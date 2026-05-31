// boot.js — entry point for the faustcode webapp.
//
// 1. Installs the /api/* fetch shim so the original public/views/* and
//    public/app.js can run unchanged — they think they're talking to the
//    Docker backend but the shim re-routes everything to the OPFS
//    session cache + libfaust-wasm compile pipeline.
//
// 2. Hydrates the in-memory session cache from OPFS before importing
//    public/app.js (which calls /api/sessions on startup).
//
// 3. Imports public/app.js (via the symlink webapp/app.js) — its
//    top-level init() then drives the rest of the UI.
//
// 4. Wires the MCP addon : a single MCP pill in the header
//    whose colour reflects the WebSocket state, and a right-side
//    drawer (opened by clicking the pill) that holds Connect /
//    Disconnect, WS URL override, Setup steps and the Activity log.

import { installApiShim } from './api-shim.js';
import {
  initSessions,
  getLastMcpUrl,
  setLastMcpUrl,
  getSession,
  getActiveSha1,
} from './sessions.js';
import { loadContract } from './contract.js';
import { connectMcp, disconnect } from './ws-client.js';
import { dispatch } from './handlers.js';
import { getFaust } from './faust.js';
import { initSetupMcp } from './setup-mcp.js';
import * as floatingEditor from './floating-editor.js';
// Install the live mirror bus on window.__faustEditorBus before any
// editor (dsp view, floating overlay…) is created, so they auto-join.
import { bus as editorBus } from './editor-sync.js';

const WEBAPP_VERSION = '0.6.0';

// 1. Synchronously install the fetch shim BEFORE any view code runs.
installApiShim();

// ---------------------------------------------------------------------
// MCP pill + drawer + activity log
// ---------------------------------------------------------------------

const pillEl       = document.getElementById('mcp-pill');
const pillDot      = pillEl ? pillEl.querySelector('.mcp-pill-dot') : null;
const drawerEl     = document.getElementById('mcp-drawer');
const drawerBackdr = document.getElementById('mcp-drawer-backdrop');
const drawerClose  = document.getElementById('mcp-drawer-close');
const drawerStateDot = document.getElementById('mcp-drawer-state-dot');
const drawerStateText = document.getElementById('mcp-drawer-state-text');
const connectBtn   = document.getElementById('mcp-connect');
const disconnectBtn = document.getElementById('mcp-disconnect');
const wsInput      = document.getElementById('ws-url');
const logEl        = document.getElementById('mcp-log');

const STATE_CLASSES = ['is-idle', 'is-connecting', 'is-ok', 'is-error'];

function setStatus(kind, label) {
  // kind ∈ { idle, connecting, ok, error }
  const cls = `is-${kind}`;
  if (pillEl) {
    pillEl.classList.remove(...STATE_CLASSES);
    pillEl.classList.add(cls);
    pillEl.title = `MCP : ${label}`;
  }
  if (drawerStateDot) {
    drawerStateDot.classList.remove(...STATE_CLASSES);
    drawerStateDot.classList.add(cls);
  }
  if (drawerStateText) drawerStateText.textContent = label;
}

// Trigger one short bright-green flash on the dot. Only effective when
// the pill is in the .is-ok state ; the CSS rule scopes the animation
// to that combination.
let flashTimer = null;
function flashPill() {
  if (!pillEl) return;
  pillEl.classList.remove('flash');
  // Force reflow so re-adding the class restarts the animation when two
  // requests fire in quick succession.
  // eslint-disable-next-line no-unused-expressions
  pillEl.offsetWidth;
  pillEl.classList.add('flash');
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    pillEl.classList.remove('flash');
    flashTimer = null;
  }, 240);
}

