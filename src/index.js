// DrivePool: several Google Drive accounts behind one password-protected web app.
//
// The Worker keeps each account's refresh token in KV and does all metadata work
// (listing, folders, rename, move, trash). File bytes do not pass through it on
// upload: the browser sends them straight to Google with a short-lived token.
// Downloads are streamed through so they work as plain links on any device.

const FOLDER = 'application/vnd.google-apps.folder';
const SCOPE = 'https://www.googleapis.com/auth/drive';
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,thumbnailLink,webViewLink';
const COOKIE = 'dp_session';
const SESSION_SECONDS = 30 * 24 * 3600;
const UPLOAD_TOKEN_MIN_MS = 40 * 60 * 1000;
const MAX_PAGES = 5;
// Only these types are ever served inline; everything else is forced to download
// so a stored HTML/SVG file can never run script on this origin.
const INLINE_OK = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/|audio\/|application\/pdf)/i;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

const enc = new TextEncoder();
const tokenCache = new Map();

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      return await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'Something went wrong on the server' }, 500);
    }
  },
};

// ---------------------------------------------------------------- routing

const POST_ROUTES = {
  '/list': list,
  '/mkdir': mkdir,
  '/rename': rename,
  '/trash': trash,
  '/move': move,
  '/upload/target': uploadTarget,
  '/upload/token': uploadToken,
  '/accounts/remove': removeAccount,
  '/accounts/empty-trash': emptyTrash,
};

async function route(req, env, url) {
  const path = url.pathname.slice(4);
  const method = req.method;
  const isGet = method === 'GET' || method === 'HEAD';

  if (!isGet) {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-origin request blocked');
  }

  const missing = ['APP_PASSWORD', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].filter((k) => !env[k]);
  if (!env.KV) missing.push('KV');
  const authed = !missing.length && (await hasSession(req, env));

  if (path === '/me') return json({ configured: !missing.length, missing, authed });
  if (missing.length) throw new HttpError(503, `Server is not configured yet (missing: ${missing.join(', ')})`);

  if (path === '/login' && method === 'POST') return login(req, env, url);
  if (path === '/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0, url) });
  }
  if (!authed) throw new HttpError(401, 'Not signed in');

  if (method === 'POST' && POST_ROUTES[path]) {
    const body = await req.json().catch(() => ({}));
    return json(await POST_ROUTES[path](env, body || {}));
  }
  if (isGet) {
    if (path === '/accounts') return json(await accountsOverview(env));
    if (path === '/search') return json(await search(env, url.searchParams.get('q') || ''));
    if (path === '/oauth/start') return oauthStart(env, url);
    if (path === '/oauth/callback') return oauthCallback(env, url);
    const m = path.match(/^\/(dl|thumb)\/([^/]+)\/([^/]+)$/);
    if (m) {
      const acct = await getAccount(env, m[2]);
      const id = checkId(m[3]);
      return m[1] === 'dl' ? download(req, env, url, acct, id) : thumbnail(env, acct, id);
    }
  }
  throw new HttpError(404, 'Not found');
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function endpoints(env) {
  // The overrides exist so the app can be pointed at a fake Google in tests.
  return {
    api: env.GOOGLE_API_BASE || 'https://www.googleapis.com',
    oauth: env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com',
    auth: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  };
}

// ---------------------------------------------------------------- session

function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Signing key is derived from the password and client secret, so changing the
// password signs every device out.
async function signingKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(`${env.APP_PASSWORD}|${env.GOOGLE_CLIENT_SECRET}`));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(env, payload) {
  const sig = await crypto.subtle.sign('HMAC', await signingKey(env), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Returns the payload if the signature is valid and it has not expired.
// Payload format: "<kind>:<expiryMs>[:nonce]".
async function unsign(env, token, kind) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  if (!sameString(await sign(env, payload), token)) return null;
  const [k, exp] = payload.split(':');
  if (k !== kind || !(Number(exp) > Date.now())) return null;
  return payload;
}

function sessionCookie(value, maxAge, url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function hasSession(req, env) {
  const m = (req.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return !!(m && (await unsign(env, m[1], 's')));
}

async function login(req, env, url) {
  // Slows password guessing: at most 10 attempts a minute from one address.
  if (env.LOGIN_LIMITER) {
    const { success } = await env.LOGIN_LIMITER.limit({ key: req.headers.get('CF-Connecting-IP') || 'local' });
    if (!success) throw new HttpError(429, 'Too many attempts. Wait a minute and try again.');
  }
  const { password } = await req.json().catch(() => ({}));
  const digest = async (s) => b64url(await crypto.subtle.digest('SHA-256', enc.encode(String(s ?? ''))));
  if (!sameString(await digest(password), await digest(env.APP_PASSWORD))) {
    await new Promise((r) => setTimeout(r, 800));
    throw new HttpError(403, 'Wrong password');
  }
  const token = await sign(env, `s:${Date.now() + SESSION_SECONDS * 1000}`);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_SECONDS, url) });
}

