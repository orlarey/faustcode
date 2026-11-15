# faust-mathdoc

The files the documentator of Faust (`faust -mdoc`) reads, which the
`.data` bundle of libfaust-wasm does not carry : `webapp/mathdoc.js` writes
them to `/usr/share/faust/` of its virtual filesystem before a `-mdoc`.

- `latexheader.tex` : the head of the LaTeX document (packages, listings) ;
- `mathdoctexts-<lang>.txt` : the texts of the document, for `-mdlang`
  (`default` is `en`).

Copied unchanged from [grame-cncm/faust](https://github.com/grame-cncm/faust),
`architecture/`, branch `master-dev`, on 2026-11-15. Copyright (C) 2009 GRAME,
Centre National de Création Musicale ; under the license of the architecture
files of Faust. Update them with libfaust-wasm when the documentator changes.
