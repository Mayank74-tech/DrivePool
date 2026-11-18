// DrivePool front end. No build step: plain modules, DOM built with h().

const PALETTE = ['#4f7cff', '#12b76a', '#f79009', '#ee46bc', '#7a5af8', '#06aed4', '#f04438', '#84cc16'];
const CHUNK = 16 * 1024 * 1024; // must be a multiple of 256 KiB for Google's resumable uploads
const NATIVE = 'application/vnd.google-apps.';
const PREVIEWABLE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/|audio\/)/;
const root = () => ({ name: 'All files', ids: null });

// Per-device preferences. Storage can be unavailable (private windows), so nothing depends on it.
const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`dp.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`dp.${key}`, JSON.stringify(value));
    } catch {}
  },
};

const state = {
  accounts: null, // null until first load
  stack: [root()], // path from the top level to the open folder
  items: null,
  errors: [],
  truncated: false,
  selected: new Set(),
  sort: { key: 'name', dir: 1 },
  search: '',
  moving: null,
  uploads: [],
  uploadsCollapsed: false,
  view: prefs.get('view', 'grid') === 'details' ? 'details' : 'grid',
  tile: Math.min(320, Math.max(72, Number(prefs.get('tile', 128)) || 128)), // thumbnail width in px
  visible: [], // items as currently shown, in order
  els: new Map(), // item -> its element
  anchor: null, // where a Shift-range starts
  cursor: null, // item last clicked or reached with the arrow keys
};

// ---------------------------------------------------------------- small helpers

const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c);
  return el;
}

const ICONS = {
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  blank: '',
  check: '<path d="M20 6L9 17l-5-5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  sort: '<path d="M3 6h18M6 12h12M10 18h4"/>',
  zoomIn: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35M8 11h6"/>',
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  chevronLeft: '<path d="M15 18l-6-6 6-6"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  folderPlus: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6M9 14h6"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  video: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 9l5 3-5 3z"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  move: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  storage: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M18 15l-6-6-6 6"/>',
  refresh: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
};

function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  // Constant markup only; nothing user-supplied ever reaches innerHTML.
  span.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

const btn = (label, onclick, kind = '', iconName) =>
  h('button', { class: `btn ${kind}`, type: 'button', onclick }, iconName && icon(iconName), h('span', null, label));

const iconBtn = (iconName, label, onclick) =>
  h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, onclick }, icon(iconName));

function fmtBytes(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const s = n >= 100 || i === 0 ? Math.round(n) : Number(n.toFixed(1));
  return `${s} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '');

function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

