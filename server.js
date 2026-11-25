'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const BASE = __dirname;
const PUBLIC_DIR = path.join(BASE, 'public');
const SESSION_COOKIE = 'drive_session';
const SESSION_TTL = 7 * 24 * 60 * 60;
const MAX_JSON = 64 * 1024;

const HIDDEN_NAMES = new Set(['$recycle.bin', 'system volume information', 'recycler', 'lost+found']);
const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => new HttpError(status, message);

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(path.join(BASE, 'config.json'), 'utf8');
  } catch {
    console.error('config.json introuvable dans ' + BASE);
    process.exit(1);
  }
  let userConfig;
  try {
    userConfig = JSON.parse(raw);
  } catch (err) {
    console.error('config.json invalide : ' + err.message);
    process.exit(1);
  }
  const config = {
    title: 'Mon Drive',
    root: './shared',
    host: '127.0.0.1',
    port: 3000,
    password: ''
  };
  Object.assign(config, userConfig);
  if (typeof config.password !== 'string' || config.password.length < 4) {
    console.error('config.json : renseigne un "password" de 4 caracteres minimum.');
    process.exit(1);
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    console.error('config.json : "port" invalide.');
    process.exit(1);
  }
  return config;
}

const config = loadConfig();
const ROOT = path.resolve(BASE, config.root);
fs.mkdirSync(ROOT, { recursive: true });
const REAL_ROOT = fs.realpathSync(ROOT);

/* ---------- utilitaires HTTP ---------- */

function json(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------- sessions ---------- */

function sessionValue() {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const sig = crypto.createHmac('sha256', config.password + ':session').update(String(exp)).digest('base64url');
  return exp + '.' + sig;
}

function validSession(cookies) {
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return false;
  const dot = raw.indexOf('.');
  if (dot < 1) return false;
  const expStr = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac('sha256', config.password + ':session').update(expStr).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieHeader(value, maxAge) {
  return SESSION_COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge;
}

/* ---------- anti force brute ---------- */

const attempts = new Map();

function loginLocked(ip) {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (entry.until > Date.now()) return true;
  if (Date.now() - entry.last > 10 * 60 * 1000) attempts.delete(ip);
  return false;
}

function loginFailed(ip) {
  const entry = attempts.get(ip) || { count: 0, last: 0, until: 0 };
  entry.count += 1;
  entry.last = Date.now();
  if (entry.count >= 8) {
    entry.until = Date.now() + 5 * 60 * 1000;
    entry.count = 0;
  }
  attempts.set(ip, entry);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of attempts) {
    if (entry.until < now && now - entry.last > 10 * 60 * 1000) attempts.delete(ip);
  }
}, 5 * 60 * 1000).unref();

/* ---------- chemins ---------- */

function resolveSafe(rel) {
  const raw = String(rel == null ? '' : rel).replace(/\\/g, '/');
  const clean = path.posix.normalize('/' + raw).replace(/^\/+/, '');
  const abs = path.resolve(ROOT, clean);
  const relative = path.relative(ROOT, abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw fail(403, 'Chemin interdit.');
  return { abs, rel: clean };
}

async function assertReal(abs) {
  let real;
  try {
    real = await fsp.realpath(abs);
  } catch {
    return;
  }
  const relative = path.relative(REAL_ROOT, real);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw fail(403, 'Chemin interdit.');
}

function isHidden(name) {
  return name.startsWith('.') || HIDDEN_NAMES.has(name.toLowerCase());
}

function validateName(input) {
  if (typeof input !== 'string') throw fail(400, 'Nom manquant.');
  const name = input.trim();
  if (!name || name === '.' || name === '..') throw fail(400, 'Nom invalide.');
  if (name.length > 180) throw fail(400, 'Nom trop long.');
  if (/[\\/:*?"<>|]/.test(name) || [...name].some((c) => c.charCodeAt(0) < 32)) {
    throw fail(400, 'Caracteres interdits dans le nom.');
  }
  if (name.startsWith('.')) throw fail(400, 'Le nom ne peut pas commencer par un point.');
  return name;
}

function joinRel(dir, name) {
  return dir ? dir + '/' + name : name;
}

function asciiName(name) {
  const cleaned = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return cleaned || 'fichier';
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON) {
        reject(fail(413, 'Requete trop grosse.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(fail(400, 'JSON invalide.'));
      }
    });
    req.on('error', reject);
  });
}

