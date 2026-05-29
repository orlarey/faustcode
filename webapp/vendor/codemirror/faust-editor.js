// faust-editor.js — shared factory for CodeMirror 6 Faust editors.
//
// Used by :
//   - public/views/dsp.js          (the main DSP code pane)
//   - webapp/floating-editor.js    (the standalone floating overlay)
//
// Centralises the CodeMirror extension set so both editors stay in
// sync : same language mode, same theme, same Cmd/Ctrl+S behaviour,
// same dirty tracking.
//
// When `window.__faustEditorBus` is present (the standalone webapp
// installs one), every editor created here automatically joins a
// live mirror : keystrokes propagate between editors, pristine is
// shared, submits clear dirty everywhere.

import {
  EditorView,
  Compartment,
  keymap,
  lineNumbers,
  highlightActiveLine,
  defaultKeymap,
  indentWithTab,
  history,
  historyKeymap,
  bracketMatching,
  indentOnInput,
  closeBrackets,
  closeBracketsKeymap,
  defaultHighlightStyle,
  syntaxHighlighting,
  oneDark,
} from './cm6.js';
import { faustLanguage } from './faust-lang.js';

const BASE_FONT_PX = 14;
const FONT_FAMILY = "'SF Mono', 'Monaco', 'Consolas', monospace";

function fontTheme(pct) {
  const px = Math.round(BASE_FONT_PX * pct / 100);
  return EditorView.theme({
    '&': { fontSize: `${px}px`, height: '100%' },
    '.cm-scroller': { fontFamily: FONT_FAMILY },
  });
}

/**
 * Select a whole-line range (or a range of lines) by line numbers.
 * Anchor and head are set to line `from` / `to` so the selection stops
 * at the end of the line content, not the trailing newline — same
 * convention as in ../markpage/src/editor.ts.
 */
function selectLineRange(view, anchorLine, headLine) {
  const doc = view.state.doc;
  const aLine = doc.line(anchorLine);
  const hLine = doc.line(headLine);
  const anchor = anchorLine <= headLine ? aLine.from : aLine.to;
  const head   = anchorLine <= headLine ? hLine.to   : hLine.from;
  view.dispatch({ selection: { anchor, head } });
}

/**
 * Click a line number to select its whole line ; drag across line
 * numbers to extend the selection.
 *
 * Registered on `view.dom` rather than the content DOM because gutters
 * live outside `contentDOM` — EditorView.domEventHandlers wouldn't see
 * the event otherwise. Ported from markpage's editor.ts.
 */
function attachGutterLineSelection(view) {
  view.dom.addEventListener('mousedown', (e) => {
    const gutterItem = e.composedPath().find(
      (n) => n instanceof Element && n.classList.contains('cm-gutterElement'),
    );
    if (!gutterItem || !gutterItem.closest('.cm-lineNumbers')) return;

    e.preventDefault();

    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    if (pos === null) return;
    const startLine = view.state.doc.lineAt(pos).number;

    selectLineRange(view, startLine, startLine);
    view.focus();

    const onMove = (ev) => {
      const p = view.posAtCoords({ x: ev.clientX, y: ev.clientY }, false);
      if (p === null) return;
      const line = view.state.doc.lineAt(p).number;
      selectLineRange(view, startLine, line);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/**
 * Build a Faust-aware CodeMirror 6 editor.
 *
 * @param {object} opts
 * @param {string} [opts.doc] - Initial code. Defaults to the live
 *   mirror bus pristine if available, else an empty string.
 * @param {HTMLElement} opts.parent - DOM element to mount the editor in.
 * @param {(code: string) => Promise<void>} [opts.onSubmit] - Called on
 *   Cmd/Ctrl+S or via the returned `submit()` method.
 * @param {(dirty: boolean) => void} [opts.onDirty] - Called whenever
 *   the buffer's "ahead of pristine" state changes.
 *
 * @returns {{ view: EditorView, submit: () => Promise<void>, setCode: (code: string) => void, setZoom: (pct: number) => void, isDirty: () => boolean, destroy: () => void }}
 */
export function createFaustEditor({ doc, parent, onSubmit, onDirty }) {
  const bus = (typeof window !== 'undefined' && window.__faustEditorBus) || null;

  const initialDoc =
    typeof doc === 'string'
      ? doc
      : (bus ? bus.getPristine() : '') || '';

  let pristineCode = bus ? bus.getPristine() : initialDoc;
  let dirty = false;
  let applyingRemote = false;
  const fontCompartment = new Compartment();

  function setDirty(next) {
    if (dirty === next) return;
    dirty = next;
    if (typeof onDirty === 'function') onDirty(next);
  }

  async function submit() {
    if (!dirty || typeof onSubmit !== 'function') return;
    const code = view.state.doc.toString();
    if (!code.trim()) return;
    try {
      await onSubmit(code);
      if (bus) {
        bus.markSubmitted(code);
      } else {
        pristineCode = code;
        setDirty(false);
      }
    } catch {
      // Leave the buffer dirty so the user can fix and retry. The
      // caller surfaces the error elsewhere (banner, log…).
    }
  }

  const extensions = [
    lineNumbers(),
    highlightActiveLine(),
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    faustLanguage,
    oneDark,
    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => { void submit(); return true; },
      },
      indentWithTab,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    fontCompartment.of(fontTheme(100)),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      // Suppress while applying a transaction we received from the bus,
      // otherwise we'd re-broadcast it and loop.
      if (applyingRemote) return;
      const text = update.state.doc.toString();
      setDirty(text !== pristineCode);
      if (bus) bus.broadcastChanges(api, update.changes);
    }),
  ];

  const view = new EditorView({ doc: initialDoc, extensions, parent });

  attachGutterLineSelection(view);

  function _setBufferAndPristine(newCode) {
    applyingRemote = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newCode },
      });
    } finally {
      applyingRemote = false;
    }
    pristineCode = newCode;
    setDirty(false);
  }

  const api = {
    view,
    submit,

    /**
     * Public API : load this code as the new baseline. With the live
     * mirror bus, broadcasts to all editors. Without it, just
     * updates the local buffer + pristine.
     */
    setCode(newCode) {
      if (bus) bus.loadSession(newCode);
      else _setBufferAndPristine(newCode);
    },

    setZoom(pct) {
      const clamped = Math.max(50, Math.min(200, pct));
      view.dispatch({ effects: fontCompartment.reconfigure(fontTheme(clamped)) });
    },

    isDirty: () => dirty,

    destroy() {
      if (bus) bus.unregister(api);
      try { view.destroy(); } catch {}
    },

    // ----- bus internals ---------------------------------------------
    _onPristineChange(newPristine) {
      pristineCode = newPristine;
      setDirty(view.state.doc.toString() !== pristineCode);
    },
    _setBufferAndPristine,
    _applyRemoteChanges(changes) {
      applyingRemote = true;
      try { view.dispatch({ changes }); }
      finally { applyingRemote = false; }
      setDirty(view.state.doc.toString() !== pristineCode);
    },
  };

  if (bus) bus.register(api);

  return api;
}