async function api(path, body) {
  const opt =
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, opt);
  } catch {
    throw new Error('No connection. Check your internet and try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showLogin(data.locked ? LOCKED_MESSAGE : undefined);
    throw new Error(data.locked ? 'DrivePool is locked' : 'Please sign in again');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- accounts

const acctIndex = (id) => (state.accounts || []).findIndex((a) => a.id === id);
const acctColor = (id) => PALETTE[Math.max(0, acctIndex(id)) % PALETTE.length];
const acctEmail = (id) => state.accounts?.[acctIndex(id)]?.email || 'another account';

function dot(id) {
  const el = h('span', { class: 'dot', title: acctEmail(id) });
  el.style.background = acctColor(id);
  return el;
}

async function loadAccounts() {
  try {
    state.accounts = (await api('/api/accounts')).accounts;
    if (state.only && !state.accounts.some((a) => a.id === state.only)) state.only = null;
  } catch (e) {
    if (!state.accounts) state.accounts = [];
    toast(e.message, 'error');
  }
  renderSidebar();
  render();
}

function totals() {
  const counted = (state.accounts || []).filter((a) => !a.error && a.limit != null);
  const limit = counted.reduce((s, a) => s + a.limit, 0);
  const usage = counted.reduce((s, a) => s + Math.min(a.usage, a.limit), 0);
  return { counted, limit, usage, free: limit - usage };
}

function meter(fraction, color) {
  const fill = h('span');
  fill.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  if (color) fill.style.background = color;
  return h('div', { class: 'meter' }, fill);
}

function renderSidebar() {
  const box = $('#sidebar');
  const accts = state.accounts;
  const t = totals();

  const toggle = $('#storage-toggle');
  toggle.replaceChildren(icon('storage'), h('span', null, accts?.length ? `${fmtBytes(t.free)} free` : 'Storage'));

  const head = h('div', { class: 'side-head' }, h('h2', null, 'Storage'), iconBtn('x', 'Close storage panel', closeSidebar));
  if (!accts) {
    box.replaceChildren(head, h('p', { class: 'muted' }, 'Loading accounts…'));
    return;
  }

  const seg = h('div', { class: 'segbar', role: 'img', 'aria-label': `${fmtBytes(t.usage)} used of ${fmtBytes(t.limit)}` });
  for (const a of t.counted) {
    const part = h('span', { title: `${a.email}: ${fmtBytes(a.usage)} used` });
    part.style.width = `${(Math.min(a.usage, a.limit) / (t.limit || 1)) * 100}%`;
    part.style.background = acctColor(a.id);
    seg.append(part);
  }

  const rows = accts.map((a) =>
    h(
      'li',
      { class: `acct${state.only === a.id ? ' active' : state.only ? ' dimmed' : ''}` },
      dot(a.id),
      h(
        'button',
        {
          class: 'acct-info',
          type: 'button',
          'aria-pressed': String(state.only === a.id),
          title: state.only === a.id ? 'Show all accounts' : `Show only ${a.email}`,
          onclick: () => setOnly(state.only === a.id ? null : a.id),
        },
        h('div', { class: 'acct-email', title: a.email }, a.email),
        a.error
          ? h('div', { class: 'acct-error', title: a.error }, a.reconnect ? 'Needs reconnecting' : 'Not reachable right now')
          : h(
              'div',
              { class: 'muted small' },
              a.limit == null ? `${fmtBytes(a.usage)} used, no limit` : `${fmtBytes(a.free)} free of ${fmtBytes(a.limit)}`,
            ),
        !a.error && a.limit != null && meter(a.usage / a.limit, acctColor(a.id)),
      ),
      iconBtn('more', `Options for ${a.email}`, (e) => accountMenu(e.currentTarget, a)),
    ),
  );

  box.replaceChildren(
    head,
    accts.length
      ? h(
          'div',
          { class: 'total' },
          h('div', { class: 'total-free' }, fmtBytes(t.free), h('span', null, ' free')),
          h('div', { class: 'muted small' }, `${fmtBytes(t.usage)} used of ${fmtBytes(t.limit)} across ${plural(accts.length, 'account')}`),
          seg,
        )
      : h('p', { class: 'muted' }, 'No Google accounts connected yet.'),
    h('ul', { class: 'accts' }, rows),
    btn('Add Google account', connectAccount, 'wide', 'plus'),
    accts.length > 0 && btn('Google Photos', photosDialog, 'wide', 'image'),
    h('p', { class: 'muted small note' }, 'Each account’s space is shared with its Gmail and Google Photos.'),
    h('div', { class: 'side-foot' }, btn(`${bioName()} lock`, passkeyDialog, 'quiet', 'lock'), btn('Sign out', signOut, 'quiet', 'logout')),
  );
}

function connectAccount() {
  location.href = '/api/oauth/start';
}

function accountMenu(anchor, a) {
  openMenu(anchor, [
    a.reconnect && { icon: 'refresh', label: 'Reconnect', run: connectAccount },
    {
      icon: 'external',
      label: 'Open in Google Drive',
      run: () => window.open(`https://drive.google.com/drive/?authuser=${encodeURIComponent(a.email)}`, '_blank', 'noopener'),
    },
    state.only === a.id
      ? { icon: 'storage', label: 'Show all accounts', run: () => setOnly(null) }
      : { icon: 'eye', label: 'Show only this account', run: () => setOnly(a.id) },
    { icon: 'image', label: 'Open Google Photos', run: () => openGooglePhotos(a) },
    !a.error && { icon: 'eye', label: 'View Google Photos here', run: () => pickPhotos(a) },
    !a.error && {
      icon: 'trash',
      label: a.trash ? `Empty trash (${fmtBytes(a.trash)})` : 'Empty trash',
      run: async () => {
        const ok = await confirmBox({
          title: 'Empty trash?',
          message: `Everything in the trash of ${a.email} will be deleted for good. This cannot be undone.`,
          action: 'Empty trash',
          danger: true,
        });
        if (!ok) return;
        try {
          await api('/api/accounts/empty-trash', { id: a.id });
          toast('Trash emptied');
          loadAccounts();
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    },
    {
      icon: 'x',
      label: 'Disconnect',
      danger: true,
      run: async () => {
        const ok = await confirmBox({
          title: 'Disconnect account?',
          message: `${a.email} will be removed from DrivePool. Its files stay in Google Drive and are not deleted.`,
          action: 'Disconnect',
          danger: true,
        });
        if (!ok) return;
        try {
          await api('/api/accounts/remove', { id: a.id });
          await loadAccounts();
          loadList();
        } catch (e) {
          toast(e.message, 'error');
        }
      },
    },
  ]);
}

const openSidebar = () => document.body.classList.add('sidebar-open');
const closeSidebar = () => document.body.classList.remove('sidebar-open');

// ---------------------------------------------------------------- navigation and listing

const chainOf = (stack) => stack.slice(1).map((s) => ({ name: s.name, ids: s.ids || {} }));
const samePath = (a, b) => a.length === b.length && a.every((s, i) => s.name === b[i].name);
const saveHistory = () => history.replaceState({ stack: state.stack }, '');

function navigate(stack) {
  state.stack = stack;
  history.pushState({ stack }, '');
  resetView();
}

function resetView() {
  state.gphotos = null;
  state.search = '';
  $('#search').value = '';
  state.items = null;
  loadList();
}

let listSeq = 0;
async function loadList() {
  if (state.gphotos) return render(); // picked Google Photos are not reloaded from Drive
  const seq = ++listSeq;
  $('#list').classList.add('loading');
  state.selected.clear();
  state.anchor = state.cursor = null;
  render();
  try {
    const res = state.search
      ? await api(`/api/search?q=${encodeURIComponent(state.search)}`)
      : await api('/api/list', { chain: chainOf(state.stack) });
    if (seq !== listSeq) return;
    if (!state.search && state.stack.length > 1) {
      state.stack[state.stack.length - 1].ids = res.ids || {};
      saveHistory();
    }
    state.items = {
      folders: (res.folders || []).map((f) => ({ kind: 'folder', ...f })),
      files: (res.files || []).map((f) => ({ kind: 'file', ...f })),
    };
    state.errors = res.errors || [];
    state.truncated = !!res.truncated;
  } catch (e) {
    if (seq !== listSeq) return;
    if (!state.items) state.items = { folders: [], files: [] };
    toast(e.message, 'error');
  }
  $('#list').classList.remove('loading');
  render();
}

function sortedItems() {
  const { key, dir } = state.sort;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const cmp = {
    name: byName,
    size: (a, b) => (a.size ?? -1) - (b.size ?? -1),
    date: (a, b) => (a.modifiedTime || '').localeCompare(b.modifiedTime || ''),
  }[key];
  const by = (a, b) => cmp(a, b) * dir || byName(a, b);
  // When one account is chosen, show only what it holds (a merged folder counts if it exists there).
  const only = state.gphotos ? null : state.only;
  const keep = (it) => !only || (it.kind === 'folder' ? only in it.ids : it.acct === only);
  return [...state.items.folders.filter(keep).sort(by), ...state.items.files.filter(keep).sort(by)];
}

const sortedItemsUnfiltered = () => state.items.folders.length + state.items.files.length > 0;

function setOnly(id) {
  state.only = id && (state.accounts || []).some((a) => a.id === id) ? id : null;
  state.selected.clear();
  state.anchor = state.cursor = null;
  closeSidebar();
  renderSidebar();
  render();
}

// ---------------------------------------------------------------- rendering the file area

function render() {
  renderCrumbs();
  renderNotices();
  renderList();
  renderSelection(); // also draws the toolbar and view bar
}

function renderCrumbs() {
  const box = $('#crumbs');
  if (state.gphotos) {
    const here = state.stack[state.stack.length - 1];
    box.replaceChildren(
      h('button', { class: 'crumb', type: 'button', onclick: () => navigate(state.stack) }, here.name),
      icon('chevron'),
      h('span', { class: 'crumb current', 'aria-current': 'page' }, 'Google Photos'),
    );
    return;
  }
  if (state.search) {
    box.replaceChildren(h('span', { class: 'crumb current' }, 'Search results'));
    return;
  }
  const parts = [];
  state.stack.forEach((s, i) => {
    const last = i === state.stack.length - 1;
    if (i) parts.push(icon('chevron'));
    parts.push(
      last
        ? h('span', { class: 'crumb current', 'aria-current': 'page' }, s.name)
        : h('button', { class: 'crumb', type: 'button', onclick: () => navigate(state.stack.slice(0, i + 1)) }, s.name),
    );
  });
  box.replaceChildren(...parts);
  box.scrollLeft = box.scrollWidth;
}

const isNative = (it) => it.kind === 'file' && it.mimeType.startsWith(NATIVE);
const isDownloadable = (it) => it.kind === 'file' && !isNative(it);
// A merged folder is one item per account it lives in.
const refsOf = (it) =>
  it.kind === 'folder' ? Object.entries(it.ids).map(([acct, id]) => ({ acct, id })) : [{ acct: it.acct, id: it.id }];

function renderToolbar() {
  const bar = $('#toolbar');
  const sel = [...state.selected];
  const grow = (text, tag = 'span') => h(tag, { class: 'grow' }, text);

  if (state.picking) {
    const p = state.picking;
    bar.className = 'toolbar banner';
    bar.replaceChildren(
      grow(`Choose photos in the Google Photos window (${p.email}), then press Done there.`),
      h('a', { class: 'btn', href: p.uri, target: '_blank', rel: 'noopener' }, 'Open picker'),
      btn('Cancel', () => {
        state.picking = null;
        renderToolbar();
      }),
    );
    return;
  }
  if (state.moving) {
    bar.className = 'toolbar banner';
    bar.replaceChildren(
      grow(`Moving ${plural(state.moving.length, 'item')}. Open the folder they should go to.`),
      btn('Cancel', () => {
        state.moving = null;
        render();
      }),
      btn('Move here', doMove, 'primary'),
    );
    return;
  }
  if (sel.length) {
    bar.className = 'toolbar banner';
    bar.replaceChildren(
      grow(`${sel.length} selected`, 'strong'),
      sel.every(isDownloadable) && iconBtn('download', 'Download', () => downloadMany(sel)),
      !state.gphotos && iconBtn('move', 'Move', () => startMove(sel)),
      !state.gphotos && iconBtn('trash', 'Delete', () => removeItems(sel)),
      iconBtn('x', 'Clear selection', () => setSelection([])),
    );
    return;
  }
  bar.className = 'toolbar';
  if (state.gphotos) {
    const g = state.gphotos;
    const a = (state.accounts || []).find((x) => x.id === g.acct);
    bar.replaceChildren(
      a && btn('Pick more', () => pickPhotos(a), 'primary', 'image'),
      a && btn('Open Google Photos', () => openGooglePhotos(a), '', 'external'),
      h('span', { class: 'grow' }),
      btn('Back to files', () => navigate(state.stack)),
    );
    return;
  }
  if (state.search) {
    const n = state.items ? state.items.files.length : 0;
    bar.replaceChildren(
      grow(state.items ? `${plural(n, 'file')} matching “${state.search}”` : 'Searching…'),
      btn('Clear search', resetView),
    );
    return;
  }
  const noAccounts = !state.accounts?.length;
  const upload = btn('Upload', (e) => chooseUpload(e.currentTarget), 'primary', 'upload');
  const folder = btn('New folder', newFolder, '', 'folderPlus');
  upload.disabled = folder.disabled = noAccounts;
  bar.replaceChildren(upload, folder, h('span', { class: 'grow' }), iconBtn('refresh', 'Refresh', refreshAll));
}

// On phones a plain file picker often opens only the photo gallery, so PDFs and other
// documents cannot be reached. Let the user choose where to pick from.
function pickFiles(accept) {
  const input = $('#file-input');
  input.accept = accept;
  input.click();
}

function chooseUpload(anchor) {
  if (!matchMedia('(pointer: coarse)').matches) return pickFiles('');
  openMenu(anchor, [
    { icon: 'image', label: 'Photos & videos', run: () => pickFiles('image/*,video/*') },
    { icon: 'file', label: 'Files (PDF, documents, anything)', run: () => pickFiles('*/*') },
  ]);
}

function refreshAll() {
  loadAccounts();
  loadList();
}

function renderNotices() {
  const out = state.errors.map((e) =>
    h(
      'div',
      { class: 'notice' },
      icon('alert'),
      h('span', { class: 'grow' }, `Files from ${e.email} are missing from this view. ${e.error}`),
      e.reconnect && btn('Reconnect', connectAccount),
    ),
  );
  if (state.only && !state.gphotos) {
    out.push(
      h(
        'div',
        { class: 'notice info' },
        dot(state.only),
        h('span', { class: 'grow' }, `Showing only ${acctEmail(state.only)}. New uploads and folders go to this account.`),
        btn('Show all accounts', () => setOnly(null)),
      ),
    );
  }
  if (state.gphotos) {
    out.push(
      h(
        'div',
        { class: 'notice info' },
        icon('image'),
        h(
          'span',
          { class: 'grow' },
          `Photos you picked from ${state.gphotos.email}. Google only allows viewing them for about an hour; after that, pick them again.`,
        ),
      ),
    );
  }
  if (state.truncated) {
    out.push(h('div', { class: 'notice' }, icon('alert'), h('span', null, 'This folder is very large, so only the first few thousand items are shown.')));
  }
  $('#notices').replaceChildren(...out);
}

function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, icon(iconName), h('h2', null, title), text && h('p', { class: 'muted' }, text), action);
}

const TILE_MIN = 72;
const TILE_MAX = 320;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isVideo = (it) => it.kind === 'file' && it.mimeType.startsWith('video/');
// Google Photos converts any picture (HEIC too) to a viewable image on request.
const isPreviewable = (it) =>
  it.kind === 'file' &&
  (PREVIEWABLE.test(it.mimeType) || (!!it.gp && /^(image|video)\//.test(it.mimeType)) || needsConversion(it));

// HEIC, RAW and other photos browsers cannot show: view Google's JPEG version instead.
// (Downloading still gives the original file.)
const needsConversion = (it) => !it.gp && !!it.thumb && /^image\//.test(it.mimeType) && !PREVIEWABLE.test(it.mimeType);
const viewSrc = (f) => (needsConversion(f) ? thumbUrl(f, 2048) : fileUrl(f, true));

// An .AAE file is the iPhone's list of edits for a photo, not a picture. Find the photo it belongs to.
const isAae = (it) => it.kind === 'file' && /\.aae$/i.test(it.name);
function aaePhoto(it) {
  const base = it.name.replace(/\.aae$/i, '').replace(/^(IMG_)O?E?(\d+)$/i, '$1$2').toLowerCase();
  return state.visible.find(
    (x) => x !== it && x.kind === 'file' && /^(image|video)\//.test(x.mimeType) && x.name.replace(/\.[^.]+$/, '').replace(/^(IMG_)E(\d+)$/i, '$1$2').toLowerCase() === base,
  );
}
const acctsOf = (it) => (it.kind === 'folder' ? Object.keys(it.ids) : [it.acct]);

// Google serves thumbnails at several widths; ask for the smallest that still looks sharp.
function thumbSize(px) {
  const need = px * Math.min(window.devicePixelRatio || 1, 2);
  return need <= 220 ? 220 : need <= 400 ? 400 : 800;
}
const gpUrl = (it, s) => `/api/gp/${it.acct}?u=${encodeURIComponent(it.gp)}&s=${s}&name=${encodeURIComponent(it.name)}`;
const thumbUrl = (it, size) => (it.gp ? gpUrl(it, size) : `/api/thumb/${it.acct}/${it.id}?s=${size}`);

function renderList() {
  const box = $('#list');
  const head = $('#list-head');
  head.hidden = true;
  state.els = new Map();
  state.visible = [];
  box.classList.remove('grid', 'details');
  box.removeAttribute('role');

  if (state.accounts && !state.accounts.length) {
    box.replaceChildren(
      emptyState(
        'storage',
        'Connect your first Google account',
        'Add each Gmail account you own. Their free space is added together and their files appear here in one list.',
        btn('Add Google account', connectAccount, 'primary', 'plus'),
      ),
    );
    return;
  }
  if (!state.items) {
    box.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'muted' }, 'Loading…')));
    return;
  }
  const items = sortedItems();
  if (!items.length) {
    box.replaceChildren(
      state.search
        ? emptyState('search', 'Nothing found', `No file names contain “${state.search}”.`)
        : state.only && !state.gphotos && sortedItemsUnfiltered()
          ? emptyState('folder', `Nothing from ${acctEmail(state.only)} here`, 'Other accounts have files in this folder.', btn('Show all accounts', () => setOnly(null)))
          : emptyState('folder', 'This folder is empty', 'Drop files here, or use Upload.'),
    );
    return;
  }

  state.visible = items;
  const grid = state.view === 'grid';
  box.classList.add(grid ? 'grid' : 'details');
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-multiselectable', 'true');
  box.style.setProperty('--tile', `${state.tile}px`);

  if (!grid) {
    const sortBtn = (key, label) => {
      const active = state.sort.key === key;
      return h(
        'button',
        {
          class: `sort ${key}${active ? ' active' : ''}`,
          type: 'button',
          'aria-label': `Sort by ${label.toLowerCase()}`,
          onclick: () => {
            state.sort = { key, dir: active ? -state.sort.dir : 1 };
            refreshList();
          },
        },
        label,
        active && icon(state.sort.dir > 0 ? 'chevronUp' : 'chevronDown'),
      );
    };
    head.hidden = false;
    head.replaceChildren(
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          id: 'select-all',
          'aria-label': 'Select everything',
          onchange: (e) => setSelection(e.target.checked ? items : []),
        }),
      ),
      sortBtn('name', 'Name'),
      h('span', { class: 'acct-col' }, 'Stored in'),
      sortBtn('size', 'Size'),
      sortBtn('date', 'Modified'),
      h('span'),
    );
  }

  box.replaceChildren(
    ...items.map((it) => {
      const el = grid ? tile(it) : row(it);
      bindItem(el, it);
      state.els.set(it, el);
      return el;
    }),
  );
}

