'use strict';

const el = {
  login: document.getElementById('login'),
  loginForm: document.getElementById('login-form'),
  password: document.getElementById('password'),
  loginBtn: document.getElementById('login-btn'),
  loginError: document.getElementById('login-error'),
  app: document.getElementById('app'),
  title: document.getElementById('title'),
  crumbs: document.getElementById('crumbs'),
  list: document.getElementById('list'),
  empty: document.getElementById('empty'),
  count: document.getElementById('count'),
  free: document.getElementById('free'),
  fileInput: document.getElementById('file-input'),
  transfers: document.getElementById('transfers'),
  drop: document.getElementById('drop'),
  toast: document.getElementById('toast')
};

const state = { path: '', items: [] };

const sizeFmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

const EXT_ICONS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'ico'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'xz', 'bz2'],
  code: ['js', 'mjs', 'ts', 'jsx', 'tsx', 'py', 'rs', 'c', 'h', 'cpp', 'hpp', 'cs', 'java', 'go', 'php', 'rb', 'sh', 'bat', 'ps1', 'json', 'xml', 'yml', 'yaml', 'html', 'css', 'sql'],
  pdf: ['pdf'],
  doc: ['doc', 'docx', 'odt', 'txt', 'md', 'rtf'],
  sheet: ['xls', 'xlsx', 'ods', 'csv'],
  slides: ['ppt', 'pptx', 'odp'],
  exe: ['exe', 'msi', 'apk', 'dmg', 'iso', 'img']
};
const ICON_BY_KIND = {
  image: 'image', video: 'video', audio: 'audio', archive: 'archive', code: 'code',
  pdf: 'pdf', doc: 'file', sheet: 'sheet', slides: 'slides', exe: 'terminal'
};

/* ---------- formatage ---------- */

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' o';
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return sizeFmt.format(value) + ' ' + units[index];
}

function iconFor(item) {
  if (item.dir) return 'folder';
  const dot = item.name.lastIndexOf('.');
  const ext = dot > 0 ? item.name.slice(dot + 1).toLowerCase() : '';
  for (const [kind, list] of Object.entries(EXT_ICONS)) {
    if (list.includes(ext)) return ICON_BY_KIND[kind];
  }
  return 'file';
}

function svgIcon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.appendChild(use);
  return svg;
}

/* ---------- réseau ---------- */

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  if (res.status === 401) {
    showLogin();
    throw new Error('Connexion requise.');
  }
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) throw new Error((data && data.error) || 'Erreur ' + res.status);
  return data;
}

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

/* ---------- affichage ---------- */

function showLogin() {
  el.app.hidden = true;
  el.login.hidden = false;
  el.loginError.textContent = '';
  el.password.focus();
}

function showApp() {
  el.login.hidden = true;
  el.app.hidden = false;
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.toast.hidden = true;
  }, 4500);
}

/* ---------- navigation ---------- */

async function load(pathValue) {
  try {
    const data = await api('/api/list?path=' + encodeURIComponent(pathValue || ''));
    state.path = data.path;
    state.items = data.items;
    renderCrumbs(data.crumbs);
    renderList();
    el.count.textContent = data.items.length + (data.items.length > 1 ? ' éléments' : ' élément');
    el.free.textContent = data.free != null ? 'Libre : ' + formatSize(data.free) : '';
    history.replaceState(null, '', '#' + encodeURI(data.path));
    return true;
  } catch (err) {
    if (!pathValue) toast(err.message);
    return false;
  }
}

function renderCrumbs(crumbs) {
  el.crumbs.replaceChildren();
  crumbs.forEach((crumb, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '/';
      el.crumbs.appendChild(sep);
    }
    const node = document.createElement(index === crumbs.length - 1 ? 'span' : 'button');
    node.className = 'crumb' + (index === crumbs.length - 1 ? ' current' : '');
    node.textContent = crumb.name;
    node.title = crumb.name;
    if (index !== crumbs.length - 1) {
      node.type = 'button';
      node.addEventListener('click', () => load(crumb.path));
    }
    el.crumbs.appendChild(node);
  });
}

function renderList() {
  el.list.replaceChildren();
  el.empty.hidden = state.items.length > 0;
  const fragment = document.createDocumentFragment();
  for (const item of state.items) fragment.appendChild(renderRow(item));
  el.list.appendChild(fragment);
}

function renderRow(item) {
  const row = document.createElement('div');
  row.className = 'row' + (item.dir ? ' is-dir' : '');

  const main = item.dir ? document.createElement('button') : document.createElement('a');
  main.className = 'entry';
  main.title = item.name;
  if (item.dir) {
    main.type = 'button';
    main.addEventListener('click', () => load(item.path));
  } else {
    main.href = '/api/download?path=' + encodeURIComponent(item.path);
    main.setAttribute('download', item.name);
  }

  const icon = svgIcon(iconFor(item), 'entry-icon');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.name;
  main.append(icon, name);

  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = item.dir ? '—' : formatSize(item.size);

  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = dateFmt.format(new Date(item.mtime));

  const actions = document.createElement('span');
  actions.className = 'row-actions';
  actions.append(
    iconButton('pencil', 'Renommer', 'rename', () => renameItem(item)),
    iconButton('trash', 'Supprimer', 'danger', () => deleteItem(item))
  );

  row.append(main, size, date, actions);
  return row;
}

function iconButton(iconName, label, variant, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-btn' + (variant === 'danger' ? ' danger' : '');
  button.setAttribute('aria-label', label);
  button.title = label;
  button.appendChild(svgIcon(iconName, 'action-icon'));
  button.addEventListener('click', onClick);
  return button;
}

/* ---------- actions ---------- */

