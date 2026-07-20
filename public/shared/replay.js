/*
 * replay.js — 回放共用模型：由對局事件日誌倒推任意時刻的畫面狀態。
 * overlay（畫面重建＋圓弧時間軸）與 admin（時間軸控制）共用。伺服器側
 * server.js 的 REPLAY 段有一份同規則的夾制實作 — 改動篩選規則時三處同步：
 *
 *   RELEVANT（重建＋時間軸範圍）= SCORE / ICON / INFO / RESET
 *   MARKER（時間軸標註＝拖動屏障）= 進球（SCORE kind:goal）＋橫幅顯示（INFO op:show）
 *
 * 語義：事件在 head > utc 時才算已發生（嚴格大於）。停在事件點上（head == utc，
 * 拖動夾制的停點）畫面仍是事件前的樣子；按下播放的瞬間立即套用。段內（相鄰兩個
 * 事件點之間）狀態恆定，所以拖動絕不會閃動比分。
 */

export const REPLAY_PAD_MS = 12000;   // 時間軸頭尾留白（與 server.js 一致）

function scoreAfter(d, cur) {
  if (Number.isFinite(Number(d.to))) return Math.max(0, Math.round(Number(d.to)));
  if (Number.isFinite(Number(d.delta))) return Math.max(0, cur + Math.round(Number(d.delta)));
  return cur;
}

/* log = 伺服器 replayLog（依 utc 排序；PHASE 條目只供 admin 對時，重建忽略）。
 * 回傳 { entries, marks, t0, t1, empty }：
 *   entries — RELEVANT 條目（重建輸入）
 *   marks   — 時間軸標註（依 utc 排序）：
 *             goal: { id, utc, clock, period, kind:'goal', team, a, b } — a:b 為進球後比分
 *                   （沿日誌重算，含 adjust / set / RESET 修正）
 *             info: { id, utc, clock, period, kind:'info', title, tone, fg, cat }
 */
export function buildReplayModel(log) {
  const entries = (Array.isArray(log) ? log : []).filter(e =>
    e && (e.type === 'SCORE' || e.type === 'ICON' || e.type === 'INFO' || e.type === 'RESET'));
  const marks = [];
  const sc = { A: 0, B: 0 };
  for (const e of entries) {
    const d = e.data || {};
    if (e.type === 'SCORE') {
      const team = d.team === 'B' ? 'B' : 'A';
      sc[team] = scoreAfter(d, sc[team]);
      if (d.kind === 'goal') {
        marks.push({
          id: e.id, utc: e.utc, clock: e.clock, period: e.period,
          kind: 'goal', team, a: sc.A, b: sc.B,
        });
      }
    } else if (e.type === 'RESET') {
      sc.A = 0; sc.B = 0;
    } else if (e.type === 'INFO' && d.op === 'show') {
      marks.push({
        id: e.id, utc: e.utc, clock: e.clock, period: e.period,
        kind: 'info', title: d.title || 'INFO',
        tone: d.tone || '#E0132F', fg: d.fg || '#FFFFFF',
        cat: d.cat === 'CONTROL' ? 'CONTROL' : 'REFEREE',
      });
    }
  }
  if (!entries.length) return { entries, marks, t0: 0, t1: 0, empty: true };
  return {
    entries, marks,
    t0: entries[0].utc - REPLAY_PAD_MS,
    t1: entries[entries.length - 1].utc + REPLAY_PAD_MS,
    empty: false,
  };
}

/* 播放頭在 h 時的畫面狀態（只倒推比分／事件圖標／資訊橫幅 — 計時不在此列）。
 * 圖標 hide 沒記 id — 以「最早掛出的同隊同型」匹配（FIFO）；banner id 加 rp 前綴
 * 避免與現場 id 撞名，overlay 的 diff 動畫按 id 進出。 */
export function reconstructAt(model, h) {
  const sc = { A: 0, B: 0 };
  let icons = [];
  let info = null;
  for (const e of model.entries) {
    if (!(e.utc < h)) break;               // 嚴格大於才算已發生
    const d = e.data || {};
    if (e.type === 'SCORE') {
      const team = d.team === 'B' ? 'B' : 'A';
      sc[team] = scoreAfter(d, sc[team]);
    } else if (e.type === 'ICON') {
      if (d.op === 'show') {
        icons.push({ id: 'rp' + e.id, team: d.team === 'B' ? 'B' : 'A', type: d.icon || 'FOUL', at: e.utc });
      } else if (d.op === 'hide') {
        const team = d.team === 'B' ? 'B' : 'A';
        const i = icons.findIndex(x => x.team === team && x.type === d.icon);
        if (i >= 0) icons.splice(i, 1);
      } else if (d.op === 'clear') {
        icons = [];
      }
    } else if (e.type === 'INFO') {
      if (d.op === 'show') {
        info = {
          id: 'rp' + e.id, key: d.key || '',
          cat: d.cat === 'CONTROL' ? 'CONTROL' : 'REFEREE',
          title: d.title || 'INFO', body: d.body || '',
          tone: d.tone || '#E0132F', fg: d.fg || '#FFFFFF',
          team: '', shownAt: e.utc,
        };
      } else {
        info = null;
      }
    } else if (e.type === 'RESET') {
      sc.A = 0; sc.B = 0; icons = []; info = null;
    }
  }
  return { scores: sc, banners: icons, infoBanner: info };
}

/* 已越過的事件點數（marks 依 utc 排序）— 播放時偵測「剛剛跨過哪些點」 */
export function appliedMarkCount(model, h) {
  let n = 0;
  for (const mk of model.marks) { if (mk.utc < h) n++; else break; }
  return n;
}

/* 目前播放頭（與 server.js replayHeadNow 同式；now 用 net.js 的 serverNow()） */
export function replayHead(r, now) {
  return r.playing ? r.headUtc + (now - r.refEpoch) : r.headUtc;
}

/* 拖動夾制（client 鏡像，樂觀 UI 用；伺服器仍會再夾一次）：
 * head 所在段 = (上一事件點+1ms, 下一事件點]，再夾進 [t0, t1] */
export function clampSeek(model, target, h0) {
  if (model.empty) return target;
  let lo = model.t0, hi = model.t1;
  for (const mk of model.marks) {
    if (mk.utc < h0) { if (mk.utc + 1 > lo) lo = mk.utc + 1; }
    else { if (mk.utc < hi) hi = mk.utc; break; }
  }
  return Math.min(hi, Math.max(Math.min(lo, hi), target));
}

/* 標註文案：goal → GOAL ＋「隊伍 幾比幾」；info → ! ＋ 判罰標題 */
export function markLabel(mk, teams) {
  if (mk.kind === 'goal') {
    const t = teams && teams[mk.team];
    const short = ((t && (t.short || t.name)) || mk.team).toUpperCase();
    return { head: 'GOAL', text: `${short} ${mk.a}:${mk.b}` };
  }
  return { head: '!', text: mk.title || 'INFO' };
}
