import { api, getToken, setToken } from './api.js';
import {
  h, clear, toast, sheet, confirmDialog, fmtDate, relDay, daysAgo,
  todayISO, fmtNum, fmtCompact, loading, empty,
} from './ui.js';
import { lineChart, barChart } from './charts.js';

/* ============================ Service worker / auto-update ============================ */
if ('serviceWorker' in navigator) {
  let hadController = !!navigator.serviceWorker.controller;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; } // first install — don't reload
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then((reg) => reg.update())
      .catch(() => {});
  });
}

/* ============================ State & element refs ============================ */
let user = null;
let exercisesCache = null;
let aiStatus = { enabled: false };
let current = { view: 'home', params: {} };
let session = { workoutId: null, exerciseIds: [] }; // local logger state

const DRAFT_KEY = 'gym_active_workout';
const $ = (id) => document.getElementById(id);
const els = {};
const RENDER = {}; // view name -> async render function

const TITLES = {
  home: 'Home', log: 'Workout', progress: 'Progress', photos: 'Photos', more: 'More',
  exercises: 'Machines & Exercises', goals: 'Goals', settings: 'Settings', about: 'About', workout: 'Workout',
  schedule: 'This Week',
};
const TAB_OF = {
  home: 'home', log: 'log', progress: 'progress', photos: 'photos', more: 'more',
  exercises: 'more', goals: 'more', settings: 'more', about: 'more', workout: 'log',
  schedule: 'more',
};

const unit = () => (user && user.unit) || 'lb';

/* ============================ Beginner-mode terminology ============================ */
const TERMS = {
  one_rm: {
    tech: 'Estimated 1RM', short_tech: 'Est. 1RM',
    plain: 'Strength score (your estimated max)', short: 'Strength score',
    help: 'An estimate of the most weight you could lift for a single rep, worked out from your reps and weight.',
  },
  volume: {
    tech: 'Volume', plain: 'Total weight lifted',
    help: 'Reps multiplied by weight, added up across the session — a measure of how much total work you did.',
  },
  top_set: {
    tech: 'Top set', plain: 'Best set',
    help: 'Your heaviest work set — the most weight you lifted for the reps that day.',
  },
};
const beginnerOn = () => !user || user.beginner_mode !== false;
const termText = (k) => (beginnerOn() ? TERMS[k].plain : TERMS[k].tech);
const termShort = (k) => (beginnerOn() ? (TERMS[k].short || TERMS[k].plain) : (TERMS[k].short_tech || TERMS[k].tech));
function helpDot(k) {
  return h('span', {
    class: 'help', role: 'button', tabindex: '0', title: 'What does this mean?',
    onClick: (e) => { e.stopPropagation(); e.preventDefault(); sheet({ title: termText(k), body: h('p', { class: 'muted' }, TERMS[k].help) }); },
  }, '?');
}
function metric(k, trailing) {
  return h('span', { class: 'metric' }, termText(k), trailing ? ' ' + trailing : null, helpDot(k));
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dayName = (wd) => DAY_NAMES[wd] || '';

/* ============================ Boot & auth ============================ */
function showApp() { els.login.hidden = true; els.main.hidden = false; }
function showLogin() { els.main.hidden = true; els.login.hidden = false; }

async function afterLogin() {
  try { aiStatus = await api.get('/ai/status'); } catch { aiStatus = { enabled: false }; }
  showApp();
  navigate('home', {}, { replace: true });
}

async function boot() {
  Object.assign(els, {
    login: $('login'), main: $('main'), view: $('view'), viewTitle: $('viewTitle'),
    backBtn: $('backBtn'), tabbar: $('tabbar'), loginForm: $('loginForm'),
    loginError: $('loginError'), loginBtn: $('loginBtn'),
  });

  els.loginForm.addEventListener('submit', onLogin);
  els.backBtn.addEventListener('click', () => window.history.back());
  els.tabbar.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.tab));
  });
  window.addEventListener('popstate', (e) => {
    if (els.main.hidden) return;
    current = e.state || { view: 'home', params: {} };
    renderCurrent();
  });
  window.addEventListener('auth:expired', () => { user = null; showLogin(); toast('Signed out', 'err'); });

  const token = getToken();
  if (token) {
    try {
      const me = await api.get('/me');
      user = me.user;
      await afterLogin();
      return;
    } catch { setToken(null); }
  }
  showLogin();
}

async function onLogin(e) {
  e.preventDefault();
  els.loginError.hidden = true;
  els.loginBtn.disabled = true;
  els.loginBtn.textContent = 'Signing in…';
  try {
    const username = $('username').value.trim();
    const password = $('password').value;
    const { token, user: u } = await api.login(username, password);
    setToken(token);
    user = u;
    $('password').value = '';
    await afterLogin();
  } catch (err) {
    els.loginError.textContent = err.message || 'Sign in failed';
    els.loginError.hidden = false;
  } finally {
    els.loginBtn.disabled = false;
    els.loginBtn.textContent = 'Sign in';
  }
}

function signOut() {
  setToken(null);
  user = null;
  exercisesCache = null;
  showLogin();
}

/* ============================ Router ============================ */
function setActiveTab(tab) {
  els.tabbar.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
}

function navigate(view, params = {}, { replace = false } = {}) {
  current = { view, params };
  const st = { view, params };
  if (replace) window.history.replaceState(st, '');
  else window.history.pushState(st, '');
  renderCurrent();
}

function refresh() { renderCurrent(false); }

async function renderCurrent(spinner = true) {
  const v = current.view;
  els.viewTitle.textContent = TITLES[v] || 'Gym';
  setActiveTab(TAB_OF[v]);
  els.backBtn.hidden = TAB_OF[v] === v;
  if (spinner) { clear(els.view); els.view.appendChild(loading()); els.view.scrollTop = 0; }
  try {
    const node = await RENDER[v](current.params);
    clear(els.view);
    els.view.appendChild(node);
    if (spinner) els.view.scrollTop = 0;
  } catch (err) {
    clear(els.view);
    els.view.appendChild(errorNote(err.message));
  }
}

/* ============================ Shared builders ============================ */
function errorNote(msg) {
  return h('div', { class: 'empty' },
    h('div', { class: 'em-ico' }, '⚠️'),
    h('p', null, msg || 'Something went wrong'),
    h('button', { class: 'btn btn-sm', onClick: () => refresh() }, 'Retry'));
}

function statTile(num, lbl, suffix) {
  return h('div', { class: 'stat' },
    h('div', { class: 'num' }, String(num), suffix ? h('small', null, ' ' + suffix) : null),
    h('div', { class: 'lbl' }, lbl));
}

function row({ title, sub, meta, onClick, chev = true, badge }) {
  return h('button', { class: 'row', onClick: onClick || null },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, title, badge ? ' ' : null, badge || null),
      sub ? h('div', { class: 'row-sub' }, sub) : null),
    meta ? h('div', { class: 'row-meta' }, meta) : null,
    chev && onClick ? h('div', { class: 'chev' }, '›') : null);
}

function sectionHead(title, actionLabel, onAction) {
  return h('div', { class: 'section-head' },
    h('h3', null, title),
    onAction ? h('button', { class: 'btn btn-sm', onClick: onAction }, actionLabel) : null);
}

function field(labelText, inputEl) {
  return h('label', null, h('span', null, labelText), inputEl);
}

async function getExercises(force) {
  if (!exercisesCache || force) exercisesCache = await api.get('/exercises?archived=1');
  return exercisesCache;
}
const activeExercises = () => (exercisesCache || []).filter((e) => !e.is_archived);

