// mathdoc.test.mjs — node --test webapp/mathdoc.test.mjs
// The pure parts, then the documentator of the embedded libfaust-wasm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MATHDOC_RESOURCE_FILES,
  fixMathdocTex,
  hasMdocTag,
  includedSvgs,
  installMathdocResources,
  latexEscape,
  mathdocName,
  packMathdoc,
  runMathdoc,
  setPngDpi,
  svgRasterSize,
  withSvgSize,
} from './mathdoc.js';
import { crc32 } from './zip.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

test('mathdocName : the base name, reduced for LaTeX', () => {
  assert.equal(mathdocName('Wahoo.dsp'), 'Wahoo');
  assert.equal(mathdocName('my_synth v2.DSP'), 'my-synth-v2');
  assert.equal(mathdocName('Été.dsp'), 'Ete');
  assert.equal(mathdocName('dir/x.dsp'), 'x');
  assert.equal(mathdocName('___.dsp'), 'faust');
  assert.equal(mathdocName(undefined), 'faust');
});

test('hasMdocTag : not in a comment nor a string', () => {
  assert.equal(hasMdocTag('<mdoc>x</mdoc>\nprocess=_;'), true);
  assert.equal(hasMdocTag('// <mdoc>x</mdoc>\nprocess=_;'), false);
  assert.equal(hasMdocTag('/* <mdoc>\n</mdoc> */ process=_;'), false);
  assert.equal(hasMdocTag('declare d "<mdoc>"; process=_;'), false);
});

test('latexEscape', () => {
  assert.equal(latexEscape('a_b %c & d#$ {e} ~ ^ \\ <f@g>'), 'a\\_b \\%c \\& d\\#\\$ \\{e\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{} $<$f@g$>$');
  assert.equal(latexEscape('Français é'), 'Français é');
});

test('fixMathdocTex : the controls, their units and groups', () => {
  const tex = [
    '\\begin{itemize}',
    '\t\\item \\textsf{Main_1/}',
    '\t\t\\begin{center}',
    '\t\t\t\\begin{supertabular}{lll}',
    '\t\t\t\t\\textsf{"level"} \\ (%) & ${u_s}_{1}(t)$ $\\in$ $\\left[\\,0, 100\\,\\right]$ & $(\\mbox{default value} = 50)$\\\\',
    '\t\t\t\t\\textsf{"on & off"}  & ${u_c}_{1}(t)$ $\\in$ $\\left\\{\\,0, 1\\,\\right\\}$ & $(\\mbox{default value} = 0)$\\\\',
    '\t\t\t\t\\textsf{"freq_hz"} \\ (Hz) & ${u_s}_{2}(t)$',
    '\\item \\textsf{user_text} kept',
  ].join('\n');
  const out = fixMathdocTex(tex).split('\n');
  assert.equal(out[1], '\t\\item \\textsf{Main\\_1/}');
  assert.match(out[4], /^\t+\\textsf\{"level"\} \\ \(\\%\) & \$\{u_s\}_\{1\}\(t\)\$/);
  assert.match(out[5], /^\t+\\textsf\{"on \\& off"\}  & \$\{u_c\}_\{1\}/);
  assert.match(out[6], /^\t+\\textsf\{"freq\\_hz"\} \\ \(Hz\) & \$\{u_s\}_\{2\}/);
  assert.equal(out[7], '\\item \\textsf{user_text} kept'); // not before a table of controls
});

const AUTODOC_HEAD =
  '\\title{my_synth} \\author{A & B} \\date{\\today} \\maketitle \\begin{tabular}{ll}  \\hline  ' +
  '\\textbf{compile_options} & -lang wasm -ct 1 \\\\  ' +
  '\\textbf{filters.lib/lowpass0_highpass1:copyright} & Copyright (C) 2003-2019 by Julius O. Smith III <jos@ccrma.stanford.edu> \\\\  ' +
  '\\textbf{name} & my_synth \\\\  \\hline  \\end{tabular} \\bigskip';

test('fixMathdocTex : the head of the autodoc', () => {
  const out = fixMathdocTex(AUTODOC_HEAD, { autodoc: true });
  assert.ok(out.startsWith('\\title{my\\_synth} \\author{A \\& B} \\date{\\today} \\maketitle \\begin{tabular}{@{}p{0.36\\textwidth}p{0.6\\textwidth}@{}}'), out);
  assert.ok(out.includes('\\textbf{compile\\_options} & -lang wasm -ct 1 \\\\'));
  assert.ok(out.includes('\\textbf{filters.lib/\\allowbreak{}lowpass0\\_highpass1:\\allowbreak{}copyright} & Copyright (C) 2003-2019 by Julius O. Smith III $<$jos@ccrma.stanford.edu$>$ \\\\'));
  assert.ok(out.includes('\\textbf{name} & my\\_synth \\\\  \\hline  \\end{tabular} \\bigskip'));
  // with <mdoc> tags, the title and the tables are the LaTeX of the user
  assert.equal(fixMathdocTex(AUTODOC_HEAD), AUTODOC_HEAD);
});

