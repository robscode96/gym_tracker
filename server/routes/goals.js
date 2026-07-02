import { Router } from 'express';
import { query } from '../db.js';
import { asyncH, toInt, toNum, toBool, bad, num } from '../util.js';

const router = Router();

const KINDS = new Set(['weekly_workouts', 'total_workouts', 'exercise_weight', 'exercise_1rm']);

// Compute the current value for a goal so the client can render progress.
async function currentValue(userId, goal) {
  switch (goal.kind) {
    case 'weekly_workouts': {
      const r = await query(
        `SELECT COUNT(*) AS n FROM workouts w
         WHERE w.user_id = $1 AND w.performed_on >= date_trunc('week', CURRENT_DATE)
           AND EXISTS (SELECT 1 FROM sets sx WHERE sx.workout_id = w.id)`,
        [userId]
      );
      return num(r.rows[0].n);
    }
    case 'total_workouts': {
      const r = await query(
        `SELECT COUNT(*) AS n FROM workouts w WHERE w.user_id = $1
           AND EXISTS (SELECT 1 FROM sets sx WHERE sx.workout_id = w.id)`,
        [userId]
      );
      return num(r.rows[0].n);
    }
    case 'exercise_weight': {
      const r = await query(
        `SELECT MAX(s.weight) AS v FROM sets s JOIN workouts w ON w.id = s.workout_id
         WHERE w.user_id = $1 AND s.exercise_id = $2 AND NOT s.is_warmup`,
        [userId, goal.exercise_id]
      );
      return num(r.rows[0].v);
    }
    case 'exercise_1rm': {
      const r = await query(
        `SELECT MAX(COALESCE(s.weight,0)*(1+COALESCE(s.reps,0)/30.0)) AS v
         FROM sets s JOIN workouts w ON w.id = s.workout_id
         WHERE w.user_id = $1 AND s.exercise_id = $2 AND NOT s.is_warmup`,
        [userId, goal.exercise_id]
      );
      return Math.round(num(r.rows[0].v) * 10) / 10;
    }
    default:
      return 0;
  }
}

router.get('/goals', asyncH(async (req, res) => {
  const { rows } = await query(
    `SELECT g.*, e.name AS exercise_name FROM goals g
     LEFT JOIN exercises e ON e.id = g.exercise_id
     WHERE g.user_id = $1 ORDER BY g.is_active DESC, g.created_at DESC`,
    [req.userId]
  );

  const out = [];
  for (const g of rows) {
    const current = await currentValue(req.userId, g);
    const target = num(g.target_value);
    const reached = target > 0 && current >= target;
    // Sticky achievement: stamp the first time a goal is reached.
    if (reached && !g.achieved_at) {
      const upd = await query('UPDATE goals SET achieved_at = now() WHERE id = $1 RETURNING achieved_at', [g.id]);
      g.achieved_at = upd.rows[0].achieved_at;
    }
    out.push({
      ...g,
      target_value: target,
      current,
      pct: target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0,
      reached,
    });
  }
  res.json(out);
}));

router.post('/goals', asyncH(async (req, res) => {
  const { kind, exercise_id = null, title = null, target_value, target_date = null } = req.body || {};
  if (!KINDS.has(kind)) return bad(res, 'Invalid goal type');
  const target = toNum(target_value);
  if (target == null || target <= 0) return bad(res, 'Target must be a positive number');
  if ((kind === 'exercise_weight' || kind === 'exercise_1rm') && !toInt(exercise_id)) {
    return bad(res, 'This goal type requires an exercise');
  }
  const { rows } = await query(
    `INSERT INTO goals (user_id, kind, exercise_id, title, target_value, target_date)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.userId, kind, toInt(exercise_id), title, target, target_date]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/goals/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const fields = [];
  const vals = [];
  let i = 1;
  for (const key of ['title', 'target_value', 'target_date']) {
    if (key in (req.body || {})) { fields.push(`${key} = $${i++}`); vals.push(req.body[key]); }
  }
  if ('is_active' in (req.body || {})) { fields.push(`is_active = $${i++}`); vals.push(toBool(req.body.is_active)); }
  if (!fields.length) return bad(res, 'Nothing to update');
  vals.push(id, req.userId);
  const { rows } = await query(
    `UPDATE goals SET ${fields.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING *`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'Goal not found' });
  res.json(rows[0]);
}));

router.delete('/goals/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const { rows } = await query('DELETE FROM goals WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Goal not found' });
  res.json({ ok: true });
}));

export default router;
