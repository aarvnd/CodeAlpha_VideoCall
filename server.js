const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { Server } = require('socket.io');
const db = require('./db');
const { hashPassword, verifyPassword, createSession, loadUser, requireAuth, destroySession } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 }); // signaling messages are small

app.use(express.json({ limit: '10kb' }));
app.use(loadUser);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const ROOM_RE = /^[a-z0-9-]{4,40}$/;
const MAX_PEERS = 6; // mesh: every user sends video to every other user, so keep rooms small
const MAX_STROKES = 20000;
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------- Auth (REST) ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!USERNAME_RE.test(username || '')) return bad(res, 'Username must be 3-20 letters, numbers or _');
  if (typeof password !== 'string' || password.length < 6 || password.length > 100)
    return bad(res, 'Password must be 6-100 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return bad(res, 'Username is taken', 409);
  const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, hashPassword(password));
  createSession(res, lastInsertRowid);
  res.status(201).json({ id: Number(lastInsertRowid), username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = typeof username === 'string' && db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash))
    return bad(res, 'Wrong username or password', 401);
  createSession(res, user.id);
  res.json({ id: user.id, username: user.username });
});

app.post('/api/logout', (req, res) => { destroySession(req, res); res.json({ ok: true }); });
app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

// ---------- Real-time (socket.io) ----------
// rooms: roomId -> { peers: Map(socketId -> username), strokes: [] }
const rooms = new Map();

// Same session cookie as the REST API: no valid login, no socket
io.use((socket, next) => {
  loadUser(socket.request, null, () => {});
  if (!socket.request.user) return next(new Error('unauthorized'));
  socket.user = socket.request.user;
  next();
});

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const validStroke = s => s && [s.x0, s.y0, s.x1, s.y1].every(v => isNum(v) && v >= 0 && v <= 1)
  && isNum(s.w) && s.w > 0 && s.w <= 40 && typeof s.c === 'string' && /^#[0-9a-f]{6}$/i.test(s.c);

io.on('connection', socket => {
  let roomId = null;
  const room = () => rooms.get(roomId);

  socket.on('join', (id, ack) => {
    if (roomId || typeof id !== 'string' || !ROOM_RE.test(id)) return ack?.({ error: 'Invalid room' });
    if (!rooms.has(id)) rooms.set(id, { peers: new Map(), strokes: [] });
    const r = rooms.get(id);
    if (r.peers.size >= MAX_PEERS) return ack?.({ error: `Room is full (max ${MAX_PEERS})` });

    roomId = id;
    const existing = [...r.peers].map(([peerId, username]) => ({ id: peerId, username }));
    r.peers.set(socket.id, socket.user.username);
    socket.join(id);
    // The newcomer calls everyone already inside; they just wait for its offer (avoids both sides offering)
    ack?.({ self: socket.id, username: socket.user.username, peers: existing, strokes: r.strokes });
    socket.to(id).emit('peer-joined', { id: socket.id, username: socket.user.username });
  });

  // WebRTC offer / answer / ICE candidate: relayed only to a peer in the same room
  socket.on('signal', ({ to, data } = {}) => {
    if (room()?.peers.has(to)) io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('draw', stroke => {
    const r = room();
    if (!r || !validStroke(stroke)) return;
    if (r.strokes.length < MAX_STROKES) r.strokes.push(stroke);
    socket.to(roomId).emit('draw', stroke);
  });

  socket.on('clear-board', () => {
    const r = room();
    if (!r) return;
    r.strokes = [];
    io.to(roomId).emit('clear-board', socket.user.username);
  });

  // Chat is end-to-end encrypted in the browser (AES-GCM). The server only sees {iv, ct}
  // and cannot read it: the key lives in the invite link's #fragment, which browsers never send.
  socket.on('chat', msg => {
    const b64 = (v, max) => typeof v === 'string' && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
    if (!room() || !b64(msg?.iv, 32) || !b64(msg?.ct, 3000)) return;
    io.to(roomId).emit('chat', { from: socket.user.username, iv: msg.iv, ct: msg.ct, at: Date.now() });
  });

  socket.on('disconnect', () => {
    const r = room();
    if (!r) return;
    r.peers.delete(socket.id);
    socket.to(roomId).emit('peer-left', socket.id);
    if (!r.peers.size) rooms.delete(roomId); // empty room: forget its whiteboard too
  });
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`Meet app running at http://localhost:${port}`));
}

module.exports = server;