/* ============================ HOME ============================ */
RENDER.home = async function () {
  const [stats, goals, workouts, split] = await Promise.all([
    api.get('/stats'), api.get('/goals'), api.get('/workouts'), api.get('/split').catch(() => null),
  ]);
  const wrap = h('div', null);

  const name = (user.display_name || user.username || '').split(' ')[0];
  wrap.appendChild(h('div', { style: { margin: '2px 2px 14px' } },
    h('h3', { style: { fontSize: '22px' } }, `Hey ${name} 👋`),
    h('div', { class: 'muted tiny' }, new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))));

  // Today's plan (from the weekly split)
  if (split && split.length) {
    const day = split.find((d) => d.weekday === new Date().getDay());
    if (day) {
      // "Done today?" is evaluated in the user's LOCAL date. Workouts are stored
      // with the local calendar date they were started on (see todayISO()), and we
      // read from the same /workouts table that feeds the stats counters + streak,
      // so completion stays consistent. Slicing handles both 'YYYY-MM-DD' (PGlite)
      // and ISO 'YYYY-MM-DDT…Z' (pg) shapes. Only workouts with logged sets count
      // (an abandoned empty draft isn't a completed workout).
      const todayStr = todayISO();
      const todayDone = workouts.some((w) => w.set_count > 0 && String(w.performed_on).slice(0, 10) === todayStr);
      wrap.appendChild(todayCard(day, todayDone));
    }
  }

  // Streak
  const st = stats.streak || { current: 0, longest: 0 };
  wrap.appendChild(h('div', { class: 'streak' },
    h('div', { class: 'flame' }, st.current > 0 ? '🔥' : '💤'),
    h('div', { class: 'grow' },
      h('div', null, h('span', { class: 'big' }, String(st.current)), ' week', st.current === 1 ? '' : 's', ' streak'),
      h('div', { class: 'muted tiny' }, st.longest ? `Longest: ${st.longest} week${st.longest === 1 ? '' : 's'}` : 'Train this week to start a streak')),
  ));

  // Stat tiles
  const t = stats.totals;
  wrap.appendChild(h('div', { class: 'stats' },
    statTile(t.this_week, 'This week'),
    statTile(t.workouts, 'Total workouts'),
    statTile(fmtCompact(t.volume), metric('volume'), unit()),
    statTile(t.exercises, 'Machines'),
  ));

  // Quick start (picks a template — Push / Pull / Legs — or blank)
  const draftId = localStorage.getItem(DRAFT_KEY);
  wrap.appendChild(h('div', { style: { margin: '14px 0' } },
    h('button', { class: 'btn btn-primary btn-block', onClick: () => (draftId ? navigate('log') : openStartPicker()) },
      draftId ? '▶︎ Continue workout' : '＋ Start a workout')));

  // Active goals (top 3)
  const active = goals.filter((g) => g.is_active).slice(0, 3);
  if (active.length) {
    wrap.appendChild(sectionHead('Goals', 'All', () => navigate('goals')));
    const c = h('div', { class: 'stack' });
    active.forEach((g) => c.appendChild(goalCard(g)));
    wrap.appendChild(c);
  }

  // Recent workouts — only sessions with logged sets (empty abandoned drafts
  // would otherwise crowd real workouts out of this window); the active draft
  // stays visible so it can be resumed.
  const recent = workouts.filter((w) => w.set_count > 0 || String(w.id) === draftId);
  wrap.appendChild(sectionHead('Recent workouts', workouts.length ? 'History' : null, workouts.length ? () => navigate('log') : null));
  if (!recent.length) {
    wrap.appendChild(empty('🏋️', 'No workouts logged yet.', h('button', { class: 'btn btn-primary', onClick: () => openStartPicker() }, 'Log your first workout')));
  } else {
    const list = h('div', null);
    recent.slice(0, 5).forEach((w) => list.appendChild(workoutRow(w)));
    wrap.appendChild(list);
  }
  return wrap;
};

function workoutRow(w) {
  const title = w.title || 'Workout';
  const sub = `${w.exercise_count} exercise${w.exercise_count === 1 ? '' : 's'} · ${w.set_count} set${w.set_count === 1 ? '' : 's'} · ${fmtCompact(w.volume)} ${unit()}`;
  return row({ title, sub, meta: relDay(w.performed_on), onClick: () => navigate('workout', { id: w.id }) });
}

function goalCard(g) {
  const isCount = g.kind === 'weekly_workouts' || g.kind === 'total_workouts';
  const cur = isCount ? g.current : `${fmtNum(g.current)} ${unit()}`;
  const tgt = isCount ? g.target_value : `${fmtNum(g.target_value)} ${unit()}`;
  return h('button', { class: 'card', style: { width: '100%', textAlign: 'left', margin: '0' }, onClick: () => openGoalActions(g) },
    h('div', { class: 'row-between' },
      h('div', { class: 'row-title' }, goalLabel(g)),
      g.reached ? h('span', { class: 'badge green' }, '✓ Reached') : h('span', { class: 'muted tiny' }, `${cur} / ${tgt}`)),
    h('div', { class: 'bar' + (g.reached ? ' done' : '') }, h('span', { style: { width: g.pct + '%' } })));
}

function goalLabel(g) {
  if (g.title) return g.title;
  switch (g.kind) {
    case 'weekly_workouts': return `${g.target_value} workouts / week`;
    case 'total_workouts': return `${g.target_value} total workouts`;
    case 'exercise_weight': return `${g.exercise_name}: ${fmtNum(g.target_value)} ${unit()}`;
    case 'exercise_1rm': return `${g.exercise_name}: ${fmtNum(g.target_value)} ${unit()} ${beginnerOn() ? 'strength score' : '1RM'}`;
    default: return 'Goal';
  }
}

function todayCard(day, todayDone) {
  const card = h('div', { class: 'card today' });
  card.appendChild(h('div', { class: 'row-between' },
    h('div', { class: 'kicker' }, `Today · ${dayName(day.weekday)}`),
    h('button', { class: 'linklike', style: { width: 'auto', margin: '0' }, onClick: () => navigate('schedule') }, 'This week →')));

  if (day.kind === 'rest' || !day.exercises.length) {
    card.appendChild(h('div', { class: 'rest-msg' }, '😴 Rest day — recover up.'));
    if (day.title && !/^rest$/i.test(day.title)) card.appendChild(h('div', { class: 'muted tiny' }, day.title));
    card.appendChild(h('button', { class: 'linklike', onClick: () => (localStorage.getItem(DRAFT_KEY) ? navigate('log') : openStartPicker()) },
      localStorage.getItem(DRAFT_KEY) ? '▶︎ Continue workout' : 'Start a workout anyway'));
    return card;
  }

  card.appendChild(h('h3', { style: { marginTop: '2px' } }, day.title || 'Workout'));
  const chips = h('div', { class: 'today-chips' });
  day.exercises.forEach((e) => chips.appendChild(h('span', { class: 'today-chip' }, e.name)));
  card.appendChild(chips);

  const label = day.title || "today's";
  const draftId = localStorage.getItem(DRAFT_KEY);
  if (draftId) {
    // Mid-session takes priority over "complete" (an in-progress workout is dated today too).
    card.appendChild(h('button', { class: 'btn btn-primary btn-block', onClick: () => navigate('log') }, '▶︎ Continue workout'));
  } else if (todayDone) {
    card.appendChild(h('div', { class: 'done-banner' }, `✓ ${day.title || 'Today’s'} workout complete`));
    card.appendChild(h('button', { class: 'linklike', onClick: () => openStartPicker() }, 'Log another'));
  } else {
    card.appendChild(h('button', { class: 'btn btn-primary btn-block', onClick: () => startTodayWorkout(day) }, `Start ${label} workout`));
  }
  return card;
}

// Start a workout pre-populated from a template (or a scheduled day, which
// carries the same {name/title, exercises} shape). Every start path goes
// through here or startWorkout so the created rows are structurally identical.
async function startWorkoutFromTemplate(tpl) {
  try {
    const w = await api.post('/workouts', { performed_on: todayISO(), title: tpl.name || tpl.title || null });
    localStorage.setItem(DRAFT_KEY, String(w.id));
    session = { workoutId: w.id, exerciseIds: (tpl.exercises || []).map((e) => e.id) };
    navigate('log');
  } catch (err) { toast(err.message, 'err'); }
}

