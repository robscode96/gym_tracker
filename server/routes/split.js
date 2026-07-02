import { Router } from 'express';
import { query } from '../db.js';
import { asyncH, toInt, bad } from '../util.js';

const router = Router();

// The weekly schedule, one entry per weekday (0=Sun .. 6=Sat). Each day is
// either rest or points at a workout template; exercises are resolved from the
// template so template edits flow through to every day using it.
router.get('/split', asyncH(async (req, res) => {
  const [days, tpls, exAll] = await Promise.all([
    query('SELECT weekday, title, kind, template_id FROM split_days WHERE user_id = $1 ORDER BY weekday', [req.userId]),
    query('SELECT id, name, exercise_ids_json FROM workout_templates WHERE user_id = $1', [req.userId]),
    query('SELECT id, name FROM exercises WHERE user_id = $1 AND is_archived = FALSE', [req.userId]),
  ]);
  const exMap = new Map(exAll.rows.map((e) => [e.id, e.name]));
  const tplMap = new Map(tpls.rows.map((t) => [t.id, t]));

  const out = days.rows.map((d) => {
    const tpl = d.template_id != null ? tplMap.get(d.template_id) : null;
    let exercises = [];
    if (tpl) {
      let ids = [];
      try { ids = JSON.parse(tpl.exercise_ids_json || '[]'); } catch { ids = []; }
      exercises = ids.filter((id) => exMap.has(id)).map((id) => ({ id, name: exMap.get(id) }));
    }
    return {
      weekday: d.weekday,
      kind: tpl ? 'workout' : 'rest',
      title: tpl ? tpl.name : (d.title || 'Rest'),
      template_id: tpl ? tpl.id : null,
      exercises,
    };
  });
  res.json(out);
}));

// Assign a template to a weekday (template_id: null makes it a rest day).
// The stored title is only used for rest days (e.g. "Rest (delivery route
// day)") and is preserved across assign/unassign so notes aren't lost.
router.put('/split/:weekday', asyncH(async (req, res) => {
  const wd = toInt(req.params.weekday);
  if (wd == null || wd < 0 || wd > 6) return bad(res, 'Invalid weekday');

  const raw = req.body ? req.body.template_id : null;
  const templateId = raw == null ? null : toInt(raw);
  if (raw != null && !templateId) return bad(res, 'Invalid template');
  if (templateId != null) {
    const owns = await query('SELECT id FROM workout_templates WHERE id = $1 AND user_id = $2', [templateId, req.userId]);
    if (!owns.rows.length) return bad(res, 'Unknown template');
  }

  const existing = await query('SELECT title FROM split_days WHERE user_id = $1 AND weekday = $2', [req.userId, wd]);
  let title = existing.rows.length ? existing.rows[0].title : null;
  if (req.body?.title != null && String(req.body.title).trim()) title = String(req.body.title).trim();
  if (templateId == null && !title) title = 'Rest';

  await query(
    `INSERT INTO split_days (user_id, weekday, title, kind, exercise_ids_json, template_id)
     VALUES ($1, $2, $3, $4, '[]', $5)
     ON CONFLICT (user_id, weekday)
     DO UPDATE SET title = EXCLUDED.title, kind = EXCLUDED.kind, template_id = EXCLUDED.template_id`,
    [req.userId, wd, title, templateId ? 'workout' : 'rest', templateId]
  );
  res.json({ ok: true });
}));

export default router;
