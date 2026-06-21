import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
// Long-lived token: the user stays signed in until they explicitly sign out.
const TOKEN_TTL = '365d';

if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET is not set — using an insecure default. Set JWT_SECRET in production!');
}

export function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, unit: u.unit };
}

export async function authenticate(username, password) {
  const res = await query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  const user = res.rows[0];
  if (!user) return null;
  return bcrypt.compareSync(password, user.password_hash) ? user : null;
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    req.username = payload.username;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}