/* ---------- fichiers statiques ---------- */

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8']
};

async function serveStatic(req, res, name, type) {
  const body = await fsp.readFile(path.join(PUBLIC_DIR, name));
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-cache'
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(body);
}

/* ---------- API ---------- */

async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress || '?';
  if (loginLocked(ip)) throw fail(429, 'Trop de tentatives. Reessaie dans 5 minutes.');
  const body = await readJson(req);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!safeEqual(password, config.password)) {
    loginFailed(ip);
    await new Promise((resolve) => setTimeout(resolve, 350));
    throw fail(401, 'Mot de passe incorrect.');
  }
  attempts.delete(ip);
  json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(sessionValue(), SESSION_TTL) });
}

function handleLogout(res) {
  json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
}

async function handleList(res, url) {
  const { abs, rel } = resolveSafe(url.searchParams.get('path') || '');
  await assertReal(abs);
  const stat = await fsp.stat(abs).catch(() => {
    throw fail(404, 'Dossier introuvable.');
  });
  if (!stat.isDirectory()) throw fail(400, 'Ce n\u2019est pas un dossier.');

  const dirents = await fsp.readdir(abs, { withFileTypes: true });
  const items = [];
  await Promise.all(
    dirents.map(async (dirent) => {
      if (isHidden(dirent.name)) return;
      const full = path.join(abs, dirent.name);
      let info;
      try {
        info = await fsp.stat(full);
      } catch {
        return;
      }
      items.push({
        name: dirent.name,
        dir: info.isDirectory(),
        size: info.size,
        mtime: info.mtimeMs,
        path: joinRel(rel, dirent.name)
      });
    })
  );
  items.sort((a, b) => (a.dir === b.dir ? collator.compare(a.name, b.name) : a.dir ? -1 : 1));

  const parts = rel ? rel.split('/') : [];
  const crumbs = [{ name: path.basename(ROOT) || ROOT, path: '' }];
  parts.forEach((part, index) => {
    crumbs.push({ name: part, path: parts.slice(0, index + 1).join('/') });
  });

  let free = null;
  try {
    if (typeof fsp.statfs === 'function') {
      const info = await fsp.statfs(abs);
      free = Number(info.bavail) * Number(info.bsize);
    }
  } catch {
    free = null;
  }

  json(res, 200, { path: rel, items, crumbs, free });
}

async function handleDownload(req, res, url) {
  const { abs } = resolveSafe(url.searchParams.get('path') || '');
  await assertReal(abs);
  const stat = await fsp.stat(abs).catch(() => {
    throw fail(404, 'Fichier introuvable.');
  });
  if (!stat.isFile()) throw fail(400, 'Ce n\u2019est pas un fichier.');

  const name = path.basename(abs);
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition':
      'attachment; filename="' + asciiName(name) + '"; filename*=UTF-8\'\'' + encodeURIComponent(name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    ETag: '"' + stat.size.toString(16) + '-' + Math.floor(stat.mtimeMs).toString(16) + '"',
    'Last-Modified': stat.mtime.toUTCString()
  };

  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range && stat.size > 0) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match && (match[1] || match[2])) {
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      } else {
        start = Math.max(0, stat.size - Number(match[2]));
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
        res.end();
        return;
      }
      status = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + stat.size;
    }
  }

  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || stat.size === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function handleUpload(req, res, url) {
  const { abs: dirAbs, rel } = resolveSafe(url.searchParams.get('path') || '');
  await assertReal(dirAbs);
  const dirStat = await fsp.stat(dirAbs).catch(() => {
    throw fail(404, 'Dossier introuvable.');
  });
  if (!dirStat.isDirectory()) throw fail(400, 'Ce n\u2019est pas un dossier.');

  const name = validateName(url.searchParams.get('name'));
  const target = path.join(dirAbs, name);
  const exists = await fsp.stat(target).then(() => true).catch(() => false);
  if (exists && url.searchParams.get('overwrite') !== '1') {
    throw fail(409, 'Ce fichier existe deja.');
  }

  const tmp = path.join(dirAbs, '.' + crypto.randomBytes(6).toString('hex') + '.part');
  try {
    await pipeline(req, fs.createWriteStream(tmp, { flags: 'wx' }));
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (err instanceof HttpError) throw err;
    throw fail(400, 'Import interrompu.');
  }

  const info = await fsp.stat(target);
  json(res, 200, { name, size: info.size, path: joinRel(rel, name) });
}

