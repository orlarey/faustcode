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
import {
  SHARE_PARAMS,
  SHARE_VIEWS,
  SHARE_POLY,
  decodeShareParams,
  stripShareParams,
  setShareIntent,
} from './share-link.js';
import { tryHandOff, installHandoffResponder, probeTabs } from './tab-handoff.js';
import { installPlaygroundLink, isPlaygroundLink } from './playground-link.js';
import { showNotice } from './notice.js';
import { initFiles, codeSha1, getOpen, nameForSession } from './files.js';
import { openStoreFile, storeErrorText, startStores, stores } from './stores-ui.js';
import { storeLink, withoutStoreLink } from './vendor/fauststore/fauststore.js';
import { writeIfHandle, hasFileAccess } from './disk-files.js';
// Install the live mirror bus on window.__faustEditorBus before any
// editor (dsp view, floating overlay…) is created, so they auto-join.
import { bus as editorBus } from './editor-sync.js';

const WEBAPP_VERSION = '0.17.0';

// 1. Synchronously install the fetch shim BEFORE any view code runs.
installApiShim();

const bootParams = new URLSearchParams(location.search);

// libfaust-wasm loads in parallel — needed by the shim's /api/submit and
// by the run view's audio runtime. For a shared link it waits for the
// hand-off decision (a tab that hands its DSP off never needs it).
let faustPreloaded = false;
function preloadFaust() {
  if (faustPreloaded) return;
  faustPreloaded = true;
  appendLog('info', 'loading libfaust-wasm…');
  getFaust().then((f) => {
    appendLog('info', `libfaust-wasm ready : Faust ${f.version} (import=${f.timings.importMs}ms, instantiate=${f.timings.instantiateMs}ms)`);
  }).catch((err) => {
    appendLog('err', 'libfaust-wasm failed :', String(err));
  });
}

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
let mcpReady = false; // this tab holds the MCP bridge (tab-handoff status)

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
          mcpReady = true;
          appendLog('info', `handshake done — mcpVersion=${detail.mcpVersion} contractVersion=${detail.contractVersion}`);
          setStatus('ok', 'MCP connected');
          if (disconnectBtn) disconnectBtn.disabled = false;
          if (connectBtn) connectBtn.disabled = true;
          setLastMcpUrl(url);
          break;
        case 'close':
          mcpReady = false;
          appendLog('warn', 'WS closed', detail ? `(${detail})` : '');
          setStatus('idle', 'disconnected');
          if (disconnectBtn) disconnectBtn.disabled = true;
          if (connectBtn) connectBtn.disabled = false;
          break;
        case 'error':
          mcpReady = false;
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
          mcpReady = false;
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
  // Shared link (?code=…) : first try to hand the DSP to the faustcode tab
  // already open (tab-handoff.js), before loading anything. A tab that
  // handed it off, or that saw another tab answer, never auto-connects
  // to MCP : the bridge accepts one tab and would drop the one in use.
  let shared = null;
  let mcpAutoConnect = true;
  if (bootParams.has('code')) {
    try {
      shared = await decodeShareParams(bootParams);
    } catch (err) {
      setShareIntent({ error: 'This link does not contain readable Faust code.' });
      appendLog('warn', 'shared link ignored :', String(err && err.message ? err.message : err));
    }
    if (shared) {
      const handoff = await tryHandOff(shared);
      if (handoff.outcome !== 'none') mcpAutoConnect = false;
      if (handoff.outcome === 'handed') {
        appendLog('info', `shared link : ${shared.name} handed to tab ${handoff.target.tabId.slice(0, 8)}`);
        await showHandedOffPage(shared.name); // resolves on « Open here instead »
      } else if (handoff.outcome === 'failed') {
        appendLog('warn', `shared link : tab ${handoff.target.tabId.slice(0, 8)} did not confirm (${handoff.error}) — opening here`);
      }
    }
  }
  // Opened by faustmodular to edit its modules (playground-link.js) :
  // like a shared link, do not take the MCP bridge from a faustcode tab
  // already open.
  if (isPlaygroundLink(location.search) && (await probeTabs()).length > 0) mcpAutoConnect = false;
  if (SHARE_PARAMS.some((p) => bootParams.has(p))) {
    history.replaceState(history.state, '', stripShareParams(location.href));
  }
  preloadFaust();

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
    // The files on top of the sessions (spec_files_store.md) : files.json,
    // and the migration of the sessions kept before the files.
    await initFiles();
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
      if (s0) editorBus.loadSession(s0.code, sha0);
    }
  } catch (err) {
    appendLog('warn', 'OPFS hydration failed :', String(err));
  }

  initSetupMcp(
    () => (contract ? contract.contractVersion : '0.0.0'),
    () => (wsInput ? wsInput.value : ''),
  );

  // Shared-DSP link loaded in THIS tab (cf. share-link.js) : compile +
  // store the session BEFORE app.js boots, so the audio gate's ENTER
  // lands on it. Sessions are keyed by sha1 : opening the same link
  // twice reuses the existing session.
  if (shared) {
    try {
      const result = await submitShared(shared);
      if (result.errors && String(result.errors).trim()) {
        // Like a dropped file : a DSP that does not compile is not
        // stored as a session ; its errors are shown.
        setShareIntent({ error: `Shared DSP ${shared.name} does not compile :\n${result.errors}` });
        appendLog('warn', `shared link : ${shared.name} does not compile`);
      } else {
        setShareIntent({ sha1: result.sha1, view: shared.view, poly: shared.poly });
        appendLog('info', `shared link : ${shared.name} (${result.sha1.slice(0, 8)}) view=${shared.view} poly=${shared.poly}`);
      }
    } catch (err) {
      setShareIntent({ error: 'This link does not contain readable Faust code.' });
      appendLog('warn', 'shared link ignored :', String(err && err.message ? err.message : err));
    }
  }

  // A link to a file of GitHub (spec_files_store.md, « Les liens ») :
  // ?file=<its address on GitHub> or ?store=<owner>/<repo>&file=<path>[&ref=…]
  // opens it as a file (linked to the store when the repository is one) ;
  // ?store=<owner>/<repo> alone follows the store and shows its modules. The
  // link leaves the address (mcp and token kept).
  const fileLink = storeLink(location.search, 'file');
  let storeToShow = null;
  if (fileLink) {
    startStores();
    const view = SHARE_VIEWS.includes(bootParams.get('view')) ? bootParams.get('view') : 'run';
    const poly = SHARE_POLY.includes(Number(bootParams.get('poly'))) ? Number(bootParams.get('poly')) : 0;
    const clean = new URL(withoutStoreLink(location.href, 'file'), location.href);
    clean.searchParams.delete('view');
    clean.searchParams.delete('poly');
    history.replaceState(history.state, '', clean.pathname + clean.search + clean.hash);
    if (fileLink.scene) {
      preloadFaust();
      try {
        const result = await openStoreFile({ store: fileLink.store, path: fileLink.scene });
        if (result.errors && String(result.errors).trim()) {
          setShareIntent({ error: `${result.name} does not compile :\n${result.errors}` });
        } else {
          setShareIntent({ sha1: result.sha1, view, poly });
          appendLog('info', `file link : ${fileLink.store} ${fileLink.scene} (${result.sha1.slice(0, 8)})`);
        }
      } catch (err) {
        setShareIntent({ error: `${fileLink.scene} : ${err && err.reason ? storeErrorText(err) : String(err && err.message ? err.message : err)}` });
        appendLog('warn', 'file link ignored :', String(err && err.message ? err.message : err));
      }
    } else {
      storeToShow = fileLink.store;
      stores.follow(fileLink.store).catch((err) => {
        storeToShow = null;
        setShareIntent({ error: `${fileLink.store} : ${storeErrorText(err)}` });
      });
    }
  }

  // Load the original app.js (symlinked to ../public/app.js). The ?v=
  // cache buster forces Chrome to bypass its module map, which would
  // otherwise keep a stale module entry across reloads.
  const appModule = await import(`./app.js?v=${Date.now()}`);
  if (storeToShow && appModule.showStoreAfterGate) appModule.showStoreAfterGate(storeToShow.replace(/@HEAD$/, ''));

  // Floating editor : intercept the header pencil icon, drive it via
  // a /api/submit + /api/state round-trip, and keep the buffer in sync
  // with the active session.
  floatingEditor.setOnSubmit(async (code, filename) => {
    // a save of the open file : a new version of it, its file of the disk written
    const open = getOpen();
    if (open && hasFileAccess()) {
      try {
        const written = await writeIfHandle(open.file.id, code);
        if (written) showNotice(`Saved to ${written}`, 2500);
      } catch (err) {
        showNotice(`Not written to the disk : ${err && err.message ? err.message : err}`, 8000);
      }
    }
    const r = await fetch('/api/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, filename: open ? open.file.name : filename, fileId: open ? open.file.id : null }),
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok || !result || typeof result.sha1 !== 'string') {
      throw new Error(result.error || 'submit failed');
    }
    if (result.errors && String(result.errors).trim()) {
      // Not stored : show why, and keep the text unsaved (draft kept).
      const banner = document.getElementById('error-banner');
      if (banner) {
        banner.textContent = result.errors;
        banner.classList.remove('hidden');
      }
      throw new Error('compilation failed');
    }
    document.dispatchEvent(new CustomEvent('faustcode:code-ok')); // clears a stale error
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
    if (sess) floatingEditor.loadSession({ sha1: sess.sha1, code: sess.code, filename: nameForSession(sess.sha1) });
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
      editorBus.loadSession(s ? s.code : '', sha);
      if (s) floatingEditor.loadSession({ sha1: s.sha1, code: s.code, filename: nameForSession(s.sha1) });
    }
  }, 500);

  // Become a hand-off target for the shared links opened later.
  installHandoffResponder({
    getStatus: () => ({ audioUnlocked: isAudioUnlocked(), mcpConnected: mcpReady }),
    onOpen: openSharedFromOtherTab,
  });

  // Editor of faustmodular modules (?link=modular) : the module's
  // code becomes a session, shown in the dsp view ; each successful save
  // of it is sent back to the playground.
  installPlaygroundLink({
    submit: async (code, filename) => {
      const sub = await dispatch({ id: `playground-submit-${Date.now()}`, op: 'submit', args: { code, filename } });
      if (!sub.ok) throw new Error(sub.error.message);
      return sub.result;
    },
    show: async (sha1) => {
      if (!isAudioUnlocked()) {
        // the audio gate's ENTER lands on it
        setShareIntent({ sha1, view: 'dsp', poly: 0 });
      } else {
        await dispatch({ id: `playground-view-${Date.now()}`, op: 'set_view', args: { view: 'dsp' } });
      }
    },
    notify: showNotice,
    log: appendLog,
    libfaust: async () => (await getFaust()).version,
  });

  const params = new URLSearchParams(location.search);
  if (mcpAutoConnect && (params.get('mcp') || getLastMcpUrl())) startConnect();
  else if (!mcpAutoConnect) appendLog('info', 'MCP auto-connect skipped : another faustcode tab is open (use Connect to take the bridge)');
})();

