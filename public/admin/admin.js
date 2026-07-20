/* Scoreboard-X admin — every control maps to a server action; the UI itself
 * re-renders from SSE state, so several admins (PC + phone) stay in sync. */
import { connect, act, serverNow } from '/shared/net.js';
import { buildPalette, relLuminance } from '/shared/palette.js';
import { buildReplayModel, replayHead, markLabel } from '/shared/replay.js';

const $ = id => document.getElementById(id);
let st = null;
let lastTier = 'large';   // for the B shortcut: off <-> last shown tier

const patch = p => act('patch', { patch: p });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

/* ---------------------------------------------------------- helpers */

function setVal(node, v) {
  if (document.activeElement !== node && node.value !== String(v)) node.value = v;
}
function fmtClock(ms, direction) {
  ms = Math.max(0, ms);
  const cs = Math.floor(ms / 10) % 100;
  const pCs = String(cs).padStart(2, '0');
  if (direction === 'up') {
    const s = Math.floor(ms / 1000);
    const min = Math.floor(s / 60);
    const sec = s % 60;
    const pMin = (min === 0 && sec === 0) ? '00' : String(min);
    const pSec = String(sec).padStart(2, '0');
    return `${pMin}:${pSec}.${pCs}`;
  }
  if (ms < 10000) return `${Math.floor(cs / 100)}.${pCs}`;
  if (ms < 60000) {
    const s = Math.floor(ms / 1000);
    return `0:${String(s).padStart(2, '0')}.${pCs}`;
  }
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${pCs}`;
}
function parseTime(str) {
  str = String(str || '').trim();
  if (!str) return null;
  let cs = 0;
  if (str.includes('.')) {
    const dotIdx = str.indexOf('.');
    const decPart = str.slice(dotIdx + 1);
    cs = Math.round((parseFloat('0.' + decPart) || 0) * 100);
    str = str.slice(0, dotIdx);
  }
  if (str.includes(':')) {
    const [m, s] = str.split(':');
    const mm = parseInt(m, 10), ss = parseInt(s, 10);
    if (Number.isNaN(mm) || Number.isNaN(ss) || ss >= 60) return null;
    return (mm * 60 + ss) * 1000 + cs * 10;
  }
  const sec = parseFloat(str);
  return Number.isNaN(sec) ? null : Math.round(sec * 1000) + cs * 10;
}
function timerRemaining(t) {
  if (!t.running) return Math.max(0, t.remainingMs);
  return Math.max(0, t.remainingMs - (serverNow() - t.refEpoch));
}
function clockWordFor(s) {
  const t = s.timer;
  if (t.mode === 'break') return 'BREAK';
  if (t.mode === 'matchEnd') return 'END';
  if (t.mode === 'pause') return 'PAUSE';
  if (t.autoPauseWord && !t.running) {
    const r = timerRemaining(t);
    if (r > 0 && r < t.durationMs) return 'PAUSE';
  }
  return null;
}
function throttle(fn, ms) {
  let last = 0, timer = null, lastArgs = null;
  return (...args) => {
    lastArgs = args;
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...args); }
    else {
      clearTimeout(timer);
      timer = setTimeout(() => { last = Date.now(); fn(...lastArgs); }, ms - (now - last));
    }
  };
}

const BANNER_META = {
  FOUL:    { label: 'FOUL',    color: '#E0132F' },
  TIMEOUT: { label: 'TIMEOUT', color: '#0E9E64' },
  SUSP2:   { label: '2′ 罰時', color: '#FF8A00' },
  YELLOW:  { label: '黃牌',    color: '#F5C400' },
  RED:     { label: '紅牌',    color: '#C4001D' },
  BLUE:    { label: '藍牌',    color: '#1E6ADB' },
  MEDICAL: { label: '醫療',    color: '#0FA3B1' },
};

/* roster role labels — shared by the info-banner player picker, the bottom-banner
 * picker and its sequence list, so it must be declared above all of them */
const BB_ROLE_LABEL = {
  LEADER: '領隊', COACH: '教練', STAFF: '工作人員', PLAYER: '球員',
  COMMENTATOR: '評論員', REFEREE: '裁判', VIP: '主禮嘉賓', GUEST: '嘉賓',
  CHAMPION: '冠軍', RUNNER_UP: '亞軍', THIRD: '季軍', FOURTH: '殿軍',
};

/* ---------------------------------------------------------- refresh */

function paintPal(team, hex) {
  const pal = buildPalette(hex);
  const strip = $(team === 'A' ? 'palA' : 'palB');
  strip.innerHTML = '';
  for (const c of [pal.deeper, pal.deep, pal.base, pal.shift, pal.bright, pal.glow]) {
    const i = document.createElement('i');
    i.style.background = c;
    strip.append(i);
  }
}

function renderActiveBanners(s) {
  const host = $('activeBanners');
  host.innerHTML = '';
  for (const b of s.banners) {
    const meta = BANNER_META[b.type] || BANNER_META.FOUL;
    const item = document.createElement('div');
    item.className = 'ab-item';
    let cd = '';
    if (b.type === 'SUSP2' && b.susp) {
      cd = ` data-msleft="${Number(b.susp.msLeft) || 0}" data-ref="${Number(b.susp.refEpoch) || 0}" data-running="${b.susp.running ? 1 : 0}"`;
    } else if (b.type === 'TIMEOUT' && b.tout && s.automation && s.automation.timeoutCountdown) {
      cd = ` data-endsat="${Number(b.tout.endsAt) || 0}"`;
    }
    item.innerHTML = `
      <span class="ab-dot" style="--dot:${meta.color}"></span>
      <span class="ab-team">${(s.teams[b.team].short || '').toUpperCase()}</span>
      <span class="ab-label">${meta.label}</span>
      <span class="ab-count"${cd}></span>
      <button class="ab-x" title="移除">✕</button>`;
    item.querySelector('.ab-x').addEventListener('click', () => act('banner.hide', { id: b.id }));
    host.append(item);
  }
}

/* Conditional slider rows (展開持續 / 自動隱藏秒數 / 翻頁秒數) start hidden, so the
 * width lock measured them at 0 and skipped them — a row revealed later would sit
 * at full width beside the locked ones. Re-sync only when one actually flips:
 * doing it on every sync would be a layout read per action, and it would fight a
 * slider mid-drag (release → re-measure → re-lock, 6×/sec while dragging). */
let sliderRowsDirty = false;
function showSliderRow(id, on) {
  const el = $(id);
  const next = on ? '' : 'none';
  if (el.style.display === next) return;
  el.style.display = next;
  sliderRowsDirty = true;
}

function refresh(s) {
  st = s;

  /* score card */
  $('scoreNameA').textContent = s.teams.A.name;
  $('scoreNameB').textContent = s.teams.B.name;
  $('scoreValA').textContent = s.teams.A.score;
  $('scoreValB').textContent = s.teams.B.score;
  setVal($('goalDelta'), s.goalDelta == null ? 1 : s.goalDelta);

  const root = document.documentElement;
  root.style.setProperty('--a-color', s.teams.A.color);
  root.style.setProperty('--b-color', s.teams.B.color);
  for (const t of ['A', 'B']) {
    const ink = relLuminance(s.teams[t].color) > 0.42 ? '#0D0F13' : '#fff';
    const side = $(t === 'A' ? 'sideA' : 'sideB');
    side.style.setProperty('--tc-ink', ink);
  }

  /* event icons — now a collapsible section inside 資訊橫幅; summary badge lets
   * you see the live count without expanding it */
  for (const t of ['A', 'B']) {
    const chip = $('iconTeam' + t);
    chip.textContent = (s.teams[t].short || t).toUpperCase();
    chip.style.background = s.teams[t].color;
    chip.style.color = relLuminance(s.teams[t].color) > 0.42 ? '#0D0F13' : '#fff';
  }
  const iconsStatus = $('iconsStatus');
  iconsStatus.textContent = s.banners.length ? `${s.banners.length} 個顯示中` : '尚無圖標';
  iconsStatus.classList.toggle('on', !!s.banners.length);
  renderActiveBanners(s);

  /* info banner card */
  const ib = s.infoBanner;
  const ibs = $('ibStatus');
  ibs.textContent = ib
    ? `目前顯示：${ib.cat === 'CONTROL' ? 'MATCH CONTROL' : 'REFEREE'} · ${ib.title}`
    : '目前未顯示';
  ibs.classList.toggle('on', !!ib);
  /* team dropdown labels follow the live short names (values A/B never change);
   * each team option is painted in its own theme colour (ink by luminance) */
  const optInk = c => relLuminance(c) > 0.42 ? '#0D0F13' : '#fff';
  for (const t of ['A', 'B']) {
    const o = $('ibTeamOpt' + t);
    o.textContent = (s.teams[t].short || t).toUpperCase();
    o.style.background = s.teams[t].color;
    o.style.color = optInk(s.teams[t].color);
  }
  /* 勝方 is a VIRTUAL option — show which side it currently resolves to,
   * themed to the resolved side (neutral while level) */
  const wk = ibWinnerKey(s);
  const wOpt = $('ibTeamOptWin');
  wOpt.textContent = wk
    ? `勝方 · ${(s.teams[wk].short || wk).toUpperCase()}`
    : '勝方（目前平手）';
  wOpt.style.background = wk ? s.teams[wk].color : '';
  wOpt.style.color = wk ? optInk(s.teams[wk].color) : '';
  /* 勝方 can change hands mid-match: the player list must follow the new team
   * (it is keyed by the RESOLVED team, not by the 'WIN' select value) */
  if (wk !== ibLastWinKey) {
    ibLastWinKey = wk;
    if ($('ibTeamSel').value === 'WIN' && document.activeElement !== $('ibPlayerSel')) {
      ibFillPlayers();
    }
  }
  ibRefreshComposed();   // FULL-TIME's wording tracks the live score

  /* timer card */
  const running = s.timer.running;
  {
    const b = $('startPause');
    b.textContent = running ? '暫停' : '開始';
    b.classList.toggle('running', running);
  }
  document.querySelectorAll('#modeSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === s.timer.mode));
  $('autoPauseWord').checked = !!s.timer.autoPauseWord;
  $('pauseAlternate').checked = !!s.timer.pauseAlternate;
  $('endAlternate').checked = !!s.timer.endAlternate;
  document.querySelectorAll('#timerDirSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.dir === s.timer.direction));
  document.querySelectorAll('#durChips .chip').forEach(c =>
    c.classList.toggle('active', +c.dataset.min * 60000 === s.timer.durationMs));

  /* display card */
  const tier = s.board.tier || 'large';
  document.querySelectorAll('#tierSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tier === tier));
  if (tier !== 'off') lastTier = tier;
  const nm = s.board.nameMode;
  const nmv = k => (typeof nm === 'string' ? nm : ((nm && nm[k]) || 'short'));
  document.querySelectorAll('.nm-seg').forEach(seg => {
    seg.querySelectorAll('.seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.nm === nmv(seg.dataset.tier)));
  });
  const fsq = s.board.flagShow || {};
  document.querySelectorAll('.flag-seg').forEach(seg => {
    const on = fsq[seg.dataset.tier] !== false;
    seg.querySelectorAll('.seg-btn').forEach(b =>
      b.classList.toggle('active', (b.dataset.flag === '1') === on));
  });
  const em = s.board.eventMode || {};
  const emv = k => (typeof em === 'string' ? em : ((em && em[k]) || 'full'));
  document.querySelectorAll('.ev-seg').forEach(seg => {
    seg.querySelectorAll('.seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.ev === emv(seg.dataset.tier)));
  });
  const goalEffect = s.board.goalEffect || 'full';
  document.querySelectorAll('#goalEffectSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.effect === goalEffect));
  showSliderRow('rowGoalSec', goalEffect !== 'minimal');
  $('swAmbient').checked = !!s.board.ambient;
  $('swClock').checked = s.board.clockVisible !== false;
  setVal($('goalSec'), s.board.goalExpandSec);
  $('goalSecVal').textContent = s.board.goalExpandSec;
  setVal($('scale'), s.board.scale);
  $('scaleVal').textContent = Number(s.board.scale).toFixed(2);
  setVal($('margin'), s.board.margin);
  $('marginVal').textContent = s.board.margin;
  setVal($('driftSpeed'), s.board.driftSpeed);
  $('driftSpeedVal').textContent = Number(s.board.driftSpeed).toFixed(1);

  /* automation cards */
  const au = s.automation || {};
  $('atTimeoutCountdown').checked = !!au.timeoutCountdown;
  $('atTimeoutAutoPause').checked = !!au.timeoutAutoPause;
  $('atTimeoutAutoRemove').checked = !!au.timeoutAutoRemove;
  $('atSuspAutoRemove').checked = !!au.suspAutoRemove;
  $('atSuspExpireBanner').checked = !!au.suspExpireBanner;
  $('atIconBanner').checked = !!au.iconBanner;
  /* 計時聯動 card */
  $('atPausePreselect').checked = !!au.pausePreselect;
  $('atPauseSeq').checked = !!au.pauseSeq;
  $('atResumeClean').checked = !!au.resumeCleanup;
  $('atHalfEndFlow').checked = !!au.halfEndFlow;
  $('atHalfEndSeq').checked = !!au.halfEndSeq;
  $('atHalftimeArm').checked = !!au.halftimeArm;
  $('atMatchEndFlow').checked = !!au.matchEndFlow;
  $('atMatchEndSeq').checked = !!au.matchEndSeq;
  $('atMatchEndTie').checked = !!au.matchEndTieSuppress;
  $('atEndHidePeriod').checked = !!au.endHidePeriod;
  $('atLast30').checked = !!au.last30Banner;
  $('atTimeCalib').checked = !!au.timeCalibBanner;
  for (const [segId, boardKey] of AUTO_BOARD_SEGS) {
    document.querySelectorAll('#' + segId + ' .seg-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.bd === (au[boardKey] || 'off')));
  }
  /* 資訊橫幅聯動 card */
  $('atInfoIcon').checked = !!au.infoIcon;
  $('atInfoToPause').checked = !!au.infoTimeoutPause;
  $('atInfoToResume').checked = !!au.infoTimeoutResume;
  $('atInfoMedPause').checked = !!au.infoMedicalPause;
  /* 暫停聯動（pausePreselect）：running true→false 且仍在比賽中段（mode 還是
   * clock、剩餘 > 0）＝一次暫停。捲動只能在 client 做，所以偵測放這裡；每個開著
   * 的 admin 頁都會各自預選＋捲動。 */
  const runNow = !!s.timer.running;
  if (lastRunSeen === true && !runNow && au.pausePreselect
      && s.timer.mode === 'clock' && timerRemaining(s.timer) > 0) {
    ibAutoPreselectTimeout();
  }
  lastRunSeen = runNow;
  $('atInfoAutoHide').checked = !!au.infoAutoHide;
  setVal($('atInfoSec'), au.infoAutoHideSec ?? 12);
  $('atInfoSecVal').textContent = au.infoAutoHideSec ?? 12;
  showSliderRow('rowAtInfoSec', !!au.infoAutoHide);
  $('atBottomAutoHide').checked = !!au.bottomAutoHide;
  setVal($('atBottomSec'), au.bottomAutoHideSec ?? 12);
  $('atBottomSecVal').textContent = au.bottomAutoHideSec ?? 12;
  showSliderRow('rowAtBottomSec', !!au.bottomAutoHide);
  $('atRosterFlip').checked = !!au.rosterAutoFlip;
  setVal($('atRosterSec'), au.rosterAutoFlipSec ?? 8);
  $('atRosterSecVal').textContent = au.rosterAutoFlipSec ?? 8;
  showSliderRow('rowAtRosterSec', !!au.rosterAutoFlip);

  /* info card */
  $('swEvent').checked = !!s.event.visible;
  setVal($('eventText'), s.event.text);
  setVal($('eventShort'), s.event.short || '');
  $('swPeriod').checked = !!s.period.visible;
  setVal($('periodText'), s.period.text);
  document.querySelectorAll('#periodChips .chip').forEach(c =>
    c.classList.toggle('active', c.dataset.p === s.period.text));

  /* teams card */
  setVal($('nameA'), s.teams.A.name);
  setVal($('shortA'), s.teams.A.short);
  setVal($('nameB'), s.teams.B.name);
  setVal($('shortB'), s.teams.B.short);
  setVal($('colorA'), s.teams.A.color);
  setVal($('colorB'), s.teams.B.color);
  paintPal('A', s.teams.A.color);
  paintPal('B', s.teams.B.color);

  /* roster card */
  const rd = s.rosterDisplay || { mode: 'off', page: 0 };
  $('rModeA').textContent = (s.teams.A.short || 'A').toUpperCase();
  $('rModeB').textContent = (s.teams.B.short || 'B').toUpperCase();
  $('rGroupA').textContent = (s.teams.A.short || 'A').toUpperCase();
  $('rGroupB').textContent = (s.teams.B.short || 'B').toUpperCase();
  document.querySelectorAll('#rosterModeSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === rd.mode));
  const rTotal = rosterTotalPages(rd.mode);
  const rCur = Math.min(rd.page || 0, rTotal - 1);
  $('rPageInfo').textContent = `${rCur + 1} / ${rTotal}`;
  $('rosterPageRow').style.display = rd.mode === 'off' ? 'none' : '';
  $('rPagePrev').disabled = rCur <= 0;
  $('rPageNext').disabled = rCur >= rTotal - 1;
  const rj = JSON.stringify(s.roster);
  if (rj !== lastRosterJson) {
    lastRosterJson = rj;
    renderRosterEditor();
    // the info-banner player list is drawn from the roster; keep it fresh, but
    // never rebuild the options out from under an open dropdown
    if (document.activeElement !== $('ibPlayerSel')) ibFillPlayers();
  }

  /* bottom banner + corner logo cards */
  const bb = s.bottomBanner;
  const bbs = $('bbStatus');
  if (bb) {
    const role = BB_ROLE_LABEL[bb.role] || bb.role || '';
    bbs.textContent = `目前顯示：${bb.name}${role ? '（' + role + '）' : ''}${bbYielding(s) ? ' · 全畫幅／名單顯示中，暫時讓位' : ''}`;
  } else {
    bbs.textContent = '目前未顯示';
  }
  bbs.classList.toggle('on', !!bb);
  /* bottom-banner sequence */
  const seq = s.bbSeq || { items: [], intervalSec: 10, loop: false };
  $('bbSeqLoop').checked = !!seq.loop;
  setVal($('bbSeqSec'), seq.intervalSec ?? 10);
  $('bbSeqSecVal').textContent = seq.intervalSec ?? 10;
  $('bbSeqStatus').textContent = bbSeqRunInfo
    ? `播放中 ${Math.min((bbSeqRunInfo.idx ?? 0) + 1, seq.items.length)} / ${seq.items.length}`
    : (seq.items.length ? `序列共 ${seq.items.length} 項` : '序列是空的');
  renderBbSeqList(s);
  renderBbPicker();
  renderOrgList();
  renderCornerGrid();
  renderFlagPickers();
  hkSyncFromState(s);   // keyboard shortcuts now live in server state
  refreshReplay(s);     // 回放分頁（狀態徽章／時間軸／事件清單）
  syncToggleSegs();   // every 開關 above wrote its hidden checkbox — paint the segs
  if (sliderRowsDirty) { sliderRowsDirty = false; syncSegWidths(); }
}

/* would the overlay be suppressing the bottom banner right now? (status hint only) */
function bbYielding(s) {
  const tier = s.board.tier || 'large';
  if (tier === 'full') return true;
  if (s.infoBanner) return false;                    // info banner hides the rosters anyway
  const mode = (s.rosterDisplay || {}).mode || 'off';
  if (mode === 'off' || tier !== 'off') return false;
  const named = t => ((s.roster && s.roster[t]) || []).some(e => String(e.name || '').trim());
  return ((mode === 'A' || mode === 'both') && named('A'))
      || ((mode === 'B' || mode === 'both') && named('B'));
}

/* ------------------------------------------------------------ wiring */

/* scores */
$('goalA').addEventListener('click', () => act('goal', { team: 'A' }));
$('goalB').addEventListener('click', () => act('goal', { team: 'B' }));
$('plusA').addEventListener('click', () => act('score.adjust', { team: 'A', delta: 1 }));
$('minusA').addEventListener('click', () => act('score.adjust', { team: 'A', delta: -1 }));
$('plusB').addEventListener('click', () => act('score.adjust', { team: 'B', delta: 1 }));
$('minusB').addEventListener('click', () => act('score.adjust', { team: 'B', delta: -1 }));
$('setABtn').addEventListener('click', () => { const v = parseInt($('setA').value, 10); if (!Number.isNaN(v)) act('score.set', { team: 'A', value: v }); $('setA').value = ''; });
$('setBBtn').addEventListener('click', () => { const v = parseInt($('setB').value, 10); if (!Number.isNaN(v)) act('score.set', { team: 'B', value: v }); $('setB').value = ''; });
$('goalDelta').addEventListener('change', e => {
  let v = Math.round(parseInt(e.target.value, 10));
  if (Number.isNaN(v)) v = 1;
  v = Math.max(-19, Math.min(19, v)) || 1;
  e.target.value = v;
  patch({ goalDelta: v });
});

/* event icons — one row per team, single click */
document.querySelectorAll('.icon-row').forEach(row => {
  const team = row.dataset.team;
  row.querySelectorAll('.bn').forEach(b => {
    b.addEventListener('click', () => act('banner.show', { team, bannerType: b.dataset.type }));
  });
});
$('clearBanners').addEventListener('click', () => act('banner.clear'));

/* info banner — quick-fill presets. Complete IHF-rules library (31).
 *
 * ORDER MATTERS — buttons render in array order, so this list IS the on-screen
 * layout. Each group is sorted into CONTIGUOUS COLOUR BLOCKS; the blocks run from
 * most to least severe (red first) and entries inside a block run by in-match
 * frequency. Sorting by frequency alone (the previous rule) scattered the tones
 * and made the grid unscannable. Keep any new preset inside its colour's block.
 *   REFEREE: 深紅 取消資格 → 紅 犯規判罰 → 藍 藍牌 → 橙 罰離 → 黃 警告 → 灰 中性重開 → 綠 解除
 *   CONTROL: 橙 中斷 → 青 醫療 → 藍 流程 → 綠 正常進行
 *
 * Tones follow the shared colour language: foul red #E0132F / red card #C4001D /
 * blue card #1E6ADB / susp orange #FF8A00 / warning yellow #F5C400 / neutral
 * restart #57606E / control blue #2F6FED / positive green #0E9E64 / medical teal
 * #0FA3B1 (dark ink on yellow/orange).
 *
 * Each entry declares whether the 球隊 / 球員 dropdowns apply to it (unusable ones
 * are cleared + disabled) and owns a `body(t, p, c)` writer: t = team short name,
 * p = player label (either possibly ''), c = live match facts from ibCtx()
 * `{ a, b, diff, winner, key, hi, lo, lead, clock, left, period }`.
 * Optional flags: `teamDefault` preselects a 球隊 on pick ('WIN' = 勝方) and `live`
 * marks a writer whose text depends on c, so it re-composes on every sync
 * (see ibRefreshComposed) — a late score correction can never leave stale text.
 *
 * Refinement policy (Jason 2026-07-17): SITUATIONAL presets (milestones, penalties
 * with man-down consequences, timeouts, endgame) weave live score / time / margin
 * tiers into their wording — like FULL-TIME; ROUTINE restarts (free throw, throw-in,
 * goalkeeper throw, travel-type violations) stay as concise rule explanations with
 * NO live data, to avoid viewer fatigue on high-frequency calls.
 * The server mirrors several of these writers for automation-driven banners
 * (AUTO_INFO in server.js) — keep the wording in sync when editing either side.
 * The writer is NOT a string insert — every
 * preset spells out its own sentence per case so the subject lands in the right
 * slot with natural word order (e.g. FREE THROW takes the team as the RECIPIENT
 * "判 NICE 自由球", while PASSIVE PLAY's team is the one that GETS the free throw
 * and STEPS' team is the OFFENDER). */
const IB_PRESETS = [
  /* ==================== REFEREE 判罰 ==================== */
  /* 深紅 #C4001D — 取消資格（最重） */
  { key: 'RED_CARD', cat: 'REFEREE', title: 'RED CARD', tone: '#C4001D', fg: '#FFFFFF',
    team: true, player: true, live: true,
    body: (t, p, c) => {
      const tail = `目前比分 ${c.a}:${c.b}，${t || '該隊'}將少一人應戰兩分鐘。`;
      return p ? `${t} ${p} 被取消比賽資格，不得繼續參賽；${tail}`
           : t ? `${t} 一名球員被取消比賽資格，不得繼續參賽；${tail}`
               : `球員犯規並被取消比賽資格，不得繼續參賽；${tail}`;
    } },
  /* 紅 #E0132F — 犯規判罰 */
  { key: 'FREE_THROW', cat: 'REFEREE', title: 'FREE THROW', tone: '#E0132F', fg: '#FFFFFF',
    team: true, player: false,
    body: t => t ? `因犯規判給 ${t} 自由球，於犯規地點重新開球。`
                 : '因犯規判給進攻方自由球，於犯規地點重新開球。' },
  { key: 'SEVEN_METRE', cat: 'REFEREE', title: '7-METRE THROW', tone: '#E0132F', fg: '#FFFFFF',
    team: true, player: true, live: true,
    body: (t, p, c) => {
      const base = p ? `${t} ${p} 的明顯得分機會遭非法破壞，判罰七米球`
                 : t ? `${t} 的明顯得分機會遭非法破壞，判罰七米球`
                     : `明顯得分機會遭非法破壞，判罰七米球`;
      return base + (c.diff <= 1 ? `；目前 ${c.a}:${c.b}，此球足以改寫戰局！`
                                 : `；目前比分 ${c.a}:${c.b}。`);
    } },
  { key: 'GOAL_DISALLOWED', cat: 'REFEREE', title: 'GOAL DISALLOWED', tone: '#E0132F', fg: '#FFFFFF',
    team: true, player: false, live: true,
    body: (t, p, c) => t ? `${t} 此球不計分：球完全越線前已有犯規或哨聲；比分維持 ${c.a}:${c.b}。`
                         : `球完全越線前已有犯規或哨聲，此球不計分；比分維持 ${c.a}:${c.b}。` },
  { key: 'OFFENSIVE_FOUL', cat: 'REFEREE', title: 'OFFENSIVE FOUL', tone: '#E0132F', fg: '#FFFFFF',
    team: true, player: true,
    body: (t, p) => p ? `${t} ${p} 進攻犯規，球權轉換。`
                 : t ? `${t} 進攻犯規，球權轉換。`
                     : '進攻方犯規，球權轉換。' },
  { key: 'PASSIVE_PLAY', cat: 'REFEREE', title: 'PASSIVE PLAY', tone: '#E0132F', fg: '#FFFFFF',
    team: true, player: false,
    body: t => t ? `消極比賽成立，判 ${t} 自由球。`
                 : '消極比賽成立，判對方自由球。' },
  { key: 'STEPS', cat: 'REFEREE', title: 'STEPS', tone: '#E0132F', fg: '#FFFFFF',
    team: true, player: true,
    body: (t, p) => p ? `${t} ${p} 帶球超過三步，判對方自由球。`
                 : t ? `${t} 走步違例（帶球超過三步），判對方自由球。`
                     : '走步違例（帶球超過三步），判對方自由球。' },
  { key: 'DOUBLE_DRIBBLE', cat: 'REFEREE', title: 'DOUBLE DRIBBLE', tone: '#E0132F', fg: '#FFFFFF',
    team: true, player: true,
    body: (t, p) => p ? `${t} ${p} 二次運球違例，判對方自由球。`
                 : t ? `${t} 二次運球違例，判對方自由球。`
                     : '球員二次運球違例，判對方自由球。' },
  { key: 'GOAL_AREA', cat: 'REFEREE', title: 'GOAL AREA VIOLATION', tone: '#E0132F', fg: '#FFFFFF',
    team: true, player: true,
    body: (t, p) => p ? `${t} ${p} 違例進入六米球門區，判守門員擲球或自由球。`
                 : t ? `${t} 違例進入六米球門區，判守門員擲球或自由球。`
                     : '違例進入六米球門區，判守門員擲球或自由球。' },
  /* 藍 #1E6ADB — 取消資格＋書面報告 */
  { key: 'BLUE_CARD', cat: 'REFEREE', title: 'BLUE CARD', tone: '#1E6ADB', fg: '#FFFFFF',
    team: true, player: true, live: true,
    body: (t, p, c) => {
      const tail = `賽後將提交書面報告並可能追加處分；目前 ${c.a}:${c.b}，${t || '該隊'}減員兩分鐘。`;
      return p ? `${t} ${p} 被出示藍牌取消資格，${tail}`
           : t ? `${t} 一名球員被出示藍牌取消資格，${tail}`
               : `球員被出示藍牌取消資格，${tail}`;
    } },
  /* 橙 #FF8A00 — 罰離減員 */
  { key: 'SUSP_2MIN', cat: 'REFEREE', title: '2-MIN SUSPENSION', tone: '#FF8A00', fg: '#15181E',
    team: true, player: true, live: true,
    body: (t, p, c) => {
      const who = p ? `${t} ${p} 被罰離場兩分鐘` : t ? `${t} 一名球員被罰離場兩分鐘` : `球員被罰離場兩分鐘`;
      const tail = !c.winner ? `；目前 ${c.a}:${c.b} 平手，這兩分鐘的減員至關重要！`
                 : c.diff <= 2 ? `；目前 ${c.a}:${c.b} 分差膠著，這兩分鐘的減員至關重要！`
                               : `；目前比分 ${c.a}:${c.b}，該隊將少一人應戰。`;
      return who + tail;
    } },
  { key: 'SUSP_4MIN', cat: 'REFEREE', title: '4-MIN SUSPENSION', tone: '#FF8A00', fg: '#15181E',
    team: true, player: false, live: true,
    body: (t, p, c) => t ? `${t} 因連續違規追加處罰，減員四分鐘；目前比分 ${c.a}:${c.b}，長時間的以少打多！`
                         : `連續違規追加處罰，球隊減員四分鐘；目前比分 ${c.a}:${c.b}。` },
  /* 黃 #F5C400 — 警告 */
  { key: 'YELLOW_CARD', cat: 'REFEREE', title: 'YELLOW CARD', tone: '#F5C400', fg: '#15181E',
    team: true, player: true,
    body: (t, p) => p ? `${t} ${p} 因違反運動精神或危險動作被出示黃牌警告，再犯將面臨兩分鐘罰離。`
                 : t ? `${t} 一名球員被出示黃牌正式警告，再犯將面臨兩分鐘罰離。`
                     : '對違反運動精神或危險動作的正式警告，再犯將面臨兩分鐘罰離。' },
  { key: 'PASSIVE_WARNING', cat: 'REFEREE', title: 'PASSIVE PLAY WARNING', tone: '#F5C400', fg: '#15181E',
    team: true, player: false,
    body: t => t ? `${t} 進攻消極，須於四次傳球內完成射門。`
                 : '消極比賽預警：進攻方須於四次傳球內完成射門。' },
  /* 灰 #57606E — 中性重新開球 */
  { key: 'THROW_IN', cat: 'REFEREE', title: 'THROW-IN', tone: '#57606E', fg: '#FFFFFF',
    team: true, player: false,
    body: t => t ? `球出邊線，由 ${t} 擲界外球恢復比賽。`
                 : '球出邊線，由對方擲界外球恢復比賽。' },
  { key: 'GK_THROW', cat: 'REFEREE', title: 'GOALKEEPER THROW', tone: '#57606E', fg: '#FFFFFF',
    team: true, player: false,
    body: t => t ? `球越底線，由 ${t} 守門員擲球恢復比賽。`
                 : '球越底線，由守門員擲球恢復比賽。' },
  /* 綠 #0E9E64 — 解除／有利 */
  { key: 'SUSP_EXPIRED', cat: 'REFEREE', title: 'SUSPENSION EXPIRED', tone: '#0E9E64', fg: '#FFFFFF',
    team: true, player: true, live: true,
    body: (t, p, c) => (p ? `${t} ${p} 罰時結束歸隊，該隊恢復滿員應戰；目前比分 ${c.a}:${c.b}。`
                     : t ? `${t} 罰時結束，球員歸隊，恢復滿員應戰；目前比分 ${c.a}:${c.b}。`
                         : `罰時結束，球員歸隊，恢復滿員應戰；目前比分 ${c.a}:${c.b}。`) },
  { key: 'GOAL_AWARDED', cat: 'REFEREE', title: 'GOAL AWARDED', tone: '#0E9E64', fg: '#FFFFFF',
    team: true, player: true, live: true,
    body: (t, p, c) => (p ? `裁判確認 ${t} ${p} 的進球有效；目前比分 ${c.a}:${c.b}。`
                     : t ? `裁判確認 ${t} 此球有效；目前比分 ${c.a}:${c.b}。`
                         : `裁判確認進球有效；目前比分 ${c.a}:${c.b}。`) },
  /* ==================== MATCH CONTROL 賽事控制 ==================== */
  /* 橙 #FF8A00 — 中斷／緊急 */
  { key: 'PLAY_SUSPENDED', cat: 'CONTROL', title: 'PLAY SUSPENDED', tone: '#FF8A00', fg: '#15181E',
    team: false, player: false, live: true,
    body: (t, p, c) => `比賽於 ${c.period} ${c.clock} 暫時中斷，恢復時間另行通知。` },
  { key: 'LAST_30S', cat: 'CONTROL', title: 'LAST 30 SECONDS', tone: '#FF8A00', fg: '#15181E',
    team: false, player: false, live: true,
    body: (t, p, c) => {
      if (!c.winner) return `比賽最後三十秒，雙方 ${c.a}:${c.b} 平手，勝負懸於一線！`;
      if (c.diff <= 2) return `比賽最後三十秒，${c.lead} 僅以 ${c.hi}:${c.lo} 領先，懸念保留到最後一刻！`;
      return `比賽進入最後三十秒，${c.lead} 以 ${c.hi}:${c.lo} 領先。`;
    } },
  /* 青 #0FA3B1 — 醫療 */
  { key: 'MEDICAL_TIMEOUT', cat: 'CONTROL', title: 'MEDICAL TIME-OUT', tone: '#0FA3B1', fg: '#FFFFFF',
    team: true, player: true, live: true,
    body: (t, p, c) => (p ? `${t} ${p} 接受治療，比賽暫停，計時停在 ${c.clock}。`
                     : t ? `${t} 場上球員接受治療，比賽暫停，計時停在 ${c.clock}。`
                         : `場上球員接受治療，比賽暫停，計時停在 ${c.clock}。`) },
  /* 藍 #2F6FED — 流程資訊 */
  { key: 'THROW_OFF', cat: 'CONTROL', title: 'THROW-OFF', tone: '#2F6FED', fg: '#FFFFFF',
    team: true, player: false,
    body: t => t ? `由 ${t} 於中線開球。`
                 : '由中線開球，比賽開始。' },
  /* score comparison at the interval (Jason's direction): level / margin tiers,
   * the leader read from the LIVE score — server AUTO_INFO mirrors this writer */
  { key: 'HALF_TIME', cat: 'CONTROL', title: 'HALF-TIME', tone: '#2F6FED', fg: '#FFFFFF',
    team: false, player: false, live: true,
    body: (t, p, c) => {
      if (!c.winner) return `半場結束，雙方 ${c.a}:${c.b} 平分秋色，下半場見真章。`;
      if (c.diff === 1) return `半場結束，${c.lead} 以 ${c.hi}:${c.lo} 一球暫時領先，勝負仍是未知之數。`;
      if (c.diff <= 3) return `半場結束，${c.lead} 以 ${c.hi}:${c.lo} 領先，比分緊咬，懸念留待下半場。`;
      if (c.diff <= 6) return `半場結束，${c.lead} 以 ${c.hi}:${c.lo} 領先，暫時掌握比賽主動權。`;
      return `半場結束，${c.lead} 以 ${c.hi}:${c.lo} 大幅領先，下半場能否守住優勢？`;
    } },
  /* the one score-driven preset: opens on 勝方 and tiers its wording by the goal
   * margin. `live: true` re-composes it on every sync so a late score correction
   * cannot leave a wrong winner on screen. Defensive by design — it reads the
   * winner from the SCORE, so hand-picking the losing side still reads correctly. */
  { key: 'FULL_TIME', cat: 'CONTROL', title: 'FULL-TIME', tone: '#2F6FED', fg: '#FFFFFF',
    team: true, player: false, teamDefault: 'WIN', live: true,
    body: (t, p, c) => {
      const hi = Math.max(c.a, c.b), lo = Math.min(c.a, c.b);
      if (!c.winner) return `雙方以 ${c.a}:${c.b} 打成平手，比賽結束。`;
      if (!t) return `比賽結束，最終比分 ${c.a}:${c.b}。`;
      if (c.key !== c.winner) return `比賽結束，${t} 以 ${lo}:${hi} 落敗。`;
      if (c.diff === 1) return `恭喜 ${t} 以 ${hi}:${lo} 一球之差險勝，雙方緊咬到最後一刻！`;
      if (c.diff <= 3) return `恭喜 ${t} 以 ${hi}:${lo} 勝出，比分緊咬直到終場！`;
      if (c.diff <= 6) return `恭喜 ${t} 以 ${hi}:${lo} 穩健取勝，全場掌握比賽節奏！`;
      if (c.diff <= 9) return `恭喜 ${t} 以 ${hi}:${lo} 大勝，攻守兩端表現全面！`;
      return `恭喜 ${t} 以 ${hi}:${lo} 懸殊比分大獲全勝，展現壓倒性實力！`;
    } },
  { key: 'VIDEO_REVIEW', cat: 'CONTROL', title: 'VIDEO REVIEW', tone: '#2F6FED', fg: '#FFFFFF',
    team: false, player: false, live: true,
    body: (t, p, c) => `裁判覆核影像中，請稍候；目前比分 ${c.a}:${c.b}。` },
  { key: 'OVERTIME', cat: 'CONTROL', title: 'OVERTIME', tone: '#2F6FED', fg: '#FFFFFF',
    team: false, player: false, live: true,
    body: (t, p, c) => (!c.winner
      ? `雙方 ${c.a}:${c.b} 戰平，進入加時：休息五分鐘後進行兩節各五分鐘。`
      : `平手進入加時：休息五分鐘後進行兩節各五分鐘。`) },
  { key: 'SHOOTOUT', cat: 'CONTROL', title: 'SHOOTOUT', tone: '#2F6FED', fg: '#FFFFFF',
    team: false, player: false, live: true,
    body: (t, p, c) => (!c.winner
      ? `雙方 ${c.a}:${c.b} 戰平，以七米球決勝：每隊五名球員輪流主射。`
      : `以七米球決勝：每隊五名球員輪流主射。`) },
  { key: 'EMPTY_GOAL', cat: 'CONTROL', title: 'EMPTY GOAL', tone: '#2F6FED', fg: '#FFFFFF',
    team: true, player: false, live: true,
    body: (t, p, c) => {
      if (t && c.key && c.winner && c.key !== c.winner)
        return `落後 ${c.diff} 分之際，${t} 撤下守門員改以七名場上球員進攻，放手一搏。`;
      return t ? `${t} 撤下守門員，以七名場上球員進攻。`
               : `該隊撤下守門員，以七名場上球員進攻。`;
    } },
  { key: 'TIME_CALIBRATE', cat: 'CONTROL', title: 'TIME-CALIBRATE', tone: '#2F6FED', fg: '#FFFFFF',
    team: false, player: false, live: true,
    body: (t, p, c) => `正在校正官方比賽計時，校正後由 ${c.clock} 繼續。` },
  /* 綠 #0E9E64 — 正常進行 */
  /* remaining time + score for tension (Jason's direction) — server AUTO_INFO
   * mirrors the team-only branch for the icon-linked auto banner */
  { key: 'TEAM_TIMEOUT', cat: 'CONTROL', title: 'TEAM TIME-OUT', tone: '#0E9E64', fg: '#FFFFFF',
    team: true, player: false, live: true,
    body: (t, p, c) => {
      const who = t ? `${t} 請求暫停，時長一分鐘` : `球隊請求暫停，時長一分鐘`;
      if (!c.winner) return `${who}；兩隊 ${c.a}:${c.b} 戰平，比賽剩餘 ${c.left}，這一分鐘至關重要！`;
      if (c.diff <= 3) return `${who}；目前 ${c.a}:${c.b}，比賽剩餘 ${c.left}，關鍵時刻的戰術部署！`;
      return `${who}；目前比分 ${c.a}:${c.b}，比賽剩餘 ${c.left}。`;
    } },
  { key: 'RESUME', cat: 'CONTROL', title: 'RESUME', tone: '#0E9E64', fg: '#FFFFFF',
    team: false, player: false, live: true,
    body: (t, p, c) => `比賽即將恢復，剩餘 ${c.left}。` },
];

/* The 說明 textarea is a LIVE PREVIEW of the composed body: picking a preset or
 * changing 球隊 / 球員 rewrites it through that preset's own writer, and whatever
 * stands in the box is exactly what goes on air (hand tweaks still possible). */
let ibSel = null;
let ibLastComposed = '';   // what the writer last produced — lets us spot a hand edit
let ibLastWinKey = null;   // last resolved 勝方, to notice the lead changing hands
let lastRunSeen = null;    // timer.running from the previous sync — pause-edge detector

/* 勝方 is a VIRTUAL entry in the 球隊 dropdown: it is not a team key, it resolves
 * to whichever side is ahead RIGHT NOW (null while level). Everything downstream
 * (short name, roster, player list) must go through ibTeamKey, never read the
 * raw select value — 'WIN' is not a key into state.teams / state.roster. */
function ibWinnerKey(s) {
  if (!s) return null;
  const a = s.teams.A.score, b = s.teams.B.score;
  return a > b ? 'A' : b > a ? 'B' : null;
}
function ibTeamKey() {
  const v = $('ibTeamSel').value;
  if (v === 'A' || v === 'B') return v;
  if (v === 'WIN') return ibWinnerKey(st);
  return null;
}
function ibTeamShort() {
  const k = ibTeamKey();
  return (k && st) ? (st.teams[k].short || k).toUpperCase() : '';
}
/* live match facts for presets whose wording depends on the score / clock.
 * Presets that don't care simply ignore the 3rd body() argument.
 *   a, b    — live scores          diff — |a-b|
 *   winner  — 'A'|'B'|null         key  — the RESOLVED 球隊 pick ('WIN' mapped)
 *   hi, lo  — sorted scores        lead — leading side's SHORT NAME ('' if level)
 *   clock   — the time as the scoreboard shows it right now (direction-aware)
 *   left    — time REMAINING to the end of the period (mm:ss, both directions)
 *   period  — current period text */
function ibCtx() {
  const a = (st && st.teams.A.score) || 0;
  const b = (st && st.teams.B.score) || 0;
  const winner = ibWinnerKey(st);
  const remMs = st ? timerRemaining(st.timer) : 0;
  const dispMs = (st && st.timer.direction === 'up') ? Math.max(0, st.timer.durationMs - remMs) : remMs;
  return {
    a, b,
    diff: Math.abs(a - b),
    winner,
    key: ibTeamKey(),
    hi: Math.max(a, b),
    lo: Math.min(a, b),
    lead: winner && st ? (st.teams[winner].short || winner).toUpperCase() : '',
    clock: fmtMs(dispMs),
    left: fmtMs(remMs),
    period: (st && st.period.text) || '',
  };
}
/* named players of a team, in roster order (PLAYER role first, then the rest) */
function ibTeamRoster(team) {
  const list = (st && st.roster && st.roster[team]) || [];
  const named = list.filter(e => String(e.name || '').trim());
  return [...named.filter(e => e.role === 'PLAYER'), ...named.filter(e => e.role !== 'PLAYER')];
}
/* banner wording for a roster entry — "12 號 陳大文" / "陳大文" (no number registered) */
function ibPlayerLabel() {
  const team = ibTeamKey();
  const id = $('ibPlayerSel').value;
  if (!team || !id) return '';
  const e = ibTeamRoster(team).find(x => x.id === id);
  if (!e) return '';
  const num = String(e.num || '').trim();
  return (num ? num + ' 號 ' : '') + e.name;
}
function ibFillPlayers() {
  const sel = $('ibPlayerSel');
  const keep = sel.value;
  const team = ibTeamKey();
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '球員（不指定）';
  sel.append(none);
  if (team) {
    for (const e of ibTeamRoster(team)) {
      const o = document.createElement('option');
      o.value = e.id;
      const num = String(e.num || '').trim();
      const role = e.role === 'PLAYER' ? (e.pos || '') : (BB_ROLE_LABEL[e.role] || e.role || '');
      o.textContent = (num ? '#' + num + ' ' : '') + e.name + (role ? ' · ' + role : '');
      sel.append(o);
    }
  }
  sel.value = [...sel.options].some(o => o.value === keep) ? keep : '';
}
/* clear + disable whatever the picked preset does not use (Jason: 不適用就要設為空並禁止選擇) */
function ibSyncSelects() {
  const teamSel = $('ibTeamSel');
  const playerSel = $('ibPlayerSel');
  const canTeam = !!(ibSel && ibSel.team);
  teamSel.disabled = !canTeam;
  if (!canTeam) teamSel.value = '';
  ibFillPlayers();
  // a player only makes sense once its team is RESOLVED (勝方 while level = no team)
  playerSel.disabled = !(ibSel && ibSel.player && ibTeamKey());
  if (playerSel.disabled) playerSel.value = '';
}
function ibRecompose() {
  if (!ibSel) return;
  ibLastComposed = ibSel.body(ibTeamShort(), ibPlayerLabel(), ibCtx());
  $('ibBody').value = ibLastComposed;
}
/* a `live` preset's wording is derived from match state (FULL-TIME: winner + margin),
 * so a score correction after picking it would leave stale text on screen. Re-compose
 * on every sync — but ONLY while the box still holds exactly what the writer wrote,
 * so a hand edit is never clobbered. */
function ibRefreshComposed() {
  if (!ibSel || !ibSel.live) return;
  const box = $('ibBody');
  if (document.activeElement === box || box.value !== ibLastComposed) return;
  ibRecompose();
}
function ibPickPreset(entry, btn) {
  ibSel = entry;
  $('ibTitle').value = entry.title;
  const badge = $('ibCatBadge');
  badge.textContent = entry.cat === 'CONTROL' ? 'MATCH CONTROL' : 'REFEREE';
  badge.classList.toggle('ctl', entry.cat === 'CONTROL');
  // 球隊 / 球員 survive a preset switch when the new preset still takes them —
  // 黃牌 → 2 分鐘罰時 on the same player is one gesture, not two re-picks.
  // 勝方 is the exception: it belongs to FULL-TIME's flow and must NOT leak onto
  // unrelated presets (「由 勝方 於中線開球」reads wrong) — drop it on switch.
  // A preset may override with its own default (FULL-TIME opens on 勝方).
  if ($('ibTeamSel').value === 'WIN' && entry.teamDefault !== 'WIN') $('ibTeamSel').value = '';
  if (entry.teamDefault) $('ibTeamSel').value = entry.teamDefault;
  ibSyncSelects();
  ibRecompose();
  document.querySelectorAll('.preset-grid .pv').forEach(x => x.classList.toggle('active', x === btn));
}
const ibBtnByKey = {};   // preset key -> its grid button (auto-preselect needs both)
for (const entry of IB_PRESETS) {
  const btn = document.createElement('button');
  btn.className = 'btn pv';
  btn.style.setProperty('--pv', entry.tone);
  btn.textContent = entry.title;
  // 再次點擊已選中的預設＝直接顯示橫幅（同「顯示橫幅」鈕），不是重新填一次編輯器
  btn.addEventListener('click', () => {
    if (ibSel === entry && btn.classList.contains('active')) { ibShowNow(); return; }
    ibPickPreset(entry, btn);
  });
  ibBtnByKey[entry.key] = btn;
  $(entry.cat === 'CONTROL' ? 'ibPresetsCtl' : 'ibPresetsRef').append(btn);
}
/* 暫停聯動（automation.pausePreselect）：把編輯器預選成 TEAM TIME-OUT、切到比賽
 * 分頁並捲動到資訊橫幅卡。正在此卡輸入時不打擾（既不改編輯器也不捲動）。 */
function ibAutoPreselectTimeout() {
  const entry = IB_PRESETS.find(e => e.key === 'TEAM_TIMEOUT');
  const btn = ibBtnByKey.TEAM_TIMEOUT;
  const card = $('cardInfoBanner');
  if (!entry || !btn || typingInside(card)) return;
  ibPickPreset(entry, btn);
  setTab('live');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('ibTeamSel').addEventListener('change', () => {
  $('ibPlayerSel').value = '';   // the old pick belongs to the other team
  ibSyncSelects();
  ibRecompose();
});
$('ibPlayerSel').addEventListener('change', ibRecompose);
ibSyncSelects();   // nothing picked yet -> both dropdowns start cleared + disabled

/* put the current editor content on air — shared by the 顯示橫幅 button and by
 * re-clicking an already-active preset. `team` rides along so the server-side
 * 橫幅→圖標／暫停 automation knows which side the banner concerns. */
function ibShowNow() {
  const cat = $('ibCatBadge').classList.contains('ctl') ? 'CONTROL' : 'REFEREE';
  const title = $('ibTitle').value.trim();
  const body = $('ibBody').value.trim();
  if (!title && !body) return;
  act('info.show', {
    key: ibSel ? ibSel.key : '',
    cat,
    title: title || 'INFO',
    body,
    tone: ibSel ? ibSel.tone : (cat === 'CONTROL' ? '#2F6FED' : '#E0132F'),
    fg: ibSel ? ibSel.fg : '#FFFFFF',
    team: ibTeamKey() || '',
  });
}
$('ibShowBtn').addEventListener('click', ibShowNow);
$('ibHideBtn').addEventListener('click', () => act('info.hide'));

/* ------------------------------------------------- bottom banner card */
/* Picker = every candidate laid out flat (no dropdown), grouped A隊 / B隊 / 賽事人員 /
 * 機構, live-filtered by the text box. Click selects; clicking the SAME chip again
 * puts it straight on air (Jason 2026-07-17: 再點即顯示，不是取消選擇) — the
 * 顯示橫幅 button still works on the current selection. The chip whose card is
 * currently on air gets a green edge. Orgs need a name configured first. */

const noExt = f => String(f).replace(/\.[^.]+$/, '');

let assetsList = { banner: [], corner: [], flag: [] };   // folder listings, from every SSE payload
let bbSel = null;                              // { kind, group?, entryId?, file? }
let bbFilterText = '';
let lastBbKey = '';
let lastOrgKey = '';
let lastCornerKey = '';

function bbMatch(...texts) {
  const q = bbFilterText.trim().toLowerCase();
  if (!q) return true;
  return texts.some(t => String(t || '').toLowerCase().includes(q));
}
function bbSelIs(sel) {
  return !!bbSel && bbSel.kind === sel.kind && bbSel.group === sel.group
      && bbSel.entryId === sel.entryId && bbSel.file === sel.file;
}
function bbLiveIs(sel) {
  const bb = st && st.bottomBanner;
  if (!bb || bb.kind !== sel.kind) return false;
  return sel.kind === 'org' ? bb.file === sel.file : bb.entryId === sel.entryId;
}
function bbChipEl({ sel, label, sub, thumb, disabled, title }) {
  const b = document.createElement('button');
  b.className = 'bbp-chip';
  if (thumb) {
    const img = document.createElement('img');
    img.className = 'bbp-thumb';
    img.src = thumb;
    img.alt = '';
    b.append(img);
  }
  const name = document.createElement('span');
  name.className = 'bbp-name';
  name.textContent = label;
  b.append(name);
  if (sub) {
    const s = document.createElement('span');
    s.className = 'bbp-sub';
    s.textContent = sub;
    b.append(s);
  }
  if (title) b.title = title;
  if (disabled) b.disabled = true;
  else b.addEventListener('click', async () => {
    if (bbSelIs(sel)) {
      // 再次點擊已選取的待選項＝直接上架這張橫幅（不是取消選擇）
      const r = await act('bottom.show', sel);
      if (r && !r.ok) alert(r.error || '顯示失敗');
      return;
    }
    bbSel = sel;
    lastBbKey = '';
    renderBbPicker();
  });
  b.classList.toggle('sel', bbSelIs(sel));
  b.classList.toggle('live', bbLiveIs(sel));
  return b;
}

function renderBbPicker() {
  if (!st) return;
  const host = $('bbPicker');
  const key = JSON.stringify([
    st.roster, st.orgBanners, assetsList.banner,
    st.teams.A.short, st.teams.B.short,
    st.bottomBanner && st.bottomBanner.id, bbSel, bbFilterText,
  ]);
  if (key === lastBbKey) return;
  lastBbKey = key;
  host.innerHTML = '';
  let total = 0;
  const addGroup = (title, chips) => {
    if (!chips.length) return;
    total += chips.length;
    const t = document.createElement('div');
    t.className = 'bbp-group-title';
    t.textContent = title;
    const grid = document.createElement('div');
    grid.className = 'bbp-grid';
    for (const c of chips) grid.append(c);
    host.append(t, grid);
  };
  for (const g of ['A', 'B']) {
    const chips = [];
    for (const e of ((st.roster && st.roster[g]) || [])) {
      if (!String(e.name || '').trim()) continue;
      const role = BB_ROLE_LABEL[e.role] || e.role;
      if (!bbMatch(e.name, role)) continue;
      chips.push(bbChipEl({ sel: { kind: 'person', group: g, entryId: e.id }, label: e.name, sub: role }));
    }
    addGroup(((st.teams[g].short || g)).toUpperCase() + (g === 'A' ? '（主隊）' : '（客隊）'), chips);
  }
  {
    const chips = [];
    for (const e of ((st.roster && st.roster.officials) || [])) {
      if (!String(e.name || '').trim()) continue;
      const role = BB_ROLE_LABEL[e.role] || e.role;
      if (!bbMatch(e.name, role)) continue;
      chips.push(bbChipEl({ sel: { kind: 'official', entryId: e.id }, label: e.name, sub: role }));
    }
    addGroup('賽事人員', chips);
  }
  {
    const chips = [];
    for (const file of (assetsList.banner || [])) {
      const meta = (st.orgBanners || {})[file];
      const named = !!(meta && String(meta.name || '').trim());   // name required; 位置選填
      const label = named ? meta.name : noExt(file);
      const sub = named ? (meta.role || '') : '未命名';
      if (!bbMatch(label, sub, file)) continue;
      chips.push(bbChipEl({
        sel: { kind: 'org', file }, label, sub,
        thumb: '/assets/banner/' + encodeURIComponent(file),
        disabled: !named,
        title: named ? '' : '請先在下方「機構橫幅設定」填寫機構名稱',
      }));
    }
    addGroup('機構', chips);
  }
  if (!total) {
    const empty = document.createElement('div');
    empty.className = 'bbp-empty';
    empty.textContent = bbFilterText
      ? '沒有符合篩選的項目'
      : '尚無可選項目——先在「隊職員名單」登記人員，或於下方設定機構';
    host.append(empty);
  }
}

function renderOrgList() {
  if (!st) return;
  const host = $('bbOrgList');
  const key = JSON.stringify([assetsList.banner, st.orgBanners]);
  if (key === lastOrgKey) return;
  if (typingInside(host)) { host.dataset.dirty = '1'; return; }
  lastOrgKey = key;
  host.innerHTML = '';
  if (!(assetsList.banner || []).length) {
    const d = document.createElement('div');
    d.className = 'bbp-empty';
    d.textContent = '資料夾 public/assets/banner 內沒有圖片';
    host.append(d);
    return;
  }
  for (const file of assetsList.banner) {
    const meta = (st.orgBanners || {})[file] || { name: '', role: '' };
    const row = document.createElement('div');
    row.className = 'org-row';
    const img = document.createElement('img');
    img.className = 'org-thumb';
    img.src = '/assets/banner/' + encodeURIComponent(file);
    img.alt = '';
    const fn = document.createElement('span');
    fn.className = 'org-file';
    fn.textContent = file;
    const name = document.createElement('input');
    name.className = 'in org-name';
    name.placeholder = '機構名稱';
    name.maxLength = 40;
    name.value = meta.name || '';
    name.addEventListener('change', () => patch({ orgBanners: { [file]: { name: name.value.trim() } } }));
    const useFn = document.createElement('button');
    useFn.className = 'btn sm';
    useFn.textContent = '用檔名';
    useFn.title = '將機構名稱設為圖片檔名';
    useFn.addEventListener('click', () => patch({ orgBanners: { [file]: { name: noExt(file) } } }));
    const role = document.createElement('input');
    role.className = 'in org-pos';
    role.placeholder = '位置（可留空，如 主辦單位）';
    role.maxLength = 20;
    role.value = meta.role || '';
    role.addEventListener('change', () => patch({ orgBanners: { [file]: { role: role.value.trim() } } }));
    row.append(img, fn, name, useFn, role);
    host.append(row);
  }
}

$('bbFilter').addEventListener('input', e => { bbFilterText = e.target.value; renderBbPicker(); });
$('bbShowBtn').addEventListener('click', async () => {
  if (!bbSel) { alert('請先在上方點選一位人員或一個機構'); return; }
  const r = await act('bottom.show', bbSel);
  if (r && !r.ok) alert(r.error || '顯示失敗');
});
$('bbHideBtn').addEventListener('click', () => act('bottom.hide'));

/* --------------------------------------------- bottom banner sequence */

let bbSeqRunInfo = null;   // runtime playback status from the snapshot
let lastBbSeqKey = '';

/* tiny ↑/↓/✕ list button used by the sequence rows */
function seqIconBtn(txt, title, onClick) {
  const b = document.createElement('button');
  b.className = 'r-x';
  b.textContent = txt;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function bbSeqItemLabel(it) {
  if (it.kind === 'org') {
    const meta = (st.orgBanners || {})[it.file];
    return {
      label: (meta && String(meta.name || '').trim()) || noExt(it.file || '') || '（機構）',
      sub: '機構',
    };
  }
  const list = it.kind === 'official'
    ? ((st.roster && st.roster.officials) || [])
    : ((st.roster && st.roster[it.group === 'B' ? 'B' : 'A']) || []);
  const e = list.find(x => x.id === it.entryId);
  if (!e || !String(e.name || '').trim()) return { label: '（人員已移除，播放時自動略過）', sub: '' };
  return { label: e.name, sub: BB_ROLE_LABEL[e.role] || e.role || '' };
}

function sendBbSeq(mut) {
  if (!st) return;
  const seq = JSON.parse(JSON.stringify(st.bbSeq || { items: [], intervalSec: 10, loop: false }));
  mut(seq);
  act('bbseq.save', { seq });
}

function renderBbSeqList(s) {
  const host = $('bbSeqList');
  const key = JSON.stringify([s.bbSeq, bbSeqRunInfo, s.roster, s.orgBanners]);
  if (key === lastBbSeqKey) return;
  lastBbSeqKey = key;
  host.innerHTML = '';
  const items = (s.bbSeq && s.bbSeq.items) || [];
  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'bbp-empty';
    d.textContent = '先在上方點選人員或機構，再按「加入目前選取」';
    host.append(d);
    return;
  }
  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'seq-row' + (bbSeqRunInfo && bbSeqRunInfo.idx === i ? ' current' : '');
    const num = document.createElement('b');
    num.className = 'seq-num';
    num.textContent = i + 1;
    const { label, sub } = bbSeqItemLabel(it);
    const name = document.createElement('span');
    name.className = 'bbseq-label';
    name.textContent = label;
    row.append(num, name);
    if (sub) {
      const sb = document.createElement('span');
      sb.className = 'bbseq-sub';
      sb.textContent = sub;
      row.append(sb);
    }
    const up = seqIconBtn('↑', '上移', () => {
      if (i > 0) sendBbSeq(q => { [q.items[i - 1], q.items[i]] = [q.items[i], q.items[i - 1]]; });
    });
    const down = seqIconBtn('↓', '下移', () => {
      if (i < items.length - 1) sendBbSeq(q => { [q.items[i + 1], q.items[i]] = [q.items[i], q.items[i + 1]]; });
    });
    const x = seqIconBtn('✕', '自序列移除', () => sendBbSeq(q => { q.items.splice(i, 1); }));
    row.append(up, down, x);
    host.append(row);
  });
}

$('bbSeqAddBtn').addEventListener('click', () => {
  if (!bbSel) { alert('請先在上方點選一位人員或一個機構'); return; }
  sendBbSeq(q => { q.items.push({ ...bbSel }); });
});
$('bbSeqLoop').addEventListener('change', e => sendBbSeq(q => { q.loop = e.target.checked; }));
const sendBbSeqSec = throttle(v => sendBbSeq(q => { q.intervalSec = v; }), 250);
$('bbSeqSec').addEventListener('input', e => {
  $('bbSeqSecVal').textContent = e.target.value;
  sendBbSeqSec(+e.target.value);
});
$('bbSeqPlayBtn').addEventListener('click', async () => {
  const r = await act('bbseq.play');
  if (r && !r.ok) alert(r.error || '播放失敗');
});
$('bbSeqStopBtn').addEventListener('click', () => act('bbseq.stop'));

/* ------------------------------------------------- corner logo card */

function renderCornerGrid() {
  if (!st) return;
  const host = $('cornerGrid');
  const key = JSON.stringify([assetsList.corner, st.cornerLogos]);
  if (key === lastCornerKey) return;
  lastCornerKey = key;
  host.innerHTML = '';
  const active = st.cornerLogos || [];
  for (const file of (assetsList.corner || [])) {
    const cell = document.createElement('button');
    cell.className = 'corner-cell' + (active.includes(file) ? ' on' : '');
    const img = document.createElement('img');
    img.src = '/assets/corner/' + encodeURIComponent(file);
    img.alt = '';
    const nm = document.createElement('span');
    nm.className = 'cc-name';
    nm.textContent = noExt(file);
    nm.title = noExt(file);
    cell.append(img, nm);
    const idx = active.indexOf(file);
    if (idx >= 0) {
      const ord = document.createElement('span');
      ord.className = 'cc-ord';
      ord.textContent = idx + 1;
      cell.append(ord);
    }
    cell.addEventListener('click', () => {
      const cur = (st && st.cornerLogos) || [];
      if (cur.includes(file)) patch({ cornerLogos: cur.filter(f => f !== file) });
      else if (cur.length >= 3) flashCornerNote('最多同時顯示 3 個 Logo');
      else patch({ cornerLogos: [...cur, file] });
    });
    host.append(cell);
  }
}
let cornerNoteTimer = 0;
function flashCornerNote(msg) {
  const n = $('cornerNote');
  n.textContent = msg;
  n.classList.add('flash');
  clearTimeout(cornerNoteTimer);
  cornerNoteTimer = setTimeout(() => {
    n.classList.remove('flash');
    n.textContent = 'TEAM B／全部名單顯示時，角落 Logo 會自動暫時讓位。';
  }, 2000);
}

/* per-team flag picker — single-select from assets/flag, plus a 無 (none) option.
   Cheap keyed skip like renderCornerGrid so SSE reflows don't rebuild constantly. */
let lastFlagKey = '';
function renderFlagPickers() {
  if (!st) return;
  const files = assetsList.flag || [];
  const key = JSON.stringify([files, st.teams.A.flag, st.teams.B.flag]);
  if (key === lastFlagKey) return;
  lastFlagKey = key;
  for (const team of ['A', 'B']) {
    const host = $('flagPick' + team);
    if (!host) continue;
    host.innerHTML = '';
    const cur = (st.teams[team].flag || '').trim();
    const none = document.createElement('button');
    none.className = 'flag-cell flag-none' + (cur ? '' : ' on');
    none.textContent = '無';
    none.title = '不顯示國旗';
    none.addEventListener('click', () => patch({ teams: { [team]: { flag: '' } } }));
    host.append(none);
    for (const file of files) {
      const cell = document.createElement('button');
      cell.className = 'flag-cell' + (file === cur ? ' on' : '');
      cell.title = noExt(file);
      const img = document.createElement('img');
      img.src = '/assets/flag/' + encodeURIComponent(file);
      img.alt = '';
      cell.append(img);
      cell.addEventListener('click', () => patch({ teams: { [team]: { flag: file } } }));
      host.append(cell);
    }
    if (!files.length) {
      const note = document.createElement('span');
      note.className = 'flag-empty hint';
      note.textContent = '把國旗圖檔放到 public/assets/flag/';
      host.append(note);
    }
  }
}

/* timer */
function toggleTimer() { if (st) act(st.timer.running ? 'timer.pause' : 'timer.start'); }
$('startPause').addEventListener('click', toggleTimer);
$('timerReset').addEventListener('click', () => act('timer.reset'));
document.querySelectorAll('.adjust-row .btn').forEach(b => {
  b.addEventListener('click', () => {
    let delta = +b.dataset.adj;
    if (st && st.timer.direction === 'up') delta = -delta;
    act('timer.adjust', { deltaMs: delta });
  });
});
function applyTimerSet() {
  let ms = parseTime($('timerSetIn').value);
  if (ms != null && st) {
    if (st.timer.direction === 'up') {
      ms = Math.min(ms, st.timer.durationMs);
      ms = st.timer.durationMs - ms;
    }
    ms = clamp(ms, 0, st.timer.durationMs);
    act('timer.set', { remainingMs: ms });
    $('timerSetIn').value = '';
  }
}
$('timerSetBtn').addEventListener('click', applyTimerSet);
$('timerSetIn').addEventListener('keydown', e => { if (e.key === 'Enter') applyTimerSet(); });
document.querySelectorAll('#durChips .chip').forEach(c => {
  c.addEventListener('click', () => act('timer.duration', { durationMs: +c.dataset.min * 60000 }));
});
function applyDur() {
  const ms = parseTime($('durIn').value);
  if (ms != null) { act('timer.duration', { durationMs: ms }); $('durIn').value = ''; }
}
$('durBtn').addEventListener('click', applyDur);
$('durIn').addEventListener('keydown', e => { if (e.key === 'Enter') applyDur(); });
document.querySelectorAll('#modeSeg .seg-btn').forEach(b => {
  b.addEventListener('click', () => act('timer.mode', { mode: b.dataset.mode }));
});
$('autoPauseWord').addEventListener('change', e => patch({ timer: { autoPauseWord: e.target.checked } }));
$('pauseAlternate').addEventListener('change', e => patch({ timer: { pauseAlternate: e.target.checked } }));
$('endAlternate').addEventListener('change', e => patch({ timer: { endAlternate: e.target.checked } }));
document.querySelectorAll('#timerDirSeg .seg-btn').forEach(b => {
  b.addEventListener('click', () => act('timer.direction', { direction: b.dataset.dir }));
});

/* display */
document.querySelectorAll('#tierSeg .seg-btn').forEach(b => {
  b.addEventListener('click', () => patch({ board: { tier: b.dataset.tier } }));
});
document.querySelectorAll('.nm-seg').forEach(seg => {
  const tier = seg.dataset.tier;
  seg.querySelectorAll('.seg-btn').forEach(b => {
    b.addEventListener('click', () => patch({ board: { nameMode: { [tier]: b.dataset.nm } } }));
  });
});
document.querySelectorAll('.flag-seg').forEach(seg => {
  const tier = seg.dataset.tier;
  seg.querySelectorAll('.seg-btn').forEach(b => {
    b.addEventListener('click', () => patch({ board: { flagShow: { [tier]: b.dataset.flag === '1' } } }));
  });
});
document.querySelectorAll('#goalEffectSeg .seg-btn').forEach(b => {
  b.addEventListener('click', () => patch({ board: { goalEffect: b.dataset.effect } }));
});
$('swAmbient').addEventListener('change', e => patch({ board: { ambient: e.target.checked } }));
$('swClock').addEventListener('change', e => patch({ board: { clockVisible: e.target.checked } }));
const sendDriftSpeed = throttle(v => patch({ board: { driftSpeed: v } }), 150);
$('driftSpeed').addEventListener('input', e => { $('driftSpeedVal').textContent = Number(e.target.value).toFixed(1); sendDriftSpeed(+e.target.value); });
const sendGoalSec = throttle(v => patch({ board: { goalExpandSec: v } }), 200);
$('goalSec').addEventListener('input', e => { $('goalSecVal').textContent = e.target.value; sendGoalSec(+e.target.value); });
const sendScale = throttle(v => patch({ board: { scale: v } }), 150);
$('scale').addEventListener('input', e => { $('scaleVal').textContent = Number(e.target.value).toFixed(2); sendScale(+e.target.value); });
const sendMargin = throttle(v => patch({ board: { margin: v } }), 150);
$('margin').addEventListener('input', e => { $('marginVal').textContent = e.target.value; sendMargin(+e.target.value); });

/* automation prefs — plain toggles map 1:1 onto automation.* booleans */
for (const [id, key] of [
  ['atTimeoutCountdown', 'timeoutCountdown'],
  ['atTimeoutAutoPause', 'timeoutAutoPause'],
  ['atTimeoutAutoRemove', 'timeoutAutoRemove'],
  ['atSuspAutoRemove', 'suspAutoRemove'],
  ['atSuspExpireBanner', 'suspExpireBanner'],
  ['atIconBanner', 'iconBanner'],
  ['atPausePreselect', 'pausePreselect'],
  ['atResumeClean', 'resumeCleanup'],
  ['atHalfEndFlow', 'halfEndFlow'],
  ['atHalftimeArm', 'halftimeArm'],
  ['atMatchEndFlow', 'matchEndFlow'],
  ['atMatchEndTie', 'matchEndTieSuppress'],
  ['atEndHidePeriod', 'endHidePeriod'],
  ['atLast30', 'last30Banner'],
  ['atTimeCalib', 'timeCalibBanner'],
  ['atInfoIcon', 'infoIcon'],
  ['atInfoToPause', 'infoTimeoutPause'],
  ['atInfoToResume', 'infoTimeoutResume'],
  ['atInfoMedPause', 'infoMedicalPause'],
  ['atInfoAutoHide', 'infoAutoHide'],
  ['atBottomAutoHide', 'bottomAutoHide'],
  ['atRosterFlip', 'rosterAutoFlip'],
]) {
  $(id).addEventListener('change', e => patch({ automation: { [key]: e.target.checked } }));
}

/* 三組「畫面（關閉/全畫幅/大型）＋序列」：自動展示全畫幅與自動播放序列互斥
 * （底部橫幅在全畫幅下讓位）。點其一就把同組另一邊對開；server sanitize 亦有
 * 同款最後防線（board='full' 時強制 seq=false）。 */
const AUTO_BOARD_SEGS = [
  ['atPauseBoardSeg', 'pauseBoard', 'pauseSeq'],
  ['atHalfEndBoardSeg', 'halfEndBoard', 'halfEndSeq'],
  ['atMatchEndBoardSeg', 'matchEndBoard', 'matchEndSeq'],
];
for (const [segId, boardKey, seqKey] of AUTO_BOARD_SEGS) {
  document.querySelectorAll('#' + segId + ' .seg-btn').forEach(b => {
    b.addEventListener('click', () => {
      const upd = { [boardKey]: b.dataset.bd };
      if (b.dataset.bd === 'full' && st && st.automation && st.automation[seqKey]) upd[seqKey] = false;
      patch({ automation: upd });
    });
  });
}
for (const [id, seqKey, boardKey] of [
  ['atPauseSeq', 'pauseSeq', 'pauseBoard'],
  ['atHalfEndSeq', 'halfEndSeq', 'halfEndBoard'],
  ['atMatchEndSeq', 'matchEndSeq', 'matchEndBoard'],
]) {
  $(id).addEventListener('change', e => {
    const upd = { [seqKey]: e.target.checked };
    if (e.target.checked && st && st.automation && st.automation[boardKey] === 'full') upd[boardKey] = 'off';
    patch({ automation: upd });
  });
}
for (const [rangeId, valId, key] of [
  ['atInfoSec', 'atInfoSecVal', 'infoAutoHideSec'],
  ['atBottomSec', 'atBottomSecVal', 'bottomAutoHideSec'],
  ['atRosterSec', 'atRosterSecVal', 'rosterAutoFlipSec'],
]) {
  const send = throttle(v => patch({ automation: { [key]: v } }), 200);
  $(rangeId).addEventListener('input', e => { $(valId).textContent = e.target.value; send(+e.target.value); });
}

/* info */
$('swEvent').addEventListener('change', e => patch({ event: { visible: e.target.checked } }));
$('eventText').addEventListener('change', e => patch({ event: { text: e.target.value } }));
$('eventShort').addEventListener('change', e => patch({ event: { short: e.target.value } }));
document.querySelectorAll('.ev-seg').forEach(seg => {
  const tier = seg.dataset.tier;
  seg.querySelectorAll('.seg-btn').forEach(b => {
    b.addEventListener('click', () => patch({ board: { eventMode: { [tier]: b.dataset.ev } } }));
  });
});
$('swPeriod').addEventListener('change', e => patch({ period: { visible: e.target.checked } }));
document.querySelectorAll('#periodChips .chip').forEach(c => {
  c.addEventListener('click', () => patch({ period: { text: c.dataset.p } }));
});
function applyPeriod() { const v = $('periodText').value.trim(); if (v) patch({ period: { text: v } }); }
$('periodBtn').addEventListener('click', applyPeriod);
$('periodText').addEventListener('keydown', e => { if (e.key === 'Enter') { applyPeriod(); e.target.blur(); } });

/* teams */
for (const t of ['A', 'B']) {
  $('name' + t).addEventListener('change', e => patch({ teams: { [t]: { name: e.target.value } } }));
  $('short' + t).addEventListener('change', e => patch({ teams: { [t]: { short: e.target.value } } }));
  const sendColor = throttle(v => patch({ teams: { [t]: { color: v } } }), 160);
  $('color' + t).addEventListener('input', e => { paintPal(t, e.target.value); sendColor(e.target.value); });
}
document.querySelectorAll('.swatches').forEach(sw => {
  sw.addEventListener('click', e => {
    const c = e.target.dataset.c;
    if (!c) return;
    const t = sw.dataset.team;
    $('color' + t).value = c;
    paintPal(t, c);
    patch({ teams: { [t]: { color: c } } });
  });
});

/* ------------------------------------------------------------ roster */

const ROLE_SECTIONS_TEAM = [['LEADER', '領隊'], ['COACH', '教練'], ['STAFF', '工作人員'], ['PLAYER', '球員']];
const ROLE_SECTIONS_OFF = [
  ['COMMENTATOR', '評論員'], ['REFEREE', '裁判'], ['VIP', '主禮嘉賓'], ['GUEST', '嘉賓'],
  ['CHAMPION', '冠軍'], ['RUNNER_UP', '亞軍'], ['THIRD', '季軍'], ['FOURTH', '殿軍'],
];
/* 名次條目：name 欄是「隊伍名稱」、title 欄是組別；底部橫幅背景用該名次的獎牌色
 * （金／銀／銅／淺綠，須與 overlay.js 的 BB_AWARD_COLOR 一致） */
const AWARD_ROLES = new Set(['CHAMPION', 'RUNNER_UP', 'THIRD', 'FOURTH']);
const AWARD_COLOR = { CHAMPION: '#E6B325', RUNNER_UP: '#BCC3CE', THIRD: '#C67B3C', FOURTH: '#93CE9E' };
let rosterGroup = 'A';
let lastRosterJson = '';

/* Mirror the overlay's height + column aware pagination (overlay.js is the source
 * of truth; the overlay clamps whatever page we send). Row heights, budgets and
 * the column-fit rule match overlay.js; column width is estimated with canvas
 * text metrics using the same Oswald face, and the full-board height is estimated
 * from its scale (the overlay measures it live), so the count is essentially exact. */
const RP_ROW_H = 48, RP_HEAD_H = 52, RP_COL_GAP = 44, RP_PANEL_HEAD = 68, RP_ROWS_PAD = 8, RP_DOTS_RESERVE = 44, RP_GAP_FULL = 28;
let _measCtx = null;
function measTextW(text, weight) {
  if (!_measCtx) _measCtx = document.createElement('canvas').getContext('2d');
  _measCtx.font = `${weight} 27px 'Oswald','GenShin Gothic',sans-serif`;
  return _measCtx.measureText(String(text || '')).width;
}
function rosterNamed(t) {
  const list = (st && st.roster && Array.isArray(st.roster[t])) ? st.roster[t] : [];
  return list.filter(e => String(e.name || '').trim());
}
function rosterStreamAdmin(t) {
  const out = [];
  for (const [role, label] of ROLE_SECTIONS_TEAM) {
    const es = rosterNamed(t).filter(e => e.role === role);
    if (!es.length) continue;
    out.push({ kind: 'head', role, label });
    for (const e of es) out.push({ kind: 'person', role, e });
  }
  return out;
}
function rosterAvailH() {
  const margin = Math.round(Number((st.board && st.board.margin) || 0));
  if (st.board && (st.board.tier === 'full' || st.board.tier === 'preparing')) {
    const scale = Number(st.board.scale) || 1;
    const baseW = 1920 - 2 * margin, capW = 1920 - 2 * Math.max(0, margin);
    const fullScale = Math.min(scale, baseW > 0 ? capW / baseW : 1);
    return Math.max(300, 1080 - 2 * margin - 342 * fullScale - RP_GAP_FULL);
  }
  return Math.max(300, 1080 - 2 * margin);
}
function rosterColW(t) {
  let w = measTextW('工作人員', 600) + 30;
  for (const e of rosterNamed(t)) {
    let rw = measTextW(e.name, 600) + 28;
    if (e.role === 'PLAYER') rw += (e.num ? 58 : 0) + (e.pos ? measTextW(e.pos, 500) + 16 : 0);
    else rw += (e.title ? measTextW(e.title, 500) + 16 : 0);
    w = Math.max(w, rw);
  }
  return w;
}
function rosterPackAdmin(stream, budget) {
  const cols = []; let col = [], used = 0, cur = null;
  const flush = () => { if (col.length) { cols.push(col); col = []; used = 0; } };
  for (const it of stream) {
    if (it.kind === 'head') { cur = it; if (used > 0 && used + RP_HEAD_H + RP_ROW_H > budget) flush(); col.push(it); used += RP_HEAD_H; }
    else { if (used > 0 && used + RP_ROW_H > budget) { flush(); if (cur) { col.push(cur); used += RP_HEAD_H; } } col.push(it); used += RP_ROW_H; }
  }
  flush();
  return cols;
}
function rosterPagesFor(t) {
  if (!st) return 1;
  const stream = rosterStreamAdmin(t);
  if (!stream.length) return 1;
  const margin = Math.round(Number((st.board && st.board.margin) || 0));
  const budget = Math.max(RP_HEAD_H + RP_ROW_H, rosterAvailH() - RP_PANEL_HEAD - RP_DOTS_RESERVE - RP_ROWS_PAD);
  const columns = rosterPackAdmin(stream, budget);
  let cols = 1;
  if (columns.length >= 2) {
    const innerMax = (1920 / 2 - margin - 24) - 52;
    const cw = rosterColW(t);
    cols = (cw > 0 && cw * 2 + RP_COL_GAP <= innerMax) ? 2 : 1;
  }
  return Math.max(1, Math.ceil(columns.length / cols));
}
function rosterTotalPages(mode) {
  if (mode === 'A') return rosterPagesFor('A');
  if (mode === 'B') return rosterPagesFor('B');
  if (mode === 'both') return Math.max(rosterPagesFor('A'), rosterPagesFor('B'));
  return 1;
}

/* Re-render guard: ONLY a text field being typed in defers a rebuild (buttons /
 * selects keep focus after a click, and blocking on them froze the whole card). */
function typingInside(host) {
  const a = document.activeElement;
  return !!(a && host.contains(a) && /^(INPUT|TEXTAREA)$/.test(a.tagName));
}

function rosterInputEl(group, e, cls, ph, key, maxlen) {
  const inp = document.createElement('input');
  inp.className = 'in ' + cls;
  inp.placeholder = ph;
  inp.maxLength = maxlen;
  inp.value = e[key] || '';
  inp.addEventListener('change', () => act('roster.update', { group, id: e.id, [key]: inp.value }));
  return inp;
}

function renderRosterEditor() {
  const host = $('rosterEditor');
  if (!st) return;
  if (typingInside(host)) { host.dataset.dirty = '1'; return; }
  host.innerHTML = '';
  const group = rosterGroup;
  const list = group === 'OFF'
    ? ((st.roster && st.roster.officials) || [])
    : ((st.roster && st.roster[group]) || []);
  const sections = group === 'OFF' ? ROLE_SECTIONS_OFF : ROLE_SECTIONS_TEAM;
  for (const [role, label] of sections) {
    const sec = document.createElement('div');
    sec.className = 'roster-sec';
    const head = document.createElement('div');
    head.className = 'rs-title';
    if (AWARD_ROLES.has(role)) {   // medal colour cue = the banner's background for this placing
      const dot = document.createElement('i');
      dot.className = 'rs-award-dot';
      dot.style.background = AWARD_COLOR[role];
      head.append(dot);
    }
    const lb = document.createElement('span');
    lb.textContent = label;
    head.append(lb);
    const add = document.createElement('button');
    add.className = 'btn sm';
    add.textContent = '＋ 新增';
    add.addEventListener('click', () => act('roster.add', { group, role }));
    head.append(add);
    sec.append(head);
    const entries = list.filter(x => x.role === role);
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'rs-empty';
      empty.textContent = '（未登記）';
      sec.append(empty);
    }
    for (const e of entries) {
      const row = document.createElement('div');
      row.className = 'r-row';
      if (role === 'PLAYER') {
        row.append(
          rosterInputEl(group, e, 'r-num', '#', 'num', 3),
          rosterInputEl(group, e, 'grow', '姓名', 'name', 30),
          rosterInputEl(group, e, 'r-pos', '位置', 'pos', 10),
        );
      } else if (AWARD_ROLES.has(role)) {
        // 名次：名稱欄＝隊伍名稱，職稱欄＝組別（如 女子U6組）
        row.append(
          rosterInputEl(group, e, 'grow', '隊伍名稱', 'name', 30),
          rosterInputEl(group, e, 'r-title', '職稱／組別', 'title', 50),
        );
      } else {
        row.append(
          rosterInputEl(group, e, 'r-title', '職稱', 'title', 50),
          rosterInputEl(group, e, 'grow', '姓名', 'name', 30),
        );
      }
      const x = document.createElement('button');
      x.className = 'r-x';
      x.title = '移除';
      x.textContent = '✕';
      x.addEventListener('click', () => act('roster.remove', { group, id: e.id }));
      row.append(x);
      sec.append(row);
    }
    host.append(sec);
  }
}

document.querySelectorAll('#rosterModeSeg .seg-btn').forEach(b => {
  b.addEventListener('click', () => act('roster.display', { mode: b.dataset.mode }));
});
document.querySelectorAll('#rosterGroupSeg .seg-btn').forEach(b => {
  b.addEventListener('click', () => {
    rosterGroup = b.dataset.group;
    document.querySelectorAll('#rosterGroupSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    renderRosterEditor();
  });
});
$('rPagePrev').addEventListener('click', () => {
  if (!st) return;
  act('roster.page', { page: Math.max(0, (st.rosterDisplay.page || 0) - 1) });
});
$('rPageNext').addEventListener('click', () => {
  if (!st) return;
  const total = rosterTotalPages(st.rosterDisplay.mode);
  act('roster.page', { page: Math.min(total - 1, (st.rosterDisplay.page || 0) + 1) });
});

/* ------------------------------------------------------------ matches */

let matchesSummary = [];
let activeMatchId = null;
let lastMatchesKey = '';
let matchPage = 0;
const MATCHES_PER_PAGE = 5;
const expandedMatches = new Set();
const detailCache = new Map();   // id -> full match record

const PHASE_LABEL = { NEW: '未開始', LIVE: '進行中', PAUSED: '暫停中', BREAK: '中場', ENDED: '已結束' };

function esc(s) { const d = document.createElement('span'); d.textContent = String(s ?? ''); return d.innerHTML; }
function fmtDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fileStamp(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function dlJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename.replace(/[\\/:*?"<>|\s]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function readJSONFile(input) {
  const f = input.files && input.files[0];
  input.value = '';
  if (!f) return null;
  try { return JSON.parse(await f.text()); } catch { return undefined; }
}

async function fetchMatch(id) {
  try {
    const res = await fetch('/api/match?id=' + encodeURIComponent(id));
    const data = await res.json();
    if (data && data.ok) { detailCache.set(id, data.match); return data.match; }
  } catch {}
  return null;
}

function renderMatches() {
  const host = $('matchList');
  const total = Math.max(1, Math.ceil(matchesSummary.length / MATCHES_PER_PAGE));
  matchPage = Math.min(matchPage, total - 1);
  const key = JSON.stringify([matchesSummary, [...expandedMatches], matchPage]);
  if (key === lastMatchesKey) return;
  if (typingInside(host)) { host.dataset.dirty = '1'; return; }
  lastMatchesKey = key;
  host.innerHTML = '';
  host.style.removeProperty('--mi-w');
  const list = [...matchesSummary].sort((a, b) => b.createdAt - a.createdAt);
  const pageItems = list.slice(matchPage * MATCHES_PER_PAGE, (matchPage + 1) * MATCHES_PER_PAGE);
  for (const m of pageItems) host.append(matchItemEl(m));
  $('mPageInfo').textContent = `${matchPage + 1} / ${total}`;
  $('mPagePrev').disabled = matchPage <= 0;
  $('mPageNext').disabled = matchPage >= total - 1;
  /* 統一左右隊卡寬度：量整個列表裡最寬的一張，套給全部（含跨對局，整列對齊） */
  let w = 0;
  host.querySelectorAll('.mi-team').forEach(n => { w = Math.max(w, n.offsetWidth); });
  if (w) host.style.setProperty('--mi-w', Math.ceil(w)+1 + 'px');
}

function matchItemEl(m) {
  const item = document.createElement('div');
  item.className = 'match-item' + (m.active ? ' active' : '') + (expandedMatches.has(m.id) ? ' open' : '');
  const ink = c => relLuminance(c) > 0.42 ? '#0D0F13' : '#fff';
  const main = document.createElement('div');
  main.className = 'mi-main';
  main.innerHTML = `
    <div class="mi-team a" style="--mc:${m.teams.A.color};--mi:${ink(m.teams.A.color)}">
      <span class="mi-short">${esc((m.teams.A.short || 'A').toUpperCase())}</span>
      <span class="mi-score">${m.teams.A.score}</span>
    </div>
    <div class="mi-mid">
      <div class="mi-event">${esc(m.eventText || '')}</div>
      <div class="mi-meta">${fmtDate(m.updatedAt)} 使用 · ${PHASE_LABEL[m.phase] || m.phase} · ${m.logCount} 筆紀錄</div>
    </div>
    <div class="mi-team b" style="--mc:${m.teams.B.color};--mi:${ink(m.teams.B.color)}">
      <span class="mi-short">${esc((m.teams.B.short || 'B').toUpperCase())}</span>
      <span class="mi-score">${m.teams.B.score}</span>
    </div>
    <div class="mi-actions"></div>`;
  const actions = main.querySelector('.mi-actions');
  if (m.active) {
    const badge = document.createElement('span');
    badge.className = 'mi-badge';
    badge.textContent = '使用中';
    actions.append(badge);
  } else {
    const load = document.createElement('button');
    load.className = 'btn sm';
    load.style.marginLeft = '13px';
    load.textContent = '載入';
    load.addEventListener('click', () => {
      if (confirm('載入此對局？畫面將完整切換到該對局（目前對局已即時保存，不會丟失）。')) {
        act('match.load', { id: m.id });
      }
    });
    actions.append(load);
  }
  const exp = document.createElement('button');
  exp.className = 'btn sm mi-expand';
  exp.title = '展開／收合紀錄';
  exp.textContent = '▾';
  exp.addEventListener('click', () => {
    if (expandedMatches.has(m.id)) expandedMatches.delete(m.id);
    else expandedMatches.add(m.id);
    renderMatches();
  });
  actions.append(exp);
  item.append(main);
  if (expandedMatches.has(m.id)) {
    const det = document.createElement('div');
    det.className = 'mi-detail';
    item.append(det);
    fillDetail(det, m);
  }
  return item;
}

async function fillDetail(host, summary) {
  const cached = detailCache.get(summary.id);
  const fresh = cached && cached.updatedAt === summary.updatedAt && (cached.log || []).length === summary.logCount;
  if (fresh) { renderDetail(host, cached); return; }
  if (cached) renderDetail(host, cached);   // keep the stale view while refetching (no flash)
  else host.innerHTML = '<div class="log-empty">載入中…</div>';
  const m = await fetchMatch(summary.id);
  if (!m || !host.isConnected) return;
  renderDetail(host, m);
}

function renderDetail(host, m) {
  host.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'row wrap';
  const ins = document.createElement('button');
  ins.className = 'btn sm';
  ins.textContent = '＋ 插入紀錄';
  ins.addEventListener('click', () => {
    const clock = (m.id === activeMatchId && st) ? timerRemaining(st.timer) : 0;
    act('match.log.insert', {
      id: m.id,
      entry: { type: 'NOTE', utc: Date.now(), clock, period: (st && st.period.text) || '', data: { text: '' } },
    });
  });
  const dl = document.createElement('button');
  dl.className = 'btn sm';
  dl.textContent = '導出此對局';
  dl.addEventListener('click', () => exportOneMatch(m.id));
  bar.append(ins, dl);
  if (m.log && m.log.length) {
    const clr = document.createElement('button');
    clr.className = 'btn sm warn';
    clr.textContent = '清空紀錄';
    clr.title = '刪除此對局的全部紀錄（對局本身保留）';
    clr.addEventListener('click', async () => {
      if (!confirm('清空此對局的所有紀錄？對局本身與比分／隊伍會保留，紀錄無法復原。')) return;
      const r = await act('match.log.clear', { id: m.id });
      if (r && r.ok) detailCache.delete(m.id);
      else alert((r && r.error) || '清空失敗');
    });
    bar.append(clr);
  }
  if (m.id !== activeMatchId) {
    const del = document.createElement('button');
    del.className = 'btn sm warn';
    del.textContent = '刪除對局';
    del.addEventListener('click', async () => {
      if (!confirm('確定刪除此對局？其所有紀錄將一併刪除，無法復原。')) return;
      const r = await act('match.delete', { id: m.id });
      if (r && r.ok) { expandedMatches.delete(m.id); detailCache.delete(m.id); }
      else alert((r && r.error) || '刪除失敗');
    });
    bar.append(del);
  }
  host.append(bar);
  const rowsHost = document.createElement('div');
  rowsHost.className = 'log-rows';
  if (!m.log || !m.log.length) {
    rowsHost.innerHTML = '<div class="log-empty">此對局尚無紀錄</div>';
  } else {
    for (const e of m.log) rowsHost.append(logRowEl(m, e));
  }
  host.append(rowsHost);
}

async function exportOneMatch(id) {
  const m = detailCache.get(id) || await fetchMatch(id);
  if (!m) { alert('讀取對局失敗'); return; }
  const name = `match-${m.snap.teams.A.short || 'A'}-vs-${m.snap.teams.B.short || 'B'}-${fileStamp(m.createdAt)}.json`;
  dlJSON({ app: 'scoreboard-x', kind: 'match', version: 1, exportedAt: Date.now(), match: m }, name);
}

/* ---------------------------------------------------- match log editor */

const LOG_TYPE_META = {
  PHASE:      { label: '階段',     fields: [{ k: 'phase', kind: 'select', options: ['START', 'PAUSE', 'BREAK', 'MATCH_END'] }] },
  SCORE:      { label: '比分',     fields: [{ k: 'team', kind: 'select', options: ['A', 'B'] }, { k: 'kind', kind: 'select', options: ['goal', 'adjust', 'set'] }, { k: 'from', kind: 'num', ph: '從' }, { k: 'to', kind: 'num', ph: '到' }] },
  ICON:       { label: '事件圖標', fields: [{ k: 'op', kind: 'select', options: ['show', 'hide', 'clear'] }, { k: 'team', kind: 'select', options: ['A', 'B'] }, { k: 'icon', kind: 'select', options: Object.keys(BANNER_META) }] },
  INFO:       { label: '資訊橫幅', fields: [{ k: 'op', kind: 'select', options: ['show', 'hide'] }, { k: 'cat', kind: 'select', options: ['REFEREE', 'CONTROL'] }, { k: 'title', kind: 'text', ph: '標題' }, { k: 'body', kind: 'text', ph: '內容' }] },
  CLOCK:      { label: '計時調整', fields: [{ k: 'op', kind: 'select', options: ['set', 'adjust', 'reset', 'direction'] }, { k: 'ms', kind: 'ms', ph: 'mm:ss' }] },
  PERIOD:     { label: '節次',     fields: [{ k: 'from', kind: 'text', ph: '原' }, { k: 'to', kind: 'text', ph: '新' }] },
  EVENT_NAME: { label: '賽事名稱', fields: [{ k: 'from', kind: 'text', ph: '原' }, { k: 'to', kind: 'text', ph: '新' }] },
  RESET:      { label: '重置',     fields: [{ k: 'op', kind: 'select', options: ['match', 'factory'] }] },
  NOTE:       { label: '備註',     fields: [{ k: 'text', kind: 'text', ph: '內容' }] },
};

function fmtUTC(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function parseUTC(baseTs, str) {
  const mm = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(str).trim());
  if (!mm) return null;
  const h = +mm[1], mi = +mm[2], s = +mm[3];
  if (h > 23 || mi > 59 || s > 59) return null;
  const d = new Date(baseTs);
  d.setUTCHours(h, mi, s, 0);
  return d.getTime();
}
/* the entry clock is stored as remainingMs; show it the way the scoreboard did */
function fmtClockMs(ms, m) {
  let v = Math.max(0, Math.round(Number(ms) || 0));
  if (m.snap.timer.direction === 'up') v = Math.max(0, (m.snap.timer.durationMs || 0) - v);
  const s = Math.floor(v / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function parseClockMs(str, m) {
  const ms = parseTime(str);
  if (ms == null) return null;
  return m.snap.timer.direction === 'up' ? Math.max(0, (m.snap.timer.durationMs || 0) - ms) : ms;
}
function fmtMs(ms) {
  const s = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* running segments derived from the PHASE entries — the UTC <-> match-clock
 * mapping. Editing one time auto-updates the other when it is derivable;
 * inside a paused span (or before the first START) only the edited value moves. */
function logSegments(m) {
  const segs = [];
  let open = null;
  for (const e of m.log) {
    if (e.type !== 'PHASE') continue;
    const ph = e.data && e.data.phase;
    if (ph === 'START') open = { u0: e.utc, c0: e.clock };
    else if (open && ['PAUSE', 'BREAK', 'MATCH_END'].includes(ph)) { segs.push({ ...open, u1: e.utc }); open = null; }
  }
  if (open) segs.push({ ...open, u1: Infinity });
  return segs;
}
function clockAtUtc(m, utc) {
  let last = null;
  for (const s of logSegments(m)) {
    if (utc < s.u0) break;
    if (utc <= s.u1) return Math.max(0, s.c0 - (utc - s.u0));
    last = s;
  }
  if (last) return Math.max(0, last.c0 - (last.u1 - last.u0));
  return null;
}
function utcAtClock(m, clock) {
  for (const s of logSegments(m)) {
    const runDur = s.u1 === Infinity ? s.c0 : Math.min(s.c0, s.u1 - s.u0);
    if (clock <= s.c0 && clock >= s.c0 - runDur) return s.u0 + (s.c0 - clock);
  }
  return null;
}

function logRowEl(m, e) {
  const data = e.data || {};
  const row = document.createElement('div');
  row.className = 'log-row';
  const send = entry => act('match.log.update', { id: m.id, entryId: e.id, entry });

  const utcIn = document.createElement('input');
  utcIn.className = 'in le-utc';
  utcIn.value = fmtUTC(e.utc);
  utcIn.title = 'UTC+0 時間 · ' + new Date(e.utc).toISOString();
  utcIn.addEventListener('change', () => {
    const ts = parseUTC(e.utc, utcIn.value);
    if (ts == null) { utcIn.value = fmtUTC(e.utc); return; }
    const linked = clockAtUtc(m, ts);
    send(linked == null ? { utc: ts } : { utc: ts, clock: linked });
  });

  const ckIn = document.createElement('input');
  ckIn.className = 'in le-clock';
  ckIn.value = fmtClockMs(e.clock, m);
  ckIn.title = '比賽時間（計時器顯示值）';
  ckIn.addEventListener('change', () => {
    const ms = parseClockMs(ckIn.value, m);
    if (ms == null) { ckIn.value = fmtClockMs(e.clock, m); return; }
    const linked = utcAtClock(m, ms);
    send(linked == null ? { clock: ms } : { clock: ms, utc: linked });
  });

  const typeSel = document.createElement('select');
  typeSel.className = 'in le-type';
  for (const [k, meta] of Object.entries(LOG_TYPE_META)) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = meta.label;
    if (k === e.type) o.selected = true;
    typeSel.append(o);
  }
  typeSel.addEventListener('change', () => send({ type: typeSel.value, data: {} }));

  const fields = document.createElement('span');
  fields.className = 'le-fields';
  const meta = LOG_TYPE_META[e.type] || LOG_TYPE_META.NOTE;
  for (const f of meta.fields) {
    if (f.kind === 'select') {
      const sel = document.createElement('select');
      sel.className = 'in';
      for (const opt of f.options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (String(data[f.k] ?? '') === opt) o.selected = true;
        sel.append(o);
      }
      if (data[f.k] == null) sel.selectedIndex = -1;
      sel.addEventListener('change', () => send({ data: { ...data, [f.k]: sel.value } }));
      fields.append(sel);
    } else if (f.kind === 'num') {
      const inp = document.createElement('input');
      inp.className = 'in';
      inp.type = 'number';
      inp.style.width = '62px';
      inp.placeholder = f.ph || f.k;
      inp.value = data[f.k] ?? '';
      inp.addEventListener('change', () => {
        const v = Number(inp.value);
        if (Number.isFinite(v)) send({ data: { ...data, [f.k]: v } });
      });
      fields.append(inp);
    } else if (f.kind === 'ms') {
      const inp = document.createElement('input');
      inp.className = 'in le-clock';
      inp.placeholder = f.ph || 'mm:ss';
      inp.value = data[f.k] != null ? fmtMs(data[f.k]) : '';
      inp.addEventListener('change', () => {
        const v = parseTime(inp.value);
        if (v != null) send({ data: { ...data, [f.k]: v } });
      });
      fields.append(inp);
    } else {
      const inp = document.createElement('input');
      inp.className = 'in le-f-text';
      inp.placeholder = f.ph || f.k;
      inp.value = data[f.k] ?? '';
      inp.addEventListener('change', () => send({ data: { ...data, [f.k]: inp.value } }));
      fields.append(inp);
    }
  }

  const x = document.createElement('button');
  x.className = 'r-x';
  x.title = '刪除此紀錄';
  x.textContent = '✕';
  x.addEventListener('click', () => {
    if (confirm('刪除此筆紀錄？')) act('match.log.delete', { id: m.id, entryId: e.id });
  });
  row.append(utcIn, ckIn, typeSel, fields, x);
  return row;
}

/* buttons */
$('mNewBtn').addEventListener('click', () => {
  if (confirm('新建對局？目前對局已保存；畫面將重置為 TEAM A / TEAM B、半場 15:00。')) act('match.create');
});
$('mExportAllBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/matches');
    const data = await res.json();
    if (!data || !data.ok) throw new Error();
    dlJSON({ app: 'scoreboard-x', kind: 'matches', version: 1, exportedAt: Date.now(), matches: data.matches },
      `matches-all-${fileStamp(Date.now())}.json`);
  } catch { alert('導出失敗'); }
});
$('mImportBtn').addEventListener('click', () => $('mImportFile').click());
$('mImportFile').addEventListener('change', async e => {
  const payload = await readJSONFile(e.target);
  if (payload === null) return;
  if (payload === undefined) { alert('導入失敗：檔案不是有效的 JSON'); return; }
  const r = await act('match.import', { payload });
  alert(r && r.ok ? '對局導入成功' : ('導入失敗：' + ((r && r.error) || '未知錯誤')));
});

/* re-render list / roster editor / org list once focus leaves them (edits skip
 * re-render while typing). Blank rows are intentionally NOT removed here — a just-
 * added row must survive so you can type into it. Empty entries are simply hidden
 * on the overlay (nameless rows are skipped) and excluded from the match snapshot. */
const dirtyHosts = {
  matchList: () => { lastMatchesKey = ''; renderMatches(); },
  rosterEditor: () => renderRosterEditor(),
  bbOrgList: () => { lastOrgKey = ''; renderOrgList(); },
};
for (const hostId of Object.keys(dirtyHosts)) {
  $(hostId).addEventListener('focusout', () => {
    setTimeout(() => {
      const host = $(hostId);
      if (host.dataset.dirty && !host.contains(document.activeElement)) {
        delete host.dataset.dirty;
        dirtyHosts[hostId]();
      }
    }, 60);
  });
}

/* ------------------------------------------------ admin settings (danger) */

$('settingsExport').addEventListener('click', () => {
  if (!st) return;
  dlJSON({
    app: 'scoreboard-x', kind: 'settings', version: 1, exportedAt: Date.now(),
    settings: {
      board: st.board,
      goalDelta: st.goalDelta,
      timerPrefs: {
        autoPauseWord: !!st.timer.autoPauseWord,
        pauseAlternate: !!st.timer.pauseAlternate,
        endAlternate: !!st.timer.endAlternate,
      },
      cornerLogos: st.cornerLogos || [],
      orgBanners: st.orgBanners || {},
      automation: st.automation || {},
      hotkeys: st.hotkeys || {},
    },
  }, `scoreboard-settings-${fileStamp(Date.now())}.json`);
});
$('settingsImport').addEventListener('click', () => $('settingsImportFile').click());
$('settingsImportFile').addEventListener('change', async e => {
  const parsed = await readJSONFile(e.target);
  if (parsed === null) return;
  if (parsed === undefined) { alert('導入失敗：檔案不是有效的 JSON'); return; }
  const settings = parsed && typeof parsed === 'object' && parsed.settings && typeof parsed.settings === 'object'
    ? parsed.settings : parsed;
  const r = await act('settings.import', { settings });
  alert(r && r.ok ? '設置已導入' : ('導入失敗：' + ((r && r.error) || '未知錯誤')));
});

/* danger */
$('resetMatch').addEventListener('click', () => {
  if (confirm('重置比分、計時器與橫幅？球隊與顯示設置保留。')) act('reset.match');
});
$('resetFactory').addEventListener('click', () => {
  if (confirm('恢復出廠設定？所有球隊、顏色、名單與顯示設置都會還原。')) act('reset.factory');
});

/* ------------------------------------------------------------ misc */

const overlayUrl = location.origin + '/overlay';
const obsUrl = $('obsUrl');
if (obsUrl) obsUrl.textContent = overlayUrl;

/* ------------------------------------------ 預覽背景（純本機，不進 server） */
/* 預覽 iframe 永遠載入「透明」的 /overlay —— 與 OBS 算圖的完全同一份文件。它底下
 * 的東西全是 admin 這一側的裝飾：格線層、攝影機、或 WHEP 直播流。所以這裡沒有任何
 * 一行碰得到直播輸出，切換背景也不會重載 iframe（不斷 SSE、不閃畫面）。
 *
 * 設定只存 localStorage（Jason：只存這台機器）——攝影機 deviceId 本來就是每台機器
 * 不同的東西，而且它不該混進設定匯出檔。 */

const PV_KEY = 'sbx.previewBg';
const PV_MODES = ['pitch', 'dark', 'camera', 'stream'];
/* 首次啟用時優先挑虛擬攝影機：這台機器要預覽的來源，最可能就是 OBS 虛擬攝影機 */
const PV_VIRTUAL_RE = /virtual|obs|vcam|manycam|droidcam|xsplit|虛擬|虚拟/i;
const PV_LABEL = { pitch: '格線', dark: '深色', camera: '攝影機', stream: '直播流' };
const PV_CONN = {
  new: '連線中…', connecting: '連線中…', connected: '已連線',
  disconnected: '已斷線', failed: '連線失敗', closed: '未連線',
};

const frame = $('previewFrame');
const pvVideo = $('pvVideo');
const pvSeg = $('pvBgSeg');
const pvCamSel = $('pvCamSel');
const pvUrlIn = $('pvStreamUrl');

let pv = { mode: 'pitch', camId: '', url: '', overlay: true };
try { Object.assign(pv, JSON.parse(localStorage.getItem(PV_KEY) || '{}')); } catch {}
if (!PV_MODES.includes(pv.mode)) pv.mode = 'pitch';
pv.overlay = pv.overlay !== false;   // 舊存檔沒這個欄位 → 預設疊上
/* 靜音狀態刻意「不」存檔：存成非靜音的話，下次載入時還沒有任何 user gesture，
 * autoplay 政策會直接擋掉播放，整個預覽就是一片黑。每次載入都靜音，喇叭鈕只管當下。 */
let pvMuted = true;
let pvErr = '';

const pvSave = () => { try { localStorage.setItem(PV_KEY, JSON.stringify(pv)); } catch {} };

/* 只寫 --pv-scale：格線層與 iframe 共用它，兩層必須是同一個縮放，
 * 100px 的格子才會跟計分板待在同一個 1920 座標系裡。 */
function fitPreview() {
  if (!frame) return;
  frame.style.setProperty('--pv-scale', frame.clientWidth / 1920);
}
if (frame) { new ResizeObserver(fitPreview).observe(frame); fitPreview(); }

/* ------------------------------------------------------------ 攝影機 */

let pvCamStream = null;
let pvCamTok = 0;

function pvCamStop() {
  if (!pvCamStream) return;
  pvCamStream.getTracks().forEach(t => t.stop());
  pvCamStream = null;
  pvVideo.srcObject = null;
}
const pvOpenCam = id => navigator.mediaDevices.getUserMedia({
  audio: false,
  video: id ? { deviceId: { exact: id } } : true,
});

/* 裝置標籤要拿到攝影機權限後才看得到，所以清單一律在第一次 getUserMedia 成功之後填 */
async function pvListCams() {
  let devs = [];
  try {
    devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  } catch {}
  pvCamSel.innerHTML = '';
  if (!devs.length) pvCamSel.appendChild(new Option('（找不到攝影機）', ''));
  else devs.forEach((d, i) => pvCamSel.appendChild(new Option(d.label || `攝影機 ${i + 1}`, d.deviceId)));
  pvCamSel.value = pv.camId || '';
  return devs;
}

function pvCamErrText(e) {
  if (e.name === 'NotAllowedError') return '攝影機權限被拒 —— 請在網址列的權限圖示開放後再試一次';
  if (e.name === 'NotFoundError') return '找不到攝影機裝置';
  if (e.name === 'NotReadableError') return '攝影機被其他程式佔用（OBS？）';
  return String(e.message || e);
}

async function pvCamStart() {
  const tok = ++pvCamTok;
  const stale = () => tok !== pvCamTok || pv.mode !== 'camera';
  const drop = s => s.getTracks().forEach(t => t.stop());
  pvErr = '';
  pvStreamStop();
  pvCamStop();
  /* getUserMedia 只在安全來源存在 —— 從別台機器用 http://<IP>:3690 開 admin 就沒有 */
  if (!navigator.mediaDevices?.getUserMedia) {
    pvErr = window.isSecureContext
      ? '這個瀏覽器不支援攝影機存取'
      : `瀏覽器只在安全來源開放攝影機 —— 請改用 localhost 或 https 開啟 admin（目前是 ${location.origin}）`;
    pvPaint();
    return;
  }
  try {
    let stream = await pvOpenCam(pv.camId);
    if (stale()) return drop(stream);
    const devs = await pvListCams();
    let curId = stream.getVideoTracks()[0]?.getSettings?.().deviceId || '';
    /* 第一次用：沒存過裝置就優先挑虛擬攝影機，挑到的不是現在這台就換過去 */
    if (!pv.camId) {
      const want = devs.find(d => PV_VIRTUAL_RE.test(d.label))?.deviceId || curId;
      if (want && want !== curId) {
        drop(stream);
        stream = await pvOpenCam(want);
        curId = want;
      }
      pv.camId = curId;
      pvSave();
      pvCamSel.value = curId;
    }
    if (stale()) return drop(stream);
    pvCamStream = stream;
    pvVideo.srcObject = stream;
    pvVideo.play().catch(() => {});
  } catch (e) {
    /* 存過的那台不見了（拔線、或虛擬攝影機沒開）→ 清掉重挑一次，只會遞迴這一層 */
    if (pv.camId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
      pv.camId = '';
      pvSave();
      return pvCamStart();
    }
    pvErr = pvCamErrText(e);
  }
  pvPaint();
}

/* ------------------------------------------------------- WHEP 直播流 */
/* 精簡 WHEP client。握手與 srs.sdk.js 同一套（POST offer SDP → 回 answer，Location
 * 是 session resource，關閉時 DELETE 掉），但多做兩件 SDK 沒做、而這裡正是重點的事：
 *   receiver.jitterBufferTarget = 0 —— 不要建去抖動緩衝
 *   receiver.playoutDelayHint  = 0 —— 幀到了就畫，不要為了平滑再壓幾幀
 * 少了這兩行，Chromium 會自己壓著 150–250ms；區網來源不需要這個緩衝。
 * 另外刻意不設任何 STUN/TURN：只收 host candidate，區網直連，也省掉 gathering 的等待。 */

let pvPC = null;         // 目前的 RTCPeerConnection
let pvRes = null;        // WHEP session resource URL（來自 Location header）
let pvTok = 0;           // 讓還在飛的握手知道自己已經過期
let pvRetry = 0;         // 退避次數
let pvRetryTimer = 0;

function pvStreamStop() {
  clearTimeout(pvRetryTimer);
  pvRetryTimer = 0;
  pvTok++;
  if (pvPC) { try { pvPC.close(); } catch {} pvPC = null; }
  if (pvRes) { fetch(pvRes, { method: 'DELETE' }).catch(() => {}); pvRes = null; }
  if (pvVideo.srcObject && !pvCamStream) pvVideo.srcObject = null;
}

/* 沒設 STUN/TURN 就只會收集 host candidate，幾毫秒即完成。等它結束再送 offer，
 * 對不吃 trickle 的 WHEP server 也成立（SRS 不等也行，但別家會要）。 */
function pvIceReady(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', chk); resolve(); };
    const chk = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, 300);   // 保險絲：不讓 gathering 卡住連線
    pc.addEventListener('icegatheringstatechange', chk);
  });
}

/* 1s → 2s → 4s → 8s 封頂。先開 admin 再開台、SRS 中途重啟，都會自己接回來。 */
function pvScheduleRetry() {
  if (pv.mode !== 'stream' || pvRetryTimer) return;
  const wait = Math.min(8000, 1000 * 2 ** pvRetry++);
  pvRetryTimer = setTimeout(() => {
    pvRetryTimer = 0;
    if (pv.mode === 'stream') pvStreamConnect();
  }, wait);
  pvPaint();
}

function pvStreamErrText(e) {
  /* fetch 對「連不上」與「被 CORS 擋掉」都只給 TypeError: Failed to fetch */
  if (e instanceof TypeError) return '連不上串流伺服器（未開台、網址錯，或該 server 未開 CORS）';
  return String(e.message || e);
}

async function pvStreamConnect() {
  pvStreamStop();          // 內含 pvTok++，把任何還在飛的舊握手作廢
  const tok = pvTok;
  const url = (pv.url || '').trim();
  pvErr = '';
  if (!url) { pvErr = '請先填入 WHEP 網址'; pvPaint(); return; }

  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  pvPC = pc;
  const ms = new MediaStream();
  /* 一律協商 video＋audio：聲音預設靜音，要聽再按喇叭 */
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.ontrack = ev => {
    if (tok !== pvTok) return;
    try { ev.receiver.jitterBufferTarget = 0; } catch {}
    try { ev.receiver.playoutDelayHint = 0; } catch {}
    ms.addTrack(ev.track);
    if (pvVideo.srcObject !== ms) pvVideo.srcObject = ms;
    pvVideo.muted = pvMuted;
    pvVideo.play().catch(() => {});
  };
  pc.addEventListener('connectionstatechange', () => {
    if (tok !== pvTok) return;
    const s = pc.connectionState;
    if (s === 'connected') { pvRetry = 0; pvErr = ''; }
    else if (s === 'failed' || s === 'disconnected') pvScheduleRetry();
    pvPaint();
  });

  try {
    await pc.setLocalDescription(await pc.createOffer());
    await pvIceReady(pc);
    if (tok !== pvTok) return;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) throw new Error(`伺服器回應 HTTP ${res.status}`);
    const answer = await res.text();
    if (tok !== pvTok) return;          // 期間切走了模式／改了網址
    const loc = res.headers.get('Location');
    if (loc) pvRes = new URL(loc, url).href;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  } catch (e) {
    if (tok !== pvTok) return;
    pvErr = pvStreamErrText(e);
    pvScheduleRetry();
  }
  pvPaint();
}

/* ------------------------------------------------------ 模式與畫面 */

function pvPaint() {
  frame.dataset.bg = pv.mode;
  frame.dataset.overlay = pv.overlay ? '1' : '0';
  for (const b of pvSeg.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.dataset.bg === pv.mode);
  $('pvCamRow').style.display = pv.mode === 'camera' ? '' : 'none';
  $('pvStreamRow').style.display = pv.mode === 'stream' ? '' : 'none';
  $('pvMuteBtn').textContent = pvMuted ? '🔇' : '🔊';

  let txt = PV_LABEL[pv.mode];
  let on = false;
  if (pv.mode === 'camera') {
    on = !!pvCamStream;
    txt += ' · ' + (on ? (pvCamSel.selectedOptions[0]?.textContent || '已開啟') : '未開啟');
  } else if (pv.mode === 'stream') {
    on = pvPC?.connectionState === 'connected';
    txt += ' · ' + (pvRetryTimer ? '重試中…' : (pvPC ? (PV_CONN[pvPC.connectionState] || '') : '未連線'));
  }
  const pill = $('pvStatus');
  pill.textContent = txt;
  pill.classList.toggle('on', on);

  const note = $('pvNote');
  note.textContent = (pv.mode === 'camera' || pv.mode === 'stream') ? pvErr : '';
  note.classList.toggle('bad', !!note.textContent);
}

function pvApply() {
  pvPaint();               // UI 先反應，來源再慢慢接
  if (pv.mode !== 'camera') pvCamStop();
  if (pv.mode !== 'stream') pvStreamStop();
  if (pv.mode === 'camera') pvCamStart();
  else if (pv.mode === 'stream') pvStreamConnect();
}
function pvSetMode(m) {
  if (!PV_MODES.includes(m) || m === pv.mode) return;
  pv.mode = m;
  pvSave();
  pvErr = '';
  pvRetry = 0;
  pvApply();
}
function pvStreamApply() {
  pv.url = pvUrlIn.value.trim();
  pvSave();
  pvErr = '';
  pvRetry = 0;
  if (pv.mode === 'stream') pvStreamConnect();
  else pvSetMode('stream');
}

for (const b of pvSeg.querySelectorAll('.seg-btn')) {
  b.addEventListener('click', () => pvSetMode(b.dataset.bg));
}
pvCamSel.addEventListener('change', () => {
  pv.camId = pvCamSel.value;
  pvSave();
  if (pv.mode === 'camera') pvCamStart();
});
$('pvCamRefresh').addEventListener('click', () => pvCamStart());
$('pvStreamBtn').addEventListener('click', pvStreamApply);
pvUrlIn.addEventListener('keydown', e => { if (e.key === 'Enter') pvStreamApply(); });
$('pvMuteBtn').addEventListener('click', () => {
  pvMuted = !pvMuted;
  pvVideo.muted = pvMuted;
  if (!pvMuted) pvVideo.play().catch(() => {});   // 這一下就是 user gesture，autoplay 政策放行
  pvPaint();
});
/* 疊層開關走專案標準的「隱藏 checkbox ＋ seg」：seg 點擊由通用處理器寫進 checkbox 再
 * 補送 change，動作一律從這個 listener 出去。checkbox 就是真值來源，所以檔案後面
 * refresh() 尾端的 syncToggleSegs() 會照著它上色 —— 即使這個開關並不是 server state。 */
$('pvOverlay').addEventListener('change', e => {
  pv.overlay = e.target.checked;
  pvSave();
  pvPaint();
});
/* 插拔裝置／OBS 開關虛擬攝影機：還活著就只重列清單，斷了才整個重接 */
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  if (pv.mode !== 'camera') return;
  if (pvCamStream && pvCamStream.getVideoTracks()[0]?.readyState === 'live') pvListCams().then(pvPaint);
  else pvCamStart();
});

pvUrlIn.value = pv.url || '';
/* 只寫 checkbox，seg 的上色交給後面那支 syncToggleSegs()（它在本檔更後面才跑） */
$('pvOverlay').checked = pv.overlay;
pvVideo.muted = pvMuted;
pvApply();

/* Several cards hold 2+ label+control rows whose labels differ in width
 * (計分板 vs 名單, 小型/大型/全畫幅隊名, 流動速度/整體縮放/邊距 ...) — under plain
 * flex:1 each control just fills whatever room its own row's label left it,
 * so they end up different widths. Lock a family of controls to the NARROWEST
 * one's natural width (that row's label leaves the least room, so nothing else
 * can grow past it) — CSS (`.row > .seg.grow` / `.row > input[type=range]`)
 * then pushes each flush to the row's right edge, so they line up.
 *
 * The two families are scoped differently ON PURPOSE:
 *   segs   — per card. Each card carries its own scale and that reads fine.
 *   ranges — PAGE-WIDE. Sliders are spread thin (進球動效 and 名單自動翻頁 hold
 *            exactly one each), so per-card grouping skipped those cards and
 *            left them at full width next to 橫幅自動隱藏's locked pair — the
 *            mismatch Jason flagged. One global group makes every slider in the
 *            panel the same length regardless of which card it sits in.
 *
 * Hidden tabs measure 0 and are excluded (setTab re-syncs when they show).
 * Content is static text (never server state), so this only needs recomputing
 * when the available width changes: tab switch, window resize, webfont swap. */
function lockControlWidths(els) {
  els.forEach(s => { s.style.flex = ''; });   // release before re-measuring
  const live = els.filter(s => s.getBoundingClientRect().width > 0);
  if (live.length < 2) return;
  const w = Math.floor(Math.min(...live.map(s => s.getBoundingClientRect().width)));
  if (w > 0) live.forEach(s => { s.style.flex = `0 0 ${w}px`; });
}
function syncSegWidths() {
  document.querySelectorAll('.card').forEach(card => {
    lockControlWidths([...card.querySelectorAll(':scope > .row > .seg.grow')]);
  });
  lockControlWidths([...document.querySelectorAll('.row > input[type="range"]')]);
}
window.addEventListener('resize', throttle(syncSegWidths, 120));
if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncSegWidths).catch(() => {});

/* ------------------------------------------------ 開關（checkbox ⇄ seg） */
/* Every 開關 is a hidden checkbox + a 關閉/開啟 seg (same styling as every other
 * seg in the panel). The CHECKBOX remains the single source of truth, so all the
 * existing `$(id).checked = …` lines in refresh() and all the `change` listeners
 * keep working untouched — the seg is purely its face. A click writes the box and
 * re-dispatches `change`, so the action still leaves through the same handler. */
function syncToggleSegs() {
  document.querySelectorAll('.seg-toggle').forEach(seg => {
    const box = $(seg.dataset.for);
    if (!box) return;
    seg.querySelectorAll('.seg-btn').forEach(b =>
      b.classList.toggle('active', (b.dataset.val === '1') === box.checked));
  });
}
for (const seg of document.querySelectorAll('.seg-toggle')) {
  const box = $(seg.dataset.for);
  if (!box) continue;
  for (const b of seg.querySelectorAll('.seg-btn')) {
    b.addEventListener('click', () => {
      const on = b.dataset.val === '1';
      if (box.checked === on) return;
      box.checked = on;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      syncToggleSegs();   // paint immediately; the server echo confirms it
    });
  }
}
syncToggleSegs();   // paint the initial (unchecked) state before the first sync

/* ------------------------------------------- 比賽面板快捷鍵 */
/* One assignable key per interactive control on the 比賽 tab, PLUS one per 資訊橫幅
 * preset. Every seg / chip option is its OWN binding that SELECTS that specific value
 * (Jason: 不能是切換 seg，要指定選項) — triggering just clicks the native control (or
 * the preset button), so all existing logic (actions, guards) is reused verbatim.
 * Bindings live in SERVER state (state.hotkeys, settings-exported) so they persist and
 * sync across admin clients (Jason 2026-07-17: 存 server.json). Shortcuts do NOT fire
 * while a text field is focused (the lesson behind Jason removing the old global
 * Space/1/2/B/E keys 2026-07-10 — accidental live triggers); they DO work from any tab,
 * since the live controls are always in the DOM. */
const HK_GROUPS = [
  ['計時', [
    ['tmToggle', '開始／暫停', '#startPause'],
    ['tmReset', '重置計時', '#timerReset'],
    ['tmM60', '計時 −1:00', '.adjust-row .btn[data-adj="-60000"]'],
    ['tmM10', '計時 −0:10', '.adjust-row .btn[data-adj="-10000"]'],
    ['tmM1', '計時 −0:01', '.adjust-row .btn[data-adj="-1000"]'],
    ['tmP1', '計時 +0:01', '.adjust-row .btn[data-adj="1000"]'],
    ['tmP10', '計時 +0:10', '.adjust-row .btn[data-adj="10000"]'],
    ['tmP60', '計時 +1:00', '.adjust-row .btn[data-adj="60000"]'],
    ['tmWClock', '字樣 → 比賽計時', '#modeSeg .seg-btn[data-mode="clock"]'],
    ['tmWBreak', '字樣 → BREAK', '#modeSeg .seg-btn[data-mode="break"]'],
    ['tmWPause', '字樣 → PAUSE', '#modeSeg .seg-btn[data-mode="pause"]'],
    ['tmWEnd', '字樣 → MATCH END', '#modeSeg .seg-btn[data-mode="matchEnd"]'],
  ]],
  ['比分', [
    ['scGoalA', '主隊 A · GOAL', '#goalA'],
    ['scMinusA', '主隊 A · −1', '#minusA'],
    ['scPlusA', '主隊 A · +1', '#plusA'],
    ['scGoalB', '客隊 B · GOAL', '#goalB'],
    ['scMinusB', '客隊 B · −1', '#minusB'],
    ['scPlusB', '客隊 B · +1', '#plusB'],
  ]],
  ['畫面與節次', [
    ['tierOff', '計分板 → 關閉', '#tierSeg .seg-btn[data-tier="off"]'],
    ['tierSmall', '計分板 → 小型', '#tierSeg .seg-btn[data-tier="small"]'],
    ['tierLarge', '計分板 → 大型', '#tierSeg .seg-btn[data-tier="large"]'],
    ['tierFull', '計分板 → 全畫幅', '#tierSeg .seg-btn[data-tier="full"]'],
    ['tierPreparing', '計分板 → PREPARING', '#tierSeg .seg-btn[data-tier="preparing"]'],
    ['pd1', '節次 → 1ST HALF', '#periodChips .chip[data-p="1ST HALF"]'],
    ['pd2', '節次 → 2ND HALF', '#periodChips .chip[data-p="2ND HALF"]'],
    ['pdHT', '節次 → HALFTIME', '#periodChips .chip[data-p="HALFTIME"]'],
    ['pdOT1', '節次 → OT 1', '#periodChips .chip[data-p="OT 1"]'],
    ['pdOT2', '節次 → OT 2', '#periodChips .chip[data-p="OT 2"]'],
    ['pdSO', '節次 → SHOOTOUT', '#periodChips .chip[data-p="SHOOTOUT"]'],
    ['rmOff', '名單 → 關閉', '#rosterModeSeg .seg-btn[data-mode="off"]'],
    ['rmA', '名單 → 主隊 A', '#rosterModeSeg .seg-btn[data-mode="A"]'],
    ['rmB', '名單 → 客隊 B', '#rosterModeSeg .seg-btn[data-mode="B"]'],
    ['rmBoth', '名單 → 全部', '#rosterModeSeg .seg-btn[data-mode="both"]'],
    ['rPrev', '名單上一頁', '#rPagePrev'],
    ['rNext', '名單下一頁', '#rPageNext'],
  ]],
  ['橫幅', [
    ['ibShow', '資訊橫幅 · 顯示', '#ibShowBtn'],
    ['ibHide', '資訊橫幅 · 隱藏', '#ibHideBtn'],
    ['bbShow', '底部橫幅 · 顯示', '#bbShowBtn'],
    ['bbHide', '底部橫幅 · 隱藏', '#bbHideBtn'],
    ['bbSeqPlay', '底部序列 · 播放', '#bbSeqPlayBtn'],
    ['bbSeqStop', '底部序列 · 停止', '#bbSeqStopBtn'],
  ]],
];
/* every 資訊橫幅 preset gets a shortcut too — its target is the dynamically-created
 * preset button (ibBtnByKey), so it carries a run() rather than a CSS selector.
 * Pressing it FILLS the editor with that preset (re-press shows it, mirroring the
 * button's own click behaviour). */
HK_GROUPS.push(['資訊橫幅預設', IB_PRESETS.map(p => [
  'ib:' + p.key,
  (p.cat === 'CONTROL' ? '控制' : '裁判') + ' · ' + p.title,
  { run: () => { const b = ibBtnByKey[p.key]; if (b) b.click(); } },
])]);

const HK_ITEMS = {};
for (const [, items] of HK_GROUPS) for (const [id, label, target] of items) {
  HK_ITEMS[id] = (typeof target === 'string') ? { label, sel: target } : { label, run: target.run };
}

let hkBindings = {};            // mirror of state.hotkeys (server is the source of truth)
let lastHkJson = '';            // last synced server map, to skip redundant re-renders
let hkRec = null;               // action id currently recording a key
let hkFlashId = null, hkFlashMsg = '';
let hkFlashTimer = 0;

/* push the whole map to the server (it replaces state.hotkeys wholesale); set
 * lastHkJson so our own echo doesn't trigger a needless re-render */
function hkPush() {
  lastHkJson = JSON.stringify(hkBindings);
  act('hotkeys.set', { hotkeys: hkBindings });
}
/* pull server state into the card (skipped mid-recording so it can't clobber it) */
function hkSyncFromState(s) {
  if (hkRec) return;
  const hj = JSON.stringify(s.hotkeys || {});
  if (hj === lastHkJson) return;
  lastHkJson = hj;
  hkBindings = JSON.parse(hj);
  renderHotkeys();
}
const HK_MOD_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);
function hkCombo(e) {
  const m = [];
  if (e.ctrlKey) m.push('Ctrl');
  if (e.altKey) m.push('Alt');
  if (e.shiftKey) m.push('Shift');
  m.push(e.code);
  return m.join('+');
}
const HK_KEYNAMES = {
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: '⌫',
  Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Backquote: '`',
};
function hkKeyLabel(combo) {
  return combo.split('+').map(p => {
    if (p.startsWith('Key')) return p.slice(3);
    if (p.startsWith('Digit')) return p.slice(5);
    if (p.startsWith('Numpad')) return 'Num' + p.slice(6);
    return HK_KEYNAMES[p] || p;
  }).join('+');
}
function hkFlash(id, msg) {
  hkFlashId = id; hkFlashMsg = msg;
  clearTimeout(hkFlashTimer);
  hkFlashTimer = setTimeout(() => { hkFlashId = null; hkFlashMsg = ''; renderHotkeys(); }, 2200);
  renderHotkeys();
}
function renderHotkeys() {
  const host = $('hkList');
  if (!host) return;
  host.innerHTML = '';
  for (const [title, items] of HK_GROUPS) {
    const g = document.createElement('div');
    g.className = 'hk-group';
    const h = document.createElement('div');
    h.className = 'hk-group-title';
    h.textContent = title;
    g.append(h);
    for (const [id, label] of items) {
      const row = document.createElement('div');
      row.className = 'hk-row' + (hkRec === id ? ' rec' : '') + (hkFlashId === id ? ' clash' : '');
      const lb = document.createElement('span');
      lb.className = 'hk-label';
      lb.textContent = label;
      const key = document.createElement('span');
      const bound = hkBindings[id];
      if (hkRec === id) { key.className = 'hk-key'; key.textContent = '按鍵…'; }
      else if (bound) { key.className = 'hk-key'; key.textContent = hkKeyLabel(bound); }
      else { key.className = 'hk-key empty'; key.textContent = '未設定'; }
      const set = document.createElement('button');
      set.className = 'hk-set';
      set.textContent = hkRec === id ? '取消' : '設定';
      set.addEventListener('click', () => { hkRec = hkRec === id ? null : id; renderHotkeys(); });
      row.append(lb, key, set);
      if (hkFlashId === id) {
        const fl = document.createElement('span');
        fl.className = 'hk-flash';
        fl.textContent = hkFlashMsg;
        row.append(fl);
      } else if (bound && hkRec !== id) {
        const clr = document.createElement('button');
        clr.className = 'hk-clear';
        clr.textContent = '清除';
        clr.addEventListener('click', () => { delete hkBindings[id]; hkPush(); renderHotkeys(); });
        row.append(clr);
      }
      g.append(row);
    }
    host.append(g);
  }
}
$('hkClearAll').addEventListener('click', () => {
  if (!Object.keys(hkBindings).length) return;
  if (confirm('清除所有快捷鍵綁定？')) { hkBindings = {}; hkPush(); hkRec = null; renderHotkeys(); }
});
window.addEventListener('keydown', e => {
  /* recording a new binding — capture the next real key, reject conflicts */
  if (hkRec) {
    if (HK_MOD_CODES.has(e.code)) return;   // a bare modifier — wait for the real key
    e.preventDefault();
    if (e.code === 'Escape') { hkRec = null; renderHotkeys(); return; }
    const combo = hkCombo(e);
    const clashId = Object.keys(hkBindings).find(k => hkBindings[k] === combo && k !== hkRec);
    if (clashId) { hkFlash(hkRec, '衝突：已用於「' + (HK_ITEMS[clashId] ? HK_ITEMS[clashId].label : clashId) + '」'); return; }
    hkBindings[hkRec] = combo;
    hkPush();
    hkRec = null;
    renderHotkeys();
    return;
  }
  /* dispatch — never while typing in a field */
  const a = document.activeElement;
  if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
  const combo = hkCombo(e);
  const id = Object.keys(hkBindings).find(k => hkBindings[k] === combo);
  const item = id && HK_ITEMS[id];
  if (!item) return;
  if (item.run) { e.preventDefault(); item.run(); return; }
  const el = document.querySelector(item.sel);
  if (!el) return;
  e.preventDefault();
  el.click();
});
renderHotkeys();

