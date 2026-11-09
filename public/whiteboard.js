// points are sent as 0-1 values instead of pixels,
// so the drawing shows up in the same spot on any screen size
function initBoard(canvas, socket, history) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width, height = canvas.height;
  // board colour comes from the --color-board token (hex, because erasing sends it through the server's #hex check)
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-board').trim() || '#071129';
  const color = document.getElementById('pen-color');
  const size = document.getElementById('pen-size');
  let erasing = false, last = null;

  const clear = () => { ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height); };
  function line(s) {
    ctx.strokeStyle = s.c;
    ctx.lineWidth = s.w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x0 * width, s.y0 * height);
    ctx.lineTo(s.x1 * width, s.y1 * height);
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
    const s = { x0: last.x, y0: last.y, x1: p.x, y1: p.y, c: erasing ? bg : color.value, w: erasing ? 30 : Number(size.value) };
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
