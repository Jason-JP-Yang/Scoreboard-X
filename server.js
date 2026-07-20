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
    tier: 'large',            // off | small | large | full | preparing
    nameMode: { small: 'short', large: 'short', full: 'short' }, // short | full per tier
    flagShow: { small: true, large: true, full: true },          // show team flags per tier (preparing follows full)
    eventMode: { small: 'full', large: 'full', full: 'full' },   // event name style per tier: full | short (preparing follows full)
    scale: 1,                 // overall overlay scale (0.7 - 1.4)
    margin: 36,               // distance from top/left edge, stage px (can be negative)
    goalEffect: 'full',       // goal expand: 'minimal' | 'partial' (scorer row only) | 'full' (both rows)
    goalExpandSec: 8,         // ... for this many seconds (partial / full)
    ambient: true,            // subtle idle motion
    driftSpeed: 3,            // facet drift speed multiplier (0.1 - 3.0)
    clockVisible: true,       // show clock + period on overlay
  },
  event: { text: 'HANDBALL CUP 2026', short: 'HANDBALL 2026', visible: true },
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
    endAlternate: false,      // alternate END word and 0.00 time
  },
  goalDelta: 1,               // points added by the GOAL button (-19 .. 19, not 0)
  teams: {
    A: { name: 'OGC NICE', short: 'NICE', color: '#D6152C', score: 0, flag: '' },
    B: { name: 'RC LENS', short: 'LENS', color: '#F6C500', score: 0, flag: '' },
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
  /* automation prefs (global, exported with settings). All OFF by default —
   * icons keep the manual-removal philosophy unless explicitly enabled.
   * 計時聯動/資訊橫幅聯動 (2026-07-17): every feature is its OWN switch; all the
   * "wait N s" delays are measured FROM THE TRIGGER, never chained. */
  automation: {
    /* --- 事件圖標 --- */
    timeoutCountdown: false,   // TIMEOUT icon carries a 60s real-time countdown tape
    timeoutAutoPause: false,   // showing a TIMEOUT icon pauses the match clock
    timeoutAutoRemove: false,  // remove the TIMEOUT icon when its 60s run out
    suspAutoRemove: false,     // remove a SUSP2 icon when the 2-min penalty hits 0
    suspExpireBanner: false,   // auto-show a SUSPENSION EXPIRED info banner at expiry
    iconBanner: false,         // showing an event icon auto-shows the matching info banner
    /* --- 計時聯動 --- */
    pausePreselect: false,     // 暫停 → admin 預選 TEAM TIME-OUT ＋捲動（client-side 行為）
    pauseBoard: 'off',         // 暫停 +1s → 顯示 full|large 計分板（off = 不動）
    pauseSeq: false,           // 暫停 +1s → 播放底部橫幅序列（與 pauseBoard:'full' 互斥）
    halfEndFlow: false,        // 1ST HALF 歸零 +1s → BREAK＋HALFTIME 節次＋HALF-TIME 橫幅
    halfEndBoard: 'off',       // 1ST HALF 歸零 +2s → full|large
    halfEndSeq: false,         // 1ST HALF 歸零 +2s → 播放序列（互斥同上）
    halftimeArm: false,        // HALFTIME 中重置計時 → 2ND HALF＋小型＋比賽計時＋RESUME 橫幅
    matchEndFlow: false,       // 2ND HALF 歸零 +1s → MATCH END＋FULL-TIME 橫幅
    matchEndBoard: 'off',      // 2ND HALF 歸零 +2s → full|large
    matchEndSeq: false,        // 2ND HALF 歸零 +2s → 播放序列（互斥同上）
    matchEndTieSuppress: false,// 平手時抑制整組下半場結束自動化（加時由操作者接手）
    endHidePeriod: false,      // 進入/離開 MATCH END → 隱藏/顯示節次（僅在轉換邊沿動作）
    last30Banner: false,       // 2ND HALF / OT 剩餘跨過 30 秒 → LAST 30S 橫幅
    timeCalibBanner: false,    // BREAK/PAUSE 中校時 → TIME CALIBRATION 橫幅（每段最多一次）
    resumeCleanup: false,      // 恢復計時 → 移除 TIMEOUT 圖標；+1s 移除 TIMEOUT/MEDICAL 橫幅
    /* --- 資訊橫幅聯動 --- */
    infoIcon: false,           // 顯示含球隊的橫幅 → 自動掛出對應事件圖標
    infoTimeoutPause: false,   // TEAM TIME-OUT 橫幅 → 自動暫停計時
    infoTimeoutResume: false,  // TEAM TIME-OUT 橫幅 +45s → RESUME 橫幅（計時仍暫停才顯示）
    infoMedicalPause: false,   // MEDICAL TIME-OUT 橫幅 → 自動暫停計時
    /* --- 橫幅／名單 --- */
    infoAutoHide: false, infoAutoHideSec: 12,     // info banner fades after N s
    bottomAutoHide: false, bottomAutoHideSec: 12, // bottom banner fades after N s
    rosterAutoFlip: false, rosterAutoFlipSec: 8,  // roster pages advance every N s (wraps)
  },
  /* bottom-banner display sequence (match-scoped — items reference roster ids).
   * Playback progress is runtime-only (bbSeqRun module var): a restart stops it. */
  bbSeq: { items: [], intervalSec: 10, loop: false },
  /* admin keyboard shortcuts (global display config, settings-exported): map of
   * client-defined action id -> key combo string (e.g. "Shift+KeyA"). Replaced
   * wholesale via the hotkeys.set action; the admin owns the id namespace. */
  hotkeys: {},
  /* 回放（REPLAY）— 顯示層 runtime 狀態，不屬於對局快照。播放頭是 UTC 軸上的
   * 「假時間」，完全由操作者控制；比賽計時器不受回放影響（人手控制照舊）。
   * tier 僅 off | small | large（全畫幅在回放中不可用）；showScores 關閉時
   * 計分板收起兩隊列，只剩賽事名稱＋時間。重啟後保持進入狀態但強制暫停。 */
  replay: {
    active: false,
    tier: 'large',            // off | small | large
    showScores: true,
    playing: false,
    headUtc: 0,               // playhead：playing 時為 refEpoch 當下的值，暫停時為絕對值
    refEpoch: 0,
  },
};

const BANNER_TYPES = ['FOUL', 'TIMEOUT', 'SUSP2', 'YELLOW', 'RED', 'BLUE', 'MEDICAL'];
const SUSP2_MS = 120000;      // 2-minute suspension countdown, runs on playing time (freezes with the match clock)
const TIMEOUT_MS = 60000;     // team timeout countdown, runs on REAL time (the match clock is stopped anyway)
const TEAM_ROLES = ['LEADER', 'COACH', 'STAFF', 'PLAYER'];
/* 賽事人員 roles: commentators / referees / guests, plus the four placings
 * (CHAMPION..FOURTH) whose "name" is a TEAM name and whose title is the 組別 */
const OFF_ROLES = ['COMMENTATOR', 'REFEREE', 'VIP', 'GUEST', 'CHAMPION', 'RUNNER_UP', 'THIRD', 'FOURTH'];
const ROSTER_TITLE_MAX = 50;   // 職稱 (Jason 2026-07-17: 加長到 50，容得下組別／獎項全名)
const BB_KINDS = ['person', 'official', 'org'];   // org 位置(role)為選填自由文字
const MAX_CORNER_LOGOS = 3;
/* logged event types. Team setup + half-duration are intentionally NOT here —
 * they are setup, kept only as final state in the snapshot (like the roster). */
