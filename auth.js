const crypto = require('node:crypto');
const db = require('./db');

const sessionDays = 7;
const cookieName = 'sid';

// scrypt is slow on purpose, so cracking a leaked db takes forever
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
  const expires = Date.now() + sessionDays * 864e5;
  db.prepare('insert into sessions (token, user_id, expires_at) values (?, ?, ?)').run(token, userId, expires);
  res.cookie(cookieName, token, { httpOnly: true, sameSite: 'lax', maxAge: sessionDays * 864e5 });
}

function readCookie(req, name) {
  const pair = (req.headers.cookie || '').split('; ').find(c => c.startsWith(name + '='));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

// puts the logged in user on req.user (if the cookie is valid)
function loadUser(req, _res, next) {
  const token = readCookie(req, cookieName);
  req.user = token
    ? db.prepare(`select u.id, u.username from sessions s join users u on u.id = s.user_id
                  where s.token = ? and s.expires_at > ?`).get(token, Date.now())
    : undefined;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in' });
  next();
}

function destroySession(req, res) {
  const token = readCookie(req, cookieName);
  if (token) db.prepare('delete from sessions where token = ?').run(token);
  res.clearCookie(cookieName);
}

module.exports = { hashPassword, verifyPassword, createSession, loadUser, requireAuth, destroySession };