// ---------------------------------------------------------------- accounts and tokens

async function loadAccounts(env) {
  return (await env.KV.get('accounts', 'json')) || [];
}

async function getAccount(env, id) {
  const acct = (await loadAccounts(env)).find((a) => a.id === id);
  if (!acct) throw new HttpError(404, 'That account is not connected');
  return acct;
}

async function accessToken(env, acct, minMs = 60_000) {
  const fresh = (c) => c && c.exp > Date.now() + minMs;
  let c = tokenCache.get(acct.id);
  if (fresh(c)) return c.t;
  c = await env.KV.get(`tok:${acct.id}`, 'json');
  if (fresh(c)) {
    tokenCache.set(acct.id, c);
    return c.t;
  }
  const res = await fetch(`${endpoints(env).oauth}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: acct.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    if (body.error === 'invalid_grant') {
      throw new HttpError(502, `${acct.email} needs to be reconnected (its Google sign-in expired or was revoked)`, {
        reconnect: true,
      });
    }
    throw new HttpError(502, `Google refused a token for ${acct.email}: ${body.error_description || body.error || res.status}`);
  }
  return cacheToken(env, acct.id, body);
}

async function cacheToken(env, id, body) {
  const expiresIn = Number(body.expires_in) || 3600;
  const c = { t: body.access_token, exp: Date.now() + expiresIn * 1000 };
  tokenCache.set(id, c);
  // Best effort: if the write fails the token is simply fetched again next time.
  await env.KV.put(`tok:${id}`, JSON.stringify(c), { expirationTtl: Math.max(60, expiresIn - 120) }).catch(() => {});
  return c.t;
}

async function gfetch(env, acct, path, init = {}) {
  const token = await accessToken(env, acct);
  return fetch(endpoints(env).api + path, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
  });
}

async function googleError(res, acct) {
  const body = await res.json().catch(() => null);
  const msg = body?.error?.message || `Google returned ${res.status}`;
  // Never forward Google's 401 as ours: the client treats 401 as "signed out of DrivePool".
  const status = res.status === 404 ? 404 : res.status === 403 ? 403 : 502;
  return new HttpError(status, `${msg} (${acct.email})`);
}

async function gjson(env, acct, path, init = {}) {
  if (init.json !== undefined) {
    init = { ...init, body: JSON.stringify(init.json), headers: { ...(init.headers || {}), 'Content-Type': 'application/json' } };
    delete init.json;
  }
  const res = await gfetch(env, acct, path, init);
  if (!res.ok) throw await googleError(res, acct);
  return res.status === 204 ? null : res.json();
}

async function quota(env, acct) {
  const q = (await gjson(env, acct, '/drive/v3/about?fields=storageQuota')).storageQuota || {};
  const limit = q.limit ? Number(q.limit) : null; // absent means unlimited
  const usage = Number(q.usage || 0);
  return {
    limit,
    usage,
    drive: Number(q.usageInDrive || 0),
    trash: Number(q.usageInDriveTrash || 0),
    free: limit == null ? null : Math.max(0, limit - usage),
  };
}

async function accountsWithQuota(env) {
  const accounts = await loadAccounts(env);
  return Promise.all(
    accounts.map(async (acct) => {
      const info = { id: acct.id, email: acct.email, name: acct.name };
      try {
        Object.assign(info, await quota(env, acct));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        Object.assign(info, { error: e.message, reconnect: !!e.reconnect });
      }
      return { acct, info };
    }),
  );
}

async function accountsOverview(env) {
  return { accounts: (await accountsWithQuota(env)).map((x) => x.info) };
}

function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

// The account with the most free space that can hold `size` more bytes.
// `pending` is bytes the client has just uploaded per account, because Google's
// reported quota can lag behind for a few minutes.
async function pickAccount(env, size, pending = {}) {
  const all = await accountsWithQuota(env);
  if (!all.length) throw new HttpError(409, 'Connect a Google account first');
  let best = null;
  let bestFree = -1;
  for (const x of all) {
    if (x.info.error) continue;
    const free = x.info.free == null ? Infinity : x.info.free - (Number(pending[x.info.id]) || 0);
    if (free > bestFree) {
      best = x;
      bestFree = free;
    }
  }
  if (!best) throw new HttpError(502, all[0].info.error);
  if (bestFree < size) {
    throw new HttpError(
      507,
      `Not enough room: this file is ${fmtBytes(size)}, and the emptiest account (${best.info.email}) has ${fmtBytes(Math.max(0, bestFree))} free. A file has to fit inside one account.`,
    );
  }
  return best.acct;
}

async function removeAccount(env, body) {
  const accounts = await loadAccounts(env);
  const acct = accounts.find((a) => a.id === body.id);
  if (!acct) throw new HttpError(404, 'That account is not connected');
  await fetch(`${endpoints(env).oauth}/revoke`, {
    method: 'POST',
    body: new URLSearchParams({ token: acct.refresh_token }),
  }).catch(() => {});
  await env.KV.put('accounts', JSON.stringify(accounts.filter((a) => a.id !== acct.id)));
  await env.KV.delete(`tok:${acct.id}`);
  tokenCache.delete(acct.id);
  return { ok: true };
}

async function emptyTrash(env, body) {
  const acct = await getAccount(env, body.id);
  await gjson(env, acct, '/drive/v3/files/trash', { method: 'DELETE' });
  return { ok: true };
}

// ---------------------------------------------------------------- Google sign-in for an account

async function oauthStart(env, url) {
  const state = await sign(env, `o:${Date.now() + 10 * 60 * 1000}:${crypto.randomUUID()}`);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${url.origin}/api/oauth/callback`,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent select_account',
    state,
  });
  return Response.redirect(`${endpoints(env).auth}?${params}`, 302);
}