const LOG_TYPES = ['PHASE', 'SCORE', 'ICON', 'INFO', 'CLOCK', 'PERIOD', 'EVENT_NAME', 'RESET', 'NOTE'];
const PHASES = ['START', 'PAUSE', 'BREAK', 'MATCH_END'];
const TIMER_PREF_KEYS = ['autoPauseWord', 'pauseAlternate', 'endAlternate'];
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
    title: cleanText(String(e.title ?? ''), ROSTER_TITLE_MAX, ''),
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
    // 2026-07-17: autoExpandBreak/autoEndMode 由計時聯動自動化取代；階段流程整個移除
    delete base.board.autoExpandBreak;
    delete base.timer.autoEndMode;
    delete base.flow;
    delete base.flowIdx;
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
    /* 回放：重啟後 refEpoch 已過期 — 保持進入狀態，但強制暫停在原播放頭 */
    if (isObj(base.replay)) { base.replay.playing = false; base.replay.refEpoch = 0; }
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
  if (!['off', 'small', 'large', 'full', 'preparing'].includes(b.tier)) b.tier = 'large';
  {
    const norm = m => (['short', 'full'].includes(m) ? m : 'short');
    const nm = b.nameMode;
    if (typeof nm === 'string') b.nameMode = { small: norm(nm), large: norm(nm), full: norm(nm) };
    else if (isObj(nm)) b.nameMode = { small: norm(nm.small), large: norm(nm.large), full: norm(nm.full) };
    else b.nameMode = { small: 'short', large: 'short', full: 'short' };
  }
  {
    // per-tier flag visibility (default on; preparing follows full)
    const fs0 = isObj(b.flagShow) ? b.flagShow : {};
    const on = v => v !== false;   // default true when unset
    b.flagShow = { small: on(fs0.small), large: on(fs0.large), full: on(fs0.full) };
  }
  {
    // per-tier event-name style (full | short; default full; preparing follows full)
    const norm = m => (['short', 'full'].includes(m) ? m : 'full');
    const em = b.eventMode;
    if (typeof em === 'string') b.eventMode = { small: norm(em), large: norm(em), full: norm(em) };
    else if (isObj(em)) b.eventMode = { small: norm(em.small), large: norm(em.large), full: norm(em.full) };
    else b.eventMode = { small: 'full', large: 'full', full: 'full' };
  }
  delete b.visible;
  delete b.expanded;
  delete b.autoExpandBreak;        // superseded by automation.pauseBoard 等（舊設定檔匯入時清掉）
  delete state.timer.autoEndMode;  // superseded by automation.matchEndFlow
  delete state.flow;               // 階段流程已整個移除
  delete state.flowIdx;
  b.scale = clamp(b.scale, 0.6, 1.6);
  b.margin = Math.round(clamp(b.margin, -300, 300));
  b.goalExpandSec = clamp(b.goalExpandSec, 2, 30);
  if (b.goalEffect == null && 'autoExpandGoal' in b) b.goalEffect = b.autoExpandGoal ? 'full' : 'minimal';
  if (!['minimal', 'partial', 'full'].includes(b.goalEffect)) b.goalEffect = 'full';
  delete b.autoExpandGoal;
  state.goalDelta = Math.round(clamp(state.goalDelta, -19, 19)) || 1;
  state.event.text = cleanText(state.event.text, 100, DEFAULT_STATE.event.text);
  state.event.short = cleanText(state.event.short, 50, '');
  state.period.text = cleanText(state.period.text, 22, DEFAULT_STATE.period.text);
  for (const key of ['A', 'B']) {
    const t = state.teams[key];
    t.name = cleanText(t.name, 26, DEFAULT_STATE.teams[key].name);
    t.short = cleanText(t.short, 8, DEFAULT_STATE.teams[key].short) || t.name.slice(0, 4).toUpperCase();
    t.score = Math.round(clamp(t.score, 0, 199));
    if (!/^#[0-9a-fA-F]{6}$/.test(String(t.color))) t.color = DEFAULT_STATE.teams[key].color;
    t.flag = cleanText(String(t.flag ?? ''), 160, '');   // assets/flag/<file>, empty = none
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
      bb.num = cleanText(String(bb.num ?? ''), 3, '');
      bb.pos = cleanText(String(bb.pos ?? ''), 10, '');
      bb.title = cleanText(String(bb.title ?? ''), ROSTER_TITLE_MAX, '');
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
  /* automation prefs — booleans coerced, enums validated, second-sliders clamped */
  {
    const a = isObj(state.automation) ? state.automation : {};
    const board3 = v => (['off', 'full', 'large'].includes(v) ? v : 'off');
    state.automation = {
      timeoutCountdown: !!a.timeoutCountdown,
      timeoutAutoPause: !!a.timeoutAutoPause,
      timeoutAutoRemove: !!a.timeoutAutoRemove,
      suspAutoRemove: !!a.suspAutoRemove,
      suspExpireBanner: !!a.suspExpireBanner,
      iconBanner: !!a.iconBanner,
      pausePreselect: !!a.pausePreselect,
      pauseBoard: board3(a.pauseBoard),
      pauseSeq: !!a.pauseSeq,
      halfEndFlow: !!a.halfEndFlow,
      halfEndBoard: board3(a.halfEndBoard),
      halfEndSeq: !!a.halfEndSeq,
      halftimeArm: !!a.halftimeArm,
      matchEndFlow: !!a.matchEndFlow,
      matchEndBoard: board3(a.matchEndBoard),
      matchEndSeq: !!a.matchEndSeq,
      matchEndTieSuppress: !!a.matchEndTieSuppress,
      endHidePeriod: !!a.endHidePeriod,
      last30Banner: !!a.last30Banner,
      timeCalibBanner: !!a.timeCalibBanner,
      resumeCleanup: !!a.resumeCleanup,
      infoIcon: !!a.infoIcon,
      infoTimeoutPause: !!a.infoTimeoutPause,
      infoTimeoutResume: !!a.infoTimeoutResume,
      infoMedicalPause: !!a.infoMedicalPause,
      infoAutoHide: !!a.infoAutoHide,
      infoAutoHideSec: Math.round(clamp(a.infoAutoHideSec ?? 12, 5, 60)),
      bottomAutoHide: !!a.bottomAutoHide,
      bottomAutoHideSec: Math.round(clamp(a.bottomAutoHideSec ?? 12, 5, 60)),
      rosterAutoFlip: !!a.rosterAutoFlip,
      rosterAutoFlipSec: Math.round(clamp(a.rosterAutoFlipSec ?? 8, 5, 30)),
    };
    /* 自動展示「全畫幅」與自動播放序列互斥（底部橫幅在全畫幅下讓位）。admin 在點擊
     * 時已互相對開；這裡是最後防線，擋掉舊設定檔匯入等途徑弄出的衝突組合。 */
    const q = state.automation;
    if (q.pauseBoard === 'full') q.pauseSeq = false;
    if (q.halfEndBoard === 'full') q.halfEndSeq = false;
    if (q.matchEndBoard === 'full') q.matchEndSeq = false;
  }
  /* bottom-banner sequence (match-scoped config; playback itself is runtime) */
  {
    const q = isObj(state.bbSeq) ? state.bbSeq : {};
    const items = (Array.isArray(q.items) ? q.items : []).filter(isObj).slice(0, 30).map(it => ({
      kind: BB_KINDS.includes(it.kind) ? it.kind : 'person',
      group: ['A', 'B', 'OFF'].includes(it.group) ? it.group : '',
      entryId: typeof it.entryId === 'string' ? it.entryId.slice(0, 20) : '',
      file: cleanText(String(it.file ?? ''), 120, ''),
    }));
    state.bbSeq = {
      items,
      intervalSec: Math.round(clamp(q.intervalSec ?? 10, 3, 60)),
      loop: !!q.loop,
    };
  }
  /* keyboard shortcuts: string→string map, both sides capped, whole thing capped */
  {
    const src = isObj(state.hotkeys) ? state.hotkeys : {};
    const out = {};
    let n = 0;
    for (const k of Object.keys(src)) {
      if (++n > 120) break;
      const v = src[k];
      if (typeof v !== 'string' || !v.trim()) continue;
      out[String(k).slice(0, 40)] = v.slice(0, 40);
    }
    state.hotkeys = out;
  }
  /* 回放狀態 — enum / boolean / number 全面驗證（patch 不可直達，僅 replay.* 動作） */
  {
    const r = isObj(state.replay) ? state.replay : {};
    state.replay = {
      active: !!r.active,
      tier: ['off', 'small', 'large'].includes(r.tier) ? r.tier : 'large',
      showScores: r.showScores !== false,
      playing: !!r.playing,
      headUtc: Number.isFinite(Number(r.headUtc)) ? Math.max(0, Number(r.headUtc)) : 0,
      refEpoch: Number.isFinite(Number(r.refEpoch)) ? Math.max(0, Number(r.refEpoch)) : 0,
    };
  }
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
    /* the buzzer itself only stops the clock — words / period / banners / view
     * are the 計時聯動 automation's job now (delayed steps, each self-guarded) */
    logEvent('PHASE', { phase: 'PAUSE', auto: true });
    fireTimeEndAutomation();
    afterAutoChange({ kind: 'timeend' });
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

/* ------------------------------------------------- automation schedulers */
/* Auto-hide banners: one pending timeout per banner, re-armed after every
 * action and at boot. Firing behaves like the manual hide action (the info
 * banner logs, the bottom banner does not — same as manual) and pushes a
 * fresh snapshot to every client. */
let infoHideTimer = null;
let bottomHideTimer = null;
function scheduleBannerAutoHide() {
  const a = state.automation;
  clearTimeout(infoHideTimer);
  infoHideTimer = null;
  const ib = state.infoBanner;
  if (a.infoAutoHide && ib) {
    const id = ib.id;
    const due = (Number(ib.shownAt) || Date.now()) + a.infoAutoHideSec * 1000;
    infoHideTimer = setTimeout(() => {
      const cur = state.infoBanner;
      if (!state.automation.infoAutoHide || !cur || cur.id !== id) return;
      logEvent('INFO', { op: 'hide', key: cur.key, title: cur.title, auto: true });
      state.infoBanner = null;
      afterAutoChange();
    }, Math.max(0, due - Date.now()) + 20);
  }
  clearTimeout(bottomHideTimer);
  bottomHideTimer = null;
  const bb = state.bottomBanner;
  if (a.bottomAutoHide && bb && !bbSeqRun) {   // a running sequence owns its own timing
    const id = bb.id;
    const due = (Number(bb.shownAt) || Date.now()) + a.bottomAutoHideSec * 1000;
    bottomHideTimer = setTimeout(() => {
      const cur = state.bottomBanner;
      if (!state.automation.bottomAutoHide || !cur || cur.id !== id) return;
      state.bottomBanner = null;
      afterAutoChange();
    }, Math.max(0, due - Date.now()) + 20);
  }
}

/* SUSP2 expiry (runs on playing time — armed only while the countdown ticks).
 * One timeout for the earliest running suspension; firing re-arms for the next.
 * suspFiredIds stops a banner-only fire (icon kept on screen) from re-firing:
 * in-memory on purpose — after a restart the 2s staleness grace covers it. */
let suspTimer = null;
const suspFiredIds = new Set();
function scheduleSuspExpiry() {
  const a = state.automation;
  clearTimeout(suspTimer);
  suspTimer = null;
  const alive = new Set(state.banners.map(b => b.id));
  for (const id of suspFiredIds) if (!alive.has(id)) suspFiredIds.delete(id);
  if (!a.suspAutoRemove && !a.suspExpireBanner) return;
  let next = Infinity, nextId = null;
  for (const b of state.banners) {
    if (b.type !== 'SUSP2' || !isObj(b.susp) || !b.susp.running) continue;
    if (suspFiredIds.has(b.id)) continue;
    const due = Number(b.susp.refEpoch) + Number(b.susp.msLeft);
    if (due < Date.now() - 2000) continue;   // expired long ago — never fire late
    if (due < next) { next = due; nextId = b.id; }
  }
  if (!nextId) return;
  suspTimer = setTimeout(() => {
    const a2 = state.automation;
    const b = state.banners.find(x => x.id === nextId);
    if (!b || b.type !== 'SUSP2' || !isObj(b.susp) || suspRemaining(b) > 0) {
      scheduleSuspExpiry();   // removed / clock paused meanwhile — re-evaluate
      return;
    }
    suspFiredIds.add(b.id);
    if (a2.suspExpireBanner) {
      const short = (state.teams[b.team].short || b.team).toUpperCase();
      const c = scoreCtx();
      setInfoBanner({
        key: 'SUSP_EXPIRED', cat: 'REFEREE', title: 'SUSPENSION EXPIRED',
        tone: '#0E9E64', fg: '#FFFFFF', team: b.team,
        body: `${short} 罰時結束，球員歸隊，恢復滿員應戰；目前比分 ${c.a}:${c.b}。`,
      });
    }
    if (a2.suspAutoRemove) {
      dropBanner(b.id);
      logEvent('ICON', { op: 'hide', team: b.team, icon: 'SUSP2', auto: true });
    }
    afterAutoChange();
  }, Math.max(0, next - Date.now()) + 30);
}

/* TIMEOUT expiry (real time). Armed only while auto-remove is enabled; the
 * removal deletes the banner, so no fired-marker is needed. */
let toutTimer = null;
function scheduleTimeoutExpiry() {
  clearTimeout(toutTimer);
  toutTimer = null;
  if (!state.automation.timeoutAutoRemove) return;
  let next = Infinity, nextId = null;
  for (const b of state.banners) {
    if (b.type !== 'TIMEOUT' || !isObj(b.tout)) continue;
    const due = Number(b.tout.endsAt);
    if (!Number.isFinite(due) || due < Date.now() - 2000) continue;   // stale — never fire late
    if (due < next) { next = due; nextId = b.id; }
  }
  if (!nextId) return;
  toutTimer = setTimeout(() => {
    const b = state.banners.find(x => x.id === nextId);
    if (!b || !state.automation.timeoutAutoRemove) { scheduleTimeoutExpiry(); return; }
    dropBanner(b.id);
    logEvent('ICON', { op: 'hide', team: b.team, icon: 'TIMEOUT', auto: true });
    afterAutoChange();
  }, Math.max(0, next - Date.now()) + 30);
}

/* roster auto-flip: page++ (wrap) every N s while a roster mode is on and the
 * overlay reported more than one page. The next fire time survives re-arms so
 * frequent actions don't postpone it; manual paging restarts the cadence. */
let rosterPageCount = 1;   // ephemeral — reported live by the overlay
let rosterFlipTimer = null;
let rosterFlipAt = 0;
function scheduleRosterFlip() {
  const a = state.automation;
  clearTimeout(rosterFlipTimer);
  rosterFlipTimer = null;
  const active = a.rosterAutoFlip && state.rosterDisplay.mode !== 'off' && rosterPageCount > 1;
  if (!active) { rosterFlipAt = 0; return; }
  if (!rosterFlipAt) rosterFlipAt = Date.now() + a.rosterAutoFlipSec * 1000;
  rosterFlipTimer = setTimeout(() => {
    const a2 = state.automation;
    if (!(a2.rosterAutoFlip && state.rosterDisplay.mode !== 'off' && rosterPageCount > 1)) {
      rosterFlipAt = 0;
      return;
    }
    const cur = Math.round(Number(state.rosterDisplay.page) || 0);
    state.rosterDisplay.page = (cur + 1) % Math.max(1, rosterPageCount);
    rosterFlipAt = Date.now() + a2.rosterAutoFlipSec * 1000;
    afterAutoChange();
  }, Math.max(0, rosterFlipAt - Date.now()) + 10);
}

/* bottom-banner sequence player. bbSeqRun is runtime-only ({ idx }): playback
 * stops on a server restart and on any manual bottom.show / bottom.hide. The
 * current card's shownAt anchors the cadence. */
let bbSeqTimer = null;
let bbSeqRun = null;

/* step the sequence onto entry idx (skipping items that no longer resolve —
 * removed roster people, unnamed orgs). Returns false when the run ends. */
function bbSeqShowFrom(idx) {
  const seq = state.bbSeq;
  const n = seq.items.length;
  if (!n) { bbSeqRun = null; return false; }
  let i = idx;
  for (let tries = 0; tries < n; tries++) {
    if (i >= n) {
      if (!seq.loop) break;
      i = 0;
    }
    const r = resolveBottomBanner(seq.items[i] || {});
    if (r.bb) {
      state.bottomBanner = r.bb;
      bbSeqRun = { idx: i };
      return true;
    }
    i++;
  }
  bbSeqRun = null;
  return false;
}

function scheduleBbSeq() {
  clearTimeout(bbSeqTimer);
  bbSeqTimer = null;
  if (!bbSeqRun) return;
  if (!state.bottomBanner) { bbSeqRun = null; return; }   // hidden some other way
  const due = (Number(state.bottomBanner.shownAt) || Date.now()) + state.bbSeq.intervalSec * 1000;
  bbSeqTimer = setTimeout(() => {
    if (!bbSeqRun || !state.bottomBanner) { bbSeqRun = null; return; }
    const showing = bbSeqShowFrom(bbSeqRun.idx + 1);
    if (!showing) state.bottomBanner = null;   // run finished — clear the last card
    afterAutoChange();
  }, Math.max(0, due - Date.now()) + 20);
}

/* ------------------------------------------------- 計時聯動 automation engine */
/* Design (Jason 2026-07-17):
 *   - every feature = its OWN toggle; delays measured FROM THE TRIGGER, never
 *     chained (上半場結束: +1s BREAK＋節次＋橫幅 together, +2s 畫面/序列).
 *   - delayed steps live in autoTimers and re-check their preconditions when
 *     they fire, so an operator intervention silently cancels what no longer
 *     fits; reset / match switch clears them outright (a restart also does).
 *   - automation-driven changes go through the same tails as admin actions, so
 *     they can trigger FURTHER automation (chains allowed); infinite ping-pong
 *     between 圖標↔橫幅 is prevented by suppressing only the DIRECT reverse
 *     edge (opts.fromIcon / opts.fromInfo).
 *   - an automation view switch remembers the operator's tier (autoTierPrev)
 *     and every clock start puts it back + stops an auto-started 序列. */
let autoTimers = [];
function autoAfter(ms, fn) {
  const t = setTimeout(() => { autoTimers = autoTimers.filter(x => x !== t); fn(); }, ms);
  autoTimers.push(t);
}
function clearAutoSeq() {
  for (const t of autoTimers) clearTimeout(t);
  autoTimers = [];
}
let autoTierPrev = null;    // tier the operator had before an automation switch
let autoTierSet = null;     // tier the automation switched TO (restore only if unchanged)
let autoSeqStarted = false; // the running bbSeq was auto-started (stop it on resume)
let calibFired = false;     // TIME CALIBRATION shown in this BREAK/PAUSE episode
let obsRunning = !!state.timer.running;
let obsMode = state.timer.mode;

function fmtMMSS(ms) {
  const s = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/* the time as the scoreboard shows it right now (direction-aware) */
function clockTextNow() {
  const t = state.timer;
  const rem = timerRemainingNow();
  return fmtMMSS(t.direction === 'up' ? Math.max(0, t.durationMs - rem) : rem);
}
/* time remaining to the end of the period (both directions) */
function leftTextNow() { return fmtMMSS(timerRemainingNow()); }
function scoreCtx() {
  const a = state.teams.A.score, b = state.teams.B.score;
  const winner = a > b ? 'A' : b > a ? 'B' : null;
  return {
    a, b, diff: Math.abs(a - b), winner,
    hi: Math.max(a, b), lo: Math.min(a, b),
    lead: winner ? (state.teams[winner].short || winner).toUpperCase() : '',
  };
}

/* automation-composed banners — wording mirrors the admin editor's IB_PRESETS
 * writers (admin.js); keep the two in sync when editing either side */
function autoInfoHalfTime() {
  const c = scoreCtx();
  let body;
  if (!c.winner) body = `半場結束，雙方 ${c.a}:${c.b} 平分秋色，下半場見真章。`;
  else if (c.diff === 1) body = `半場結束，${c.lead} 以 ${c.hi}:${c.lo} 一球暫時領先，勝負仍是未知之數。`;
  else if (c.diff <= 3) body = `半場結束，${c.lead} 以 ${c.hi}:${c.lo} 領先，比分緊咬，懸念留待下半場。`;
  else if (c.diff <= 6) body = `半場結束，${c.lead} 以 ${c.hi}:${c.lo} 領先，暫時掌握比賽主動權。`;
  else body = `半場結束，${c.lead} 以 ${c.hi}:${c.lo} 大幅領先，下半場能否守住優勢？`;
  setInfoBanner({ key: 'HALF_TIME', cat: 'CONTROL', title: 'HALF-TIME', tone: '#2F6FED', fg: '#FFFFFF', body });
}
function autoInfoFullTime() {
  const c = scoreCtx();
  let body;
  if (!c.winner) body = `雙方以 ${c.a}:${c.b} 打成平手，比賽結束。`;
  else if (c.diff === 1) body = `恭喜 ${c.lead} 以 ${c.hi}:${c.lo} 一球之差險勝，雙方緊咬到最後一刻！`;
  else if (c.diff <= 3) body = `恭喜 ${c.lead} 以 ${c.hi}:${c.lo} 勝出，比分緊咬直到終場！`;
  else if (c.diff <= 6) body = `恭喜 ${c.lead} 以 ${c.hi}:${c.lo} 穩健取勝，全場掌握比賽節奏！`;
  else if (c.diff <= 9) body = `恭喜 ${c.lead} 以 ${c.hi}:${c.lo} 大勝，攻守兩端表現全面！`;
  else body = `恭喜 ${c.lead} 以 ${c.hi}:${c.lo} 懸殊比分大獲全勝，展現壓倒性實力！`;
  setInfoBanner({ key: 'FULL_TIME', cat: 'CONTROL', title: 'FULL-TIME', tone: '#2F6FED', fg: '#FFFFFF', body, team: c.winner || '' });
}
function autoInfoLast30() {
  const c = scoreCtx();
  const body = !c.winner ? `比賽最後三十秒，雙方 ${c.a}:${c.b} 平手，勝負懸於一線！`
    : c.diff <= 2 ? `比賽最後三十秒，${c.lead} 僅以 ${c.hi}:${c.lo} 領先，懸念保留到最後一刻！`
    : `比賽進入最後三十秒，${c.lead} 以 ${c.hi}:${c.lo} 領先。`;
  setInfoBanner({ key: 'LAST_30S', cat: 'CONTROL', title: 'LAST 30 SECONDS', tone: '#FF8A00', fg: '#15181E', body });
}
function autoInfoCalib() {
  setInfoBanner({
    key: 'TIME_CALIBRATE', cat: 'CONTROL', title: 'TIME-CALIBRATE', tone: '#2F6FED', fg: '#FFFFFF',
    body: `正在校正官方比賽計時，校正後由 ${clockTextNow()} 繼續。`,
  });
}
/* kind: 'halftime' = HALFTIME 重置聯動 arming the 2nd half; 'timeout' = 45s after TEAM TIME-OUT */
function autoInfoResume(kind) {
  const body = kind === 'halftime'
    ? '中場休息結束，比賽即將恢復。'
    : `暫停即將結束，比賽即將恢復，剩餘 ${leftTextNow()}。`;
  setInfoBanner({ key: 'RESUME', cat: 'CONTROL', title: 'RESUME', tone: '#0E9E64', fg: '#FFFFFF', body });
}

/* automation-driven view switch — remembers what the operator had so the next
 * clock start can put it back (a manual tier patch clears the memory) */
function fireBoardAuto(target) {
  if (!['full', 'large'].includes(target) || state.board.tier === target) return false;
  if (autoTierPrev == null) autoTierPrev = state.board.tier;
  autoTierSet = target;
  state.board.tier = target;
  return true;
}

/* pause-linked automation. Fires on an actual mid-period PAUSE (manual 暫停,
 * TIMEOUT-icon auto-pause, banner auto-pause) — never on the natural time-end
 * (it has its own sequences) or on BREAK/END word switches. */
function firePauseAutomation() {
  const pausedMidPeriod = () => !state.timer.running && timerRemainingNow() > 0;
  if (state.automation.pauseBoard !== 'off') autoAfter(1000, () => {
    const t = state.automation.pauseBoard;
    if (t === 'off' || !pausedMidPeriod()) return;
    if (fireBoardAuto(t)) afterAutoChange();
  });
  if (state.automation.pauseSeq) autoAfter(1000, () => {
    if (!state.automation.pauseSeq || !pausedMidPeriod()) return;
    if (bbSeqRun || !state.bbSeq.items.length) return;
    if (bbSeqShowFrom(0)) { autoSeqStarted = true; afterAutoChange(); }
  });
}

/* +2s view/sequence step shared by the two time-end groups */
function scheduleEndView(boardKey, seqKey) {
  autoAfter(2000, () => {
    if (state.timer.running || timerRemainingNow() > 0) return;
    const a = state.automation;
    let changed = false;
    if (a[boardKey] !== 'off' && fireBoardAuto(a[boardKey])) changed = true;
    if (a[seqKey] && !bbSeqRun && state.bbSeq.items.length && bbSeqShowFrom(0)) {
      autoSeqStarted = true;
      changed = true;
    }
    if (changed) afterAutoChange();
  });
}

/* natural time-end sequences. Waits measured from the buzzer; every step
 * re-checks its own preconditions so operator intervention cancels it. */
function fireTimeEndAutomation() {
  const a = state.automation;
  const period = String(state.period.text).trim().toUpperCase();
  const stillEnded = () => !state.timer.running && timerRemainingNow() <= 0;
  if (period === '1ST HALF') {
    if (a.halfEndFlow) autoAfter(1000, () => {
      if (!stillEnded() || String(state.period.text).trim().toUpperCase() !== '1ST HALF') return;
      state.timer.mode = 'break';
      logEvent('PHASE', { phase: 'BREAK', auto: true });
      const prev = state.period.text;
      state.period.text = 'HALFTIME';
      logEvent('PERIOD', { from: prev, to: 'HALFTIME' });
      autoInfoHalfTime();
      afterAutoChange();
    });
    scheduleEndView('halfEndBoard', 'halfEndSeq');
  } else if (period === '2ND HALF') {
    /* 平局抑制 is evaluated AT THE BUZZER — a later score correction does not
     * retro-fire the sequence (the moment has passed; operator handles 加時) */
    if (state.teams.A.score === state.teams.B.score && a.matchEndTieSuppress) return;
    if (a.matchEndFlow) autoAfter(1000, () => {
      if (!stillEnded()) return;
      state.timer.mode = 'matchEnd';
      logEvent('PHASE', { phase: 'MATCH_END', auto: true });
      autoInfoFullTime();
      afterAutoChange();
    });
    scheduleEndView('matchEndBoard', 'matchEndSeq');
  }
}

/* BREAK/PAUSE 中校時 → TIME CALIBRATION（每段一次）。`pre` = timer state BEFORE
 * the set/adjust applied — episode membership is judged on where the clock WAS. */
function calibPre() {
  return { running: state.timer.running, mode: state.timer.mode, rem: timerRemainingNow(), dur: state.timer.durationMs };
}
function maybeCalibBanner(pre) {
  if (!state.automation.timeCalibBanner || calibFired || pre.running) return;
  const inEpisode = pre.mode === 'break' || pre.mode === 'pause'
    || (pre.rem > 0 && pre.rem < pre.dur);   // stopped mid-period = a PAUSE episode
  if (!inEpisode) return;
  calibFired = true;
  autoInfoCalib();
}

/* watches mode / running transitions in the shared action tails — this is what
 * makes automation-triggered changes trigger further automation */
function observeAutoTransitions() {
  const runNow = !!state.timer.running;
  const modeNow = state.timer.mode;
  const wasRunning = obsRunning, wasMode = obsMode;
  obsRunning = runNow;
  obsMode = modeNow;
  /* MATCH END ⇄ 節次顯示：transition-edge only, so the operator can still
   * override the visibility in between */
  if (state.automation.endHidePeriod && modeNow !== wasMode) {
    if (modeNow === 'matchEnd') state.period.visible = false;
    else if (wasMode === 'matchEnd') state.period.visible = true;
  }
  if (!wasRunning && runNow) onClockResumed();
}
/* every clock start = a "resume": undo what pause/end automation changed, then
 * run the 恢復清理 feature if enabled */
function onClockResumed() {
  calibFired = false;
  if (autoTierSet) {
    if (state.board.tier === autoTierSet && autoTierPrev != null) state.board.tier = autoTierPrev;
    autoTierPrev = null;
    autoTierSet = null;
  }
  if (autoSeqStarted) {
    autoSeqStarted = false;
    if (bbSeqRun) { bbSeqRun = null; state.bottomBanner = null; }
  }
  if (state.automation.resumeCleanup) {
    for (const b of state.banners.filter(x => x.type === 'TIMEOUT')) {
      dropBanner(b.id);
      logEvent('ICON', { op: 'hide', team: b.team, icon: 'TIMEOUT', auto: true });
    }
    autoAfter(1000, () => {
      const ib = state.infoBanner;
      /* RESUME too: the 45s auto-resume banner is exactly the timeout's "about to
       * restart" card, so an actual resume should clear it alongside the timeout ones */
      if (!ib || !['TEAM_TIMEOUT', 'MEDICAL_TIMEOUT', 'RESUME'].includes(ib.key)) return;
      logEvent('INFO', { op: 'hide', key: ib.key, title: ib.title, auto: true });
      state.infoBanner = null;
      afterAutoChange();
    });
  }
}

/* LAST 30S：fires when the running clock CROSSES 30s remaining in an eligible
 * period; calibrating back above 30s re-arms it (crossing semantics). */
let last30Timer = null;
const LAST30_PERIODS = new Set(['2ND HALF', 'OT 1', 'OT 2']);
function scheduleLast30() {
  clearTimeout(last30Timer);
  last30Timer = null;
  const eligible = () => LAST30_PERIODS.has(String(state.period.text).trim().toUpperCase());
  if (!state.automation.last30Banner || !state.timer.running || !eligible()) return;
  const wait = timerRemainingNow() - 30000;
  if (wait <= 0) return;   // already inside the last 30s — crossings only, never late
  last30Timer = setTimeout(() => {
    if (!state.automation.last30Banner || !state.timer.running || !eligible()) return;
    const rem = timerRemainingNow();
    if (rem > 30500 || rem <= 0) return;
    autoInfoLast30();
    afterAutoChange();
  }, wait + 20);
}

/* reset the engine's runtime — pending steps die with the context that armed them */
function resetAutoRuntime() {
  clearAutoSeq();
  autoTierPrev = null;
  autoTierSet = null;
  autoSeqStarted = false;
  calibFired = false;
}

/* 資訊橫幅聯動 — runs after EVERY banner set (manual info.show, icon link, and
 * automation-composed banners alike), so chains keep propagating. opts.fromIcon
 * suppresses only the direct reverse edge (橫幅→圖標) when the banner itself came
 * from an icon (圖標→橫幅), preventing infinite ping-pong. */
const INFO_ICON_MAP = {
  RED_CARD: 'RED', BLUE_CARD: 'BLUE', YELLOW_CARD: 'YELLOW',
  SUSP_2MIN: 'SUSP2', TEAM_TIMEOUT: 'TIMEOUT', MEDICAL_TIMEOUT: 'MEDICAL',
};
function fireInfoAutomation(ib, opts) {
  const a = state.automation;
  if (a.infoIcon && !opts.fromIcon && ib.team) {
    const icon = INFO_ICON_MAP[ib.key];
    /* dup guard: an identical icon hung moments ago (e.g. operator used both
     * controls for the same call) — a second one is noise, skip it */
    const dup = icon && state.banners.some(b =>
      b.team === ib.team && b.type === icon && Date.now() - b.createdAt < 10000);
    if (icon && !dup) addIconBanner(ib.team, icon, { fromInfo: true });
  }
  if (ib.key === 'TEAM_TIMEOUT') {
    if (a.infoTimeoutPause && state.timer.running) {
      timerActions.pause();
      logEvent('PHASE', { phase: 'PAUSE', auto: true });
      firePauseAutomation();
    }
    if (a.infoTimeoutResume) autoAfter(45000, () => {
      if (state.timer.running || !state.automation.infoTimeoutResume) return;
      autoInfoResume('timeout');
      afterAutoChange();
    });
  }
  if (ib.key === 'MEDICAL_TIMEOUT' && a.infoMedicalPause && state.timer.running) {
    timerActions.pause();
    logEvent('PHASE', { phase: 'PAUSE', auto: true });
    firePauseAutomation();
  }
}

/* every automation-driven mutation ends the same way an admin action does */
function afterAutoChange(fx) {
  syncSuspensions();
  observeAutoTransitions();
  syncMatchSnap();
  persist();
  broadcast(fx || null);
  scheduleAutomation();
}

/* re-arm every automation timer from current state (cheap; runs per action) */
function scheduleAutomation() {
  scheduleBannerAutoHide();
  scheduleSuspExpiry();
  scheduleTimeoutExpiry();
  scheduleRosterFlip();
  scheduleBbSeq();
  scheduleLast30();
  scheduleReplayEnd();
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
    event: { text: DEFAULT_STATE.event.text, short: DEFAULT_STATE.event.short },
    period: { text: DEFAULT_STATE.period.text },
    timer: {
      durationMs: NEW_MATCH_DURATION, remainingMs: NEW_MATCH_DURATION,
      running: false, refEpoch: 0, mode: 'clock', direction: 'down',
    },
    teams: {
      A: { name: 'TEAM A', short: 'TEAM A', color: DEFAULT_STATE.teams.A.color, score: 0, flag: '' },
      B: { name: 'TEAM B', short: 'TEAM B', color: DEFAULT_STATE.teams.B.color, score: 0, flag: '' },
    },
    banners: [],
    infoBanner: null,
    bottomBanner: null,
    roster: { A: [], B: [], officials: [] },
    bbSeq: { items: [], intervalSec: 10, loop: false },
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
    event: { text: state.event.text, short: state.event.short },
    period: { text: state.period.text },
    timer,
    teams: state.teams,
    banners: state.banners,
    infoBanner: state.infoBanner,
    bottomBanner: state.bottomBanner,
    roster,
    bbSeq: state.bbSeq,
  });
}

function sanitizeSnap(src) {
  const snap = defaultSnap();
  if (!isObj(src)) return snap;
  if (isObj(src.event)) {
    snap.event.text = cleanText(src.event.text, 100, snap.event.text);
    snap.event.short = cleanText(src.event.short, 50, '');
  }
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
      snap.teams[k].flag = cleanText(String(t.flag ?? ''), 160, '');
    }
  }
  if (Array.isArray(src.banners)) {
    snap.banners = src.banners.filter(b => isObj(b) && BANNER_TYPES.includes(b.type)).slice(0, 6).map(b => {
      const out = { id: typeof b.id === 'string' ? b.id.slice(0, 20) : newId('b'), team: b.team === 'B' ? 'B' : 'A', type: b.type, createdAt: Number(b.createdAt) || Date.now() };
      if (b.type === 'SUSP2') {
        const s = isObj(b.susp) ? b.susp : {};
        out.susp = { msLeft: clamp(s.msLeft, 0, SUSP2_MS), refEpoch: Number(s.refEpoch) || 0, running: !!s.running };
      }
      if (b.type === 'TIMEOUT' && isObj(b.tout)) {
        out.tout = { endsAt: Number(b.tout.endsAt) || 0 };   // wall-clock: survives snap round-trips as-is
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
      team: ib.team === 'A' || ib.team === 'B' ? ib.team : '',
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
        num: cleanText(String(bb.num ?? ''), 3, ''),
        pos: cleanText(String(bb.pos ?? ''), 10, ''),
        title: cleanText(String(bb.title ?? ''), ROSTER_TITLE_MAX, ''),
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
  if (isObj(src.bbSeq)) {
    const q = src.bbSeq;
    snap.bbSeq = {
      items: (Array.isArray(q.items) ? q.items : []).filter(isObj).slice(0, 30).map(it => ({
        kind: BB_KINDS.includes(it.kind) ? it.kind : 'person',
        group: ['A', 'B', 'OFF'].includes(it.group) ? it.group : '',
        entryId: typeof it.entryId === 'string' ? it.entryId.slice(0, 20) : '',
        file: cleanText(String(it.file ?? ''), 120, ''),
      })),
      intervalSec: Math.round(clamp(q.intervalSec ?? 10, 3, 60)),
      loop: !!q.loop,
    };
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

/* 任何對局日誌變動都遞增（append／編輯／匯入）— 回放日誌快取與廣播去重的鍵 */
let logRev = 0;

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
  logRev++;
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
  state.event.short = s.event.short;
  state.period.text = s.period.text;
  for (const k of MATCH_TIMER_KEYS) state.timer[k] = s.timer[k];
  state.teams = s.teams;
  state.banners = s.banners || [];
  state.infoBanner = s.infoBanner || null;
  state.bottomBanner = s.bottomBanner || null;
  state.roster = s.roster || clone(DEFAULT_STATE.roster);
  state.rosterDisplay.page = 0;
  state.bbSeq = isObj(s.bbSeq) ? s.bbSeq : clone(DEFAULT_STATE.bbSeq);
  bbSeqRun = null;   // switching matches stops any sequence playback
  scheduleTimerEnd();
}

/* reset the match-scoped fields for a freshly created match */
function freshMatchState() {
  const d = defaultSnap();
  state.event.text = d.event.text;
  state.event.short = d.event.short;
  state.period.text = d.period.text;
  for (const k of MATCH_TIMER_KEYS) state.timer[k] = d.timer[k];
  state.teams = d.teams;
  state.banners = [];
  state.infoBanner = null;
  state.bottomBanner = null;
  state.roster = d.roster;
  state.rosterDisplay = { mode: 'off', page: 0 };
  state.bbSeq = d.bbSeq;
  bbSeqRun = null;   // a fresh match stops any sequence playback
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

/* ------------------------------------------------------------- replay */
/* 回放引擎（伺服器側只管播放頭與夾制；畫面倒推在 client 用 /shared/replay.js
 * 以同一份日誌重建 — 兩邊的篩選規則必須一致，改動時同步修改）：
 *   · RELEVANT（重建＋時間軸範圍）= SCORE / ICON / INFO / RESET
 *   · MARKER（時間軸標註＝拖動屏障）= 進球（SCORE kind:goal）＋橫幅顯示（INFO op:show）
 *   · 事件在 head > utc 時才算已發生（嚴格大於）：停在事件點上畫面仍是事件前，
 *     按下播放的瞬間立即套用（時間軸以 1x 平滑滑過標記 — Jason: 一秒內穿過）。
 *   · 拖動／微調夾在 (上一事件點, 下一事件點] — 段內狀態恆定，拖動絕不閃分；
 *     跨越事件點只能靠跳轉按鈕（明確意圖）或播放。
 * 回放動作一律不寫入對局日誌。 */
const REPLAY_PAD_MS = 12000;   // 時間軸頭尾留白
const REPLAY_RELEVANT = new Set(['SCORE', 'ICON', 'INFO', 'RESET']);
const REPLAY_LOG_TYPES = new Set(['SCORE', 'ICON', 'INFO', 'RESET', 'PHASE']);  // 快照額外帶 PHASE 供 admin 對時

/* 事件點 utc 清單（日誌本身依 utc 排序，這裡直接沿用） */
function replayMarks() {
  const m = activeMatch();
  if (!m) return [];
  const out = [];
  for (const e of m.log) {
    if (e.type === 'SCORE' && e.data && e.data.kind === 'goal') out.push(e.utc);
    else if (e.type === 'INFO' && e.data && e.data.op === 'show') out.push(e.utc);
  }
  return out;
}
function replayRange() {
  const m = activeMatch();
  const rel = m ? m.log.filter(e => REPLAY_RELEVANT.has(e.type)) : [];
  if (!rel.length) { const now = Date.now(); return { t0: now, t1: now }; }
  return { t0: rel[0].utc - REPLAY_PAD_MS, t1: rel[rel.length - 1].utc + REPLAY_PAD_MS };
}
function replayHeadNow() {
  const r = state.replay;
  return r.playing ? r.headUtc + (Date.now() - r.refEpoch) : r.headUtc;
}
/* 拖動夾制：head 所在段 = (上一事件點+1ms, 下一事件點]，再夾進 [t0, t1] */
function replayClampSeek(target, h0) {
  const { t0, t1 } = replayRange();
  let lo = t0, hi = t1;
  for (const u of replayMarks()) {
    if (u < h0) { if (u + 1 > lo) lo = u + 1; }
    else { if (u < hi) hi = u; break; }
  }
  return clamp(target, Math.min(lo, hi), hi);
}

/* 播放到時間軸終點自動暫停（重建狀態已到終局，再走毫無意義） */
let replayEndTimer = null;
function scheduleReplayEnd() {
  clearTimeout(replayEndTimer);
  replayEndTimer = null;
  const r = state.replay;
  if (!r.active || !r.playing) return;
  const wait = replayRange().t1 - replayHeadNow();
  replayEndTimer = setTimeout(() => {
    const r2 = state.replay;
    if (!r2.active || !r2.playing) return;
    const end = replayRange().t1;
    if (replayHeadNow() < end - 40) { scheduleReplayEnd(); return; }   // 日誌變長了 — 重排
    r2.headUtc = end;
    r2.refEpoch = 0;
    r2.playing = false;
    afterAutoChange();
  }, Math.max(0, wait) + 30);
}

/* 換局／新局／重置：回放語境（該局日誌）已失效 — 直接退出回放 */
function stopReplay() {
  state.replay.active = false;
  state.replay.playing = false;
  state.replay.refEpoch = 0;
}

/* 回放日誌快照（client 重建畫面用）：型別篩選＋欄位裁剪，依 logRev 快取；
 * 廣播時只在鍵改變的那一次帶上清單（拖動 seek 的高頻廣播保持輕量） */
let replayLogCache = { key: '', list: null };
function replayLogPayload() {
  if (!state.replay.active) return null;
  const m = activeMatch();
  if (!m) return null;
  const key = m.id + ':' + m.log.length + ':' + logRev;
  if (replayLogCache.key !== key) {
    replayLogCache = {
      key,
      list: m.log.filter(e => REPLAY_LOG_TYPES.has(e.type))
        .map(e => ({ id: e.id, utc: e.utc, clock: e.clock, period: e.period, type: e.type, data: e.data })),
    };
  }
  return replayLogCache;
}

/* boot: no library yet -> wrap the current live board into match #1 */
if (!matchStore.matches.length) {
  const m = newMatchRecord(matchSnap());
  matchStore.matches.push(m);
  matchStore.activeId = m.id;
}
syncSuspensions();   // align restored icons with the restored clock state
syncMatchSnap();     // state.json is the live truth after a restart — refresh the active snap
scheduleTimerEnd();  // a timer that was running when the server stopped re-arms (or fires) now
scheduleAutomation();

/* ---------------------------------------------------------------- actions */

/* set + log the top info banner (shared by the info.show action, the icon ->
 * banner link and every automation-composed banner). `team` rides along so the
 * 資訊橫幅聯動 knows which side the banner concerns; the automation hooks run
 * HERE, at the single choke point, so chains propagate no matter who set it —
 * opts.fromIcon marks a banner that came from the 圖標→橫幅 link (its reverse
 * edge 橫幅→圖標 is then suppressed). */
function setInfoBanner(src, opts = {}) {
  const cat = src.cat === 'CONTROL' ? 'CONTROL' : 'REFEREE';
  const hex = v => /^#[0-9a-fA-F]{6}$/.test(String(v));
  state.infoBanner = {
    id: 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    key: cleanText(String(src.key || ''), 24, ''),
    cat,
    title: (cleanText(String(src.title || ''), 30, '') || 'INFO').trim() || 'INFO',
    body: cleanText(String(src.body || ''), 240, '').trim(),
    tone: hex(src.tone) ? src.tone : (cat === 'CONTROL' ? '#2F6FED' : '#E0132F'),
    fg: hex(src.fg) ? src.fg : '#FFFFFF',
    team: src.team === 'A' || src.team === 'B' ? src.team : '',
    shownAt: Date.now(),
  };
  logEvent('INFO', {
    op: 'show', key: state.infoBanner.key, cat,
    title: state.infoBanner.title, body: state.infoBanner.body,
    tone: state.infoBanner.tone, fg: state.infoBanner.fg,
  });
  fireInfoAutomation(state.infoBanner, opts);
}

/* resolve a picker selection into a frozen bottom-banner display copy —
 * shared by bottom.show and the sequence player. Returns { bb } or { error }.
 * Content is FROZEN here (Jason: 顯示當下凍結) — later roster / org edits
 * never change a card that is already on air. */
function resolveBottomBanner(sel) {
  const kind = sel.kind;
  const bb = {
    id: 'bb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind, name: '', role: '', teamName: '', color: '#FFFFFF', file: '',
    num: '', pos: '', title: '',   // frozen roster detail — drives the [隊伍 位置 職稱] sub-line
    shownAt: Date.now(),
  };
  if (kind === 'org') {
    const file = String(sel.file || '');
    const meta = isObj(state.orgBanners) ? state.orgBanners[file] : null;
    if (!meta || !String(meta.name || '').trim()) {
      return { error: '請先在機構橫幅設定中填寫該機構的名稱' };
    }
    bb.file = file;
    bb.name = meta.name;
    bb.role = meta.role || '';   // 位置為選填
  } else if (kind === 'person' || kind === 'official') {
    const group = kind === 'official' ? 'OFF' : (sel.group === 'B' ? 'B' : 'A');
    const list = group === 'OFF' ? state.roster.officials : state.roster[group];
    const e = (list || []).find(x => x.id === String(sel.entryId));
    if (!e || !String(e.name || '').trim()) return { error: 'entry not found' };
    bb.group = group;      // provenance only (admin highlights the source chip)
    bb.entryId = e.id;
    bb.name = e.name;
    bb.role = e.role;
    bb.num = e.num || '';
    bb.pos = e.pos || '';
    bb.title = e.title || '';
    if (kind === 'person') {
      bb.teamName = state.teams[group].name;
      bb.color = state.teams[group].color;
    }
  } else {
    return { error: 'unknown banner kind' };
  }
  return { bb };
}

/* icon -> info-banner link (automation.iconBanner). FOUL is deliberately unmapped
 * — bannering every foul would spam. `body(t)` writes the team into its natural
 * slot rather than prefixing it, and weaves in the same live score / clock facts
 * as the admin editor's team-only branch (IB_PRESETS in admin.js — keep the
 * wording in sync when editing either side). */
const ICON_INFO_PRESETS = {
  SUSP2:   { key: 'SUSP_2MIN',       cat: 'REFEREE', title: '2-MIN SUSPENSION', tone: '#FF8A00', fg: '#15181E',
             body: t => {
               const c = scoreCtx();
               const tail = !c.winner ? `；目前 ${c.a}:${c.b} 平手，這兩分鐘的減員至關重要！`
                          : c.diff <= 2 ? `；目前 ${c.a}:${c.b} 分差膠著，這兩分鐘的減員至關重要！`
                                        : `；目前比分 ${c.a}:${c.b}，該隊將少一人應戰。`;
               return `${t} 一名球員被罰離場兩分鐘` + tail;
             } },
  YELLOW:  { key: 'YELLOW_CARD',     cat: 'REFEREE', title: 'YELLOW CARD',      tone: '#F5C400', fg: '#15181E',
             body: t => `${t} 一名球員被出示黃牌正式警告，再犯將面臨兩分鐘罰離。` },
  RED:     { key: 'RED_CARD',        cat: 'REFEREE', title: 'RED CARD',         tone: '#C4001D', fg: '#FFFFFF',
             body: t => {
               const c = scoreCtx();
               return `${t} 一名球員被取消比賽資格，不得繼續參賽；目前比分 ${c.a}:${c.b}，${t}將少一人應戰兩分鐘。`;
             } },
  BLUE:    { key: 'BLUE_CARD',       cat: 'REFEREE', title: 'BLUE CARD',        tone: '#1E6ADB', fg: '#FFFFFF',
             body: t => {
               const c = scoreCtx();
               return `${t} 一名球員被出示藍牌取消資格，賽後將提交書面報告並可能追加處分；目前 ${c.a}:${c.b}，${t}減員兩分鐘。`;
             } },
  TIMEOUT: { key: 'TEAM_TIMEOUT',    cat: 'CONTROL', title: 'TEAM TIME-OUT',    tone: '#0E9E64', fg: '#FFFFFF',
             body: t => {
               const c = scoreCtx();
               const who = `${t} 請求暫停，時長一分鐘`;
               if (!c.winner) return `${who}；兩隊 ${c.a}:${c.b} 戰平，比賽剩餘 ${leftTextNow()}，這一分鐘至關重要！`;
               if (c.diff <= 3) return `${who}；目前 ${c.a}:${c.b}，比賽剩餘 ${leftTextNow()}，關鍵時刻的戰術部署！`;
               return `${who}；目前比分 ${c.a}:${c.b}，比賽剩餘 ${leftTextNow()}。`;
             } },
  MEDICAL: { key: 'MEDICAL_TIMEOUT', cat: 'CONTROL', title: 'MEDICAL TIME-OUT', tone: '#0FA3B1', fg: '#FFFFFF',
             body: t => `${t} 場上球員接受治療，比賽暫停，計時停在 ${clockTextNow()}。` },
};

/* hang an event icon — shared by the banner.show action and the 橫幅→圖標
 * automation. opts.fromInfo marks an icon the info banner spawned: its reverse
 * edge (圖標→橫幅) is suppressed, everything else (auto-pause etc.) still runs. */
function addIconBanner(team, btype, opts = {}) {
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
  if (btype === 'TIMEOUT') {
    banner.tout = { endsAt: now + TIMEOUT_MS };   // display gated by automation.timeoutCountdown
    if (state.automation.timeoutAutoPause && state.timer.running) {
      timerActions.pause();
      logEvent('PHASE', { phase: 'PAUSE', auto: true });
      firePauseAutomation();
    }
  }
  state.banners.push(banner);
  logEvent('ICON', { op: 'show', team, icon: btype, ...(opts.fromInfo ? { auto: true } : {}) });
  /* automation: icon -> matching info banner, team written into the sentence */
  const link = !opts.fromInfo && state.automation.iconBanner && ICON_INFO_PRESETS[btype];
  if (link) {
    const short = (state.teams[team].short || team).toUpperCase();
    setInfoBanner({ ...link, body: link.body(short), team }, { fromIcon: true });
  }
}

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
        delete action.patch.bbSeq;         // sequence only via bbseq.save
        delete action.patch.hotkeys;       // shortcuts only via hotkeys.set (deepMerge can't delete keys)
        delete action.patch.replay;        // replay only via replay.* actions (夾制邏輯不可繞過)
        // (orgBanners / cornerLogos ARE patchable — plain display config like board.*)
        if (isObj(action.patch.board) && 'tier' in action.patch.board) {
          autoTierPrev = null;             // operator re-picked the view — automation
          autoTierSet = null;              // must not "restore" over their choice
        }
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
      if (was && !state.timer.running) {
        logEvent('PHASE', { phase: 'PAUSE' });
        firePauseAutomation();
      }
      break;
    }
    case 'timer.reset': {
      const wasHalftime = String(state.period.text).trim().toUpperCase() === 'HALFTIME';
      timerActions.reset();
      logEvent('CLOCK', { op: 'reset', ms: state.timer.remainingMs });
      /* HALFTIME 重置聯動：中場休息時重置計時＝準備下半場 —— 節次切 2ND HALF、
       * 小型計分板、回到比賽計時字樣、直接展示 RESUME 橫幅（全部即時，無延時） */
      if (wasHalftime && state.automation.halftimeArm) {
        const prev = state.period.text;
        state.period.text = '2ND HALF';
        if (prev !== '2ND HALF') logEvent('PERIOD', { from: prev, to: '2ND HALF' });
        state.board.tier = 'small';
        autoTierPrev = null;   // this IS the restore — forget any pending view memory
        autoTierSet = null;
        state.timer.mode = 'clock';
        autoInfoResume('halftime');
      }
      break;
    }
    case 'timer.set': {
      const pre = calibPre();
      timerActions.set(action.remainingMs);
      logEvent('CLOCK', { op: 'set', ms: state.timer.remainingMs });
      maybeCalibBanner(pre);
      break;
    }
    case 'timer.adjust': {
      const pre = calibPre();
      timerActions.adjust(action.deltaMs);
      logEvent('CLOCK', { op: 'adjust', deltaMs: Number(action.deltaMs) || 0, ms: timerRemainingNow() });
      maybeCalibBanner(pre);
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
      addIconBanner(team, btype);
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
      setInfoBanner(action);
      break;
    }
    case 'info.hide': {
      if (state.infoBanner) logEvent('INFO', { op: 'hide', key: state.infoBanner.key, title: state.infoBanner.title });
      state.infoBanner = null;
      break;
    }
    /* ------------------------------------------------- bottom banner */
    case 'bottom.show': {
      const r = resolveBottomBanner(action);
      if (r.error) return { ok: false, error: r.error };
      bbSeqRun = null;             // a manual show interrupts sequence playback
      state.bottomBanner = r.bb;
      break;
    }
    case 'bottom.hide': {
      bbSeqRun = null;             // a manual hide interrupts sequence playback
      state.bottomBanner = null;
      break;
    }
    /* -------------------------------------------- bottom banner sequence */
    case 'bbseq.save': {
      if (isObj(action.seq)) state.bbSeq = clone(action.seq);   // sanitize() cleans it below
      break;
    }
    /* keyboard shortcuts — whole map replaced (deepMerge can't remove a cleared
     * binding); sanitize() validates it below */
    case 'hotkeys.set': {
      if (isObj(action.hotkeys)) state.hotkeys = clone(action.hotkeys);
      break;
    }
    case 'bbseq.play': {
      if (!state.bbSeq.items.length) return { ok: false, error: '序列是空的，請先加入項目' };
      if (!bbSeqShowFrom(0)) {
        return { ok: false, error: '序列中沒有可顯示的項目（人員已移除或機構未命名）' };
      }
      break;
    }
    case 'bbseq.stop': {
      bbSeqRun = null;
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
        title: cleanText(String(action.title ?? ''), ROSTER_TITLE_MAX, ''),
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
      if (action.title != null) e.title = cleanText(String(action.title), ROSTER_TITLE_MAX, e.title);
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
      rosterFlipAt = 0;   // restart the auto-flip cadence on a mode change
      break;
    }
    case 'roster.page': {
      state.rosterDisplay.page = Math.round(clamp(action.page, 0, 99));
      rosterFlipAt = 0;   // manual paging restarts the auto-flip cadence
      break;
    }
    case 'roster.pagecount': {
      // reported by the overlay (pagination is pure layout — it lives client-side)
      rosterPageCount = Math.round(clamp(action.count, 1, 99));
      break;
    }
    /* ------------------------------------------------------------ matches */
    case 'match.create': {
      if (matchStore.matches.length >= MAX_MATCHES) return { ok: false, error: 'match library full' };
      syncMatchSnap();               // seal the outgoing match first
      freshMatchState();
      resetAutoRuntime();            // pending automation steps belong to the old match
      stopReplay();                  // 回放語境（舊局日誌）已失效
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
        resetAutoRuntime();          // pending automation steps belong to the old match
        stopReplay();                // 回放語境（舊局日誌）已失效
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
      logRev++;
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
      if (isObj(s.automation)) deepMerge(state.automation, s.automation);
      if (isObj(s.hotkeys)) state.hotkeys = clone(s.hotkeys);   // whole map (deepMerge can't clear)
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
      logRev++;
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
      logRev++;
      m.updatedAt = Date.now();
      persistMatches();
      break;
    }
    case 'match.log.delete': {
      const m = findMatch(action.id);
      if (!m) return { ok: false, error: 'match not found' };
      m.log = m.log.filter(x => x.id !== String(action.entryId));
      logRev++;
      m.updatedAt = Date.now();
      persistMatches();
      break;
    }
    case 'match.log.clear': {
      const m = findMatch(action.id);
      if (!m) return { ok: false, error: 'match not found' };
      m.log = [];
      logRev++;
      m.updatedAt = Date.now();
      persistMatches();
      break;
    }
    /* ------------------------------------------------------------ replay */
    case 'replay.start': {
      const r = state.replay;
      if (!r.active) {
        r.active = true;
        r.playing = false;
        r.refEpoch = 0;
        r.headUtc = replayRange().t1;    // 從「終局＝現在」進入：畫面無跳變，再由操作者回跳
        r.tier = ['off', 'small', 'large'].includes(state.board.tier) ? state.board.tier : 'large';
      }
      break;
    }
    case 'replay.stop': {
      stopReplay();
      break;
    }
    case 'replay.tier': {
      if (['off', 'small', 'large'].includes(action.tier)) state.replay.tier = action.tier;
      break;
    }
    case 'replay.scores': {
      state.replay.showScores = !!action.show;
      break;
    }
    case 'replay.play': {
      const r = state.replay;
      if (!r.active || r.playing) break;
      const { t1 } = replayRange();
      let h = r.headUtc;
      if (h >= t1) return { ok: false, error: '已到時間軸結尾，請先跳回較早的時刻' };
      /* 停在事件點上（拖動的停點）：按下繼續＝立刻套用該事件（head 跨過 utc），
       * 時間軸隨後以 1x 平滑滑過標記 */
      for (const u of replayMarks()) {
        if (u < h) continue;
        if (u - h <= 80) h = u + 1;
        break;
      }
      r.headUtc = h;
      r.refEpoch = Date.now();
      r.playing = true;
      break;
    }
    case 'replay.pause': {
      const r = state.replay;
      if (r.playing) {
        r.headUtc = replayHeadNow();
        r.playing = false;
        r.refEpoch = 0;
      }
      break;
    }
    case 'replay.seek': {
      const r = state.replay;
      if (!r.active) break;
      const t = Number(action.utc);
      if (!Number.isFinite(t)) break;
      const { t0, t1 } = replayRange();
      /* free = 明確跳轉（回到開頭／結尾按鈕）— 只夾範圍；拖動／微調走事件點夾制 */
      r.headUtc = action.free ? clamp(t, t0, t1) : replayClampSeek(t, replayHeadNow());
      r.refEpoch = Date.now();   // 播放中重定錨；暫停時 refEpoch 不參與
      break;
    }
    case 'replay.jump': {
      const r = state.replay;
      if (!r.active) break;
      const m = activeMatch();
      const e = m && m.log.find(x => x.id === String(action.entryId));
      if (!e) return { ok: false, error: 'entry not found' };
      const { t0 } = replayRange();
      let lo = t0;
      for (const u of replayMarks()) { if (u < e.utc) lo = u + 1; else break; }
      /* 回到該事件前 10 秒（不足 10 秒則貼在上一事件點之後）並繼續播放 */
      r.headUtc = clamp(e.utc - 10000, Math.min(lo, e.utc), e.utc);
      r.refEpoch = Date.now();
      r.playing = true;
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
      state.timer.endAlternate = DEFAULT_STATE.timer.endAlternate;
      if (state.board.tier === 'full') state.board.tier = 'large';
      resetAutoRuntime();
      stopReplay();               // 重置＝回放語境失效
      scheduleTimerEnd();
      break;
    }
    case 'reset.factory': {
      logEvent('RESET', { op: 'factory' });
      state = clone(DEFAULT_STATE);
      resetAutoRuntime();
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
  observeAutoTransitions();  // mode / running edges drive the 計時聯動 automation
  syncMatchSnap();
  persist();
  broadcast(fx);
  scheduleAutomation();
  return { ok: true };
}

/* ------------------------------------------------------------------ assets */
/* enumerate the banner / corner image folders — the admin picks from these lists.
 * Cached briefly so SSE broadcasts don't hit the disk on every action. */

const ASSET_DIRS = {
  banner: path.join(PUBLIC_DIR, 'assets', 'banner'),
  corner: path.join(PUBLIC_DIR, 'assets', 'corner'),
  flag: path.join(PUBLIC_DIR, 'assets', 'flag'),
  main: path.join(PUBLIC_DIR, 'assets', 'main'),   // PREPARING centre icon
};
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.bmp']);
let assetsCache = { at: 0, list: { banner: [], corner: [], flag: [], main: [] } };
function listAssets() {
  if (Date.now() - assetsCache.at < 5000) return assetsCache.list;
  const list = { banner: [], corner: [], flag: [], main: [] };
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

/* logDiff=true（廣播）：replayLog 只在鍵改變的那一次帶清單 — client 依鍵快取，
 * 初始快照（SSE 首包／/api/state）永遠帶全量 */
let replayLogBcastKey = '';
function snapshot(fx, { logDiff = false } = {}) {
  const out = {
    state,
    serverNow: Date.now(),
    fx: fx || null,
    matches: matchSummaries(),
    activeMatchId: matchStore.activeId,
    assets: listAssets(),
    bbSeqRun: bbSeqRun ? { idx: bbSeqRun.idx } : null,   // runtime playback status
  };
  const rl = replayLogPayload();
  if (rl) {
    out.replayLogKey = rl.key;
    if (!logDiff || rl.key !== replayLogBcastKey) out.replayLog = rl.list;
  }
  return out;
}
function broadcast(fx) {
  const msg = `data: ${JSON.stringify(snapshot(fx, { logDiff: true }))}\n\n`;
  const rl = replayLogPayload();
  replayLogBcastKey = rl ? rl.key : '';
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
