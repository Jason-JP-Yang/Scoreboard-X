/*
 * net.js — SSE subscription + action dispatch + server clock sync.
 * Every payload carries serverNow, so all pages agree on the timer within
 * a few milliseconds (localhost / LAN).
 */

let offset = 0;
let haveOffset = false;

export function serverNow() { return Date.now() + offset; }

function absorb(msgServerNow) {
  const o = msgServerNow - Date.now();
  // first sample wins outright, then follow smoothly (EMA) to avoid jumps
  offset = haveOffset ? offset + (o - offset) * 0.25 : o;
  haveOffset = true;
}

export function connect({ onSync, onStatus }) {
  const es = new EventSource('/api/events');
  es.onopen = () => onStatus && onStatus(true);
  es.onerror = () => onStatus && onStatus(false);
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (typeof msg.serverNow === 'number') absorb(msg.serverNow);
    onSync(msg);
  };
  return es;
}

export async function act(type, payload = {}) {
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    });
    const data = await res.json().catch(() => null);
    if (data && typeof data.serverNow === 'number') absorb(data.serverNow);
    return data;
  } catch {
    return null;
  }
}
