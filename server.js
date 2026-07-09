/*
 * Scoreboard-X — zero-dependency local server for the handball livestream overlay.
 *
 *   run:      node server.js
 *   overlay:  http://localhost:3690/overlay   (OBS browser source, 1080x1920)
 *   admin:    http://localhost:3690/admin     (control panel, desktop & phone)
 *
 * No npm install required. State is authoritative here and pushed to every
 * connected page over Server-Sent Events. State survives restarts (state.json).
 *
 * Match library (matches.json): every match owns a snapshot of the MATCH-scoped
 * state (teams / score / timer / period / event name / icons / info banner /
 * roster) plus an event log for replay. Display settings (board.*, timer word
 * prefs, goalDelta) are global and never stored per match. Team setup and the
 * half duration are NOT logged — only their final state lives in the snapshot.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT || 3690);
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, 'state.json');
const MATCHES_FILE = path.join(__dirname, 'matches.json');

/* ------------------------------------------------------------------ state */

const DEFAULT_STATE = {
  board: {
    tier: 'large',            // off | small | large | full
    nameMode: { small: 'short', large: 'short', full: 'short' }, // short | full per tier
    scale: 1,                 // overall overlay scale (0.7 - 1.4)
    margin: 36,               // distance from top/left edge, stage px (can be negative)
    goalEffect: 'full',       // goal expand: 'minimal' | 'partial' (scorer row only) | 'full' (both rows)
    goalExpandSec: 8,         // ... for this many seconds (partial / full)
    autoExpandBreak: true,    // auto switch to full while BREAK / PAUSE word / END shows
    ambient: true,            // subtle idle motion
    driftSpeed: 3,            // facet drift speed multiplier (0.1 - 3.0)
    clockVisible: true,       // show clock + period on overlay
  },
  event: { text: 'HANDBALL CUP 2026', visible: true },
  period: { text: '1ST HALF', visible: true },
  timer: {
    durationMs: 30 * 60000,
    remainingMs: 30 * 60000,  // valid at refEpoch when running, absolute when paused
    running: false,
    refEpoch: 0,
    mode: 'clock',            // clock | break | pause | matchEnd
    direction: 'down',        // 'down' = count-down (倒計時) | 'up' = count-up (正計時)
    autoPauseWord: true,      // show PAUSE automatically when stopped mid-period
    pauseAlternate: false,    // alternate PAUSE word and time while paused
    autoEndMode: true,        // switch to matchEnd mode when timer hits 0
    endAlternate: false,      // alternate END word and 0.00 time
  },
  goalDelta: 1,               // points added by the GOAL button (-19 .. 19, not 0)
  teams: {
    A: { name: 'OGC NICE', short: 'NICE', color: '#D6152C', score: 0 },
    B: { name: 'RC LENS', short: 'LENS', color: '#F6C500', score: 0 },
  },
  banners: [],                // event icons: { id, team:'A'|'B', type, createdAt, susp? } — manual removal only
  infoBanner: null,           // top-centre info banner: null | { id, key, cat:'REFEREE'|'CONTROL', title, body, tone, fg, shownAt }
  roster: { A: [], B: [], officials: [] },  // entries: { id, role, name, num, pos, title } — only name is required
  rosterDisplay: { mode: 'off', page: 0 },  // mode: off | A | B | both ; page is shared (teams flip together)
  /* bottom-centre banner (person / event official / organisation). Content is a FROZEN
   * copy taken at show time — later roster / org edits never change the card on air. */
  bottomBanner: null,         // null | { id, kind:'person'|'official'|'org', name, role, teamName, color, file, shownAt }
  /* global display config (like board.*, NOT match-scoped) */
  orgBanners: {},             // assets/banner/<file> -> { name, role: 'HOST'|'SUPPORT'|'FUNDER' }
  cornerLogos: [],            // ordered assets/corner/ filenames shown top-right (max 3, admin click order)
};

const BANNER_TYPES = ['FOUL', 'TIMEOUT', 'SUSP2', 'YELLOW', 'RED', 'BLUE', 'MEDICAL'];
const SUSP2_MS = 120000;      // 2-minute suspension countdown, runs on playing time (freezes with the match clock)
const TEAM_ROLES = ['LEADER', 'COACH', 'STAFF', 'PLAYER'];
const OFF_ROLES = ['COMMENTATOR', 'REFEREE'];
const BB_KINDS = ['person', 'official', 'org'];   // org 位置(role)為選填自由文字
const MAX_CORNER_LOGOS = 3;
/* logged event types. Team setup + half-duration are intentionally NOT here —
 * they are setup, kept only as final state in the snapshot (like the roster). */
const LOG_TYPES = ['PHASE', 'SCORE', 'ICON', 'INFO', 'CLOCK', 'PERIOD', 'EVENT_NAME', 'RESET', 'NOTE'];
const PHASES = ['START', 'PAUSE', 'BREAK', 'MATCH_END'];
const TIMER_PREF_KEYS = ['autoPauseWord', 'pauseAlternate', 'autoEndMode', 'endAlternate'];
const MATCH_TIMER_KEYS = ['durationMs', 'remainingMs', 'running', 'refEpoch', 'mode', 'direction'];
const NEW_MATCH_DURATION = 15 * 60000;   // 新對局預設半場 15:00
const MAX_LOG = 5000;
const MAX_MATCHES = 200;

