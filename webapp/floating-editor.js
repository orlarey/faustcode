// floating-editor.js — faustcode-only floating overlay editor.
//
// A draggable + resizable window holding a CodeMirror 6 Faust editor.
// Toggled via the ✎ icon in the page header. Stays open across view
// switches so the user can iterate on the DSP code while watching the
// Run UI / SVG diagram / etc. update underneath each time Cmd/Ctrl+S
// or the Submit button fires.
//
// Position and size are persisted in localStorage.

import { createFaustEditor } from './vendor/codemirror/faust-editor.js';

const STORAGE_KEY = 'faustcode-floating-editor';
const DEFAULT_GEOM = { left: -460, top: 56, width: 440, height: 480 }; // negative left = anchored from right

let rootEl = null;
let editor = null;
let onSubmitCb = null;       // (code: string, filename: string) => Promise<void>
let titleEl = null;
let filenameEl = null;
let dragState = null;
let resizeState = null;
let visible = false;
let currentSha = null;
let currentFilename = 'patch.dsp';

// ---------------------------------------------------------------------
// Geometry persistence
// ---------------------------------------------------------------------

function loadGeom() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw);
    if (typeof g !== 'object' || g === null) return null;
    return g;
  } catch { return null; }
}

function saveGeom(g) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(g)); } catch {}
}

function applyGeom(g) {
  if (!rootEl) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let { left, top, width, height } = g;
  // Clamp into the visible viewport so a stale position doesn't strand
  // the panel offscreen.
  width = Math.max(280, Math.min(width || 440, vw - 40));
  height = Math.max(180, Math.min(height || 480, vh - 60));
  if (left < 0) left = vw - width - 16;     // initial right-anchored
  left = Math.max(8, Math.min(left, vw - width - 8));
  top = Math.max(48, Math.min(top, vh - height - 8));
  rootEl.style.left = `${left}px`;
  rootEl.style.top = `${top}px`;
  rootEl.style.width = `${width}px`;
  rootEl.style.height = `${height}px`;
}

function currentGeom() {
  if (!rootEl) return DEFAULT_GEOM;
  const r = rootEl.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

// ---------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------

function build() {
  if (rootEl) return;
  rootEl = document.createElement('aside');
  rootEl.id = 'floating-editor';
  rootEl.className = 'floating-editor hidden';
  rootEl.setAttribute('aria-hidden', 'true');
  rootEl.innerHTML = `
    <div class="floating-editor-titlebar">
      <span class="floating-editor-title">DSP CODE</span>
      <span class="floating-editor-filename"></span>
      <span class="floating-editor-spacer"></span>
      <button class="primary-btn floating-editor-submit" type="button" disabled
              title="Compile (Cmd/Ctrl+S)">Submit</button>
      <button class="ff-dialog-close floating-editor-close" type="button"
              aria-label="Close editor">×</button>
    </div>
    <div class="floating-editor-host"></div>
    <div class="floating-editor-resize" aria-hidden="true"></div>
  `;
  document.body.appendChild(rootEl);

  titleEl = rootEl.querySelector('.floating-editor-title');
  filenameEl = rootEl.querySelector('.floating-editor-filename');
  const submitBtn = rootEl.querySelector('.floating-editor-submit');
  const closeBtn = rootEl.querySelector('.floating-editor-close');
  const titlebar = rootEl.querySelector('.floating-editor-titlebar');
  const resizeHandle = rootEl.querySelector('.floating-editor-resize');
  const host = rootEl.querySelector('.floating-editor-host');

  applyGeom(loadGeom() || DEFAULT_GEOM);

  editor = createFaustEditor({
    doc: '',
    parent: host,
    onSubmit: async (code) => {
      if (typeof onSubmitCb !== 'function') return;
      await onSubmitCb(code, currentFilename);
    },
    onDirty: (b) => {
      titleEl.textContent = b ? 'DSP CODE ●' : 'DSP CODE';
      titleEl.classList.toggle('is-dirty', b);
      submitBtn.disabled = !b;
    },
  });

  submitBtn.addEventListener('click', () => { void editor.submit(); });
  closeBtn.addEventListener('click', () => hide());

  // Drag.
  titlebar.addEventListener('mousedown', (ev) => {
    if (ev.target.closest('button')) return; // don't drag when clicking buttons
    const r = rootEl.getBoundingClientRect();
    dragState = { startX: ev.clientX, startY: ev.clientY, baseLeft: r.left, baseTop: r.top };
    rootEl.classList.add('is-moving');
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (dragState) {
      const left = dragState.baseLeft + (ev.clientX - dragState.startX);
      const top  = dragState.baseTop  + (ev.clientY - dragState.startY);
      rootEl.style.left = `${left}px`;
      rootEl.style.top  = `${top}px`;
    } else if (resizeState) {
      const width  = resizeState.baseWidth  + (ev.clientX - resizeState.startX);
      const height = resizeState.baseHeight + (ev.clientY - resizeState.startY);
      rootEl.style.width  = `${Math.max(280, width)}px`;
      rootEl.style.height = `${Math.max(180, height)}px`;
    }
  });
  window.addEventListener('mouseup', () => {
    if (dragState || resizeState) {
      applyGeom(currentGeom()); // clamp into viewport
      saveGeom(currentGeom());
    }
    if (dragState) rootEl.classList.remove('is-moving');
    if (resizeState) rootEl.classList.remove('is-resizing');
    dragState = null;
    resizeState = null;
  });

  // Resize.
  resizeHandle.addEventListener('mousedown', (ev) => {
    const r = rootEl.getBoundingClientRect();
    resizeState = { startX: ev.clientX, startY: ev.clientY, baseWidth: r.width, baseHeight: r.height };
    rootEl.classList.add('is-resizing');
    ev.preventDefault();
  });

  // Re-clamp on window resize.
  window.addEventListener('resize', () => {
    if (visible) applyGeom(currentGeom());
  });
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

function show() {
  if (!rootEl) build();
  if (visible) return;
  rootEl.classList.remove('hidden');
  rootEl.setAttribute('aria-hidden', 'false');
  visible = true;
  // The CM editor needs a measure pass after becoming visible so its
  // layout reflects the real container size.
  setTimeout(() => { if (editor) editor.view.requestMeasure(); }, 0);
}

function hide() {
  if (!visible || !rootEl) return;
  rootEl.classList.add('hidden');
  rootEl.setAttribute('aria-hidden', 'true');
  visible = false;
}

export function toggle() {
  if (!rootEl) build();
  if (visible) hide();
  else show();
}

export function isVisible() {
  return visible;
}

/**
 * Push a new session into the editor : if the buffer is clean, replace
 * the code with the new session's source. If it's dirty, leave it
 * alone — the user is mid-edit, they don't want their work clobbered.
 *
 * @param {{ sha1: string, code: string, filename?: string }} session
 */
export function loadSession(session) {
  if (!rootEl) build();
  if (!session || typeof session.code !== 'string') return;
  currentSha = session.sha1 || null;
  currentFilename = session.filename || 'patch.dsp';
  if (filenameEl) filenameEl.textContent = currentFilename;
  if (!editor) return;
  // Only refresh the buffer when clean ; preserve in-progress edits
  // otherwise.
  if (!editor.isDirty()) {
    editor.setCode(session.code);
  }
}

/**
 * Wire the submit callback. Typically points at the parent app's
 * submitCode helper (via onSubmit hook in views).
 *
 * @param {(code: string, filename: string) => Promise<void>} cb
 */
export function setOnSubmit(cb) {
  onSubmitCb = cb;
}