function startTodayWorkout(day) {
  return startWorkoutFromTemplate(day);
}

// Pick a saved template (Push / Pull / Legs / custom) — or a blank workout —
// and start it today, regardless of what the schedule says.
async function openStartPicker() {
  if (localStorage.getItem(DRAFT_KEY)) { navigate('log'); return; }
  let templates = [];
  try { templates = await api.get('/templates'); } catch { templates = []; }
  const body = h('div', { class: 'stack' });
  templates.forEach((t) => body.appendChild(h('button', { class: 'row', style: { margin: '0' }, onClick: () => { s.close(); startWorkoutFromTemplate(t); } },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, t.name),
      h('div', { class: 'row-sub' }, t.exercises.map((e) => e.name).join(', ') || 'No exercises yet')),
    h('div', { class: 'chev' }, '›'))));
  body.appendChild(h('button', { class: 'btn btn-block', onClick: () => { s.close(); startWorkout(); } }, 'Blank workout'));
  const s = sheet({ title: 'Start a workout', body });
}

/* ============================ LOG / WORKOUT LOGGER ============================ */
async function startWorkout() {
  try {
    const w = await api.post('/workouts', { performed_on: todayISO() });
    localStorage.setItem(DRAFT_KEY, String(w.id));
    session = { workoutId: w.id, exerciseIds: [] };
    navigate('log');
  } catch (err) { toast(err.message, 'err'); }
}

RENDER.log = async function () {
  const draftId = localStorage.getItem(DRAFT_KEY);
  if (!draftId) return logHome();

  let workout;
  try {
    workout = await api.get('/workouts/' + draftId);
  } catch {
    localStorage.removeItem(DRAFT_KEY);
    return logHome();
  }
  await getExercises();
  if (session.workoutId !== workout.id) session = { workoutId: workout.id, exerciseIds: [] };

  // Exercises in this session = those with sets + locally added
  const byEx = new Map();
  workout.sets.forEach((s) => {
    if (!byEx.has(s.exercise_id)) byEx.set(s.exercise_id, []);
    byEx.get(s.exercise_id).push(s);
  });
  // Session (template) order first so exercises stay in the order you planned.
  const exIds = [...new Set([...session.exerciseIds, ...byEx.keys()])];

  // "Try next time" suggestions (based on the previous session, not this draft).
  const suggestions = {};
  await Promise.all(exIds.map(async (exId) => {
    try { suggestions[exId] = await api.get(`/exercises/${exId}/suggestion?exclude=${workout.id}`); }
    catch { suggestions[exId] = { has: false }; }
  }));

  const wrap = h('div', null);
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'row-between' },
      h('input', { id: 'wkTitle', placeholder: 'Workout title (optional)', value: workout.title || '', class: 'grow',
        onchange: (e) => api.patch('/workouts/' + workout.id, { title: e.target.value.trim() || null }).catch(() => {}) })),
    h('div', { class: 'muted tiny', style: { marginTop: '8px' } }, fmtDate(workout.performed_on, { weekday: true, year: true }))));

  if (!exIds.length) {
    wrap.appendChild(empty('💪', 'Add an exercise to start logging sets.'));
  }

  exIds.forEach((exId) => {
    const ex = (exercisesCache || []).find((e) => e.id === exId);
    const sets = (byEx.get(exId) || []).sort((a, b) => a.set_index - b.set_index);
    wrap.appendChild(exerciseBlock(workout.id, ex, sets, suggestions[exId]));
  });

  wrap.appendChild(h('button', { class: 'btn btn-block', style: { marginTop: '4px' }, onClick: () => pickExerciseSheet(workout.id) }, '＋ Add exercise'));

  wrap.appendChild(h('div', { class: 'divider' }));
  wrap.appendChild(h('div', { class: 'grid-2' },
    h('button', { class: 'btn btn-danger', onClick: () => discardWorkout(workout.id) }, 'Discard'),
    h('button', { class: 'btn btn-primary', onClick: () => finishWorkout(workout) }, '✓ Finish')));
  return wrap;
};

function exerciseBlock(workoutId, ex, sets, suggestion) {
  const last = sets[sets.length - 1];
  const block = h('div', { class: 'ex-block' });
  block.appendChild(h('h4', null,
    h('span', null, ex ? ex.name : 'Exercise'),
    ex && ex.equipment ? h('span', { class: 'badge' }, ex.equipment) : null));

  // Gentle "try next time" hint, anchored on the BEST set of the last session.
  if (suggestion && suggestion.has) {
    const L = suggestion.last, S = suggestion.suggestion;
    block.appendChild(h('div', { class: 'hint' },
      `Last best set: ${fmtNum(L.weight)} ${unit()} × ${L.reps} — try ${fmtNum(S.weight)} ${unit()} × ${S.reps}`));
  }

  sets.forEach((s, i) => {
    block.appendChild(h('div', { class: 'set-line' },
      h('div', { class: 'idx' }, String(i + 1)),
      h('div', { class: 'muted', style: { gridColumn: 'span 2' } },
        `${fmtNum(s.reps)} reps × ${fmtNum(s.weight)} ${s.unit || unit()}`, s.is_warmup ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'warmup') : null),
      h('button', { class: 'del', title: 'Delete set', onClick: () => deleteSet(s.id) }, '×')));
  });

  // Add-set row — prefill from this session's last set, else the suggestion.
  let preReps = last ? fmtNum(last.reps) : '';
  let preWt = last ? fmtNum(last.weight) : '';
  if (!last && suggestion && suggestion.has) {
    preReps = String(suggestion.suggestion.reps);
    preWt = fmtNum(suggestion.suggestion.weight);
  }
  const reps = h('input', { inputmode: 'numeric', placeholder: 'reps', value: preReps });
  const wt = h('input', { inputmode: 'decimal', placeholder: unit(), value: preWt });
  const add = async () => {
    const r = parseFloat(reps.value), w = parseFloat(wt.value);
    if (!reps.value && !wt.value) { toast('Enter reps and weight', 'err'); return; }
    try {
      await api.post(`/workouts/${workoutId}/sets`, { exercise_id: ex.id, reps: isNaN(r) ? null : r, weight: isNaN(w) ? null : w, unit: unit() });
      refresh();
    } catch (err) { toast(err.message, 'err'); }
  };
  reps.addEventListener('keydown', (e) => { if (e.key === 'Enter') wt.focus(); });
  wt.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  block.appendChild(h('div', { class: 'set-line' },
    h('div', { class: 'idx' }, '＋'), reps, wt,
    h('button', { class: 'btn btn-sm btn-primary', onClick: add }, 'Add')));
  return block;
}

function pickExerciseSheet(workoutId) {
  const list = activeExercises();
  const body = h('div', { class: 'stack' });
  body.appendChild(h('button', { class: 'btn btn-block', onClick: () => { s.close(); openExerciseForm(null, (created) => addExerciseToSession(workoutId, created.id)); } }, '＋ New machine / exercise'));
  if (!list.length) body.appendChild(h('p', { class: 'muted tiny center' }, 'No exercises yet — create one above.'));
  const grp = h('div', { class: 'pill-grp', style: { marginTop: '6px' } });
  list.forEach((ex) => grp.appendChild(h('button', { class: 'pill', onClick: () => { s.close(); addExerciseToSession(workoutId, ex.id); } }, ex.name)));
  body.appendChild(grp);
  const s = sheet({ title: 'Add exercise', body });
}

function addExerciseToSession(workoutId, exId) {
  if (session.workoutId !== workoutId) session = { workoutId, exerciseIds: [] };
  if (!session.exerciseIds.includes(exId)) session.exerciseIds.push(exId);
  refresh();
}

async function deleteSet(id) {
  try { await api.del('/sets/' + id); refresh(); } catch (err) { toast(err.message, 'err'); }
}

