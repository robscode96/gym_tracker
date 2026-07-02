import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initDb, dbBackend, query } from './db.js';
import { authenticate, signToken, publicUser, authMiddleware } from './auth.js';
import { asyncH, bad } from './util.js';

import exercisesRouter from './routes/exercises.js';
import workoutsRouter from './routes/workouts.js';
import goalsRouter from './routes/goals.js';
import statsRouter from './routes/stats.js';
import photosRouter from './routes/photos.js';
import accountRouter from './routes/account.js';
import splitRouter from './routes/split.js';
import templatesRouter from './routes/templates.js';
import insightsRouter from './routes/insights.js';
import { serviceWorker } from './service-worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

// A build identifier that changes on each deploy so the PWA updates on launch.
const BUILD =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.BUILD_ID ||
  String(Date.now());

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

// ---- Public API ----
app.get('/api/health', (req, res) => res.json({ ok: true, version: BUILD.slice(0, 12), backend: dbBackend() }));
app.get('/api/version', (req, res) => res.json({ version: BUILD }));

app.post('/api/login', asyncH(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || password == null) return bad(res, 'Username and password are required');
  const user = await authenticate(String(username).trim(), String(password));
  if (!user) return res.status(401).json({ error: 'Invalid username or password' });
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// ---- Protected API ----
app.use('/api', authMiddleware, exercisesRouter, workoutsRouter, goalsRouter, statsRouter, photosRouter, accountRouter, splitRouter, templatesRouter, insightsRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---- PWA service worker (served from root scope, versioned per build) ----
app.get('/service-worker.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(serviceWorker(BUILD));
});

// ---- Static assets + SPA fallback ----
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ---- Error handler ----
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // Only honor a status we set intentionally (err.statusCode). Never relay a
  // third-party library's `.status` (e.g. the Anthropic SDK's 401) — doing so
  // would make the client think the user's session expired and sign them out.
  const status = err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`[server] Gym Tracker running on http://localhost:${PORT}  (build ${BUILD.slice(0, 12)})`);
  });
}

main().catch((err) => {
  console.error('[fatal] failed to start:', err);
  process.exit(1);
});
