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

// "Try next time" suggestion for the set logger, using simple double progression
// over an 8–12 rep range. Pin-loaded machines: if the next weight jump is large
// (>12% of the working weight), suggest adding a rep instead of adding weight.
router.get('/exercises/:id/suggestion', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const exclude = toInt(req.query.exclude); // ignore the in-progress workout
  const owns = await query('SELECT id FROM exercises WHERE id = $1 AND user_id = $2', [id, req.userId]);
  if (!owns.rows.length) return res.status(404).json({ error: 'Exercise not found' });

  const last = await query(
    `SELECT w.id, w.performed_on
     FROM workouts w JOIN sets s ON s.workout_id = w.id
     WHERE w.user_id = $1 AND s.exercise_id = $2 AND NOT s.is_warmup ${exclude ? 'AND w.id <> $3' : ''}
     GROUP BY w.id, w.performed_on
     ORDER BY w.performed_on DESC, w.id DESC
     LIMIT 1`,
    exclude ? [req.userId, id, exclude] : [req.userId, id]
  );
  if (!last.rows.length) return res.json({ has: false });

  const setsRes = await query(
    `SELECT reps, weight FROM sets WHERE workout_id = $1 AND exercise_id = $2 AND NOT is_warmup ORDER BY set_index, id`,
    [last.rows[0].id, id]
  );
  const sets = setsRes.rows
    .map((r) => ({ reps: r.reps == null ? 0 : num(r.reps), weight: r.weight == null ? null : num(r.weight) }))
    .filter((s) => s.weight != null);
  if (!sets.length) return res.json({ has: false });

  const TOP = 12, BOTTOM = 8;
  const topWeight = Math.max(...sets.map((s) => s.weight));
  const minRepsAtTop = Math.min(...sets.filter((s) => s.weight === topWeight).map((s) => s.reps));
  const completedAllAtTop = sets.every((s) => s.reps >= TOP);

  // Infer this machine's weight step from the smallest gap between weights used.
  const wRes = await query(
    `SELECT DISTINCT weight FROM sets s JOIN workouts w ON w.id = s.workout_id
     WHERE w.user_id = $1 AND s.exercise_id = $2 AND NOT s.is_warmup AND weight IS NOT NULL
     ORDER BY weight ASC`,
    [req.userId, id]
  );
  const weights = wRes.rows.map((r) => num(r.weight));
  let step = null;
  for (let k = 1; k < weights.length; k++) {
    const d = weights[k] - weights[k - 1];
    if (d > 0 && (step == null || d < step)) step = d;
  }
  const userRow = await query('SELECT unit FROM users WHERE id = $1', [req.userId]);
  if (step == null) step = (userRow.rows[0]?.unit === 'kg') ? 5 : 10;

  let suggestion, addedWeight = false;
  if (completedAllAtTop) {
    const bigJump = step > 0.12 * topWeight;
    if (bigJump) {
      suggestion = { reps: TOP + 1, weight: topWeight }; // add a rep rather than a big pin jump
    } else {
      suggestion = { reps: BOTTOM, weight: topWeight + step };
      addedWeight = true;
    }
  } else {
    suggestion = { reps: minRepsAtTop + 1, weight: topWeight };
  }

  res.json({
    has: true,
    last: { reps: minRepsAtTop, weight: topWeight, sets: sets.length, date: last.rows[0].performed_on },
    suggestion,
    added_weight: addedWeight,
  });
}));

export default router;
