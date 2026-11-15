// mathdoc.js — the mathematical documentation of a Faust program, as
// `faust -mdoc` makes it, packed in a .zip ready for pdflatex.
//
// libfaust-wasm has the documentator of Faust compiled in, but :
//   1. its .data bundle lacks the files of `architecture/` the documentator
//      reads (latexheader.tex, mathdoctexts-<lang>.txt) : they are copied in
//      vendor/faust-mathdoc/ and written to /usr/share/faust/ of its virtual
//      filesystem (installMathdocResources) ;
//   2. -mdoc reads the program again from the file named by the compile (to
//      find the <mdoc> tags, which the parser skips, and to copy the sources
//      into src/) : the code is written to /<name>.dsp first.
// It makes /<name>-mdoc/{tex,svg,src,cpp,pdf}/ : tex/<name>.tex, the block
// diagrams in svg/ ; cpp/ stays empty (no C++ backend in libfaust-wasm) and
// pdf/ too (faust2mathdoc runs pdflatex ; here, the user does).
//
// What is added to what Faust makes :
//   - fixMathdocTex : the texts Faust copies raw into the LaTeX — the labels,
//     units and groups of the controls, and, in the document made when the
//     program has no <mdoc> tag, its title and the table of the metadata
//     (`compile_options`, `filters.lib/lowpass0_highpass1:author`…) — are
//     escaped : a `&` in them stops pdflatex, a `%` drops the end of the line,
//     a `_` prints a dot (breqn changes its catcode : `compile˙options`) ;
//   - declareUnicode : each character beyond ASCII given to listings in ASCII
//     (`literate`) and to inputenc (\DeclareUnicodeCharacter) : the comments of
//     the libraries have π, μ, ≤, →, which stopped pdflatex in the listings ;
//   - a PNG of each diagram the document includes (\includegraphics{../svg/…}
//     has no extension : pdflatex takes the .png, or a .pdf the user makes) ;
//   - README.txt : how to make the PDF.

import { crc32, makeZip } from './zip.js';

export const MATHDOC_LANGS = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
];

export const MATHDOC_RESOURCE_FILES = [
  'latexheader.tex',
  'mathdoctexts-default.txt',
  ...MATHDOC_LANGS.map((l) => `mathdoctexts-${l.code}.txt`),
];

const RESOURCE_DIR = '/usr/share/faust';

/** Resolution of the PNG of the diagrams. */
export const MATHDOC_PNG_DPI = 300;

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

/**
 * The name of the documentation of a file : its base name without `.dsp`,
 * reduced to letters, digits and `-` (it goes into LaTeX : \faustfilename,
 * captions, paths of \includegraphics).
 */
export function mathdocName(filename) {
  const base = String(filename || '').replace(/^.*[\\/]/, '').replace(/\.dsp$/i, '');
  const safe = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'faust';
}

/** Whether Faust finds a <mdoc> tag in the code (comments and strings aside). */
export function hasMdocTag(code) {
  return /<mdoc>/.test(bareCode(code));
}

/** The code without its comments and strings (what the parser of Faust reads as tags). */
function bareCode(code) {
  return String(code).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"/g, ' ');
}

/** Whether the code asks for the listings of the libraries : `<listing dependencies="true"/>`. */
export function wantsDependencies(code) {
  // the comments aside, not the strings : the value of the attribute is one
  const uncommented = String(code).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ');
  return /<listing\b[^>]*\bdependencies\s*=\s*"true"/.test(uncommented);
}

/** The texts of a mathdoctexts-<lang>.txt : `:key "value"` lines. */
export function mathdocTexts(text) {
  const map = {};
  for (const m of String(text).matchAll(/^:(\w+)\s+"(.*)"\s*$/gm)) map[m[1]] = m[2];
  return map;
}

/**
 * The listings of the document : those of the files `keep` (the program, the
 * .lib files of faustcode), not those of the libraries of Faust, which the
 * documentator lists unless `<listing dependencies="false"/>` (thousands of
 * lines : 140 pages for stdfaust.lib ; their sources stay in src/). With one
 * listing left, the autodoc gets the title and text of one listing.
 *
 * @param {string} tex
 * @param {{ keep: string[], texts?: object }} options  texts : mathdocTexts of the language
 */
