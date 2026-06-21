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
  beginner_mode BOOLEAN NOT NULL DEFAULT TRUE,
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

ALTER TABLE users ADD COLUMN IF NOT EXISTS beginner_mode BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS split_days (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday           SMALLINT NOT NULL,
  title             TEXT,
  kind              TEXT NOT NULL DEFAULT 'workout',
  exercise_ids_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (user_id, weekday)
);
`;

// Default weekly split (pin-loaded machine movements).
const UPPER = ['Chest Press', 'Seated Row', 'Shoulder Press', 'Lat Pulldown', 'Bicep Curl', 'Tricep Pushdown'];
const LOWER = ['Leg Press', 'Leg Extension', 'Seated Leg Curl', 'Calf Raise', 'Hip Abduction'];

const EXERCISE_META = {
  'Chest Press': ['Chest', 'Machine'],
  'Seated Row': ['Back', 'Machine'],
  'Shoulder Press': ['Shoulders', 'Machine'],
  'Lat Pulldown': ['Back', 'Machine'],
  'Bicep Curl': ['Arms', 'Machine'],
  'Tricep Pushdown': ['Arms', 'Machine'],
  'Leg Press': ['Legs', 'Machine'],
  'Leg Extension': ['Legs', 'Machine'],
  'Seated Leg Curl': ['Legs', 'Machine'],
  'Calf Raise': ['Legs', 'Machine'],
  'Hip Abduction': ['Glutes', 'Machine'],
};

// Keyed by JS getDay() — 0=Sun .. 6=Sat.
const SPLIT_TEMPLATE = {
  0: { title: 'Lower', kind: 'workout', names: LOWER },
  1: { title: 'Upper', kind: 'workout', names: UPPER },
  2: { title: 'Rest (delivery route day)', kind: 'rest', names: [] },
  3: { title: 'Lower', kind: 'workout', names: LOWER },
  4: { title: 'Rest', kind: 'rest', names: [] },
  5: { title: 'Upper', kind: 'workout', names: UPPER },
  6: { title: 'Rest (delivery route day)', kind: 'rest', names: [] },
};

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
  await query(
    'INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3)',
    [username, hash, username]
  );
  console.log(`[db] seeded user "${username}"`);
}

async function findOrCreateExercise(userId, name) {
  const found = await query(
    'SELECT id FROM exercises WHERE user_id = $1 AND lower(name) = lower($2) ORDER BY id LIMIT 1',
    [userId, name]
  );
  if (found.rows.length) return found.rows[0].id;
  const [muscle, equipment] = EXERCISE_META[name] || [null, 'Machine'];
  const ins = await query(
    'INSERT INTO exercises (user_id, name, muscle_group, equipment) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, name, muscle, equipment]
  );
  return ins.rows[0].id;
}

// Seed the default weekly split for any user that doesn't have one yet.
// Runs for existing users too, creating any missing split exercises by name.
async function ensureSplitForUser(userId) {
  const has = await query('SELECT 1 FROM split_days WHERE user_id = $1 LIMIT 1', [userId]);
  if (has.rows.length) return;

  const ids = {};
  for (const name of new Set([...UPPER, ...LOWER])) ids[name] = await findOrCreateExercise(userId, name);

  for (let wd = 0; wd <= 6; wd++) {
    const def = SPLIT_TEMPLATE[wd];
    const exIds = def.names.map((n) => ids[n]);
    await query(
      `INSERT INTO split_days (user_id, weekday, title, kind, exercise_ids_json)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, wd, def.title, def.kind, JSON.stringify(exIds)]
    );
  }
  console.log(`[db] seeded default weekly split for user ${userId}`);
}

async function ensureSplits() {
  const users = await query('SELECT id FROM users');
  for (const u of users.rows) await ensureSplitForUser(u.id);
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
  await ensureSplits();
}