function appendLog(kind, ...parts) {
  if (!logEl) return;
  const row = document.createElement('div');
  row.className = `log-row ${kind}`;
  const ts = new Date().toISOString().slice(11, 23);
  row.innerHTML = `<span class="ts">${ts}</span>`;
  row.append(parts.join(' '));
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

function openDrawer() {
  if (!drawerEl) return;
  drawerEl.classList.remove('hidden');
  drawerEl.setAttribute('aria-hidden', 'false');
  if (drawerBackdr) drawerBackdr.classList.remove('hidden');
}
function closeDrawer() {
  if (!drawerEl) return;
  drawerEl.classList.add('hidden');
  drawerEl.setAttribute('aria-hidden', 'true');
  if (drawerBackdr) drawerBackdr.classList.add('hidden');
}
function toggleDrawer() {
  if (!drawerEl) return;
  if (drawerEl.classList.contains('hidden')) openDrawer();
  else closeDrawer();
}

if (pillEl)       pillEl.addEventListener('click', toggleDrawer);
if (drawerClose)  drawerClose.addEventListener('click', closeDrawer);
if (drawerBackdr) drawerBackdr.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && drawerEl && !drawerEl.classList.contains('hidden')) {
    closeDrawer();
  }
});

setStatus('idle', 'idle');

// ---------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------

let contract = null;

function startConnect() {
  if (!contract) {
    appendLog('warn', 'contract not loaded yet — try again in a moment');
    return;
  }
  const url = (wsInput && wsInput.value || '').trim();
  if (!url) {
    appendLog('warn', 'no MCP WS URL provided');
    return;
  }
  setStatus('connecting', 'connecting…');
  if (connectBtn) connectBtn.disabled = true;
  const params = new URLSearchParams(location.search);
  const tokenFromQuery = params.get('token') || '';
  connectMcp({
    url,
    token: tokenFromQuery,
    webappVersion: WEBAPP_VERSION,
    contractVersion: contract.contractVersion,
    onStateChange: (state, detail) => {
      switch (state) {
        case 'open':
          appendLog('info', 'WS open :', url);
          setStatus('connecting', 'handshaking…');
          break;
        case 'ready':
          appendLog('info', `handshake done — mcpVersion=${detail.mcpVersion} contractVersion=${detail.contractVersion}`);
          setStatus('ok', 'MCP connected');
          if (disconnectBtn) disconnectBtn.disabled = false;
          if (connectBtn) connectBtn.disabled = true;
          setLastMcpUrl(url);
          break;
        case 'close':
          appendLog('warn', 'WS closed', detail ? `(${detail})` : '');
          setStatus('idle', 'disconnected');
          if (disconnectBtn) disconnectBtn.disabled = true;
          if (connectBtn) connectBtn.disabled = false;
          break;
        case 'error':
          appendLog('err', 'WS error :', String(detail));
          setStatus('error', 'error');
          if (disconnectBtn) disconnectBtn.disabled = true;
          if (connectBtn) connectBtn.disabled = false;
          break;
        case 'reconnecting':
          appendLog('info', `reconnecting in ${detail.delay}ms (attempt ${detail.attempt})`);
          setStatus('connecting', `reconnecting in ${(detail.delay / 1000).toFixed(1)}s…`);
          if (connectBtn) connectBtn.disabled = false;
          break;
        case 'superseded':
          // Another faustcode tab took the MCP bridge from us. The
          // ws-client has stopped its retry loop ; we surface a
          // distinct state so the user knows what happened.
          appendLog('warn', 'another tab took over the MCP bridge — this tab will stay disconnected');
          setStatus('error', 'another tab is using MCP');
          if (disconnectBtn) disconnectBtn.disabled = true;
          if (connectBtn) connectBtn.disabled = false;
          break;
      }
    },
    onReq: async (req) => {
      appendLog('req', `← req id=${req.id} op=${req.op} args=${JSON.stringify(req.args || {})}`);
      flashPill();
      const outcome = await dispatch(req);
      if (outcome.ok) {
        const preview = JSON.stringify(outcome.result || {}).slice(0, 200);
        appendLog('resp', `→ ok id=${req.id} op=${req.op} result=${preview}`);
      } else {
        appendLog('warn', `→ err id=${req.id} op=${req.op} code=${outcome.error.code} msg=${outcome.error.message}`);
      }
      flashPill();
      return outcome;
    },
  });
}

if (connectBtn)    connectBtn.addEventListener('click', startConnect);
if (disconnectBtn) disconnectBtn.addEventListener('click', () => disconnect());