export function shortenListings(tex, { keep, texts = {} }) {
  const kept = new Set(keep);
  let left = 0;
  let removed = 0;
  let out = tex.replace(
    /\n\\bigskip\\bigskip\n\\begin\{lstlisting\}\[caption=\\texttt\{([^}\n]*)\}\]\n[\s\S]*?(?<=\n)\\end\{lstlisting\}\n\n?/g,
    (m, file) => {
      if (kept.has(file)) {
        left++;
        return m;
      }
      removed++;
      return '';
    },
  );
  if (removed && left === 1) {
    for (const [two, one] of [['autolsttitle2', 'autolsttitle1'], ['autolsttext2', 'autolsttext1']]) {
      if (texts[two] && texts[one]) out = out.split(texts[two]).join(texts[one]);
    }
  }
  return out;
}

const LATEX_TEXT = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  _: '\\_',
  '%': '\\%',
  '&': '\\&',
  '#': '\\#',
  $: '\\$',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
  '<': '$<$',
  '>': '$>$',
};

/** A text as LaTeX text : the characters LaTeX reads as commands escaped. */
export function latexEscape(text) {
  return String(text).replace(/[\\{}_%&#$^~<>]/g, (c) => LATEX_TEXT[c]);
}

/** A key of metadata, escaped, which may break after its `/` and `:`. */
function metadataKey(text) {
  return latexEscape(text).replace(/([/:])/g, '$1\\allowbreak{}');
}

/**
 * The LaTeX of the documentator, its raw texts escaped.
 *
 * @param {string} tex
 * @param {{ autodoc?: boolean }} options  autodoc : the program has no <mdoc>
 *   tag, Faust made the document (title, metadata) ; with tags, the title and
 *   the metadata are the LaTeX of the user, left as they are.
 */
export function fixMathdocTex(tex, { autodoc = false } = {}) {
  let out = tex;
  // The controls : `\textsf{"label"} \ (unit) & $…` (DocCompiler::prepare*UI).
  out = out.replace(/\\textsf\{"(.*?)"\} (?=(?:\\ \(.*?\) | )& \$)/g, (_m, label) => `\\textsf{"${latexEscape(label)}"} `);
  out = out.replace(/\\ \((.*?)\) & \$/g, (_m, unit) => `\\ (${latexEscape(unit)}) & $`);
  // Their groups : `\item \textsf{path}` before a table of controls (Lateq::printHierarchy).
  out = out.replace(
    /(\\item \\textsf\{)([^\n]*)\}(\n\s*\\begin\{center\}\n\s*\\begin\{supertabular\}\{lll\})/g,
    (_m, head, path, tail) => `${head}${latexEscape(path)}}${tail}`,
  );
  if (autodoc) {
    // The head of the autodoc (declareAutoDoc) : title, author, date, then the metadata.
    out = out.replace(
      /\\title\{(.*?)\}(\s*)(?:\\author\{(.*?)\}(\s*))?\\date\{(.*?)\}(\s*)\\maketitle/s,
      (_m, title, s1, author, s2, date, s3) =>
        `\\title{${latexEscape(title)}}${s1}` +
        (author !== undefined ? `\\author{${latexEscape(author)}}${s2}` : '') +
        `\\date{${date === '\\today' ? date : latexEscape(date)}}${s3}\\maketitle`,
    );
    out = out.replace(/(\\maketitle\s*)\\begin\{tabular\}\{ll\}([\s\S]*?)\\end\{tabular\}/, (_m, head, body) => {
      const rows = body.replace(
        /\\textbf\{(.*?)\} & (.*?) \\\\(?=\s*(?:\\textbf\{|\\hline))/gs,
        (_r, key, value) => `\\textbf{${metadataKey(key)}} & ${latexEscape(value)} \\\\`,
      );
      // two columns of paragraphs : the keys and values of the libraries are long
      return `${head}\\begin{tabular}{@{}p{0.36\\textwidth}p{0.6\\textwidth}@{}}${rows}\\end{tabular}`;
    });
  }
  return declareUnicode(out);
}

// ---------------------------------------------------------------------
// The characters beyond ASCII
// ---------------------------------------------------------------------
//
// listings reads its text byte by byte : a character of several bytes of
// UTF-8 is a fatal `Invalid UTF-8 byte sequence (\lst@EC)`, unless the
// `literate` of its \lstset has it ; latexheader.tex has 16 (áàäâéèëêïîöôùûçÇ),
// and the libraries of Faust have π, μ, ≤, → in their comments. Each other
// character of the document gets an entry `{c}{{latex}}1` (the replacement
// in ASCII : the character itself there loops listings), and a
// \DeclareUnicodeCharacter with the same LaTeX for the text outside the
// listings (OT1 lacks the guillemets, Greek, mathematics…).

const GREEK = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi o pi rho varsigma sigma tau upsilon phi chi psi omega'.split(' ');
const GREEK_UPPER = 'A B Gamma Delta E Z H Theta I K Lambda M N Xi O Pi P - Sigma T Upsilon Phi X Psi Omega'.split(' ');

/** The characters set in mathematics. */
const UNICODE_MATH = {
  '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv', '∼': '\\sim', '∝': '\\propto',
  '≪': '\\ll', '≫': '\\gg', '→': '\\rightarrow', '←': '\\leftarrow', '↔': '\\leftrightarrow', '↑': '\\uparrow',
  '↓': '\\downarrow', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↦': '\\mapsto',
  '∞': '\\infty', '√': '\\surd', '∑': '\\sum', '∏': '\\prod', '∫': '\\int', '∂': '\\partial', '∇': '\\nabla',
  '∆': '\\Delta', 'Ω': '\\Omega', '∈': '\\in', '∉': '\\notin', '∀': '\\forall', '∃': '\\exists',
  '∅': '\\emptyset', '∩': '\\cap', '∪': '\\cup', '⊂': '\\subset', '⊆': '\\subseteq', '∘': '\\circ',
  '⋅': '\\cdot', '∙': '\\cdot', '·': '\\cdot', '−': '-', '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div',
  '¬': '\\neg', '°': '^{\\circ}', 'µ': '\\mu', '′': '\\prime', '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil',
  '⌉': '\\rceil', '⟨': '\\langle', '⟩': '\\rangle', '«': '\\ll', '»': '\\gg', '¼': '\\frac{1}{4}', '½': '\\frac{1}{2}',
  '¾': '\\frac{3}{4}', 'ℝ': '\\mathbf{R}', 'ℤ': '\\mathbf{Z}', 'ℕ': '\\mathbf{N}', 'ℂ': '\\mathbf{C}', 'ℚ': '\\mathbf{Q}',
  '¹': '^{1}', '²': '^{2}', '³': '^{3}', '⁺': '^{+}', '⁻': '^{-}', 'ⁿ': '^{n}', '₊': '_{+}', '₋': '_{-}',
};

/** The characters set in text (OT1). */
const UNICODE_TEXT = {
  ' ': '~', 'ß': '\\ss{}', 'æ': '\\ae{}', 'Æ': '\\AE{}', 'œ': '\\oe{}', 'Œ': '\\OE{}', 'ø': '\\o{}', 'Ø': '\\O{}',
  'ł': '\\l{}', 'Ł': '\\L{}', 'ı': '\\i{}', 'å': '\\aa{}', 'Å': '\\AA{}', '¿': '?`', '¡': '!`', '§': '\\S{}', '¶': '\\P{}',
  '©': '\\copyright{}', '£': '\\pounds{}', 'ª': '\\textsuperscript{a}', 'º': '\\textsuperscript{o}',
  '–': '--', '—': '---', '‘': '`', '’': "'", '‚': ',', '“': '``', '”': "''", '„': ',,', '…': '\\ldots{}',
  '€': '\\texteuro{}', '•': '\\textbullet{}', '†': '\\dag{}', '‡': '\\ddag{}', '‹': '\\ensuremath{<}', '›': '\\ensuremath{>}',
};

GREEK.forEach((name, i) => {
  UNICODE_MATH[String.fromCodePoint(0x3b1 + i)] = name.length > 1 ? `\\${name}` : name;
  const up = GREEK_UPPER[i];
  // a capital that looks Latin is the Latin letter (\mathrm stops listings in a comment)
  if (up.length > 1) UNICODE_MATH[String.fromCodePoint(0x391 + i)] = `\\${up}`;
  else if (up !== '-') UNICODE_TEXT[String.fromCodePoint(0x391 + i)] = up;
});
for (let d = 0; d < 10; d++) {
  UNICODE_MATH[String.fromCodePoint(0x2080 + d)] = `_{${d}}`;
  if (d === 0 || d > 3) UNICODE_MATH[String.fromCodePoint(0x2070 + d)] = `^{${d}}`;
}

/** The accents of OT1, by combining mark (NFD). */
const ACCENTS = {
  '̀': '`', '́': "'", '̂': '^', '̃': '~', '̄': '=', '̆': 'u', '̇': '.',
  '̈': '"', '̊': 'r', '̋': 'H', '̌': 'v', '̧': 'c',
};

function hex(ch) {
  return ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
}

/** A character beyond ASCII in LaTeX, written in ASCII : text, mathematics, an accented letter, or its code. */
export function latexOfChar(ch) {
  if (UNICODE_TEXT[ch] !== undefined) return UNICODE_TEXT[ch];
  if (UNICODE_MATH[ch] !== undefined) return `\\ensuremath{${UNICODE_MATH[ch]}}`;
  const [base, ...marks] = [...ch.normalize('NFD')];
  if (marks.length && /^[A-Za-z]$/.test(base)) {
    // an accent OT1 lacks (ogonek…) : the letter alone
    return marks.reduce((acc, m) => (ACCENTS[m] ? `\\${ACCENTS[m]}{${acc}}` : acc), base === 'i' || base === 'j' ? `\\${base}` : base);
  }
  return `{\\ttfamily[U+${hex(ch)}]}`;
}

/** The characters beyond ASCII of the document given to listings and to inputenc. */
export function declareUnicode(tex) {
  const chars = [...new Set([...tex].filter((ch) => ch.codePointAt(0) > 0x7f))].sort();
  if (!chars.length) return tex;
  // columns=flexible drops the space after a replacement of `literate` : keepspaces
  let out = tex.replace(/(\n\s*columns=flexible,)/, '$1 keepspaces=true,');
  const lit = out.match(/(literate=[\s\S]*?)(,\s*\n\s*emph=)/);
  if (lit) {
    const known = new Set([...lit[1].matchAll(/\{([^{}])\}\{/gu)].map((m) => m[1]));
    // \l draws its bar with the character 32 of the font : a visible space in typewriter
    const listed = (ch) => ({ 'ł': 'l', 'Ł': 'L' })[ch] ?? latexOfChar(ch);
    const entries = chars.filter((ch) => !known.has(ch)).map((ch) => `{${ch}}{{${listed(ch)}}}1`);
    if (entries.length) out = out.replace(lit[0], () => `${lit[1]}\n\t\t\t${entries.join(' ')}${lit[2]}`);
  }
  const declared = chars.map((ch) => `\\DeclareUnicodeCharacter{${hex(ch)}}{${latexOfChar(ch)}}`);
  return out.replace(/\n\\begin\{document\}/, (m) => `\n% faustcode : the characters beyond ASCII\n${declared.join('\n')}\n${m}`);
}

/** The SVG the document includes, as paths in the doc directory (`svg/svg-01/process.svg`). */
export function includedSvgs(tex) {
  const paths = new Set();
  for (const m of tex.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{\.\.\/(svg\/[^}]+)\}/g)) {
    paths.add(/\.svg$/i.test(m[1]) ? m[1] : `${m[1]}.svg`);
  }
  return [...paths];
}

const UNIT_PER_INCH = { in: 1, cm: 2.54, mm: 25.4, pt: 72, pc: 6, px: 96, '': 96 };

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`));
  return m ? (m[2] ?? m[3]) : null;
}

/** A length of SVG (`196.9mm`, `50`, `3in`…) in inches, or null. */
function svgLengthInches(value) {
  const m = value && String(value).trim().match(/^([0-9.]+(?:e[-+]?\d+)?)\s*(in|cm|mm|pt|pc|px)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n > 0 ? n / UNIT_PER_INCH[(m[2] || '').toLowerCase()] : null;
}

/**
 * The size in pixels of the PNG of an SVG at `dpi`, kept under the limits of
 * the canvas of the browsers (8192 a side, 16 Mpixels : Safari), and the
 * resolution that gives (lower than `dpi` for a big diagram).
 */
export function svgRasterSize(svgText, dpi = MATHDOC_PNG_DPI, { maxSide = 8192, maxPixels = 16_000_000 } = {}) {
  const tag = (String(svgText).match(/<svg\b[^>]*>/) || [''])[0];
  let wIn = svgLengthInches(attr(tag, 'width'));
  let hIn = svgLengthInches(attr(tag, 'height'));
  const box = (attr(tag, 'viewBox') || '').trim().split(/[\s,]+/).map(Number);
  if ((!wIn || !hIn) && box.length === 4 && box[2] > 0 && box[3] > 0) {
    if (wIn && !hIn) hIn = (wIn * box[3]) / box[2];
    else if (hIn && !wIn) wIn = (hIn * box[2]) / box[3];
    else {
      wIn = box[2] / 96;
      hIn = box[3] / 96;
    }
  }
  if (!wIn || !hIn) throw new Error('SVG without a size');
  let d = dpi;
  d = Math.min(d, maxSide / wIn, maxSide / hIn, Math.sqrt(maxPixels / (wIn * hIn)));
  return { width: Math.max(1, Math.round(wIn * d)), height: Math.max(1, Math.round(hIn * d)), dpi: d };
}

/** The SVG with the width and height of its root set to pixels (its viewBox kept, made if absent). */
export function withSvgSize(svgText, width, height) {
  return String(svgText).replace(/<svg\b[^>]*>/, (tag) => {
    let t = tag;
    if (!attr(t, 'viewBox')) {
      const w = parseFloat(attr(t, 'width')) || width;
      const h = parseFloat(attr(t, 'height')) || height;
      t = t.replace(/^<svg\b/, `<svg viewBox="0 0 ${w} ${h}"`);
    }
    for (const [name, value] of [['width', width], ['height', height]]) {
      const re = new RegExp(`(\\s${name}\\s*=\\s*)("[^"]*"|'[^']*')`);
      t = re.test(t) ? t.replace(re, `$1"${value}"`) : t.replace(/^<svg\b/, `<svg ${name}="${value}"`);
    }
    return t;
  });
}

