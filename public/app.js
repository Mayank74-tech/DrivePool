// DrivePool front end. No build step: plain modules, DOM built with h().

const PALETTE = ['#4f7cff', '#12b76a', '#f79009', '#ee46bc', '#7a5af8', '#06aed4', '#f04438', '#84cc16'];
const CHUNK = 16 * 1024 * 1024; // must be a multiple of 256 KiB for Google's resumable uploads
const NATIVE = 'application/vnd.google-apps.';
const PREVIEWABLE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/|audio\/)/;
const root = () => ({ name: 'All files', ids: null });

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
    showLogin();
    throw new Error('Please sign in again');
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
      { class: 'acct' },
      dot(a.id),
      h(
        'div',
        { class: 'acct-info' },
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
    h('p', { class: 'muted small note' }, 'Each account’s space is shared with its Gmail and Google Photos.'),
    h('div', { class: 'side-foot' }, btn('Sign out', signOut, 'quiet', 'logout')),
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
  state.search = '';
  $('#search').value = '';
  state.items = null;
  loadList();
}

let listSeq = 0;
async function loadList() {
  const seq = ++listSeq;
  $('#list').classList.add('loading');
  state.selected.clear();
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
  return [...[...state.items.folders].sort(by), ...[...state.items.files].sort(by)];
}

// ---------------------------------------------------------------- rendering the file area

function render() {
  renderCrumbs();
  renderToolbar();
  renderNotices();
  renderList();
}

function renderCrumbs() {
  const box = $('#crumbs');
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
      iconBtn('move', 'Move', () => startMove(sel)),
      iconBtn('trash', 'Delete', () => removeItems(sel)),
      iconBtn('x', 'Clear selection', () => {
        state.selected.clear();
        render();
      }),
    );
    return;
  }
  bar.className = 'toolbar';
  if (state.search) {
    const n = state.items ? state.items.files.length : 0;
    bar.replaceChildren(
      grow(state.items ? `${plural(n, 'file')} matching “${state.search}”` : 'Searching…'),
      btn('Clear search', resetView),
    );
    return;
  }
  const noAccounts = !state.accounts?.length;
  const upload = btn('Upload', () => $('#file-input').click(), 'primary', 'upload');
  const folder = btn('New folder', newFolder, '', 'folderPlus');
  upload.disabled = folder.disabled = noAccounts;
  bar.replaceChildren(upload, folder, h('span', { class: 'grow' }), iconBtn('refresh', 'Refresh', refreshAll));
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
  if (state.truncated) {
    out.push(h('div', { class: 'notice' }, icon('alert'), h('span', null, 'This folder is very large, so only the first few thousand items are shown.')));
  }
  $('#notices').replaceChildren(...out);
}

function emptyState(iconName, title, text, action) {
  return h('div', { class: 'empty' }, icon(iconName), h('h2', null, title), text && h('p', { class: 'muted' }, text), action);
}

function renderList() {
  const box = $('#list');
  const head = $('#list-head');
  head.hidden = true;

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
        : emptyState('folder', 'This folder is empty', 'Drop files here, or use Upload.'),
    );
    return;
  }

  const allSelected = items.every((it) => state.selected.has(it));
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
          renderList();
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
        checked: allSelected,
        'aria-label': 'Select everything',
        onchange: (e) => {
          state.selected = new Set(e.target.checked ? items : []);
          render();
        },
      }),
    ),
    sortBtn('name', 'Name'),
    h('span', { class: 'acct-col' }, 'Stored in'),
    sortBtn('size', 'Size'),
    sortBtn('date', 'Modified'),
    h('span'),
  );
  box.replaceChildren(...items.map(row));
}

function typeIcon(it) {
  if (it.kind === 'folder') return 'folder';
  const type = it.mimeType.split('/')[0];
  return type === 'image' || type === 'video' || type === 'audio' ? type : 'file';
}

function leadingVisual(it) {
  const fallback = h('span', { class: `glyph ${it.kind === 'folder' ? 'is-folder' : ''}` }, icon(typeIcon(it)));
  if (it.kind !== 'file' || !it.thumb) return fallback;
  const img = h('img', { class: 'thumb', alt: '', loading: 'lazy', src: `/api/thumb/${it.acct}/${it.id}` });
  img.addEventListener('error', () => img.replaceWith(fallback));
  return img;
}

function row(it) {
  const accts = it.kind === 'folder' ? Object.keys(it.ids) : [it.acct];
  const sub = h(
    'span',
    { class: 'sub' },
    accts.map(dot),
    [it.kind === 'file' && it.size != null && fmtBytes(it.size), fmtDate(it.modifiedTime)].filter(Boolean).join(' · '),
  );
  const el = h(
    'div',
    { class: `row${state.selected.has(it) ? ' selected' : ''}` },
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: state.selected.has(it),
        'aria-label': `Select ${it.name}`,
        onchange: (e) => {
          if (e.target.checked) state.selected.add(it);
          else state.selected.delete(it);
          render();
        },
      }),
    ),
    h(
      'button',
      { class: 'name', type: 'button', title: it.name, onclick: () => openItem(it) },
      leadingVisual(it),
      h('span', { class: 'text' }, h('span', { class: 'title' }, it.name), sub),
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
  return el;
}