function finishWorkout(workout) {
  const dur = h('input', { inputmode: 'numeric', placeholder: 'minutes (optional)', value: workout.duration_min || '' });
  const notes = h('textarea', { placeholder: 'How did it go? (optional)' }, workout.notes || '');
  const save = async () => {
    try {
      await api.patch('/workouts/' + workout.id, {
        duration_min: dur.value ? parseInt(dur.value, 10) : null,
        notes: notes.value.trim() || null,
      });
      localStorage.removeItem(DRAFT_KEY);
      session = { workoutId: null, exerciseIds: [] };
      s.close();
      toast('Workout saved 💪', 'ok');
      navigate('home', {}, { replace: true });
    } catch (err) { toast(err.message, 'err'); }
  };
  const body = h('div', { class: 'stack' },
    field('Duration', dur), field('Notes', notes),
    h('button', { class: 'btn btn-primary btn-block', onClick: save }, 'Finish & save'));
  const s = sheet({ title: 'Finish workout', body });
}

async function discardWorkout(id) {
  if (!(await confirmDialog('Discard this workout and all its sets?', { danger: true, okText: 'Discard' }))) return;
  try {
    await api.del('/workouts/' + id);
    localStorage.removeItem(DRAFT_KEY);
    session = { workoutId: null, exerciseIds: [] };
    toast('Discarded');
    navigate('home', {}, { replace: true });
  } catch (err) { toast(err.message, 'err'); }
}

async function logHome() {
  const workouts = await api.get('/workouts');
  const wrap = h('div', null);
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, 'New session'),
    h('button', { class: 'btn btn-primary btn-block', onClick: () => openStartPicker() }, '＋ Start a workout')));

  wrap.appendChild(sectionHead('History'));
  if (!workouts.length) {
    wrap.appendChild(empty('📭', 'Your logged workouts will appear here.'));
  } else {
    const list = h('div', null);
    workouts.forEach((w) => list.appendChild(workoutRow(w)));
    wrap.appendChild(list);
  }
  return wrap;
}

/* ============================ WORKOUT DETAIL ============================ */
RENDER.workout = async function ({ id }) {
  const w = await api.get('/workouts/' + id);
  const wrap = h('div', null);

  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'row-between' },
      h('div', null,
        h('h3', null, w.title || 'Workout'),
        h('div', { class: 'muted tiny', style: { marginTop: '2px' } }, fmtDate(w.performed_on, { weekday: true, year: true }), w.duration_min ? ` · ${w.duration_min} min` : '')),
      h('button', { class: 'btn btn-sm', onClick: () => editWorkoutMeta(w) }, 'Edit')),
    w.notes ? h('p', { class: 'muted', style: { marginTop: '10px', whiteSpace: 'pre-wrap' } }, w.notes) : null));

  const byEx = new Map();
  w.sets.forEach((s) => { if (!byEx.has(s.exercise_id)) byEx.set(s.exercise_id, { name: s.exercise_name, equipment: s.equipment, sets: [] }); byEx.get(s.exercise_id).sets.push(s); });

  if (!byEx.size) {
    wrap.appendChild(empty('🤷', 'No sets logged in this workout.'));
  } else {
    [...byEx.values()].forEach((g) => {
      const block = h('div', { class: 'ex-block' });
      block.appendChild(h('h4', null, h('span', null, g.name), g.equipment ? h('span', { class: 'badge' }, g.equipment) : null));
      g.sets.sort((a, b) => a.set_index - b.set_index).forEach((s, i) => {
        block.appendChild(h('div', { class: 'set-line' },
          h('div', { class: 'idx' }, String(i + 1)),
          h('div', { style: { gridColumn: 'span 3' } }, `${fmtNum(s.reps)} × ${fmtNum(s.weight)} ${s.unit || unit()}`, s.is_warmup ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'warmup') : null)));
      });
      wrap.appendChild(block);
    });
  }

  wrap.appendChild(h('div', { class: 'grid-2', style: { marginTop: '6px' } },
    h('button', { class: 'btn', onClick: () => { localStorage.setItem(DRAFT_KEY, String(w.id)); session = { workoutId: w.id, exerciseIds: [] }; navigate('log'); } }, 'Continue logging'),
    h('button', { class: 'btn btn-danger', onClick: () => deleteWorkout(w.id) }, 'Delete')));
  return wrap;
};

function editWorkoutMeta(w) {
  const title = h('input', { value: w.title || '', placeholder: 'Title' });
  const date = h('input', { type: 'date', value: (w.performed_on || '').slice(0, 10) });
  const dur = h('input', { inputmode: 'numeric', value: w.duration_min || '', placeholder: 'minutes' });
  const notes = h('textarea', { placeholder: 'Notes' }, w.notes || '');
  const save = async () => {
    try {
      await api.patch('/workouts/' + w.id, {
        title: title.value.trim() || null, performed_on: date.value || w.performed_on,
        duration_min: dur.value ? parseInt(dur.value, 10) : null, notes: notes.value.trim() || null,
      });
      s.close(); refresh();
    } catch (err) { toast(err.message, 'err'); }
  };
  const s = sheet({ title: 'Edit workout', body: h('div', { class: 'stack' },
    field('Title', title), field('Date', date), field('Duration (min)', dur), field('Notes', notes),
    h('button', { class: 'btn btn-primary btn-block', onClick: save }, 'Save')) });
}

async function deleteWorkout(id) {
  if (!(await confirmDialog('Delete this workout permanently?', { danger: true, okText: 'Delete' }))) return;
  try {
    await api.del('/workouts/' + id);
    if (localStorage.getItem(DRAFT_KEY) === String(id)) localStorage.removeItem(DRAFT_KEY);
    toast('Deleted');
    window.history.back();
  } catch (err) { toast(err.message, 'err'); }
}

/* ============================ PROGRESS ============================ */
RENDER.progress = async function (params) {
  const [stats, exercises, insights] = await Promise.all([
    api.get('/stats'), getExercises(), api.get('/insights').catch(() => null),
  ]);
  const wrap = h('div', null);

  // Plain-English summaries
  if (insights) {
    const card = h('div', { class: 'card' });
    card.appendChild(h('div', { class: 'card-title' }, 'In plain English'));
    card.appendChild(h('p', { class: 'insight' }, weekSentence(insights.week)));
    insights.exercises.slice(0, 4).forEach((e) => card.appendChild(h('p', { class: 'insight' }, exSentence(e))));
    wrap.appendChild(card);
  }

  // Weekly volume
  if (stats.volume_by_week && stats.volume_by_week.length) {
    wrap.appendChild(h('div', { class: 'card' },
      h('div', { class: 'card-title' }, metric('volume', '(' + unit() + ')')),
      barChart(stats.volume_by_week.map((p) => ({ label: fmtDate(p.week), value: p.volume })))));
  }

  // Personal records
  if (stats.prs && stats.prs.length) {
    wrap.appendChild(sectionHead('Personal records'));
    const list = h('div', null);
    stats.prs.forEach((p) => list.appendChild(row({
      title: p.name,
      sub: `${termShort('one_rm')} ${fmtNum(p.best_1rm)} ${unit()}`,
      meta: `${fmtNum(p.max_weight)} ${unit()}`,
      onClick: () => navigate('progress', { ex: p.id }),
      chev: false,
    })));
    wrap.appendChild(list);
  }

  // Per-exercise chart
  const withData = (exercises || []).filter((e) => e.set_count > 0);
  wrap.appendChild(sectionHead('Exercise progress'));
  if (!withData.length) {
    wrap.appendChild(empty('📈', 'Log some sets to see progress charts.'));
    return wrap;
  }
  const selId = Number(params.ex) || withData[0].id;
  const select = h('select', { onchange: (e) => navigate('progress', { ex: Number(e.target.value) }, { replace: true }) },
    ...withData.map((e) => h('option', { value: e.id, selected: e.id === selId }, e.name)));
  wrap.appendChild(h('div', { class: 'card' }, field('Exercise', select), h('div', { id: 'exChart' }, loading())));

  api.get(`/exercises/${selId}/history`).then((hist) => {
    const box = $('exChart');
    if (!box) return;
    clear(box);
    if (!hist.series.length) { box.appendChild(empty('—', 'No data yet')); return; }
    box.appendChild(h('div', { class: 'row-between', style: { margin: '4px 0 10px' } },
      h('span', { class: 'badge amber' }, `PR ${fmtNum(hist.pr.max_weight)} ${unit()}`),
      h('span', { class: 'badge' }, `${termShort('one_rm')} ${fmtNum(hist.pr.best_1rm)} ${unit()} `, helpDot('one_rm'))));
    box.appendChild(h('div', { class: 'card-title' }, metric('top_set', 'weight')));
    box.appendChild(lineChart(hist.series.filter((p) => p.top_weight != null).map((p) => ({ label: fmtDate(p.date), value: p.top_weight }))));
    box.appendChild(h('div', { class: 'card-title', style: { marginTop: '14px' } }, h('span', null, termText('volume'), ' · per session')));
    box.appendChild(barChart(hist.series.slice(-12).map((p) => ({ label: fmtDate(p.date), value: p.volume }))));
  }).catch((err) => { const box = $('exChart'); if (box) { clear(box); box.appendChild(errorNote(err.message)); } });

  return wrap;
};

