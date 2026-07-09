/*
 * overlay.js — Scoreboard-X livestream overlay.
 *
 * Two independent boards driven by one server state:
 *   · #board (main view)  — small / large tiers, top-left
 *   · #fullboard (full view) — full-frame tier, bottom-center
 *
 * Tier transitions:
 *   · small <-> large : in-place choreography (names FLIP-move, scores
 *     fade out / fade in at their new spot, facet backgrounds & theme
 *     bars cross-fade, panel FLIP-resizes)
 *   · any <-> full    : the outgoing board plays its hide animation while
 *     the full board plays its show animation at the same time (no morph)
 *
 * Event icons hang off the right edge of the main board, F1-style: 5s as an
 * icon+label pill, then collapse to a square icon until manually removed from
 * the admin panel (no auto-hide). The 2-min suspension icon shows a live
 * countdown (playing time) instead of a label, then collapses when it ends.
 *
 * The info banner (#infobar) is a top-centre F1-style strip: the verdict chip
 * pops in alone, then the body slides out from behind it. Manual show / hide.
 */
import { buildPalette, facetSVG, hexToRgba, relLuminance } from '/shared/palette.js';
import { connect, serverNow } from '/shared/net.js';

/* ================================================================ dom */

const STAGE_W = 1920, STAGE_H = 1080;
const stage = document.getElementById('stage');
const boardEl = document.getElementById('board');
const fullEl = document.getElementById('fullboard');
const canvas = document.getElementById('fx');
const ctx = canvas.getContext('2d');

function el(tag, cls, txt) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
}

/* ============================================================== stage */

let stageScale = 1;
function fitStage() {
  stageScale = Math.min(innerWidth / STAGE_W, innerHeight / STAGE_H) || 1;
  stage.style.transform = `scale(${stageScale})`;
  stage.style.left = `${Math.max(0, (innerWidth - STAGE_W * stageScale) / 2)}px`;
}
addEventListener('resize', fitStage);
fitStage();

const params = new URLSearchParams(location.search);
if (params.get('bg')) document.body.classList.add('bg-' + params.get('bg'));

/* ============================================================ easings */

const canLinear = CSS.supports('animation-timing-function', 'linear(0, 1)');

function springEase(omega, zeta, durMs) {
  if (!canLinear) return { easing: 'cubic-bezier(0.34, 1.4, 0.42, 1)', dur: durMs };
  const n = 40, pts = [];
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * (durMs / 1000);
    let x = 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + (zeta * omega / wd) * Math.sin(wd * t));
    if (i === n) x = 1;
    pts.push(`${Math.round(x * 10000) / 10000} ${Math.round((i / n) * 1000) / 10}%`);
  }
  return { easing: `linear(${pts.join(', ')})`, dur: durMs };
}

const GLIDE = springEase(11, 0.88, 700);   // layout morphs — quick launch, velvet settle
const POP   = springEase(16, 0.52, 640);   // score punch — lively overshoot
const ROLL  = springEase(14, 0.68, 540);   // odometer digits
const OUT_5   = 'cubic-bezier(0.16, 1, 0.3, 1)';
const IN_SOFT = 'cubic-bezier(0.3, 0.9, 0.45, 1)';
const EXIT    = 'cubic-bezier(0.5, 0, 0.55, 1)';

/* ============================================== channelled animations */

const chanMap = new WeakMap();
function cancelRun(node, channel) {
  const m = chanMap.get(node);
  const a = m && m.get(channel);
  if (a) { try { a.cancel(); } catch {} m.delete(channel); }
}
function run(node, channel, frames, opts = {}) {
  cancelRun(node, channel);
  const a = node.animate(frames, { fill: 'none', ...opts });
  let m = chanMap.get(node);
  if (!m) chanMap.set(node, m = new Map());
  m.set(channel, a);
  return a;
}
const done = a => a.finished.catch(() => {});
const later = ms => new Promise(r => setTimeout(r, ms));

const tokens = {};
const bump = k => (tokens[k] = (tokens[k] || 0) + 1);
const alive = (k, t) => tokens[k] === t;

/* ================================================================ fx */

const particles = [];
let lastFrame = performance.now();
let canvasDirty = false;
function stepParticles(now) {
  const dt = Math.min(0.033, (now - lastFrame) / 1000);
  lastFrame = now;
  if (!particles.length) {
    if (canvasDirty) { ctx.clearRect(0, 0, STAGE_W, STAGE_H); canvasDirty = false; }
    return;
  }
  canvasDirty = true;
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.vy += 2100 * dt;
    p.vx *= (1 - 1.6 * dt);
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    const a = Math.min(1, p.life / (p.max * 0.35));
    ctx.save();
    ctx.globalAlpha = a * p.alpha;
    if (p.glowy) ctx.globalCompositeOperation = 'lighter';
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    if (p.glowy) {
      ctx.beginPath(); ctx.arc(0, 0, p.w, 0, 7); ctx.fill();
    } else {
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    }
    ctx.restore();
  }
}

function stageRectOf(node) {
  const r = node.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return {
    x: (r.left - s.left) / stageScale, y: (r.top - s.top) / stageScale,
    w: r.width / stageScale, h: r.height / stageScale,
  };
}

function burstFrom(node, pal, big) {
  const r = stageRectOf(node);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const colors = [pal.base, pal.bright, pal.glow, '#FFFFFF', pal.shift];
  const shards = big ? 120 : 62;
  for (let i = 0; i < shards; i++) {
    const ang = (-90 + (Math.random() * 130 - 65)) * Math.PI / 180;
    const sp = (big ? 780 : 560) + Math.random() * (big ? 900 : 620);
    particles.push({
      x: cx + (Math.random() - 0.5) * r.w * 0.5,
      y: cy + (Math.random() - 0.5) * r.h * 0.3,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      w: 5 + Math.random() * 9, h: 3 + Math.random() * 4,
      rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 16,
      life: 0, max: 0, alpha: 0.95,
      color: colors[i % colors.length],
    });
    const p = particles[particles.length - 1];
    p.max = p.life = 0.9 + Math.random() * (big ? 0.9 : 0.6);
  }
  for (let i = 0; i < (big ? 22 : 12); i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 120 + Math.random() * 380;
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 240,
      w: 3 + Math.random() * 6, h: 0,
      rot: 0, vr: 0, glowy: true,
      life: 0.55 + Math.random() * 0.4, max: 0.8, alpha: 0.8,
      color: pal.glow,
    });
  }
}

function glowFlash(v, color) {
  run(v.glow, 'flash', [
    { boxShadow: `0 0 70px ${hexToRgba(color, 0)}`, opacity: 1 },
    { boxShadow: `0 0 88px ${hexToRgba(color, 0.4)}`, opacity: 1, offset: 0.2 },
    { boxShadow: `0 0 70px ${hexToRgba(color, 0)}`, opacity: 1 },
  ], { duration: 1100, easing: 'ease-out' });
}

/* ======================================================= digit tapes */

function measureDigits() {
  const probe = el('span', '', '0');
  Object.assign(probe.style, {
    position: 'absolute', visibility: 'hidden',
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-sport'),
    fontWeight: 700, fontSize: '100px',
  });
  document.body.append(probe);
  let max = 0;
  for (let d = 0; d <= 9; d++) { probe.textContent = String(d); max = Math.max(max, probe.getBoundingClientRect().width); }
  probe.remove();
  if (max > 0) document.documentElement.style.setProperty('--digit-r', (max / 100 - 0.01).toFixed(4));
}
measureDigits();
document.fonts.ready.then(measureDigits);