async function oauthCallback(env, url) {
  const back = (key, value) => Response.redirect(new URL(`/?${key}=${encodeURIComponent(value)}`, url).href, 302);
  const q = url.searchParams;
  if (q.get('error')) return back('error', q.get('error') === 'access_denied' ? 'Google sign-in was cancelled' : q.get('error'));
  if (!q.get('code') || !(await unsign(env, q.get('state'), 'o'))) return back('error', 'Sign-in link expired, please try again');

  const res = await fetch(`${endpoints(env).oauth}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      code: q.get('code'),
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/api/oauth/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) return back('error', `Google sign-in failed: ${tok.error_description || tok.error || res.status}`);
  if (!tok.refresh_token) return back('error', 'Google did not grant long-term access. Tick the Drive permission box and try again.');
  if (tok.scope && !tok.scope.split(' ').includes(SCOPE)) {
    return back('error', 'Drive access was not ticked on the Google screen. Try again and allow it.');
  }

  const about = await fetch(`${endpoints(env).api}/drive/v3/about?fields=user(displayName,emailAddress,permissionId)`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  const user = (await about.json().catch(() => ({}))).user;
  if (!about.ok || !user?.permissionId) return back('error', 'Could not read the Google account details');

  const accounts = await loadAccounts(env);
  const entry = { id: user.permissionId, email: user.emailAddress, name: user.displayName || '', refresh_token: tok.refresh_token };
  const i = accounts.findIndex((a) => a.id === entry.id);
  if (i >= 0) accounts[i] = { ...accounts[i], ...entry };
  else accounts.push({ ...entry, addedAt: Date.now() });
  await env.KV.put('accounts', JSON.stringify(accounts));
  await cacheToken(env, entry.id, tok);
  return back('connected', entry.email);
}

// ---------------------------------------------------------------- folders

function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, 'Bad file id');
  return id;
}

function checkName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 255) throw new HttpError(400, 'Enter a name (up to 255 characters)');
  return name.trim();
}

// A "chain" is the path from the top level down to a folder. The same folder can
// exist in several accounts under different ids, so each level carries the ids
// the client already knows: [{ name, ids: { accountId: folderId } }, ...].
function cleanChain(chain) {
  if (chain == null) return [];
  if (!Array.isArray(chain) || chain.length > 40) throw new HttpError(400, 'Bad folder path');
  return chain.map((level) => {
    const ids = {};
    for (const [acct, id] of Object.entries(level?.ids || {})) ids[acct] = checkId(id);
    return { name: checkName(level?.name), ids };
  });
}

const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function findFolder(env, acct, parent, name) {
  const params = new URLSearchParams({
    q: `name = ${quote(name)} and ${quote(parent)} in parents and mimeType = '${FOLDER}' and trashed = false`,
    fields: 'files(id)',
    pageSize: '1',
  });
  return (await gjson(env, acct, `/drive/v3/files?${params}`)).files?.[0]?.id || null;
}

function createFolder(env, acct, parent, name) {
  return gjson(env, acct, `/drive/v3/files?fields=${FILE_FIELDS}`, {
    method: 'POST',
    json: { name, mimeType: FOLDER, parents: [parent] },
  });
}

// Folder id at every level of the chain in one account. Starts from the deepest
// level whose id is already known and looks the rest up by name. With `create`,
// missing levels are made; without it, returns null if the path is not there.
async function resolveChain(env, acct, chain, create) {
  const out = chain.map((level) => level.ids[acct.id] || null);
  let start = 0;
  let parent = 'root';
  for (let i = chain.length - 1; i >= 0; i--) {
    if (out[i]) {
      parent = out[i];
      start = i + 1;
      break;
    }
  }
  let created = false;
  for (let i = start; i < chain.length; i++) {
    let id = created ? null : await findFolder(env, acct, parent, chain[i].name);
    if (!id) {
      if (!create) return null;
      id = (await createFolder(env, acct, parent, chain[i].name)).id;
      created = true;
    }
    out[i] = id;
    parent = id;
  }
  return out;
}

const leafOf = (ids) => (ids.length ? ids[ids.length - 1] : 'root');

async function listChildren(env, acct, parent) {
  const files = [];
  let pageToken;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      q: `${quote(parent)} in parents and trashed = false`,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: '1000',
      orderBy: 'folder,name',
      spaces: 'drive',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await gjson(env, acct, `/drive/v3/files?${params}`);
    files.push(...(res.files || []));
    pageToken = res.nextPageToken;
    if (!pageToken) return { files, truncated: false };
  }
  return { files, truncated: true };
}

const fileOut = (acct, f) => ({
  acct: acct.id,
  id: f.id,
  name: f.name,
  mimeType: f.mimeType,
  size: f.size != null ? Number(f.size) : null,
  modifiedTime: f.modifiedTime,
  thumb: !!f.thumbnailLink,
  link: f.webViewLink || null,
});

const accountError = (acct, e) => ({ acct: acct.id, email: acct.email, error: e.message, reconnect: !!e.reconnect });

// One folder across every account. Folders with the same name merge into a
// single entry that remembers its id in each account.
async function list(env, body) {
  const chain = cleanChain(body.chain);
  const accounts = await loadAccounts(env);
  const ids = {};
  const errors = [];
  const perAccount = [];
  let truncated = false;

  await Promise.all(
    accounts.map(async (acct, i) => {
      try {
        const resolved = await resolveChain(env, acct, chain, false);
        if (!resolved) return;
        const res = await listChildren(env, acct, leafOf(resolved));
        if (chain.length) ids[acct.id] = leafOf(resolved);
        perAccount[i] = res.files;
        truncated ||= res.truncated;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        if (e.status !== 404) errors.push(accountError(acct, e)); // 404: folder was deleted elsewhere
      }
    }),
  );

  const folders = new Map();
  const files = [];
  accounts.forEach((acct, i) => {
    const seen = new Map();
    for (const f of perAccount[i] || []) {
      if (f.mimeType !== FOLDER) {
        files.push(fileOut(acct, f));
        continue;
      }
      // Drive allows two folders with one name in the same place; keep those apart.
      const n = seen.get(f.name) || 0;
      seen.set(f.name, n + 1);
      const key = `${f.name}\u0000${n}`;
      let merged = folders.get(key);
      if (!merged) folders.set(key, (merged = { name: f.name, ids: {}, modifiedTime: f.modifiedTime }));
      merged.ids[acct.id] = f.id;
      if (f.modifiedTime > merged.modifiedTime) merged.modifiedTime = f.modifiedTime;
    }
  });
  return { ids, folders: [...folders.values()], files, errors, truncated };
}

async function search(env, q) {
  q = q.trim().slice(0, 100);
  if (!q) return { folders: [], files: [], errors: [] };
  const accounts = await loadAccounts(env);
  const errors = [];
  const files = [];
  await Promise.all(
    accounts.map(async (acct) => {
      try {
        const params = new URLSearchParams({
          q: `name contains ${quote(q)} and trashed = false and 'me' in owners and mimeType != '${FOLDER}'`,
          fields: `files(${FILE_FIELDS})`,
          pageSize: '100',
          spaces: 'drive',
        });
        const res = await gjson(env, acct, `/drive/v3/files?${params}`);
        for (const f of res.files || []) files.push(fileOut(acct, f));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        errors.push(accountError(acct, e));
      }
    }),
  );
  return { folders: [], files, errors };
}

async function mkdir(env, body) {
  const name = checkName(body.name);
  const chain = cleanChain(body.chain);
  const acct = await pickAccount(env, 0);
  const ids = await resolveChain(env, acct, chain, true);
  const parent = leafOf(ids);
  if (await findFolder(env, acct, parent, name)) throw new HttpError(409, `A folder named "${name}" already exists here`);
  const folder = await createFolder(env, acct, parent, name);
  return { acct: acct.id, chainIds: ids, folder: { name: folder.name, ids: { [acct.id]: folder.id }, modifiedTime: folder.modifiedTime } };
}

// ---------------------------------------------------------------- changing items

// items: [{ acct, id }]. A merged folder is sent as one item per account.
async function forEachItem(env, items, fn) {
  if (!Array.isArray(items) || !items.length || items.length > 20) throw new HttpError(400, 'Send between 1 and 20 items');
  const accounts = await loadAccounts(env);
  const results = await Promise.allSettled(
    items.map(async (item) => {
      const acct = accounts.find((a) => a.id === item?.acct);
      if (!acct) throw new HttpError(404, 'That account is not connected');
      return fn(acct, checkId(item.id));
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  for (const f of failed) if (!(f.reason instanceof HttpError)) throw f.reason;
  return { done: results.length - failed.length, failed: failed.map((f) => f.reason.message) };
}

function rename(env, body) {
  const name = checkName(body.name);
  return forEachItem(env, body.items, (acct, id) =>
    gjson(env, acct, `/drive/v3/files/${id}?fields=id`, { method: 'PATCH', json: { name } }),
  );
}

function trash(env, body) {
  return forEachItem(env, body.items, (acct, id) =>
    gjson(env, acct, `/drive/v3/files/${id}?fields=id`, { method: 'PATCH', json: { trashed: true } }),
  );
}

async function move(env, body) {
  const chain = cleanChain(body.chain);
  const dest = new Map(); // account id -> promise of destination folder id
  const destFor = (acct) => {
    if (!dest.has(acct.id)) {
      dest.set(
        acct.id,
        chain.length
          ? resolveChain(env, acct, chain, true).then(leafOf)
          : gjson(env, acct, '/drive/v3/files/root?fields=id').then((r) => r.id),
      );
    }
    return dest.get(acct.id);
  };
  return forEachItem(env, body.items, async (acct, id) => {
    const to = await destFor(acct);
    if (to === id) throw new HttpError(400, 'A folder cannot be moved into itself');
    const { parents = [] } = await gjson(env, acct, `/drive/v3/files/${id}?fields=parents`);
    if (parents.length === 1 && parents[0] === to) return;
    const params = new URLSearchParams({ addParents: to, fields: 'id' });
    if (parents.length) params.set('removeParents', parents.join(','));
    await gjson(env, acct, `/drive/v3/files/${id}?${params}`, { method: 'PATCH', json: {} });
  });
}

// ---------------------------------------------------------------- upload and download

// Chooses where a new file goes and hands the browser what it needs to send
// the bytes directly to Google.
async function uploadTarget(env, body) {
  const size = Number(body.size);
  if (!Number.isFinite(size) || size < 0) throw new HttpError(400, 'Bad file size');
  const chain = cleanChain(body.chain);
  const acct = await pickAccount(env, size, body.pending || {});
  const ids = await resolveChain(env, acct, chain, true);
  return {
    acct: acct.id,
    email: acct.email,
    folderId: leafOf(ids),
    chainIds: ids,
    token: await accessToken(env, acct, UPLOAD_TOKEN_MIN_MS),
    uploadBase: endpoints(env).api,
  };
}

async function uploadToken(env, body) {
  const acct = await getAccount(env, body.acct);
  return { token: await accessToken(env, acct, UPLOAD_TOKEN_MIN_MS) };
}

async function download(req, env, url, acct, id) {
  const headers = {};
  const range = req.headers.get('Range');
  if (range) headers.Range = range;
  const res = await gfetch(env, acct, `/drive/v3/files/${id}?alt=media`, { headers });
  if (!res.ok) throw await googleError(res, acct);

  const type = res.headers.get('Content-Type') || 'application/octet-stream';
  const inline = url.searchParams.has('inline') && INLINE_OK.test(type);
  const name = (url.searchParams.get('name') || 'download').replace(/[\r\n"\\/]/g, '_');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  const out = new Headers({
    'Content-Type': inline ? type : 'application/octet-stream',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const h of ['Content-Length', 'Content-Range']) {
    if (res.headers.get(h)) out.set(h, res.headers.get(h));
  }
  return new Response(res.body, { status: res.status, headers: out });
}

async function thumbnail(env, acct, id) {
  const meta = await gjson(env, acct, `/drive/v3/files/${id}?fields=thumbnailLink`);
  let link;
  try {
    link = new URL(meta.thumbnailLink);
  } catch {
    throw new HttpError(404, 'No thumbnail');
  }
  // The token only ever goes to Google's own hosts.
  if (link.protocol !== 'https:' || !/(^|\.)(googleusercontent\.com|google\.com)$/.test(link.hostname)) {
    throw new HttpError(404, 'No thumbnail');
  }
  const res = await fetch(link, { headers: { Authorization: `Bearer ${await accessToken(env, acct)}` } });
  const type = res.headers.get('Content-Type') || '';
  if (!res.ok || !/^image\/(png|jpeg|gif|webp)/.test(type)) throw new HttpError(404, 'No thumbnail');
  return new Response(res.body, {
    headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' },
  });
}
