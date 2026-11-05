// Shared whiteboard. Points are sent as 0..1 fractions of the board,
// so a stroke lands in the same place on every screen size.
function initBoard(canvas, socket, history) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const BG = '#fbfbfd';
  const color = document.getElementById('pen-color');
  const size = document.getElementById('pen-size');
  let erasing = false, last = null;

  const clear = () => { ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H); };
  function line(s) {
    ctx.strokeStyle = s.c;
    ctx.lineWidth = s.w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x0 * W, s.y0 * H);
    ctx.lineTo(s.x1 * W, s.y1 * H);
    ctx.stroke();
  }
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    const clamp = v => Math.min(1, Math.max(0, v));
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  clear();
  history.forEach(line);

  canvas.onpointerdown = e => { last = pos(e); canvas.setPointerCapture(e.pointerId); };
  canvas.onpointermove = e => {
    if (!last) return;
    const p = pos(e);
    const s = { x0: last.x, y0: last.y, x1: p.x, y1: p.y, c: erasing ? BG : color.value, w: erasing ? 30 : Number(size.value) };
    line(s);
    socket.emit('draw', s);
    last = p;
  };
  canvas.onpointerup = canvas.onpointercancel = () => { last = null; };

  document.getElementById('eraser').onclick = e => {
    erasing = !erasing;
    e.currentTarget.setAttribute('aria-pressed', String(erasing));
  };
  document.getElementById('clear').onclick = () => socket.emit('clear-board');

  socket.on('draw', line);
  socket.on('clear-board', who => { clear(); toast(`${who} cleared the board`); });
}