class Tape {
  constructor(host) {
    this.host = host;
    host.classList.add('tape-host');
    this.group = el('div', 'tape-group');
    host.append(this.group);
    this.text = '';
  }
  build(text) {
    this.group.innerHTML = '';
    for (const ch of text) {
      const slot = el('span', 'tape-slot' + (/[0-9]/.test(ch) ? '' : ' punct'));
      slot.append(el('span', 'tape-cell', ch));
      this.group.append(slot);
    }
  }
  set(text, { dir = 1, anim = true, pop = false, staticLast = 0 } = {}) {
    if (text === this.text) return;
    const old = this.text;
    this.text = text;
    if (!anim || !old) { this.build(text); return; }
    if (old.length !== text.length) { this.swapWhole(text, dir); return; }
    const slots = [...this.group.children];
    for (let i = 0; i < text.length; i++) {
      if (old[i] === text[i]) continue;
      if (i >= text.length - staticLast) {
        const c = slots[i].querySelector('.tape-cell');
        if (c) c.textContent = text[i];
        continue;
      }
      this.rollSlot(slots[i], text[i], dir, pop);
    }
  }
  rollSlot(slot, ch, dir, pop) {
    const cells = [...slot.children];
    cells.forEach(c => { cancelRun(c, 'roll'); });
    cells.slice(0, -1).forEach(c => c.remove());
    const cur = slot.lastElementChild;
    const next = el('span', 'tape-cell', ch);
    slot.append(next);
    const timing = pop
      ? { duration: ROLL.dur, easing: ROLL.easing }
      : { duration: 240, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' };
    if (cur) {
      run(cur, 'roll', [
        { transform: 'translateY(0%)', opacity: 1 },
        { transform: `translateY(${-106 * dir}%)`, opacity: 0.2 },
      ], { ...timing, fill: 'forwards' }).finished.then(() => cur.remove()).catch(() => {});
    }
    run(next, 'roll', [
      { transform: `translateY(${106 * dir}%)`, opacity: 0.2 },
      { transform: 'translateY(0%)', opacity: 1 },
    ], timing);
  }
  swapWhole(text, dir) {
    const oldG = this.group;
    oldG.classList.add('tape-old');
    run(oldG, 'tswap', [
      { transform: 'translate(-50%, 0%)', opacity: 1 },
      { transform: `translate(-50%, ${-48 * dir}%)`, opacity: 0 },
    ], { duration: 230, easing: EXIT, fill: 'forwards' }).finished.then(() => oldG.remove()).catch(() => {});
    this.group = el('div', 'tape-group');
    this.host.append(this.group);
    this.build(text);
    run(this.group, 'tswap', [
      { transform: `translateY(${42 * dir}%)`, opacity: 0 },
      { transform: 'translateY(0%)', opacity: 1 },
    ], { duration: 360, delay: 60, easing: OUT_5, fill: 'backwards' });
  }
}

/* ============================================================== views */

function makeView(root, kind) {
  const q = s => root.querySelector(s);
  const v = {
    kind, root,
    bg: q('.board-bg'),
    grid: q('.board-grid'),
    glow: q('.board-glow'),
    cellEvent: q('.cell-event'),
    eventBox: q('.event-text'),
    boxPeriod: q('.box-period'),
    periodBox: q('.period-text'),
    boxClock: q('.box-clock'),
    clockTapesEl: q('.clock-tapes'),
    clockWordEl: q('.clock-word'),
    teams: {
      A: {
        root: q('.team-a'), bg: q('[data-team-bg="A"]'), bar: q('.team-a .team-bar'), flash: q('.team-a .team-flash'),
        name: q('.team-a .team-name'), nameBox: q('.team-a .name-swap'),
        score: q('.team-a .team-score'), tapeHost: q('.team-a .score-tape'),
      },
      B: {
        root: q('.team-b'), bg: q('[data-team-bg="B"]'), bar: q('.team-b .team-bar'), flash: q('.team-b .team-flash'),
        name: q('.team-b .team-name'), nameBox: q('.team-b .name-swap'),
        score: q('.team-b .team-score'), tapeHost: q('.team-b .score-tape'),
      },
    },
    goalWordActive: { A: false, B: false },
    shownWord: null,
    lastClockStr: '',
    visible: false,
  };
  v.clockTape = new Tape(v.clockTapesEl);
  v.scoreTapes = { A: new Tape(v.teams.A.tapeHost), B: new Tape(v.teams.B.tapeHost) };
  return v;
}

const mainV = makeView(boardEl, 'main');
const fullV = makeView(fullEl, 'full');
const views = [mainV, fullV];
const rails = {
  A: boardEl.querySelector('.icon-rail.rail-a'),
  B: boardEl.querySelector('.icon-rail.rail-b'),
};

/* ======================================================== word swaps */

function buildWord(text, o = {}) {
  const w = el('span', 'swap-cur' + (o.goal ? ' goal-word' : ''));
  w.dataset.txt = text;
  const lines = text.split('\n');
  if (lines.length > 1) {
    w.style.flexDirection = 'column';
    w.style.whiteSpace = 'nowrap';
    for (const line of lines) {
      const row = el('span', 'word-row');
      for (const ch of line) row.append(el('span', 'lt', ch === ' ' ? ' ' : ch));
      w.append(row);
    }
  } else {
    for (const ch of text) w.append(el('span', 'lt', ch === ' ' ? ' ' : ch));
  }
  if (o.glow) w.style.textShadow = `0 0 20px ${o.glow}`;
  return w;
}

/* per-letter cascade swap (team names, GOAL!, BREAK / PAUSE) */
const boxTokens = new WeakMap();
function letterSwap(box, text, o = {}) {
  const tok = (boxTokens.get(box) || 0) + 1;
  boxTokens.set(box, tok);
  const cur = box.querySelector('.swap-cur');
  if (cur && cur.dataset.txt === text && !o.force) return;
  if (o.instant) {
    box.innerHTML = '';
    box.append(buildWord(text, o));
    return;
  }
  let outRect = null;
  if (cur) {
    outRect = cur.getBoundingClientRect();   // freeze its screen spot before the box resizes
    cur.classList.replace('swap-cur', 'swap-out');
    const outLts = [...cur.querySelectorAll('.lt')];
    outLts.forEach((lt, i) =>
      run(lt, 'ls', [
        { transform: 'none', opacity: 1 },
        { transform: 'translateY(-64%) rotateX(58deg)', opacity: 0 },
      ], { duration: 200, delay: i * 15, easing: EXIT, fill: 'forwards' }));
    later(220 + outLts.length * 15).then(() => { if (cur.parentNode) cur.remove(); });
    // clean any older leftovers
    box.querySelectorAll('.swap-out').forEach(n => { if (n !== cur) n.remove(); });
  }
  const word = buildWord(text, o);
  box.append(word);
  // Pin the outgoing word to its exact pre-swap position instead of letting the CSS
  // rule re-centre it (left:50%). The name box is fit-content and re-centres/resizes when
  // the incoming word (e.g. GOAL!) has a different width — that re-centring is what shifted
  // the team name sideways. Freezing keeps small (left-aligned) and large (centred) names
  // from jumping regardless of the box's alignment or width change.
  if (cur && outRect) {
    const boxRect = box.getBoundingClientRect();
    const sf = box.offsetWidth ? boxRect.width / box.offsetWidth : 1;   // total render scale
    cur.style.left = ((outRect.left - boxRect.left) / (sf || 1)) + 'px';
    cur.style.right = 'auto';
    cur.style.transform = 'none';
  }
  const lts = [...word.querySelectorAll('.lt')];
  lts.forEach((lt, i) => {
    const fromT = o.goal
      ? 'translateY(90%) scale(1.7) rotate(7deg)'
      : 'translateY(72%) rotateX(-52deg)';
    run(lt, 'ls', [
      { transform: fromT, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], {
      duration: o.goal ? POP.dur : 380,
      delay: 90 + i * (o.goal ? 40 : 22),
      easing: o.goal ? POP.easing : OUT_5,
      fill: 'backwards',
    });
  });
}

/* whole-word slide swap (event name, period) */
function swapWord(box, text, o = {}) {
  const cur = box.querySelector('.swap-cur');
  if (cur && cur.dataset.txt === text) return;
  if (o.instant) { box.innerHTML = ''; const s = el('span', 'swap-cur', text); s.dataset.txt = text; box.append(s); return; }
  if (cur) {
    cur.classList.replace('swap-cur', 'swap-out');
    run(cur, 'sw', [
      { transform: 'translateX(-50%) translateY(0%) rotateX(0deg)', opacity: 1 },
      { transform: 'translateX(-50%) translateY(-60%) rotateX(48deg)', opacity: 0 },
    ], { duration: 230, easing: EXIT, fill: 'forwards' }).finished.then(() => cur.remove()).catch(() => {});
  }
  const s = el('span', 'swap-cur', text);
  s.dataset.txt = text;
  box.append(s);
  run(s, 'sw', [
    { transform: 'translateY(65%) rotateX(-46deg)', opacity: 0 },
    { transform: 'translateY(0%) rotateX(0deg)', opacity: 1 },
  ], { duration: 380, delay: 90, easing: OUT_5, fill: 'backwards' });
}

/* ================================================== fit text to width */

function fitName(v, t) {
  const cur = v.teams[t].nameBox.querySelector('.swap-cur');
  if (!cur) return;
  cur.style.fontSize = '';
  if (v === mainV && rowModeFor(t) === 'small') return;   // small row grows instead
  const nameEl = v.teams[t].name;
  const cs = getComputedStyle(nameEl);
  const avail = nameEl.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const w = cur.offsetWidth;
  if (w > avail && avail > 0) {
    const base = parseFloat(cs.fontSize);
    cur.style.fontSize = Math.max(12, Math.floor(base * (avail / w) * 0.97)) + 'px';
  }
}

function fitEvent(v) {
  const cur = v.eventBox.querySelector('.swap-cur');
  if (!cur) return;
  cur.style.fontSize = '';
  if (v === mainV && !anyRowLarge()) return;          // uncapped small board grows instead
  const avail = v.cellEvent.clientWidth - 40;        // .event-text side padding
  const w = cur.offsetWidth;
  if (w > avail && avail > 0) {
    cur.style.fontSize = Math.max(12, Math.floor(24 * (avail / w) * 0.97)) + 'px';
  }
}

/* ========================================================== palettes */

const palettes = {
  A: buildPalette('#D6152C'),
  B: buildPalette('#F6C500'),
};

function applyPalette(team, hex, { instant = false } = {}) {
  const pal = buildPalette(hex);
  palettes[team] = pal;
  const p = team.toLowerCase();
  const root = document.documentElement;
  root.style.setProperty(`--${p}-base`, pal.base);
  root.style.setProperty(`--${p}-deep`, pal.deep);
  root.style.setProperty(`--${p}-bright`, pal.bright);
  root.style.setProperty(`--${p}-glow`, pal.glow);
  root.style.setProperty(`--${p}-ink`, pal.ink);

  for (const v of views) {
    const host = v.teams[team].bg;
    const layer = el('div', 'facet-layer');
    layer.innerHTML = facetSVG(pal, { mirror: team === 'B' });
    const olds = [...host.children];
    host.append(layer);
    if (instant || !v.visible) {
      olds.forEach(n => n.remove());
    } else {
      run(layer, 'tint', [{ opacity: 0 }, { opacity: 1 }], { duration: 550, easing: 'ease-out' });
      olds.forEach(n => {
        run(n, 'tint', [{ opacity: 1 }, { opacity: 0 }], { duration: 550, easing: 'ease-out', fill: 'forwards' })
          .finished.then(() => n.remove()).catch(() => n.remove());
      });
    }
  }
}

/* ============================================================ layout */

let st = null;               // latest server state
let firstPaint = true;
let tierShown = 'off';       // what is currently on screen
let mainMode = 'large';      // BASE row mode from the tier: small | large
const rowExpand = { A: false, B: false };   // transient per-row goal expansion (partial / full)
const rowExpandTimer = { A: 0, B: 0 };

/* a team row is large if the board base is large, or this row is goal-expanded */
function rowModeFor(t) { return (mainMode === 'large' || rowExpand[t]) ? 'large' : 'small'; }
function anyRowLarge() { return rowExpand.A || rowExpand.B || mainMode === 'large'; }

function boardScaleVar() {
  return (st && st.board.scale) || 1;
}
/* per-tier name mode: board.nameMode = { small, large, full } (short | full).
 * the main board follows its live layout (small vs large); full board its own. */
function nameModeFor(v, team) {
  const nm = st && st.board.nameMode;
  if (typeof nm === 'string') return nm === 'full' ? 'full' : 'short';   // legacy safety
  const key = v === fullV ? 'full' : rowModeFor(team);   // per-row: an expanded row can show its 'large' name
  return (nm && nm[key]) === 'full' ? 'full' : 'short';
}
const nameFor = (v, team) => {
  const full = nameModeFor(v, team) === 'full';
  return ((full ? st.teams[team].name : st.teams[team].short) || '').toUpperCase();
};

function setName(v, t, { instant = false } = {}) {
  letterSwap(v.teams[t].nameBox, nameFor(v, t), { instant });
  fitName(v, t);
}

/* ------------------------------------------- main-board width choreography */
/* The main board is fit-content, so a name-mode toggle changes its width.
 * We measure the final width up front and glide it smoothly:
 *   short -> full : stretch the board first, swap names at the halfway point
 *   full -> short : swap names first, shrink the board at the halfway point
 * so the width change never yanks the (centred) team name mid-swap. */
const NAME_WIDTH_DUR = GLIDE.dur;   // width glide — matches layout morphs
const NAME_SWAP_HALF = 330;         // ~halfway through the letter cascade
let nameMorphTok = 0;

/* fit-content width the main board WOULD have with the given A/B name texts,
 * measured synchronously (no visible flash) then fully restored. */
function boardWidthWith(texts) {
  const savedWidth = boardEl.style.width;
  const saved = {}, built = {};
  for (const t of ['A', 'B']) {
    const box = mainV.teams[t].nameBox;
    saved[t] = box.innerHTML;
    box.innerHTML = '';
    built[t] = buildWord(texts[t]);
    box.append(built[t]);
  }
  boardEl.style.width = '';                 // release any pin -> real fit-content
  const font = {};
  for (const t of ['A', 'B']) { fitName(mainV, t); font[t] = built[t].style.fontSize || ''; }
  const width = boardEl.offsetWidth;
  for (const t of ['A', 'B']) mainV.teams[t].nameBox.innerHTML = saved[t];
  boardEl.style.width = savedWidth;
  return { width, font };   // font = the fitted size at the FINAL width, applied at swap time
}

function swapMainNamesMorph() {
  const v = mainV;
  const affected = ['A', 'B'].filter(t => !v.goalWordActive[t]);
  if (!affected.length) return;
  if (!v.visible) { affected.forEach(t => setName(v, t, { instant: true })); return; }

  const curTxt = t => { const c = v.teams[t].nameBox.querySelector('.swap-cur'); return c ? c.dataset.txt : ''; };
  const wantTxt = t => (v.goalWordActive[t] ? curTxt(t) : nameFor(v, t));
  const willChange = affected.filter(t => curTxt(t) !== nameFor(v, t));
  if (!willChange.length) return;

  const tok = ++nameMorphTok;
  const lockW = boardEl.offsetWidth;               // current width (mid-glide ok)
  cancelRun(boardEl, 'namew');
  boardEl.style.width = lockW + 'px';              // pin so measuring can't jump
  const { width: targetW, font: targetFont } = boardWidthWith({ A: wantTxt('A'), B: wantTxt('B') });
  // swap a name AND pin it to the final fitted font-size, so a mid-glide fitName can't
  // shrink it to the (narrower) intermediate width and then snap the layout at the end.
  const swapTo = t => {
    setName(v, t);
    const c = v.teams[t].nameBox.querySelector('.swap-cur');
    if (c) c.style.fontSize = targetFont[t];
  };

  if (Math.abs(targetW - lockW) < 1.5) {           // width unaffected -> plain swap
    boardEl.style.width = '';
    willChange.forEach(swapTo);
    return;
  }

  const glideWidth = () => run(boardEl, 'namew', [
    { width: lockW + 'px' }, { width: targetW + 'px' },
  ], { duration: NAME_WIDTH_DUR, easing: GLIDE.easing, fill: 'forwards' })
    .finished.then(() => { if (nameMorphTok === tok) { boardEl.style.width = ''; cancelRun(boardEl, 'namew'); } })
    .catch(() => {});

  if (targetW > lockW) {                            // short -> full : stretch, then swap
    glideWidth();
    setTimeout(() => { if (nameMorphTok === tok) willChange.forEach(swapTo); }, NAME_WIDTH_DUR * 0.5);
  } else {                                          // full -> short : swap, then shrink
    willChange.forEach(swapTo);
    setTimeout(() => { if (nameMorphTok === tok) glideWidth(); }, NAME_SWAP_HALF);
  }
}

/* underlying (non-blinking) condition for the BREAK / PAUSE / END words —
 * used for the auto full-frame rule so alternate-blink doesn't flap tiers */
function wordConditionActive(s) {
  const t = s.timer;
  if (t.mode === 'break' || t.mode === 'pause' || t.mode === 'matchEnd') return true;
  if (t.autoPauseWord && !t.running) {
    const r = timerRemaining(t);
    if (r > 0 && r < t.durationMs) return true;
  }
  return false;
}

function effTier() {
  if (!st) return 'off';
  const t = st.board.tier;
  if (t === 'off') return 'off';
  if (st.board.autoExpandBreak && wordConditionActive(st)) return 'full';
  return t;   // small | large | full (goal expansion is per-row, not a tier change)
}

/* ---- per-row modes (item 4: a goal can expand only the scoring team's row) -------- */
function currentRowMode(t) {
  return mainV.teams[t].root.classList.contains('row-small') ? 'small' : 'large';
}
function setRowClass(t, mode) {
  const teamEl = mainV.teams[t].root;
  teamEl.classList.toggle('row-large', mode === 'large');
  teamEl.classList.toggle('row-small', mode === 'small');
}
function clearRowExpands() {
  for (const t of ['A', 'B']) { rowExpand[t] = false; clearTimeout(rowExpandTimer[t]); }
}
/* reconcile every per-row class + grid track + the width cap to the current state (instant) */
function applyRowModes() {
  boardEl.classList.toggle('cap-width', anyRowLarge());
  for (const t of ['A', 'B']) {
    const mode = rowModeFor(t);
    setRowClass(t, mode);
    boardEl.style.setProperty(t === 'A' ? '--row-a' : '--row-b', mode === 'large' ? '150px' : '56px');
    fitName(mainV, t);
  }
  fitEvent(mainV);
}
/* set the board BASE row mode (from the tier) and reconcile instantly */
function setMainMode(m) {
  mainMode = m;
  applyRowModes();
}

/* ================================== per-row small <-> large morph ==================================
 * Choreography confirmed with Jason (both directions 650ms):
 *   · panel height  : REAL height growth — glide the --row-a / --row-b grid tracks (no scale distortion)
 *   · team name     : continuous glide + scale (FLIP against the final layout); expand overshoots,
 *                     collapse settles cleanly
 *   · score         : fast bounce handoff — the old score leaves at once, the new score bounces in
 *                     near the end at its new spot (a brief no-score gap is intended)
 *   · theme visuals : color bar slides out to the right + facet wipes in from the name (left) side
 *                     on expand; mirror on collapse
 * Board width snaps to its new fit-content (a real width glide would fight the real-height + name
 * FLIP and double-move the name). Expand = lively spring; collapse = clean decel. */
const MORPH_DUR = 650;
const MORPH_EXPAND = springEase(12, 0.82, MORPH_DUR);      // spring, mild overshoot
const MORPH_COLLAPSE = { easing: OUT_5, dur: MORPH_DUR };  // clean decel, no overshoot
const SCORE_OUT_DUR = 190;
const SCORE_OUT_COLLAPSE = 120;   // large->small: the big score should clear a bit quicker
const SCORE_IN_DELAY = Math.round(MORPH_DUR * 0.6);        // new score arrives near the end
const SCORE_POP = springEase(18, 0.5, 320);               // snappy score bounce-in
const easeOf = e => (typeof e === 'string' ? e : e.easing);

/* on-screen height (board-px) of a given team row right now — interrupt-safe */
function teamRowPx(t) {
  const k = stageScale * boardScaleVar();
  return mainV.teams[t].root.getBoundingClientRect().height / k || 56;
}

/* freeze the current score as a ghost at its spot, shrink+fade it out, hide the real one */
function scoreGhostOut(v, t, dur = SCORE_OUT_DUR) {
  const scoreEl = v.teams[t].score;
  const r = stageRectOf(scoreEl);
  cancelRun(scoreEl, 'sxf'); cancelRun(scoreEl, 'sbounce');
  scoreEl.style.transform = '';
  if (!r.w || !r.h) { scoreEl.style.opacity = '0'; return; }
  const cs = getComputedStyle(scoreEl);
  const ghost = scoreEl.cloneNode(true);
  ghost.classList.add('score-ghost');
  Object.assign(ghost.style, {
    position: 'absolute', left: r.x + 'px', top: r.y + 'px',
    width: r.w + 'px', height: r.h + 'px', margin: '0', padding: cs.padding,
    fontSize: (parseFloat(cs.fontSize) * boardScaleVar()) + 'px', color: cs.color,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none', flex: 'none', transformOrigin: '50% 50%',
  });
  stage.append(ghost);
  run(ghost, 'g', [
    { opacity: 1, transform: 'scale(1)' },
    { opacity: 0, transform: 'scale(0.6)' },
  ], { duration: dur, easing: EXIT, fill: 'forwards' })
    .finished.then(() => ghost.remove()).catch(() => ghost.remove());
  scoreEl.style.opacity = '0';
}

/* bounce the real score in where it now lands (held hidden until SCORE_IN_DELAY) */
function scoreBounceIn(v, t) {
  const scoreEl = v.teams[t].score;
  scoreEl.style.opacity = '';
  run(scoreEl, 'sxf', [{ opacity: 0 }, { opacity: 1 }],
    { duration: 180, delay: SCORE_IN_DELAY, easing: 'ease-out', fill: 'backwards' });
  run(scoreEl, 'sbounce', [
    { transform: 'scale(0.5)' }, { transform: 'scale(1)' },
  ], { duration: SCORE_POP.dur, delay: SCORE_IN_DELAY, easing: SCORE_POP.easing, fill: 'backwards' })
    .finished.then(() => { cancelRun(scoreEl, 'sbounce'); scoreEl.style.transform = ''; }).catch(() => {});
}

/* team-name FLIP that BLENDS with the width glide (item 2): the after-rect is measured
 * at the START board width, so the transform (delta -> 0) and the real width reflow —
 * driven by the same easing — sum to a smooth slide instead of double-moving the name. */
function nameBlend(v, t, before, atWb, ease) {
  const box = v.teams[t].nameBox;
  const a = atWb || box.getBoundingClientRect();
  if (!before || !before.width || !before.height || !a || !a.width || !a.height) return;
  const k = stageScale * boardScaleVar();
  const dx = (before.left - a.left) / k, dy = (before.top - a.top) / k;
  const sx = before.width / a.width, sy = before.height / a.height;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
  box.style.transformOrigin = '0 0';
  run(box, 'flip', [
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
    { transform: 'none' },
  ], { duration: MORPH_DUR, easing: easeOf(ease), fill: 'none' })
    .finished.then(() => { box.style.transformOrigin = ''; box.style.transform = ''; }).catch(() => {});
}

/* one row's theme visuals — bar slides out right + facet wipes in from left (expand);
 * mirror (collapse). clip-path keyframes carry opacity:1 so the resting
 * .team.row-small { opacity:0 } on .team-bg can't hide the facet mid-wipe (WAAPI outranks
 * the static rule; cleared on finish). */
function themeMorphRow(v, t, expand) {
  const bg = v.teams[t].bg, bar = v.teams[t].bar;
  cancelRun(bg, 'theme'); if (bar) cancelRun(bar, 'theme');
  if (expand) {
    run(bg, 'theme', [
      { clipPath: 'inset(0 100% 0 0)', opacity: 1 },
      { clipPath: 'inset(0 0 0 0)', opacity: 1 },
    ], { duration: MORPH_DUR, easing: OUT_5, fill: 'both' })
      .finished.then(() => { cancelRun(bg, 'theme'); bg.style.clipPath = ''; bg.style.opacity = ''; }).catch(() => {});
    if (bar) run(bar, 'theme', [
      { transform: 'translateX(0)', opacity: 1 },
      { transform: 'translateX(18px)', opacity: 0 },
    ], { duration: Math.round(MORPH_DUR * 0.55), easing: EXIT, fill: 'both' })
      .finished.then(() => { cancelRun(bar, 'theme'); bar.style.transform = ''; bar.style.opacity = ''; }).catch(() => {});
  } else {
    run(bg, 'theme', [
      { clipPath: 'inset(0 0 0 0)', opacity: 1 },
      { clipPath: 'inset(0 100% 0 0)', opacity: 1 },
    ], { duration: Math.round(MORPH_DUR * 0.72), easing: EXIT, fill: 'both' })
      .finished.then(() => { cancelRun(bg, 'theme'); bg.style.clipPath = ''; bg.style.opacity = ''; }).catch(() => {});
    if (bar) run(bar, 'theme', [
      { transform: 'translateX(18px)', opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 },
    ], { duration: MORPH_DUR, delay: Math.round(MORPH_DUR * 0.2), easing: OUT_5, fill: 'both' })
      .finished.then(() => { cancelRun(bar, 'theme'); bar.style.transform = ''; bar.style.opacity = ''; }).catch(() => {});
  }
}

/* Morph the rows whose desired mode (rowModeFor) differs from what's on screen, with a
 * coordinated board width glide (item 2) + per-row height / name / score / theme.
 * The caller sets mainMode / rowExpand first. Handles whole-board tier changes (both rows)
 * AND partial goal expansion (only the scoring row). */
function morphBoard() {
  const v = mainV;
  const tok = bump('morph');
  const want = t => rowModeFor(t);
  const changed = ['A', 'B'].filter(t => currentRowMode(t) !== want(t));
  boardEl.classList.toggle('cap-width', anyRowLarge());
  if (!changed.length) return;
  const expand = want(changed[0]) === 'large';
  const ease = expand ? MORPH_EXPAND : MORPH_COLLAPSE;

  /* BEFORE geometry (names + current row heights + board width) */
  const nameBefore = {}, rowBefore = {};
  for (const t of changed) { nameBefore[t] = v.teams[t].nameBox.getBoundingClientRect(); rowBefore[t] = teamRowPx(t); }
  const widthBefore = boardEl.offsetWidth;

  /* the changed rows' old scores leave at once (ghosts captured at their current spot);
     large->small clears the big score a bit quicker */
  for (const t of changed) scoreGhostOut(v, t, expand ? SCORE_OUT_DUR : SCORE_OUT_COLLAPSE);

  /* switch the changed rows to their target styling (grid tracks pinned to BEFORE below) */
  for (const t of changed) { cancelRun(v.teams[t].nameBox, 'flip'); cancelRun(v.grid, 'row-' + t); v.teams[t].nameBox.style.minWidth = ''; }
  cancelRun(boardEl, 'morphw'); cancelRun(boardEl, 'namew');
  for (const t of changed) setRowClass(t, want(t));
  /* per-row name text can change with the mode (per-tier nameMode) -> ride letterSwap not FLIP */
  const nameSwap = {};
  for (const t of changed) {
    const cur = v.teams[t].nameBox.querySelector('.swap-cur');
    nameSwap[t] = !v.goalWordActive[t] && (!cur || cur.dataset.txt !== nameFor(v, t));
  }

  /* measure the target board width (cap-width active -> large names shrink-fit) + final fonts */
  boardEl.style.maxWidth = '';
  boardEl.style.width = '';
  for (const t of changed) { if (nameSwap[t]) setName(v, t); else fitName(v, t); }
  const widthAfter = boardEl.offsetWidth;

  /* measure each gliding name at the START width (final font already applied) for nameBlend */
  boardEl.style.maxWidth = 'none';
  boardEl.style.width = widthBefore + 'px';
  const nameAtWb = {};
  for (const t of changed) if (!v.goalWordActive[t] && !nameSwap[t]) nameAtWb[t] = v.teams[t].nameBox.getBoundingClientRect();

  /* ---- animate ---- */
  /* board width glide (real reflow; maxWidth off so the pin isn't clamped) */
  if (Math.abs(widthAfter - widthBefore) > 1.5) {
    run(boardEl, 'morphw', [{ width: widthBefore + 'px' }, { width: widthAfter + 'px' }],
      { duration: MORPH_DUR, easing: easeOf(ease), fill: 'forwards' })
      // release the pin to fit-content BEFORE cancelling, so width never reverts to the
      // start value for a frame (and #board's CSS width transition can't re-fire)
      .finished.then(() => { if (alive('morph', tok)) { boardEl.style.width = ''; boardEl.style.maxWidth = ''; cancelRun(boardEl, 'morphw'); } }).catch(() => {});
  } else {
    boardEl.style.width = ''; boardEl.style.maxWidth = '';
  }
  /* per row: REAL height growth + name blend + theme + score bounce */
  for (const t of changed) {
    const varName = t === 'A' ? '--row-a' : '--row-b';
    const rowAfter = want(t) === 'large' ? 150 : 56;
    boardEl.style.setProperty(varName, rowBefore[t] + 'px');
    run(v.grid, 'row-' + t, [{ [varName]: rowBefore[t] + 'px' }, { [varName]: rowAfter + 'px' }],
      { duration: MORPH_DUR, easing: easeOf(ease), fill: 'forwards' })
      // set the resting track on #board BEFORE cancelling so the grid never reverts to rowBefore
      .finished.then(() => { if (alive('morph', tok)) { boardEl.style.setProperty(varName, rowAfter + 'px'); v.grid.style.removeProperty(varName); cancelRun(v.grid, 'row-' + t); } }).catch(() => {});
    if (!v.goalWordActive[t] && !nameSwap[t]) nameBlend(v, t, nameBefore[t], nameAtWb[t], ease);
    themeMorphRow(v, t, want(t) === 'large');
    scoreBounceIn(v, t);
  }
}

/* ------------------------------------------------------- tier machine */

function applyTierInstant(want) {
  const mainOn = want === 'small' || want === 'large';
  if (mainOn) setMainMode(want);
  if (mainOn && !mainV.visible && st) renderAllView(mainV, st);
  if (want === 'full' && !fullV.visible && st) renderAllView(fullV, st);
  mainV.visible = mainOn;
  fullV.visible = want === 'full';
  boardEl.classList.toggle('is-hidden', !mainV.visible);
  fullEl.classList.toggle('is-hidden', !fullV.visible);
}

function applyTier({ instant = false } = {}) {
  if (!st) return;
  const want = effTier();
  if (want === tierShown) return;
  const from = tierShown;
  tierShown = want;
  clearRowExpands();          // a real tier change cancels any transient goal expansion

  if (instant || firstPaint) { applyTierInstant(want); return; }

  if (want === 'off') {
    if (from === 'full') { hideView(fullV); holdRosterReflow(FULL_HIDE_WIPE_AT); }
    else hideView(mainV);
    return;
  }
  if (from === 'off') {
    if (want === 'full') {
      withBottomClear(() => { if (tierShown === 'full') { renderAllView(fullV, st); showView(fullV); } });
    } else { setMainMode(want); renderAllView(mainV, st); showView(mainV); }
    return;
  }
  if (from === 'full') {          // full -> small | large (simultaneous)
    hideView(fullV);
    holdRosterReflow(FULL_HIDE_WIPE_AT);
    setMainMode(want);
    renderAllView(mainV, st);
    showView(mainV);
    return;
  }
  if (want === 'full') {          // small | large -> full (simultaneous)
    hideView(mainV);
    withBottomClear(() => { if (tierShown === 'full') { renderAllView(fullV, st); showView(fullV); } });
    return;
  }
  mainMode = want;                // small <-> large : base row-mode change
  morphBoard();                   // morph both rows, board stays on screen
}

/* expandable cells (event row / clock row: vertical, period pill: horizontal) */
function toggleCell(node, show, axis = 'y', { instant = false } = {}) {
  const horiz = axis === 'x';
  const prop = horiz ? 'width' : 'height';
  const minProp = horiz ? 'minWidth' : 'minHeight';
  cancelRun(node, 'cell');
  if (instant) {
    node.style[prop] = show ? '' : '0px';
    node.style[minProp] = show ? '' : '0px';
    node.style.opacity = show ? '' : '0';
    if (horiz) node.style.marginLeft = show ? '' : '0px';
    return;
  }
  const k = stageScale * boardScaleVar();
  const curRect = node.getBoundingClientRect();
  const cur = (horiz ? curRect.width : curRect.height) / k;
  const curMl = horiz ? parseFloat(getComputedStyle(node).marginLeft) || 0 : 0;
  node.style[prop] = ''; node.style[minProp] = '';
  node.style.marginLeft = '';
  const natural = horiz ? node.offsetWidth : node.offsetHeight;
  const naturalMl = horiz ? parseFloat(getComputedStyle(node).marginLeft) || 0 : 0;
  const to = show ? natural : 0;
  const toMl = show ? naturalMl : 0;
  const frames = horiz
    ? [{ width: cur + 'px', marginLeft: curMl + 'px', opacity: getComputedStyle(node).opacity },
       { width: to + 'px', marginLeft: toMl + 'px', opacity: show ? 1 : 0 }]
    : [{ height: cur + 'px', opacity: getComputedStyle(node).opacity },
       { height: to + 'px', opacity: show ? 1 : 0 }];
  node.style.opacity = show ? '' : '0';
  if (!show) { node.style[prop] = '0px'; node.style[minProp] = '0px'; if (horiz) node.style.marginLeft = '0px'; }
  run(node, 'cell', frames, { duration: 480, easing: OUT_5 });
}

/* =================================================== show / hide views */

const CLIP_OPEN = 'inset(0% 0 0% 0)';
const CLIP_SHUT = { main: 'inset(0 0 100% 0)', full: 'inset(100% 0 0 0)' };

function revealCellsV(v) {
  return [v.cellEvent, v.boxPeriod, v.boxClock, v.teams.A.root, v.teams.B.root];
}

async function showView(v) {
  bump('vis-' + v.kind);
  const shut = CLIP_SHUT[v.kind];
  v.root.classList.remove('is-hidden');
  v.visible = true;
  run(v.bg, 'vis', [
    { clipPath: shut, opacity: 0.4 },
    { clipPath: CLIP_OPEN, opacity: 1 },
  ], { duration: 620, easing: OUT_5, fill: 'forwards' });
  run(v.grid, 'vis', [
    { clipPath: shut },
    { clipPath: CLIP_OPEN },
  ], { duration: 620, easing: OUT_5, fill: 'forwards' });
  // underlying value = open, so a later cancel (e.g. hide interrupting)
  // snaps to the open state instead of flashing shut for a frame
  v.bg.style.clipPath = CLIP_OPEN;
  v.grid.style.clipPath = CLIP_OPEN;
  run(v.glow, 'vis', [{ opacity: 0 }, { opacity: 0.55 }], { duration: 900, easing: 'ease-out', fill: 'forwards' });
  const fromY = v.kind === 'full' ? 24 : -18;
  revealCellsV(v).forEach((c, i) => {
    run(c, 'vis', [
      { transform: `translateY(${fromY}px)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: 520, delay: 120 + i * 75, easing: OUT_5, fill: 'backwards' });
  });
  if (v === mainV) {
    for (const t of ['A', 'B']) {
      run(rails[t], 'vis', [{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 280, easing: OUT_5, fill: 'backwards' });
    }
  }
}

async function hideView(v) {
  const tok = bump('vis-' + v.kind);
  v.visible = false;
  const cells = revealCellsV(v);
  const toY = v.kind === 'full' ? 18 : -14;
  cells.forEach((c, i) => {
    run(c, 'vis', [
      { transform: 'none', opacity: 1 },
      { transform: `translateY(${toY}px)`, opacity: 0 },
    ], { duration: 230, delay: i * 45, easing: EXIT, fill: 'forwards' });
  });
  if (v === mainV) {
    for (const t of ['A', 'B']) {
      run(rails[t], 'vis', [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EXIT, fill: 'forwards' });
    }
  }
  run(v.glow, 'vis', [{ opacity: 0.55 }, { opacity: 0 }], { duration: 300, easing: EXIT, fill: 'forwards' });
  await later(230 + cells.length * 45);
  if (!alive('vis-' + v.kind, tok)) return;
  const shut = CLIP_SHUT[v.kind];
  run(v.grid, 'vis', [
    { clipPath: CLIP_OPEN },
    { clipPath: shut },
  ], { duration: 380, easing: EXIT, fill: 'forwards' });
  await done(run(v.bg, 'vis', [
    { clipPath: CLIP_OPEN, opacity: 1 },
    { clipPath: shut, opacity: 0.4 },
  ], { duration: 380, easing: EXIT, fill: 'forwards' }));
  if (!alive('vis-' + v.kind, tok)) return;
  v.root.classList.add('is-hidden');
  cells.forEach(c => cancelRun(c, 'vis'));
  cancelRun(v.bg, 'vis');
  cancelRun(v.grid, 'vis');
  cancelRun(v.glow, 'vis');
  if (v === mainV) for (const t of ['A', 'B']) cancelRun(rails[t], 'vis');
  v.bg.style.clipPath = '';
  v.grid.style.clipPath = '';
}

/* ============================================================= clock */

function timerRemaining(t) {
  if (!t.running) return Math.max(0, t.remainingMs);
  return Math.max(0, t.remainingMs - (serverNow() - t.refEpoch));
}
function clockString(ms, direction, remaining) {
  if (direction === 'up') {
    const s = Math.floor(ms / 1000);
    const min = Math.floor(s / 60);
    const sec = s % 60;
    const pMin = (min === 0 && sec === 0) ? '00' : String(min);
    const pSec = String(sec).padStart(2, '0');
    if (remaining < 10000) {
      const cs = Math.floor(ms / 10) % 100;
      return `${pMin}:${pSec}.${String(cs).padStart(2, '0')}`;
    }
    if (remaining < 60000) {
      const ds = Math.floor(ms / 100) % 10;
      return `${pMin}:${pSec}.${ds}`;
    }
    return `${pMin}:${pSec}`;
  }
  if (ms < 10000) {
    const cs = Math.floor(ms / 10);
    return `${Math.floor(cs / 100)}.${String(cs % 100).padStart(2, '0')}`;
  }
  if (ms < 60000) {
    const ds = Math.floor(ms / 100);
    return `${Math.floor(ds / 10)}.${ds % 10}`;
  }
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function clockWordFor(s, kind) {
  const t = s.timer;
  if (t.mode === 'break') return 'BREAK';
  if (t.mode === 'matchEnd') {
    if (t.endAlternate && Math.floor(serverNow() / 2500) % 2 === 0) return null;
    return kind === 'full' ? 'MATCH\nEND' : 'END';
  }
  if (t.mode === 'pause' || (t.autoPauseWord && !t.running)) {
    const r = timerRemaining(t);
    if (t.mode === 'pause' || (r > 0 && r < t.durationMs)) {
      if (t.pauseAlternate && Math.floor(serverNow() / 2500) % 2 === 0) return null;
      return 'PAUSE';
    }
  }
  return null;
}

/* the underlying MAIN-board clock word, ignoring the alternate blink — so a reserved width
 * stays stable while PAUSE / END flashes on and off */
function mainClockWord(s) {
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

/* Reserve the clock word's width on the (always-laid-out) time tape while a word-mode is
 * active. The .clock-word is position:absolute so it never sizes .box-clock — without this
 * a wider PAUSE/BREAK gets clipped (wrong padding) and toggling word<->time resizes the
 * fit-content board. Glided so entering / leaving the mode is smooth. */
function reserveClockWidth(v, text) {
  const probe = buildWord(text);
  Object.assign(probe.style, {
    position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap',
    fontSize: '36px', fontWeight: '600', padding: '0 20px',
  });
  v.boxClock.appendChild(probe);
  const w = probe.offsetWidth;
  probe.remove();
  glideWidthAround(() => { v.clockTapesEl.style.minWidth = w + 'px'; });
}

function swapClockWordV(v, word, { instant = false } = {}) {
  v.shownWord = word;
  const tok = bump('cw-' + v.kind);
  if (instant) {
    v.clockWordEl.innerHTML = '';
    if (word) {
      v.clockWordEl.append(buildWord(word));
      v.clockTapesEl.style.opacity = '0';
    } else {
      cancelRun(v.clockTapesEl, 'cw');
      cancelRun(v.clockTapesEl, 'cw2');
      v.clockTapesEl.style.opacity = '';
      v.lastClockStr = '';
    }
    return;
  }
  if (word) {
    run(v.clockTapesEl, 'cw', [
      { transform: 'translateY(0%)', opacity: 1 },
      { transform: 'translateY(58%)', opacity: 0 },
    ], { duration: 240, easing: EXIT, fill: 'forwards' });
    v.clockWordEl.innerHTML = '';
    const w = buildWord(word);
    v.clockWordEl.append(w);
    const lts = [...w.querySelectorAll('.lt')];
    lts.forEach((lt, i) => {
      run(lt, 'ls', [
        { transform: 'translateY(85%) rotateX(-55deg)', opacity: 0 },
        { transform: 'none', opacity: 1 },
      ], { duration: 430, delay: 140 + i * 34, easing: OUT_5, fill: 'backwards' });
    });
  } else {
    const w = v.clockWordEl.querySelector('.swap-cur');
    if (w) {
      const lts = [...w.querySelectorAll('.lt')];
      lts.forEach((lt, i) => {
        run(lt, 'ls', [
          { transform: 'none', opacity: 1 },
          { transform: 'translateY(70%) rotateX(-55deg)', opacity: 0 },
        ], { duration: 200, delay: i * 18, easing: EXIT, fill: 'forwards' });
      });
      later(240 + lts.length * 18).then(() => { if (alive('cw-' + v.kind, tok)) v.clockWordEl.innerHTML = ''; });
    }
    cancelRun(v.clockTapesEl, 'cw');
    v.clockTapesEl.style.opacity = '';
    run(v.clockTapesEl, 'cw2', [
      { transform: 'translateY(50%)', opacity: 0 },
      { transform: 'translateY(0%)', opacity: 1 },
    ], { duration: 380, delay: 130, easing: OUT_5, fill: 'both' });
    v.lastClockStr = ''; // force refresh
  }
}

function timeEndFx() {
  for (const v of views) {
    if (!v.visible) continue;
    run(v.clockTapesEl, 'blink', [
      { opacity: 1 }, { opacity: 0.15 }, { opacity: 1 },
      { opacity: 0.15 }, { opacity: 1 },
    ], { duration: 760, easing: 'steps(1, end)' });
    glowFlash(v, '#FF3348');
  }
}

/* ============================================================= goals */

const GOAL_WORD_MS = 1800;   // how long the GOAL! word holds before restoring the name (was 3600)

function updateScoreSilent(v, team, score) {
  v.scoreTapes[team].set(String(score), { anim: false });
}

/* Glide the main board's fit-content width when a mutation (e.g. a score digit-count change)
 * resizes it, instead of snapping. No-op when the board is hidden, when a morph / name glide
 * already owns the width, or when the width didn't actually change. */
function widthAnimating() {
  const m = chanMap.get(boardEl);
  return !!(m && (m.has('morphw') || m.has('namew') || m.has('bw')));
}
function glideWidthAround(mutate) {
  if (!mainV.visible || widthAnimating()) { mutate(); return; }
  const w0 = boardEl.offsetWidth;
  mutate();
  const w1 = boardEl.offsetWidth;
  if (Math.abs(w1 - w0) < 1.5) return;
  run(boardEl, 'bw', [{ width: w0 + 'px' }, { width: w1 + 'px' }],
    { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' })
    .finished.then(() => { boardEl.style.width = ''; cancelRun(boardEl, 'bw'); }).catch(() => {});
}

/* the score odometer roll — split out so a goal-expand can roll it partway through
 * the morph while the flourish lands later (see onGoalFx) */
function rollScore(v, team, score, delta = 1) {
  const set = () => v.scoreTapes[team].set(String(score), { dir: delta < 0 ? -1 : 1, anim: v.visible, pop: true });
  if (v === mainV) glideWidthAround(set); else set();
}

/* the GOAL flourish: score punch + glow + particle burst + GOAL! word */
function flourish(v, team) {
  if (!v.visible) return;
  const T = v.teams[team];
  const pal = palettes[team];
  const weak = v === mainV && rowModeFor(team) === 'small';   // 小型列：減弱特效
  run(T.score, 'punch', [
    { transform: 'scale(1)' },
    { transform: `scale(${weak ? 1.1 : v.kind === 'full' ? 1.14 : 1.22})`, offset: 0.28 },
    { transform: 'scale(1)' },
  ], { duration: POP.dur, easing: POP.easing, composite: 'add' });
  if (!weak) {
    glowFlash(v, pal.bright);
    burstFrom(T.score, pal, v.kind === 'full');
  }
  goalWordShow(v, team);
}

function celebrate(v, team, score, delta = 1) {
  rollScore(v, team, score, delta);
  flourish(v, team);
}

async function goalWordShow(v, team) {
  const key = 'gw-' + v.kind + team;
  const tok = bump(key);
  const box = v.teams[team].nameBox;
  // Reserve THIS row's real-name width on its own name box, so a narrower GOAL! word can't
  // shrink the fit-content board. Robust because it is:
  //   · per-box  — each team independent, no ref-counting, no shared board-level pin;
  //   · measured clean — box.offsetWidth is the untransformed layout width of the name that
  //     is on screen right now (ignores any in-flight nameBlend FLIP transform);
  //   · morph-safe — during a morph the width is driven by the 'morphw' glide; this floor
  //     only takes effect once the board is back to fit-content, exactly when GOAL! is up.
  // Cleared unconditionally when this row's name is restored (below) / on re-render.
  if (v === mainV) box.style.minWidth = box.offsetWidth + 'px';
  v.goalWordActive[team] = true;
  letterSwap(box, 'GOAL!', { goal: true, glow: palettes[team].glow, force: true });
  await later(GOAL_WORD_MS);
  if (!alive(key, tok)) return;
  v.goalWordActive[team] = false;
  setName(v, team);
  if (v === mainV) box.style.minWidth = '';
}

function onGoalFx(team, score, delta = 1) {
  if (!st) return;
  const eff = effTier();
  if (eff === 'off') {
    for (const v of views) updateScoreSilent(v, team, score);
    return;
  }
  if (eff === 'full') {
    updateScoreSilent(mainV, team, score);
    celebrate(fullV, team, score, delta);
    return;
  }
  updateScoreSilent(fullV, team, score);

  // 進球動效 (goalEffect): minimal = no expand; partial = only the scoring row expands;
  // full = both rows. Expansion applies only in the small tier.
  const effect = st.board.goalEffect || 'full';
  if (eff !== 'small' || effect === 'minimal') {
    celebrate(mainV, team, score, delta);        // celebrate in place (weak fx while the row is small)
    return;
  }
  const rows = effect === 'full' ? ['A', 'B'] : [team];
  const tok = bump('goalseq-' + team);
  const scorerWasSmall = rowModeFor(team) === 'small';
  for (const r of rows) rowExpand[r] = true;
  morphBoard();                                  // expand the newly-large row(s)
  const sec = Math.max(2, st.board.goalExpandSec) * 1000;
  for (const r of rows) {                         // each row collapses on its OWN timer
    clearTimeout(rowExpandTimer[r]);
    rowExpandTimer[r] = setTimeout(() => { rowExpand[r] = false; morphBoard(); }, sec);
  }
  if (scorerWasSmall) {
    // overlap the celebration with the expand: score rolls just past halfway, GOAL!/burst
    // land a bit later — but still before the morph fully settles.
    setTimeout(() => { if (alive('goalseq-' + team, tok)) rollScore(mainV, team, score, delta); }, Math.round(MORPH_DUR * 0.55));
    setTimeout(() => { if (alive('goalseq-' + team, tok)) flourish(mainV, team); }, Math.round(MORPH_DUR * 0.8));
  } else {
    celebrate(mainV, team, score, delta);         // scoring row already large -> celebrate in place
  }
}

/* ======================================================= event icons */

const ICON_META = {
  FOUL: {
    label: 'FOUL',
    svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="1.5" y="6.5" width="11" height="4.6" rx="1.6" fill="currentColor"/>
      <circle cx="14" cy="13.4" r="7" fill="currentColor"/>
      <circle cx="14" cy="13.4" r="2.6" style="fill:var(--ev-bg)"/>
    </svg>`,
  },
  TIMEOUT: {
    label: 'TIMEOUT',
    svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="9.8" y="1.6" width="4.4" height="3" rx="1" fill="currentColor"/>
      <circle cx="12" cy="13.6" r="8.4" fill="currentColor"/>
      <rect x="8.9" y="9.8" width="2.1" height="7.6" rx="0.8" style="fill:var(--ev-bg)"/>
      <rect x="13" y="9.8" width="2.1" height="7.6" rx="0.8" style="fill:var(--ev-bg)"/>
    </svg>`,
  },
  SUSP2: {
    label: '2:00',                       // shown only if the tape somehow fails; timer replaces it
    svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <text x="10.4" y="18.2" text-anchor="middle" font-size="18" font-weight="800"
            font-family="inherit" fill="currentColor">2</text>
      <rect x="17.4" y="5.6" width="2.4" height="6.4" rx="1.2"
            transform="rotate(14 18.6 8.8)" fill="currentColor"/>
    </svg>`,
  },
  YELLOW: {
    label: 'YELLOW CARD',
    svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="7" y="3.4" width="10.8" height="16.6" rx="1.8"
            transform="rotate(9 12.4 11.7)" fill="currentColor"/>
    </svg>`,
  },
  RED: {
    label: 'RED CARD',
    svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="7" y="3.4" width="10.8" height="16.6" rx="1.8"
            transform="rotate(9 12.4 11.7)" fill="currentColor"/>
    </svg>`,
  },
  BLUE: {
    label: 'BLUE CARD',
    svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="7" y="3.4" width="10.8" height="16.6" rx="1.8"
            transform="rotate(9 12.4 11.7)" fill="currentColor"/>
    </svg>`,
  },
  MEDICAL: {
    label: 'MEDICAL',
    svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="9.9" y="3.6" width="4.2" height="16.8" rx="1.2" fill="currentColor"/>
      <rect x="3.6" y="9.9" width="16.8" height="4.2" rx="1.2" fill="currentColor"/>
    </svg>`,
  },
};
const LABEL_PHASE_MS = 5000;
const SUSP2_MS = 120000;
const iconEls = new Map(); // id -> wrap element

/* 2-min suspension countdown = playing time; the server freezes/unfreezes
 * susp.{msLeft,refEpoch,running} together with the match clock. */
function suspLeftMs(b) {
  const s = b.susp;
  if (!s) return 0;
  const left = s.running ? s.msLeft - (serverNow() - s.refEpoch) : s.msLeft;
  return Math.max(0, Math.min(SUSP2_MS, left));
}
function suspStr(ms) {
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function iconWrapEl(b) {
  const meta = ICON_META[b.type] || ICON_META.FOUL;
  const wrap = el('div', 'evicon-wrap');
  const card = el('div', 'evicon tone-' + (ICON_META[b.type] ? b.type : 'FOUL'));
  const glyph = el('span', 'evicon-glyph');
  glyph.innerHTML = meta.svg;
  const lw = el('span', 'evicon-labelwrap');
  if (b.type === 'SUSP2') {
    const host = el('span', 'evicon-timer');
    lw.append(host);
    wrap.suspTape = new Tape(host);
    wrap.suspTape.set(suspStr(suspLeftMs(b)), { anim: false });
  } else {
    lw.append(el('span', 'evicon-label', meta.label));
  }
  card.append(glyph, lw);
  wrap.append(card);
  wrap.dataset.id = b.id;
  return wrap;
}

function enterIcon(wrap, b, { instant = false } = {}) {
  const rail = rails[b.team === 'B' ? 'B' : 'A'];
  rail.append(wrap);
  if (b.type === 'SUSP2') {
    // the countdown IS the label: it stays open until it hits 0:00
    if (suspLeftMs(b) <= 0) suspFinish(wrap, { instant: true });
  } else if (serverNow() - b.createdAt >= LABEL_PHASE_MS) {
    wrap.dataset.collapsed = '1';
    toggleCell(wrap.querySelector('.evicon-labelwrap'), false, 'x', { instant: true });
  }
  if (instant) return;
  wrap.style.width = '0px';
  toggleCell(wrap, true, 'x');
  run(wrap.querySelector('.evicon'), 'in', [
    { transform: 'translateX(-10px) scale(0.85)', opacity: 0 },
    { transform: 'none', opacity: 1 },
  ], { duration: 380, delay: 60, easing: OUT_5, fill: 'backwards' });
}

function collapseIcon(wrap) {
  wrap.dataset.collapsed = '1';
  toggleCell(wrap.querySelector('.evicon-labelwrap'), false, 'x');
}

function exitIcon(wrap) {
  run(wrap.querySelector('.evicon'), 'out', [
    { opacity: 1 }, { opacity: 0 },
  ], { duration: 240, easing: EXIT, fill: 'forwards' });
  toggleCell(wrap, false, 'x');
  setTimeout(() => wrap.remove(), 540);
}

function renderIcons(list, { instant = false } = {}) {
  const seen = new Set();
  for (const b of list) {
    seen.add(b.id);
    if (!iconEls.has(b.id)) {
      const wrap = iconWrapEl(b);
      iconEls.set(b.id, wrap);
      enterIcon(wrap, b, { instant: instant || !mainV.visible });
    }
  }
  for (const [id, wrap] of iconEls) {
    if (!seen.has(id)) {
      iconEls.delete(id);
      if (instant || !mainV.visible) wrap.remove();
      else exitIcon(wrap);
    }
  }
}

/* countdown hit 0:00 — blink the digits, then collapse to the bare 2' icon.
 * The icon itself stays until it is removed manually from the admin panel. */
function suspFinish(wrap, { instant = false } = {}) {
  wrap.dataset.done = '1';
  const lw = wrap.querySelector('.evicon-labelwrap');
  if (instant || !mainV.visible) { toggleCell(lw, false, 'x', { instant: true }); return; }
  run(lw, 'blink', [
    { opacity: 1 }, { opacity: 0.15 }, { opacity: 1 }, { opacity: 0.15 }, { opacity: 1 },
  ], { duration: 880, easing: 'linear' }).finished.then(() => {
    if (wrap.isConnected) toggleCell(lw, false, 'x');
  }).catch(() => {});
}

function updateIconPhases() {
  if (!st) return;
  for (const b of st.banners) {
    const wrap = iconEls.get(b.id);
    if (!wrap) continue;
    if (b.type === 'SUSP2') {
      if (wrap.dataset.done) continue;
      const left = suspLeftMs(b);
      if (wrap.suspTape) wrap.suspTape.set(suspStr(left), { dir: -1, anim: mainV.visible });
      if (left <= 0) suspFinish(wrap);
      continue;
    }
    if (wrap.dataset.collapsed) continue;
    if (serverNow() - b.createdAt >= LABEL_PHASE_MS) collapseIcon(wrap);
  }
}

/* icon rails hang off the right edge of each team row (F1 style) */
const railPos = { A: { x: -1, y: -1 }, B: { x: -1, y: -1 } };
function trackRails() {
  if (!st) return;
  const k = stageScale * boardScaleVar();
  const boardRect = boardEl.getBoundingClientRect();
  for (const t of ['A', 'B']) {
    const rail = rails[t];
    const teamRect = mainV.teams[t].root.getBoundingClientRect();
    const x = (teamRect.right - boardRect.left) / k;
    const rowH = teamRect.height / k;
    const y = (teamRect.top - boardRect.top) / k + (rowModeFor(t) === 'small' ? Math.max(0, (rowH - 48) / 2) : 10);
    const p = railPos[t];
    if (Math.abs(x - p.x) > 0.5 || Math.abs(y - p.y) > 0.5) {
      rail.style.transform = `translate(${x}px, ${y}px)`;
      p.x = x; p.y = y;
    }
  }
}

/* ===================================================== info banner */

const infobar = document.getElementById('infobar');
const ibStrip = infobar.querySelector('.ib-strip');
const ibBody = infobar.querySelector('.ib-body');
const ibIcon = infobar.querySelector('.ib-icon');
const ibCat = infobar.querySelector('.ib-cat');
const ibMsg = infobar.querySelector('.ib-msg');
const ibChip = infobar.querySelector('.ib-chip');

const IB_ICONS = {
  REFEREE: ICON_META.FOUL.svg,           // whistle
  CONTROL: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M5.2 2.4c-.66 0-1.2.54-1.2 1.2v17a1.1 1.1 0 0 0 2.2 0v-6.4h12.6c.96 0 1.52-1.08.97-1.86l-2.9-4.09 2.9-4.09c.55-.78-.01-1.86-.97-1.86H5.2z" fill="currentColor"/>
  </svg>`,                               // race-control flag
};
const IB_CAT_LABEL = { REFEREE: 'REFEREE:', CONTROL: 'MATCH CONTROL:' };

const IB_REVEAL = springEase(11, 0.86, 720);
const IB_POP = springEase(16, 0.6, 360);
const IB_CHIP_DELAY = 460;               // chip stands alone before the body slides out

let ibShownId = null;
let ibTok = 0;
let ibSwapping = false;
let ibPendTimer = 0;     // deferred show while the roster panels finish leaving
let ibShift = 0;         // horizontal nudge (stage px) that keeps the strip clear of the board
let ibBoardWasActive = null;  // main board on-screen last frame? (null = re-seed on next show)
let ibMoveTok = 0;       // guards the eased reposition glide
let ibGliding = false;   // an eased reposition is in flight; pause per-frame tracking
let ibWTarget = 0;       // applied strip max-width (corner-logo avoidance)
let ibEvictLogos = false;   // strip too squeezed (< IB_MIN_WIDTH) -> evict the corner logos entirely
const IB_MIN_WIDTH = 750;   // below this available width the strip drops the logos instead of shrinking

function ibSetContent(ib) {
  const cat = ib.cat === 'CONTROL' ? 'CONTROL' : 'REFEREE';
  const tone = ib.tone || '#E0132F';
  const fg = ib.fg || '#FFFFFF';
  ibIcon.innerHTML = IB_ICONS[cat];
  ibIcon.style.background = tone;          // icon block follows the verdict colour
  ibIcon.style.color = fg;                 // ... and its glyph matches the chip ink
  // whistle inner circle (fill:var(--ev-bg)) must contrast the glyph, which follows fg:
  // white glyph -> dark hole, dark glyph -> white hole. (Unlike the rail, the banner
  // icon bg is set directly, so --ev-bg here only drives the knockout hole.)
  ibIcon.style.setProperty('--ev-bg', relLuminance(fg) > 0.5 ? '#141414' : '#FFFFFF');
  ibCat.textContent = IB_CAT_LABEL[cat];
  ibMsg.textContent = ib.body || '';
  ibChip.textContent = ib.title || '';
  ibChip.style.background = tone;
  ibChip.style.color = fg;
}

function resetIb() {
  cancelRun(ibStrip, 'reveal');
  cancelRun(ibStrip, 'shift');
  cancelRun(ibChip, 'pop');
  cancelRun(ibBody, 'fade');
  cancelRun(infobar, 'ibfade');
  cancelRun(infobar, 'ibmove');
  ibGliding = false;
  ibStrip.style.clipPath = '';
  ibStrip.style.transform = '';
}

/* clip the strip in from its right (chip) edge; no shadow now, so 0 insets on the other sides */
function ibClip(d) { return `inset(0px 0px 0px ${d}px)`; }

/* decide up front whether the strip would be squeezed below IB_MIN_WIDTH by the corner
 * logos; if so, evict them and let the reveal wait until they have slid away (Jason:
 * 先隱藏全部 corner logo 再執行顯示動畫). Returns the ms to wait before revealing. */
function ibPrepareLogos() {
  if (ibEvictLogos) return cornerOnStage() ? CORNER_OUT_MS + 120 : 0;
  const stripW = Math.min(1240, ibStrip.offsetWidth || 1240);
  const target = !boardEl.classList.contains('is-hidden') ? boardClearShift(stripW) : 0;
  const capWithLogos = 2 * (ibRightLimit() - target) - STAGE_W;
  if ((cornerWantList().length || cornerOnStage()) && capWithLogos < IB_MIN_WIDTH) {
    ibEvictLogos = true;         // suppresses the logos from the next frame
    updateCornerLogos();         // start their exit this tick
    return CORNER_OUT_MS + 120;  // reveal once they have slid off
  }
  return 0;
}

function ibShow(ib) {
  const tok = ++ibTok;
  resetIb();
  ibSetContent(ib);
  infobar.classList.remove('ib-hidden');
  const wait = ibPrepareLogos();
  if (wait > 0) {
    infobar.style.opacity = '0';   // hold the strip hidden while the logos clear
    setTimeout(() => {
      if (tok !== ibTok) return;
      infobar.style.opacity = '';
      ibReveal(ib, tok);
    }, wait);
    return;
  }
  ibReveal(ib, tok);
}

function ibReveal(ib, tok) {
  trackInfoBar();   // seat position + width cap FIRST, so the reveal is measured at the final width
  const D = Math.max(0, ibStrip.offsetWidth - ibChip.offsetWidth);
  // 1. verdict chip pops in alone at the screen centre (strip shifted left by D/2)
  run(ibChip, 'pop', [
    { transform: 'scale(0.55)', opacity: 0 },
    { transform: 'scale(1)', opacity: 1 },
  ], { duration: IB_POP.dur, easing: IB_POP.easing, fill: 'backwards' });
  // 2. body reveals leftwards while the whole strip re-centres: the chip glides
  //    right and the text emerges from behind it, one clip + one transform.
  const glide = { duration: IB_REVEAL.dur, delay: IB_CHIP_DELAY, easing: IB_REVEAL.easing, fill: 'both' };
  run(ibStrip, 'reveal', [{ clipPath: ibClip(D) }, { clipPath: ibClip(0) }], glide)
    .finished.then(() => { if (tok === ibTok) cancelRun(ibStrip, 'reveal'); }).catch(() => {});
  run(ibStrip, 'shift', [
    { transform: `translateX(${-D / 2}px)` },
    { transform: 'translateX(0px)' },
  ], glide).finished.then(() => { if (tok === ibTok) cancelRun(ibStrip, 'shift'); }).catch(() => {});
  // 3. icon + text settle in slightly after the reveal starts
  run(ibBody, 'fade', [
    { opacity: 0, transform: 'translateX(-18px)' },
    { opacity: 1, transform: 'none' },
  ], { duration: 430, delay: IB_CHIP_DELAY + 150, easing: OUT_5, fill: 'both' })
    .finished.then(() => { if (tok === ibTok) cancelRun(ibBody, 'fade'); }).catch(() => {});
}

/* close = the whole strip fades out in place (no shrink) */
function ibHide({ fast = false } = {}) {
  const tok = ++ibTok;
  const dur = fast ? 200 : 300;
  return run(infobar, 'ibfade', [{ opacity: 1 }, { opacity: 0 }],
    { duration: dur, easing: EXIT, fill: 'forwards' }).finished.then(() => {
    if (tok !== ibTok) return;
    infobar.classList.add('ib-hidden');
    infobar.style.transform = '';
    infobar.style.opacity = '';
    ibShift = 0;
    ibBoardWasActive = null;
    if (!(st && st.infoBanner)) ibEvictLogos = false;   // truly gone (not a swap) -> logos return
    resetIb();
  }).catch(() => {});
}

/* how long until the on-stage roster panels are ALMOST fully hidden — the info banner
 * starts its reveal a moment before they finish (Jason: 完全消失前一小會再立刻顯示).
 * rosterHide completes ≈ 490 + rows·14ms; start the banner ~160ms before that. */
function rosterExitWait() {
  let ms = 0;
  for (const t of ['A', 'B']) {
    const r = rosterEls[t];
    if (r.visible) ms = Math.max(ms, 330 + rosterItems(r).length * 14);
    else if (!r.root.classList.contains('is-hidden')) ms = Math.max(ms, 240);   // already mid-hide
  }
  return ms;
}

function renderInfoBanner(ib, { instant = false } = {}) {
  const want = ib ? ib.id : null;
  if (want === ibShownId) return;
  ibShownId = want;
  clearTimeout(ibPendTimer);   // any target change supersedes a pending deferred show
  if (instant) {
    ++ibTok;
    ibSwapping = false;
    resetIb();
    infobar.style.opacity = '';
    if (ib) { ibSetContent(ib); infobar.classList.remove('ib-hidden'); trackInfoBar(); }
    else { infobar.classList.add('ib-hidden'); ibEvictLogos = false; }
    return;
  }
  if (!ib) {
    if (!ibSwapping) ibHide();   // a swap in flight already ends hidden if the target went away
    return;
  }
  if (!infobar.classList.contains('ib-hidden')) {
    // one at a time: fade the current banner out, then expand the new one
    if (!ibSwapping) {
      ibSwapping = true;
      ibHide({ fast: true }).then(() => {
        ibSwapping = false;
        const cur = st && st.infoBanner;
        if (cur && cur.id === ibShownId) ibShow(cur);
      });
    }
    return;
  }
  // the roster panels give way to the banner (their gate hides them this same sync);
  // hold the reveal until they are almost gone, then come in right on their tail.
  const wait = rosterExitWait();
  if (wait > 0) {
    ibPendTimer = setTimeout(() => {
      const cur = st && st.infoBanner;
      if (cur && cur.id === ibShownId && infobar.classList.contains('ib-hidden')) ibShow(cur);
    }, wait);
    return;
  }
  ibShow(ib);
}

/* Keep the centred strip from covering the top-left board: if the board's right
 * edge (plus a gap) reaches past the strip's natural left edge, nudge the whole
 * bar right by just enough to clear it. Clamped so the bar stays on stage.
 *
 * While the board is on screen (present or mid width-morph) we track it directly
 * every frame, so the nudge glides in sync with the small<->large morph. The
 * board's is-hidden class flips only at the END of its show/hide wipe, so during
 * a switch to/from full the target holds until the board has fully gone, then an
 * eased glide (not a per-frame snap) moves the bar to its new spot. */
function boardClearShift(stripW) {
  const naturalLeft = (STAGE_W - stripW) / 2;
  const stageRect = stage.getBoundingClientRect();
  const boardRight = (boardEl.getBoundingClientRect().right - stageRect.left) / stageScale;
  const maxShift = Math.max(0, STAGE_W - 20 - stripW - naturalLeft);
  return Math.min(Math.max(0, boardRight + 26 - naturalLeft), maxShift);
}

/* x-limit (stage px) the strip's right edge must stay left of: the LIVE left edge of the
 * corner-logo zone (measured, so it tracks the variable-width logos as they slide), else
 * the stage edge. The zone animates its own width, so this moves smoothly on its own. */
function ibRightLimit() {
  if (!cornerWantList().length && !cornerOnStage()) return STAGE_W - 20;
  const cr = cornerEl.getBoundingClientRect();
  if (!(cr.width > 0)) return STAGE_W - 20;
  const left = (cr.left - stage.getBoundingClientRect().left) / (stageScale || 1);
  return left - 24;
}

/* apply a strip max-width directly — the corner zone and the board both move via their
 * own smooth animations, so per-frame tracking already reads as a smooth width glide */
function ibSetWidth(w) {
  if (Math.abs(w - ibWTarget) < 0.5 && ibStrip.style.maxWidth) return;
  ibWTarget = w;
  ibStrip.style.maxWidth = w + 'px';
}

function trackInfoBar() {
  if (infobar.classList.contains('ib-hidden')) { ibBoardWasActive = null; return; }
  const stripW = ibStrip.offsetWidth;
  if (!stripW) return;
  const boardActive = !boardEl.classList.contains('is-hidden');
  const target = boardActive ? boardClearShift(stripW) : 0;

  /* width cap — keep the strip clear of the corner logos. The cap keeps the strip's
   * right edge (after the centring shift) left of the zone; the smoothing comes from
   * the zone / board animating, tracked per frame. */
  ibSetWidth(Math.max(360, Math.min(1240, 2 * (ibRightLimit() - target) - STAGE_W)));

  // board just appeared / disappeared -> ease from the held position to the new one
  if (ibBoardWasActive !== null && boardActive !== ibBoardWasActive) {
    ibBoardWasActive = boardActive;
    const from = ibShift;
    ibShift = target;
    if (Math.abs(target - from) > 0.5) {
      ibGliding = true;
      const tok = ++ibMoveTok;
      run(infobar, 'ibmove',
        [{ transform: `translateX(${from}px)` }, { transform: `translateX(${target}px)` }],
        { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' })
        .finished.then(() => {
          if (tok !== ibMoveTok) return;
          ibGliding = false;
          cancelRun(infobar, 'ibmove');
          infobar.style.transform = ibShift ? `translateX(${ibShift}px)` : '';
        }).catch(() => {});
    }
    return;
  }
  ibBoardWasActive = boardActive;
  if (ibGliding) return;   // the eased glide owns the transform until it finishes

  if (Math.abs(target - ibShift) > 0.5) {
    infobar.style.transform = target ? `translateX(${target}px)` : '';
    ibShift = target;
  }
}

/* ======================================================== team rosters */
/* Side panels (A left, B right), on stage only while the tier is 'full' or
 * 'off'. Content = roster entries ordered 領隊→教練→工作人員→球員. Each page can
 * hold TWO columns (both opening with their group subtitle); it drops to ONE
 * column + paging when two columns would exceed the panel's max width. Vertical
 * capacity follows the free space: full stage height (board off) vs. above the
 * full board (board full). Both teams share one page index (admin flips them
 * together), each clamped to its own last page. */

const RP_ROW_H = 48;         // .rp-row fixed height  (CSS)
const RP_HEAD_H = 52;        // .rp-ghead height incl. its divider (CSS)
const RP_COL_GAP = 44;       // gap between the two columns (CSS)
const RP_PANEL_HEAD = 68;    // .rp-head height (CSS)
const RP_ROWS_PAD = 8;       // .rp-rows top padding + slack
const RP_DOTS_RESERVE = 44;  // space kept for the page dots
const RP_GAP_FULL = 28;      // clearance kept above the full board
const ROSTER_GROUPS = [['LEADER', '領隊'], ['COACH', '教練'], ['STAFF', '工作人員'], ['PLAYER', '球員']];

const rosterEls = {};
for (const t of ['A', 'B']) {
  const root = document.getElementById('roster' + t);
  rosterEls[t] = {
    root,
    bg: root.querySelector('.rp-bg'),
    head: root.querySelector('.rp-head'),
    headBg: root.querySelector('.rp-head-bg'),
    title: root.querySelector('.rp-title'),
    rows: root.querySelector('.rp-rows'),
    dots: root.querySelector('.rp-dots'),
    visible: false,
    page: 0,
    renderSig: '',
    rosterIdentity: '',
    layoutCache: null,
    layoutCacheSig: '',
  };
}

/* entries with a name only — a nameless / blank row never displays or paginates */
function namedEntries(t) {
  const list = (st && st.roster && Array.isArray(st.roster[t])) ? st.roster[t] : [];
  return list.filter(e => String(e.name || '').trim());
}
function rosterIdentity(t) {
  return JSON.stringify(namedEntries(t).map(e => [e.role, e.id, e.name, e.num, e.pos, e.title]));
}
function rosterDisplayPage() {
  return (st && st.rosterDisplay && Number(st.rosterDisplay.page)) || 0;
}

/* flat item stream: a header then its people, per non-empty group, in order */
function rosterStream(t) {
  const list = namedEntries(t);
  const out = [];
  for (const [role, label] of ROSTER_GROUPS) {
    const es = list.filter(e => e.role === role);
    if (!es.length) continue;
    out.push({ kind: 'head', role, label });
    for (const e of es) out.push({ kind: 'person', role, e });
  }
  return out;
}

/* vertical space (stage px) a panel may occupy: full stage minus margins while
 * the board is off; above the full board (measured) while it is on. */
function rosterAvailH() {
  const margin = Math.round(Number(st.board.margin) || 0);
  if (effTier() === 'full') {
    let fullH = 340;
    if (!fullEl.classList.contains('is-hidden')) {
      const h = fullEl.getBoundingClientRect().height / (stageScale || 1);
      if (h > 60) fullH = h;
    }
    return Math.max(300, STAGE_H - 2 * margin - fullH - RP_GAP_FULL);
  }
  return Math.max(300, STAGE_H - 2 * margin);
}

/* greedily pack the stream into columns of `budget` px. A column that starts
 * mid-group repeats that group's header, and a header never lands as a column's
 * last line — so every column opens with a subtitle. */
function rosterPack(stream, budget) {
  const columns = [];
  let col = [], used = 0, curHead = null;
  const flush = () => { if (col.length) { columns.push(col); col = []; used = 0; } };
  for (const item of stream) {
    if (item.kind === 'head') {
      curHead = item;
      if (used > 0 && used + RP_HEAD_H + RP_ROW_H > budget) flush();
      col.push(item); used += RP_HEAD_H;
    } else {
      if (used > 0 && used + RP_ROW_H > budget) {
        flush();
        if (curHead) { col.push({ kind: 'head', role: curHead.role, label: curHead.label, repeat: true }); used += RP_HEAD_H; }
      }
      col.push(item); used += RP_ROW_H;
    }
  }
  flush();
  return columns;
}

/* measure the natural width of one column (widest row) with a hidden probe */
function rosterProbeColWidth(t) {
  const r = rosterEls[t];
  const probe = el('div', 'rp-col');
  Object.assign(probe.style, { position: 'absolute', visibility: 'hidden', left: '-9999px', top: '0' });
  probe.append(el('div', 'rp-ghead', '工作人員'));
  for (const e of namedEntries(t)) probe.append(rosterRowEl(e));
  r.rows.append(probe);
  const w = probe.offsetWidth;
  probe.remove();
  return w;
}

/* two columns only if they fit the panel's max width; else one column + paging */
function rosterDecideCols(t, columns, margin) {
  if (columns.length < 2) return 1;
  const panelMaxW = STAGE_W / 2 - margin - 24;   // mirrors .roster-panel max-width
  const innerMax = panelMaxW - 52;               // minus .rp-rows padding (26*2)
  const colW = rosterProbeColWidth(t);
  return (colW > 0 && colW * 2 + RP_COL_GAP <= innerMax) ? 2 : 1;
}

/* {columns, cols, pages} — memoised by roster content + tier + margin + availH */
function rosterComputeLayout(t) {
  const r = rosterEls[t];
  const margin = Math.round(Number(st.board.margin) || 0);
  const availH = rosterAvailH();
  const idn = rosterIdentity(t);
  const sig = idn + '|' + Math.round(availH / 16) + '|' + margin + '|' + effTier();
  if (r.layoutCacheSig === sig && r.layoutCache) return r.layoutCache;
  const budget = Math.max(RP_HEAD_H + RP_ROW_H, availH - RP_PANEL_HEAD - RP_DOTS_RESERVE - RP_ROWS_PAD);
  const columns = rosterPack(rosterStream(t), budget);
  const cols = rosterDecideCols(t, columns, margin);
  const pages = [];
  for (let i = 0; i < columns.length; i += cols) pages.push(columns.slice(i, i + cols));
  const layout = { columns, cols, pages: pages.length ? pages : [[]] };
  r.layoutCache = layout; r.layoutCacheSig = sig;
  return layout;
}

function rosterPages(t) { return rosterComputeLayout(t).pages.length; }
function rosterPageFor(t) {
  return Math.max(0, Math.min(rosterDisplayPage(), rosterPages(t) - 1));
}
function rosterWantVisible(t) {
  if (!st) return false;
  if (st.infoBanner) return false;   // the info banner owns the screen while shown — panels give way
  const mode = (st.rosterDisplay && st.rosterDisplay.mode) || 'off';
  if (mode !== 'both' && mode !== t) return false;
  const tier = effTier();
  if (tier !== 'off' && tier !== 'full') return false;
  return namedEntries(t).length > 0;
}
function rosterRenderSig(t, layout, page) {
  const pg = layout.pages[page] || [];
  const items = pg.map(col => col.map(it => it.kind === 'head'
    ? 'H:' + it.label + (it.repeat ? '*' : '')
    : 'P:' + it.e.id + ':' + it.e.name + ':' + it.e.num + ':' + it.e.pos + ':' + it.e.title));
  return JSON.stringify([layout.cols, layout.pages.length, page, items,
    st.teams[t].color, st.teams[t].name, st.teams[t].short]);
}

function rosterRowEl(e) {
  const row = el('div', 'rp-row');
  if (e.role === 'PLAYER') {
    if (e.num) row.append(el('span', 'rr-num', e.num));
    row.append(el('span', 'rr-name', e.name || ''));
    if (e.pos) row.append(el('span', 'rr-sub', e.pos.toUpperCase()));
  } else {
    if (e.title) row.append(el('span', 'rr-sub', e.title));
    row.append(el('span', 'rr-name', e.name || ''));
  }
  return row;
}
/* stable identity of a page item — drives the keyed reflow diff (who stays / leaves /
 * arrives). Persons key on their roster id; headers on role (+ '*' for the repeated
 * copy a column that starts mid-group gets — at most one per role per page). */
function rosterItemKey(item) {
  return item.kind === 'head' ? 'H:' + item.role + (item.repeat ? '*' : '') : 'P:' + item.e.id;
}
function rosterNodeFor(item) {
  const node = item.kind === 'head' ? el('div', 'rp-ghead', item.label) : rosterRowEl(item.e);
  node.dataset.rk = rosterItemKey(item);
  return node;
}
function rosterBuildPage(t, layout, pageIdx) {
  const page = layout.pages[Math.max(0, Math.min(pageIdx, layout.pages.length - 1))] || [];
  const frag = document.createDocumentFragment();
  for (const column of page) {
    const colEl = el('div', 'rp-col');
    for (const item of column) colEl.append(rosterNodeFor(item));
    frag.append(colEl);
  }
  return frag;
}

/* accordion in/out for a single roster row — the row (and its borders / padding)
 * collapse to zero height so its neighbours flow into the gap on their own, with NO
 * transform on the survivors. Out and in are exact mirrors (Jason: 消失動畫和顯示動畫要保持一致). */
function rowCollapseOut(node, dur) {
  if (node.dataset.leaving) return;
  node.dataset.leaving = '1';
  const cs = getComputedStyle(node);
  const h = node.offsetHeight;
  node.style.boxSizing = 'border-box';
  node.style.overflow = 'hidden';
  run(node, 'pg', [
    { height: h + 'px', opacity: 1, borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
    { height: '0px', opacity: 0, borderTopWidth: '0px', borderBottomWidth: '0px', paddingTop: '0px', paddingBottom: '0px' },
  ], { duration: dur, easing: EXIT, fill: 'forwards' })
    .finished.then(() => node.remove()).catch(() => node.remove());
}
function rowExpandIn(node, dur, delay) {
  const cs = getComputedStyle(node);
  const h = node.offsetHeight;   // natural height (just inserted, not yet animated)
  const bt = cs.borderTopWidth, bb = cs.borderBottomWidth, pt = cs.paddingTop, pb = cs.paddingBottom;
  node.style.boxSizing = 'border-box';
  node.style.overflow = 'hidden';
  run(node, 'pg', [
    { height: '0px', opacity: 0, borderTopWidth: '0px', borderBottomWidth: '0px', paddingTop: '0px', paddingBottom: '0px' },
    { height: h + 'px', opacity: 1, borderTopWidth: bt, borderBottomWidth: bb, paddingTop: pt, paddingBottom: pb },
  ], { duration: dur, delay: delay || 0, easing: OUT_5, fill: 'backwards' })
    .finished.then(() => {
      for (const p of ['height', 'overflow', 'boxSizing', 'borderTopWidth', 'borderBottomWidth', 'paddingTop', 'paddingBottom']) node.style[p] = '';
    }).catch(() => {});
}

/* reconcile ONE column in place, keyed by row identity: leavers collapse out, newcomers
 * expand in, survivors are the same DOM node kept where they are (they only reflow). */
function rosterReconcileColumn(colEl, targetItems, outMs, inMs) {
  const existing = new Map();
  for (const node of colEl.children) { if (!node.dataset.leaving) existing.set(node.dataset.rk, node); }
  const targetKeys = new Set(targetItems.map(rosterItemKey));
  for (const [k, node] of existing) {
    if (!targetKeys.has(k)) { rowCollapseOut(node, outMs); existing.delete(k); }
  }
  let prev = null, inIdx = 0;
  for (const item of targetItems) {
    const k = rosterItemKey(item);
    let node = existing.get(k);
    if (node) { prev = node; continue; }
    node = rosterNodeFor(item);
    if (prev) prev.after(node); else colEl.insertBefore(node, colEl.firstChild);
    rowExpandIn(node, inMs, 40 + inIdx++ * 24);
    prev = node;
  }
}
function rosterItems(r) { return [...r.rows.querySelectorAll('.rp-row, .rp-ghead')]; }
function rosterPaintDots(t, layout, page) {
  const r = rosterEls[t];
  r.dots.innerHTML = '';
  const pages = layout.pages.length;
  if (pages < 2) return;
  for (let i = 0; i < pages; i++) r.dots.append(el('i', i === page ? 'on' : ''));
}
function rosterApplyTheme(t) {
  const r = rosterEls[t];
  const pal = palettes[t];
  r.root.style.setProperty('--rp-c', pal.base);
  r.root.style.setProperty('--rp-ink', pal.ink);
  r.headBg.innerHTML = facetSVG(pal, { mirror: t === 'B' });   // same faceted theme block as the board
  r.title.textContent = ((st.teams[t].name || st.teams[t].short) || '').toUpperCase();
}
/* build the given page instantly (no animation) */
function rosterPaint(t, layout, page) {
  const r = rosterEls[t];
  rosterApplyTheme(t);
  r.page = page;
  r.rows.style.height = '';
  r.rows.innerHTML = '';
  r.rows.append(rosterBuildPage(t, layout, page));
  rosterPaintDots(t, layout, page);
  r.renderSig = rosterRenderSig(t, layout, page);
  r.rosterIdentity = rosterIdentity(t);
}

const RP_SHUT = 'inset(0 0 100% 0)';
const RP_OPEN = 'inset(0 0 0% 0)';

function rosterShow(t) {
  const r = rosterEls[t];
  bump('rp-' + t);
  const layout = rosterComputeLayout(t);
  rosterPaint(t, layout, Math.max(0, Math.min(rosterDisplayPage(), layout.pages.length - 1)));
  r.root.classList.remove('is-hidden');
  r.visible = true;
  run(r.bg, 'vis', [
    { clipPath: RP_SHUT, opacity: 0.5 },
    { clipPath: RP_OPEN, opacity: 1 },
  ], { duration: 560, easing: OUT_5, fill: 'forwards' });
  r.bg.style.clipPath = RP_OPEN;   // resting value, so an interrupt can't flash it shut
  run(r.head, 'vis', [
    { transform: 'translateY(-12px)', opacity: 0 },
    { transform: 'none', opacity: 1 },
  ], { duration: 460, delay: 110, easing: OUT_5, fill: 'backwards' });
  rosterItems(r).forEach((row, i) => run(row, 'vis', [
    { transform: 'translateY(-14px)', opacity: 0 },
    { transform: 'none', opacity: 1 },
  ], { duration: 420, delay: 170 + i * 26, easing: OUT_5, fill: 'backwards' }));
  run(r.dots, 'vis', [{ opacity: 0 }, { opacity: 1 }],
    { duration: 380, delay: 340, easing: OUT_5, fill: 'backwards' });
}

async function rosterHide(t) {
  const r = rosterEls[t];
  const tok = bump('rp-' + t);
  r.visible = false;
  const rows = rosterItems(r);
  rows.forEach((row, i) => run(row, 'vis', [
    { transform: 'none', opacity: 1 },
    { transform: 'translateY(-10px)', opacity: 0 },
  ], { duration: 180, delay: i * 14, easing: EXIT, fill: 'forwards' }));
  run(r.head, 'vis', [{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: EXIT, fill: 'forwards' });
  run(r.dots, 'vis', [{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: EXIT, fill: 'forwards' });
  await later(150 + rows.length * 14);
  if (!alive('rp-' + t, tok)) return;
  await done(run(r.bg, 'vis', [
    { clipPath: RP_OPEN, opacity: 1 },
    { clipPath: RP_SHUT, opacity: 0.5 },
  ], { duration: 340, easing: EXIT, fill: 'forwards' }));
  if (!alive('rp-' + t, tok)) return;
  r.root.classList.add('is-hidden');
  rosterItems(r).forEach(row => cancelRun(row, 'vis'));
  cancelRun(r.head, 'vis');
  cancelRun(r.dots, 'vis');
  cancelRun(r.bg, 'vis');
  r.bg.style.clipPath = '';
}

/* manual page flip: current rows roll out in the flip direction, the new rolls in */
function rosterTurnPage(t, layout, page) {
  const r = rosterEls[t];
  const dir = page > r.page ? 1 : -1;
  const tok = bump('rp-page-' + t);
  const old = rosterItems(r);
  const h0 = r.rows.offsetHeight;
  old.forEach((row, i) => run(row, 'pg', [
    { transform: 'none', opacity: 1 },
    { transform: `translateY(${-16 * dir}px)`, opacity: 0 },
  ], { duration: 190, delay: i * 8, easing: EXIT, fill: 'forwards' }));
  later(150 + old.length * 8).then(() => {
    if (!alive('rp-page-' + t, tok) || !r.visible) return;
    r.rows.style.height = '';
    r.rows.innerHTML = '';
    r.rows.append(rosterBuildPage(t, layout, page));
    rosterPaintDots(t, layout, page);
    r.page = page;
    r.renderSig = rosterRenderSig(t, layout, page);
    r.rosterIdentity = rosterIdentity(t);
    const h1 = r.rows.offsetHeight;
    if (Math.abs(h1 - h0) > 1) {
      run(r.rows, 'h', [{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 340, easing: OUT_5 })
        .finished.then(() => { r.rows.style.height = ''; }).catch(() => {});
    }
    rosterItems(r).forEach((row, i) => run(row, 'pg', [
      { transform: `translateY(${20 * dir}px)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: 360, delay: 40 + i * 18, easing: OUT_5, fill: 'backwards' }));
  });
}

/* row skeleton of a render signature — column shapes only (kinds per column). Equal
 * skeletons = only texts / theme changed (soft crossfade is enough); different skeletons
 * = rows appeared / vanished / repacked (full cascade reflow with the height morph). */
function rosterSkeleton(sig) {
  try {
    const [cols, pages, page, items] = JSON.parse(sig);
    return JSON.stringify([cols, pages, page, items.map(col => col.map(s => s.charAt(0)))]);
  } catch { return sig; }
}

/* content or available-height changed while visible — rebuild in place.
 * reflow=false : same row skeleton (a rename, a theme tint) -> light crossfade.
 * reflow=true  : KEYED in-place diff (Jason: 不是 move transition — 需要消失的球員做消失動畫，
 *                隨即在新位置做顯示動畫). Survivors are kept as-is and simply reflow (no
 *                transform); only leaving rows collapse+fade out and arriving rows expand+
 *                fade in, mirror animations. A row that moves columns naturally reads as
 *                a disappear-here / reappear-there, exactly as asked.
 * urgent=true  : the full board is arriving bottom-centre — compressed timings so the
 *                panel clears the board's zone before its reveal wipe reaches the top. */
function rosterRefresh(t, layout, page, { reflow = false, urgent = false } = {}) {
  const r = rosterEls[t];
  if (!reflow) {
    const h0 = r.rows.offsetHeight;
    rosterPaint(t, layout, page);
    const h1 = r.rows.offsetHeight;
    if (Math.abs(h1 - h0) > 1) {
      run(r.rows, 'h', [{ height: h0 + 'px' }, { height: h1 + 'px' }], { duration: 420, easing: OUT_5 })
        .finished.then(() => { r.rows.style.height = ''; }).catch(() => {});
    }
    run(r.rows, 'pg', [{ opacity: 0.5 }, { opacity: 1 }], { duration: 260, easing: 'ease-out' });
    return;
  }
  const tok = bump('rp-page-' + t);
  r.rows.style.height = '';   // let the panel height follow the accordion naturally
  const tPage = layout.pages[Math.max(0, Math.min(page, layout.pages.length - 1))] || [];
  const outMs = urgent ? 200 : 300;
  const inMs = urgent ? 320 : 440;
  const curCols = [...r.rows.querySelectorAll('.rp-col')];
  const nCols = Math.max(curCols.length, tPage.length);
  for (let ci = 0; ci < nCols; ci++) {
    let colEl = curCols[ci];
    if (!colEl) { colEl = el('div', 'rp-col'); r.rows.append(colEl); }
    rosterReconcileColumn(colEl, tPage[ci] || [], outMs, inMs);
  }
  // drop any column emptied by the reflow once its rows have finished collapsing
  setTimeout(() => {
    if (!alive('rp-page-' + t, tok)) return;
    for (const c of [...r.rows.querySelectorAll('.rp-col')]) if (!c.children.length) c.remove();
  }, outMs + 120);
  rosterPaintDots(t, layout, page);
  r.page = page;
  r.renderSig = rosterRenderSig(t, layout, page);
  r.rosterIdentity = rosterIdentity(t);
}

function rosterMountInstant(t) {
  const r = rosterEls[t];
  bump('rp-' + t);
  const layout = rosterComputeLayout(t);
  rosterPaint(t, layout, Math.max(0, Math.min(rosterDisplayPage(), layout.pages.length - 1)));
  r.root.classList.remove('is-hidden');
  r.visible = true;
  r.bg.style.clipPath = '';
}
function rosterUnmountInstant(t) {
  const r = rosterEls[t];
  bump('rp-' + t);
  r.root.classList.add('is-hidden');
  r.visible = false;
}

/* While the full board plays its hide (full -> off/small/large) the roster panels keep
 * their old (short) layout; the re-pack to the taller budget is released exactly when the
 * board's bg wipe starts collapsing downwards, so the panel grows into space that is being
 * vacated — not on top of a still-visible board. */
const FULL_HIDE_WIPE_AT = 470;   // hideView(fullV): cells leave ≈455ms, then the bg wipe starts
let rosterReflowHold = false;
let rosterHoldTok = 0;
function holdRosterReflow(ms) {
  rosterReflowHold = true;
  const tok = ++rosterHoldTok;
  setTimeout(() => {
    if (tok !== rosterHoldTok) return;
    rosterReflowHold = false;
    updateRosters();
  }, ms);
}

/* a panel's entrance can be queued behind other elements' exits: the bottom banner
 * (fades out first, both sides) and the corner logos (slide out first, B side) */
const rosterPendTimer = { A: 0, B: 0 };
function rosterShowDelay(t) {
  let d = 0;
  if (!bottombar.classList.contains('bb-hidden')) d = Math.max(d, BB_CLEAR_MS);
  // the corner logos yield to the B panel; in 全部 mode BOTH panels wait, so the
  // two sides enter together on the tail of the logos' exit
  const mode = (st.rosterDisplay && st.rosterDisplay.mode) || 'off';
  if ((t === 'B' || mode === 'both') && cornerOnStage()) d = Math.max(d, CORNER_CLEAR_MS);
  return d;
}

function updateRosters({ instant = false } = {}) {
  if (!st) return;
  for (const t of ['A', 'B']) {
    const r = rosterEls[t];
    const want = rosterWantVisible(t);
    if (want && !r.visible) {
      if (instant) { clearTimeout(rosterPendTimer[t]); rosterPendTimer[t] = 0; rosterMountInstant(t); continue; }
      if (rosterPendTimer[t]) continue;              // entrance already queued
      const delay = rosterShowDelay(t);
      if (delay > 0) {
        updateBottomBanner();                        // start the yields this tick
        updateCornerLogos();
        rosterPendTimer[t] = setTimeout(() => {
          rosterPendTimer[t] = 0;
          if (rosterWantVisible(t) && !rosterEls[t].visible) rosterShow(t);
        }, delay);
      } else rosterShow(t);
      continue;
    }
    if (!want && rosterPendTimer[t]) { clearTimeout(rosterPendTimer[t]); rosterPendTimer[t] = 0; }
    if (!want && r.visible) { instant ? rosterUnmountInstant(t) : rosterHide(t); continue; }
    if (!want) continue;
    const layout = rosterComputeLayout(t);
    const page = Math.max(0, Math.min(rosterDisplayPage(), layout.pages.length - 1));
    const sig = rosterRenderSig(t, layout, page);
    if (sig === r.renderSig) continue;
    if (instant) { rosterPaint(t, layout, page); continue; }
    if (rosterReflowHold) continue;   // full board still clearing — re-checked on release
    if (page !== r.page && rosterIdentity(t) === r.rosterIdentity) rosterTurnPage(t, layout, page);
    else {
      rosterRefresh(t, layout, page, {
        reflow: rosterSkeleton(sig) !== rosterSkeleton(r.renderSig),
        urgent: effTier() === 'full',
      });
    }
  }
}

/* ===================================================== bottom banner */
/* Bottom-centre card, one at a time: a team person (team facet theme), an event
 * official (white facet theme) or an organisation (pure white + left icon). The
 * server froze the content at show time. Pure fade in / out (Jason: 淡入淡出即可).
 * The bottom zone belongs to the full board / roster panels: while one of them is
 * on stage OR arriving the card yields (fades out first — they enter on its tail),
 * and it fades back automatically once they have fully left. */

const bottombar = document.getElementById('bottombar');
const bbCard = bottombar.querySelector('.bb-card');
const bbBg = bottombar.querySelector('.bb-bg');
const bbIconWrap = bottombar.querySelector('.bb-icon');
const bbImg = bottombar.querySelector('.bb-icon img');
const bbNameEl = bottombar.querySelector('.bb-name');
const bbSubEl = bottombar.querySelector('.bb-sub');

const BB_ROLE_LABEL = {
  LEADER: '領隊', COACH: '教練', STAFF: '工作人員', PLAYER: '球員',
  COMMENTATOR: '評論員', REFEREE: '裁判',
  HOST: '主辦單位', SUPPORT: '支持及指導單位', FUNDER: '資助機構',
};
/* hand-tuned near-white palette for event officials — buildPalette('#FFFFFF') greys
 * out (its lightness clamp), so the "white theme" facets get explicit tones instead */
const BB_WHITE_PAL = {
  base: '#F4F6FA', deep: '#E7EBF2', deeper: '#DADFE9',
  bright: '#FFFFFF', shift: '#EDF1F7', glow: '#FFFFFF',
  ink: '#0D0F13', isLight: true,
};
const BB_CLEAR_MS = 210;   // how long an arriving big element waits for the card's fade-out
const BB_REVEAL = springEase(11, 0.86, 720);  // card stretch-open (mirrors the info strip IB_REVEAL)
const BB_POP = springEase(16, 0.6, 360);      // org icon pop-in (mirrors IB_POP)
const BB_ICON_DELAY = 460;   // org icon stands alone before the card stretches (mirrors IB_CHIP_DELAY)
/* clip the card in from its RIGHT edge (mirror of the info strip, whose chip is on the right) */
function bbClipR(d) { return `inset(0px ${d}px 0px 0px)`; }

let bbShownId = null;
let bbTok = 0;
let bbSwapping = false;

function bbFit() {
  bbNameEl.style.fontSize = '';
  const w = bbNameEl.scrollWidth, avail = bbNameEl.clientWidth;
  if (w > avail && avail > 0) {
    bbNameEl.style.fontSize = Math.max(24, Math.floor(44 * (avail / w) * 0.98)) + 'px';
  }
}

function bbSetContent(bb) {
  // person / official roles are codes -> map to 繁中; an organisation's position is
  // free admin text (may be empty) -> shown verbatim
  const label = bb.kind === 'org' ? (bb.role || '') : (BB_ROLE_LABEL[bb.role] || bb.role || '');
  bbNameEl.textContent = bb.name || '';
  bbSubEl.textContent = bb.kind === 'person'
    ? ((bb.teamName || '').toUpperCase() + (label ? '——' + label : ''))
    : label;
  bbSubEl.style.display = label ? '' : 'none';
  bbCard.classList.toggle('bb-org', bb.kind === 'org');
  // org uses the SAME white facet theme as an official; its CSS overlay then dissolves
  // the left (icon) side to pure white
  const pal = bb.kind === 'person' ? buildPalette(bb.color || '#D6152C') : BB_WHITE_PAL;
  bbBg.innerHTML = facetSVG(pal, {});
  const light = pal.isLight;
  bbCard.classList.toggle('bb-light', light);
  bbCard.style.setProperty('--bb-ink', pal.ink);
  bbCard.style.setProperty('--bb-ink-dim', light ? 'rgba(13,15,19,0.66)' : 'rgba(255,255,255,0.74)');
  if (bb.kind === 'org' && bb.file) {
    bbImg.src = '/assets/banner/' + encodeURIComponent(bb.file);
    bbIconWrap.classList.remove('bb-noicon');
    // dynamic white mask: solid until the icon block + a padding of clearance, then a
    // short 80px fade to transparent (Jason #2). Needs the image's real width.
    if (bbImg.complete && bbImg.naturalWidth) bbSetOrgMask();
    else bbImg.addEventListener('load', bbSetOrgMask, { once: true });
  } else {
    bbImg.removeAttribute('src');
    bbIconWrap.classList.add('bb-noicon');
  }
  bbFit();
}

function bbSetOrgMask() {
  // solid white spans the whole icon block (image + its symmetric padding), then a short
  // 80px fade into the facet — so the icon always sits on a clean white field (Jason #2)
  const start = bbIconWrap.offsetWidth;
  bbCard.style.setProperty('--bb-fade-start', start + 'px');
  bbCard.style.setProperty('--bb-fade-end', (start + 80) + 'px');
}

/* the bottom zone is claimed the moment a full board / roster panel is REQUESTED
 * (state-based → the card yields first) and released only once they are fully
 * gone (DOM-based → the card returns after their exit completes) */
function bbBlocked() {
  if (!st) return true;
  if (effTier() === 'full' || !fullEl.classList.contains('is-hidden')) return true;
  for (const t of ['A', 'B']) {
    if (rosterWantVisible(t) || !rosterEls[t].root.classList.contains('is-hidden')) return true;
  }
  return false;
}

function resetBb() {
  cancelRun(bottombar, 'bbfade');
  cancelRun(bbCard, 'reveal');
  cancelRun(bbCard, 'shift');
  cancelRun(bbIconWrap, 'pop');
  cancelRun(bbNameEl, 'bbfade');
  cancelRun(bbSubEl, 'bbfade');
  bbCard.style.clipPath = '';
  bbCard.style.transform = '';
}

/* Show. HIDE stays a plain fade (unchanged).
 *  · person / official : the card stretches open from the centre, name first then sub.
 *  · organisation      : FULLY mirrors the info strip (Jason #1) — the icon pops in at
 *    the centre alone, THEN the whole card stretches open (the icon glides to its left
 *    rest as the body reveals rightward), then the name, then the rest. */
function bbShow(bb) {
  const tok = ++bbTok;
  resetBb();
  bottombar.classList.remove('bb-hidden');
  bbSetContent(bb);          // content set while laid out, so bbFit can measure
  run(bottombar, 'bbfade', [{ opacity: 0 }, { opacity: 1 }],
    { duration: 240, easing: IN_SOFT, fill: 'backwards' });
  if (bb.kind === 'org') {
    // hold the card clipped shut until the logo has real dimensions (D + mask depend on it)
    bbCard.style.clipPath = 'inset(0 100% 0 0)';
    const go = () => { if (tok === bbTok) bbRevealOrg(tok); };
    if (bbImg.complete && bbImg.naturalWidth) go();
    else bbImg.addEventListener('load', go, { once: true });
    return;
  }
  run(bbCard, 'reveal', [{ clipPath: 'inset(0 50% 0 50%)' }, { clipPath: 'inset(0 0 0 0)' }],
    { duration: BB_REVEAL.dur, easing: BB_REVEAL.easing, fill: 'both' })
    .finished.then(() => { if (tok === bbTok) { cancelRun(bbCard, 'reveal'); bbCard.style.clipPath = ''; } }).catch(() => {});
  run(bbNameEl, 'bbfade', [
    { opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' },
  ], { duration: 340, delay: 240, easing: OUT_5, fill: 'backwards' });
  run(bbSubEl, 'bbfade', [
    { opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' },
  ], { duration: 320, delay: 370, easing: OUT_5, fill: 'backwards' });
}

/* org reveal, mirror of ibShow: the icon block is the "chip" on the LEFT */
function bbRevealOrg(tok) {
  bbSetOrgMask();
  const iconW = bbIconWrap.offsetWidth;
  const D = Math.max(0, bbCard.offsetWidth - iconW);
  // 1. icon pops in alone at the card centre (card shifted right by D/2 so it reads centred)
  run(bbIconWrap, 'pop', [
    { transform: 'scale(0.5)', opacity: 0 },
    { transform: 'scale(1)', opacity: 1 },
  ], { duration: BB_POP.dur, easing: BB_POP.easing, fill: 'backwards' });
  // 2. the body reveals rightward while the card re-centres (icon glides left to rest)
  const glide = { duration: BB_REVEAL.dur, delay: BB_ICON_DELAY, easing: BB_REVEAL.easing, fill: 'both' };
  run(bbCard, 'reveal', [{ clipPath: bbClipR(D) }, { clipPath: bbClipR(0) }], glide)
    .finished.then(() => { if (tok === bbTok) { cancelRun(bbCard, 'reveal'); bbCard.style.clipPath = ''; } }).catch(() => {});
  run(bbCard, 'shift', [{ transform: `translateX(${D / 2}px)` }, { transform: 'translateX(0px)' }], glide)
    .finished.then(() => { if (tok === bbTok) { cancelRun(bbCard, 'shift'); bbCard.style.transform = ''; } }).catch(() => {});
  // 3. name settles first, the rest after
  run(bbNameEl, 'bbfade', [
    { opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' },
  ], { duration: 340, delay: BB_ICON_DELAY + 150, easing: OUT_5, fill: 'both' });
  run(bbSubEl, 'bbfade', [
    { opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' },
  ], { duration: 320, delay: BB_ICON_DELAY + 280, easing: OUT_5, fill: 'both' });
}

function bbHide({ fast = false } = {}) {
  if (bottombar.classList.contains('bb-hidden')) return Promise.resolve();
  const tok = ++bbTok;
  return run(bottombar, 'bbfade', [{ opacity: 1 }, { opacity: 0 }],
    { duration: fast ? 180 : 260, easing: EXIT, fill: 'forwards' })
    .finished.then(() => {
      if (tok !== bbTok) return;
      bottombar.classList.add('bb-hidden');
      resetBb();
    }).catch(() => {});
}

/* an arriving full board waits for the card to fade before it reveals (先隱後顯) */
function withBottomClear(fn) {
  if (bottombar.classList.contains('bb-hidden')) { fn(); return; }
  updateBottomBanner();          // the gate is already true — start the fade this tick
  setTimeout(fn, BB_CLEAR_MS);
}

function updateBottomBanner({ instant = false } = {}) {
  if (!st) return;
  const bb = st.bottomBanner;
  const want = bb && !bbBlocked() ? bb : null;
  const wantId = want ? want.id : null;
  if (wantId === bbShownId) return;
  if (instant) {
    ++bbTok;
    bbSwapping = false;
    resetBb();
    bbShownId = wantId;
    if (want) { bottombar.classList.remove('bb-hidden'); bbSetContent(want); }
    else bottombar.classList.add('bb-hidden');
    return;
  }
  if (!want) {
    bbShownId = null;
    if (!bbSwapping) bbHide();
    return;
  }
  if (!bottombar.classList.contains('bb-hidden')) {
    // one at a time (like the info banner): fade the current out, then the new in
    bbShownId = wantId;
    if (!bbSwapping) {
      bbSwapping = true;
      bbHide({ fast: true }).then(() => {
        bbSwapping = false;
        const cur = st && st.bottomBanner;
        if (cur && cur.id === bbShownId && !bbBlocked()) bbShow(cur);
      });
    }
    return;
  }
  bbShownId = wantId;
  bbShow(want);
}

/* ===================================================== corner logos */
/* Top-right persistent logos (global display config, admin click order). A new logo
 * slides in from the right into the corner slot and the earlier ones shift left, so
 * reading order (left→right) = click order; exits mirror to the right, each tile
 * clipped by its own slot (no crossing). While the TEAM B / 全部 roster panel is
 * requested or still on stage the logos slide away and return once it is gone. */

const cornerEl = document.getElementById('cornerlogos');
const CORNER_OUT_MS = 340;
const CORNER_CLEAR_MS = 420;    // roster B enters as the logos' exit (incl. stagger) nears its end
const cornerSlots = new Map();  // file -> slot element


function cornerSuppressed() {
  if (!st) return false;
  if (ibEvictLogos) return true;   // info banner needs the full width (see ibPrepareLogos)
  return rosterWantVisible('B') || !rosterEls.B.root.classList.contains('is-hidden');
}
function cornerOnStage() {
  for (const n of cornerEl.children) { if (!n.dataset.exiting) return true; }
  return false;
}
function cornerWantList() {
  if (!st || cornerSuppressed()) return [];
  return (Array.isArray(st.cornerLogos) ? st.cornerLogos : []).slice(0, 3);
}

function cornerSlotEl(file) {
  const slot = el('div', 'cl-slot');
  slot.dataset.file = file;
  const tile = el('div', 'cl-tile');
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('error', () => { cornerSlots.delete(file); slot.remove(); });
  img.src = '/assets/corner/' + encodeURIComponent(file);
  tile.append(img);
  slot.append(tile);
  return slot;
}

/* logo enter: the existing logos shift to make room, then FLIP back to a clean ease-out
 * glide (transform only — never a width animation, so the neighbours can't reflow-bounce
 * when they settle). The new tile slides in from the right into its corner slot. */
function cornerEnter(slot, i, { instant = false } = {}) {
  const others = [...cornerEl.children].filter(n => n !== slot && !n.dataset.exiting);
  const first = others.map(n => n.getBoundingClientRect().left);
  cornerEl.append(slot);
  if (instant) { slot.style.width = ''; return; }
  slot.style.width = '0px';   // hold zero space until the image measures (no flash)
  const reveal = () => {
    if (!slot.isConnected || slot.dataset.exiting) return;
    slot.style.width = '';    // natural width -> the others jump to their final spots at once
    const k = stageScale || 1;
    others.forEach((n, j) => {
      if (!n.isConnected) return;
      const dx = (first[j] - n.getBoundingClientRect().left) / k;
      if (Math.abs(dx) < 0.5) return;
      run(n, 'x', [{ transform: `translateX(${dx}px)` }, { transform: 'none' }],
        { duration: 520, easing: OUT_5, fill: 'none' });
    });
    run(slot.firstChild, 'x', [
      { transform: `translateX(${slot.offsetWidth + 40}px)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: 560, easing: OUT_5, fill: 'backwards' });
  };
  const img = slot.querySelector('img');
  if (img && img.complete && img.naturalWidth) reveal();
  else if (img) img.addEventListener('load', reveal, { once: true });
  else reveal();
}

/* logo exit: lift the tile to a floating overlay (so its slide-out is independent of the
 * layout), drop the slot from flow at once, and FLIP the survivors into the gap with a
 * pure ease-out — no reflow-driven settle, so nothing bounces at the end (Jason). */
function cornerExit(slot) {
  if (slot.dataset.exiting) return;
  slot.dataset.exiting = '1';
  const survivors = [...cornerEl.children].filter(n => n !== slot && !n.dataset.exiting);
  const first = survivors.map(n => n.getBoundingClientRect().left);
  const k = stageScale || 1;
  const tile = slot.firstChild;
  const sr = stage.getBoundingClientRect();
  const tr = tile ? tile.getBoundingClientRect() : null;
  slot.remove();               // out of flow instantly -> survivors' final layout is immediate
  if (tile && tr) {
    tile.style.position = 'absolute';
    tile.style.left = ((tr.left - sr.left) / k) + 'px';
    tile.style.top = ((tr.top - sr.top) / k) + 'px';
    tile.style.zIndex = '6';
    tile.style.pointerEvents = 'none';
    stage.append(tile);
    run(tile, 'x', [
      { transform: 'none', opacity: 1 },
      { transform: `translateX(${tr.width / k + 30}px)`, opacity: 0 },
    ], { duration: CORNER_OUT_MS, easing: EXIT, fill: 'forwards' })
      .finished.then(() => tile.remove()).catch(() => tile.remove());
  }
  survivors.forEach((n, j) => {
    if (!n.isConnected) return;
    const dx = (first[j] - n.getBoundingClientRect().left) / k;
    if (Math.abs(dx) < 0.5) return;
    run(n, 'x', [{ transform: `translateX(${dx}px)` }, { transform: 'none' }],
      { duration: CORNER_OUT_MS, easing: OUT_5, fill: 'none' });
  });
}

function updateCornerLogos({ instant = false } = {}) {
  if (!st) return;
  const want = cornerWantList();
  const wantSet = new Set(want);
  let outIdx = 0;
  for (const [file, slot] of [...cornerSlots]) {
    if (wantSet.has(file)) continue;
    cornerSlots.delete(file);
    if (instant) slot.remove();
    else { cornerExit(slot); outIdx++; }
  }
  let inIdx = 0;
  for (const file of want) {
    if (cornerSlots.has(file)) continue;
    const slot = cornerSlotEl(file);
    cornerSlots.set(file, slot);
    cornerEnter(slot, inIdx++, { instant });
  }
  // same set, different order (e.g. a settings import) — reseat silently
  if (!inIdx && !outIdx) {
    const live = [];
    for (const n of cornerEl.children) { if (!n.dataset.exiting) live.push(n.dataset.file); }
    if (live.length === want.length && live.some((f, i) => f !== want[i])) {
      for (const file of want) { const s = cornerSlots.get(file); if (s) cornerEl.append(s); }
    }
  }
}

/* ========================================================== renderer */

function applyBoardVars(s) {
  // roster panels + bottom banner share --margin (unified edges), --drift-dur + ambient
  for (const root of [boardEl, fullEl, rosterEls.A.root, rosterEls.B.root, bottombar]) {
    root.style.setProperty('--margin', s.board.margin);
    root.style.setProperty('--scale', s.board.scale);
    root.style.setProperty('--drift-dur', (12 / (s.board.driftSpeed || 1)) + 's');
    root.classList.toggle('ambient', !!s.board.ambient);
  }
  // full board fills the stage width, so upscaling would spill off-screen.
  // Cap its effective scale so the on-screen width stays within 1920 - 2*margin
  // (and never wider than the 1920 stage when the margin is negative).
  const margin = Number(s.board.margin) || 0;
  const scale = Number(s.board.scale) || 1;
  const baseW = STAGE_W - 2 * margin;                 // #fullboard css width
  const capW = STAGE_W - 2 * Math.max(0, margin);     // allowed on-screen width
  const fitScale = baseW > 0 ? capW / baseW : 1;
  fullEl.style.setProperty('--full-scale', Math.min(scale, fitScale));
  // corner logos are branding — never let a negative margin crop them off-stage
  const cornerMargin = Math.max(12, Math.round(margin));
  cornerEl.style.top = cornerMargin + 'px';
  cornerEl.style.right = cornerMargin + 'px';
}

function renderAllView(v, s) {
  const clk = s.board.clockVisible !== false;
  toggleCell(v.cellEvent, s.event.visible, 'y', { instant: true });
  toggleCell(v.boxClock, clk, 'y', { instant: true });
  // period collapses vertically with the clock row, horizontally on its own
  toggleCell(v.boxPeriod, clk, 'y', { instant: true });
  toggleCell(v.boxPeriod, s.period.visible, 'x', { instant: true });
  swapWord(v.eventBox, s.event.text.toUpperCase(), { instant: true });
  fitEvent(v);
  swapWord(v.periodBox, s.period.text.toUpperCase(), { instant: true });
  for (const t of ['A', 'B']) {
    bump('gw-' + v.kind + t);           // cancel pending GOAL-word restores
    v.goalWordActive[t] = false;
    // clear any in-flight small<->large morph animation on this team
    cancelRun(v.teams[t].nameBox, 'flip');
    v.teams[t].nameBox.style.transformOrigin = '';
    v.teams[t].nameBox.style.transform = '';
    v.teams[t].nameBox.style.minWidth = '';
    setName(v, t, { instant: true });
    cancelRun(v.teams[t].score, 'sxf');
    cancelRun(v.teams[t].score, 'sbounce');
    v.teams[t].score.style.opacity = '';
    v.teams[t].score.style.transform = '';
    cancelRun(v.teams[t].bg, 'theme');
    v.teams[t].bg.style.opacity = '';
    v.teams[t].bg.style.clipPath = '';
    if (v.teams[t].bar) { cancelRun(v.teams[t].bar, 'theme'); v.teams[t].bar.style.opacity = ''; v.teams[t].bar.style.transform = ''; }
    v.scoreTapes[t].set(String(s.teams[t].score), { anim: false });
  }
  swapClockWordV(v, clockWordFor(s, v.kind), { instant: true });
  v.lastClockStr = '';
  v.reservedWord = null;
  v.clockTapesEl.style.minWidth = '';
  if (v === mainV) {
    bump('morph'); nameMorphTok++;
    cancelRun(boardEl, 'namew'); cancelRun(boardEl, 'morphw');
    boardEl.style.width = ''; boardEl.style.minWidth = ''; boardEl.style.maxWidth = '';
    cancelRun(v.grid, 'row-A'); cancelRun(v.grid, 'row-B');
    v.grid.style.removeProperty('--row-a'); v.grid.style.removeProperty('--row-b');
  }
}

function renderAll(s) {
  applyPalette('A', s.teams.A.color, { instant: true });
  applyPalette('B', s.teams.B.color, { instant: true });
  applyBoardVars(s);
  clearRowExpands();
  tierShown = effTier();
  mainMode = tierShown === 'small' ? 'small' : 'large';
  applyRowModes();            // per-row classes + grid tracks + width cap
  mainV.visible = tierShown === 'small' || tierShown === 'large';
  fullV.visible = tierShown === 'full';
  boardEl.classList.toggle('is-hidden', !mainV.visible);
  fullEl.classList.toggle('is-hidden', !fullV.visible);
  renderAllView(mainV, s);
  renderAllView(fullV, s);
  renderIcons(s.banners, { instant: true });
  renderInfoBanner(s.infoBanner, { instant: true });
  updateRosters({ instant: true });
  updateBottomBanner({ instant: true });
  updateCornerLogos({ instant: true });
}

function onSync({ state: s, fx }) {
  const p = st;
  st = s;
  if (firstPaint) {
    renderAll(s);
    firstPaint = false;
    return;
  }

  /* palettes */
  for (const t of ['A', 'B']) {
    if (p.teams[t].color !== s.teams[t].color) applyPalette(t, s.teams[t].color, {});
  }
  applyBoardVars(s);

  /* per-tier full-name / short-name switch */
  {
    const nmKey = (nm, key) =>
      (typeof nm === 'string' ? (nm === 'full' ? 'full' : 'short')
                              : ((nm && nm[key]) === 'full' ? 'full' : 'short'));
    const pnm = p.board.nameMode, snm = s.board.nameMode;
    const mainKeys = new Set([rowModeFor('A'), rowModeFor('B')]);   // whichever row modes are on screen
    let mainChanged = false;
    for (const key of mainKeys) if (nmKey(pnm, key) !== nmKey(snm, key)) mainChanged = true;
    if (mainChanged) swapMainNamesMorph();
    if (nmKey(pnm, 'full') !== nmKey(snm, 'full')) {
      for (const t of ['A', 'B']) if (!fullV.goalWordActive[t]) setName(fullV, t, { instant: !fullV.visible });
    }
  }

  /* tier (off / small / large / full + auto rules) */
  applyTier();

  /* clock area visibility */
  const clk = s.board.clockVisible !== false;
  if (p.board.clockVisible !== s.board.clockVisible) {
    for (const v of views) {
      toggleCell(v.boxClock, clk, 'y', { instant: !v.visible });
      toggleCell(v.boxPeriod, clk, 'y', { instant: !v.visible });
    }
  }

  /* optional cells */
  if (p.event.visible !== s.event.visible) {
    for (const v of views) toggleCell(v.cellEvent, s.event.visible, 'y', { instant: !v.visible });
  }
  if (p.period.visible !== s.period.visible) {
    for (const v of views) toggleCell(v.boxPeriod, s.period.visible, 'x', { instant: !v.visible || !clk });
  }

  /* texts */
  if (p.event.text !== s.event.text) {
    for (const v of views) { swapWord(v.eventBox, s.event.text.toUpperCase(), { instant: !v.visible }); fitEvent(v); }
  }
  if (p.period.text !== s.period.text) {
    for (const v of views) swapWord(v.periodBox, s.period.text.toUpperCase(), { instant: !v.visible });
  }
  for (const t of ['A', 'B']) {
    const nameChanged = p.teams[t].name !== s.teams[t].name || p.teams[t].short !== s.teams[t].short;
    if (!nameChanged) continue;
    for (const v of views) {
      if (!v.goalWordActive[t]) setName(v, t, { instant: !v.visible });
    }
  }

  /* scores (quiet corrections; goals handled via fx) — glide the board width if it changes */
  glideWidthAround(() => {
    for (const t of ['A', 'B']) {
      if (p.teams[t].score === s.teams[t].score) continue;
      if (fx && fx.kind === 'goal' && fx.team === t) continue;
      const dir = s.teams[t].score > p.teams[t].score ? 1 : -1;
      for (const v of views) v.scoreTapes[t].set(String(s.teams[t].score), { dir, anim: v.visible, pop: false });
    }
  });

  /* event icons */
  renderIcons(s.banners);

  /* info banner */
  renderInfoBanner(s.infoBanner);

  /* roster side panels (tier gating + paging + live edits) */
  updateRosters();

  /* one-shot fx */
  if (fx && fx.kind === 'goal') onGoalFx(fx.team, s.teams[fx.team].score, fx.delta == null ? 1 : fx.delta);
  if (fx && fx.kind === 'timeend') timeEndFx();
}

/* ========================================================== rAF loop */

function frame(now) {
  requestAnimationFrame(frame);
  stepParticles(now);
  if (!st) return;

  const rem = timerRemaining(st.timer);
  const dir = st.timer.direction === 'up' ? 'up' : 'down';
  const display = dir === 'up' ? Math.max(0, st.timer.durationMs - rem) : rem;
  const mode = st.timer.mode;
  const isAutoPause = mode === 'clock' && st.timer.autoPauseWord && !st.timer.running && rem > 0 && rem < st.timer.durationMs;
  const isPauseActive = mode === 'pause' || isAutoPause;
  for (const v of views) {
    const word = clockWordFor(st, v.kind);
    if (word !== v.shownWord) swapClockWordV(v, word, { instant: !v.visible });
    if (v === mainV) {
      const uw = mainClockWord(st);            // underlying word, ignores the alternate blink
      if (uw) {
        if (v.reservedWord !== uw) { v.reservedWord = uw; reserveClockWidth(v, uw); }
      } else if (v.reservedWord) {
        v.reservedWord = null;
        glideWidthAround(() => { v.clockTapesEl.style.minWidth = ''; });
      }
    }
    if (!word) {
      const str = clockString(display, dir, rem);
      if (str !== v.lastClockStr) {
        const staticCount = /\.\d\d$/.test(str) ? 2 : (str.includes('.') ? 1 : 0);
        const rollDir = dir === 'up' ? 1 : -1;
        const lenChanged = v === mainV && v.visible && v.lastClockStr && str.length !== v.lastClockStr.length;
        if (lenChanged) {
          boardEl.style.width = boardEl.offsetWidth + 'px';
        }
        v.clockTape.set(str, { dir: rollDir, anim: v.visible && v.lastClockStr !== '', staticLast: staticCount });
        v.lastClockStr = str;
        if (lenChanged) {
          const oldW = parseFloat(boardEl.style.width);
          requestAnimationFrame(() => {
            boardEl.style.width = '';
            const newW = boardEl.offsetWidth;
            boardEl.style.transition = 'none';
            boardEl.style.width = oldW + 'px';
            boardEl.offsetHeight;
            boardEl.style.transition = 'width 0.35s cubic-bezier(0.22, 1, 0.36, 1)';
            boardEl.style.width = newW + 'px';
            setTimeout(() => {
              boardEl.style.width = '';
              boardEl.style.transition = '';
            }, 400);
          });
        }
      }
    }
    if (mode === 'matchEnd') {
      v.boxClock.classList.toggle('urgent', false);
      v.boxClock.classList.toggle('critical', false);
      v.boxClock.classList.toggle('end-mode', true);
    } else if (mode === 'break' || isPauseActive) {
      v.boxClock.classList.toggle('urgent', false);
      v.boxClock.classList.toggle('critical', false);
      v.boxClock.classList.toggle('end-mode', false);
    } else {
      v.boxClock.classList.toggle('urgent', rem <= 60000 && rem > 10000 && st.timer.running);
      v.boxClock.classList.toggle('critical', rem <= 10000 && st.timer.running);
      v.boxClock.classList.toggle('end-mode', false);
    }
  }

  updateIconPhases();
  trackRails();
  trackInfoBar();
  updateBottomBanner();   // gates depend on classes that flip when animations END —
  updateCornerLogos();    // per-frame checks give exact hand-off timing (cheap no-ops otherwise)
}
requestAnimationFrame(frame);

/* =============================================================== boot */

connect({
  onSync,
  onStatus() { /* overlay stays silent about connection state */ },
});
