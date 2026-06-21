import { Router } from 'express';
import { query } from '../db.js';
import { asyncH, toInt, bad, toBool, num } from '../util.js';

const router = Router();

// List exercises (machines). ?archived=1 to include archived.
router.get('/exercises', asyncH(async (req, res) => {
  const includeArchived = toBool(req.query.archived);
  const sql = `
    SELECT e.*,
      (SELECT COUNT(*) FROM sets s WHERE s.exercise_id = e.id) AS set_count,
      (SELECT MAX(performed_on) FROM workouts w
         JOIN sets s ON s.workout_id = w.id WHERE s.exercise_id = e.id) AS last_used
    FROM exercises e
    WHERE e.user_id = $1 ${includeArchived ? '' : 'AND e.is_archived = FALSE'}
    ORDER BY e.is_archived ASC, lower(e.name) ASC`;
  const { rows } = await query(sql, [req.userId]);
  res.json(rows.map((r) => ({ ...r, set_count: num(r.set_count) })));
}));

router.post('/exercises', asyncH(async (req, res) => {
  const { name, muscle_group = null, equipment = null, notes = null } = req.body || {};
  if (!name || !String(name).trim()) return bad(res, 'Name is required');
  const { rows } = await query(
    `INSERT INTO exercises (user_id, name, muscle_group, equipment, notes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [req.userId, String(name).trim(), muscle_group, equipment, notes]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/exercises/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const fields = [];
  const vals = [];
  let i = 1;
  for (const key of ['name', 'muscle_group', 'equipment', 'notes']) {
    if (key in (req.body || {})) { fields.push(`${key} = $${i++}`); vals.push(req.body[key]); }
  }
  if ('is_archived' in (req.body || {})) { fields.push(`is_archived = $${i++}`); vals.push(toBool(req.body.is_archived)); }
  if (!fields.length) return bad(res, 'Nothing to update');
  vals.push(id, req.userId);
  const { rows } = await query(
    `UPDATE exercises SET ${fields.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'Exercise not found' });
  res.json(rows[0]);
}));

// Hard delete (also removes its logged sets). The UI defaults to archiving instead.
router.delete('/exercises/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const { rows } = await query(
    'DELETE FROM exercises WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Exercise not found' });
  res.json({ ok: true });
}));

// History + personal records for one exercise, used by the Progress charts.
router.get('/exercises/:id/history', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const owner = await query('SELECT id, name FROM exercises WHERE id = $1 AND user_id = $2', [id, req.userId]);
  if (!owner.rows.length) return res.status(404).json({ error: 'Exercise not found' });

  // Per-session best set: heaviest weight that day and the volume for the day.
  const { rows } = await query(
    `SELECT w.performed_on,
            MAX(s.weight) FILTER (WHERE NOT s.is_warmup) AS top_weight,
            MAX(COALESCE(s.weight,0) * (1 + COALESCE(s.reps,0)/30.0)) FILTER (WHERE NOT s.is_warmup) AS est_1rm,
            SUM(CASE WHEN s.is_warmup THEN 0 ELSE COALESCE(s.reps,0)*COALESCE(s.weight,0) END) AS volume,
            MAX(s.reps) FILTER (WHERE NOT s.is_warmup) AS top_reps
     FROM sets s JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = $1 AND w.user_id = $2
     GROUP BY w.performed_on
     ORDER BY w.performed_on ASC`,
    [id, req.userId]
  );

  const series = rows.map((r) => ({
    date: r.performed_on,
    top_weight: r.top_weight == null ? null : num(r.top_weight),
    est_1rm: r.est_1rm == null ? null : Math.round(num(r.est_1rm) * 10) / 10,
    volume: num(r.volume),
    top_reps: r.top_reps == null ? null : num(r.top_reps),
  }));

  const maxWeight = series.reduce((m, p) => (p.top_weight != null && p.top_weight > m ? p.top_weight : m), 0);
  const best1rm = series.reduce((m, p) => (p.est_1rm != null && p.est_1rm > m ? p.est_1rm : m), 0);
  res.json({ exercise: owner.rows[0], series, pr: { max_weight: maxWeight, best_1rm: best1rm } });
}));

export default router;
