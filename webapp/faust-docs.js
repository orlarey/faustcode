// faust-docs.js — documentation of the Faust libraries and primitives,
// extracted from the library sources themselves, for the editor's
// completion and hover (faust-completion.js). Same behaviour as
// FaustIDE's monaco-faust (Faust2Doc), written from the faust2md
// comment conventions :
//
//   //############# Title #################     title block
//   //============== Section ==============     section block
//   //-------------- `(os.)osc` -----------     documented function
//   //  markdown text…
//   //-------------------------------------     end of block
//
// Namespaces follow the library structure : stdfaust.lib's
// `os = library("oscillators.lib");` documents `osc` as `os.osc`.
//
// No DOM access at module level : unit-tested with
// `node --test webapp/faust-docs.test.mjs`.

const BEGIN_TITLE = /^\s*\/\/#{3,}\s*([^#]*[^#\s])\s*#{3,}$/;
const BEGIN_SECTION = /^\s*\/\/={3,}\s*([^=]*[^=\s])\s*={3,}$/;
const BEGIN_COMMENT = /^\s*\/\/-{3,}\s*([^-]*[^-\s])\s*-{3,}$/;
const END_TITLE = /^\s*\/\/#{3,}\s*$/;
const END_SECTION = /^\s*\/\/={3,}\s*$/;
const END_COMMENT = /^\s*\/\/-{3,}\s*$/;
const COMMENT = /^\s*\/\//;
const FUNC_NAMES = /`[^`]*?([\w[\]|']+|@)`/g;
const LIBRARY_DEF = /\b(\w+)\s*=\s*library\("([^"]+)"\)\s*;/g;
const IMPORT_DEF = /\bimport\("([^"]+)"\)\s*;/g;

/**
 * Expand the optional / alternative parts of a documented name :
 *   `[third|half]_octave_[analyzer|filterbank][n]` →
 *   third_octave_analyzer, third_octave_analyzern, half_octave_…
 * `[x]` (single choice) is optional, `[a|b]` picks one.
 */
export function expandName(name) {
  const m = /\[([^\]]*)\]/.exec(name);
  if (!m) return [name];
  const before = name.slice(0, m.index);
  const after = name.slice(m.index + m[0].length);
  const choices = m[1].split('|');
  const variants = choices.length === 1 ? ['', choices[0]] : choices;
  return variants.flatMap((v) => expandName(before + v + after));
}