async function renameItem(item) {
  const name = prompt('Nouveau nom :', item.name);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed || trimmed === item.name) return;
  try {
    await api('/api/rename', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ path: item.path, name: trimmed })
    });
    await load(state.path);
  } catch (err) {
    toast(err.message);
  }
}

async function deleteItem(item) {
  const question = 'Supprimer « ' + item.name + ' » ?' + (item.dir ? ' (dossier et tout son contenu)' : '');
  if (!confirm(question)) return;
  try {
    await api('/api/delete', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ path: item.path })
    });
    await load(state.path);
  } catch (err) {
    toast(err.message);
  }
}

async function createFolder() {
  const name = prompt('Nom du nouveau dossier :');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    await api('/api/mkdir', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ path: state.path, name: trimmed })
    });
    await load(state.path);
  } catch (err) {
    toast(err.message);
  }
}

/* ---------- upload ---------- */

function uploadFiles(fileList) {
  const files = Array.from(fileList).filter((file) => file.name && !file.name.startsWith('.'));
  if (!files.length) return;
  const directory = state.path;
  el.transfers.hidden = false;

  (async () => {
    for (const file of files) {
      const row = addTransfer(file.name);
      try {
        await putFile(file, directory, row);
        row.classList.add('done');
        setProgress(row, 1);
      } catch (err) {
        row.classList.add('error');
        if (err.message !== 'Ignoré') toast(file.name + ' : ' + err.message);
      }
      const delay = row.classList.contains('error') ? 6000 : 2500;
      setTimeout(() => {
        row.remove();
        if (!el.transfers.children.length) el.transfers.hidden = true;
      }, delay);
    }
    await load(directory);
  })();
}

function putFile(file, directory, row) {
  const send = (overwrite) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url =
        '/api/upload?path=' + encodeURIComponent(directory) +
        '&name=' + encodeURIComponent(file.name) +
        (overwrite ? '&overwrite=1' : '');
      xhr.open('PUT', url);
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) setProgress(row, event.loaded / event.total);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status === 409) return resolve({ conflict: true });
        if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
        let message = 'Erreur ' + xhr.status;
        try {
          message = JSON.parse(xhr.responseText).error || message;
        } catch {}
        reject(new Error(message));
      });
      xhr.addEventListener('error', () => reject(new Error('connexion perdue')));
      xhr.addEventListener('abort', () => reject(new Error('annulé')));
      xhr.send(file);
    });

  return (async () => {
    let result = await send(false);
    if (result.conflict) {
      if (!confirm('« ' + file.name + ' » existe déjà. Le remplacer ?')) throw new Error('Ignoré');
      result = await send(true);
    }
  })();
}

function addTransfer(name) {
  const row = document.createElement('div');
  row.className = 'transfer';

  const head = document.createElement('div');
  head.className = 'transfer-head';
  const label = document.createElement('span');
  label.className = 'transfer-name';
  label.textContent = name;
  label.title = name;
  const percent = document.createElement('span');
  percent.className = 'transfer-pct';
  percent.textContent = '0 %';
  head.append(label, percent);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);

  row.append(head, bar);
  row.fill = fill;
  row.percent = percent;
  el.transfers.appendChild(row);
  return row;
}

function setProgress(row, ratio) {
  const value = Math.max(0, Math.min(1, ratio));
  row.fill.style.width = (value * 100).toFixed(1) + '%';
  row.percent.textContent = Math.round(value * 100) + ' %';
}

/* ---------- glisser-déposer ---------- */

function hasFiles(event) {
  return Boolean(event.dataTransfer) && Array.from(event.dataTransfer.types || []).includes('Files');
}

let dragDepth = 0;

document.addEventListener('dragenter', (event) => {
  if (el.app.hidden || !hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  el.drop.classList.add('visible');
});

document.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
});

document.addEventListener('dragleave', (event) => {
  if (el.app.hidden || !hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.drop.classList.remove('visible');
});

document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  el.drop.classList.remove('visible');
  if (el.app.hidden) return;
  if (event.dataTransfer.files.length) uploadFiles(event.dataTransfer.files);
});

/* ---------- écouteurs ---------- */

el.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.loginError.textContent = '';
  el.loginBtn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ password: el.password.value })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      el.loginError.textContent = data.error || 'Connexion impossible.';
      return;
    }
    el.password.value = '';
    showApp();
    const deep = decodeURI(location.hash.slice(1));
    if (!(await load(deep))) await load('');
  } catch {
    el.loginError.textContent = 'Serveur injoignable.';
  } finally {
    el.loginBtn.disabled = false;
  }
});

document.getElementById('logout').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {}
  state.items = [];
  el.list.replaceChildren();
  history.replaceState(null, '', location.pathname);
  showLogin();
});

document.getElementById('new-folder').addEventListener('click', createFolder);
document.getElementById('upload-btn').addEventListener('click', () => el.fileInput.click());
el.fileInput.addEventListener('change', () => {
  uploadFiles(el.fileInput.files);
  el.fileInput.value = '';
});

/* ---------- thème clair / sombre ---------- */

const THEME_KEY = 'drive-theme';

function setTheme(theme, persist) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }
  const label = theme === 'dark' ? 'Passer en clair' : 'Passer en sombre';
  for (const button of document.querySelectorAll('.theme-toggle')) {
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {}
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(saved === 'dark' || saved === 'light' ? saved : prefersDark ? 'dark' : 'light', false);
}

for (const button of document.querySelectorAll('.theme-toggle')) {
  button.addEventListener('click', () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true);
  });
}

initTheme();

/* ---------- démarrage ---------- */

(async function boot() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    el.title.textContent = data.title || 'Mon Drive';
    document.title = data.title || 'Mon Drive';
    if (data.auth) {
      showApp();
      const deep = decodeURI(location.hash.slice(1));
      if (!(await load(deep))) await load('');
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