let state = loadState();

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(dst, src) {
  for (const k of Object.keys(src)) {
    if (isObj(src[k]) && isObj(dst[k])) deepMerge(dst[k], src[k]);
    else dst[k] = clone(src[k]);
  }
  return dst;
}
function clamp(v, lo, hi) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }
function cleanText(v, max, fallback) {
  if (typeof v !== 'string') return fallback;
  return v.replace(/[\r\n\t]/g, ' ').slice(0, max);
}
function newId(pfx) { return pfx + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
/* a roster entry with no name AND no other field is "completely blank" — never
 * persisted or displayed (an in-progress add stays in live state until blurred). */
function isBlankEntry(e) {
  return !(String(e.name || '').trim() || String(e.num || '').trim()
        || String(e.pos || '').trim() || String(e.title || '').trim());
}

function cleanRosterEntry(e, roles) {
  return {
    id: typeof e.id === 'string' && e.id ? e.id.slice(0, 20) : newId('p'),
    role: roles.includes(e.role) ? e.role : roles[roles.length - 1],
    name: cleanText(String(e.name ?? ''), 30, ''),
    num: cleanText(String(e.num ?? ''), 3, ''),
    pos: cleanText(String(e.pos ?? ''), 10, ''),
    title: cleanText(String(e.title ?? ''), 14, ''),
  };
}

function loadState() {
  const base = clone(DEFAULT_STATE);
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    deepMerge(base, saved);
    // migrate pre-tier saves (board.visible / board.expanded)
    if (saved && saved.board && saved.board.tier == null) {
      base.board.tier = saved.board.visible === false ? 'off'
        : (saved.board.expanded ? 'full' : 'large');
    }
    delete base.board.visible;
    delete base.board.expanded;
    // migrate pre-per-tier saves (board.nameMode was a single 'short' | 'full')
    if (typeof base.board.nameMode === 'string') {
      const m = ['short', 'full'].includes(base.board.nameMode) ? base.board.nameMode : 'short';
      base.board.nameMode = { small: m, large: m, full: m };
    }
    delete base.bannerPrefs;    // pre-2026-07 auto-hide config — icons are manual-removal now
    if (!Array.isArray(base.banners)) base.banners = [];
    base.banners = base.banners.filter(b => isObj(b) && BANNER_TYPES.includes(b.type));
    for (const b of base.banners) {
      delete b.expiresAt;
      if (b.type === 'SUSP2') {
        if (!isObj(b.susp)) b.susp = { msLeft: 0, refEpoch: 0, running: false };
        if (b.susp.running) { // freeze across restarts; syncSuspensions re-arms if the clock is running
          b.susp.msLeft = Math.max(0, Number(b.susp.msLeft) - (Date.now() - Number(b.susp.refEpoch)));
          b.susp.running = false;
          b.susp.refEpoch = 0;
        }
      }
    }
    if (!isObj(base.infoBanner)) base.infoBanner = null;
    if (!isObj(base.bottomBanner)) base.bottomBanner = null;
    if (!isObj(base.orgBanners)) base.orgBanners = {};
    if (!Array.isArray(base.cornerLogos)) base.cornerLogos = [];
    // roster: drop completely-blank entries so a page reload clears them
    if (!isObj(base.roster)) base.roster = clone(DEFAULT_STATE.roster);
    for (const k of ['A', 'B', 'officials']) {
      const roles = k === 'officials' ? OFF_ROLES : TEAM_ROLES;
      base.roster[k] = (Array.isArray(base.roster[k]) ? base.roster[k] : [])
        .filter(isObj).map(e => cleanRosterEntry(e, roles)).filter(e => !isBlankEntry(e));
    }
    if (!isObj(base.rosterDisplay)) base.rosterDisplay = clone(DEFAULT_STATE.rosterDisplay);
  } catch { /* first run or corrupt file -> defaults */ }
  return base;
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {});
  }, 400);
}

