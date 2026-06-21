import { Router } from 'express';
import { query } from '../db.js';
import { asyncH, num } from '../util.js';

const router = Router();

const DAY = 86400000;
const WEEK = 7 * DAY;

function toDate(v) {
  // Normalise pg (Date) and PGlite (string) week-start values to a UTC midnight Date.
  const d = new Date(typeof v === 'string' ? v : v);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function mondayUTC(d = new Date()) {
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (u.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  return new Date(u.getTime() - dow * DAY);
}

// Consecutive-week streak: weeks (Mon–Sun) containing at least one workout.
// The in-progress current week doesn't break the streak if it's still empty.
function computeStreaks(weekStarts) {
  const set = new Set(weekStarts.map((d) => toDate(d).getTime()));
  const thisMon = mondayUTC().getTime();

  let current = 0;
  let cursor = set.has(thisMon) ? thisMon : thisMon - WEEK;
  while (set.has(cursor)) { current++; cursor -= WEEK; }

  const sorted = [...set].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const t of sorted) {
    run = prev !== null && t - prev === WEEK ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = t;
  }
  return { current, longest, unit: 'week' };
}

router.get('/stats', asyncH(async (req, res) => {
  const uid = req.userId;

  const totals = await query(
    `SELECT
       (SELECT COUNT(*) FROM workouts WHERE user_id = $1) AS workouts,
       (SELECT COUNT(*) FROM sets s JOIN workouts w ON w.id = s.workout_id WHERE w.user_id = $1) AS sets,
       (SELECT COUNT(*) FROM exercises WHERE user_id = $1 AND is_archived = FALSE) AS exercises,
       (SELECT COALESCE(SUM(CASE WHEN s.is_warmup THEN 0 ELSE COALESCE(s.reps,0)*COALESCE(s.weight,0) END),0)
          FROM sets s JOIN workouts w ON w.id = s.workout_id WHERE w.user_id = $1) AS volume,
       (SELECT COUNT(*) FROM workouts WHERE user_id = $1 AND performed_on >= date_trunc('week', CURRENT_DATE)) AS this_week,
       (SELECT MAX(performed_on) FROM workouts WHERE user_id = $1) AS last_workout`,
    [uid]
  );
  const t = totals.rows[0];

  const weeks = await query(
    `SELECT DISTINCT date_trunc('week', performed_on)::date AS wk FROM workouts WHERE user_id = $1`,
    [uid]
  );
  const streak = computeStreaks(weeks.rows.map((r) => r.wk));

  const prsRes = await query(
    `SELECT e.id, e.name,
       MAX(s.weight) FILTER (WHERE NOT s.is_warmup) AS max_weight,
       MAX(COALESCE(s.weight,0)*(1+COALESCE(s.reps,0)/30.0)) FILTER (WHERE NOT s.is_warmup) AS best_1rm
     FROM exercises e JOIN sets s ON s.exercise_id = e.id JOIN workouts w ON w.id = s.workout_id
     WHERE e.user_id = $1
     GROUP BY e.id, e.name
     HAVING MAX(s.weight) FILTER (WHERE NOT s.is_warmup) IS NOT NULL
     ORDER BY best_1rm DESC NULLS LAST
     LIMIT 8`,
    [uid]
  );
  const prs = prsRes.rows.map((r) => ({
    id: r.id, name: r.name,
    max_weight: num(r.max_weight),
    best_1rm: Math.round(num(r.best_1rm) * 10) / 10,
  }));

  const volRes = await query(
    `SELECT date_trunc('week', w.performed_on)::date AS wk,
            SUM(CASE WHEN s.is_warmup THEN 0 ELSE COALESCE(s.reps,0)*COALESCE(s.weight,0) END) AS volume
     FROM workouts w LEFT JOIN sets s ON s.workout_id = w.id
     WHERE w.user_id = $1 AND w.performed_on >= CURRENT_DATE - INTERVAL '84 days'
     GROUP BY wk ORDER BY wk ASC`,
    [uid]
  );
  const volume_by_week = volRes.rows.map((r) => ({ week: r.wk, volume: num(r.volume) }));

  const calRes = await query(
    `SELECT DISTINCT performed_on FROM workouts
     WHERE user_id = $1 AND performed_on >= CURRENT_DATE - INTERVAL '140 days'
     ORDER BY performed_on`,
    [uid]
  );

  res.json({
    totals: {
      workouts: num(t.workouts),
      sets: num(t.sets),
      exercises: num(t.exercises),
      volume: num(t.volume),
      this_week: num(t.this_week),
      last_workout: t.last_workout,
    },
    streak,
    prs,
    volume_by_week,
    workout_days: calRes.rows.map((r) => r.performed_on),
  });
}));

export default router;
