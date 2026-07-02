# 🏋️ Gym Tracker

A personal, installable **PWA** for tracking your gym life — the machines you use,
your workouts, sets/reps/weights, streaks, goals, progress charts, and progress
photos (with optional AI analysis). Data lives in a **Postgres database on Railway**,
so you can log in from any device and pick up where you left off.

Built to deploy on **GitHub → Railway** with zero build step.

---

## ✨ Features

- **Log in anywhere** — single account, long-lived session. You stay signed in until you sign out.
- **Machines & exercises** — add the equipment you actually use (muscle group, equipment type, notes); archive what you don't.
- **Fast workout logging** — start a session, add exercises, punch in sets (reps × weight). The add-set row pre-fills from your last set for speed. Warm-up flag supported.
- **History & workout detail** — every session, grouped by exercise, with total volume.
- **Progress** — per-exercise top-set and est. 1RM tracking, session-volume bars, weekly volume, and **personal records**.
- **Streaks** — consecutive-week training streak (an in-progress week never breaks it) plus your longest streak.
- **Goals** — weekly workout targets, total-workout milestones, or hit a target weight / estimated 1RM on a specific lift. Progress bars + a "reached" celebration.
- **Progress photos** — a visual timeline with bodyweight + notes. Optionally **analyze your progress with Claude vision** (gated behind an API key).
- **Installable PWA** — add to your home screen for a full-screen, offline-capable app that **auto-updates on launch** whenever you deploy a new version.
- **lb / kg** unit toggle, display name, and password change in Settings.

### 🌱 Beginner-friendly

- **Beginner Mode** (on by default) — swaps lifter jargon for plain language with a tap-to-read **(?)** explanation on each: *Estimated 1RM* → **Strength score (your estimated max)**, *Volume* → **Total weight lifted**, *Top set* → **Best set**. Turn it off in Settings to see the technical terms.
- **"Try next time" suggestions** — on the logging screen each exercise shows a gentle hint based on the **best set** of your last session (highest estimated max via Epley, never the fatigued final set), using 10–15 rep double progression: under 15 reps → same weight, one more rep; at 15+ → the machine's smallest weight increment up (inferred from your history, default +5 lb) with reps reset to 10. The hint pre-fills the next set (e.g. *"Last best set: 100 lb × 12 — try 100 lb × 13"*).
- **Plain-English progress** — the Progress screen translates your numbers into a sentence or two per exercise (e.g. *"You're getting stronger on Chest Press — up 15 lb since you started"*, *"You trained 3 times this week, same as last week"*).
- **Workout templates + "Today" guide** — **Push**, **Pull** and **Legs** templates (all pin-loaded machine movements) are seeded on first run and fully editable in **Settings → Workout templates** (rename, add/remove/**reorder** exercises, create your own). Assign any template — or rest — to each weekday under **Settings → My split** (default: Mon Push, Wed Legs, Fri Pull, Sun Legs). The Home screen shows a **Today** card with the planned exercises and a one-tap start (with a ✓ complete state once today is logged); rest days show a "recover up" message.
- **Start any template on any day** — every "Start a workout" button opens a picker (Push / Pull / Legs / custom / blank), so a make-up workout on a rest day is identical to a scheduled one: same title, same pre-loaded exercises, counted everywhere. Only workouts with at least one logged set count toward stats, streaks and Recent workouts — abandoned empty drafts don't pollute anything.
- **"This Week" schedule view** — a read-friendly weekly overview (**More → This week**, or the link on the Today card) with an **Up next** highlight, the whole week at a glance, today highlighted, and completed days checked off.

Default login: **`Robert` / `1`** (change the password any time in Settings).

---

## 🧱 Tech stack

| Layer    | Choice |
|----------|--------|
| Backend  | Node.js + Express (ES modules) |
| Database | PostgreSQL via `pg` (Railway). Local dev falls back to **PGlite** — a WASM Postgres — so there's nothing to install. |
| Auth     | JWT (long-lived) in `localStorage`, bcrypt password hashing |
| Frontend | Vanilla JS PWA — no build step, no framework. Custom dependency-free SVG charts. |
| AI       | Optional Claude vision via the official `@anthropic-ai/sdk` |

---

## 🚀 Deploy to Railway

1. **Push this repo to GitHub** (you're probably already here).

2. **Create a Railway project from the repo**
   - [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → pick this repository.
   - Railway auto-detects Node (Nixpacks) and uses `railway.json`: it runs `npm install`, starts with `node server/index.js`, and health-checks `/api/health`.

3. **Add a Postgres database**
   - In the project: **New → Database → Add PostgreSQL**.

4. **Set the service variables** (your app service → **Variables**):

   | Variable | Value |
   |----------|-------|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` — reference the Postgres service you just added |
   | `JWT_SECRET` | a long random string (e.g. `openssl rand -hex 48`) |
   | `ANTHROPIC_API_KEY` | *(optional)* enables AI progress-photo analysis |
   | `SEED_USERNAME` / `SEED_PASSWORD` | *(optional)* override the default `Robert` / `1` |

   You don't need to set `PORT` — Railway provides it.

5. **Deploy.** On boot the app creates its tables and seeds your user automatically. Open the generated domain, sign in, and **Add to Home Screen** to install it.

> **Updating:** push to GitHub → Railway redeploys. The service worker is versioned per deploy, so the installed PWA detects the new version and refreshes on next launch.

---

## 💻 Local development

No database setup required — without a `DATABASE_URL` the app uses a local PGlite file at `./.data`.

```bash
npm install
npm run dev          # http://localhost:3000  (auto-restarts on change)
```

Sign in with `Robert` / `1`. To mirror production locally, copy `.env.example` to `.env` and point `DATABASE_URL` at a real Postgres.

Run the frontend smoke test (jsdom):

```bash
npm test
```

Regenerate the app icons (pure Node, no tools needed):

```bash
npm run generate-icons
```

---

## 🔐 Environment variables

See [`.env.example`](./.env.example). Summary:

| Variable | Required | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | prod only | Postgres connection string. Empty locally → PGlite. |
| `JWT_SECRET` | recommended | Signs login tokens. Set a strong value in production. |
| `ANTHROPIC_API_KEY` | optional | Enables AI progress-photo analysis. |
| `ANTHROPIC_MODEL` | optional | Override the Claude model (defaults to the latest Opus). |
| `SEED_USERNAME` / `SEED_PASSWORD` | optional | Initial account (defaults `Robert` / `1`). |
| `PORT` | optional | Defaults to `3000`; Railway sets it automatically. |

---

## 📂 Project structure

```
server/
  index.js          Express app, routing, PWA service worker, SPA fallback
  db.js             pg / PGlite layer, migrations, user seeding
  auth.js           JWT + bcrypt
  ai.js             Optional Claude-vision photo analysis
  routes/           exercises · workouts · goals · stats · photos · account
public/
  index.html        App shell
  css/styles.css    Mobile-first dark theme
  js/               api · ui · charts · app (the SPA)
  manifest.webmanifest, icons/
scripts/
  generate-icons.js     PNG icon generator (zlib, no deps)
  smoke-frontend.mjs    jsdom smoke test
```

---

## 📝 Notes

- **Your data is stored in Railway Postgres**, not on the device — sign in anywhere.
- **Progress photos** are stored in the database and sent to Claude only when *you* tap "Analyze". With no API key, the feature is hidden and nothing is sent anywhere.
- This is a single-user app by design, but every record is scoped to the account, so it's straightforward to extend later.
