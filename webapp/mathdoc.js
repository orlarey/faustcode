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
//     escaped : a `_`, `%` or `&` in them stops pdflatex ;
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
  const bare = String(code).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"/g, ' ');
  return /<mdoc>/.test(bare);
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
  return out;
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
${row('src/', 'the Faust sources used, the libraries included')}
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
 * @param {{ code: string, filename?: string, lang?: string, args?: string }} options
 *   args : more options of Faust (the -I of the libraries of faustcode)
 * @returns {{ name: string, dirs: string[], files: { path: string, data: Uint8Array }[] }}
 *   paths under `<name>-mdoc/`, the .tex fixed (fixMathdocTex)
 */
export function runMathdoc(compiler, { code, filename = 'faust.dsp', lang = 'en', args = '' }) {
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
  tex.data = new TextEncoder().encode(fixMathdocTex(new TextDecoder().decode(tex.data), { autodoc: !hasMdocTag(code) }));
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
