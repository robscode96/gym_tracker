import { Router } from 'express';
import { query } from '../db.js';
import { asyncH, toInt, toNum, toBool, bad, num } from '../util.js';

const router = Router();

async function ownsWorkout(userId, workoutId) {
  const { rows } = await query('SELECT id FROM workouts WHERE id = $1 AND user_id = $2', [workoutId, userId]);
  return rows.length > 0;
}

// List workout sessions with aggregates (newest first).
router.get('/workouts', asyncH(async (req, res) => {
  const { rows } = await query(
    `SELECT w.*,
       COALESCE(agg.set_count, 0)      AS set_count,
       COALESCE(agg.exercise_count, 0) AS exercise_count,
       COALESCE(agg.volume, 0)         AS volume
     FROM workouts w
     LEFT JOIN (
       SELECT workout_id,
              COUNT(*) AS set_count,
              COUNT(DISTINCT exercise_id) AS exercise_count,
              SUM(CASE WHEN is_warmup THEN 0 ELSE COALESCE(reps,0)*COALESCE(weight,0) END) AS volume
       FROM sets GROUP BY workout_id
     ) agg ON agg.workout_id = w.id
     WHERE w.user_id = $1
     ORDER BY w.performed_on DESC, w.id DESC
     LIMIT 300`,
    [req.userId]
  );
  res.json(rows.map((r) => ({
    ...r,
    set_count: num(r.set_count),
    exercise_count: num(r.exercise_count),
    volume: num(r.volume),
  })));
}));

// Full workout detail with sets grouped by exercise.
router.get('/workouts/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const w = await query('SELECT * FROM workouts WHERE id = $1 AND user_id = $2', [id, req.userId]);
  if (!w.rows.length) return res.status(404).json({ error: 'Workout not found' });
  const sets = await query(
    `SELECT s.*, e.name AS exercise_name, e.muscle_group, e.equipment
     FROM sets s JOIN exercises e ON e.id = s.exercise_id
     WHERE s.workout_id = $1
     ORDER BY s.exercise_id, s.set_index, s.id`,
    [id]
  );
  res.json({ ...w.rows[0], sets: sets.rows });
}));

// Create a workout session (optionally with an initial batch of sets).
router.post('/workouts', asyncH(async (req, res) => {
  const { performed_on = null, title = null, notes = null, duration_min = null, sets = [] } = req.body || {};
  const { rows } = await query(
    `INSERT INTO workouts (user_id, performed_on, title, notes, duration_min)
     VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5) RETURNING *`,
    [req.userId, performed_on, title, notes, toInt(duration_min)]
  );
  const workout = rows[0];

  if (Array.isArray(sets) && sets.length) {
    for (let idx = 0; idx < sets.length; idx++) {
      const s = sets[idx];
      const exId = toInt(s.exercise_id);
      if (!exId) continue;
      await query(
        `INSERT INTO sets (workout_id, exercise_id, set_index, reps, weight, unit, rpe, is_warmup)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [workout.id, exId, toInt(s.set_index, idx + 1), toInt(s.reps), toNum(s.weight),
         s.unit || null, toNum(s.rpe), toBool(s.is_warmup)]
      );
    }
  }
  res.status(201).json(workout);
}));

router.patch('/workouts/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const fields = [];
  const vals = [];
  let i = 1;
  for (const key of ['performed_on', 'title', 'notes']) {
    if (key in (req.body || {})) { fields.push(`${key} = $${i++}`); vals.push(req.body[key]); }
  }
  if ('duration_min' in (req.body || {})) { fields.push(`duration_min = $${i++}`); vals.push(toInt(req.body.duration_min)); }
  if (!fields.length) return bad(res, 'Nothing to update');
  vals.push(id, req.userId);
  const { rows } = await query(
    `UPDATE workouts SET ${fields.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'Workout not found' });
  res.json(rows[0]);
}));

router.delete('/workouts/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const { rows } = await query('DELETE FROM workouts WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Workout not found' });
  res.json({ ok: true });
}));

// Add a single set to an existing workout (used by the live logger).
router.post('/workouts/:id/sets', asyncH(async (req, res) => {
  const workoutId = toInt(req.params.id);
  if (!(await ownsWorkout(req.userId, workoutId))) return res.status(404).json({ error: 'Workout not found' });

  const exId = toInt(req.body?.exercise_id);
  if (!exId) return bad(res, 'exercise_id is required');
  const owns = await query('SELECT id FROM exercises WHERE id = $1 AND user_id = $2', [exId, req.userId]);
  if (!owns.rows.length) return bad(res, 'Unknown exercise');

  let setIndex = toInt(req.body.set_index);
  if (!setIndex) {
    const r = await query('SELECT COALESCE(MAX(set_index),0)+1 AS n FROM sets WHERE workout_id = $1 AND exercise_id = $2', [workoutId, exId]);
    setIndex = num(r.rows[0].n);
  }

  const { rows } = await query(
    `INSERT INTO sets (workout_id, exercise_id, set_index, reps, weight, unit, rpe, is_warmup)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [workoutId, exId, setIndex, toInt(req.body.reps), toNum(req.body.weight),
     req.body.unit || null, toNum(req.body.rpe), toBool(req.body.is_warmup)]
  );
  res.status(201).json(rows[0]);
}));

router.delete('/sets/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const { rows } = await query(
    `DELETE FROM sets WHERE id = $1 AND workout_id IN (SELECT id FROM workouts WHERE user_id = $2) RETURNING id`,
    [id, req.userId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Set not found' });
  res.json({ ok: true });
}));

export default router;