function sanitize() {
  const b = state.board;
  if (!['off', 'small', 'large', 'full'].includes(b.tier)) b.tier = 'large';
  {
    const norm = m => (['short', 'full'].includes(m) ? m : 'short');
    const nm = b.nameMode;
    if (typeof nm === 'string') b.nameMode = { small: norm(nm), large: norm(nm), full: norm(nm) };
    else if (isObj(nm)) b.nameMode = { small: norm(nm.small), large: norm(nm.large), full: norm(nm.full) };
    else b.nameMode = { small: 'short', large: 'short', full: 'short' };
  }
  delete b.visible;
  delete b.expanded;
  b.scale = clamp(b.scale, 0.6, 1.6);
  b.margin = Math.round(clamp(b.margin, -300, 300));
  b.goalExpandSec = clamp(b.goalExpandSec, 2, 30);
  if (b.goalEffect == null && 'autoExpandGoal' in b) b.goalEffect = b.autoExpandGoal ? 'full' : 'minimal';
  if (!['minimal', 'partial', 'full'].includes(b.goalEffect)) b.goalEffect = 'full';
  delete b.autoExpandGoal;
  state.goalDelta = Math.round(clamp(state.goalDelta, -19, 19)) || 1;
  state.event.text = cleanText(state.event.text, 44, DEFAULT_STATE.event.text);
  state.period.text = cleanText(state.period.text, 22, DEFAULT_STATE.period.text);
  for (const key of ['A', 'B']) {
    const t = state.teams[key];
    t.name = cleanText(t.name, 26, DEFAULT_STATE.teams[key].name);
    t.short = cleanText(t.short, 8, DEFAULT_STATE.teams[key].short) || t.name.slice(0, 4).toUpperCase();
    t.score = Math.round(clamp(t.score, 0, 199));
    if (!/^#[0-9a-fA-F]{6}$/.test(String(t.color))) t.color = DEFAULT_STATE.teams[key].color;
  }
  delete state.bannerPrefs;
  if (state.infoBanner != null && !isObj(state.infoBanner)) state.infoBanner = null;
  if (!['clock', 'break', 'pause', 'matchEnd'].includes(state.timer.mode)) state.timer.mode = 'clock';
  if (!['up', 'down'].includes(state.timer.direction)) state.timer.direction = 'down';
  /* roster + roster display. Blank rows are kept in LIVE state (an add stays put
   * until you fill or blur it); they are stripped on persist snap / load only. */
  if (!isObj(state.roster)) state.roster = clone(DEFAULT_STATE.roster);
  for (const key of ['A', 'B', 'officials']) {
    const roles = key === 'officials' ? OFF_ROLES : TEAM_ROLES;
    const list = Array.isArray(state.roster[key]) ? state.roster[key] : [];
    state.roster[key] = list.filter(isObj).slice(0, 40).map(e => cleanRosterEntry(e, roles));
  }
  {
    const rd = isObj(state.rosterDisplay) ? state.rosterDisplay : {};
    state.rosterDisplay = {
      mode: ['off', 'A', 'B', 'both'].includes(rd.mode) ? rd.mode : 'off',
      page: Math.round(clamp(rd.page, 0, 99)),
    };
  }
  /* bottom banner — a frozen display copy; drop it entirely if malformed / nameless */
  if (state.bottomBanner != null) {
    const bb = state.bottomBanner;
    if (!isObj(bb) || !BB_KINDS.includes(bb.kind)
        || !cleanText(String(bb.name ?? ''), 40, '').trim()) {
      state.bottomBanner = null;
    } else {
      bb.id = typeof bb.id === 'string' && bb.id ? bb.id.slice(0, 20) : newId('bb');
      bb.name = cleanText(String(bb.name ?? ''), 40, '');
      bb.role = cleanText(String(bb.role ?? ''), 16, '');
      bb.teamName = cleanText(String(bb.teamName ?? ''), 26, '');
      if (!/^#[0-9a-fA-F]{6}$/.test(String(bb.color))) bb.color = '#FFFFFF';
      bb.file = cleanText(String(bb.file ?? ''), 120, '');
      bb.group = ['A', 'B', 'OFF'].includes(bb.group) ? bb.group : '';
      bb.entryId = typeof bb.entryId === 'string' ? bb.entryId.slice(0, 20) : '';
      bb.shownAt = Number(bb.shownAt) || Date.now();
    }
  }
  /* org banner meta: file -> { name, role } — name required to be usable, role (位置)
   * is free admin text and may be empty */
  {
    const src = isObj(state.orgBanners) ? state.orgBanners : {};
    const out = {};
    let n = 0;
    for (const k of Object.keys(src)) {
      if (++n > 100) break;
      const v = src[k];
      if (!isObj(v)) continue;
      out[String(k).slice(0, 120)] = {
        name: cleanText(String(v.name ?? ''), 40, ''),
        role: cleanText(String(v.role ?? ''), 20, ''),
      };
    }
    state.orgBanners = out;
  }
  /* corner logos: ordered filenames, hard-capped (admin enforces the same limit) */
  state.cornerLogos = (Array.isArray(state.cornerLogos) ? state.cornerLogos : [])
    .filter(f => typeof f === 'string' && f.trim())
    .map(f => f.slice(0, 120))
    .slice(0, MAX_CORNER_LOGOS);
}

/* ------------------------------------------------------------------ timer */

function timerRemainingNow() {
  const t = state.timer;
  if (!t.running) return Math.max(0, t.remainingMs);
  return Math.max(0, t.remainingMs - (Date.now() - t.refEpoch));
}

let timerEndTimeout = null;
function scheduleTimerEnd() {
  clearTimeout(timerEndTimeout);
  if (!state.timer.running) return;
  const left = timerRemainingNow();
  timerEndTimeout = setTimeout(() => {
    state.timer.remainingMs = 0;
    state.timer.running = false;
    if (state.timer.autoEndMode) state.timer.mode = 'matchEnd';
    logEvent('PHASE', { phase: state.timer.autoEndMode ? 'MATCH_END' : 'PAUSE', auto: true });
    syncSuspensions();
    syncMatchSnap();
    persist();
    broadcast({ kind: 'timeend' });
  }, left + 30);
}

const timerActions = {
  start() {
    const t = state.timer;
    if (t.running) return;
    t.remainingMs = timerRemainingNow();
    if (t.remainingMs <= 0) return;
    t.refEpoch = Date.now();
    t.running = true;
    if (t.mode === 'pause' || t.mode === 'matchEnd') t.mode = 'clock'; // starting the clock clears forced words
    scheduleTimerEnd();
  },
  pause() {
    const t = state.timer;
    if (!t.running) return;
    t.remainingMs = timerRemainingNow();
    t.running = false;
    scheduleTimerEnd();
  },
  set(ms) {
    const t = state.timer;
    t.remainingMs = clamp(ms, 0, t.durationMs);
    t.refEpoch = Date.now();
    scheduleTimerEnd();
  },
  adjust(delta) {
    this.set(timerRemainingNow() + Number(delta || 0));
  },
  reset() {
    const t = state.timer;
    t.running = false;
    t.remainingMs = t.durationMs;
    scheduleTimerEnd();
  },
  duration(ms) {
    const t = state.timer;
    const wasFull = !t.running && t.remainingMs === t.durationMs;
    t.durationMs = clamp(ms, 0, 120 * 60000);
    if (t.direction === 'up') {
      if (timerRemainingNow() > t.durationMs) this.set(t.durationMs);
      scheduleTimerEnd();
      return;
    }
    if (wasFull) t.remainingMs = t.durationMs;
    else if (timerRemainingNow() > t.durationMs) this.set(t.durationMs);
  },
  mode(mode) {
    const t = state.timer;
    if (!['clock', 'break', 'pause', 'matchEnd'].includes(mode)) return;
    if (mode !== 'clock' && t.running) this.pause(); // BREAK / PAUSE / MATCH END always stop the clock
    if (mode === 'matchEnd') t.remainingMs = 0;
    t.mode = mode;
  },
};

/* ---------------------------------------------------------------- banners */

function dropBanner(id) {
  state.banners = state.banners.filter(x => x.id !== id);
}

/* 2-min suspension countdowns run on PLAYING time: they advance only while the
 * match clock runs. Freeze/unfreeze whenever timer.running flips (any action,
 * or the natural time-end). Clock set/adjust/calibrate do NOT touch them. */
function suspRemaining(b) {
  const s = b.susp;
  const left = s.running ? Number(s.msLeft) - (Date.now() - Number(s.refEpoch)) : Number(s.msLeft);
  return Math.max(0, Math.min(SUSP2_MS, left));
}
function syncSuspensions() {
  const run = !!state.timer.running;
  for (const b of state.banners) {
    if (b.type !== 'SUSP2' || !isObj(b.susp)) continue;
    if (b.susp.running === run) continue;
    const left = suspRemaining(b);
    b.susp = (run && left > 0)
      ? { msLeft: left, refEpoch: Date.now(), running: true }
      : { msLeft: left, refEpoch: 0, running: false };
  }
}

/* ---------------------------------------------------------- match library */
/* matches.json = { activeId, matches: [ { id, createdAt, updatedAt, snap, log } ] }
 * snap  = match-scoped slice of state (see matchSnap)
 * log   = [ { id, utc, clock, period, type, data } ] sorted by utc
 *          utc   — UTC epoch ms of the event
 *          clock — timer remainingMs at that moment (display side converts for count-up)
 */

function defaultSnap() {
  return clone({
    event: { text: DEFAULT_STATE.event.text },
    period: { text: DEFAULT_STATE.period.text },
    timer: {
      durationMs: NEW_MATCH_DURATION, remainingMs: NEW_MATCH_DURATION,
      running: false, refEpoch: 0, mode: 'clock', direction: 'down',
    },
    teams: {
      A: { name: 'TEAM A', short: 'TEAM A', color: DEFAULT_STATE.teams.A.color, score: 0 },
      B: { name: 'TEAM B', short: 'TEAM B', color: DEFAULT_STATE.teams.B.color, score: 0 },
    },
    banners: [],
    infoBanner: null,
    bottomBanner: null,
    roster: { A: [], B: [], officials: [] },
  });
}

function matchSnap() {
  const timer = {};
  for (const k of MATCH_TIMER_KEYS) timer[k] = state.timer[k];
  const roster = { A: [], B: [], officials: [] };
  for (const k of ['A', 'B', 'officials']) {
    roster[k] = state.roster[k].filter(e => !isBlankEntry(e));   // strip blanks from the stored snapshot
  }
  return clone({
    event: { text: state.event.text },
    period: { text: state.period.text },
    timer,
    teams: state.teams,
    banners: state.banners,
    infoBanner: state.infoBanner,
    bottomBanner: state.bottomBanner,
    roster,
  });
}

function sanitizeSnap(src) {
  const snap = defaultSnap();
  if (!isObj(src)) return snap;
  if (isObj(src.event)) snap.event.text = cleanText(src.event.text, 44, snap.event.text);
  if (isObj(src.period)) snap.period.text = cleanText(src.period.text, 22, snap.period.text);
  if (isObj(src.timer)) {
    for (const k of ['durationMs', 'remainingMs', 'refEpoch']) {
      if (Number.isFinite(Number(src.timer[k]))) snap.timer[k] = Math.max(0, Number(src.timer[k]));
    }
    snap.timer.running = !!src.timer.running;
    if (['clock', 'break', 'pause', 'matchEnd'].includes(src.timer.mode)) snap.timer.mode = src.timer.mode;
    if (['up', 'down'].includes(src.timer.direction)) snap.timer.direction = src.timer.direction;
  }
  if (isObj(src.teams)) {
    for (const k of ['A', 'B']) {
      const t = src.teams[k];
      if (!isObj(t)) continue;
      snap.teams[k].name = cleanText(String(t.name ?? ''), 26, snap.teams[k].name);
      snap.teams[k].short = cleanText(String(t.short ?? ''), 8, snap.teams[k].short);
      snap.teams[k].score = Math.round(clamp(t.score, 0, 199));
      if (/^#[0-9a-fA-F]{6}$/.test(String(t.color))) snap.teams[k].color = t.color;
    }
  }
  if (Array.isArray(src.banners)) {
    snap.banners = src.banners.filter(b => isObj(b) && BANNER_TYPES.includes(b.type)).slice(0, 6).map(b => {
      const out = { id: typeof b.id === 'string' ? b.id.slice(0, 20) : newId('b'), team: b.team === 'B' ? 'B' : 'A', type: b.type, createdAt: Number(b.createdAt) || Date.now() };
      if (b.type === 'SUSP2') {
        const s = isObj(b.susp) ? b.susp : {};
        out.susp = { msLeft: clamp(s.msLeft, 0, SUSP2_MS), refEpoch: Number(s.refEpoch) || 0, running: !!s.running };
      }
      return out;
    });
  }
  if (isObj(src.infoBanner)) {
    const ib = src.infoBanner;
    const hex = v => /^#[0-9a-fA-F]{6}$/.test(String(v));
    snap.infoBanner = {
      id: typeof ib.id === 'string' ? ib.id.slice(0, 20) : newId('i'),
      key: cleanText(String(ib.key ?? ''), 24, ''),
      cat: ib.cat === 'CONTROL' ? 'CONTROL' : 'REFEREE',
      title: cleanText(String(ib.title ?? ''), 30, 'INFO') || 'INFO',
      body: cleanText(String(ib.body ?? ''), 240, ''),
      tone: hex(ib.tone) ? ib.tone : '#E0132F',
      fg: hex(ib.fg) ? ib.fg : '#FFFFFF',
      shownAt: Number(ib.shownAt) || Date.now(),
    };
  }
  if (isObj(src.bottomBanner)) {
    const bb = src.bottomBanner;
    const name = cleanText(String(bb.name ?? ''), 40, '');
    if (BB_KINDS.includes(bb.kind) && name.trim()) {
      snap.bottomBanner = {
        id: typeof bb.id === 'string' && bb.id ? bb.id.slice(0, 20) : newId('bb'),
        kind: bb.kind,
        name,
        role: cleanText(String(bb.role ?? ''), 16, ''),
        teamName: cleanText(String(bb.teamName ?? ''), 26, ''),
        color: /^#[0-9a-fA-F]{6}$/.test(String(bb.color)) ? bb.color : '#FFFFFF',
        file: cleanText(String(bb.file ?? ''), 120, ''),
        group: ['A', 'B', 'OFF'].includes(bb.group) ? bb.group : '',
        entryId: typeof bb.entryId === 'string' ? bb.entryId.slice(0, 20) : '',
        shownAt: Number(bb.shownAt) || Date.now(),
      };
    }
  }
  if (isObj(src.roster)) {
    for (const key of ['A', 'B', 'officials']) {
      const roles = key === 'officials' ? OFF_ROLES : TEAM_ROLES;
      const list = Array.isArray(src.roster[key]) ? src.roster[key] : [];
      snap.roster[key] = list.filter(isObj).slice(0, 40)
        .map(e => cleanRosterEntry(e, roles)).filter(e => !isBlankEntry(e));
    }
  }
  return snap;
}

function sanitizeData(d) {
  const out = {};
  let n = 0;
  for (const k of Object.keys(isObj(d) ? d : {})) {
    if (++n > 16) break;
    const v = d[k];
    const key = String(k).slice(0, 24);
    if (typeof v === 'string') out[key] = cleanText(v, 240, '');
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

function cleanEntryPatch(src) {
  const out = {};
  if (src.utc != null && Number.isFinite(Number(src.utc))) out.utc = Math.max(0, Number(src.utc));
  if (src.clock != null && Number.isFinite(Number(src.clock))) out.clock = Math.max(0, Number(src.clock));
  if (typeof src.period === 'string') out.period = cleanText(src.period, 22, '');
  if (LOG_TYPES.includes(src.type)) out.type = src.type;
  if (isObj(src.data)) out.data = sanitizeData(src.data);
  return out;
}

function normalizeEntry(src) {
  const e = {
    id: newId('e'),
    utc: Date.now(),
    clock: 0,
    period: '',
    type: 'NOTE',
    data: {},
  };
  Object.assign(e, cleanEntryPatch(isObj(src) ? src : {}));
  return e;
}
/* like normalizeEntry but keeps a stored id */
function normalizeEntry0(src) {
  const e = normalizeEntry(src);
  if (isObj(src) && typeof src.id === 'string' && src.id) e.id = src.id.slice(0, 20);
  return e;
}

function newMatchRecord(snap) {
  const now = Date.now();
  return { id: newId('m'), createdAt: now, updatedAt: now, snap, log: [] };
}

function loadMatches() {
  const store = { activeId: null, matches: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf8'));
    if (isObj(saved) && Array.isArray(saved.matches)) {
      for (const m of saved.matches.slice(0, MAX_MATCHES)) {
        if (!isObj(m) || !isObj(m.snap)) continue;
        store.matches.push({
          id: typeof m.id === 'string' && m.id ? m.id.slice(0, 20) : newId('m'),
          createdAt: Number(m.createdAt) || Date.now(),
          updatedAt: Number(m.updatedAt) || Number(m.createdAt) || Date.now(),
          snap: sanitizeSnap(m.snap),
          log: Array.isArray(m.log) ? m.log.slice(0, MAX_LOG).filter(isObj).map(normalizeEntry0) : [],
        });
      }
      if (typeof saved.activeId === 'string') store.activeId = saved.activeId;
    }
  } catch { /* first run */ }
  if (!store.matches.some(m => m.id === store.activeId)) {
    store.activeId = store.matches.length ? store.matches[store.matches.length - 1].id : null;
  }
  for (const m of store.matches) sortLog(m);
  return store;
}

let matchesSaveTimer = null;
function persistMatches() {
  clearTimeout(matchesSaveTimer);
  matchesSaveTimer = setTimeout(() => {
    fs.writeFile(MATCHES_FILE, JSON.stringify(matchStore, null, 1), () => {});
  }, 500);
}

const matchStore = loadMatches();

function findMatch(id) {
  return matchStore.matches.find(m => m.id === String(id)) || null;
}
function activeMatch() {
  return findMatch(matchStore.activeId);
}
function sortLog(m) {
  m.log.sort((a, b) => a.utc - b.utc);
}

/* append an event to the ACTIVE match's log (replay-relevant actions only) */
function logEvent(type, data) {
  const m = activeMatch();
  if (!m) return;
  m.log.push({
    id: newId('e'),
    utc: Date.now(),
    clock: timerRemainingNow(),
    period: state.period.text,
    type,
    data: sanitizeData(data),
  });
  if (m.log.length > MAX_LOG) m.log.splice(0, m.log.length - MAX_LOG);
}

/* mirror the current match-scoped state into the active match record */
function syncMatchSnap() {
  const m = activeMatch();
  if (!m) return;
  m.snap = matchSnap();
  m.updatedAt = Date.now();
  persistMatches();
}

/* restore a match snapshot into the live state (display settings untouched).
 * A timer / suspension that was running keeps only the time it had actually
 * used up to the match's last update — it does not tick while unloaded. */
function applySnap(m) {
  const s = clone(m.snap);
  if (s.timer && s.timer.running) {
    s.timer.remainingMs = Math.max(0, Number(s.timer.remainingMs) - (m.updatedAt - Number(s.timer.refEpoch)));
    s.timer.running = false;
    s.timer.refEpoch = 0;
  }
  for (const b of s.banners || []) {
    if (b.type === 'SUSP2' && isObj(b.susp) && b.susp.running) {
      b.susp.msLeft = Math.max(0, Number(b.susp.msLeft) - (m.updatedAt - Number(b.susp.refEpoch)));
      b.susp.running = false;
      b.susp.refEpoch = 0;
    }
  }
  state.event.text = s.event.text;
  state.period.text = s.period.text;
  for (const k of MATCH_TIMER_KEYS) state.timer[k] = s.timer[k];
  state.teams = s.teams;
  state.banners = s.banners || [];
  state.infoBanner = s.infoBanner || null;
  state.bottomBanner = s.bottomBanner || null;
  state.roster = s.roster || clone(DEFAULT_STATE.roster);
  state.rosterDisplay.page = 0;
  scheduleTimerEnd();
}

/* reset the match-scoped fields for a freshly created match */
function freshMatchState() {
  const d = defaultSnap();
  state.event.text = d.event.text;
  state.period.text = d.period.text;
  for (const k of MATCH_TIMER_KEYS) state.timer[k] = d.timer[k];
  state.teams = d.teams;
  state.banners = [];
  state.infoBanner = null;
  state.bottomBanner = null;
  state.roster = d.roster;
  state.rosterDisplay = { mode: 'off', page: 0 };
  scheduleTimerEnd();
}

function matchPhase(m) {
  for (let i = m.log.length - 1; i >= 0; i--) {
    const e = m.log[i];
    if (e.type !== 'PHASE') continue;
    const ph = e.data && e.data.phase;
    if (ph === 'START') return 'LIVE';
    if (ph === 'PAUSE') return 'PAUSED';
    if (ph === 'BREAK') return 'BREAK';
    if (ph === 'MATCH_END') return 'ENDED';
  }
  return 'NEW';
}

function matchSummaries() {
  const pick = t => ({ name: t.name, short: t.short, color: t.color, score: t.score });
  return matchStore.matches.map(m => ({
    id: m.id,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    active: m.id === matchStore.activeId,
    eventText: m.snap.event.text,
    phase: matchPhase(m),
    logCount: m.log.length,
    durationMs: m.snap.timer.durationMs,
    teams: { A: pick(m.snap.teams.A), B: pick(m.snap.teams.B) },
  }));
}

/* boot: no library yet -> wrap the current live board into match #1 */
if (!matchStore.matches.length) {
  const m = newMatchRecord(matchSnap());
  matchStore.matches.push(m);
  matchStore.activeId = m.id;
}
syncSuspensions();   // align restored icons with the restored clock state
syncMatchSnap();     // state.json is the live truth after a restart — refresh the active snap

/* ---------------------------------------------------------------- actions */

function applyAction(action) {
  const type = String(action.type || '');
  let fx = null;
  let patchWatch = null;   // pre-patch values of the logged fields (period / event name)

  switch (type) {
    case 'patch': {
      if (isObj(action.patch)) {
        delete action.patch.banners;       // banners only via banner.* actions
        delete action.patch.infoBanner;    // info banner only via info.* actions
        delete action.patch.bottomBanner;  // bottom banner only via bottom.* actions
        delete action.patch.roster;        // roster only via roster.* actions
        delete action.patch.rosterDisplay; // ... same
        // (orgBanners / cornerLogos ARE patchable — plain display config like board.*)
        patchWatch = { period: state.period.text, event: state.event.text };
        deepMerge(state, action.patch);
      }
      break;
    }
    case 'goal': {
      const team = action.team === 'B' ? 'B' : 'A';
      const delta = Math.round(clamp(state.goalDelta, -19, 19)) || 1;
      const from = state.teams[team].score;
      state.teams[team].score = clamp(from + delta, 0, 199);
      logEvent('SCORE', { team, kind: 'goal', delta, from, to: state.teams[team].score });
      fx = { kind: 'goal', team, score: state.teams[team].score, delta };
      break;
    }
    case 'score.adjust': {
      const team = action.team === 'B' ? 'B' : 'A';
      const from = state.teams[team].score;
      state.teams[team].score = clamp(from + Math.round(Number(action.delta || 0)), 0, 199);
      if (state.teams[team].score !== from) {
        logEvent('SCORE', { team, kind: 'adjust', delta: state.teams[team].score - from, from, to: state.teams[team].score });
      }
      break;
    }
    case 'score.set': {
      const team = action.team === 'B' ? 'B' : 'A';
      const from = state.teams[team].score;
      state.teams[team].score = Math.round(clamp(action.value, 0, 199));
      if (state.teams[team].score !== from) {
        logEvent('SCORE', { team, kind: 'set', from, to: state.teams[team].score });
      }
      break;
    }
    case 'timer.start': {
      const was = state.timer.running;
      timerActions.start();
      if (!was && state.timer.running) logEvent('PHASE', { phase: 'START' });
      break;
    }
    case 'timer.pause': {
      const was = state.timer.running;
      timerActions.pause();
      if (was && !state.timer.running) logEvent('PHASE', { phase: 'PAUSE' });
      break;
    }
    case 'timer.reset': {
      timerActions.reset();
      logEvent('CLOCK', { op: 'reset', ms: state.timer.remainingMs });
      break;
    }
    case 'timer.set': {
      timerActions.set(action.remainingMs);
      logEvent('CLOCK', { op: 'set', ms: state.timer.remainingMs });
      break;
    }
    case 'timer.adjust': {
      timerActions.adjust(action.deltaMs);
      logEvent('CLOCK', { op: 'adjust', deltaMs: Number(action.deltaMs) || 0, ms: timerRemainingNow() });
      break;
    }
    case 'timer.duration': {
      // half duration is setup, not a replay event — change it, do NOT log it
      timerActions.duration(action.durationMs);
      break;
    }
    case 'timer.mode': {
      const prev = state.timer.mode;
      timerActions.mode(action.mode);
      if (state.timer.mode !== prev) {
        if (state.timer.mode === 'break') logEvent('PHASE', { phase: 'BREAK' });
        else if (state.timer.mode === 'matchEnd') logEvent('PHASE', { phase: 'MATCH_END' });
        else if (state.timer.mode === 'pause') logEvent('PHASE', { phase: 'PAUSE', word: true });
      }
      break;
    }
    case 'timer.direction': {
      if (['up', 'down'].includes(action.direction) && state.timer.direction !== action.direction) {
        state.timer.direction = action.direction;
        logEvent('CLOCK', { op: 'direction', direction: action.direction });
      }
      break;
    }
    case 'banner.show': {
      const team = action.team === 'B' ? 'B' : 'A';
      const btype = BANNER_TYPES.includes(action.bannerType) ? action.bannerType : 'FOUL';
      while (state.banners.length >= 6) dropBanner(state.banners[0].id);
      const now = Date.now();
      const banner = {
        id: 'b' + now.toString(36) + Math.random().toString(36).slice(2, 6),
        team, type: btype,
        createdAt: now,
      };
      if (btype === 'SUSP2') {
        const run = !!state.timer.running;
        banner.susp = { msLeft: SUSP2_MS, refEpoch: run ? now : 0, running: run };
      }
      state.banners.push(banner);
      logEvent('ICON', { op: 'show', team, icon: btype });
      break;
    }
    case 'banner.hide': {
      const b = state.banners.find(x => x.id === String(action.id));
      dropBanner(String(action.id));
      if (b) logEvent('ICON', { op: 'hide', team: b.team, icon: b.type });
      break;
    }
    case 'banner.clear': {
      if (state.banners.length) logEvent('ICON', { op: 'clear', count: state.banners.length });
      state.banners = [];
      break;
    }
    case 'info.show': {
      const cat = action.cat === 'CONTROL' ? 'CONTROL' : 'REFEREE';
      const hex = v => /^#[0-9a-fA-F]{6}$/.test(String(v));
      state.infoBanner = {
        id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        key: cleanText(String(action.key || ''), 24, ''),
        cat,
        title: (cleanText(String(action.title || ''), 30, '') || 'INFO').trim() || 'INFO',
        body: cleanText(String(action.body || ''), 240, '').trim(),
        tone: hex(action.tone) ? action.tone : (cat === 'CONTROL' ? '#2F6FED' : '#E0132F'),
        fg: hex(action.fg) ? action.fg : '#FFFFFF',
        shownAt: Date.now(),
      };
      logEvent('INFO', {
        op: 'show', key: state.infoBanner.key, cat,
        title: state.infoBanner.title, body: state.infoBanner.body,
        tone: state.infoBanner.tone, fg: state.infoBanner.fg,
      });
      break;
    }
    case 'info.hide': {
      if (state.infoBanner) logEvent('INFO', { op: 'hide', key: state.infoBanner.key, title: state.infoBanner.title });
      state.infoBanner = null;
      break;
    }
    /* ------------------------------------------------- bottom banner */
    case 'bottom.show': {
      // content is FROZEN here (Jason: 顯示當下凍結) — later roster / org edits
      // never change the card that is already on air
      const kind = action.kind;
      const bb = {
        id: 'bb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        kind, name: '', role: '', teamName: '', color: '#FFFFFF', file: '',
        shownAt: Date.now(),
      };
      if (kind === 'org') {
        const file = String(action.file || '');
        const meta = isObj(state.orgBanners) ? state.orgBanners[file] : null;
        if (!meta || !String(meta.name || '').trim()) {
          return { ok: false, error: '請先在機構橫幅設定中填寫該機構的名稱' };
        }
        bb.file = file;
        bb.name = meta.name;
        bb.role = meta.role || '';   // 位置為選填
      } else if (kind === 'person' || kind === 'official') {
        const group = kind === 'official' ? 'OFF' : (action.group === 'B' ? 'B' : 'A');
        const list = group === 'OFF' ? state.roster.officials : state.roster[group];
        const e = (list || []).find(x => x.id === String(action.entryId));
        if (!e || !String(e.name || '').trim()) return { ok: false, error: 'entry not found' };
        bb.group = group;      // provenance only (admin highlights the source chip)
        bb.entryId = e.id;
        bb.name = e.name;
        bb.role = e.role;
        if (kind === 'person') {
          bb.teamName = state.teams[group].name;
          bb.color = state.teams[group].color;
        }
      } else {
        return { ok: false, error: 'unknown banner kind' };
      }
      state.bottomBanner = bb;
      break;
    }
    case 'bottom.hide': {
      state.bottomBanner = null;
      break;
    }
    /* ------------------------------------------------------------ roster */
    case 'roster.add': {
      const group = ['A', 'B', 'OFF'].includes(action.group) ? action.group : 'A';
      const roles = group === 'OFF' ? OFF_ROLES : TEAM_ROLES;
      const list = group === 'OFF' ? state.roster.officials : state.roster[group];
      if (list.length >= 40) return { ok: false, error: 'roster full' };
      list.push({
        id: newId('p'),
        role: roles.includes(action.role) ? action.role : roles[roles.length - 1],
        name: cleanText(String(action.name ?? ''), 30, ''),
        num: cleanText(String(action.num ?? ''), 3, ''),
        pos: cleanText(String(action.pos ?? ''), 10, ''),
        title: cleanText(String(action.title ?? ''), 14, ''),
      });
      break;
    }
    case 'roster.update': {
      const group = ['A', 'B', 'OFF'].includes(action.group) ? action.group : 'A';
      const roles = group === 'OFF' ? OFF_ROLES : TEAM_ROLES;
      const list = group === 'OFF' ? state.roster.officials : state.roster[group];
      const e = list.find(x => x.id === String(action.id));
      if (!e) return { ok: false, error: 'entry not found' };
      if (action.role != null && roles.includes(action.role)) e.role = action.role;
      if (action.name != null) e.name = cleanText(String(action.name), 30, e.name);
      if (action.num != null) e.num = cleanText(String(action.num), 3, e.num);
      if (action.pos != null) e.pos = cleanText(String(action.pos), 10, e.pos);
      if (action.title != null) e.title = cleanText(String(action.title), 14, e.title);
      break;
    }
    case 'roster.remove': {
      const group = ['A', 'B', 'OFF'].includes(action.group) ? action.group : 'A';
      const key = group === 'OFF' ? 'officials' : group;
      state.roster[key] = state.roster[key].filter(x => x.id !== String(action.id));
      break;
    }
    case 'roster.display': {
      if (['off', 'A', 'B', 'both'].includes(action.mode)) state.rosterDisplay.mode = action.mode;
      break;
    }
    case 'roster.page': {
      state.rosterDisplay.page = Math.round(clamp(action.page, 0, 99));
      break;
    }
    /* ------------------------------------------------------------ matches */
    case 'match.create': {
      if (matchStore.matches.length >= MAX_MATCHES) return { ok: false, error: 'match library full' };
      syncMatchSnap();               // seal the outgoing match first
      freshMatchState();
      const m = newMatchRecord(matchSnap());
      matchStore.matches.push(m);
      matchStore.activeId = m.id;
      break;
    }
    case 'match.load': {
      const m = findMatch(action.id);
      if (!m) return { ok: false, error: 'match not found' };
      if (m.id !== matchStore.activeId) {
        syncMatchSnap();             // seal the outgoing match
        matchStore.activeId = m.id;
        applySnap(m);
      }
      break;
    }
    case 'match.delete': {
      const id = String(action.id);
      if (id === matchStore.activeId) return { ok: false, error: 'cannot delete the active match' };
      const before = matchStore.matches.length;
      matchStore.matches = matchStore.matches.filter(m => m.id !== id);
      if (matchStore.matches.length === before) return { ok: false, error: 'match not found' };
      persistMatches();
      break;
    }
    case 'match.import': {
      const p = action.payload;
      const list = isObj(p) && Array.isArray(p.matches) ? p.matches
        : (isObj(p) && isObj(p.match) ? [p.match]
        : (isObj(p) && isObj(p.snap) ? [p] : null));
      if (!list) return { ok: false, error: '無法識別的檔案格式' };
      let added = 0;
      for (const src of list) {
        if (!isObj(src) || !isObj(src.snap)) continue;
        if (matchStore.matches.length >= MAX_MATCHES) break;
        const m = {
          id: newId('m'),           // always a fresh id — imports never collide
          createdAt: Number(src.createdAt) || Date.now(),
          updatedAt: Number(src.updatedAt) || Number(src.createdAt) || Date.now(),
          snap: sanitizeSnap(src.snap),
          log: Array.isArray(src.log) ? src.log.slice(0, MAX_LOG).filter(isObj).map(normalizeEntry) : [],
        };
        sortLog(m);
        matchStore.matches.push(m);
        added++;
      }
      if (!added) return { ok: false, error: '檔案中沒有有效的對局' };
      persistMatches();
      break;
    }
    case 'settings.import': {
      const s = isObj(action.settings) ? action.settings : null;
      if (!s) return { ok: false, error: '無法識別的檔案格式' };
      if (isObj(s.board)) deepMerge(state.board, s.board);
      if (s.goalDelta != null) state.goalDelta = s.goalDelta;
      if (isObj(s.timerPrefs)) {
        for (const k of TIMER_PREF_KEYS) {
          if (typeof s.timerPrefs[k] === 'boolean') state.timer[k] = s.timerPrefs[k];
        }
      }
      if (Array.isArray(s.cornerLogos)) state.cornerLogos = clone(s.cornerLogos);
      if (isObj(s.orgBanners)) state.orgBanners = clone(s.orgBanners);
      break;
    }
    /* --------------------------------------------------------- log editing */
    case 'match.log.update': {
      const m = findMatch(action.id);
      if (!m) return { ok: false, error: 'match not found' };
      const e = m.log.find(x => x.id === String(action.entryId));
      if (!e) return { ok: false, error: 'entry not found' };
      Object.assign(e, cleanEntryPatch(isObj(action.entry) ? action.entry : {}));
      sortLog(m);
      m.updatedAt = Date.now();
      persistMatches();
      break;
    }
    case 'match.log.insert': {
      const m = findMatch(action.id);
      if (!m) return { ok: false, error: 'match not found' };
      if (m.log.length >= MAX_LOG) return { ok: false, error: 'log full' };
      m.log.push(normalizeEntry(action.entry));
      sortLog(m);
      m.updatedAt = Date.now();
      persistMatches();
      break;
    }
    case 'match.log.delete': {
      const m = findMatch(action.id);
      if (!m) return { ok: false, error: 'match not found' };
      m.log = m.log.filter(x => x.id !== String(action.entryId));
      m.updatedAt = Date.now();
      persistMatches();
      break;
    }
    case 'match.log.clear': {
      const m = findMatch(action.id);
      if (!m) return { ok: false, error: 'match not found' };
      m.log = [];
      m.updatedAt = Date.now();
      persistMatches();
      break;
    }
    /* -------------------------------------------------------------- resets */
    case 'reset.match': {
      logEvent('RESET', { op: 'match' });
      state.teams.A.score = 0;
      state.teams.B.score = 0;
      state.banners = [];
      state.infoBanner = null;
      state.bottomBanner = null;
      state.period = clone(DEFAULT_STATE.period);
      state.timer.running = false;
      state.timer.mode = 'clock';
      state.timer.direction = DEFAULT_STATE.timer.direction;
      state.timer.remainingMs = state.timer.durationMs;
      state.timer.autoPauseWord = DEFAULT_STATE.timer.autoPauseWord;
      state.timer.pauseAlternate = DEFAULT_STATE.timer.pauseAlternate;
      state.timer.autoEndMode = DEFAULT_STATE.timer.autoEndMode;
      state.timer.endAlternate = DEFAULT_STATE.timer.endAlternate;
      if (state.board.tier === 'full') state.board.tier = 'large';
      scheduleTimerEnd();
      break;
    }
    case 'reset.factory': {
      logEvent('RESET', { op: 'factory' });
      state = clone(DEFAULT_STATE);
      scheduleTimerEnd();
      break;
    }
    default:
      return { ok: false, error: 'unknown action: ' + type };
  }

  syncSuspensions(); // any action may have flipped timer.running
  sanitize();
  /* patch-driven changes that belong in the match log (period / event name only —
   * team setup + half duration are setup, kept only as final state) */
  if (patchWatch) {
    if (patchWatch.period !== state.period.text) {
      logEvent('PERIOD', { from: patchWatch.period, to: state.period.text });
    }
    if (patchWatch.event !== state.event.text) {
      logEvent('EVENT_NAME', { from: patchWatch.event, to: state.event.text });
    }
  }
  syncMatchSnap();
  persist();
  broadcast(fx);
  return { ok: true };
}

/* ------------------------------------------------------------------ assets */
/* enumerate the banner / corner image folders — the admin picks from these lists.
 * Cached briefly so SSE broadcasts don't hit the disk on every action. */

const ASSET_DIRS = {
  banner: path.join(PUBLIC_DIR, 'assets', 'banner'),
  corner: path.join(PUBLIC_DIR, 'assets', 'corner'),
};
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp']);
let assetsCache = { at: 0, list: { banner: [], corner: [] } };
function listAssets() {
  if (Date.now() - assetsCache.at < 5000) return assetsCache.list;
  const list = { banner: [], corner: [] };
  for (const key of Object.keys(ASSET_DIRS)) {
    try {
      list[key] = fs.readdirSync(ASSET_DIRS[key])
        .filter(f => IMG_EXTS.has(path.extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    } catch { list[key] = []; }
  }
  assetsCache = { at: Date.now(), list };
  return list;
}

/* -------------------------------------------------------------------- sse */

const sseClients = new Set();

function snapshot(fx) {
  return {
    state,
    serverNow: Date.now(),
    fx: fx || null,
    matches: matchSummaries(),
    activeMatchId: matchStore.activeId,
    assets: listAssets(),
  };
}
function broadcast(fx) {
  const msg = `data: ${JSON.stringify(snapshot(fx))}\n\n`;
  for (const res of sseClients) res.write(msg);
}
setInterval(() => { for (const res of sseClients) res.write(': ping\n\n'); }, 25000).unref();

/* ------------------------------------------------------------------- http */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(res, urlPath) {
  // asset filenames are CJK — URLs arrive percent-encoded and must be decoded first
  let decoded = urlPath;
  try { decoded = decodeURIComponent(urlPath); } catch { /* malformed escape — use as-is */ }
  const safe = path.normalize(decoded).replace(/^([.]{2}[/\\])+/, '').replace(/^[/\\]+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'max-age=86400' : 'no-cache',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      // match imports carry whole logs — allow a few MB (localhost / LAN only)
      if (body.length > 4 * 1024 * 1024) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' ) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
  if (p === '/admin') return serveStatic(res, '/admin/admin.html');
  if (p === '/overlay') return serveStatic(res, '/overlay/overlay.html');

  if (p === '/api/state') {
    return sendJSON(res, 200, snapshot());
  }
  if (p === '/api/match') {
    const m = findMatch(url.searchParams.get('id'));
    if (!m) return sendJSON(res, 404, { ok: false, error: 'match not found' });
    return sendJSON(res, 200, { ok: true, match: m, activeMatchId: matchStore.activeId, serverNow: Date.now() });
  }
  if (p === '/api/matches') {
    return sendJSON(res, 200, { ok: true, activeId: matchStore.activeId, matches: matchStore.matches });
  }
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1200\n\n');
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (p === '/api/action' && req.method === 'POST') {
    try {
      const action = JSON.parse(await readBody(req) || '{}');
      const result = applyAction(action);
      return sendJSON(res, result.ok ? 200 : 400, { ...result, serverNow: Date.now() });
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  return serveStatic(res, p);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。可能服务器已经在运行了？`);
    console.error(`  如需换端口：  set PORT=3691 && node server.js\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const lanIPs = Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────┐');
  console.log('  │            SCOREBOARD-X  ·  handball overlay        │');
  console.log('  └─────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`   OBS 浏览器源 (1080x1920):  http://localhost:${PORT}/overlay`);
  console.log(`   控制台 (本机):             http://localhost:${PORT}/admin`);
  for (const ip of lanIPs) {
    console.log(`   控制台 (手机, 同一WiFi):    http://${ip}:${PORT}/admin`);
  }
  console.log('');
  console.log('   按 Ctrl+C 停止服务器。状态保存于 state.json，对局库保存于 matches.json。');
  console.log('');
});