function refreshList() {
  renderList();
  renderSelection();
}

function typeIcon(it) {
  if (it.kind === 'folder') return 'folder';
  const type = it.mimeType.split('/')[0];
  return type === 'image' || type === 'video' || type === 'audio' ? type : 'file';
}

// A thumbnail when Google has one, otherwise an icon for the kind of file.
function visual(it, size) {
  const glyph = h('span', { class: `glyph ${it.kind === 'folder' ? 'is-folder' : ''}` }, icon(typeIcon(it)));
  if (it.kind !== 'file' || !it.thumb) return glyph;
  const img = h('img', { class: 'thumb', alt: '', loading: 'lazy', src: thumbUrl(it, size) });
  img.draggable = false;
  img.dataset.size = size;
  img.addEventListener('error', () => img.replaceWith(glyph));
  return img;
}

function checkbox(it) {
  return h(
    'label',
    { class: 'check' },
    h('input', {
      type: 'checkbox',
      'aria-label': `Select ${it.name}`,
      onchange: (e) => {
        if (e.target.checked) state.selected.add(it);
        else state.selected.delete(it);
        state.anchor = state.cursor = it;
        renderSelection();
      },
    }),
  );
}

const details = (it) =>
  [it.kind === 'file' && it.size != null && fmtBytes(it.size), fmtDate(it.modifiedTime)].filter(Boolean).join(' · ');

function row(it) {
  const accts = acctsOf(it);
  return h(
    'div',
    { class: 'row', role: 'option' },
    checkbox(it),
    h(
      'div',
      { class: 'name', title: it.name },
      visual(it, 220),
      h('span', { class: 'text' }, h('span', { class: 'title' }, it.name), h('span', { class: 'sub' }, accts.map(dot), details(it))),
    ),
    h(
      'div',
      { class: 'acct-col' },
      accts.length === 1
        ? h('span', { class: 'chip', title: acctEmail(accts[0]) }, dot(accts[0]), acctEmail(accts[0]).split('@')[0])
        : h('span', { class: 'chip', title: accts.map(acctEmail).join(', ') }, accts.map(dot), `${accts.length} accounts`),
    ),
    h('div', { class: 'size' }, it.kind === 'file' && it.size != null ? fmtBytes(it.size) : '—'),
    h('div', { class: 'date' }, fmtDate(it.modifiedTime)),
    iconBtn('more', `Actions for ${it.name}`, (e) => itemMenu(e.currentTarget, it)),
  );
}

function tile(it) {
  return h(
    'div',
    { class: 'tile', role: 'option', title: `${it.name}\n${details(it)}` },
    h(
      'div',
      { class: 'tile-art' },
      visual(it, thumbSize(state.tile)),
      isVideo(it) && it.thumb && h('span', { class: 'play' }, icon('video')),
      h('span', { class: 'tile-accts' }, acctsOf(it).map(dot)),
    ),
    h('div', { class: 'tile-name' }, it.name),
    checkbox(it),
    iconBtn('more', `Actions for ${it.name}`, (e) => itemMenu(e.currentTarget, it)),
  );
}

// ---------------------------------------------------------------- selection, like a desktop file manager

// A click or tap opens straight away. Selecting is done with the tick box,
// Ctrl/Shift + click or right-click; once something is selected, clicks toggle selection.
function bindItem(el, it) {
  el.tabIndex = 0;
  const onControl = (e) => e.target.closest('.check, .icon-btn');
  el.addEventListener('click', (e) => {
    if (onControl(e)) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) return clickSelect(it, e);
    if (state.selected.size) return toggleSelect(it);
    if (e.detail > 1) return; // second click of a double-click: already opened
    openItem(it);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!state.selected.has(it)) {
      state.selected = new Set([it]);
      state.anchor = state.cursor = it;
      renderSelection();
    }
    itemMenu({ x: e.clientX, y: e.clientY }, it);
  });
}

function setSelection(items) {
  state.selected = new Set(items);
  renderSelection();
}

function toggleSelect(it) {
  if (state.selected.has(it)) state.selected.delete(it);
  else state.selected.add(it);
  state.anchor = state.cursor = it;
  renderSelection();
}

function rangeTo(it, keep) {
  const items = state.visible;
  const a = items.indexOf(state.anchor);
  const b = items.indexOf(it);
  const range = items.slice(Math.min(a, b), Math.max(a, b) + 1);
  state.selected = new Set(keep ? [...state.selected, ...range] : range);
}

function clickSelect(it, e) {
  const mod = e.ctrlKey || e.metaKey;
  if (e.shiftKey && state.visible.includes(state.anchor)) {
    rangeTo(it, mod);
  } else if (mod) {
    if (state.selected.has(it)) state.selected.delete(it);
    else state.selected.add(it);
    state.anchor = it;
  } else {
    state.selected = new Set([it]);
    state.anchor = it;
  }
  state.cursor = it;
  renderSelection();
}

