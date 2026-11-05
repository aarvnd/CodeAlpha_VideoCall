// Meeting room: WebRTC video (mesh), screen share, P2P file sharing, encrypted chat
const params = new URLSearchParams(location.search);
const roomId = params.get('id') || '';
const keyParam = new URLSearchParams(location.hash.slice(1)).get('k');

// shortcut: STUN only — works on the same network / most home NATs; add a TURN server for strict corporate/mobile NATs
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const CHUNK = 16 * 1024;            // safe DataChannel message size across browsers
const MAX_FILE = 50 * 1024 * 1024;  // keep whole file in memory on the receiver, so cap it

const $ = id => document.getElementById(id);
const peers = new Map(); // socketId -> { pc, dc, username, stream, tile, queue }
let camTrack = null, micTrack = null, screenTrack = null, chatKey = null, me = '';
const socket = io({ autoConnect: false });

// ---------- media ----------
async function getMedia() {
  for (const c of [{ video: true, audio: true }, { audio: true }]) {
    try {
      const s = await navigator.mediaDevices.getUserMedia(c);
      camTrack = s.getVideoTracks()[0] || null;
      micTrack = s.getAudioTracks()[0] || null;
      return;
    } catch {}
  }
  toast('No camera or microphone access — you can still chat, draw and share files');
}

function addTile(id, name, local) {
  const video = h('video', { autoplay: '', playsinline: '' });
  video.muted = !!local; // never play your own mic back
  const tile = h('div', { class: 'tile' + (local ? ' local' : ''), id: 'tile-' + id },
    video, h('span', { class: 'name' }, local ? `${name} (you)` : name), h('span', { class: 'state' }));
  $('grid').append(tile);
  return { el: tile, video, state: tile.querySelector('.state') };
}

let localTile;
function showLocal() {
  const track = screenTrack || camTrack;
  localTile.video.srcObject = track ? new MediaStream([track]) : null;
  localTile.el.classList.toggle('mirror', !screenTrack);
  localTile.el.classList.toggle('off', !track || !track.enabled);
}

// Put our current mic + camera/screen onto a connection's audio/video senders
function attachLocalTracks(pc) {
  for (const t of pc.getTransceivers()) {
    t.direction = 'sendrecv';
    t.sender.replaceTrack(t.receiver.track.kind === 'audio' ? micTrack : (screenTrack || camTrack));
  }
}

// ---------- peer connections ----------
function createPeer(id, username, initiator) {
  const pc = new RTCPeerConnection(ICE);
  const peer = { id, pc, dc: null, username, stream: new MediaStream(), tile: addTile(id, username), queue: Promise.resolve() };
  peers.set(id, peer);

  pc.onicecandidate = e => e.candidate && socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  pc.ontrack = e => {
    peer.stream.addTrack(e.track);
    peer.tile.video.srcObject = peer.stream;
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    peer.tile.state.textContent = s === 'connected' ? '' : s;
    if (s === 'failed') toast(`Could not connect to ${username} (network blocks direct connection)`);
  };

  if (initiator) {
    // Fixed audio + video slots, even with no camera: makes screen share a simple track swap later
    pc.addTransceiver('audio');
    pc.addTransceiver('video');
    attachLocalTracks(pc);
    setupChannel(peer, pc.createDataChannel('files'));
    peer.queue = peer.queue.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
    });
  } else {
    pc.ondatachannel = e => setupChannel(peer, e.channel);
  }
  return peer;
}

async function handleSignal(peer, data) {
  const { pc } = peer;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      attachLocalTracks(pc);
      await pc.setLocalDescription(await pc.createAnswer());
      socket.emit('signal', { to: peer.id, data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    await pc.addIceCandidate(data.candidate).catch(() => {});
  }
}

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close();
  p.tile.el.remove();
  peers.delete(id);
  sysLine(`${p.username} left`);
}

// ---------- screen share & controls ----------
function setOutgoingVideo(track) {
  for (const { pc } of peers.values())
    pc.getTransceivers().find(t => t.receiver.track.kind === 'video')?.sender.replaceTrack(track);
  showLocal();
}

async function toggleScreen() {
  if (screenTrack) return stopScreen();
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    screenTrack = s.getVideoTracks()[0];
    screenTrack.onended = stopScreen; // user pressed the browser's own "Stop sharing"
    setOutgoingVideo(screenTrack);
    $('screen').setAttribute('aria-pressed', 'true');
  } catch {}
}

function stopScreen() {
  screenTrack?.stop();
  screenTrack = null;
  setOutgoingVideo(camTrack);
  $('screen').setAttribute('aria-pressed', 'false');
}

function toggleTrack(track, btn) {
  if (!track) return;
  track.enabled = !track.enabled;
  btn.setAttribute('aria-pressed', String(!track.enabled));
  showLocal();
}

// ---------- file sharing (RTCDataChannel, peer to peer) ----------
function setupChannel(peer, dc) {
  peer.dc = dc;
  dc.binaryType = 'arraybuffer';
  let incoming = null;
  dc.onmessage = e => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      if (m.type === 'file' && Number.isInteger(m.size) && m.size > 0 && m.size <= MAX_FILE) {
        incoming = { ...m, parts: [], got: 0, line: sysLine(`${peer.username} is sending ${m.name}…`) };
      }
    } else if (incoming) {
      incoming.parts.push(e.data);
      incoming.got += e.data.byteLength;
      if (incoming.got >= incoming.size) {
        const blob = new Blob(incoming.parts, { type: incoming.mime || 'application/octet-stream' });
        incoming.line.replaceWith(fileLine(peer.username, incoming.name, blob));
        incoming = null;
      }
    }
  };
}

