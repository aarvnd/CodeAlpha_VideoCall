const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
process.env.DB_FILE = ':memory:';
const server = require('../server');

let base;
before(() => new Promise(r => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

async function register(username) {
  const res = await fetch(base + '/api/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'secret1' }),
  });
  assert.equal(res.status, 201);
  return res.headers.get('set-cookie').split(';')[0];
}

const socketFor = cookie => connect(base, { extraHeaders: cookie ? { cookie } : {}, transports: ['websocket'], forceNew: true });
const once = (s, ev) => new Promise(r => s.once(ev, r));

test('wrong password is rejected', async () => {
  await register('carol');
  const res = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'carol', password: 'nope123' }),
  });
  assert.equal(res.status, 401);
});

test('socket without login is refused', async () => {
  const s = socketFor(null);
  const err = await once(s, 'connect_error');
  assert.equal(err.message, 'unauthorized');
  s.close();
});

test('two users join a room, exchange signals, chat and whiteboard', async () => {
  const a = socketFor(await register('alice'));
  const b = socketFor(await register('bob'));

  const ja = await a.emitWithAck('join', 'room-1');
  assert.deepEqual(ja.peers, []);

  const joined = once(a, 'peer-joined');
  const jb = await b.emitWithAck('join', 'room-1');
  assert.equal(jb.peers[0].username, 'alice');
  assert.equal((await joined).username, 'bob');

  // signal goes only to the peer it was meant for
  const sig = once(a, 'signal');
  b.emit('signal', { to: jb.peers[0].id, data: { sdp: 'fake-offer' } });
  assert.deepEqual(await sig, { from: jb.self, data: { sdp: 'fake-offer' } });

  // server only forwards encrypted chat, and the name comes from login (mallory can't fake it)
  const msg = once(b, 'chat');
  a.emit('chat', 'plain text is dropped');
  a.emit('chat', { iv: 'aXY', ct: 'Y2lwaGVy', from: 'mallory' });
  const m = await msg;
  assert.equal(m.from, 'alice');
  assert.equal(m.ct, 'Y2lwaGVy');

  // valid strokes get saved for people joining later, junk gets dropped
  const drawn = once(b, 'draw');
  a.emit('draw', { x0: 9, y0: 0, x1: 0, y1: 0, w: 3, c: '#ffffff' });
  a.emit('draw', { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2, w: 3, c: '#ffffff' });
  assert.equal((await drawn).x1, 0.2);

  const c = socketFor(await register('dave'));
  const jc = await c.emitWithAck('join', 'room-1');
  assert.equal(jc.strokes.length, 1);
  assert.equal(jc.peers.length, 2);

  assert.equal((await c.emitWithAck('join', 'room-2')).error, 'Invalid room');

  const left = once(a, 'peer-left');
  b.close();
  assert.equal(await left, jb.self);
  a.close(); c.close();
});