test('includedSvgs', () => {
  const tex = '\\includegraphics[width=\\textwidth]{../svg/svg-01/process}\n\\includegraphics{../svg/svg-02/a.svg}\n\\includegraphics{other}';
  assert.deepEqual(includedSvgs(tex), ['svg/svg-01/process.svg', 'svg/svg-02/a.svg']);
});

test('svgRasterSize : mm at 300 dpi, the limits of the canvas', () => {
  const svg = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 393.8 100" width="196.9mm" height="50mm" version="1.1">';
  assert.deepEqual(svgRasterSize(svg, 300), { width: 2326, height: 591, dpi: 300 });
  const big = svgRasterSize('<svg viewBox="0 0 4000 2000" width="2000mm" height="1000mm">', 300);
  assert.ok(big.width <= 8192 && big.width * big.height <= 16_000_000, JSON.stringify(big));
  assert.ok(Math.abs(big.width / big.height - 2) < 0.01);
  assert.deepEqual(svgRasterSize('<svg viewBox="0 0 96 48">', 96), { width: 96, height: 48, dpi: 96 });
  assert.throws(() => svgRasterSize('<svg>'), /without a size/);
});

test('withSvgSize : pixels on the root, the viewBox kept', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 393.8 100" width="196.9mm" height="50mm"><rect width="5mm"/></svg>';
  assert.equal(withSvgSize(svg, 2326, 591), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 393.8 100" width="2326" height="591"><rect width="5mm"/></svg>');
  assert.equal(withSvgSize('<svg width="10" height="5">', 20, 10), '<svg viewBox="0 0 10 5" width="20" height="10">');
});