/** Strip the `//` prefix, keeping the markdown indentation of the block. */
function outdent(lines) {
  // Indentation of the block = spaces after `//` on its first text line.
  let indent = 0;
  for (const line of lines) {
    const m = /^\s*\/\/( *)\S/.exec(line);
    if (m) { indent = m[1].length; break; }
  }
  return lines
    .map((line) => {
      const body = line.replace(/^\s*\/\//, '');
      const spaces = /^ */.exec(body)[0].length;
      return body.slice(Math.min(indent, spaces)).replace(/\s+$/, '');
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Documented functions of one library text.
 * @returns {Array<{ name: string, header: string, doc: string }>}
 */
export function parseDocBlocks(text) {
  const blocks = [];
  let current = null; // { header, name, lines } while inside a block
  const close = () => {
    if (current && current.names.length) {
      const doc = outdent(current.lines);
      for (const name of current.names) blocks.push({ name, header: current.header, doc });
    }
    current = null;
  };
  for (const line of String(text).split('\n')) {
    if (!COMMENT.test(line)) {
      close();
      continue;
    }
    if (current) {
      if (END_COMMENT.test(line) || END_SECTION.test(line) || END_TITLE.test(line)) {
        close();
      } else if (BEGIN_COMMENT.test(line) || BEGIN_SECTION.test(line) || BEGIN_TITLE.test(line)) {
        close();
        current = startBlock(line);
      } else {
        current.lines.push(line);
      }
      continue;
    }
    current = startBlock(line);
  }
  close();
  return blocks;
}

function startBlock(line) {
  const c = BEGIN_COMMENT.exec(line);
  if (c) {
    // A header may document several functions : `(an.)octave_analyzer`, `(an.)half_octave_analyzer`…
    const names = [...c[1].matchAll(FUNC_NAMES)].map((m) => m[1]);
    return { header: c[1], names, lines: [] };
  }
  if (BEGIN_SECTION.test(line) || BEGIN_TITLE.test(line)) return { header: null, names: [], lines: [] };
  return null;
}

/**
 * Library structure of one text : `ns = library("file")` and
 * `import("file")` statements, outside comments.
 */
export function parseLibraryRefs(text) {
  const code = String(text)
    .split('\n')
    .filter((l) => !COMMENT.test(l))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const libraries = [...code.matchAll(LIBRARY_DEF)].map((m) => ({ namespace: m[1], file: m[2] }));
  const imports = [...code.matchAll(IMPORT_DEF)].map((m) => m[1]);
  return { libraries, imports };
}

/**
 * Walk a library tree from `rootFile` and collect every documented
 * function under its qualified name (`os.osc`, `fi.lowpass`…).
 *
 * @param {(file: string) => Promise<string|null>} readLib
 * @param {string} rootFile
 * @param {number} depth  libraries followed below the root (stdfaust → *.lib)
 * @returns {Promise<Map<string, { key, name, namespace, file, header, doc }>>}
 */
export async function collectDocs(readLib, rootFile = 'stdfaust.lib', depth = 2, prefix = [], out = new Map(), seen = new Set()) {
  if (depth === 0) return out;
  const visitKey = `${prefix.join('.')}|${rootFile}`;
  if (seen.has(visitKey)) return out;
  seen.add(visitKey);
  const text = await readLib(rootFile);
  if (typeof text !== 'string') return out;
  for (const block of parseDocBlocks(text)) {
    for (const name of expandName(block.name)) {
      const key = [...prefix, name].join('.');
      if (!out.has(key)) {
        out.set(key, { key, name, namespace: prefix.join('.'), file: rootFile, header: block.header, doc: block.doc });
      }
    }
  }
  const { libraries, imports } = parseLibraryRefs(text);
  for (const lib of libraries) {
    await collectDocs(readLib, lib.file, depth - 1, [...prefix, lib.namespace], out, seen);
  }
  for (const imp of imports) {
    await collectDocs(readLib, imp, depth - 1, prefix, out, seen);
  }
  return out;
}

/** First sentence-ish line of a doc, for the completion list. */
export function docSummary(doc) {
  let inFence = false;
  for (const raw of String(doc || '').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence || !line || line.startsWith('#') || /^[-=*_]{3,}$/.test(line)) continue;
    return line.replace(/`/g, '').slice(0, 120);
  }
  return '';
}

/**
 * The `ns.name` (or `name`) around `offset` in a line of code, reduced to
 * its longest documented suffix : `os.osc` → tries `os.osc`, then `osc`.
 * @returns {{ key, from, to } | null}  from / to are offsets in the line
 */
export function resolveDottedName(lineText, offset, has) {
  const isWord = (ch) => /[\w.]/.test(ch);
  let from = offset;
  let to = offset;
  while (from > 0 && isWord(lineText[from - 1])) from--;
  while (to < lineText.length && isWord(lineText[to])) to++;
  while (from < to && lineText[from] === '.') from++;
  while (to > from && lineText[to - 1] === '.') to--;
  if (from === to) return null;
  const parts = lineText.slice(from, to).split('.');
  let start = from;
  for (let i = 0; i < parts.length; i++) {
    const key = parts.slice(i).join('.');
    if (key && has(key)) return { key, from: start, to };
    start += parts[i].length + 1;
  }
  return null;
}

// Minimal markdown → HTML for the doc panels. Everything is escaped
// first : the docs come from library files, never trusted as HTML.
export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

export function markdownToHtml(md) {
  const out = [];
  let list = false;
  let code = null;
  let para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
  const closeList = () => { if (list) out.push('</ul>'); list = false; };
  for (const raw of String(md).split('\n')) {
    if (code !== null) {
      if (/^\s*```/.test(raw)) { out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`); code = null; }
      else code.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) { flushPara(); closeList(); code = []; continue; }
    const line = raw.trim();
    if (!line) { flushPara(); closeList(); continue; }
    const h = /^#+\s*(.*)$/.exec(line);
    if (h) { flushPara(); closeList(); out.push(`<div class="cm-faust-doc-h">${inline(h[1])}</div>`); continue; }
    const li = /^[*-]\s+(.*)$/.exec(line);
    if (li) { flushPara(); if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    closeList();
    para.push(line);
  }
  if (code !== null) out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
  flushPara();
  closeList();
  return out.join('');
}