async function handleMkdir(req, res) {
  const body = await readJson(req);
  const { abs, rel } = resolveSafe(body.path || '');
  await assertReal(abs);
  const name = validateName(body.name);
  try {
    await fsp.mkdir(path.join(abs, name));
  } catch (err) {
    if (err.code === 'EEXIST') throw fail(409, 'Un fichier ou dossier porte deja ce nom.');
    if (err.code === 'ENOENT') throw fail(404, 'Dossier parent introuvable.');
    throw fail(400, 'Creation impossible (' + err.code + ').');
  }
  json(res, 201, { name, path: joinRel(rel, name) });
}

async function handleRename(req, res) {
  const body = await readJson(req);
  const { abs, rel } = resolveSafe(body.path || '');
  if (abs === ROOT) throw fail(403, 'Impossible de renommer la racine.');
  await assertReal(abs);
  const exists = await fsp.stat(abs).then(() => true).catch(() => false);
  if (!exists) throw fail(404, 'Element introuvable.');

  const name = validateName(body.name);
  const target = path.join(path.dirname(abs), name);
  if (target === abs) return json(res, 200, { name, path: rel });

  const taken = await fsp.stat(target).then(() => true).catch(() => false);
  if (taken) throw fail(409, 'Un fichier ou dossier porte deja ce nom.');
  try {
    await fsp.rename(abs, target);
  } catch (err) {
    throw fail(400, 'Renommage impossible (' + err.code + ').');
  }
  const parent = path.posix.dirname(rel);
  json(res, 200, { name, path: parent === '.' ? name : parent + '/' + name });
}

async function handleDelete(req, res) {
  const body = await readJson(req);
  const { abs } = resolveSafe(body.path || '');
  if (abs === ROOT) throw fail(403, 'Impossible de supprimer la racine.');
  await assertReal(abs);
  const exists = await fsp.stat(abs).then(() => true).catch(() => false);
  if (!exists) throw fail(404, 'Element introuvable.');
  try {
    await fsp.rm(abs, { recursive: true, force: false });
  } catch (err) {
    throw fail(400, 'Suppression impossible (' + err.code + ').');
  }
  json(res, 200, { ok: true });
}

/* ---------- routage ---------- */

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method;

  if (STATIC_FILES[pathname] && (method === 'GET' || method === 'HEAD')) {
    const [name, type] = STATIC_FILES[pathname];
    return serveStatic(req, res, name, type);
  }

  if (pathname === '/api/login' && method === 'POST') return handleLogin(req, res);
  if (pathname === '/api/logout' && method === 'POST') return handleLogout(res);
  if (pathname === '/api/session' && method === 'GET') {
    return json(res, 200, {
      auth: validSession(parseCookies(req.headers.cookie)),
      title: config.title
    });
  }

  if (pathname.startsWith('/api/')) {
    if (!validSession(parseCookies(req.headers.cookie))) throw fail(401, 'Connexion requise.');
    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) throw fail(403, 'Origine refusee.');

    if (pathname === '/api/list' && method === 'GET') return handleList(res, url);
    if (pathname === '/api/download' && (method === 'GET' || method === 'HEAD')) {
      return handleDownload(req, res, url);
    }
    if (pathname === '/api/upload' && method === 'PUT') return handleUpload(req, res, url);
    if (pathname === '/api/mkdir' && method === 'POST') return handleMkdir(req, res);
    if (pathname === '/api/rename' && method === 'POST') return handleRename(req, res);
    if (pathname === '/api/delete' && method === 'POST') return handleDelete(req, res);
  }

  throw fail(404, 'Introuvable.');
}

const server = http.createServer((req, res) => {
  securityHeaders(res);
  route(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    json(res, status, { error: status >= 500 ? 'Erreur interne du serveur.' : err.message });
  });
});

server.on('error', (err) => {
  console.error('Serveur : ' + err.message);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const wildcard = config.host === '0.0.0.0' || config.host === '::';
  console.log('');
  console.log('  ' + config.title);
  console.log('  Dossier partage : ' + ROOT);
  console.log('  Local           : http://' + (wildcard ? '127.0.0.1' : config.host) + ':' + config.port);
  if (wildcard) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log('  Reseau          : http://' + net.address + ':' + config.port);
        }
      }
    }
  }
  console.log('  Arret           : Ctrl+C');
  console.log('');
});

function shutdown() {
  console.log('\nArret du serveur...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
