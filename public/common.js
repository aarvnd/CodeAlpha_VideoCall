// helpers used on every page + login and lobby page code

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !location.pathname.startsWith('/login')) goLogin();
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

// save where to go back after login in sessionStorage instead of the url,
// that way the chat key after # never gets sent to the server
function goLogin() {
  try { sessionStorage.setItem('next', location.pathname + location.search + location.hash); } catch {}
  location.href = '/login';
}

// small helper to build elements. strings go in as text so nobody can inject html
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...children.flat().filter(c => c != null && c !== false));
  return el;
}

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

// base64url encode / decode
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

function loginPage() {
  const form = document.getElementById('auth');
  const err = document.getElementById('err');
  let mode = 'login';
  document.querySelectorAll('[data-mode]').forEach(t => t.onclick = () => {
    mode = t.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-selected', String(x === t)));
    form.querySelector('button[type=submit]').textContent = mode === 'login' ? 'Log in' : 'Create account';
    form.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    err.textContent = '';
  });
  form.onsubmit = async e => {
    e.preventDefault();
    try {
      await api('POST', `/api/${mode}`, { username: form.username.value, password: form.password.value });
      let next = '/';
      try { next = sessionStorage.getItem('next') || '/'; sessionStorage.removeItem('next'); } catch {}
      location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    } catch (e2) { err.textContent = e2.message; }
  };
}

async function lobbyPage() {
  const me = await api('GET', '/api/me');
  document.getElementById('hello').textContent = `Hi ${me.username}, start or join a meeting`;
  document.getElementById('logout').onclick = async () => { await api('POST', '/api/logout'); location.href = '/login'; };

  document.getElementById('new').onclick = () => {
    const id = crypto.randomUUID().slice(0, 8) + '-' + crypto.randomUUID().slice(0, 4);
    const key = b64(crypto.getRandomValues(new Uint8Array(32))); // random 256 bit key for the chat
    location.href = `/room?id=${id}#k=${key}`;
  };

  document.getElementById('join').onsubmit = e => {
    e.preventDefault();
    const value = e.target.link.value.trim();
    try {
      const url = new URL(value, location.origin);
      if (url.origin === location.origin && url.searchParams.get('id')) return location.href = url.pathname + url.search + url.hash;
    } catch {}
    if (/^[a-z0-9-]{4,40}$/.test(value)) return location.href = `/room?id=${value}`;
    toast('Paste the full invite link (or a room code)');
  };
}

({ login: loginPage, lobby: lobbyPage })[document.body.dataset.page]?.();