// ---------------------------------------------------------------- item actions

const fileUrl = (f, inline) => `/api/dl/${f.acct}/${f.id}?name=${encodeURIComponent(f.name)}${inline ? '&inline=1' : ''}`;

function googleUrl(f) {
  return `${f.link}${f.link.includes('?') ? '&' : '?'}authuser=${encodeURIComponent(acctEmail(f.acct))}`;
}

function openItem(it) {
  if (it.kind === 'folder') {
    if (state.moving?.includes(it)) return toast('That folder is one of the items being moved');
    return navigate([...state.stack, { name: it.name, ids: it.ids }]);
  }
  if (isNative(it)) return it.link ? window.open(googleUrl(it), '_blank', 'noopener') : toast('This item can only be opened in Google Drive');
  if (PREVIEWABLE.test(it.mimeType)) return preview(it);
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

function itemMenu(anchor, it) {
  const file = it.kind === 'file';
  openMenu(anchor, [
    !file && { icon: 'folder', label: 'Open', run: () => openItem(it) },
    file && PREVIEWABLE.test(it.mimeType) && { icon: 'eye', label: 'Preview', run: () => preview(it) },
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
    await api('/api/mkdir', { name, chain: chainOf(state.stack) });
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
  if (justClosed === anchor) return; // second tap on the same button just closes it
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
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8));
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const outside = (e) => {
    if (menu.contains(e.target)) return;
    if (anchor.contains(e.target)) {
      justClosed = anchor;
      setTimeout(() => (justClosed = null), 300);
    }
    closeMenu();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();
    anchor.focus();
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
    dlg.onclose = () => resolve(dlg.returnValue);
    dlg.showModal();
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

function preview(f) {
  const dlg = $('#preview');
  const src = fileUrl(f, true);
  const type = f.mimeType.split('/')[0];
  const media =
    type === 'image'
      ? h('img', { src, alt: f.name })
      : type === 'video'
        ? h('video', { src, controls: true, autoplay: true, playsInline: true })
        : h('audio', { src, controls: true, autoplay: true });
  dlg.replaceChildren(
    h(
      'header',
      null,
      h('span', { class: 'title grow' }, f.name),
      iconBtn('download', 'Download', () => download(f)),
      iconBtn('x', 'Close', () => dlg.close()),
    ),
    h('div', { class: 'preview-body' }, media),
  );
  dlg.onclose = () => dlg.replaceChildren(); // also stops playback
  dlg.showModal();
}

// ---------------------------------------------------------------- uploads

const ACTIVE = ['queued', 'starting', 'uploading'];
const recentUploads = []; // { acct, size, at }: sent to the server so it does not overfill an account
let pumping = false;

function queueUploads(files) {
  files = [...files];
  if (!files.length) return;
  if (!state.accounts?.length) return toast('Connect a Google account first', 'error');
  const stack = state.stack.map((s) => ({ ...s }));
  for (const file of files) {
    state.uploads.push({ file, name: file.name, size: file.size, sent: 0, status: 'queued', stack });
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
    const target = await api('/api/upload/target', { size: u.size, chain: chainOf(u.stack), pending: pendingByAccount() });
    if (u.cancelled) throw new Error('Cancelled');
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
  const title = active
    ? `Uploading ${plural(active, 'file')}`
    : failed
      ? `${done} uploaded, ${failed} failed`
      : `${plural(done, 'upload')} complete`;

  const rows = ups.map((u) => {
    const bar = meter(u.size ? u.sent / u.size : u.status === 'done' ? 1 : 0);
    const status = h('div', { class: `small ${u.status === 'error' ? 'acct-error' : 'muted'}` }, uploadStatus(u));
    u.els = { fill: bar.firstChild, status };
    return h(
      'li',
      { class: `upload ${u.status}` },
      h('div', { class: 'upload-info' }, h('div', { class: 'upload-name', title: u.name }, u.name), status, ACTIVE.includes(u.status) && bar),
      ACTIVE.includes(u.status) && iconBtn('x', `Cancel ${u.name}`, () => cancelUpload(u)),
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
  if (message) $('#login-hint').textContent = message;
  $('#login-pw').focus();
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
        body: JSON.stringify({ password: $('#login-pw').value }),
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
      state.search = q;
      state.items = null;
      loadList();
    }, 350);
  });

  window.addEventListener('popstate', (e) => {
    state.stack = Array.isArray(e.state?.stack) && e.state.stack.length ? e.state.stack : [root()];
    resetView();
  });

  $('#file-input').addEventListener('change', (e) => {
    queueUploads(e.target.files);
    e.target.value = '';
  });

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
    if (state.search) return toast('Clear the search first, then drop files into a folder', 'error');
    queueUploads(files);
  });

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
  if (!me.authed) return showLogin();
  enterApp();
}

init();