function weekSentence(week) {
  const t = week.this, l = week.last;
  if (t === 0 && l === 0) return 'No workouts logged yet this week — your first one starts a streak.';
  let s = `You trained ${t} time${t === 1 ? '' : 's'} this week`;
  if (t > l) s += l > 0 ? `, up from ${l} last week 💪` : ' — nice start! 💪';
  else if (t === l) s += ', same as last week.';
  else s += `, ${l} last week — let's catch up.`;
  return s.endsWith('.') || s.endsWith('💪') ? s : s + '.';
}

function exSentence(e) {
  const u = unit();
  if (e.sessions <= 1) return `First session logged for ${e.name} — nice start!`;
  if (e.delta > 0) return `You're getting stronger on ${e.name} — up ${fmtNum(e.delta)} ${u} since you started.`;
  if (e.delta === 0) return `Holding steady on ${e.name} — same best set as when you started. Try one more rep next time.`;
  return `${e.name} dipped a little from your best — totally normal, just keep showing up.`;
}

/* ============================ PHOTOS ============================ */
let photoSelect = null; // Set of ids when selecting

RENDER.photos = async function () {
  const photos = await api.get('/photos');
  const wrap = h('div', null);

  wrap.appendChild(h('div', { class: 'row-between', style: { marginBottom: '12px' } },
    h('button', { class: 'btn btn-primary', onClick: addPhoto }, '＋ Add photo'),
    photos.length ? h('button', { class: 'btn btn-sm', onClick: () => { photoSelect = photoSelect ? null : new Set(); refresh(); } }, photoSelect ? 'Cancel' : 'Select') : null));

  if (aiStatus.enabled && photoSelect) {
    wrap.appendChild(h('div', { class: 'card' },
      h('div', { class: 'muted tiny', style: { marginBottom: '8px' } }, `Select 1–6 photos, then analyze your progress with AI. (${photoSelect.size} selected)`),
      h('button', { class: 'btn btn-primary btn-block', disabled: photoSelect.size === 0, onClick: () => runAnalysis([...photoSelect]) }, '✨ Analyze with AI')));
  } else if (!aiStatus.enabled) {
    wrap.appendChild(h('div', { class: 'card muted tiny' }, '💡 Set an ANTHROPIC_API_KEY on the server to enable AI progress analysis of your photos.'));
  }

  if (!photos.length) {
    wrap.appendChild(empty('📸', 'No progress photos yet. Add one to start a visual timeline.'));
    return wrap;
  }

  const grid = h('div', { class: 'photo-grid' });
  photos.forEach((p) => {
    const selected = photoSelect && photoSelect.has(p.id);
    const cell = h('button', { class: 'ph' + (selected ? ' sel' : ''), onClick: () => {
      if (photoSelect) {
        if (photoSelect.has(p.id)) photoSelect.delete(p.id);
        else if (photoSelect.size < 6) photoSelect.add(p.id);
        else { toast('Up to 6 photos', 'err'); return; }
        refresh();
      } else openPhoto(p);
    } },
      h('img', { src: `/api/photos/${p.id}/image`, loading: 'lazy', alt: '' }),
      photoSelect ? h('div', { class: 'pick' }, selected ? '✓' : '') : null,
      h('div', { class: 'date' }, fmtDate(p.taken_on, { year: true })));
    grid.appendChild(cell);
  });
  wrap.appendChild(grid);
  return wrap;
};

function addPhoto() {
  const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    let dataUrl;
    try { dataUrl = await fileToDataURL(file); } catch { toast('Could not read image', 'err'); return; }
    const preview = h('img', { src: dataUrl, style: { width: '100%', borderRadius: '12px', maxHeight: '40vh', objectFit: 'cover' } });
    const date = h('input', { type: 'date', value: todayISO() });
    const bw = h('input', { inputmode: 'decimal', placeholder: `bodyweight (${unit()})` });
    const notes = h('textarea', { placeholder: 'Notes (optional)' });
    const save = async () => {
      try {
        await api.post('/photos', { image: dataUrl, taken_on: date.value, bodyweight: bw.value ? parseFloat(bw.value) : null, notes: notes.value.trim() || null });
        s.close(); toast('Photo saved', 'ok'); refresh();
      } catch (err) { toast(err.message, 'err'); }
    };
    const s = sheet({ title: 'New progress photo', body: h('div', { class: 'stack' },
      preview, field('Date', date), field(`Bodyweight (${unit()})`, bw), field('Notes', notes),
      h('button', { class: 'btn btn-primary btn-block', onClick: save }, 'Save photo')) });
  });
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 60000);
}

function openPhoto(p) {
  const body = h('div', { class: 'stack' },
    h('img', { src: `/api/photos/${p.id}/image`, style: { width: '100%', borderRadius: '12px' }, alt: '' }),
    h('div', { class: 'muted tiny' }, fmtDate(p.taken_on, { weekday: true, year: true }), p.bodyweight != null ? ` · ${fmtNum(p.bodyweight)} ${unit()}` : ''),
    p.notes ? h('p', { style: { whiteSpace: 'pre-wrap' } }, p.notes) : null,
    p.ai_analysis ? h('div', null, h('div', { class: 'card-title' }, '✨ AI analysis'), h('div', { class: 'ai-box' }, p.ai_analysis)) : null,
    h('button', { class: 'btn btn-danger btn-block', onClick: async () => {
      if (!(await confirmDialog('Delete this photo?', { danger: true, okText: 'Delete' }))) return;
      try { await api.del('/photos/' + p.id); s.close(); toast('Deleted'); refresh(); } catch (err) { toast(err.message, 'err'); }
    } }, 'Delete photo'));
  const s = sheet({ body });
}

async function runAnalysis(ids) {
  const s = sheet({ title: '✨ Analyzing…', body: h('div', { class: 'stack' }, loading(), h('p', { class: 'muted tiny center' }, 'Claude is reviewing your photos. This can take a moment.')) });
  try {
    const res = await api.post('/photos/analyze', { ids });
    clear(s.el);
    s.el.appendChild(h('div', { class: 'grip' }));
    s.el.appendChild(h('h3', null, '✨ Progress analysis'));
    s.el.appendChild(h('div', { class: 'ai-box' }, res.analysis));
    s.el.appendChild(h('button', { class: 'btn btn-block', style: { marginTop: '14px' }, onClick: () => { s.close(); photoSelect = null; refresh(); } }, 'Done'));
  } catch (err) {
    clear(s.el);
    s.el.appendChild(h('div', { class: 'grip' }));
    s.el.appendChild(errorNote(err.message));
  }
}

