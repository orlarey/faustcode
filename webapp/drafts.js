// drafts.js — unsaved editor text, per session (sha1).
//
// The editor buffer only lives in the CodeMirror views, which are
// destroyed on every view switch or session change : edits that were
// not submitted used to be lost. Drafts keep them, in memory and in
// localStorage (survives a reload or a closed tab), until the code is
// submitted or edited back to the stored version.
//
// Storage : one JSON object { sha1: { code, at } }, at most MAX_DRAFTS
// entries (oldest dropped). Every storage access is guarded : private
// windows or blocked storage just keep the drafts in memory.

const STORAGE_KEY = 'faustcode-drafts';
const MAX_DRAFTS = 30;
const SAVE_DELAY_MS = 300;

let drafts = load();
let saveTimer = null;

function load() {
  try {
    const raw = globalThis.localStorage && localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function persistNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const entries = Object.entries(drafts).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    drafts = Object.fromEntries(entries.slice(0, MAX_DRAFTS));
    if (globalThis.localStorage) localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // quota / blocked storage : drafts stay in memory
  }
}

function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(persistNow, SAVE_DELAY_MS);
}

/** Unsaved text of a session, or null. */
export function getDraft(sha) {
  const d = sha ? drafts[sha] : null;
  return d && typeof d.code === 'string' ? d.code : null;
}

export function setDraft(sha, code) {
  if (!sha) return;
  drafts[sha] = { code: String(code), at: Date.now() };
  persistSoon();
}

export function clearDraft(sha) {
  if (!sha || !(sha in drafts)) return;
  delete drafts[sha];
  persistSoon();
}

/** Forget every draft whose text was just submitted (it is now stored). */
export function clearDraftsWithCode(code) {
  let changed = false;
  for (const [sha, d] of Object.entries(drafts)) {
    if (d.code === code) { delete drafts[sha]; changed = true; }
  }
  if (changed) persistSoon();
}

/** Write pending changes right away (page about to be hidden / closed). */
export function flushDrafts() {
  if (saveTimer) persistNow();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushDrafts);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushDrafts();
  });
}
