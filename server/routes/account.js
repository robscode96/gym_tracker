import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { publicUser } from '../auth.js';
import { asyncH, bad } from '../util.js';

const router = Router();

router.get('/me', asyncH(async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json({ user: publicUser(rows[0]) });
}));

router.patch('/me', asyncH(async (req, res) => {
  const fields = [];
  const vals = [];
  let i = 1;
  if ('display_name' in (req.body || {})) { fields.push(`display_name = $${i++}`); vals.push(req.body.display_name); }
  if ('unit' in (req.body || {})) {
    const unit = req.body.unit === 'kg' ? 'kg' : 'lb';
    fields.push(`unit = $${i++}`); vals.push(unit);
  }
  if (!fields.length) return bad(res, 'Nothing to update');
  vals.push(req.userId);
  const { rows } = await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, vals);
  res.json({ user: publicUser(rows[0]) });
}));

router.post('/me/password', asyncH(async (req, res) => {
  const { current, next } = req.body || {};
  if (!next || String(next).length < 1) return bad(res, 'New password is required');
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  if (!bcrypt.compareSync(current || '', rows[0].password_hash)) {
    return res.status(403).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(String(next), 10);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.userId]);
  res.json({ ok: true });
}));

export default router;