/* ============================ MORE ============================ */
RENDER.more = async function () {
  const wrap = h('div', null);
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'row-between' },
      h('div', null, h('div', { class: 'row-title' }, user.display_name || user.username), h('div', { class: 'muted tiny' }, '@' + user.username)),
      h('span', { class: 'badge amber' }, unit().toUpperCase()))));

  const menu = h('div', null);
  menu.appendChild(row({ title: '📅 This week', sub: 'Your weekly schedule & what’s next', onClick: () => navigate('schedule') }));
  menu.appendChild(row({ title: '🏋️ Machines & Exercises', sub: 'Manage the equipment you use', onClick: () => navigate('exercises') }));
  menu.appendChild(row({ title: '🎯 Goals', sub: 'Set and track targets', onClick: () => navigate('goals') }));
  menu.appendChild(row({ title: '⚙️ Settings', sub: 'Units, profile, password', onClick: () => navigate('settings') }));
  menu.appendChild(row({ title: 'ℹ️ About', onClick: () => navigate('about') }));
  wrap.appendChild(menu);

  wrap.appendChild(h('button', { class: 'btn btn-danger btn-block', style: { marginTop: '10px' }, onClick: async () => {
    if (await confirmDialog('Sign out of Gym Tracker?', { okText: 'Sign out' })) signOut();
  } }, 'Sign out'));
  return wrap;
};

/* ============================ SCHEDULE (This Week) ============================ */
RENDER.schedule = async function () {
  const [split, workouts] = await Promise.all([api.get('/split').catch(() => []), api.get('/workouts')]);
  const wrap = h('div', null);
  if (!split || !split.length) {
    wrap.appendChild(empty('📅', 'No weekly schedule yet.', h('button', { class: 'btn btn-primary', onClick: () => navigate('settings') }, 'Set up my split')));
    return wrap;
  }

  // All date math is LOCAL (matches how workouts are stored/compared elsewhere).
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const addDays = (base, n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };
  const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayStr = todayISO();
  const doneSet = new Set(workouts.filter((w) => w.set_count > 0).map((w) => String(w.performed_on).slice(0, 10)));
  const dayFor = (wd) => split.find((d) => d.weekday === wd) || { weekday: wd, kind: 'rest', title: 'Rest', exercises: [] };
  const isWorkout = (day) => day.kind !== 'rest' && day.exercises.length > 0;

  // ----- Up next: soonest scheduled workout you haven't done -----
  let upNext = null;
  for (let off = 0; off < 7; off++) {
    const date = addDays(today0, off);
    const day = dayFor(date.getDay());
    if (!isWorkout(day)) continue;
    if (off === 0 && doneSet.has(isoLocal(date))) continue; // today already done
    upNext = { day, date, offset: off };
    break;
  }

  const draftId = localStorage.getItem(DRAFT_KEY);
  const upCard = h('div', { class: 'card today' });
  upCard.appendChild(h('div', { class: 'kicker' }, 'Up next'));
  if (!upNext) {
    upCard.appendChild(h('div', { class: 'rest-msg' }, '🎉 Every scheduled workout this week is done — nice.'));
    upCard.appendChild(h('button', { class: 'linklike', onClick: () => openStartPicker() }, 'Start an extra workout'));
  } else {
    const when = upNext.offset === 0 ? 'Today' : upNext.offset === 1 ? 'Tomorrow' : dayName(upNext.day.weekday);
    upCard.appendChild(h('h3', { style: { marginTop: '2px' } }, `${when} · ${upNext.day.title || 'Workout'}`));
    const chips = h('div', { class: 'today-chips' });
    upNext.day.exercises.forEach((e) => chips.appendChild(h('span', { class: 'today-chip' }, e.name)));
    upCard.appendChild(chips);
    if (upNext.offset === 0) {
      upCard.appendChild(h('button', { class: 'btn btn-primary btn-block', onClick: () => (draftId ? navigate('log') : startTodayWorkout(upNext.day)) },
        draftId ? '▶︎ Continue workout' : `Start ${upNext.day.title || "today's"} workout`));
    } else {
      upCard.appendChild(h('div', { class: 'muted tiny', style: { marginTop: '6px' } }, `Coming up ${dayName(upNext.day.weekday)}, ${fmtDate(isoLocal(upNext.date))}`));
    }
  }
  wrap.appendChild(upCard);

  // ----- The week at a glance (Mon → Sun) -----
  wrap.appendChild(sectionHead('This week'));
  const dow = (today0.getDay() + 6) % 7; // Mon=0 .. Sun=6
  const weekStart = addDays(today0, -dow);
  for (let off = 0; off < 7; off++) {
    const date = addDays(weekStart, off);
    const ds = isoLocal(date);
    const day = dayFor(date.getDay());
    const done = doneSet.has(ds);
    const isToday = ds === todayStr;

    const card = h('div', { class: 'week-day' + (isToday ? ' today' : '') });
    card.appendChild(h('div', { class: 'row-between' },
      h('div', null,
        h('span', { class: 'wd-name' }, dayName(date.getDay())),
        h('span', { class: 'muted tiny', style: { marginLeft: '8px' } }, fmtDate(ds))),
      done ? h('span', { class: 'badge green' }, '✓ Done') : (isToday ? h('span', { class: 'badge amber' }, 'Today') : null)));

    if (isWorkout(day)) {
      card.appendChild(h('div', { class: 'wd-title' }, day.title || 'Workout'));
      const chips = h('div', { class: 'today-chips' });
      day.exercises.forEach((e) => chips.appendChild(h('span', { class: 'today-chip' }, e.name)));
      card.appendChild(chips);
    } else {
      const note = day.title && !/^rest$/i.test(day.title) ? `😴 ${day.title}` : '😴 Rest day';
      card.appendChild(h('div', { class: 'muted', style: { marginTop: '6px' } }, note));
    }
    wrap.appendChild(card);
  }

  wrap.appendChild(h('button', { class: 'btn btn-block', style: { marginTop: '4px' }, onClick: () => navigate('settings') }, '✏️ Edit schedule'));
  return wrap;
};

/* ============================ EXERCISES ============================ */
RENDER.exercises = async function () {
  const list = await getExercises(true);
  const wrap = h('div', null);
  wrap.appendChild(h('button', { class: 'btn btn-primary btn-block', style: { marginBottom: '14px' }, onClick: () => openExerciseForm(null) }, '＋ Add machine / exercise'));

  const activeList = list.filter((e) => !e.is_archived);
  const archived = list.filter((e) => e.is_archived);

  if (!list.length) {
    wrap.appendChild(empty('🏋️', 'Add the machines and exercises you use at the gym.'));
    return wrap;
  }
  activeList.forEach((e) => wrap.appendChild(exerciseRow(e)));

  if (archived.length) {
    wrap.appendChild(sectionHead('Archived'));
    archived.forEach((e) => wrap.appendChild(exerciseRow(e)));
  }
  return wrap;
};

function exerciseRow(e) {
  const bits = [e.muscle_group, e.equipment].filter(Boolean).join(' · ');
  const sub = [bits, e.set_count ? `${e.set_count} sets logged` : null].filter(Boolean).join(' · ');
  return row({
    title: e.name,
    sub: sub || null,
    badge: e.is_archived ? h('span', { class: 'badge' }, 'archived') : null,
    meta: e.last_used ? relDay(e.last_used) : null,
    onClick: () => openExerciseForm(e),
  });
}