// ---------------------------------------------------------------------
// Boot sequence : contract → OPFS → load original public/app.js.
// ---------------------------------------------------------------------

(async () => {
  if (wsInput) {
    const params = new URLSearchParams(location.search);
    const urlFromQuery = params.get('mcp');
    wsInput.value = urlFromQuery || 'ws://localhost:7777/ws';
  }

  try {
    contract = await loadContract();
    appendLog('info', `contract loaded : contractVersion=${contract.contractVersion} (${contract.tools.length} tools)`);
  } catch (err) {
    setStatus('error', 'contract failed');
    appendLog('err', 'failed to load contract :', String(err));
  }

  try {
    const count = await initSessions();
    appendLog('info', `OPFS sessions hydrated : ${count} session${count === 1 ? '' : 's'}`);
    if (!new URLSearchParams(location.search).get('mcp')) {
      const saved = getLastMcpUrl();
      if (saved && wsInput) wsInput.value = saved;
    }
    // Seed the editor sync bus with the currently-active session's
    // code BEFORE app.js runs : the first view that gets rendered
    // (typically DSP view) will create its editor with this pristine,
    // avoiding a brief "dirty against empty pristine" glitch.
    const sha0 = getActiveSha1();
    if (sha0) {
      const s0 = getSession(sha0);
      if (s0) editorBus.loadSession(s0.code);
    }
  } catch (err) {
    appendLog('warn', 'OPFS hydration failed :', String(err));
  }

  initSetupMcp(
    () => (contract ? contract.contractVersion : '0.0.0'),
    () => (wsInput ? wsInput.value : ''),
  );

  // Load the original app.js (symlinked to ../public/app.js). The ?v=
  // cache buster forces Chrome to bypass its module map, which would
  // otherwise keep a stale module entry across reloads.
  await import(`./app.js?v=${Date.now()}`);

  // Floating editor : intercept the header pencil icon, drive it via
  // a /api/submit + /api/state round-trip, and keep the buffer in sync
  // with the active session.
  floatingEditor.setOnSubmit(async (code, filename) => {
    const r = await fetch('/api/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, filename }),
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok || !result || typeof result.sha1 !== 'string') {
      throw new Error(result.error || 'submit failed');
    }
    // Activate the new session so the view under the floating editor
    // (Run / SVG / signals…) refreshes with the freshly-compiled DSP.
    await fetch('/api/state', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha1: result.sha1 }),
    });
  });

  document.addEventListener('faustcode:edit-request', (ev) => {
    ev.preventDefault();
    const sha = (ev.detail && ev.detail.sha1) || getActiveSha1();
    const sess = sha ? getSession(sha) : null;
    if (sess) floatingEditor.loadSession({ sha1: sess.sha1, code: sess.code, filename: sess.filename });
    floatingEditor.toggle();
  });

  // When the active session changes externally (MCP, navigation, submit
  // via the dsp view…), broadcast the new code through the bus : every
  // registered editor (dsp view, floating overlay) replaces its buffer
  // and goes clean. The floating overlay's title bar filename label is
  // updated separately since it lives outside the editor.
  let lastShaForSync = getActiveSha1();
  setInterval(() => {
    const sha = getActiveSha1();
    if (sha !== lastShaForSync) {
      lastShaForSync = sha;
      const s = sha ? getSession(sha) : null;
      editorBus.loadSession(s ? s.code : '');
      if (s) floatingEditor.loadSession({ sha1: s.sha1, code: s.code, filename: s.filename });
    }
  }, 500);

  const params = new URLSearchParams(location.search);
  if (params.get('mcp') || getLastMcpUrl()) startConnect();
})();

// libfaust-wasm loads in parallel — needed by the shim's /api/submit and
// by the run view's audio runtime.
appendLog('info', 'loading libfaust-wasm…');
getFaust().then((f) => {
  appendLog('info', `libfaust-wasm ready : Faust ${f.version} (import=${f.timings.importMs}ms, instantiate=${f.timings.instantiateMs}ms)`);
}).catch((err) => {
  appendLog('err', 'libfaust-wasm failed :', String(err));
});