async function submitShared({ code, name }) {
  const r = await fetch('/api/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, filename: name }),
  });
  const result = await r.json().catch(() => ({}));
  if (!r.ok || typeof result.sha1 !== 'string') throw new Error(result.error || 'submit failed');
  return result;
}

function isAudioUnlocked() {
  const gate = document.getElementById('audio-gate');
  return !!gate && gate.classList.contains('hidden');
}

/**
 * A new tab handed us a shared DSP. Acknowledge as soon as the sha1 is
 * known (the new tab waits 2 s at most), then compile and show it the
 * same way an MCP client would : submit → set_view → set_polyphony.
 * While the audio gate is still up, ENTER will land on it instead.
 */
async function openSharedFromOtherTab(shared) {
  // the sha1 submit will give it (normalized source)
  const sha1 = await codeSha1(shared.code);
  void (async () => {
    const call = (op, args) => dispatch({ id: `handoff-${op}-${Date.now()}`, op, args });
    const sub = await call('submit', { code: shared.code, filename: shared.name });
    if (!sub.ok || (sub.result.errors && String(sub.result.errors).trim())) {
      const why = sub.ok ? sub.result.errors : sub.error.message;
      appendLog('warn', `shared link from another tab : ${shared.name} does not compile`);
      showNotice(`Shared link ${shared.name} does not compile : ${String(why).split('\n')[0]}`, 10000);
      return;
    }
    appendLog('info', `shared link from another tab : ${shared.name} (${sha1.slice(0, 8)})`);
    if (!isAudioUnlocked()) {
      setShareIntent({ sha1, view: shared.view, poly: shared.poly });
    } else {
      await call('set_view', { view: shared.view });
      if (shared.view === 'run') await call('set_polyphony', { voices: shared.poly });
    }
    showNotice(`Opened from a shared link: ${shared.name}`);
    try { window.focus(); } catch { /* ignore */ }
  })();
  return sha1;
}

/**
 * The tab that handed its DSP off : a plain page, then try to close it
 * (allowed for a script-less-history tab opened by a link). Resolves when
 * the user asks to open the DSP here instead.
 */
function showHandedOffPage(name) {
  return new Promise((resolve) => {
    const page = document.createElement('div');
    page.className = 'handoff-page';
    page.innerHTML = `
      <div class="handoff-card">
        <p class="handoff-title">Opened in your faustcode tab</p>
        <p class="handoff-name"></p>
        <button type="button" class="primary-btn handoff-here">Open here instead</button>
      </div>`;
    page.querySelector('.handoff-name').textContent = name;
    page.querySelector('.handoff-here').addEventListener('click', () => {
      page.remove();
      resolve();
    });
    document.body.appendChild(page);
    setTimeout(() => { try { window.close(); } catch { /* ignore */ } }, 400);
  });
}
