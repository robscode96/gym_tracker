import { Router } from 'express';
import { query } from '../db.js';
import { asyncH, toInt, bad } from '../util.js';

const router = Router();

async function ownedExerciseIds(userId, ids) {
  if (!ids.length) return [];
  const owned = await query('SELECT id FROM exercises WHERE user_id = $1 AND id = ANY($2)', [userId, ids]);
  const ok = new Set(owned.rows.map((r) => r.id));
  return ids.filter((id) => ok.has(id));
}

function parseIds(json) {
  try { return JSON.parse(json || '[]'); } catch { return []; }
}

// List templates with exercises resolved (in stored order) and the weekdays
// each template is scheduled on.
router.get('/templates', asyncH(async (req, res) => {
  const [tpls, exAll, days] = await Promise.all([
    query('SELECT id, name, exercise_ids_json, position FROM workout_templates WHERE user_id = $1 ORDER BY position, id', [req.userId]),
    query('SELECT id, name FROM exercises WHERE user_id = $1 AND is_archived = FALSE', [req.userId]),
    query('SELECT weekday, template_id FROM split_days WHERE user_id = $1', [req.userId]),
  ]);
  const exMap = new Map(exAll.rows.map((e) => [e.id, e.name]));
  const usedOn = new Map();
  for (const d of days.rows) {
    if (d.template_id == null) continue;
    if (!usedOn.has(d.template_id)) usedOn.set(d.template_id, []);
    usedOn.get(d.template_id).push(d.weekday);
  }
  res.json(tpls.rows.map((t) => ({
    id: t.id,
    name: t.name,
    exercises: parseIds(t.exercise_ids_json).filter((id) => exMap.has(id)).map((id) => ({ id, name: exMap.get(id) })),
    used_on: usedOn.get(t.id) || [],
  })));
}));

router.post('/templates', asyncH(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 'Name is required');
  const ids = await ownedExerciseIds(req.userId, (Array.isArray(req.body?.exercise_ids) ? req.body.exercise_ids : []).map(toInt).filter(Boolean));
  const pos = await query('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM workout_templates WHERE user_id = $1', [req.userId]);
  const { rows } = await query(
    'INSERT INTO workout_templates (user_id, name, exercise_ids_json, position) VALUES ($1, $2, $3, $4) RETURNING id, name',
    [req.userId, name, JSON.stringify(ids), Number(pos.rows[0].p)]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/templates/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const fields = [];
  const vals = [];
  let i = 1;
  if ('name' in (req.body || {})) {
    const name = String(req.body.name || '').trim();
    if (!name) return bad(res, 'Name is required');
    fields.push(`name = $${i++}`); vals.push(name);
  }
  if ('exercise_ids' in (req.body || {})) {
    const ids = await ownedExerciseIds(req.userId, (Array.isArray(req.body.exercise_ids) ? req.body.exercise_ids : []).map(toInt).filter(Boolean));
    fields.push(`exercise_ids_json = $${i++}`); vals.push(JSON.stringify(ids));
  }
  if (!fields.length) return bad(res, 'Nothing to update');
  vals.push(id, req.userId);
  const { rows } = await query(
    `UPDATE workout_templates SET ${fields.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING id, name`,
    vals
  );
  if (!rows.length) return res.status(404).json({ error: 'Template not found' });
  res.json(rows[0]);
}));

// Delete a template; any weekday scheduled with it becomes a rest day.
router.delete('/templates/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  await query(
    `UPDATE split_days SET template_id = NULL, kind = 'rest', title = COALESCE(title, 'Rest')
     WHERE user_id = $1 AND template_id = $2`,
    [req.userId, id]
  );
  const { rows } = await query('DELETE FROM workout_templates WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Template not found' });
  res.json({ ok: true });
}));

export default router;
