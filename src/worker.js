// Revision Hub API on Cloudflare Workers + D1.
// Routes: POST /api/signup, POST /api/login, POST /api/logout, GET /api/me,
//         GET|PUT /api/progress/:subject, POST /api/password, POST /api/delete-account.
// Everything else is served from ./public by the static assets binding.

const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000; // the maximum Workers allows
const SUBJECTS = new Set(['maths', 'science']);
const MAX_PROGRESS_BYTES = 256 * 1024;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

const enc = new TextEncoder();
const toHex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => new Uint8Array(hex.match(/.{2}/g).map(h => parseInt(h, 16)));
const now = () => Math.floor(Date.now() / 1000);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
const err = (status, message) => json({ error: message }, status);

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS }, key, 256);
  return toHex(bits);
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const sha256 = async s => toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randomHex = n => toHex(crypto.getRandomValues(new Uint8Array(n)));

function getCookie(req, name) {
  const c = req.headers.get('cookie') || '';
  for (const part of c.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) return v.join('='); }
  return null;
}
function sessionCookie(token, url, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function startSession(env, userId, url) {
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), userId, now() + SESSION_DAYS * 86400).run();
  // Tidy up: drop this user's expired sessions.
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?').bind(userId, now()).run();
  return sessionCookie(token, url, SESSION_DAYS * 86400);
}
async function currentUser(req, env) {
  const token = getCookie(req, 'sid'); if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare('SELECT u.id, u.username, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(await sha256(token)).first();
  if (!row || row.expires_at < now()) return null;
  return { id: row.id, username: row.username, tokenHash: await sha256(token) };
}
async function readJson(req) {
  if (!(req.headers.get('content-type') || '').includes('application/json')) throw new Error('Expected JSON');
  const text = await req.text(); if (text.length > MAX_PROGRESS_BYTES + 1024) throw new Error('Too large');
  return JSON.parse(text);
}

async function handleApi(req, env, url) {
  const path = url.pathname, method = req.method;
  // Block cross-site writes: browsers always send Origin on POST/PUT.
  if (method !== 'GET') { const origin = req.headers.get('origin'); if (origin && origin !== url.origin) return err(403, 'Cross-site request blocked'); }

  if (path === '/api/signup' && method === 'POST') {
    let body; try { body = await readJson(req); } catch { return err(400, 'Bad request'); }
    const username = String(body.username || '').trim(), password = String(body.password || '');
    if (!USERNAME_RE.test(username)) return err(400, 'Usernames are 3–20 letters, numbers or underscores.');
    if (password.length < 8) return err(400, 'Passwords need at least 8 characters.');
    if (password.length > 200) return err(400, 'That password is too long.');
    const exists = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (exists) return err(409, 'That username is taken. Try another one.');
    const salt = randomHex(16); const hash = await hashPassword(password, salt);
    const res = await env.DB.prepare('INSERT INTO users (username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?)').bind(username, hash, salt, now()).run();
    const cookie = await startSession(env, res.meta.last_row_id, url);
    return json({ username }, 201, { 'set-cookie': cookie });
  }

  if (path === '/api/login' && method === 'POST') {
    let body; try { body = await readJson(req); } catch { return err(400, 'Bad request'); }
    const username = String(body.username || '').trim(), password = String(body.password || '');
    const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    if (!user) { await hashPassword(password, randomHex(16)); return err(401, 'Wrong username or password.'); }
    if (user.locked_until > now()) return err(429, 'Too many wrong tries. Wait a few minutes and try again.');
    const hash = await hashPassword(password, user.salt);
    if (!safeEqual(hash, user.pass_hash)) {
      const fails = user.failed_logins + 1;
      await env.DB.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').bind(fails >= 8 ? 0 : fails, fails >= 8 ? now() + 300 : 0, user.id).run();
      return err(401, 'Wrong username or password.');
    }
    await env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').bind(user.id).run();
    return json({ username: user.username }, 200, { 'set-cookie': await startSession(env, user.id, url) });
  }

  const user = await currentUser(req, env);
  if (path === '/api/me' && method === 'GET') {
    if (!user) return err(401, 'Not logged in');
    const rows = await env.DB.prepare('SELECT subject, updated_at FROM progress WHERE user_id = ?').bind(user.id).all();
    return json({ username: user.username, subjects: Object.fromEntries(rows.results.map(r => [r.subject, r.updated_at])) });
  }
  if (path === '/api/logout' && method === 'POST') {
    if (user) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(user.tokenHash).run();
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', url, 0) });
  }
  if (!user) return err(401, 'Not logged in');

  const m = path.match(/^\/api\/progress\/([a-z]+)$/);
  if (m) {
    const subject = m[1]; if (!SUBJECTS.has(subject)) return err(404, 'Unknown subject');
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT data, updated_at FROM progress WHERE user_id = ? AND subject = ?').bind(user.id, subject).first();
      return json({ data: row ? JSON.parse(row.data) : {}, updated_at: row ? row.updated_at : 0 });
    }
    if (method === 'PUT') {
      let body; try { body = await readJson(req); } catch { return err(400, 'Bad request'); }
      if (!body || typeof body.data !== 'object' || Array.isArray(body.data)) return err(400, 'Bad request');
      const text = JSON.stringify(body.data); if (text.length > MAX_PROGRESS_BYTES) return err(413, 'Progress is too large');
      const t = now();
      await env.DB.prepare('INSERT INTO progress (user_id, subject, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, subject) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').bind(user.id, subject, text, t).run();
      return json({ ok: true, updated_at: t });
    }
  }

  if (path === '/api/password' && method === 'POST') {
    let body; try { body = await readJson(req); } catch { return err(400, 'Bad request'); }
    const row = await env.DB.prepare('SELECT pass_hash, salt FROM users WHERE id = ?').bind(user.id).first();
    if (!safeEqual(await hashPassword(String(body.current || ''), row.salt), row.pass_hash)) return err(401, 'Your current password is wrong.');
    const next = String(body.next || ''); if (next.length < 8 || next.length > 200) return err(400, 'Passwords need at least 8 characters.');
    const salt = randomHex(16);
    await env.DB.prepare('UPDATE users SET pass_hash = ?, salt = ? WHERE id = ?').bind(await hashPassword(next, salt), salt, user.id).run();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, user.tokenHash).run();
    return json({ ok: true });
  }
  if (path === '/api/delete-account' && method === 'POST') {
    let body; try { body = await readJson(req); } catch { return err(400, 'Bad request'); }
    const row = await env.DB.prepare('SELECT pass_hash, salt FROM users WHERE id = ?').bind(user.id).first();
    if (!safeEqual(await hashPassword(String(body.password || ''), row.salt), row.pass_hash)) return err(401, 'That password is wrong.');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM progress WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id)
    ]);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', url, 0) });
  }
  return err(404, 'Not found');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(req, env, url); }
      catch (e) { console.error(e); return err(500, 'Something went wrong on the server. Try again.'); }
    }
    return env.ASSETS.fetch(req);
  }
};