// Updates selection in place so thumbnails are not rebuilt on every click.
function renderSelection() {
  for (const [it, el] of state.els) {
    const on = state.selected.has(it);
    el.classList.toggle('selected', on);
    el.setAttribute('aria-selected', String(on));
    el.querySelector('.check input').checked = on;
  }
  const all = $('#select-all');
  if (all) all.checked = state.visible.length > 0 && state.visible.every((it) => state.selected.has(it));
  renderToolbar();
  renderViewbar();
}

function moveCursor(e) {
  const items = state.visible;
  if (!items.length) return;
  let cols = 1;
  if (state.view === 'grid') {
    const top = state.els.get(items[0]).offsetTop;
    cols = items.findIndex((it) => state.els.get(it).offsetTop !== top);
    if (cols < 1) cols = items.length;
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    return;
  }
  e.preventDefault();
  const current = items.indexOf(state.cursor);
  const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
  const next = current < 0 ? 0 : current + delta;
  if (next < 0 || next >= items.length) return;
  const it = items[next];
  if (e.shiftKey && items.includes(state.anchor)) {
    rangeTo(it, false);
  } else {
    state.selected = new Set([it]);
    state.anchor = it;
  }
  state.cursor = it;
  const el = state.els.get(it);
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
  renderSelection();
}

function onKey(e) {
  if ($('#shell').hidden) return;
  if ($('#preview').open) return viewerKey(e);
  if (document.querySelector('dialog[open], .menu')) return;
  if (e.target.matches?.('input:not([type="checkbox"]), textarea')) return;
  const sel = [...state.selected];
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;
  if (mod && key.toLowerCase() === 'a') {
    if (!state.visible.length) return;
    e.preventDefault();
    setSelection(state.visible);
  } else if (key === 'Escape') {
    if (state.moving) {
      state.moving = null;
      render();
    } else if (sel.length) {
      setSelection([]);
    }
  } else if (key === 'Delete' && sel.length && !state.gphotos) {
    removeItems(sel);
  } else if (key === 'F2' && sel.length === 1 && !state.gphotos) {
    e.preventDefault();
    renameItem(sel[0]);
  } else if (key === 'Enter' && sel.length === 1 && !e.target.closest('button, a, .check')) {
    e.preventDefault();
    openItem(sel[0]);
  } else if (key === ' ' && e.target.matches?.('.tile, .row')) {
    e.preventDefault();
    for (const [it, el] of state.els) if (el === e.target) toggleSelect(it);
  } else if (key === 'Backspace' && state.gphotos) {
    navigate(state.stack);
  } else if (key === 'Backspace' && state.stack.length > 1 && !state.search) {
    navigate(state.stack.slice(0, -1));
  } else if (key.startsWith('Arrow') && !mod && !e.altKey) {
    moveCursor(e);
  }
}

// ---------------------------------------------------------------- view bar: item count, thumbnail size, sort, view

function renderViewbar() {
  const bar = $('#viewbar');
  const items = state.visible;
  bar.hidden = !items.length;
  if (!items.length) return;
  if (!bar.firstChild) buildViewbar(bar);
  const sel = [...state.selected];
  const bytes = sel.reduce((sum, it) => sum + (it.kind === 'file' && it.size ? it.size : 0), 0);
  $('#status').textContent = sel.length
    ? `${sel.length} of ${plural(items.length, 'item')} selected${bytes ? ` · ${fmtBytes(bytes)}` : ''}`
    : plural(items.length, 'item');
  $('#zoom').hidden = state.view !== 'grid';
  $('#zoom-range').value = state.tile;
  $('#view-grid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('#view-details').setAttribute('aria-pressed', String(state.view === 'details'));
}

function buildViewbar(bar) {
  const range = h('input', {
    type: 'range',
    id: 'zoom-range',
    min: TILE_MIN,
    max: TILE_MAX,
    step: 8,
    value: state.tile,
    'aria-label': 'Thumbnail size',
    oninput: (e) => setTile(Number(e.target.value)),
  });
  const viewBtn = (id, iconName, label, view) => {
    const b = iconBtn(iconName, label, () => setView(view));
    b.id = id;
    return b;
  };
  bar.append(
    h('span', { class: 'grow muted small', id: 'status' }),
    h(
      'div',
      { class: 'zoom', id: 'zoom' },
      iconBtn('zoomOut', 'Smaller thumbnails', () => setTile(state.tile - 24)),
      range,
      iconBtn('zoomIn', 'Larger thumbnails', () => setTile(state.tile + 24)),
    ),
    iconBtn('sort', 'Sort', (e) => sortMenu(e.currentTarget)),
    h('div', { class: 'seg' }, viewBtn('view-grid', 'grid', 'Thumbnails', 'grid'), viewBtn('view-details', 'list', 'Details', 'details')),
  );
}

function setView(view) {
  if (view === state.view) return;
  state.view = view;
  prefs.set('view', view);
  refreshList();
}

let thumbTimer;
function setTile(px) {
  state.tile = clamp(Math.round(px), TILE_MIN, TILE_MAX);
  prefs.set('tile', state.tile);
  $('#list').style.setProperty('--tile', `${state.tile}px`);
  const range = $('#zoom-range');
  if (range) range.value = state.tile;
  // Once zooming settles, swap in sharper thumbnails where the tiles outgrew them.
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const size = thumbSize(state.tile);
    for (const [it, el] of state.els) {
      const img = el.querySelector('.tile-art img.thumb');
      if (img && Number(img.dataset.size) < size) {
        img.dataset.size = size;
        img.src = thumbUrl(it, size);
      }
    }
  }, 250);
}

function sortMenu(anchor) {
  const entry = (key, label) => ({
    icon: state.sort.key === key ? 'check' : 'blank',
    label,
    run: () => {
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
      refreshList();
    },
  });
  openMenu(anchor, [
    entry('name', 'Name'),
    entry('size', 'Size'),
    entry('date', 'Date modified'),
    {
      icon: state.sort.dir > 0 ? 'chevronDown' : 'chevronUp',
      label: state.sort.dir > 0 ? 'Switch to descending' : 'Switch to ascending',
      run: () => {
        state.sort = { ...state.sort, dir: -state.sort.dir };
        refreshList();
      },
    },
  ]);
}

// ---------------------------------------------------------------- item actions

function fileUrl(f, inline) {
  if (f.gp) {
    const video = f.mimeType.startsWith('video/');
    return inline ? gpUrl(f, video ? 'video' : 'full') : `${gpUrl(f, video ? 'video' : 'download')}&dl=1`;
  }
  return `/api/dl/${f.acct}/${f.id}?name=${encodeURIComponent(f.name)}${inline ? '&inline=1' : ''}`;
}

function googleUrl(f) {
  return `${f.link}${f.link.includes('?') ? '&' : '?'}authuser=${encodeURIComponent(acctEmail(f.acct))}`;
}

function openItem(it) {
  if (it.kind === 'folder') {
    if (state.moving?.includes(it)) return toast('That folder is one of the items being moved');
    return navigate([...state.stack, { name: it.name, ids: it.ids }]);
  }
  if (it.gp) return isPreviewable(it) ? preview(it) : download(it);
  if (isNative(it)) return it.link ? window.open(googleUrl(it), '_blank', 'noopener') : toast('This item can only be opened in Google Drive');
  if (isAae(it)) {
    const photo = aaePhoto(it);
    if (photo && isPreviewable(photo)) {
      toast(`${it.name} is the iPhone's edit notes for ${photo.name}, so that photo is shown`);
      return preview(photo);
    }
    return toast(`${it.name} is a small iPhone file listing edits made to a photo. It is not a picture and cannot be opened.`);
  }
  if (isPreviewable(it)) return preview(it);
  if (it.mimeType === 'application/pdf') return window.open(fileUrl(it, true), '_blank', 'noopener');
  download(it);
}

function download(f) {
  const a = h('a', { href: fileUrl(f), download: f.name });
  document.body.append(a);
  a.click();
  a.remove();
}

async function downloadMany(items) {
  for (const f of items) {
    download(f);
    await sleep(600); // browsers drop downloads fired in the same instant
  }
}

// `anchor` is the button that was pressed, or { x, y } for a right-click.
function itemMenu(anchor, it) {
  const group = state.selected.has(it) && state.selected.size > 1 ? [...state.selected] : null;
  if (it.gp) {
    // Picked Google Photos can only be looked at and downloaded.
    const files = group || [it];
    return openMenu(anchor, [
      !group && isPreviewable(it) && { icon: 'eye', label: 'Preview', run: () => preview(it) },
      { icon: 'download', label: group ? `Download ${group.length} files` : 'Download', run: () => downloadMany(files) },
    ]);
  }
  if (group) {
    return openMenu(anchor, [
      group.every(isDownloadable) && { icon: 'download', label: `Download ${group.length} files`, run: () => downloadMany(group) },
      { icon: 'move', label: `Move ${group.length} items`, run: () => startMove(group) },
      { icon: 'trash', label: `Delete ${group.length} items`, danger: true, run: () => removeItems(group) },
    ]);
  }
  const file = it.kind === 'file';
  openMenu(anchor, [
    !file && { icon: 'folder', label: 'Open', run: () => openItem(it) },
    isPreviewable(it) && { icon: 'eye', label: 'Preview', run: () => preview(it) },
    isDownloadable(it) && { icon: 'download', label: 'Download', run: () => download(it) },
    file && it.link && { icon: 'external', label: 'Open in Google Drive', run: () => window.open(googleUrl(it), '_blank', 'noopener') },
    { icon: 'edit', label: 'Rename', run: () => renameItem(it) },
    { icon: 'move', label: 'Move', run: () => startMove([it]) },
    { icon: 'trash', label: 'Delete', danger: true, run: () => removeItems([it]) },
  ]);
}