function openExerciseForm(ex, onCreated) {
  const editing = !!ex;
  const name = h('input', { value: ex ? ex.name : '', placeholder: 'e.g. Leg Press' });
  const muscle = h('select', null, ...['', 'Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Core', 'Glutes', 'Full Body', 'Cardio']
    .map((m) => h('option', { value: m, selected: ex && ex.muscle_group === m }, m || 'Muscle group…')));
  const equip = h('select', null, ...['', 'Machine', 'Cable', 'Barbell', 'Dumbbell', 'Smith Machine', 'Bodyweight', 'Kettlebell', 'Bands']
    .map((m) => h('option', { value: m, selected: ex && ex.equipment === m }, m || 'Equipment…')));
  const notes = h('textarea', { placeholder: 'Seat height, settings, cues…' }, ex ? ex.notes || '' : '');

  const save = async () => {
    const payload = { name: name.value.trim(), muscle_group: muscle.value || null, equipment: equip.value || null, notes: notes.value.trim() || null };
    if (!payload.name) { toast('Name is required', 'err'); return; }
    try {
      const saved = editing ? await api.patch('/exercises/' + ex.id, payload) : await api.post('/exercises', payload);
      await getExercises(true);
      s.close();
      toast(editing ? 'Saved' : 'Added', 'ok');
      if (onCreated) onCreated(saved);
      else refresh();
    } catch (err) { toast(err.message, 'err'); }
  };

  const actions = [h('button', { class: 'btn btn-primary btn-block', onClick: save }, editing ? 'Save' : 'Add')];
  if (editing) {
    actions.push(h('button', { class: 'btn btn-block', onClick: async () => {
      try { await api.patch('/exercises/' + ex.id, { is_archived: !ex.is_archived }); await getExercises(true); s.close(); refresh(); } catch (err) { toast(err.message, 'err'); }
    } }, ex.is_archived ? 'Unarchive' : 'Archive'));
    actions.push(h('button', { class: 'btn btn-danger btn-block', onClick: async () => {
      if (!(await confirmDialog('Delete this exercise? Its logged sets will be removed too.', { danger: true, okText: 'Delete' }))) return;
      try { await api.del('/exercises/' + ex.id); await getExercises(true); s.close(); refresh(); } catch (err) { toast(err.message, 'err'); }
    } }, 'Delete'));
  }

  const s = sheet({ title: editing ? 'Edit exercise' : 'New exercise', body: h('div', { class: 'stack' },
    field('Name', name), field('Muscle group', muscle), field('Equipment', equip), field('Notes', notes), ...actions) });
}

/* ============================ GOALS ============================ */
RENDER.goals = async function () {
  const [goals] = await Promise.all([api.get('/goals'), getExercises()]);
  const wrap = h('div', null);
  wrap.appendChild(h('button', { class: 'btn btn-primary btn-block', style: { marginBottom: '14px' }, onClick: openGoalForm }, '＋ New goal'));

  const active = goals.filter((g) => g.is_active);
  const done = goals.filter((g) => !g.is_active);
  if (!goals.length) { wrap.appendChild(empty('🎯', 'Set a goal to stay motivated — a weekly target, a PR to chase, and more.')); return wrap; }

  const c = h('div', { class: 'stack' });
  active.forEach((g) => c.appendChild(goalCard(g)));
  wrap.appendChild(c);
  if (done.length) {
    wrap.appendChild(sectionHead('Inactive'));
    const c2 = h('div', { class: 'stack' });
    done.forEach((g) => c2.appendChild(goalCard(g)));
    wrap.appendChild(c2);
  }
  return wrap;
};

function openGoalForm() {
  const KINDS = [
    ['weekly_workouts', 'Workouts per week'],
    ['total_workouts', 'Total workouts'],
    ['exercise_weight', 'Reach a weight (exercise)'],
    ['exercise_1rm', beginnerOn() ? 'Strength score (exercise)' : 'Estimated 1RM (exercise)'],
  ];
  const kind = h('select', null, ...KINDS.map(([v, l]) => h('option', { value: v }, l)));
  const exWrap = h('div', { hidden: true });
  const exSel = h('select', null, ...activeExercises().map((e) => h('option', { value: e.id }, e.name)));
  exWrap.appendChild(field('Exercise', exSel));
  const target = h('input', { inputmode: 'decimal', placeholder: 'target' });
  const title = h('input', { placeholder: 'Custom label (optional)' });

  const sync = () => { exWrap.hidden = !(kind.value === 'exercise_weight' || kind.value === 'exercise_1rm'); };
  kind.addEventListener('change', sync); sync();

  const save = async () => {
    const payload = { kind: kind.value, target_value: parseFloat(target.value), title: title.value.trim() || null };
    if (!payload.target_value) { toast('Enter a target', 'err'); return; }
    if (!exWrap.hidden) payload.exercise_id = Number(exSel.value);
    try { await api.post('/goals', payload); s.close(); toast('Goal added', 'ok'); refresh(); } catch (err) { toast(err.message, 'err'); }
  };
  const s = sheet({ title: 'New goal', body: h('div', { class: 'stack' },
    field('Type', kind), exWrap, field('Target', target), field('Label', title),
    h('button', { class: 'btn btn-primary btn-block', onClick: save }, 'Add goal')) });
}

function openGoalActions(g) {
  const body = h('div', { class: 'stack' },
    h('p', { style: { margin: '2px' } }, goalLabel(g)),
    h('button', { class: 'btn btn-block', onClick: async () => { try { await api.patch('/goals/' + g.id, { is_active: !g.is_active }); s.close(); refresh(); } catch (e) { toast(e.message, 'err'); } } }, g.is_active ? 'Mark inactive' : 'Reactivate'),
    h('button', { class: 'btn btn-danger btn-block', onClick: async () => {
      if (!(await confirmDialog('Delete this goal?', { danger: true, okText: 'Delete' }))) return;
      try { await api.del('/goals/' + g.id); s.close(); refresh(); } catch (e) { toast(e.message, 'err'); }
    } }, 'Delete goal'));
  const s = sheet({ title: 'Goal', body });
}

/* ============================ SETTINGS ============================ */
RENDER.settings = async function () {
  const wrap = h('div', null);
  const [split, templates] = await Promise.all([
    api.get('/split').catch(() => []),
    api.get('/templates').catch(() => []),
  ]);

  // Display name
  const dn = h('input', { value: user.display_name || '', placeholder: 'Display name' });
  wrap.appendChild(h('div', { class: 'card' },
    field('Display name', dn),
    h('button', { class: 'btn btn-sm', onClick: async () => {
      try { const r = await api.patch('/me', { display_name: dn.value.trim() || null }); user = r.user; toast('Saved', 'ok'); } catch (e) { toast(e.message, 'err'); }
    } }, 'Save')));

  // Beginner mode
  const bm = (on) => h('button', { class: 'pill' + (beginnerOn() === on ? ' active' : ''), onClick: async () => {
    try { const r = await api.patch('/me', { beginner_mode: on }); user = r.user; refresh(); } catch (e) { toast(e.message, 'err'); }
  } }, on ? 'On' : 'Off');
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, 'Beginner mode'),
    h('div', { class: 'muted tiny', style: { marginBottom: '10px' } }, 'Plain-language labels with quick (?) explanations. Turn off to show technical terms.'),
    h('div', { class: 'pill-grp' }, bm(true), bm(false))));

  // My split — assign a template (Push / Pull / Legs / …) or rest to each day
  const splitCard = h('div', { class: 'card' });
  splitCard.appendChild(h('div', { class: 'card-title' }, 'My split'));
  splitCard.appendChild(h('div', { class: 'muted tiny', style: { marginBottom: '10px' } }, 'Tap a day to assign a workout template or make it a rest day.'));
  [1, 2, 3, 4, 5, 6, 0].forEach((wd) => {
    const day = split.find((d) => d.weekday === wd) || { weekday: wd, kind: 'rest', title: 'Rest', template_id: null, exercises: [] };
    const isRest = day.kind === 'rest' || !day.exercises.length;
    splitCard.appendChild(row({
      title: `${dayName(wd)} · ${isRest ? 'Rest' : day.title}`,
      sub: isRest
        ? (day.title && !/^rest$/i.test(day.title) ? day.title : 'Rest day')
        : day.exercises.map((e) => e.name).join(', '),
      onClick: () => openDayAssignSheet(day, templates),
    }));
  });
  wrap.appendChild(splitCard);

  // Workout templates — edit the reusable exercise lists themselves
  const tplCard = h('div', { class: 'card' });
  tplCard.appendChild(h('div', { class: 'card-title' }, 'Workout templates'));
  templates.forEach((t) => tplCard.appendChild(row({
    title: t.name,
    sub: t.exercises.map((e) => e.name).join(', ') || 'No exercises yet',
    meta: t.used_on && t.used_on.length
      ? t.used_on.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((wd) => dayName(wd).slice(0, 3)).join(', ')
      : null,
    onClick: () => openTemplateEditor(t),
  })));
  tplCard.appendChild(h('button', { class: 'btn btn-sm btn-block', onClick: () => openTemplateEditor(null) }, '＋ New template'));
  wrap.appendChild(tplCard);

  // Units
  const mk = (u) => h('button', { class: 'pill' + (unit() === u ? ' active' : ''), onClick: async () => {
    try { const r = await api.patch('/me', { unit: u }); user = r.user; refresh(); } catch (e) { toast(e.message, 'err'); }
  } }, u.toUpperCase());
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, 'Weight unit'),
    h('div', { class: 'pill-grp' }, mk('lb'), mk('kg'))));

  // Password
  const cur = h('input', { type: 'password', placeholder: 'Current password' });
  const nw = h('input', { type: 'password', placeholder: 'New password' });
  wrap.appendChild(h('div', { class: 'card' },
    h('div', { class: 'card-title' }, 'Change password'),
    field('Current', cur), field('New', nw),
    h('button', { class: 'btn btn-sm', onClick: async () => {
      try { await api.post('/me/password', { current: cur.value, next: nw.value }); cur.value = ''; nw.value = ''; toast('Password updated', 'ok'); } catch (e) { toast(e.message, 'err'); }
    } }, 'Update password')));

  return wrap;
};

