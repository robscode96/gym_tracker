import { Router } from 'express';
import { query } from '../db.js';
import { asyncH, toInt, bad } from '../util.js';

const router = Router();

// The user's weekly split, one entry per weekday (0=Sun .. 6=Sat), with
// exercises resolved to {id, name}.
router.get('/split', asyncH(async (req, res) => {
  const [days, exAll] = await Promise.all([
    query('SELECT weekday, title, kind, exercise_ids_json FROM split_days WHERE user_id = $1 ORDER BY weekday', [req.userId]),
    query('SELECT id, name FROM exercises WHERE user_id = $1 AND is_archived = FALSE', [req.userId]),
  ]);
  const exMap = new Map(exAll.rows.map((e) => [e.id, e.name]));
  const out = days.rows.map((d) => {
    let ids = [];
    try { ids = JSON.parse(d.exercise_ids_json || '[]'); } catch { ids = []; }
    const exercises = ids
      .filter((id) => exMap.has(id))
      .map((id) => ({ id, name: exMap.get(id) }));
    return { weekday: d.weekday, title: d.title, kind: d.kind, exercises };
  });
  res.json(out);
}));

// Edit one day of the split. Sending no exercises makes it a rest day.
router.put('/split/:weekday', asyncH(async (req, res) => {
  const wd = toInt(req.params.weekday);
  if (wd == null || wd < 0 || wd > 6) return bad(res, 'Invalid weekday');

  let ids = Array.isArray(req.body?.exercise_ids) ? req.body.exercise_ids.map(toInt).filter(Boolean) : [];
  if (ids.length) {
    const owned = await query('SELECT id FROM exercises WHERE user_id = $1 AND id = ANY($2)', [req.userId, ids]);
    const ok = new Set(owned.rows.map((r) => r.id));
    ids = ids.filter((id) => ok.has(id));
  }
  const kind = ids.length ? 'workout' : 'rest';
  let title = req.body?.title != null ? String(req.body.title).trim() : '';
  if (!title) title = kind === 'rest' ? 'Rest' : 'Workout';

  await query(
    `INSERT INTO split_days (user_id, weekday, title, kind, exercise_ids_json)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, weekday)
     DO UPDATE SET title = EXCLUDED.title, kind = EXCLUDED.kind, exercise_ids_json = EXCLUDED.exercise_ids_json`,
    [req.userId, wd, title, kind, JSON.stringify(ids)]
  );
  res.json({ ok: true });
}));

export default router;
