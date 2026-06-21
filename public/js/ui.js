// Tiny DOM + UI helpers (no framework).

function appendChildren(el, children) {
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && k !== 'list' && k !== 'type') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
      else el.setAttribute(k, v);
    }
  }
  appendChildren(el, children);
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

let toastTimer;
export function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

export function sheet({ title, body, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const content = h('div', { class: 'sheet' }, h('div', { class: 'grip' }), title ? h('h3', null, title) : null, body);
  const backdrop = h('div', { class: 'sheet-backdrop' }, content);
  let closed = false;
  function close() {
    if (closed) return; closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  root.appendChild(backdrop);
  return { close, el: content };
}

export function confirmDialog(message, { danger = false, okText = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    let decided = false;
    const done = (v) => { decided = true; s.close(); resolve(v); };
    const s = sheet({
      body: h('div', { class: 'stack' },
        h('p', { style: { margin: '4px 2px 8px' } }, message),
        h('button', { class: 'btn btn-block ' + (danger ? 'btn-danger' : 'btn-primary'), onClick: () => done(true) }, okText),
        h('button', { class: 'btn btn-block', onClick: () => done(false) }, 'Cancel'),
      ),
      onClose: () => { if (!decided) resolve(false); },
    });
  });
}

/* ---------- formatting ---------- */
function toDateParts(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
  const d = new Date(v);
  if (isNaN(d)) return null;
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() };
}

export function fmtDate(v, { weekday = false, year = 'auto' } = {}) {
  const p = toDateParts(v);
  if (!p) return '';
  const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (weekday) opts.weekday = 'short';
  if (year === true || (year === 'auto' && p.y !== new Date().getFullYear())) opts.year = 'numeric';
  return dt.toLocaleDateString(undefined, opts);
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function daysAgo(v) {
  const p = toDateParts(v);
  if (!p) return null;
  const then = Date.UTC(p.y, p.mo - 1, p.d);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - then) / 86400000);
}

export function relDay(v) {
  const d = daysAgo(v);
  if (d == null) return '';
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  return fmtDate(v);
}

export function fmtNum(n) {
  if (n == null || n === '') return '–';
  const r = Math.round(Number(n) * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function fmtCompact(n) {
  n = Number(n) || 0;
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

export function loading() {
  return h('div', { class: 'loading' }, h('div', { class: 'spinner' }));
}

export function empty(icon, text, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'em-ico' }, icon), h('p', null, text), action || null);
}