/** A PNG of 1×1 pixel, made by hand : IHDR, IDAT, IEND. */
function tinyPng() {
  const chunk = (type, data) => {
    const c = new Uint8Array(12 + data.length);
    const v = new DataView(c.buffer);
    v.setUint32(0, data.length);
    c.set(new TextEncoder().encode(type), 4);
    c.set(data, 8);
    v.setUint32(8 + data.length, crc32(c.subarray(4, 8 + data.length)));
    return c;
  };
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]);
  const idat = new Uint8Array([0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('pHYs', new Uint8Array(9)), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function pngChunks(png) {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const list = [];
  for (let at = 8; at < png.length; ) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    assert.equal(v.getUint32(at + 8 + len), crc32(png.subarray(at + 4, at + 8 + len)), `CRC of ${type}`);
    list.push({ type, data: png.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
  }
  return list;
}

test('setPngDpi : one pHYs after IHDR, in pixels per metre', () => {
  const out = setPngDpi(tinyPng(), 300);
  const chunks = pngChunks(out);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'pHYs', 'IDAT', 'IEND']);
  const v = new DataView(chunks[1].data.buffer, chunks[1].data.byteOffset, 9);
  assert.equal(v.getUint32(0), 11811);
  assert.equal(v.getUint32(4), 11811);
  assert.equal(chunks[1].data[8], 1);
  assert.throws(() => setPngDpi(new Uint8Array(40), 300), /not a PNG/);
});

// ---------------------------------------------------------------------
// The documentator of libfaust-wasm
// ---------------------------------------------------------------------

let _compiler = null;
async function compiler() {
  if (_compiler) return _compiler;
  const { LibFaust, FaustCompiler, instantiateFaustModuleFromFile } = await import('./faustwasm/index.js');
  const base = here('./libfaust-wasm/libfaust-wasm.js');
  const em = await instantiateFaustModuleFromFile(base, base.replace(/\.js$/, '.data'), base.replace(/\.js$/, '.wasm'));
  _compiler = new FaustCompiler(new LibFaust(em));
  const texts = Object.fromEntries(MATHDOC_RESOURCE_FILES.map((f) => [f, readFileSync(here(`./vendor/faust-mathdoc/${f}`), 'utf8')]));
  installMathdocResources(_compiler.fs(), texts);
  return _compiler;
}

const text = (doc, path) => new TextDecoder().decode(doc.files.find((f) => f.path === path).data);

test('runMathdoc : the autodoc of a program, in French, with a library of faustcode', async () => {
  const c = await compiler();
  const fs = c.fs();
  try { fs.mkdir('/mathdoc-test-libs'); } catch {}
  fs.writeFile('/mathdoc-test-libs/mine.lib', 'gain(g) = *(g);');
  const code = 'declare name "my_synth";\nimport("stdfaust.lib");\nm = library("mine.lib");\n' +
    'process = fi.lowpass(2, hslider("freq_hz[unit:%]", 1000, 20, 20000, 1)) : m.gain(0.5);';
  const doc = runMathdoc(c, { code, filename: 'my synth.dsp', lang: 'fr', args: '-I /mathdoc-test-libs/' });
  assert.equal(doc.name, 'my-synth');
  for (const d of ['tex', 'svg', 'src', 'cpp', 'pdf']) assert.ok(doc.dirs.includes(`my-synth-mdoc/${d}/`), d);
  const paths = doc.files.map((f) => f.path);
  assert.ok(paths.includes('my-synth-mdoc/src/my-synth.dsp'));
  assert.ok(paths.includes('my-synth-mdoc/src/mine.lib'));
  assert.ok(paths.includes('my-synth-mdoc/src/filters.lib'));
  assert.ok(paths.includes('my-synth-mdoc/svg/svg-01/process.svg'));
  const tex = text(doc, 'my-synth-mdoc/tex/my-synth.tex');
  assert.match(tex, /\\begin\{document\}/);
  assert.match(tex, /\\end\{document\}/);
  assert.match(tex, /Signal de sortie/); // -mdlang fr
  assert.match(tex, /\\title\{my\\_synth\}/);
  assert.match(tex, /\\textbf\{compile\\_options\}/);
  assert.match(tex, /\\textsf\{"freq\\_hz"\} \\ \(\\%\) & \$/);
  assert.doesNotMatch(tex.slice(0, tex.indexOf('\\begin{lstlisting}[caption')), /\\textbf\{[^}]*[^\\]_/);
  assert.deepEqual(includedSvgs(tex), ['svg/svg-01/process.svg']);
  // nothing left in the filesystem of libfaust
  assert.ok(!fs.readdir('/').some((f) => /^my-synth/.test(f)));
});

test('runMathdoc : <mdoc> tags, and a program that does not compile', async () => {
  const c = await compiler();
  const code = '<mdoc>\n\\section{Le gain}\nUn \\emph{gain}. <equation>process</equation> <diagram>process</diagram>\n</mdoc>\nprocess = *(hslider("g", 0.5, 0, 1, 0.01));';
  const doc = runMathdoc(c, { code, filename: 'Gain.dsp' });
  const tex = text(doc, 'Gain-mdoc/tex/Gain.tex');
  assert.match(tex, /\\section\{Le gain\} Un \\emph\{gain\}\./);
  assert.doesNotMatch(tex, /\\maketitle/); // no autodoc
  assert.throws(() => runMathdoc(c, { code: 'process = foo;', filename: 'Bad.dsp' }), /foo/);
  assert.ok(!c.fs().readdir('/').some((f) => /^Bad/.test(f)));
  // the compiler still works after the error
  assert.ok(runMathdoc(c, { code: 'process = +;', filename: 'Ok.dsp' }).files.length > 0);
  assert.throws(() => runMathdoc(c, { code: 'process = +;', lang: 'xx' }), /no language/);
});

test('packMathdoc : the archive, its README and the PNG of the diagrams', async () => {
  const c = await compiler();
  const doc = runMathdoc(c, { code: 'process = _ <: _, @(10);', filename: 'Echo.dsp' });
  const seen = [];
  const pack = await packMathdoc(doc, {
    rasterize: async (svg) => { seen.push(svg.slice(0, 200)); return new Uint8Array([1, 2, 3]); },
    faustVersion: '2.90.19',
    appVersion: '9.9.9',
  });
  assert.equal(pack.filename, 'Echo-mdoc.zip');
  assert.equal(seen.length, 1);
  assert.match(seen[0], /<svg/);
  assert.deepEqual(pack.warnings, []);
  const names = new TextDecoder('latin1').decode(pack.bytes);
  for (const p of ['Echo-mdoc/README.txt', 'Echo-mdoc/tex/Echo.tex', 'Echo-mdoc/svg/svg-01/process.png', 'Echo-mdoc/pdf/']) assert.ok(names.includes(p), p);
  const failed = await packMathdoc(doc, { rasterize: async () => { throw new Error('no canvas'); } });
  assert.deepEqual(failed.warnings, ['svg/svg-01/process.svg : no PNG (no canvas)']);
});
