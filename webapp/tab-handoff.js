// tab-handoff.js — open shared links (?code=…) in the faustcode tab that
// is already open instead of a new one (spec_reuse_tab.md).
//
// Tabs of the same origin talk over BroadcastChannel('faustcode') :
//   probe  (new tab)        { requestId }
//   here   (existing tabs)  { requestId, tabId, audioUnlocked, mcpConnected, lastActiveAt }
//   open   (new tab)        { requestId, to, code, name, view, poly }
//   opened (chosen tab)     { requestId, ok, sha1 | error }
//
// chooseTarget() is pure (unit-tested with node --test) ; the rest needs
// a browser.

export const CHANNEL_NAME = 'faustcode';
export const PROBE_TIMEOUT_MS = 300;
export const OPEN_TIMEOUT_MS = 2000;

export const tabId = randomId();
let lastActiveAt = Date.now();
let channel = null;

function randomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function getChannel() {
  if (channel) return channel;
  if (typeof BroadcastChannel !== 'function') return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/**
 * Pick the tab that receives the DSP : the one holding the MCP bridge,
 * else the most recently active among those with audio unlocked, else
 * the most recently active.
 * @param {Array<{tabId, audioUnlocked, mcpConnected, lastActiveAt}>} replies
 */
export function chooseTarget(replies) {
  if (!Array.isArray(replies) || replies.length === 0) return null;
  const recent = (list) => list.reduce((a, b) => ((b.lastActiveAt || 0) > (a.lastActiveAt || 0) ? b : a));
  const mcp = replies.filter((r) => r.mcpConnected);
  if (mcp.length) return recent(mcp);
  const unlocked = replies.filter((r) => r.audioUnlocked);
  if (unlocked.length) return recent(unlocked);
  return recent(replies);
}

/**
 * New tab : ask the open faustcode tabs to take the DSP.
 * @returns {Promise<{ outcome: 'none' | 'handed' | 'failed', target?, sha1?, error? }>}
 *   none   : no other tab answered → load here, normal MCP behaviour
 *   handed : another tab opened it
 *   failed : a tab answered but did not confirm in time → load here, no MCP auto-connect
 */
export async function tryHandOff(shared) {
  const ch = getChannel();
  if (!ch) return { outcome: 'none' };
  const requestId = randomId();
  const replies = [];
  const onProbeReply = (e) => {
    const m = e.data || {};
    if (m.type === 'here' && m.requestId === requestId && m.tabId !== tabId) replies.push(m);
  };
  ch.addEventListener('message', onProbeReply);
  ch.postMessage({ type: 'probe', requestId });
  await sleep(PROBE_TIMEOUT_MS);
  ch.removeEventListener('message', onProbeReply);

  const target = chooseTarget(replies);
  if (!target) return { outcome: 'none' };

  const ack = await new Promise((resolve) => {
    const timer = setTimeout(() => { ch.removeEventListener('message', onAck); resolve(null); }, OPEN_TIMEOUT_MS);
    function onAck(e) {
      const m = e.data || {};
      if (m.type !== 'opened' || m.requestId !== requestId) return;
      clearTimeout(timer);
      ch.removeEventListener('message', onAck);
      resolve(m);
    }
    ch.addEventListener('message', onAck);
    ch.postMessage({
      type: 'open',
      requestId,
      to: target.tabId,
      code: shared.code,
      name: shared.name,
      view: shared.view,
      poly: shared.poly,
    });
  });
  if (ack && ack.ok) return { outcome: 'handed', target, sha1: ack.sha1 };
  return { outcome: 'failed', target, error: ack ? ack.error : 'timeout' };
}

/**
 * Existing tab : answer probes and take `open` requests addressed to it.
 * @param {{ getStatus: () => {audioUnlocked, mcpConnected}, onOpen: (shared) => Promise<string> }} hooks
 *   onOpen resolves with the session sha1, or throws.
 */
export function installHandoffResponder({ getStatus, onOpen }) {
  const ch = getChannel();
  if (!ch) return;
  const touch = () => { lastActiveAt = Date.now(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') touch(); });
  window.addEventListener('focus', touch);
  ch.addEventListener('message', async (e) => {
    const m = e.data || {};
    if (m.type === 'probe') {
      const status = getStatus();
      ch.postMessage({
        type: 'here',
        requestId: m.requestId,
        tabId,
        audioUnlocked: !!status.audioUnlocked,
        mcpConnected: !!status.mcpConnected,
        lastActiveAt,
      });
    } else if (m.type === 'open' && m.to === tabId) {
      try {
        const sha1 = await onOpen({ code: m.code, name: m.name, view: m.view, poly: m.poly });
        ch.postMessage({ type: 'opened', requestId: m.requestId, ok: true, sha1 });
      } catch (err) {
        ch.postMessage({ type: 'opened', requestId: m.requestId, ok: false, error: String(err && err.message ? err.message : err) });
      }
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
