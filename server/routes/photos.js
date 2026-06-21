import { Router } from 'express';
import { query } from '../db.js';
import { asyncH, toInt, toNum, bad } from '../util.js';
import { aiEnabled, analyzeProgressPhotos } from '../ai.js';

const router = Router();

// Accepts a data URL ("data:image/jpeg;base64,....") or raw base64 + mime.
function parseImage(body) {
  let { image, mime } = body || {};
  if (!image || typeof image !== 'string') return null;
  const m = image.match(/^data:([^;]+);base64,(.*)$/s);
  if (m) {
    mime = m[1];
    image = m[2];
  }
  if (!image) return null;
  const buffer = Buffer.from(image, 'base64');
  if (!buffer.length) return null;
  return { buffer, mime: mime || 'image/jpeg' };
}

router.get('/ai/status', (req, res) => res.json({ enabled: aiEnabled() }));

// Photo metadata only (image fetched separately to keep payloads small).
router.get('/photos', asyncH(async (req, res) => {
  const { rows } = await query(
    `SELECT id, taken_on, mime, bodyweight, notes, ai_analysis, created_at,
            octet_length(image) AS bytes
     FROM photos WHERE user_id = $1
     ORDER BY taken_on DESC, id DESC`,
    [req.userId]
  );
  res.json(rows);
}));

router.get('/photos/:id/image', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const { rows } = await query('SELECT image, mime FROM photos WHERE id = $1 AND user_id = $2', [id, req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
  res.setHeader('Content-Type', rows[0].mime || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(rows[0].image));
}));

router.post('/photos', asyncH(async (req, res) => {
  const parsed = parseImage(req.body);
  if (!parsed) return bad(res, 'A valid image is required');
  const { taken_on = null, bodyweight = null, notes = null } = req.body || {};
  const { rows } = await query(
    `INSERT INTO photos (user_id, taken_on, image, mime, bodyweight, notes)
     VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4, $5, $6)
     RETURNING id, taken_on, mime, bodyweight, notes, created_at`,
    [req.userId, taken_on, parsed.buffer, parsed.mime, toNum(bodyweight), notes]
  );
  res.status(201).json(rows[0]);
}));

router.delete('/photos/:id', asyncH(async (req, res) => {
  const id = toInt(req.params.id);
  const { rows } = await query('DELETE FROM photos WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
  res.json({ ok: true });
}));

// Run Claude vision over a set of photos (chronological) and store the result.
router.post('/photos/analyze', asyncH(async (req, res) => {
  if (!aiEnabled()) return bad(res, 'AI analysis is not configured. Set ANTHROPIC_API_KEY to enable it.');

  let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(toInt).filter(Boolean) : [];
  // Default: analyze the most recent few photos.
  if (!ids.length) {
    const recent = await query(
      'SELECT id FROM photos WHERE user_id = $1 ORDER BY taken_on DESC, id DESC LIMIT 4',
      [req.userId]
    );
    ids = recent.rows.map((r) => r.id);
  }
  if (!ids.length) return bad(res, 'No photos to analyze. Add a progress photo first.');
  if (ids.length > 6) ids = ids.slice(0, 6);

  const { rows } = await query(
    `SELECT id, taken_on, image, mime, bodyweight, notes
     FROM photos WHERE user_id = $1 AND id = ANY($2)
     ORDER BY taken_on ASC, id ASC`,
    [req.userId, ids]
  );
  if (!rows.length) return res.status(404).json({ error: 'Photos not found' });

  const userRes = await query('SELECT unit FROM users WHERE id = $1', [req.userId]);
  const unit = userRes.rows[0]?.unit || 'lb';

  const photos = rows.map((r) => ({
    taken_on: r.taken_on,
    bodyweight: r.bodyweight == null ? null : Number(r.bodyweight),
    notes: r.notes,
    mime: r.mime,
    base64: Buffer.from(r.image).toString('base64'),
  }));

  const analysis = await analyzeProgressPhotos(photos, { unit });

  // Save the write-up against the most recent photo in the set.
  const latestId = rows[rows.length - 1].id;
  await query('UPDATE photos SET ai_analysis = $1 WHERE id = $2 AND user_id = $3', [analysis, latestId, req.userId]);

  res.json({ analysis, photo_id: latestId, analyzed_ids: rows.map((r) => r.id) });
}));

export default router;