// Sends refs to an endpoint in batches the server accepts, and reports partial failures.
async function inBatches(path, refs, extra, size) {
  let failed = [];
  for (let i = 0; i < refs.length; i += size) {
    const res = await api(path, { ...extra, items: refs.slice(i, i + size) });
    failed = failed.concat(res.failed || []);
  }
  return failed;
}

async function renameItem(it) {
  const name = await ask({ title: 'Rename', label: 'Name', value: it.name, action: 'Rename' });
  if (!name || name === it.name) return;
  try {
    const failed = await inBatches('/api/rename', refsOf(it), { name }, 20);
    if (failed.length) toast(failed[0], 'error');
  } catch (e) {
    toast(e.message, 'error');
  }
  loadList();
}

async function removeItems(items) {
  const what = items.length === 1 ? `“${items[0].name}”` : plural(items.length, 'item');
  const ok = await confirmBox({
    title: `Delete ${what}?`,
    message: 'It goes to the Google Drive trash, where it can be restored for 30 days. Space is freed once the trash is emptied.',
    action: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const failed = await inBatches('/api/trash', items.flatMap(refsOf), {}, 20);
    if (failed.length) toast(`${plural(failed.length, 'item')} could not be deleted: ${failed[0]}`, 'error');
    else toast(`Deleted ${what}`);
  } catch (e) {
    toast(e.message, 'error');
  }
  loadList();
  loadAccounts();
}

async function newFolder() {
  const name = await ask({ title: 'New folder', label: 'Folder name', action: 'Create' });
  if (!name) return;
  try {
    await api('/api/mkdir', { name, chain: chainOf(state.stack), acct: state.only || undefined });
  } catch (e) {
    toast(e.message, 'error');
  }
  loadList();
}

function startMove(items) {
  state.moving = items;
  state.selected.clear();
  if (state.search) resetView();
  else render();
}

async function doMove() {
  const items = state.moving;
  const inside = items.some(
    (it) => it.kind === 'folder' && state.stack.slice(1).some((s) => Object.entries(it.ids).some(([a, id]) => s.ids?.[a] === id)),
  );
  if (inside) return toast('A folder cannot be moved into itself', 'error');
  state.moving = null;
  render();
  try {
    const failed = await inBatches('/api/move', items.flatMap(refsOf), { chain: chainOf(state.stack) }, 15);
    if (failed.length) toast(`${plural(failed.length, 'item')} could not be moved: ${failed[0]}`, 'error');
    else toast(`Moved ${plural(items.length, 'item')}`);
  } catch (e) {
    toast(e.message, 'error');
  }
  loadList();
}

// ---------------------------------------------------------------- menus and dialogs

let closeMenu = () => {};
let justClosed = null;

function openMenu(anchor, entries) {
  closeMenu();
  const button = anchor instanceof Element ? anchor : null;
  if (button && justClosed === button) return; // second tap on the same button just closes it
  const menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    entries.filter(Boolean).map((entry) =>
      h(
        'button',
        {
          class: `menu-item${entry.danger ? ' danger' : ''}`,
          type: 'button',
          role: 'menuitem',
          onclick: () => {
            closeMenu();
            entry.run();
          },
        },
        icon(entry.icon),
        h('span', null, entry.label),
      ),
    ),
  );
  document.body.append(menu);
  const w = menu.offsetWidth;
  const ht = menu.offsetHeight;
  let left;
  let top;
  if (button) {
    const r = button.getBoundingClientRect();
    left = r.right - w;
    top = r.bottom + 4;
    if (top + ht > innerHeight - 8) top = r.top - ht - 4;
  } else {
    left = anchor.x;
    top = anchor.y;
    if (top + ht > innerHeight - 8) top = anchor.y - ht;
  }
  menu.style.left = `${clamp(left, 8, Math.max(8, innerWidth - w - 8))}px`;
  menu.style.top = `${Math.max(8, top)}px`;

  const outside = (e) => {
    if (menu.contains(e.target)) return;
    if (button?.contains(e.target)) {
      justClosed = button;
      setTimeout(() => (justClosed = null), 300);
    }
    closeMenu();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();
    button?.focus();
  };
  const onScroll = () => closeMenu();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);
  closeMenu = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    closeMenu = () => {};
  };
  menu.querySelector('button')?.focus();
}

function showDialog(content) {
  const dlg = $('#dlg');
  return new Promise((resolve) => {
    dlg.replaceChildren(content);
    dlg.returnValue = '';
    if (!dlg.open) dlg.showModal();
    // The "close" event of a dialog that was just closed arrives a moment later. If this
    // dialog opened in between, that late event must not count as this dialog's answer.
    dlg.onclose = () => {
      if (dlg.open) return;
      dlg.onclose = null;
      resolve(dlg.returnValue);
    };
  });
}

async function ask({ title, label, value = '', action }) {
  const dlg = $('#dlg');
  const input = h('input', { type: 'text', value, maxLength: 255, required: true, autocomplete: 'off' });
  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        if (input.value.trim()) dlg.close(input.value.trim());
      },
    },
    h('h2', null, title),
    h('label', { class: 'field' }, h('span', null, label), input),
    h('div', { class: 'dialog-actions' }, btn('Cancel', () => dlg.close('')), h('button', { class: 'btn primary', type: 'submit' }, action)),
  );
  const done = showDialog(form);
  input.focus();
  const ext = value.lastIndexOf('.');
  input.setSelectionRange(0, ext > 0 ? ext : value.length);
  return (await done) || null;
}

async function confirmBox({ title, message, action, danger }) {
  const dlg = $('#dlg');
  const content = h(
    'div',
    null,
    h('h2', null, title),
    h('p', { class: 'muted' }, message),
    h(
      'div',
      { class: 'dialog-actions' },
      btn('Cancel', () => dlg.close('')),
      btn(action, () => dlg.close('yes'), danger ? 'danger' : 'primary'),
    ),
  );
  return (await showDialog(content)) === 'yes';
}

// ---------------------------------------------------------------- photo and video viewer

const ZOOM_MAX = 8;
const viewer = { items: [], index: 0, scale: 1, x: 0, y: 0, img: null, pct: null };

function preview(f) {
  const all = state.visible.filter(isPreviewable);
  viewer.items = all.includes(f) ? all : [f];
  viewer.index = viewer.items.indexOf(f);
  const dlg = $('#preview');
  dlg.onclose = () => {
    dlg.replaceChildren(); // also stops playback
    viewer.img = null;
  };
  if (!dlg.open) dlg.showModal();
  showInViewer();
}

function stepViewer(delta) {
  const next = viewer.index + delta;
  if (next < 0 || next >= viewer.items.length) return;
  viewer.index = next;
  showInViewer();
}

function showInViewer() {
  const dlg = $('#preview');
  const f = viewer.items[viewer.index];
  const src = viewSrc(f);
  const type = f.mimeType.split('/')[0];
  const count = viewer.items.length;
  Object.assign(viewer, { scale: 1, x: 0, y: 0, img: null, pct: null });

  const stage = h('div', { class: 'stage' });
  let tools = null;
  if (type === 'image') {
    const img = h('img', { src, alt: f.name });
    img.draggable = false;
    stage.classList.add('loading');
    img.addEventListener('load', () => stage.classList.remove('loading'));
    img.addEventListener('error', () => {
      stage.classList.remove('loading');
      img.replaceWith(h('p', { class: 'muted' }, 'This image could not be loaded.'));
    });
    viewer.img = img;
    viewer.pct = h('span', { class: 'pct' }, '100%');
    stage.append(h('p', { class: 'muted stage-wait' }, 'Loading…'), img);
    bindZoom(stage);
    tools = [
      iconBtn('zoomOut', 'Zoom out', () => zoomBy(1 / 1.4)),
      viewer.pct,
      iconBtn('zoomIn', 'Zoom in', () => zoomBy(1.4)),
      iconBtn('fit', 'Fit to screen', () => zoomTo(1, 0, 0)),
    ];
  } else if (type === 'video') {
    stage.append(h('video', { src, controls: true, autoplay: true, playsInline: true }));
  } else {
    stage.append(h('audio', { src, controls: true, autoplay: true }));
  }
  if (count > 1) {
    const nav = (cls, iconName, label, delta, off) =>
      h('button', { class: `nav ${cls}`, type: 'button', 'aria-label': label, title: label, disabled: off, onclick: () => stepViewer(delta) }, icon(iconName));
    stage.append(
      nav('prev', 'chevronLeft', 'Previous', -1, viewer.index === 0),
      nav('next', 'chevron', 'Next', 1, viewer.index === count - 1),
    );
  }
  dlg.replaceChildren(
    h(
      'header',
      null,
      h('span', { class: 'title grow' }, f.name),
      count > 1 && h('span', { class: 'pct' }, `${viewer.index + 1} / ${count}`),
      tools,
      iconBtn('download', 'Download', () => download(f)),
      iconBtn('x', 'Close', () => dlg.close()),
    ),
    stage,
  );
}

