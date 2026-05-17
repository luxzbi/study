'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 4004);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'db.json');

loadEnv(path.join(ROOT, '.env'));

const ADMIN_ID = process.env.ADMIN_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TOKEN_SECRET = process.env.TOKEN_SECRET;
const USE_FIREBASE = process.env.USE_FIREBASE === 'true';
const MAX_BODY = 60 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
const PHOTO_COLLECTION = 'photos';

if (!USE_FIREBASE) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

let firebase = null;

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    return { photos: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return { photos: Array.isArray(parsed.photos) ? parsed.photos : [] };
  } catch {
    return { photos: [] };
  }
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function initFirebase() {
  let admin;
  try {
    admin = require('firebase-admin');
  } catch {
    console.error('Firebase 모드는 firebase-admin 설치가 필요합니다. npm install을 실행해 주세요.');
    process.exit(1);
  }

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require('./firebase-key.json');

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  return {
    admin,
    db: admin.firestore()
  };
}

function requireAuthConfig() {
  if (!ADMIN_ID || !ADMIN_PASSWORD || !TOKEN_SECRET) {
    throw new Error('ADMIN_ID, ADMIN_PASSWORD, TOKEN_SECRET 환경변수가 필요합니다.');
  }
}

function getFirebase() {
  if (!USE_FIREBASE) return null;
  if (!firebase) firebase = initFirebase();
  return firebase;
}

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('업로드 용량은 60MB까지 가능합니다.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD;

function signToken(role = 'admin') {
  requireAuthConfig();
  const payload = Buffer.from(JSON.stringify({ id: ADMIN_ID, role, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(req) {
  if (!ADMIN_ID || !TOKEN_SECRET) return false;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    // viewer tokens are valid for reading but not for writes — verifyToken checks write permission
    return data.id === ADMIN_ID && data.role === 'admin' && data.exp > Date.now();
  } catch {
    return false;
  }
}

function verifyAnyToken(req) {
  if (!TOKEN_SECRET) return false;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now();
  } catch { return false; }
}

function extractScheduleNames(memo) {
  const names = [];
  const re = /<d>[ \t]*(?:'([^'\n]+)'|([^\/\n]+?))[ \t]*\//g;
  let m;
  while ((m = re.exec(memo)) !== null) {
    const name = (m[1] || m[2] || '').trim();
    if (name) names.push(name);
  }
  return [...new Set(names)];
}

function safeDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '';
}

function cleanName(name) {
  const ext = path.extname(name || '').toLowerCase();
  const allowedExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif'].includes(ext) ? ext : '.jpg';
  return `${Date.now()}-${crypto.randomUUID()}${allowedExt}`;
}

function headerValue(header, key) {
  const match = new RegExp(`${key}="([^"]+)"`).exec(header);
  return match ? match[1] : '';
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!boundaryMatch) throw new Error('multipart boundary가 없습니다.');

  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const raw = buffer.toString('latin1');
  const parts = raw.split(boundary).slice(1, -1).map((part) => {
    const clean = part.startsWith('\r\n') ? part.slice(2) : part;
    const headerEnd = clean.indexOf('\r\n\r\n');
    if (headerEnd === -1) return null;
    let data = clean.slice(headerEnd + 4);
    if (data.endsWith('\r\n')) data = data.slice(0, -2);
    return {
      headers: clean.slice(0, headerEnd),
      data: Buffer.from(data, 'latin1')
    };
  }).filter(Boolean);

  const fields = {};
  const files = [];

  for (const part of parts) {
    const disposition = part.headers.split('\r\n').find((line) => line.toLowerCase().startsWith('content-disposition')) || '';
    const typeLine = part.headers.split('\r\n').find((line) => line.toLowerCase().startsWith('content-type')) || '';
    const name = headerValue(disposition, 'name');
    const filename = headerValue(disposition, 'filename');
    const mime = typeLine.split(':').slice(1).join(':').trim().toLowerCase();

    if (filename) files.push({ field: name, filename, mime, data: part.data });
    else if (name) fields[name] = part.data.toString('utf8');
  }

  return { fields, files };
}

