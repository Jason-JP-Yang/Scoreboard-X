/* Scoreboard-X admin — every control maps to a server action; the UI itself
 * re-renders from SSE state, so several admins (PC + phone) stay in sync. */
import { connect, act, serverNow } from '/shared/net.js';
import { buildPalette, relLuminance } from '/shared/palette.js';

const $ = id => document.getElementById(id);
let st = null;
let bannerTeam = 'A';
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
function fmtClockShort(ms, direction) {
  ms = Math.max(0, ms);
  const ds = Math.floor(ms / 100) % 10;
  if (direction === 'up') {
    const s = Math.floor(ms / 1000);
    const min = Math.floor(s / 60);
    const sec = s % 60;
    const pMin = (min === 0 && sec === 0) ? '00' : String(min);
    const pSec = String(sec).padStart(2, '0');
    return `${pMin}:${pSec}.${ds}`;
  }
  if (ms < 10000) return `${Math.floor(ms / 1000)}.${ds}`;
  if (ms < 60000) {
    const s = Math.floor(ms / 1000);
    return `0:${String(s).padStart(2, '0')}.${ds}`;
  }
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${ds}`;
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
    const susp = b.type === 'SUSP2' && b.susp
      ? ` data-msleft="${Number(b.susp.msLeft) || 0}" data-ref="${Number(b.susp.refEpoch) || 0}" data-running="${b.susp.running ? 1 : 0}"`
      : '';
    item.innerHTML = `
      <span class="ab-dot" style="--dot:${meta.color}"></span>
      <span class="ab-team">${(s.teams[b.team].short || '').toUpperCase()}</span>
      <span class="ab-label">${meta.label}</span>
      <span class="ab-count"${susp}></span>
      <button class="ab-x" title="移除">✕</button>`;
    item.querySelector('.ab-x').addEventListener('click', () => act('banner.hide', { id: b.id }));
    host.append(item);
  }
}

function refresh(s) {
  st = s;

  /* quick bar + score card */
  $('qGoalAName').textContent = (s.teams.A.short || 'A').toUpperCase();
  $('qGoalBName').textContent = (s.teams.B.short || 'B').toUpperCase();
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
    const qg = $(t === 'A' ? 'qGoalA' : 'qGoalB');
    qg.style.setProperty('--goal-c', s.teams[t].color);
    qg.style.setProperty('--goal-ink', ink);
  }

  /* banner card */
  $('segTeamA').textContent = (s.teams.A.short || 'A').toUpperCase();
  $('segTeamB').textContent = (s.teams.B.short || 'B').toUpperCase();
  renderActiveBanners(s);

  /* info banner card */
  const ib = s.infoBanner;
  const ibs = $('ibStatus');
  ibs.textContent = ib
    ? `目前顯示：${ib.cat === 'CONTROL' ? 'MATCH CONTROL' : 'REFEREE'} · ${ib.title}`
    : '目前未顯示';
  ibs.classList.toggle('on', !!ib);

  /* timer card */
  const running = s.timer.running;
  for (const b of [$('startPause'), $('qStartPause')]) {
    b.textContent = running ? '暫停' : '開始';
    b.classList.toggle('running', running);
    b.classList.add('primary');
  }
  document.querySelectorAll('#modeSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === s.timer.mode));
  $('autoPauseWord').checked = !!s.timer.autoPauseWord;
  $('pauseAlternate').checked = !!s.timer.pauseAlternate;
  $('autoEndMode').checked = !!s.timer.autoEndMode;
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
  const goalEffect = s.board.goalEffect || 'full';
  document.querySelectorAll('#goalEffectSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.effect === goalEffect));
  $('rowGoalSec').style.display = goalEffect === 'minimal' ? 'none' : '';
  $('swAutoBreak').checked = !!s.board.autoExpandBreak;
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

  /* info card */
  $('swEvent').checked = !!s.event.visible;
  setVal($('eventText'), s.event.text);
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
  if (rj !== lastRosterJson) { lastRosterJson = rj; renderRosterEditor(); }

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
  renderBbPicker();
  renderOrgList();
  renderCornerGrid();
}

/* would the overlay be suppressing the bottom banner right now? (status hint only) */
function bbYielding(s) {
  const autoFull = s.board.autoExpandBreak && !!clockWordFor(s);
  const tier = autoFull ? 'full' : (s.board.tier || 'large');
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
$('qGoalA').addEventListener('click', () => act('goal', { team: 'A' }));
$('qGoalB').addEventListener('click', () => act('goal', { team: 'B' }));
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

/* banners */
document.querySelectorAll('#bannerTeamSeg .seg-btn').forEach(b => {
  b.addEventListener('click', () => {
    bannerTeam = b.dataset.team;
    document.querySelectorAll('#bannerTeamSeg .seg-btn').forEach(x => x.classList.toggle('active', x === b));
  });
});
document.querySelectorAll('.banner-btns .bn').forEach(b => {
  b.addEventListener('click', () => act('banner.show', { team: bannerTeam, bannerType: b.dataset.type }));
});
$('clearBanners').addEventListener('click', () => act('banner.clear'));

/* info banner — quick-fill presets: [key, cat, chip title, tone, fg, 觀眾解釋預填] */
const IB_PRESETS = [
  ['GOAL_DISALLOWED', 'REFEREE', 'GOAL DISALLOWED',    '#E0132F', '#FFFFFF', '球完全越線前已有犯規，此球不計分。'],
  ['SEVEN_METRE',     'REFEREE', '7-METRE THROW',      '#E0132F', '#FFFFFF', '明顯得分機會遭犯規破壞，判罰七米球。'],
  ['FREE_THROW',      'REFEREE', 'FREE THROW',         '#57606E', '#FFFFFF', '進攻方獲自由球，於犯規地點重新開球。'],
  ['YELLOW_CARD',     'REFEREE', 'YELLOW CARD',        '#F5C400', '#15181E', '對違反運動精神或累犯行為的正式警告。'],
  ['SUSP_2MIN',       'REFEREE', '2-MIN SUSPENSION',   '#FF8A00', '#15181E', '球員被罰離場兩分鐘，該隊將少一人應戰。'],
  ['SUSP_EXPIRED',    'REFEREE', 'SUSPENSION EXPIRED', '#0E9E64', '#FFFFFF', '罰時結束，球員歸隊，恢復滿員應戰。'],
  ['RED_CARD',        'REFEREE', 'RED CARD',           '#C4001D', '#FFFFFF', '取消比賽資格，該球員不得繼續參賽。'],
  ['BLUE_CARD',       'REFEREE', 'BLUE CARD',          '#1E6ADB', '#FFFFFF', '取消資格並提交書面報告，賽後可能追加處分。'],
  ['THROW_IN',        'REFEREE', 'THROW-IN',           '#57606E', '#FFFFFF', '球出邊線，由對方擲界外球恢復比賽。'],
  ['GK_THROW',        'REFEREE', 'GK THROW',           '#57606E', '#FFFFFF', '球越底線，由守門員擲球門球恢復比賽。'],
  ['THROW_OFF',       'CONTROL', 'THROW-OFF',          '#2F6FED', '#FFFFFF', '由中線開球，比賽開始。'],
  ['TEAM_TIMEOUT',    'CONTROL', 'TEAM TIME-OUT',      '#0E9E64', '#FFFFFF', '球隊請求暫停，時長一分鐘。'],
  ['MEDICAL_TIMEOUT', 'CONTROL', 'MEDICAL TIME-OUT',   '#0FA3B1', '#FFFFFF', '場上球員接受治療，比賽暫停。'],
  ['HALF_TIME',       'CONTROL', 'HALF-TIME',          '#2F6FED', '#FFFFFF', '半場結束，中場休息。'],
  ['PLAY_SUSPENDED',  'CONTROL', 'PLAY SUSPENDED',     '#FF8A00', '#15181E', '比賽暫時中斷，恢復時間另行通知。'],
  ['RESUME',          'CONTROL', 'RESUME',             '#0E9E64', '#FFFFFF', '比賽即將恢復。'],
  ['TIME_CALIBRATE',  'CONTROL', 'TIME-CALIBRATE',     '#2F6FED', '#FFFFFF', '正在校正官方比賽計時。'],
];
let ibSel = null;
function ibPickPreset(entry, btn) {
  ibSel = entry;
  $('ibTitle').value = entry[2];
  $('ibPlayer').value = '';
  $('ibReason').value = '';
  $('ibBody').value = entry[5];
  const badge = $('ibCatBadge');
  badge.textContent = entry[1] === 'CONTROL' ? 'MATCH CONTROL' : 'REFEREE';
  badge.classList.toggle('ctl', entry[1] === 'CONTROL');
  document.querySelectorAll('.preset-grid .pv').forEach(x => x.classList.toggle('active', x === btn));
}
for (const entry of IB_PRESETS) {
  const btn = document.createElement('button');
  btn.className = 'btn pv';
  btn.style.setProperty('--pv', entry[3]);
  btn.textContent = entry[2];
  btn.addEventListener('click', () => ibPickPreset(entry, btn));
  $(entry[1] === 'CONTROL' ? 'ibPresetsCtl' : 'ibPresetsRef').append(btn);
}
$('ibShowBtn').addEventListener('click', () => {
  const cat = $('ibCatBadge').classList.contains('ctl') ? 'CONTROL' : 'REFEREE';
  const title = $('ibTitle').value.trim();
  const body = [$('ibPlayer').value.trim(), $('ibReason').value.trim(), $('ibBody').value.trim()]
    .filter(Boolean).join(' — ');
  if (!title && !body) return;
  act('info.show', {
    key: ibSel ? ibSel[0] : '',
    cat,
    title: title || 'INFO',
    body,
    tone: ibSel ? ibSel[3] : (cat === 'CONTROL' ? '#2F6FED' : '#E0132F'),
    fg: ibSel ? ibSel[4] : '#FFFFFF',
  });
});
$('ibHideBtn').addEventListener('click', () => act('info.hide'));

/* ------------------------------------------------- bottom banner card */
/* Picker = every candidate laid out flat (no dropdown), grouped A隊 / B隊 / 賽事人員 /
 * 機構, live-filtered by the text box. Click selects (click again unselects); the
 * 顯示橫幅 button puts the selection on air (Jason: 先選取再按顯示). The chip whose
 * card is currently on air gets a green edge. Orgs need name+role configured first. */

const BB_ROLE_LABEL = {
  LEADER: '領隊', COACH: '教練', STAFF: '工作人員', PLAYER: '球員',
  COMMENTATOR: '評論員', REFEREE: '裁判',
};
const noExt = f => String(f).replace(/\.[^.]+$/, '');

let assetsList = { banner: [], corner: [] };   // folder listings, from every SSE payload
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
  else b.addEventListener('click', () => {
    bbSel = bbSelIs(sel) ? null : sel;   // click again to unselect
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

/* timer */
function toggleTimer() { if (st) act(st.timer.running ? 'timer.pause' : 'timer.start'); }
$('startPause').addEventListener('click', toggleTimer);
$('qStartPause').addEventListener('click', toggleTimer);
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
$('autoEndMode').addEventListener('change', e => patch({ timer: { autoEndMode: e.target.checked } }));
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
document.querySelectorAll('#goalEffectSeg .seg-btn').forEach(b => {
  b.addEventListener('click', () => patch({ board: { goalEffect: b.dataset.effect } }));
});
$('swAutoBreak').addEventListener('change', e => patch({ board: { autoExpandBreak: e.target.checked } }));
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

/* info */
$('swEvent').addEventListener('change', e => patch({ event: { visible: e.target.checked } }));
function applyEvent() { patch({ event: { text: $('eventText').value.trim() } }); }
$('eventBtn').addEventListener('click', applyEvent);
$('eventText').addEventListener('keydown', e => { if (e.key === 'Enter') { applyEvent(); e.target.blur(); } });
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
const ROLE_SECTIONS_OFF = [['COMMENTATOR', '評論員'], ['REFEREE', '裁判']];
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
  if (st.board && st.board.tier === 'full') {
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
    head.textContent = label;
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
      } else {
        row.append(
          rosterInputEl(group, e, 'r-title', '職稱', 'title', 14),
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
        autoEndMode: !!st.timer.autoEndMode,
        endAlternate: !!st.timer.endAlternate,
      },
      cornerLogos: st.cornerLogos || [],
      orgBanners: st.orgBanners || {},
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

/* preview iframe scaling */
const frame = document.querySelector('.preview-frame');
const iframe = $('preview');
function fitPreview() {
  if (!frame || !iframe) return;
  iframe.style.transform = `scale(${frame.clientWidth / 1920})`;
}
new ResizeObserver(fitPreview).observe(frame);
fitPreview();

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
  const qc = $('qClock');
  const qTxt = word || fmtClockShort(display, dir);
  if (qc.textContent !== qTxt) qc.textContent = qTxt;
  qc.classList.toggle('word', !!word);
  qc.classList.toggle('urgent', !word && rem <= 60000);
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
    assetsList = msg.assets || { banner: [], corner: [] };
    refresh(msg.state);
    renderMatches();
  },
  onStatus(ok) { $('conn').classList.toggle('on', ok); },
});
