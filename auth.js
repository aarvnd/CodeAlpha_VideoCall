const crypto = require('node:crypto');
const db = require('./db');

const SESSION_DAYS = 7;
const COOKIE = 'sid';

// scrypt is a slow, memory-hard hash: brute-forcing a leaked DB is expensive
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_DAYS * 864e5 });
}

function readCookie(req, name) {
  const pair = (req.headers.cookie || '').split('; ').find(c => c.startsWith(name + '='));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

// Sets req.user if the cookie maps to a live session
function loadUser(req, _res, next) {
  const token = readCookie(req, COOKIE);
  req.user = token
    ? db.prepare(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
                  WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now())
    : undefined;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  next();
}

function destroySession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.clearCookie(COOKIE);
}

module.exports = { hashPassword, verifyPassword, createSession, loadUser, requireAuth, destroySession };
