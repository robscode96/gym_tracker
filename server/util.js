// Wrap an async route handler so thrown errors hit the Express error handler.
export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function toInt(v, def = null) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toBool(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

export function bad(res, msg) {
  return res.status(400).json({ error: msg });
}

// Postgres returns BIGINT/NUMERIC as strings; PGlite may return numbers.
// Normalise aggregate values to JS numbers.
export function num(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
