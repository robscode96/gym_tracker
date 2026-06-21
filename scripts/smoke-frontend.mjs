import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const html = fs.readFileSync(path.resolve('public/index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', pretendToBeVisual: true });
const { window } = dom;

// Wire browser globals that app.js expects. (Node's built-in `navigator` is
// read-only and lacks serviceWorker — which is exactly what we want, so skip it.)
for (const k of ['window', 'document', 'localStorage', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'getComputedStyle']) {
  globalThis[k] = window[k];
}
if (!window.matchMedia) window.matchMedia = () => ({ matches: false });

// Seed a token so boot() takes the logged-in path.
window.localStorage.setItem('gym_token', 'fake.jwt.token');

const STATS = {
  totals: { workouts: 3, sets: 12, exercises: 6, volume: 18250, this_week: 1, last_workout: '2026-06-21' },
  streak: { current: 2, longest: 4, unit: 'week' },
  prs: [{ id: 3, name: 'Chest Press', max_weight: 175, best_1rm: 210 }],
  volume_by_week: [{ week: '2026-06-08', volume: 8200 }, { week: '2026-06-15', volume: 10050 }],
  workout_days: ['2026-06-15', '2026-06-21'],
};
const HISTORY = {
  exercise: { id: 3, name: 'Chest Press' },
  series: [{ date: '2026-06-08', top_weight: 135, est_1rm: 162, volume: 4050, top_reps: 10 },
           { date: '2026-06-21', top_weight: 175, est_1rm: 210, volume: 5100, top_reps: 6 }],
  pr: { max_weight: 175, best_1rm: 210 },
};
const ROUTES = {
  'GET /api/me': { user: { id: 1, username: 'Robert', display_name: 'Robert', unit: 'lb' } },
  'GET /api/ai/status': { enabled: false },
  'GET /api/stats': STATS,
  'GET /api/goals': [{ id: 1, kind: 'weekly_workouts', target_value: 4, current: 1, pct: 25, reached: false, is_active: true }],
  'GET /api/workouts': [{ id: 7, title: 'Push day', performed_on: '2026-06-21', exercise_count: 3, set_count: 12, volume: 6150 }],
  'GET /api/exercises?archived=1': [
    { id: 3, name: 'Chest Press', muscle_group: 'Chest', equipment: 'Machine', is_archived: false, set_count: 12, last_used: '2026-06-21' },
    { id: 4, name: 'Leg Press', muscle_group: 'Legs', equipment: 'Machine', is_archived: false, set_count: 0, last_used: null },
  ],
  'GET /api/exercises/3/history': HISTORY,
  'GET /api/version': { version: 'smoke-build' },
};

globalThis.fetch = async (url, opts = {}) => {
  const key = `${opts.method || 'GET'} ${url}`;
  const body = key in ROUTES ? ROUTES[key] : (url.includes('history') ? HISTORY : []);
  return {
    ok: true, status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
};
window.fetch = globalThis.fetch;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

await import(pathToFileURL(path.resolve('public/js/app.js')).href);
await tick(80);

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('  ok:', msg); }

const view = window.document.getElementById('view');
const main = window.document.getElementById('main');

console.log('--- Home ---');
assert(main.hidden === false, 'app shell shown after login');
assert(window.document.getElementById('login').hidden === true, 'login hidden');
assert(/Total workouts/.test(view.textContent), 'home shows stat tiles');
assert(/week.+streak|streak/.test(view.textContent), 'home shows streak');
assert(/Push day/.test(view.textContent), 'home shows recent workout');
assert(window.document.querySelector('.tab.active')?.dataset.tab === 'home', 'home tab active');

console.log('--- Progress (charts) ---');
window.document.querySelector('[data-tab="progress"]').click();
await tick(80);
assert(view.querySelector('svg.chart') !== null, 'progress renders an SVG chart');
assert(view.querySelector('path.line') !== null, 'progress line chart drawn');
assert(/Personal records/.test(view.textContent), 'progress shows PRs');

console.log('--- Photos (AI off) ---');
window.document.querySelector('[data-tab="photos"]').click();
await tick(60);
assert(/ANTHROPIC_API_KEY/.test(view.textContent), 'photos shows AI-disabled hint');

console.log('--- More + Settings ---');
window.document.querySelector('[data-tab="more"]').click();
await tick(40);
assert(/Machines & Exercises/.test(view.textContent), 'more menu renders');

console.log(process.exitCode ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
