// mathdoc-export.js — File ▸ Math documentation : the .zip of the
// mathematical documentation of a program (faust -mdoc, mathdoc.js),
// made with the libfaust of the page and the .lib files of faustcode,
// its diagrams drawn in PNG by the browser, then downloaded.

import { getFaust } from './faust.js';
import { injectLibsIntoFs, LIB_INCLUDE_ARG } from './lib-inject.js';
import { libSessionsForCompile } from './files.js';
import { installMathdocResources, loadMathdocResources, packMathdoc, rasterizeSvg, runMathdoc } from './mathdoc.js';

function downloadBytes(filename, bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Makes and downloads `<name>-mdoc.zip`.
 *
 * @param {{ code: string, filename: string, lang: string, appVersion?: string }} options
 * @returns {Promise<{ filename: string, warnings: string[] }>}
 * @throws the errors of Faust when the code does not compile
 */
export async function exportMathdoc({ code, filename, lang, appVersion = '' }) {
  const [faust, texts] = await Promise.all([getFaust(), loadMathdocResources()]);
  const { compiler } = faust;
  const fs = compiler.fs();
  installMathdocResources(fs, texts);
  const libs = libSessionsForCompile();
  injectLibsIntoFs(fs, libs);
  const doc = runMathdoc(compiler, { code, filename, lang, args: LIB_INCLUDE_ARG, libraries: libs.map((l) => l.filename) });
  const pack = await packMathdoc(doc, {
    rasterize: (svg) => rasterizeSvg(svg),
    lang,
    faustVersion: faust.version,
    appVersion,
  });
  downloadBytes(pack.filename, pack.bytes, 'application/zip');
  return { filename: pack.filename, warnings: pack.warnings };
}
