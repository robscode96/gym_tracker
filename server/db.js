import 'dotenv/config';
import bcrypt from 'bcryptjs';

/**
 * Database layer.
 *
 * - In production (Railway) a DATABASE_URL is provided -> we use node-postgres (`pg`).
 * - For local development with no DATABASE_URL we transparently fall back to PGlite,
 *   a WASM build of Postgres that persists to ./.data. This means `npm run dev` works
 *   with zero setup, while production uses a real managed Postgres.
 *
 * Both backends speak the same SQL and expose query(text, params) -> { rows }.
 */

let _query = null;
let _close = async () => {};
let backend = null;

function wantsSsl(connectionString) {
  if (!connectionString) return false;
  if (/sslmode=disable/.test(connectionString)) return false;
  if (/sslmode=require/.test(connectionString)) return true;
  // Railway internal networking and local Postgres do not need SSL.
  if (/localhost|127\.0\.0\.1|::1|\.railway\.internal/.test(connectionString)) return false;
  // Anything else (public proxies, external hosts) -> use SSL, accept managed certs.
  return true;
}

async function initPostgres(connectionString) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    ssl: wantsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  // Surface idle-client errors instead of crashing the process.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  await pool.query('SELECT 1');
  _query = (text, params) => pool.query(text, params);
  _close = () => pool.end();
  backend = 'postgres';
}

async function initPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || './.data';
  const db = new PGlite(dir);
  await db.waitReady;
  _query = (text, params) => db.query(text, params ?? []);
  _close = () => db.close();
  backend = 'pglite';
}

export async function query(text, params) {
  if (!_query) throw new Error('Database not initialized — call initDb() first');
  return _query(text, params);
}

export async function closeDb() {
  await _close();
}

export function dbBackend() {
  return backend;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  unit          TEXT NOT NULL DEFAULT 'lb',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exercises (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  muscle_group TEXT,
  equipment    TEXT,
  notes        TEXT,
  is_archived  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workouts (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  performed_on DATE NOT NULL DEFAULT CURRENT_DATE,
  title        TEXT,
  notes        TEXT,
  duration_min INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sets (
  id          SERIAL PRIMARY KEY,
  workout_id  INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  exercise_id INTEGER NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
  set_index   INTEGER NOT NULL DEFAULT 1,
  reps        INTEGER,
  weight      NUMERIC,
  unit        TEXT,
  rpe         NUMERIC,
  is_warmup   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goals (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  exercise_id  INTEGER REFERENCES exercises(id) ON DELETE CASCADE,
  title        TEXT,
  target_value NUMERIC NOT NULL,
  target_date  DATE,
  achieved_at  TIMESTAMPTZ,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS photos (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  taken_on    DATE NOT NULL DEFAULT CURRENT_DATE,
  image       BYTEA NOT NULL,
  mime        TEXT NOT NULL DEFAULT 'image/jpeg',
  bodyweight  NUMERIC,
  notes       TEXT,
  ai_analysis TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sets_workout   ON sets(workout_id);
CREATE INDEX IF NOT EXISTS idx_sets_exercise  ON sets(exercise_id);
CREATE INDEX IF NOT EXISTS idx_workouts_user  ON workouts(user_id, performed_on);
CREATE INDEX IF NOT EXISTS idx_exercises_user ON exercises(user_id);
CREATE INDEX IF NOT EXISTS idx_photos_user    ON photos(user_id, taken_on);
`;

// A friendly starter set of machine-focused exercises, added only on first run.
const STARTER_EXERCISES = [
  ['Leg Press', 'Legs', 'Machine'],
  ['Lat Pulldown', 'Back', 'Machine'],
  ['Chest Press', 'Chest', 'Machine'],
  ['Seated Cable Row', 'Back', 'Cable'],
  ['Leg Curl', 'Legs', 'Machine'],
  ['Shoulder Press', 'Shoulders', 'Machine'],
];

async function runMigrations() {
  // PGlite executes one statement per call; split on ';' for portability.
  for (const stmt of SCHEMA.split(';')) {
    const sql = stmt.trim();
    if (sql) await query(sql);
  }
}

async function seedUser() {
  const username = process.env.SEED_USERNAME || 'Robert';
  const password = process.env.SEED_PASSWORD || '1';

  const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (existing.rows.length > 0) return;

  const hash = bcrypt.hashSync(password, 10);
  const inserted = await query(
    'INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
    [username, hash, username]
  );
  const userId = inserted.rows[0].id;

  for (const [name, muscle, equipment] of STARTER_EXERCISES) {
    await query(
      'INSERT INTO exercises (user_id, name, muscle_group, equipment) VALUES ($1, $2, $3, $4)',
      [userId, name, muscle, equipment]
    );
  }
  console.log(`[db] seeded user "${username}" with ${STARTER_EXERCISES.length} starter exercises`);
}

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (url) {
    await initPostgres(url);
    console.log('[db] connected to Postgres');
  } else {
    await initPglite();
    console.log('[db] no DATABASE_URL set — using local PGlite database at ./.data');
  }
  await runMigrations();
  await seedUser();
}