const waitDrain = dc => dc.bufferedAmount < 1 << 20 ? null : new Promise(r => {
  dc.bufferedAmountLowThreshold = 256 << 10;
  dc.addEventListener('bufferedamountlow', r, { once: true });
});

async function sendFile(file) {
  if (file.size > MAX_FILE) return toast('Max file size is 50 MB');
  const channels = [...peers.values()].map(p => p.dc).filter(dc => dc?.readyState === 'open');
  if (!channels.length) return toast('Nobody else is connected yet');
  const line = sysLine(`Sending ${file.name}…`);
  const meta = JSON.stringify({ type: 'file', name: file.name.slice(0, 200), size: file.size, mime: file.type });
  channels.forEach(dc => dc.send(meta));
  for (let o = 0; o < file.size; o += CHUNK) {
    const chunk = await file.slice(o, o + CHUNK).arrayBuffer();
    for (const dc of channels) { await waitDrain(dc); dc.send(chunk); }
  }
  line.replaceWith(fileLine('You', file.name, file));
}

// ---------- end-to-end encrypted chat (AES-GCM) ----------
async function encrypt(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, chatKey, new TextEncoder().encode(text));
  return { iv: b64(iv), ct: b64(ct) };
}

async function decrypt({ iv, ct }) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, chatKey, unb64(ct));
  return new TextDecoder().decode(pt);
}

function chatLine(from, text) {
  const li = h('li', { class: from === me ? 'mine' : '' }, h('b', {}, from), h('span', {}, text));
  $('log').append(li);
  li.scrollIntoView({ block: 'end' });
  return li;
}
const sysLine = text => { const li = chatLine('', text); li.className = 'sys'; return li; };
const fileLine = (from, name, blob) => {
  const li = h('li', { class: 'sys file' }, `${from} shared `,
    h('a', { href: URL.createObjectURL(blob), download: name }, `📎 ${name}`), ` (${(blob.size / 1024).toFixed(0)} KB)`);
  return li;
};

// ---------- boot ----------
async function start() {
  if (!/^[a-z0-9-]{4,40}$/.test(roomId)) { location.href = '/'; return; }
  try { me = (await api('GET', '/api/me')).username; } catch { return; }
  $('code').textContent = roomId;

  if (keyParam) {
    try { chatKey = await crypto.subtle.importKey('raw', unb64(keyParam), 'AES-GCM', false, ['encrypt', 'decrypt']); } catch {}
  }
  if (!chatKey) {
    $('chat-input').disabled = true;
    $('chat-input').placeholder = 'Open the full invite link to use encrypted chat';
  }

  await getMedia();
  localTile = addTile('me', me, true);
  showLocal();
  $('mic').disabled = !micTrack;
  $('cam').disabled = !camTrack;

  socket.on('connect_error', e => e.message === 'unauthorized' ? goLogin() : toast('Connection problem, retrying…'));
  socket.on('disconnect', () => toast('Disconnected from server'));
  socket.on('peer-joined', ({ id, username }) => { createPeer(id, username, false); sysLine(`${username} joined`); });
  socket.on('peer-left', removePeer);
  socket.on('signal', ({ from, data }) => {
    const p = peers.get(from);
    // one-at-a-time per peer: an ICE candidate must not be applied before its offer/answer
    if (p) p.queue = p.queue.then(() => handleSignal(p, data)).catch(err => console.error('signal', err));
  });
  socket.on('chat', async msg => {
    if (!chatKey) return;
    try { chatLine(msg.from, await decrypt(msg)); }
    catch { sysLine(`${msg.from} sent a message you cannot decrypt (different invite key)`); }
  });

  socket.connect();
  const res = await socket.emitWithAck('join', roomId);
  if (res.error) { toast(res.error); setTimeout(() => location.href = '/', 2000); return; }
  initBoard($('board'), socket, res.strokes);
  res.peers.forEach(p => createPeer(p.id, p.username, true)); // newcomer calls everyone already inside
  sysLine(res.peers.length ? `You joined. In the room: ${res.peers.map(p => p.username).join(', ')}` : 'You joined. Share the invite link to bring people in.');

  $('mic').onclick = e => toggleTrack(micTrack, e.currentTarget);
  $('cam').onclick = e => toggleTrack(camTrack, e.currentTarget);
  $('screen').onclick = toggleScreen;
  $('board-btn').onclick = e => {
    const on = $('stage').classList.toggle('board-on');
    $('board-wrap').hidden = !on;
    e.currentTarget.setAttribute('aria-pressed', String(on));
  };
  $('leave').onclick = () => {
    peers.forEach(p => p.pc.close());
    [camTrack, micTrack, screenTrack].forEach(t => t?.stop());
    location.href = '/';
  };
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Invite link copied'); }
    catch { prompt('Copy this invite link', location.href); }
  };
  $('file').onchange = e => { [...e.target.files].forEach(sendFile); e.target.value = ''; };
  $('chat').onsubmit = async e => {
    e.preventDefault();
    const text = $('chat-input').value.trim().slice(0, 1000);
    if (!text || !chatKey) return;
    socket.emit('chat', await encrypt(text));
    $('chat-input').value = '';
  };
}

start();
