// Dependency-free SVG charts.
import { fmtCompact } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function txt(x, y, str, anchor) {
  const t = s('text', { x, y, 'text-anchor': anchor || 'start' });
  t.textContent = str;
  return t;
}

// points: [{ label, value }]
export function lineChart(points, { formatY = fmtCompact } = {}) {
  const W = 324, H = 172, padL = 10, padR = 36, padT = 14, padB = 22;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
  if (!points.length) return svg;

  const vals = points.map((p) => p.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1;
  min -= pad; max += pad;
  const range = max - min || 1;

  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v) => padT + innerH - ((v - min) / range) * innerH;

  const defs = s('defs');
  const grad = s('linearGradient', { id: 'grad', x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.appendChild(s('stop', { offset: '0%', 'stop-color': '#f59e0b' }));
  grad.appendChild(s('stop', { offset: '100%', 'stop-color': '#f59e0b', 'stop-opacity': 0 }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  let d = '';
  points.forEach((p, i) => { d += (i ? ' L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1); });
  const baseY = (padT + innerH).toFixed(1);
  svg.appendChild(s('path', { class: 'area', d: `${d} L ${x(points.length - 1).toFixed(1)} ${baseY} L ${x(0).toFixed(1)} ${baseY} Z` }));
  svg.appendChild(s('path', { class: 'line', d }));

  if (points.length <= 16) {
    points.forEach((p, i) => svg.appendChild(s('circle', { class: 'dot', cx: x(i), cy: y(p.value), r: 2.6 })));
  }

  svg.appendChild(txt(W - padR + 4, padT + 3, formatY(max), 'start'));
  svg.appendChild(txt(W - padR + 4, padT + innerH, formatY(min), 'start'));
  svg.appendChild(txt(padL, H - 6, points[0].label, 'start'));
  if (points.length > 1) svg.appendChild(txt(W - padR, H - 6, points[points.length - 1].label, 'end'));
  return svg;
}

// bars: [{ label, value }]
export function barChart(bars, { formatY = fmtCompact } = {}) {
  const W = 324, H = 150, padL = 8, padR = 8, padT = 14, padB = 22;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
  if (!bars.length) return svg;

  const max = Math.max(1, ...bars.map((b) => b.value));
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const n = bars.length, gap = n > 16 ? 2 : 6;
  const bw = innerW / n - gap;

  bars.forEach((b, i) => {
    const bh = (b.value / max) * innerH;
    const bx = padL + i * (bw + gap) + gap / 2;
    const by = padT + innerH - bh;
    svg.appendChild(s('rect', { class: 'bar', x: bx, y: by, width: Math.max(2, bw), height: Math.max(0, bh), rx: 3 }));
    if (b.label) svg.appendChild(txt(bx + bw / 2, H - 7, b.label, 'middle'));
  });
  svg.appendChild(txt(padL, padT, formatY(max), 'start'));
  return svg;
}