/* ------------------------------------------------------------ 回放 */
/* 回放分頁：伺服器擁有播放頭；這裡只發 replay.* 動作並把時間軸畫出來。
 * 拖動夾在相鄰事件點之間（本地夾制＝樂觀 UI，伺服器仍會再夾一次）；
 * 跨越事件點只能用跳轉按鈕（事件前 10 秒）／開頭結尾／播放。 */

let rpModel = buildReplayModel([]);
let rpTrackKey = '';
let rpEventsKey = '';
let rpDrag = null;        // { lo, hi, head } — 拖動中（lo/hi = 本段邊界）
let rpTabShown = false;
let rpPreviewMade = false;

/* 事件的比賽時鐘（entry.clock = remainingMs；正計時反轉）＋節次 */
function fmtEntryClock(mk, s) {
  let v = Math.max(0, Number(mk.clock) || 0);
  if (s.timer.direction === 'up') v = Math.max(0, (s.timer.durationMs || 0) - v);
  const sec = Math.floor(v / 1000);
  return (mk.period ? mk.period + ' · ' : '') + `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
const rpInk = c => (relLuminance(c) > 0.42 ? '#0D0F13' : '#fff');

function renderRpTrack(s) {
  const host = $('rpTrackMarks');
  const key = rpModel.marks.map(mk => mk.id).join(',') + '|' + rpModel.t0 + '|' + rpModel.t1
    + '|' + s.teams.A.color + s.teams.B.color;
  if (key === rpTrackKey) return;
  rpTrackKey = key;
  host.innerHTML = '';
  if (rpModel.empty) return;
  const span = Math.max(1, rpModel.t1 - rpModel.t0);
  for (const mk of rpModel.marks) {
    const el = document.createElement('span');
    el.className = 'rp-tm';
    el.dataset.utc = mk.utc;
    el.style.left = ((mk.utc - rpModel.t0) / span * 100).toFixed(3) + '%';
    const lb = markLabel(mk, s.teams);
    el.title = `${lb.head === '!' ? '' : lb.head + ' '}${lb.text} · 點擊跳到事件前 10 秒`;
    if (mk.kind === 'goal') {
      el.style.setProperty('--mk-bg', s.teams[mk.team].color);
      el.style.setProperty('--mk-ink', rpInk(s.teams[mk.team].color));
    } else {
      el.style.setProperty('--mk-bg', mk.tone);
      el.style.setProperty('--mk-ink', mk.fg);
      el.textContent = '!';
    }
    el.addEventListener('click', ev => {
      ev.stopPropagation();
      if (st && st.replay && st.replay.active) act('replay.jump', { entryId: mk.id });
    });
    host.append(el);
  }
}

function renderRpEvents(s) {
  const host = $('rpEvents');
  const key = rpModel.marks.map(mk => mk.id).join(',')
    + '|' + (s.teams.A.short || '') + (s.teams.B.short || '') + s.timer.direction;
  if (key === rpEventsKey) return;
  rpEventsKey = key;
  host.innerHTML = '';
  for (const mk of rpModel.marks) {
    const row = document.createElement('div');
    row.className = 'rp-ev';
    row.dataset.utc = mk.utc;
    const clock = document.createElement('span');
    clock.className = 'rp-ev-clock';
    clock.textContent = fmtEntryClock(mk, s);
    const chip = document.createElement('span');
    chip.className = 'rp-ev-chip';
    const lb = markLabel(mk, s.teams);
    chip.textContent = lb.head;
    if (mk.kind === 'goal') {
      chip.style.setProperty('--mk-bg', s.teams[mk.team].color);
      chip.style.setProperty('--mk-ink', rpInk(s.teams[mk.team].color));
    } else {
      chip.style.setProperty('--mk-bg', mk.tone);
      chip.style.setProperty('--mk-ink', mk.fg);
    }
    const text = document.createElement('span');
    text.className = 'rp-ev-text';
    text.textContent = lb.text;
    const jump = document.createElement('button');
    jump.className = 'btn sm';
    jump.textContent = '▶ 前10秒';
    jump.title = '跳到此事件前 10 秒並繼續播放';
    jump.addEventListener('click', () => {
      if (st && st.replay && st.replay.active) act('replay.jump', { entryId: mk.id });
    });
    row.append(clock, chip, text, jump);
    host.append(row);
  }
}

function refreshReplay(s) {
  const r = s.replay || {};
  const on = !!r.active;
  $('tabBtnReplay').classList.toggle('rec', on);
  const tog = $('rpToggleBtn');
  tog.textContent = on ? '結束回放' : '進入回放';
  tog.classList.toggle('primary', !on);
  tog.classList.toggle('warn', on);
  const stat = $('rpStatus');
  stat.textContent = on ? (r.playing ? '回放中 · 播放' : '回放中 · 暫停') : '未啟動';
  stat.classList.toggle('on', on);
  document.querySelectorAll('#rpTierSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tier === (r.tier || 'large')));
  $('rpScores').checked = r.showScores !== false;
  const play = $('rpPlayBtn');
  play.textContent = r.playing ? '⏸ 暫停' : '▶ 播放';
  play.classList.toggle('playing', !!r.playing);
  $('rpTrack').classList.toggle('disabled', !on || rpModel.empty);
  renderRpTrack(s);
  renderRpEvents(s);
  document.querySelectorAll('.rp-transport .btn, #rpEvents .btn').forEach(b => { b.disabled = !on; });
}

/* ---- 控制 ---- */
$('rpToggleBtn').addEventListener('click', () => {
  if (!st) return;
  if (st.replay && st.replay.active) {
    if (confirm('結束回放並還原現場畫面？')) act('replay.stop');
  } else {
    act('replay.start');
  }
});
document.querySelectorAll('#rpTierSeg .seg-btn').forEach(b =>
  b.addEventListener('click', () => act('replay.tier', { tier: b.dataset.tier })));
$('rpScores').addEventListener('change', e => act('replay.scores', { show: e.target.checked }));
$('rpPlayBtn').addEventListener('click', async () => {
  if (!st || !st.replay) return;
  const res = await act(st.replay.playing ? 'replay.pause' : 'replay.play');
  if (res && res.ok === false && res.error) alert(res.error);
});
document.querySelectorAll('[data-rpnudge]').forEach(b =>
  b.addEventListener('click', () => {
    if (!st || !st.replay || !st.replay.active) return;
    act('replay.seek', { utc: replayHead(st.replay, serverNow()) + Number(b.dataset.rpnudge) });
  }));
$('rpToStart').addEventListener('click', () => {
  if (!rpModel.empty) act('replay.seek', { utc: rpModel.t0, free: true });
});
$('rpToEnd').addEventListener('click', () => {
  if (!rpModel.empty) act('replay.seek', { utc: rpModel.t1, free: true });
});

/* ---- 時間軸拖動（不可穿過事件點）---- */
{
  const track = $('rpTrack');
  const utcAtX = ev => {
    const r = track.getBoundingClientRect();
    const f = clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1);
    return rpModel.t0 + f * (rpModel.t1 - rpModel.t0);
  };
  const sendSeek = throttle(utc => act('replay.seek', { utc }), 90);
  track.addEventListener('pointerdown', ev => {
    if (!st || !st.replay || !st.replay.active || rpModel.empty) return;
    if (ev.target.closest('.rp-tm')) return;   // 事件點本身是跳轉按鈕
    track.setPointerCapture(ev.pointerId);
    const h0 = replayHead(st.replay, serverNow());
    let lo = rpModel.t0, hi = rpModel.t1;      // 本段邊界（與 server 夾制同規則）
    for (const mk of rpModel.marks) {
      if (mk.utc < h0) { if (mk.utc + 1 > lo) lo = mk.utc + 1; }
      else { if (mk.utc < hi) hi = mk.utc; break; }
    }
    if (lo > hi) lo = hi;
    rpDrag = { lo, hi, head: Math.min(hi, Math.max(lo, utcAtX(ev))) };
    const span = Math.max(1, rpModel.t1 - rpModel.t0);
    track.style.setProperty('--seg-lo', ((lo - rpModel.t0) / span * 100).toFixed(2) + '%');
    track.style.setProperty('--seg-hi', ((hi - rpModel.t0) / span * 100).toFixed(2) + '%');
    track.classList.add('dragging');
    sendSeek(rpDrag.head);
  });
  track.addEventListener('pointermove', ev => {
    if (!rpDrag) return;
    rpDrag.head = Math.min(rpDrag.hi, Math.max(rpDrag.lo, utcAtX(ev)));
    sendSeek(rpDrag.head);
  });
  const endDrag = () => {
    if (!rpDrag) return;
    act('replay.seek', { utc: rpDrag.head });  // 收尾以最終位置為準
    rpDrag = null;
    track.classList.remove('dragging');
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
}

/* ---- 預覽（本分頁首次開啟才載入 iframe，與 OBS 同源 /overlay）---- */
function rpEnsurePreview() {
  if (rpPreviewMade) return;
  rpPreviewMade = true;
  const ifr = document.createElement('iframe');
  ifr.className = 'pv-layer';
  ifr.src = '/overlay';
  ifr.setAttribute('scrolling', 'no');
  $('rpPreviewFrame').append(ifr);
}
const rpFrame = $('rpPreviewFrame');
function rpFitPreview() { if (rpFrame) rpFrame.style.setProperty('--pv-scale', rpFrame.clientWidth / 1920); }
if (rpFrame) { new ResizeObserver(rpFitPreview).observe(rpFrame); rpFitPreview(); }

/* ------------------------------------------------------------ tabs */

const TAB_KEY = 'sbx.tab';
function setTab(name) {
  if (!document.getElementById('tab-' + name)) name = 'live';
  document.querySelectorAll('#tabbar .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-page').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  try { localStorage.setItem(TAB_KEY, name); } catch {}
  fitPreview();   // the frame only has real dimensions while its tab shows
  syncSegWidths();   // ditto — a hidden tab's cards measure 0 width
  rpTabShown = name === 'replay';
  if (rpTabShown) { rpEnsurePreview(); rpFitPreview(); }
}
document.querySelectorAll('#tabbar .tab-btn').forEach(b => {
  b.addEventListener('click', () => setTab(b.dataset.tab));
});
let savedTab = 'live';
try { savedTab = localStorage.getItem(TAB_KEY) || 'live'; } catch {}
setTab(savedTab);

/* ------------------------------------------------------------ loop */

function loop() {
  requestAnimationFrame(loop);
  if (!st) return;
  const rem = timerRemaining(st.timer);
  const word = clockWordFor(st);
  const big = $('timerBig');
  const dir = st.timer.direction === 'up' ? 'up' : 'down';
  const display = dir === 'up' ? Math.max(0, st.timer.durationMs - rem) : rem;
  const txt = fmtClock(display, dir);
  if (big.textContent !== txt) big.textContent = txt;
  big.classList.toggle('urgent', rem <= 60000 && rem > 10000 && st.timer.running);
  big.classList.toggle('critical', rem <= 10000 && st.timer.running);
  $('timerWord').textContent = word || '';
  const durS = Math.floor(st.timer.durationMs / 1000);
  const durTxt = ` / ${Math.floor(durS / 60)}:${String(durS % 60).padStart(2, '0')}`;
  if ($('timerDur').textContent !== durTxt) $('timerDur').textContent = durTxt;
  /* live 2-min suspension countdowns in the active-icon list */
  document.querySelectorAll('.ab-count[data-msleft]').forEach(n => {
    const msLeft = +n.dataset.msleft;
    const running = n.dataset.running === '1';
    const ref = +n.dataset.ref;
    const left = Math.max(0, Math.min(120000, running ? msLeft - (serverNow() - ref) : msLeft));
    const s = Math.ceil(left / 1000);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (n.textContent !== t) n.textContent = t;
  });
  /* live team-timeout countdowns (real time) */
  document.querySelectorAll('.ab-count[data-endsat]').forEach(n => {
    const left = Math.max(0, Math.min(60000, +n.dataset.endsat - serverNow()));
    const s = Math.ceil(left / 1000);
    const t = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (n.textContent !== t) n.textContent = t;
  });
  /* 回放時間軸：滑塊／進度／讀數／事件列 done-next 著色（僅在回放分頁時更新） */
  if (rpTabShown && st.replay && st.replay.active && !rpModel.empty) {
    const span = Math.max(1, rpModel.t1 - rpModel.t0);
    let h = rpDrag ? rpDrag.head : replayHead(st.replay, serverNow());
    h = Math.min(rpModel.t1, Math.max(rpModel.t0, h));
    const pct = ((h - rpModel.t0) / span * 100).toFixed(3) + '%';
    $('rpThumb').style.left = pct;
    $('rpTrackDone').style.width = pct;
    const info = `${fmtMs(h - rpModel.t0)} / ${fmtMs(span)}`;
    if ($('rpTimeInfo').textContent !== info) $('rpTimeInfo').textContent = info;
    let nextSeen = false;
    document.querySelectorAll('#rpEvents .rp-ev').forEach(row => {
      const done = +row.dataset.utc < h;
      row.classList.toggle('done', done);
      const isNext = !done && !nextSeen;
      if (isNext) nextSeen = true;
      row.classList.toggle('next', isNext);
    });
    document.querySelectorAll('#rpTrackMarks .rp-tm').forEach(mEl =>
      mEl.classList.toggle('future', +mEl.dataset.utc >= h));
  }
}
requestAnimationFrame(loop);

/* match pagination */
$('mPagePrev').addEventListener('click', () => {
  if (matchPage > 0) { matchPage--; renderMatches(); }
});
$('mPageNext').addEventListener('click', () => {
  const total = Math.max(1, Math.ceil(matchesSummary.length / MATCHES_PER_PAGE));
  if (matchPage < total - 1) { matchPage++; renderMatches(); }
});

/* ------------------------------------------------------------ boot */

connect({
  onSync(msg) {
    matchesSummary = msg.matches || [];
    activeMatchId = msg.activeMatchId || null;
    assetsList = msg.assets || { banner: [], corner: [], flag: [] };
    bbSeqRunInfo = msg.bbSeqRun || null;
    /* 回放日誌（帶清單的那次廣播才重建；key 未變的高頻 seek 廣播不帶） */
    if (msg.replayLog !== undefined) {
      rpModel = buildReplayModel(msg.replayLog);
      rpTrackKey = '';
      rpEventsKey = '';
    }
    refresh(msg.state);
    renderMatches();
  },
  onStatus(ok) { $('conn').classList.toggle('on', ok); },
});
