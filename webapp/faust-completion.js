// faust-completion.js — completion and hover documentation for the
// Faust editor (vendor/codemirror/faust-editor.js), ported from
// FaustIDE's monaco-faust : every documented function of the standard
// libraries (`os.osc`, `fi.lowpass`…), the Faust primitives and
// keywords, plus the names defined in the edited file.
//
// The library docs are read from libfaust-wasm's own copy of the
// libraries (/usr/share/faust), so they always match the compiler ;
// primitives come from vendor/faust-primitives/primitives.lib.

import { autocompletion, hoverTooltip, EditorView } from './vendor/codemirror/cm6.js';
import { collectDocs, parseDocBlocks, resolveDottedName, markdownToHtml, escapeHtml } from './faust-docs.js';
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
      info: () => renderDoc(entry),
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

function renderDoc(entry) {
  const dom = document.createElement('div');
  dom.className = 'cm-faust-doc';
  const where = entry.namespace ? `${entry.file}` : 'Faust primitive';
  dom.innerHTML =
    `<div class="cm-faust-doc-title"><code>${escapeHtml(entry.key)}</code> <span>${escapeHtml(where)}</span></div>` +
    markdownToHtml(entry.doc || '');
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
    above: true,
    create: () => ({ dom: renderDoc(entry) }),
  };
}, { hoverTime: 400 });

const docTheme = EditorView.baseTheme({
  '.cm-faust-doc': {
    maxWidth: '520px',
    maxHeight: '340px',
    overflow: 'auto',
    padding: '6px 10px',
    fontSize: '12px',
    lineHeight: '1.45',
    fontFamily: 'system-ui, sans-serif',
    whiteSpace: 'normal',
  },
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
  '.cm-tooltip.cm-completionInfo': { padding: '0' },
});

/** Editor extensions : completion (typing or Ctrl-Space) + hover docs. */
export function faustCompletion() {
  // Start loading in the background so the first completion is instant.
  setTimeout(() => { void loadDocs(); }, 0);
  return [
    autocompletion({ override: [completionSource], icons: true }),
    docHover,
    docTheme,
  ];
}
