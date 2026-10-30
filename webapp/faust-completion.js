// faust-completion.js — completion and hover documentation for the
// Faust editor (vendor/codemirror/faust-editor.js), ported from
// FaustIDE's monaco-faust : every documented function of the standard
// libraries (`os.osc`, `fi.lowpass`…), the Faust primitives and
// keywords, plus the names defined in the edited file.
//
// The library docs are read from libfaust-wasm's own copy of the
// libraries (/usr/share/faust), so they always match the compiler ;
// primitives come from vendor/faust-primitives/primitives.lib.

import { autocompletion, completionKeymap, hoverTooltip, keymap, tooltips, EditorView } from './vendor/codemirror/cm6.js';
import { collectDocs, parseDocBlocks, resolveDottedName, markdownToHtml, escapeHtml, compactDoc } from './faust-docs.js';
import { getFaust } from './faust.js';

const KEYWORDS = [
  'import', 'component', 'declare', 'library', 'environment', 'int', 'float',
  'letrec', 'with', 'process', 'effect', 'inputs', 'outputs',
];
const PRIMITIVES = [
  'mem', 'prefix', 'rdtable', 'rwtable', 'select2', 'select3', 'ffunction', 'fconstant',
  'fvariable', 'route', 'waveform', 'soundfile', 'button', 'checkbox', 'vslider', 'hslider',
  'nentry', 'vgroup', 'hgroup', 'tgroup', 'vbargraph', 'hbargraph', 'attach', 'acos', 'asin',
  'atan', 'atan2', 'cos', 'sin', 'tan', 'exp', 'log', 'log10', 'pow', 'sqrt', 'abs', 'min',
  'max', 'fmod', 'remainder', 'floor', 'ceil', 'rint', 'round', 'seq', 'par', 'sum', 'prod',
];

// ---------------------------------------------------------------------
// Docs (loaded once, on first use)
// ---------------------------------------------------------------------

let docsPromise = null;
let docs = null; // Map key → { key, name, namespace, file, doc }
let baseOptions = null;

function loadDocs() {
  if (!docsPromise) {
    docsPromise = (async () => {
      const all = new Map();
      try {
        const text = await (await fetch(new URL('./vendor/faust-primitives/primitives.lib', import.meta.url))).text();
        for (const b of parseDocBlocks(text)) {
          if (!all.has(b.name)) all.set(b.name, { key: b.name, name: b.name, namespace: '', file: 'primitives.lib', doc: b.doc });
        }
      } catch (err) {
        console.warn('faust-completion : primitives.lib unavailable', err);
      }
      try {
        const faust = await getFaust();
        const fs = faust.compiler.fs();
        const readLib = async (file) => {
          try { return fs.readFile(`/usr/share/faust/${file}`, { encoding: 'utf8' }); } catch { return null; }
        };
        for (const [key, entry] of await collectDocs(readLib)) all.set(key, entry);
      } catch (err) {
        console.warn('faust-completion : library docs unavailable', err);
      }
      docs = all;
      baseOptions = buildBaseOptions(all);
      return all;
    })();
  }
  return docsPromise;
}

function buildBaseOptions(all) {
  const byLabel = new Map();
  for (const entry of all.values()) {
    if (!/^[A-Za-z_][\w.]*$/.test(entry.key)) continue; // `'`, `@` : not identifiers
    byLabel.set(entry.key, {
      label: entry.key,
      type: KEYWORDS.includes(entry.key) ? 'keyword' : 'function',
      detail: entry.namespace ? entry.file : 'primitive',
      info: () => renderDoc(entry, { compact: true }),
    });
  }
  for (const k of KEYWORDS) if (!byLabel.has(k)) byLabel.set(k, { label: k, type: 'keyword' });
  for (const p of PRIMITIVES) if (!byLabel.has(p)) byLabel.set(p, { label: p, type: 'function', detail: 'primitive' });
  return [...byLabel.values()];
}

// Names defined in the edited file : `name = …` and `name(x, y) = …`
// (including inside `with { … }`).
const DEFINITION = /^[ \t]*([A-Za-z_]\w*)[ \t]*(?:\([^()]*\))?[ \t]*=(?!=)/gm;