async function listDays() {
  if (USE_FIREBASE) {
    const fb = getFirebase();
    const snap = await fb.db.collection(PHOTO_COLLECTION).get();
    return groupDays(snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
  }

  const db = readDb();
  return groupDays(db.photos);
}

function groupDays(photos) {
  const grouped = new Map();
  for (const photo of photos) {
    if (!grouped.has(photo.date)) grouped.set(photo.date, []);
    grouped.get(photo.date).push(photo);
  }

  return [...grouped.entries()]
    .map(([date, photos]) => ({
      date,
      count: photos.length,
      cover: photos.sort((a, b) => b.createdAt - a.createdAt)[0]?.url || '',
      updatedAt: Math.max(...photos.map((photo) => photo.createdAt))
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt - a.updatedAt);
}

async function listPhotos(date) {
  if (USE_FIREBASE) {
    const fb = getFirebase();
    const snap = await fb.db.collection(PHOTO_COLLECTION).where('date', '==', date).get();
    return snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  return readDb().photos
    .filter((photo) => photo.date === date)
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function savePhotos(date, files) {
  if (USE_FIREBASE) return savePhotosToFirebase(date, files);

  const saved = [];
  for (const file of files) {
    if (!IMAGE_TYPES.has(file.mime)) throw new Error('이미지 파일만 업로드할 수 있습니다.');
    const filename = cleanName(file.filename);
    const relative = `/uploads/${filename}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.data);
    saved.push({
      id: crypto.randomUUID(),
      date,
      originalName: file.filename,
      filename,
      url: relative,
      mime: file.mime,
      size: file.data.length,
      createdAt: Date.now()
    });
  }

  const db = readDb();
  db.photos.push(...saved);
  writeDb(db);
  return listPhotos(date);
}

async function savePhotosToFirebase(date, files) {
  const { put } = require('@vercel/blob');
  const saved = [];
  const fb = getFirebase();

  for (const file of files) {
    if (!IMAGE_TYPES.has(file.mime)) throw new Error('이미지 파일만 업로드할 수 있습니다.');
    const filename = cleanName(file.filename);
    const blob = await put(`uploads/${date}/${filename}`, file.data, {
      access: 'public',
      contentType: file.mime
    });

    const doc = {
      date,
      originalName: file.filename,
      filename,
      blobUrl: blob.url,
      url: blob.url,
      mime: file.mime,
      size: file.data.length,
      createdAt: Date.now()
    };
    const ref = await fb.db.collection(PHOTO_COLLECTION).add(doc);
    saved.push({ id: ref.id, ...doc });
  }

  return listPhotos(date);
}

async function deletePhoto(id) {
  if (USE_FIREBASE) {
    const fb = getFirebase();
    const ref = fb.db.collection(PHOTO_COLLECTION).doc(id);
    const doc = await ref.get();
    if (!doc.exists) return false;
    const photo = doc.data();
    await ref.delete();
    if (photo.blobUrl) {
      const { del } = require('@vercel/blob');
      await del(photo.blobUrl).catch(() => {});
    }
    return true;
  }

  const db = readDb();
  const target = db.photos.find((photo) => photo.id === id);
  if (!target) return false;
  db.photos = db.photos.filter((photo) => photo.id !== target.id);
  writeDb(db);
  fs.rm(path.join(UPLOAD_DIR, target.filename), { force: true }, () => {});
  return true;
}

function serveStatic(req, res, pathname) {
  const filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, decodeURIComponent(pathname));
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC_DIR)) return text(res, 403, 'Forbidden');

  fs.stat(normalized, (err, stat) => {
    if (err || !stat.isFile()) return text(res, 404, 'Not found');
    const ext = path.extname(normalized).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.avif': 'image/avif'
    };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    fs.createReadStream(normalized).pipe(res);
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'POST' && pathname === '/api/login') {
      requireAuthConfig();
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if ((body.username || ADMIN_ID) === ADMIN_ID && body.password === ADMIN_PASSWORD) {
        return json(res, 200, { token: signToken('admin'), role: 'admin' });
      }
      if (VIEWER_PASSWORD && body.password === VIEWER_PASSWORD) {
        return json(res, 200, { token: signToken('viewer'), role: 'viewer' });
      }
      return json(res, 401, { error: '비밀번호가 맞지 않습니다.' });
    }

    if (req.method === 'GET' && pathname === '/api/days') {
      return json(res, 200, { days: await listDays() });
    }

    const memoMatch = /^\/api\/days\/(\d{4}-\d{2}-\d{2})\/memo$/.exec(pathname);
    if (req.method === 'GET' && memoMatch) {
      const fb = getFirebase();
      const doc = await fb.db.collection('memos').doc(memoMatch[1]).get();
      return json(res, 200, { memo: doc.exists ? (doc.data().memo || '') : '' });
    }
    if (req.method === 'POST' && memoMatch) {
      if (!verifyToken(req)) return json(res, 401, { error: '로그인이 필요합니다.' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const memo = typeof body.memo === 'string' ? body.memo.slice(0, 2000) : '';
      const fb = getFirebase();
      await fb.db.collection('memos').doc(memoMatch[1]).set({ memo, updatedAt: Date.now() });
      // Sync schedule names extracted from memo
      const names = extractScheduleNames(memo);
      const schedRef = fb.db.collection('schedules').doc(memoMatch[1]);
      const schedSnap = await schedRef.get();
      const existingStates = schedSnap.exists ? (schedSnap.data().states || {}) : {};
      const filteredStates = {};
      for (const name of names) {
        if (name in existingStates) filteredStates[name] = existingStates[name];
      }
      if (names.length > 0) {
        await schedRef.set({ names, states: filteredStates, updatedAt: Date.now() });
      } else if (schedSnap.exists) {
        await schedRef.delete();
      }
      return json(res, 200, { memo });
    }

    const schedMatch = /^\/api\/days\/(\d{4}-\d{2}-\d{2})\/schedules$/.exec(pathname);
    if (req.method === 'GET' && schedMatch) {
      const fb = getFirebase();
      const [memoDoc, schedDoc] = await Promise.all([
        fb.db.collection('memos').doc(schedMatch[1]).get(),
        fb.db.collection('schedules').doc(schedMatch[1]).get()
      ]);
      const names = extractScheduleNames(memoDoc.exists ? (memoDoc.data().memo || '') : '');
      const states = schedDoc.exists ? (schedDoc.data().states || {}) : {};
      return json(res, 200, { names, states });
    }
    if (req.method === 'POST' && schedMatch) {
      if (!verifyToken(req)) return json(res, 401, { error: '로그인이 필요합니다.' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const name = typeof body.name === 'string' ? body.name.slice(0, 200) : '';
      const schedState = Number(body.state);
      if (!name || ![0, 1, 2].includes(schedState)) return json(res, 400, { error: '잘못된 요청' });
      const fb = getFirebase();
      const ref = fb.db.collection('schedules').doc(schedMatch[1]);
      const snap = await ref.get();
      const existing = snap.exists ? snap.data() : { names: [], states: {} };
      const states = { ...(existing.states || {}), [name]: schedState };
      await ref.set({ ...existing, states }, { merge: true });
      return json(res, 200, { state: schedState });
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      const month = url.searchParams.get('month');
      if (!month || !/^\d{4}-\d{2}$/.test(month)) return json(res, 400, { error: '잘못된 월' });
      const fb = getFirebase();
      const prefix = month + '-';
      // Read memos (name source) and schedules (state source) in parallel
      const [memosSnap, schedsSnap] = await Promise.all([
        fb.db.collection('memos').get(),
        fb.db.collection('schedules').get()
      ]);
      const statesMap = {};
      schedsSnap.forEach((doc) => { if (doc.id.startsWith(prefix)) statesMap[doc.id] = doc.data().states || {}; });
      const events = {};
      memosSnap.forEach((doc) => {
        if (!doc.id.startsWith(prefix)) return;
        const names = extractScheduleNames(doc.data().memo || '');
        if (names.length > 0) {
          const states = statesMap[doc.id] || {};
          events[doc.id] = names.map((n) => ({ name: n, state: states[n] ?? 0 }));
        }
      });
      return json(res, 200, { events });
    }

    const photoMatch = /^\/api\/days\/(\d{4}-\d{2}-\d{2})\/photos$/.exec(pathname);
    if (req.method === 'GET' && photoMatch) {
      return json(res, 200, { photos: await listPhotos(photoMatch[1]) });
    }

    if (req.method === 'POST' && pathname === '/api/photos') {
      if (!verifyToken(req)) return json(res, 401, { error: '로그인이 필요합니다.' });
      const parsed = parseMultipart(await readBody(req), req.headers['content-type']);
      const date = safeDate(parsed.fields.date);
      if (!date) return json(res, 400, { error: '날짜를 선택해 주세요.' });

      const files = parsed.files.filter((item) => item.field === 'photos');
      if (files.length === 0) return json(res, 400, { error: '업로드할 사진을 선택해 주세요.' });
      return json(res, 201, { photos: await savePhotos(date, files) });
    }

    const deleteMatch = /^\/api\/photos\/([0-9a-f-]{36})$/.exec(pathname);
    const firebaseDeleteMatch = /^\/api\/photos\/([^/]+)$/.exec(pathname);
    if (req.method === 'DELETE' && (deleteMatch || firebaseDeleteMatch)) {
      if (!verifyToken(req)) return json(res, 401, { error: '로그인이 필요합니다.' });
      const ok = await deletePhoto((deleteMatch || firebaseDeleteMatch)[1]);
      if (!ok) return json(res, 404, { error: '사진을 찾을 수 없습니다.' });
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/img') {
      const blobUrl = url.searchParams.get('u');
      if (!blobUrl) return text(res, 400, 'Missing url');
      const imgRes = await fetch(blobUrl, {
        headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }
      });
      if (!imgRes.ok) return text(res, 404, 'Not found');
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      res.writeHead(200, {
        'content-type': imgRes.headers.get('content-type') || 'image/jpeg',
        'cache-control': 'public, max-age=31536000',
        'content-length': buffer.length
      });
      res.end(buffer);
      return;
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    return text(res, 405, 'Method not allowed');
  } catch (error) {
    return json(res, 500, { error: error.message || '서버 오류가 발생했습니다.' });
  }
}

if (require.main === module) {
  http.createServer(route).listen(PORT, () => {
    console.log(`Math board archive running at http://localhost:${PORT}`);
  });
}

module.exports = route;