/** The PNG with a pHYs chunk : its resolution, so pdflatex gives it its size at `dpi`. */
export function setPngDpi(png, dpi) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 33 || sig.some((b, i) => png[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks = [];
  let at = 8;
  while (at + 12 <= png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const end = at + 12 + len;
    if (type !== 'pHYs') chunks.push(png.subarray(at, end));
    at = end;
    if (type === 'IEND') break;
  }
  const ppm = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(21);
  const pv = new DataView(phys.buffer);
  pv.setUint32(0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4); // pHYs
  pv.setUint32(8, ppm);
  pv.setUint32(12, ppm);
  phys[16] = 1; // the unit is the metre
  pv.setUint32(17, crc32(phys.subarray(4, 17)));
  const parts = [png.subarray(0, 8), chunks[0], phys, ...chunks.slice(1)]; // after IHDR
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** README.txt of the archive. */
export function mathdocReadme({ name, lang = 'en', faustVersion = '', appVersion = '', pngs = 0 }) {
  const texFile = `tex/${name}.tex`;
  const w = Math.max(texFile.length, 4) + 3;
  const row = (left, right) => `  ${left.padEnd(w)}${right}`;
  const indent = ' '.repeat(w + 2);
  return `${name}-mdoc : the mathematical documentation of ${name}.dsp
Made by faustcode${appVersion ? ` ${appVersion}` : ''} with Faust${faustVersion ? ` ${faustVersion}` : ''} (faust -mdoc -mdlang ${lang}).

${row(texFile, 'the LaTeX document')}
${row('svg/', `the block diagrams in SVG${pngs ? `, and a PNG (${MATHDOC_PNG_DPI} dpi)\n${indent}of each diagram the document shows` : ''}`)}
${row('src/', 'the Faust sources used, the libraries included (the document')}
${indent}lists the program and the .lib files of faustcode ; with
${indent}<listing dependencies="true"/> in a <mdoc>, the libraries too)
${row('pdf/', 'for the PDF')}
${row('cpp/', 'empty (libfaust in the browser has no C++ backend)')}

To make the PDF (TeX Live or MacTeX ; packages breqn, listings, supertabular,
amsmath) :

  cd tex
  pdflatex -output-directory=../pdf ${name}.tex
  pdflatex -output-directory=../pdf ${name}.tex

(twice, for the references to the figures).

${pngs ? `The document includes the diagrams without an extension : pdflatex takes a .pdf
before a .png. For vector diagrams, make a PDF of each SVG next to it :

  rsvg-convert -f pdf -o process.pdf process.svg
` : `The document includes the diagrams without an extension : make a PDF of each
SVG it includes next to it (rsvg-convert -f pdf -o process.pdf process.svg).
`}`;
}

// ---------------------------------------------------------------------
// libfaust
// ---------------------------------------------------------------------

/** Writes the files of the documentator to the filesystem of libfaust. */
export function installMathdocResources(fs, texts) {
  for (const name of MATHDOC_RESOURCE_FILES) {
    if (typeof texts[name] !== 'string') throw new Error(`mathdoc : ${name} missing`);
    fs.writeFile(`${RESOURCE_DIR}/${name}`, texts[name]);
  }
}

let _resources = null;

/** The files of the documentator, fetched once from vendor/faust-mathdoc/. */
export function loadMathdocResources(base = new URL('./vendor/faust-mathdoc/', import.meta.url)) {
  if (!_resources) {
    _resources = Promise.all(
      MATHDOC_RESOURCE_FILES.map(async (name) => {
        const r = await fetch(new URL(name, base));
        if (!r.ok) throw new Error(`mathdoc : ${name} : HTTP ${r.status}`);
        return [name, await r.text()];
      }),
    ).then(Object.fromEntries);
    _resources.catch(() => {
      _resources = null;
    });
  }
  return _resources;
}

function isDir(fs, path) {
  try {
    return fs.isDir(fs.stat(path).mode);
  } catch {
    return false;
  }
}

function removeTree(fs, path) {
  if (!isDir(fs, path)) {
    try { fs.unlink(path); } catch { /* absent */ }
    return;
  }
  for (const f of fs.readdir(path)) if (f !== '.' && f !== '..') removeTree(fs, `${path}/${f}`);
  try { fs.rmdir(path); } catch { /* kept */ }
}

/** The directories and files under `dir`, as paths under `prefix`, the files as bytes. */
function readTree(fs, dir, prefix) {
  const dirs = [];
  const files = [];
  const walk = (abs, rel) => {
    dirs.push(`${rel}/`);
    for (const f of fs.readdir(abs).filter((x) => x !== '.' && x !== '..').sort()) {
      if (isDir(fs, `${abs}/${f}`)) walk(`${abs}/${f}`, `${rel}/${f}`);
      else files.push({ path: `${rel}/${f}`, data: fs.readFile(`${abs}/${f}`) });
    }
  };
  walk(dir, prefix);
  return { dirs, files };
}

/**
 * Runs the documentator of libfaust on a program. The resources must be
 * installed (installMathdocResources).
 *
 * @param {object} compiler  FaustCompiler (faustwasm)
 * @param {{ code: string, filename?: string, lang?: string, args?: string, libraries?: string[] }} options
 *   args : more options of Faust (the -I of the libraries of faustcode) ;
 *   libraries : the .lib files of faustcode, listed with the program (shortenListings),
 *   unless the code has <listing dependencies="true"/> : then all are
 * @returns {{ name: string, dirs: string[], files: { path: string, data: Uint8Array }[] }}
 *   paths under `<name>-mdoc/`, the .tex fixed (fixMathdocTex)
 */
export function runMathdoc(compiler, { code, filename = 'faust.dsp', lang = 'en', args = '', libraries = [] }) {
  if (!MATHDOC_LANGS.some((l) => l.code === lang)) throw new Error(`mathdoc : no language ${lang}`);
  const fs = compiler.fs();
  const name = mathdocName(filename);
  const dir = `/${name}-mdoc`;
  const src = `/${name}.dsp`;
  removeTree(fs, dir);
  fs.writeFile(src, code);
  let error = '';
  let tree = null;
  try {
    let ok = false;
    try {
      ok = compiler.generateAuxFiles(`${name}.dsp`, code, `-lang wasm -o binary -mdoc -mdlang ${lang} ${args}`.trim());
    } catch (err) {
      error = compiler.getErrorMessage() || (err && err.message) || 'mathdoc : the compilation threw';
    }
    if (!ok && !error) error = compiler.getErrorMessage() || 'mathdoc : the compilation failed';
    if (!error) tree = readTree(fs, dir, `${name}-mdoc`);
  } finally {
    removeTree(fs, dir);
    removeTree(fs, src);
  }
  if (error) throw new Error(String(error).trim());
  const texPath = `${name}-mdoc/tex/${name}.tex`;
  const tex = tree.files.find((f) => f.path === texPath);
  if (!tex) throw new Error(`mathdoc : ${texPath} not made`);
  let text = new TextDecoder().decode(tex.data);
  if (!wantsDependencies(code)) {
    let texts = {};
    try {
      texts = mathdocTexts(fs.readFile(`${RESOURCE_DIR}/mathdoctexts-${lang}.txt`, { encoding: 'utf8' }));
    } catch { /* the titles of several listings kept */ }
    text = shortenListings(text, { keep: [`${name}.dsp`, ...libraries], texts });
  }
  tex.data = new TextEncoder().encode(fixMathdocTex(text, { autodoc: !hasMdocTag(code) }));
  return { name, ...tree };
}

/**
 * The .zip of the documentation : what runMathdoc made, a PNG of each SVG
 * the document includes (by `rasterize`, when given) and README.txt.
 *
 * @param {{ name: string, dirs: string[], files: { path: string, data: Uint8Array }[] }} doc
 * @param {{ rasterize?: (svg: string) => Promise<Uint8Array>, lang?: string,
 *           faustVersion?: string, appVersion?: string }} [options]
 * @returns {Promise<{ filename: string, bytes: Uint8Array, warnings: string[] }>}
 */
export async function packMathdoc(doc, { rasterize, lang = 'en', faustVersion = '', appVersion = '' } = {}) {
  const root = `${doc.name}-mdoc`;
  const decoder = new TextDecoder();
  const byPath = new Map(doc.files.map((f) => [f.path, f]));
  const tex = byPath.get(`${root}/tex/${doc.name}.tex`);
  const warnings = [];
  const extra = [];
  if (rasterize && tex) {
    for (const svgPath of includedSvgs(decoder.decode(tex.data))) {
      const svg = byPath.get(`${root}/${svgPath}`);
      if (!svg) continue;
      try {
        extra.push({ path: `${root}/${svgPath.replace(/\.svg$/i, '.png')}`, data: await rasterize(decoder.decode(svg.data)) });
      } catch (err) {
        warnings.push(`${svgPath} : no PNG (${err && err.message ? err.message : err})`);
      }
    }
  }
  const readme = mathdocReadme({ name: doc.name, lang, faustVersion, appVersion, pngs: extra.length });
  const entries = [
    ...doc.dirs.map((path) => ({ path })),
    { path: `${root}/README.txt`, data: readme },
    ...[...doc.files, ...extra].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  ];
  return { filename: `${root}.zip`, bytes: await makeZip(entries), warnings };
}

// ---------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------

/** A PNG of an SVG, drawn by the browser (an <img> on a canvas), at `dpi`. */
export async function rasterizeSvg(svgText, dpi = MATHDOC_PNG_DPI) {
  const size = svgRasterSize(svgText, dpi);
  const url = URL.createObjectURL(new Blob([withSvgSize(svgText, size.width, size.height)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(img, 0, 0, size.width, size.height);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the canvas made no PNG'))), 'image/png'),
    );
    return setPngDpi(new Uint8Array(await blob.arrayBuffer()), size.dpi);
  } finally {
    URL.revokeObjectURL(url);
  }
}