function localOptions(text, known) {
  const seen = new Set();
  const out = [];
  for (const m of text.matchAll(DEFINITION)) {
    const name = m[1];
    if (seen.has(name) || known.has(name) || KEYWORDS.includes(name)) continue;
    seen.add(name);
    out.push({ label: name, type: 'variable', detail: 'this file', boost: 1 });
  }
  return out;
}

/** Cursor inside a `//` comment or a "string" on its line ? */
function inCommentOrString(lineBefore) {
  let inString = false;
  for (let i = 0; i < lineBefore.length; i++) {
    const ch = lineBefore[i];
    if (ch === '"') inString = !inString;
    else if (!inString && ch === '/' && lineBefore[i + 1] === '/') return true;
  }
  return inString;
}

async function completionSource(context) {
  const word = context.matchBefore(/[A-Za-z_][\w.]*/);
  if (!word && !context.explicit) return null;
  const line = context.state.doc.lineAt(context.pos);
  if (inCommentOrString(line.text.slice(0, context.pos - line.from))) return null;
  await loadDocs();
  const options = [...baseOptions, ...localOptions(context.state.doc.toString(), docs)];
  return {
    from: word ? word.from : context.pos,
    options,
    validFor: /^[\w.]*$/,
  };
}

// ---------------------------------------------------------------------
// Doc rendering
// ---------------------------------------------------------------------

/** compact : summary + Usage (completion panel) ; else the whole doc (hover). */
function renderDoc(entry, { compact = false } = {}) {
  const dom = document.createElement('div');
  dom.className = compact ? 'cm-faust-doc cm-faust-doc-compact' : 'cm-faust-doc';
  const where = entry.namespace ? `${entry.file}` : 'Faust primitive';
  const doc = compact ? compactDoc(entry.doc) : entry.doc;
  dom.innerHTML =
    `<div class="cm-faust-doc-title"><code>${escapeHtml(entry.key)}</code> <span>${escapeHtml(where)}</span></div>` +
    markdownToHtml(doc || '');
  return dom;
}

// ---------------------------------------------------------------------
// Hover : documentation of the `ns.name` under the mouse
// ---------------------------------------------------------------------

const docHover = hoverTooltip((view, pos) => {
  if (!docs) { void loadDocs(); return null; }
  const line = view.state.doc.lineAt(pos);
  const hit = resolveDottedName(line.text, pos - line.from, (k) => docs.has(k));
  if (!hit) return null;
  const entry = docs.get(hit.key);
  return {
    pos: line.from + hit.from,
    end: line.from + hit.to,
    above: false, // below the word : the lines above stay readable
    create: () => ({ dom: renderDoc(entry) }),
  };
}, { hoverTime: 600 });