// Assign a workout template (or rest) to one weekday.
function openDayAssignSheet(day, templates) {
  const assign = async (templateId) => {
    try {
      await api.put('/split/' + day.weekday, { template_id: templateId });
      s.close(); toast('Saved', 'ok'); refresh();
    } catch (e) { toast(e.message, 'err'); }
  };
  const body = h('div', { class: 'stack' });
  templates.forEach((t) => body.appendChild(h('button', { class: 'row', style: { margin: '0' }, onClick: () => assign(t.id) },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, t.name, day.template_id === t.id ? h('span', { class: 'badge green', style: { marginLeft: '8px' } }, '✓ current') : null),
      h('div', { class: 'row-sub' }, t.exercises.map((e) => e.name).join(', ') || 'No exercises yet')))));
  body.appendChild(h('button', { class: 'btn btn-block', onClick: () => assign(null) },
    '😴 Rest day', day.template_id == null ? ' ✓' : ''));
  const s = sheet({ title: dayName(day.weekday), body });
}

// Create/edit a workout template: rename, add/remove exercises, reorder.
async function openTemplateEditor(tpl) {
  await getExercises();
  const selected = tpl ? tpl.exercises.map((e) => e.id) : [];
  const name = h('input', { value: tpl ? tpl.name : '', placeholder: 'e.g. Push' });
  const listBox = h('div', null);
  const pillBox = h('div', { class: 'pill-grp' });
  const exName = (id) => ((exercisesCache || []).find((e) => e.id === id) || {}).name || 'Exercise';

  const draw = () => {
    clear(listBox);
    if (!selected.length) listBox.appendChild(h('p', { class: 'muted tiny', style: { margin: '2px 0' } }, 'No exercises yet — add some below.'));
    selected.forEach((id, i) => {
      listBox.appendChild(h('div', { class: 'order-item' },
        h('span', { class: 'nm' }, `${i + 1}. ${exName(id)}`),
        h('button', { title: 'Move up', disabled: i === 0, onClick: () => { selected.splice(i - 1, 0, selected.splice(i, 1)[0]); draw(); } }, '↑'),
        h('button', { title: 'Move down', disabled: i === selected.length - 1, onClick: () => { selected.splice(i + 1, 0, selected.splice(i, 1)[0]); draw(); } }, '↓'),
        h('button', { class: 'rm', title: 'Remove', onClick: () => { selected.splice(i, 1); draw(); } }, '✕')));
    });
    clear(pillBox);
    activeExercises().filter((e) => !selected.includes(e.id)).forEach((e) =>
      pillBox.appendChild(h('button', { class: 'pill', onClick: () => { selected.push(e.id); draw(); } }, e.name)));
  };
  draw();

  const save = async () => {
    const nm = name.value.trim();
    if (!nm) { toast('Name is required', 'err'); return; }
    try {
      if (tpl) await api.patch('/templates/' + tpl.id, { name: nm, exercise_ids: selected });
      else await api.post('/templates', { name: nm, exercise_ids: selected });
      s.close(); toast('Saved', 'ok'); refresh();
    } catch (e) { toast(e.message, 'err'); }
  };

  const actions = [h('button', { class: 'btn btn-primary btn-block', onClick: save }, tpl ? 'Save template' : 'Add template')];
  if (tpl) {
    actions.push(h('button', { class: 'btn btn-danger btn-block', onClick: async () => {
      const used = tpl.used_on && tpl.used_on.length;
      const msg = `Delete "${tpl.name}"?${used ? ' Days scheduled with it become rest days.' : ''}`;
      if (!(await confirmDialog(msg, { danger: true, okText: 'Delete' }))) return;
      try { await api.del('/templates/' + tpl.id); s.close(); toast('Deleted'); refresh(); } catch (e) { toast(e.message, 'err'); }
    } }, 'Delete template'));
  }

  const s = sheet({ title: tpl ? 'Edit template' : 'New template', body: h('div', { class: 'stack' },
    field('Name', name),
    h('div', { class: 'card-title', style: { margin: '4px 0 0' } }, 'Exercises (in order)'),
    listBox,
    h('div', { class: 'card-title', style: { margin: '8px 0 0' } }, 'Add exercises'),
    pillBox,
    h('button', { class: 'btn btn-sm', onClick: () => openExerciseForm(null, (created) => { selected.push(created.id); draw(); }) }, '＋ New machine / exercise'),
    ...actions) });
}

/* ============================ ABOUT ============================ */
RENDER.about = async function () {
  let version = '–';
  try { version = (await api.get('/version')).version; } catch {}
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  return h('div', null,
    h('div', { class: 'card', style: { textAlign: 'center' } },
      h('img', { src: '/icons/icon-192.png', width: 64, height: 64, style: { borderRadius: '16px' } }),
      h('h3', { style: { marginTop: '10px' } }, 'Gym Tracker'),
      h('p', { class: 'muted tiny' }, 'Your personal lifting log — machines, sets, streaks, goals and progress.'),
      h('p', { class: 'muted tiny', style: { marginTop: '8px' } }, 'Build ', String(version).slice(0, 12)),
      h('p', { class: 'badge ' + (aiStatus.enabled ? 'green' : ''), style: { marginTop: '10px' } }, aiStatus.enabled ? '✨ AI photo analysis on' : 'AI photo analysis off')),
    !standalone ? h('div', { class: 'card muted tiny' }, '📲 Install: open your browser menu and choose “Add to Home Screen” to use Gym Tracker like an app — full screen, offline-ready, and it stays signed in.') : null);
};

/* ============================ helpers ============================ */
function fileToDataURL(file, max = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width: w, height: hgt } = img;
      if (Math.max(w, hgt) > max) { const sc = max / Math.max(w, hgt); w = Math.round(w * sc); hgt = Math.round(hgt * sc); }
      const c = document.createElement('canvas');
      c.width = w; c.height = hgt;
      c.getContext('2d').drawImage(img, 0, 0, w, hgt);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

boot();