// Zooms so the point (cx, cy), measured from the centre of the stage, stays put.
function zoomTo(scale, cx, cy) {
  if (!viewer.img) return;
  scale = clamp(scale, 1, ZOOM_MAX);
  const k = scale / viewer.scale;
  viewer.x = cx - (cx - viewer.x) * k;
  viewer.y = cy - (cy - viewer.y) * k;
  viewer.scale = scale;
  applyZoom();
}

const zoomBy = (factor) => zoomTo(viewer.scale * factor, 0, 0);

function applyZoom() {
  const img = viewer.img;
  if (!img?.parentElement) return;
  const stage = img.parentElement;
  // Keep the picture from being dragged off screen.
  const maxX = Math.max(0, (img.offsetWidth * viewer.scale - stage.clientWidth) / 2);
  const maxY = Math.max(0, (img.offsetHeight * viewer.scale - stage.clientHeight) / 2);
  viewer.x = clamp(viewer.x, -maxX, maxX);
  viewer.y = clamp(viewer.y, -maxY, maxY);
  img.style.transform = `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.scale})`;
  viewer.pct.textContent = `${Math.round(viewer.scale * 100)}%`;
  stage.classList.toggle('zoomed', viewer.scale > 1);
}

// Wheel and pinch zoom, drag to pan, double-click to zoom in or back out, swipe for next/previous.
function bindZoom(stage) {
  const pts = new Map();
  let startDist = 0;
  let startScale = 1;
  let downX = 0;
  let pinched = false;
  const rel = (x, y) => {
    const r = stage.getBoundingClientRect();
    return [x - r.left - r.width / 2, y - r.top - r.height / 2];
  };
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomTo(viewer.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), ...rel(e.clientX, e.clientY));
    },
    { passive: false },
  );
  stage.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    if (viewer.scale > 1) zoomTo(1, 0, 0);
    else zoomTo(2.5, ...rel(e.clientX, e.clientY));
  });
  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      downX = e.clientX;
      pinched = false;
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      startDist = Math.hypot(a.x - b.x, a.y - b.y);
      startScale = viewer.scale;
      pinched = true;
    }
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (startDist) zoomTo((startScale * dist) / startDist, ...rel((a.x + b.x) / 2, (a.y + b.y) / 2));
    } else if (viewer.scale > 1) {
      viewer.x += dx;
      viewer.y += dy;
      applyZoom();
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size) return;
    stage.classList.remove('dragging');
    const swipe = e.clientX - downX;
    if (e.type === 'pointerup' && e.pointerType !== 'mouse' && !pinched && viewer.scale === 1 && Math.abs(swipe) > 60) {
      stepViewer(swipe < 0 ? 1 : -1);
    }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
}

function viewerKey(e) {
  if (e.target.closest?.('video, audio')) return; // leave the player's own keys alone
  if (e.key === 'ArrowLeft') stepViewer(-1);
  else if (e.key === 'ArrowRight') stepViewer(1);
  else if (e.key === '+' || e.key === '=') zoomBy(1.4);
  else if (e.key === '-') zoomBy(1 / 1.4);
  else if (e.key === '0') zoomTo(1, 0, 0);
  else return;
  e.preventDefault();
}

// ---------------------------------------------------------------- Google Photos

function openGooglePhotos(a) {
  window.open(`https://photos.google.com/?authuser=${encodeURIComponent(a.email)}`, '_blank', 'noopener');
}

function photosDialog() {
  const dlg = $('#dlg');
  const accts = (state.accounts || []).filter((a) => !a.error);
  const rows = accts.map((a) =>
    h(
      'li',
      { class: 'gp-row' },
      dot(a.id),
      h('span', { class: 'grow gp-email', title: a.email }, a.email),
      btn('View here', () => {
        dlg.close('');
        pickPhotos(a);
      }),
      iconBtn('external', `Open Google Photos for ${a.email}`, () => {
        dlg.close('');
        openGooglePhotos(a);
      }),
    ),
  );
  showDialog(
    h(
      'div',
      null,
      h('h2', null, 'Google Photos'),
      h(
        'p',
        { class: 'muted small' },
        'View here: choose photos in Google’s picker and see them in DrivePool (Google allows about an hour). To browse everything, open Google Photos.',
      ),
      h('ul', { class: 'gp-list' }, rows),
      h('div', { class: 'dialog-actions' }, btn('Close', () => dlg.close(''))),
    ),
  );
}

// Must be called straight from a click, so the picker window is not blocked as a pop-up.
async function pickPhotos(a) {
  if (!a.photos) {
    const ok = await confirmBox({
      title: 'Allow Google Photos?',
      message: `To show photos from ${a.email}, DrivePool needs one more permission. On Google's screen, choose ${a.email}, then make sure the box for Google Photos is ticked (it starts unticked) before pressing Continue.`,
      action: 'Continue',
    });
    if (ok) connectAccount();
    return;
  }
  const win = window.open('about:blank', '_blank');
  if (win) win.opener = null;
  let session;
  try {
    session = await api('/api/photos/session', { acct: a.id });
  } catch (e) {
    win?.close();
    return toast(e.message, 'error');
  }
  const uri = `${session.pickerUri.replace(/\/$/, '')}/autoclose`;
  if (win) win.location.href = uri;
  waitForPick(a, session, uri);
}

async function waitForPick(a, session, uri) {
  const token = {};
  state.picking = { email: a.email, uri, token };
  renderToolbar();
  const end = Date.now() + session.timeoutMs;
  let wait = session.pollMs;
  while (state.picking?.token === token) {
    if (Date.now() > end) {
      toast('Picking timed out. Try again.', 'error');
      break;
    }
    await sleep(wait);
    if (state.picking?.token !== token) return;
    try {
      const r = await api('/api/photos/poll', { acct: a.id, id: session.id });
      if (r.ready) {
        state.picking = null;
        if (!r.items.length) {
          toast('No photos were picked');
          renderToolbar();
          return;
        }
        showPicked(a, r.items);
        return;
      }
      wait = r.pollMs || wait;
    } catch (e) {
      toast(e.message, 'error');
      break;
    }
  }
  if (state.picking?.token === token) state.picking = null;
  renderToolbar();
}

function showPicked(a, items) {
  if (!state.gphotos) history.pushState({ stack: state.stack }, ''); // so Back returns to the folder
  state.gphotos = { acct: a.id, email: a.email };
  state.search = '';
  $('#search').value = '';
  state.items = {
    folders: [],
    files: items.map((m) => ({
      kind: 'file',
      acct: a.id,
      id: m.id,
      gp: m.baseUrl,
      name: m.filename,
      mimeType: m.mimeType,
      size: null,
      modifiedTime: m.createTime,
      thumb: true,
      link: null,
    })),
  };
  state.errors = [];
  state.truncated = false;
  state.selected.clear();
  state.anchor = state.cursor = null;
  closeSidebar();
  render();
}

// ---------------------------------------------------------------- uploads

const ACTIVE = ['queued', 'starting', 'uploading'];
const recentUploads = []; // { acct, size, at }: sent to the server so it does not overfill an account
let pumping = false;

function queueUploads(files) {
  files = [...files];
  if (!files.length) return;
  if (!state.accounts?.length) {
    report('upload-blocked', { reason: state.accounts ? 'no accounts' : 'accounts not loaded yet' });
    return toast(state.accounts ? 'Connect a Google account first' : 'Still loading your accounts. Try again in a moment.', 'error');
  }
  const stack = state.stack.map((s) => ({ ...s }));
  for (const file of files) {
    state.uploads.push({ file, name: file.name, size: file.size, sent: 0, status: 'queued', stack, only: state.only });
  }
  state.uploadsCollapsed = false;
  renderUploads();
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  let next;
  while ((next = state.uploads.find((u) => u.status === 'queued'))) {
    await runUpload(next);
    renderUploads();
    if (next.status === 'done' && !state.search && samePath(next.stack, state.stack) && !state.selected.size) loadList();
  }
  pumping = false;
  loadAccounts();
}

function pendingByAccount() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  const out = {};
  for (const r of recentUploads) if (r.at > cutoff) out[r.acct] = (out[r.acct] || 0) + r.size;
  return out;
}