// Popups that hide as little code as possible : compact list (6 rows),
// short doc panel, and a slightly see-through background (86 % + blur) so
// the code underneath stays perceptible. The blur sits on the list and on
// the panel separately : nested backdrop filters would not see the code.
const POPUP_BG = 'rgba(40, 44, 52, 0.86) !important';
const POPUP_BLUR = 'blur(3px)';
const POPUP_GAP_PX = 8;
const docTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete': {
    background: 'transparent !important',
    border: 'none !important',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontSize: '12px',
    maxHeight: '8.2em', // ≈ 6 rows
    minWidth: '200px',
    background: POPUP_BG,
    backdropFilter: POPUP_BLUR,
    WebkitBackdropFilter: POPUP_BLUR,
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: '4px',
  },
  '.cm-completionDetail': {
    fontStyle: 'normal',
    opacity: '0.45',
    marginLeft: '0.8em',
  },
  // A gap between the line being edited and the list / hover doc.
  '.cm-tooltip.cm-tooltip-autocomplete.cm-tooltip-below, .cm-tooltip.cm-tooltip-hover.cm-tooltip-below': {
    marginTop: `${POPUP_GAP_PX}px`,
  },
  '.cm-tooltip.cm-tooltip-autocomplete.cm-tooltip-above, .cm-tooltip.cm-tooltip-hover.cm-tooltip-above': {
    marginTop: `-${POPUP_GAP_PX}px`,
  },
  '.cm-tooltip.cm-completionInfo, .cm-tooltip.cm-tooltip-hover': {
    background: POPUP_BG,
    backdropFilter: POPUP_BLUR,
    WebkitBackdropFilter: POPUP_BLUR,
    border: '1px solid rgba(255, 255, 255, 0.08) !important',
    borderRadius: '4px',
    padding: '0',
  },
  '.cm-faust-doc': {
    maxWidth: '480px',
    maxHeight: '300px',
    overflow: 'auto',
    padding: '6px 10px',
    fontSize: '12px',
    lineHeight: '1.45',
    fontFamily: 'system-ui, sans-serif',
    whiteSpace: 'normal',
  },
  '.cm-faust-doc.cm-faust-doc-compact': { maxHeight: '180px' }, // ≈ 10 lines
  '.cm-faust-doc p': { margin: '4px 0' },
  '.cm-faust-doc ul': { margin: '4px 0', paddingLeft: '18px' },
  '.cm-faust-doc pre': {
    margin: '4px 0',
    padding: '4px 6px',
    background: 'rgba(255,255,255,0.06)',
    borderRadius: '4px',
    fontFamily: "'SF Mono', Monaco, Consolas, monospace",
    fontSize: '11.5px',
    whiteSpace: 'pre-wrap',
  },
  '.cm-faust-doc code': { fontFamily: "'SF Mono', Monaco, Consolas, monospace", fontSize: '11.5px' },
  '.cm-faust-doc-title': { fontWeight: '600', marginBottom: '4px' },
  '.cm-faust-doc-title span': { fontWeight: '400', opacity: '0.6', marginLeft: '6px' },
  '.cm-faust-doc-h': { fontWeight: '600', marginTop: '6px', opacity: '0.85' },
  // Room after the last line, so the line being typed can always sit
  // above the bottom margin below.
  '.cm-content': { paddingBottom: '200px' },
});

// Keep the cursor line at least this far above the editor's bottom edge
// while typing : the completion list then always fits below the cursor
// and never flips above it, over the code being read.
const BOTTOM_MARGIN_PX = 170;
const keepRoomBelow = EditorView.scrollMargins.of(() => ({ bottom: BOTTOM_MARGIN_PX }));

// Tab accepts the highlighted completion, like Enter (and as in FaustIDE /
// VS Code). Reuses the Enter binding's command ; when no list is open it
// returns false and Tab keeps indenting (indentWithTab, later keymap).
const acceptBinding = completionKeymap.find((b) => b.key === 'Enter');
const tabAccepts = keymap.of(acceptBinding ? [{ key: 'Tab', run: acceptBinding.run }] : []);

// Popups live outside the editor : an ancestor with `overflow: hidden` +
// `backdrop-filter` (the floating ✎ editor window) would otherwise clip
// them, so a doc panel without room below or on the right side simply
// vanished. From there, CodeMirror can move it up or to the other side
// within the whole window. The host is a 0×0 fixed box : CodeMirror's
// container carries the editor theme classes (height: 100%) and would
// otherwise become a flex item of <body> and squeeze the page layout.
function popupHost() {
  let host = document.getElementById('cm-faust-popups');
  if (!host) {
    host = document.createElement('div');
    host.id = 'cm-faust-popups';
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:200;';
    document.body.appendChild(host);
  }
  return host;
}
const popupsOutside = typeof document !== 'undefined' ? tooltips({ parent: popupHost() }) : [];

/** Editor extensions : completion (typing or Ctrl-Space) + hover docs. */
export function faustCompletion() {
  // Start loading in the background so the first completion is instant.
  setTimeout(() => { void loadDocs(); }, 0);
  return [
    popupsOutside,
    autocompletion({ override: [completionSource], icons: true }),
    tabAccepts,
    docHover,
    docTheme,
    keepRoomBelow,
  ];
}
