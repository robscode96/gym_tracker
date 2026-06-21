import { Router } from 'express';
import { query } from '../db.js';
import { asyncH, num } from '../util.js';

const router = Router();

// Plain-English progress data: this-week vs last-week training count, and each
// exercise's first vs latest best-set weight so the client can write summaries.
router.get('/insights', asyncH(async (req, res) => {
  const uid = req.userId;

  const week = await query(
    `SELECT
       (SELECT COUNT(*) FROM workouts WHERE user_id = $1 AND performed_on >= date_trunc('week', CURRENT_DATE)) AS this,
       (SELECT COUNT(*) FROM workouts WHERE user_id = $1
          AND performed_on >= date_trunc('week', CURRENT_DATE) - INTERVAL '7 days'
          AND performed_on <  date_trunc('week', CURRENT_DATE)) AS last`,
    [uid]
  );

  const exRes = await query(
    `WITH per AS (
       SELECT s.exercise_id AS eid, w.performed_on AS d, MAX(s.weight) AS top
       FROM sets s JOIN workouts w ON w.id = s.workout_id
       WHERE w.user_id = $1 AND NOT s.is_warmup AND s.weight IS NOT NULL
       GROUP BY s.exercise_id, w.performed_on
     )
     SELECT p.eid, e.name,
            COUNT(*) AS sessions,
            MAX(p.d) AS last_date,
            (array_agg(p.top ORDER BY p.d ASC))[1]  AS first_top,
            (array_agg(p.top ORDER BY p.d DESC))[1] AS last_top
     FROM per p JOIN exercises e ON e.id = p.eid
     GROUP BY p.eid, e.name
     ORDER BY last_date DESC
     LIMIT 8`,
    [uid]
  );

  const exercises = exRes.rows.map((r) => {
    const first = r.first_top == null ? null : num(r.first_top);
    const latest = r.last_top == null ? null : num(r.last_top);
    return {
      id: r.eid,
      name: r.name,
      sessions: num(r.sessions),
      first_top: first,
      last_top: latest,
      delta: first == null || latest == null ? 0 : Math.round((latest - first) * 10) / 10,
      last_date: r.last_date,
    };
  });

  res.json({ week: { this: num(week.rows[0].this), last: num(week.rows[0].last) }, exercises });
}));

export default router;