async function runUpload(u) {
  u.status = 'starting';
  u.sent = 0;
  u.cancelled = false;
  renderUploads();
  try {
    const target = await api('/api/upload/target', {
      name: u.name,
      size: u.size,
      force: !!u.force,
      acct: u.only || undefined,
      chain: chainOf(u.stack),
      pending: pendingByAccount(),
    });
    if (u.cancelled) throw new Error('Cancelled');
    if (target.duplicate) {
      u.status = 'skipped';
      u.email = target.duplicate.email;
      return;
    }
    target.chainIds.forEach((id, i) => {
      if (id) u.stack[i + 1].ids = { ...(u.stack[i + 1].ids || {}), [target.acct]: id };
    });
    Object.assign(u, { acct: target.acct, email: target.email, token: target.token, status: 'uploading' });
    renderUploads();

    const meta = { name: u.name };
    if (target.folderId !== 'root') meta.parents = [target.folderId];
    const init = await fetch(`${target.uploadBase}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': u.file.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(u.size),
      },
      body: JSON.stringify(meta),
    });
    if (!init.ok) throw new Error(googleMessage(await init.text()) || `Google refused the upload (${init.status})`);
    const session = init.headers.get('Location');
    if (!session) throw new Error('Google did not open an upload session');

    await sendFile(u, session);
    recentUploads.push({ acct: u.acct, size: u.size, at: Date.now() });
    u.sent = u.size;
    u.status = 'done';
  } catch (e) {
    u.status = u.cancelled ? 'cancelled' : 'error';
    if (!u.cancelled) report('upload-failed', { error: e.message, size: u.size, type: u.file?.type || '?', sent: u.sent });
    u.error = e.message === 'Failed to fetch' ? 'Connection lost' : e.message;
  }
  u.xhr = null;
}

function googleMessage(text) {
  try {
    return JSON.parse(text).error.message;
  } catch {
    return '';
  }
}

function put(u, session, blob, contentRange, base = 0) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    u.xhr = xhr;
    xhr.open('PUT', session);
    xhr.setRequestHeader('Authorization', `Bearer ${u.token}`);
    if (contentRange) xhr.setRequestHeader('Content-Range', contentRange);
    xhr.upload.onprogress = (e) => {
      u.sent = base + e.loaded;
      updateProgress(u);
    };
    xhr.onload = () => resolve({ status: xhr.status, range: xhr.getResponseHeader('Range'), text: xhr.responseText });
    xhr.onerror = xhr.ontimeout = () => reject(new Error('Connection lost'));
    xhr.onabort = () => reject(new Error('Cancelled'));
    xhr.send(blob);
  });
}

// Google answers 308 with "Range: bytes=0-N" for what it has stored so far.
const storedUpTo = (range, fallback) => {
  const m = /bytes=0-(\d+)/.exec(range || '');
  return m ? Number(m[1]) + 1 : fallback;
};

// Sends the file in chunks. After a dropped connection it asks Google how much
// arrived and carries on from there instead of starting over.
async function sendFile(u, session) {
  const size = u.size;
  if (size === 0) {
    const r = await put(u, session, new Blob([]), null);
    if (r.status >= 300) throw new Error(googleMessage(r.text) || `Upload failed (${r.status})`);
    return;
  }
  let offset = 0;
  let failures = 0;
  for (;;) {
    const end = Math.min(offset + CHUNK, size);
    let r;
    try {
      r = await put(u, session, u.file.slice(offset, end), `bytes ${offset}-${end - 1}/${size}`, offset);
    } catch (e) {
      if (u.cancelled) throw e;
      r = { status: 0 };
    }
    if (r.status === 200 || r.status === 201) return;
    if (r.status === 308) {
      failures = 0;
      offset = storedUpTo(r.range, end);
      continue;
    }
    if (++failures > 6) throw new Error(googleMessage(r.text) || 'The upload kept failing. Check your connection and try again.');
    if (r.status === 401) {
      u.token = (await api('/api/upload/token', { acct: u.acct })).token;
      continue;
    }
    if (r.status !== 0 && r.status !== 429 && r.status < 500) {
      throw new Error(googleMessage(r.text) || `Upload failed (${r.status})`);
    }
    await sleep(Math.min(30000, 1000 * 2 ** failures));
    if (u.cancelled) throw new Error('Cancelled');
    try {
      const s = await put(u, session, null, `bytes */${size}`, offset);
      if (s.status === 200 || s.status === 201) return;
      if (s.status === 308) offset = storedUpTo(s.range, 0);
    } catch (e) {
      if (u.cancelled) throw e;
    }
    u.sent = offset;
    updateProgress(u);
  }
}

function cancelUpload(u) {
  u.cancelled = true;
  if (u.status === 'queued') u.status = 'cancelled';
  u.xhr?.abort();
  renderUploads();
}

function uploadStatus(u) {
  switch (u.status) {
    case 'queued':
      return 'Waiting';
    case 'starting':
      return 'Choosing an account…';
    case 'uploading':
      return `${fmtBytes(u.sent)} of ${fmtBytes(u.size)} · ${u.email}`;
    case 'done':
      return `Saved to ${u.email}`;
    case 'cancelled':
      return 'Cancelled';
    case 'skipped':
      return `Skipped: already in this folder (${u.email})`;
    default:
      return u.error || 'Failed';
  }
}

function updateProgress(u) {
  if (!u.els) return;
  u.els.fill.style.width = `${u.size ? (u.sent / u.size) * 100 : 100}%`;
  u.els.status.textContent = uploadStatus(u);
}

function renderUploads() {
  const box = $('#uploads');
  const ups = state.uploads;
  box.hidden = !ups.length;
  if (!ups.length) return;
  const active = ups.filter((u) => ACTIVE.includes(u.status)).length;
  const done = ups.filter((u) => u.status === 'done').length;
  const failed = ups.filter((u) => u.status === 'error').length;
  const skipped = ups.filter((u) => u.status === 'skipped').length;
  const title = active
    ? `Uploading ${plural(active, 'file')}`
    : [done && `${done} uploaded`, skipped && `${skipped} already there`, failed && `${failed} failed`].filter(Boolean).join(', ') ||
      'Uploads';

  const rows = ups.map((u) => {
    const bar = meter(u.size ? u.sent / u.size : u.status === 'done' ? 1 : 0);
    const status = h('div', { class: `small ${u.status === 'error' ? 'acct-error' : 'muted'}` }, uploadStatus(u));
    u.els = { fill: bar.firstChild, status };
    return h(
      'li',
      { class: `upload ${u.status}` },
      h('div', { class: 'upload-info' }, h('div', { class: 'upload-name', title: u.name }, u.name), status, ACTIVE.includes(u.status) && bar),
      ACTIVE.includes(u.status) && iconBtn('x', `Cancel ${u.name}`, () => cancelUpload(u)),
      u.status === 'skipped' &&
        iconBtn('upload', `Upload ${u.name} anyway`, () => {
          u.force = true;
          u.status = 'queued';
          renderUploads();
          pump();
        }),
      (u.status === 'error' || u.status === 'cancelled') &&
        iconBtn('refresh', `Try ${u.name} again`, () => {
          u.status = 'queued';
          renderUploads();
          pump();
        }),
    );
  });

  box.replaceChildren(
    h(
      'header',
      null,
      h('strong', { class: 'grow' }, title),
      iconBtn(state.uploadsCollapsed ? 'chevronUp' : 'chevronDown', state.uploadsCollapsed ? 'Show uploads' : 'Hide uploads', () => {
        state.uploadsCollapsed = !state.uploadsCollapsed;
        renderUploads();
      }),
      !active &&
        iconBtn('x', 'Dismiss', () => {
          state.uploads = [];
          renderUploads();
        }),
    ),
    !state.uploadsCollapsed && h('ul', null, rows),
  );
}

// ---------------------------------------------------------------- sign-in and start-up

function showLogin(message) {
  $('#shell').hidden = true;
  $('#login').hidden = false;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close(''));
  closeMenu();
  if (message) $('#login-hint').textContent = message;
  const canPasskey = state.hasPasskeys && passkeysSupported();
  $('#passkey-btn').hidden = $('#passkey-or').hidden = !canPasskey;
  $('#passkey-btn').textContent = `Unlock with ${bioName()}`;
  // On a Face ID device, the Face ID button comes first; typing the password is the fallback.
  if (canPasskey && prefs.get('lock', false)) $('#passkey-btn').focus();
  else $('#login-pw').focus();
}

// ---------------------------------------------------------------- Face ID and other passkeys

const LOCKED_MESSAGE = 'DrivePool locked itself after 5 minutes without use.';

const passkeysSupported = () => !!window.PublicKeyCredential && !!navigator.credentials;

function bioName() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'Face ID';
  if (/Macintosh/.test(ua)) return 'Touch ID';
  if (/Android/.test(ua)) return 'fingerprint';
  if (/Windows/.test(ua)) return 'Windows Hello';
  return 'passkey';
}

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Device';
}

const toB64url = (buf) => {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const withIds = (list) => (list || []).map((c) => ({ ...c, id: fromB64url(c.id) }));

function passkeyError(e) {
  if (e?.name === 'NotAllowedError') return `${bioName()} was cancelled or timed out.`;
  if (e?.name === 'InvalidStateError') return `${bioName()} is already set up on this device.`;
  return e?.message || `${bioName()} did not work.`;
}

async function setUpPasskey() {
  const { options, token } = await api('/api/passkey/register-options', {});
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: fromB64url(options.challenge),
      user: { ...options.user, id: fromB64url(options.user.id) },
      excludeCredentials: withIds(options.excludeCredentials),
    },
  });
  const r = cred.response;
  const response = {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      attestationObject: toB64url(r.attestationObject),
      transports: r.getTransports?.() || [],
    },
  };
  await api('/api/passkey/register', { token, response, name: deviceLabel() });
  prefs.set('lock', true);
  state.hasPasskeys = true;
}

async function unlockWithPasskey() {
  const res = await fetch('/api/passkey/login-options', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not start Face ID');
  const { options, token } = data;
  const cred = await navigator.credentials.get({
    publicKey: { ...options, challenge: fromB64url(options.challenge), allowCredentials: withIds(options.allowCredentials) },
  });
  const r = cred.response;
  const response = {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: r.userHandle ? toB64url(r.userHandle) : undefined,
    },
  };
  const done = await fetch('/api/passkey/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, response }),
  });
  const out = await done.json().catch(() => ({}));
  if (!done.ok) throw new Error(out.error || `${bioName()} sign-in failed`);
  prefs.set('lock', true); // this device unlocks with a passkey, so keep locking it
}

async function passkeyDialog() {
  const dlg = $('#dlg');
  let list = [];
  try {
    list = (await api('/api/passkeys')).passkeys;
  } catch (e) {
    return toast(e.message, 'error');
  }
  const when = (t) => (t ? dateFmt.format(new Date(t)) : 'never');
  const rows = list.map((p) =>
    h(
      'li',
      { class: 'gp-row' },
      icon('lock'),
      h('span', { class: 'grow' }, h('div', null, p.name), h('div', { class: 'muted small' }, `Added ${when(p.createdAt)} · last used ${when(p.lastUsed)}`)),
      iconBtn('trash', `Remove ${p.name}`, async () => {
        dlg.close('');
        const ok = await confirmBox({
          title: `Remove ${p.name}?`,
          message: `That device will no longer unlock DrivePool with ${bioName()}. The password still works.`,
          action: 'Remove',
          danger: true,
        });
        if (!ok) return;
        try {
          await api('/api/passkey/remove', { id: p.id });
          toast('Removed');
          state.hasPasskeys = list.length > 1;
        } catch (e) {
          toast(e.message, 'error');
        }
      }),
    ),
  );
  const setup = btn(`Set up ${bioName()} on this device`, async () => {
    setup.disabled = true;
    try {
      await setUpPasskey();
      dlg.close('');
      toast(`${bioName()} is set up. DrivePool will lock after 5 minutes without use.`);
    } catch (e) {
      toast(passkeyError(e), 'error');
      setup.disabled = false;
    }
  }, 'primary', 'lock');
  if (!passkeysSupported()) setup.disabled = true;
  showDialog(
    h(
      'div',
      null,
      h('h2', null, `${bioName()} lock`),
      h(
        'p',
        { class: 'muted small' },
        `Unlock DrivePool with ${bioName()} instead of typing the password. On devices set up this way, DrivePool locks itself after 5 minutes without use. Your password always works too.`,
      ),
      rows.length ? h('ul', { class: 'gp-list' }, rows) : h('p', { class: 'muted small' }, 'No device is set up yet.'),
      setup,
      !passkeysSupported() && h('p', { class: 'error small' }, 'This browser does not support passkeys.'),
      h('div', { class: 'dialog-actions' }, btn('Close', () => dlg.close(''))),
    ),
  );
}

async function signOut() {
  await api('/api/logout', {}).catch(() => {});
  location.href = '/';
}

function enterApp() {
  $('#login').hidden = true;
  $('#shell').hidden = false;
  const params = new URLSearchParams(location.search);
  if (params.get('connected')) toast(`Connected ${params.get('connected')}`);
  if (params.get('error')) toast(params.get('error'), 'error');
  if (Array.isArray(history.state?.stack) && history.state.stack.length) state.stack = history.state.stack;
  history.replaceState({ stack: state.stack }, '', '/');
  renderSidebar();
  loadAccounts();
  loadList();
}

function wire() {
  $('#search-icon').append(icon('search'));

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    const button = $('#login-btn');
    err.hidden = true;
    button.disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#login-pw').value, lock: prefs.get('lock', false) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not sign in');
      $('#login-pw').value = '';
      enterApp();
    } catch (ex) {
      err.textContent = ex.message === 'Failed to fetch' ? 'No connection. Try again.' : ex.message;
      err.hidden = false;
    }
    button.disabled = false;
  });

  $('#passkey-btn').addEventListener('click', async () => {
    const err = $('#login-error');
    const button = $('#passkey-btn');
    err.hidden = true;
    button.disabled = true;
    try {
      await unlockWithPasskey();
      enterApp();
    } catch (ex) {
      err.textContent = ex.message === 'Failed to fetch' ? 'No connection. Try again.' : passkeyError(ex);
      err.hidden = false;
    }
    button.disabled = false;
  });

  // Coming back to DrivePool after a while: if this device has locked, show the lock screen
  // straight away instead of the files.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || $('#shell').hidden) return;
    const me = await fetch('/api/me').then((r) => r.json()).catch(() => null);
    if (me && me.configured && !me.authed) showLogin(me.locked ? LOCKED_MESSAGE : undefined);
  });

  $('#home-link').addEventListener('click', (e) => {
    e.preventDefault();
    navigate([root()]);
  });
  $('#storage-toggle').addEventListener('click', openSidebar);
  $('#backdrop').addEventListener('click', closeSidebar);

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const q = e.target.value.trim();
      if (q === state.search) return;
      state.gphotos = null;
      state.search = q;
      state.items = null;
      loadList();
    }, 350);
  });

  window.addEventListener('popstate', (e) => {
    state.stack = Array.isArray(e.state?.stack) && e.state.stack.length ? e.state.stack : [root()];
    resetView();
  });

  // Some mobile browsers send "input" rather than "change" after a gallery pick; handle
  // whichever arrives first (the field is emptied afterwards, so the other one is a no-op).
  const onPicked = (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    report('picked', { count: files.length, sizes: files.map((f) => f.size), types: files.map((f) => f.type || '?') });
    e.target.value = '';
    queueUploads(files);
  };
  $('#file-input').addEventListener('change', onPicked);
  $('#file-input').addEventListener('input', onPicked);

  // Drag and drop anywhere on the page.
  const drop = $('#drop');
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || $('#shell').hidden) return;
    e.preventDefault();
    depth++;
    drop.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) drop.hidden = true;
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    drop.hidden = true;
    if ($('#shell').hidden) return;
    const entries = [...e.dataTransfer.items].map((i) => i.webkitGetAsEntry?.());
    const files = [...e.dataTransfer.files].filter((_, i) => !entries[i]?.isDirectory);
    if (files.length < e.dataTransfer.files.length) toast('Folders cannot be dropped. Open the folder and drop its files instead.', 'error');
    if (state.search || state.gphotos) return toast('Go back to a folder first, then drop files into it', 'error');
    queueUploads(files);
  });

  // Desktop file-manager behaviour: keyboard shortcuts, click on empty space, Ctrl+wheel to resize thumbnails.
  document.addEventListener('keydown', onKey);
  const main = document.querySelector('.main');
  main.addEventListener('click', (e) => {
    if ((e.target === main || e.target === $('#list')) && state.selected.size) setSelection([]);
  });
  main.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || state.view !== 'grid') return;
      e.preventDefault();
      setTile(state.tile + (e.deltaY < 0 ? 16 : -16));
    },
    { passive: false },
  );
  window.addEventListener('resize', () => applyZoom());

  for (const id of ['#dlg', '#preview']) {
    const dlg = $(id);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close('');
    });
  }

  window.addEventListener('beforeunload', (e) => {
    if (state.uploads.some((u) => ACTIVE.includes(u.status))) e.preventDefault();
  });
}

// Sends a short note about a problem to the server log (no file names or contents),
// so problems that only happen on someone's phone can be diagnosed.
function report(event, data = {}) {
  try {
    const body = JSON.stringify({ event, data, ua: navigator.userAgent.slice(0, 200) });
    if (!navigator.sendBeacon?.('/api/client-log', new Blob([body], { type: 'application/json' }))) {
      fetch('/api/client-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch {}
}
window.addEventListener('error', (e) => report('js-error', { message: String(e.message).slice(0, 300), at: `${e.lineno}:${e.colno}` }));
window.addEventListener('unhandledrejection', (e) => report('js-error', { message: String(e.reason?.message || e.reason).slice(0, 300) }));

async function init() {
  wire();
  const me = await fetch('/api/me')
    .then((r) => r.json())
    .catch(() => null);
  if (!me) return showLogin('Cannot reach the server. Check your connection and reload.');
  if (!me.configured) {
    $('#login-form').querySelector('.field').hidden = true;
    $('#login-btn').hidden = true;
    return showLogin(`Setup is not finished. Still missing: ${me.missing.join(', ')}. See README.md.`);
  }
  state.hasPasskeys = !!me.passkeys;
  if (!me.authed) return showLogin(me.locked ? LOCKED_MESSAGE : undefined);
  enterApp();
}

init();
