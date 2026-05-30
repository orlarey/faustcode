// sessions.js — in-memory cache of submitted sessions, hydrated from
// OPFS at boot and write-through on every mutation.
//
// A session is identified by sha1(code). Static sessions are immutable
// (cf. INV-3 in SPECIFICATION.md). Live sessions are out of scope.
//
// The cache is the source of truth for reads ; OPFS is the source of
// truth for persistence. Writes happen :
//   - storeSession()  → cache then opfs.writeSession() (awaited)
//   - deleteSession() → cache then opfs.deleteSessionOnDisk() (awaited)
//   - touchSession()  → cache then opfs.touchSessionOnDisk() (fire-and-forget)
//
// At boot, app.js must await initSessions() before any handler is
// invoked, otherwise list_sessions / get_session would lie.

import * as opfs from './opfs-store.js';

const STORE = new Map();   // sha1 → SessionEntry

/**
 * @typedef {object} SessionEntry
 * @property {string} sha1
 * @property {string} filename
 * @property {string} code
 * @property {string} errors
 * @property {Record<string,string>|null} svg
 * @property {string|null} signalsDot
 * @property {string|null} tasksDot
 * @property {number} createdAt
 * @property {number} lastUsedAt
 * @property {number} [usageScore]
 * @property {string} [cppFlags]
 */

let _initPromise = null;
let _initDone = false;

/**
 * Hydrate the in-memory cache from OPFS. Safe to call multiple times :
 * the first call kicks off the load, subsequent calls receive the same
 * Promise.
 *
 * In addition to sessions, this also restores the user's preferences
 * (active sha1, active view, last MCP URL) when they exist in
 * preferences.json — so a refresh / restart picks up where the previous
 * session left off.
 */
export function initSessions() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const entries = await opfs.loadAllSessions();
      for (const e of entries) STORE.set(e.sha1, e);

      // Restore the preferences blob (if it exists). It is loaded AFTER
      // sessions so we can validate that the saved active sha1 still
      // exists on disk before promoting it.
      const prefs = await opfs.readPreferences();
      if (prefs) {
        if (prefs.activeSha1 && STORE.has(prefs.activeSha1)) {
          _activeSha1 = prefs.activeSha1;
        }
        if (typeof prefs.activeView === 'string' && VALID_VIEWS.has(prefs.activeView)) {
          _activeView = prefs.activeView;
        }
        if (typeof prefs.lastMcpUrl === 'string') {
          _lastMcpUrl = prefs.lastMcpUrl;
        }
        if (typeof prefs.sessionOrder === 'string' && VALID_ORDERS.has(prefs.sessionOrder)) {
          _sessionOrder = prefs.sessionOrder;
        }
      }

      _initDone = true;
      return entries.length;
    } catch (err) {
      console.warn('[sessions] OPFS init failed, continuing in-memory only :', err);
      _initDone = true;
      throw err;
    }
  })();
  return _initPromise;
}

export function isInitDone() {
  return _initDone;
}

// ---------------------------------------------------------------------
// Reads (synchronous, against the in-memory cache)
// ---------------------------------------------------------------------

export function getSession(sha1) {
  return STORE.get(sha1) || null;
}

export function hasSession(sha1) {
  return STORE.has(sha1);
}

export function listSessions() {
  // Sorted by creation order, oldest first (matches mcp.mjs list_sessions).
  return [...STORE.values()].sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------
// Writes (cache first, then OPFS)
// ---------------------------------------------------------------------

/**
 * storeSession is async because OPFS is async. Callers (handlers) MUST
 * await it so that a follow-up list_sessions sees the entry.
 */
export async function storeSession(entry) {
  STORE.set(entry.sha1, entry);
  try {
    await opfs.writeSession(entry);
  } catch (err) {
    console.warn('[sessions] OPFS writeSession failed for', entry.sha1, err);
    // Cache is still updated — we keep going.
  }
}

export async function deleteSession(sha1) {
  const had = STORE.delete(sha1);
  try {
    await opfs.deleteSessionOnDisk(sha1);
  } catch (err) {
    console.warn('[sessions] OPFS deleteSession failed for', sha1, err);
  }
  return had;
}

// Debounce window per sha1 — matches the Docker faustforge behaviour
// where two touch events within 700 ms count as one usage.
const _lastTouchAt = new Map();
const TOUCH_DEBOUNCE_MS = 700;

/**
 * touchSession is fire-and-forget : we update lastUsedAt, bump the
 * cumulative usageScore by `weight`, and schedule the OPFS rewrite
 * without awaiting it. Called on every set_session / set_active_view as
 * well as on engaged-time ticks from app.js (POST /api/{sha}/use).
 *
 * The cumulative-score semantics match the Docker faustforge :
 *   score += max(0, weight) ; default weight = 1.
 */
export function touchSession(sha1, weight = 1) {
  const e = STORE.get(sha1);
  if (!e) return;
  const now = Date.now();
  const last = _lastTouchAt.get(sha1) || 0;
  if (now - last < TOUCH_DEBOUNCE_MS) return;
  _lastTouchAt.set(sha1, now);
  e.lastUsedAt = now;
  const w = Math.max(0, Number(weight) || 0);
  e.usageScore = (Number(e.usageScore) || 0) + w;
  opfs.touchSessionOnDisk(sha1, e.lastUsedAt, e.usageScore).catch((err) => {
    console.warn('[sessions] OPFS touchSession failed for', sha1, err);
  });
}

// ---------------------------------------------------------------------
// Active session / view / last MCP URL — persisted in preferences.json
// at the OPFS root via a debounced write-back.
// ---------------------------------------------------------------------

let _activeSha1 = null;
let _activeView = 'dsp';
let _lastMcpUrl = '';
let _sessionOrder = 'chronological';
const VALID_VIEWS = new Set(['dsp', 'svg', 'run', 'signals', 'tasks']);
const VALID_ORDERS = new Set(['chronological', 'usage']);

export function getActiveSha1() {
  return _activeSha1;
}

export function setActiveSha1(sha1) {
  _activeSha1 = sha1;
  if (sha1) touchSession(sha1);
  schedulePrefsSave();
}

export function getActiveView() {
  return _activeView;
}

export function setActiveView(view) {
  if (!VALID_VIEWS.has(view)) {
    throw new Error(`invalid view: ${view}`);
  }
  _activeView = view;
  schedulePrefsSave();
}

export function getLastMcpUrl() {
  return _lastMcpUrl;
}

export function setLastMcpUrl(url) {
  _lastMcpUrl = typeof url === 'string' ? url : '';
  schedulePrefsSave();
}

export function getSessionOrder() {
  return _sessionOrder;
}

export function setSessionOrder(order) {
  if (!VALID_ORDERS.has(order)) {
    throw new Error(`invalid sessionOrder: ${order}`);
  }
  _sessionOrder = order;
  schedulePrefsSave();
}

// Debounce preferences writes — UI changes (clicks, set_view…) tend to
// fire several in a row. We accept the trailing edge.
let _prefsSaveTimer = null;
function schedulePrefsSave() {
  if (!_initDone) return;
  if (_prefsSaveTimer) clearTimeout(_prefsSaveTimer);
  _prefsSaveTimer = setTimeout(() => {
    _prefsSaveTimer = null;
    opfs.writePreferences({
      activeSha1: _activeSha1,
      activeView: _activeView,
      lastMcpUrl: _lastMcpUrl,
      sessionOrder: _sessionOrder,
    }).catch((err) => {
      console.warn('[sessions] preferences save failed:', err);
    });
  }, 250);
}
