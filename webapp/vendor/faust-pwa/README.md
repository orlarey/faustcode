# faust-pwa

The templates of `faust2wasm -pwa` (`assets/standalone/` of
[@grame/faustwasm](https://www.npmjs.com/package/@grame/faustwasm) 0.20.1, the
version of `webapp/faustwasm/`), copied unchanged except the
`sourceMappingURL` comments of `faust-ui/` (the maps are not copied) and
one fix in `faust-pwa.js` : the service worker was registered on the `load`
event of the window, which has passed when `index.js` imports `faust-pwa.js`
(a dynamic import) ; it is now registered at once when the page is loaded,
so the PWA works offline (the PWAs of `faust2wasm -pwa` 0.20.1 have the bug).
`webapp/pwa-export.js` fills them as `copyWebPWAAssets` does
(`FAUST_DSP_NAME`, `VERSION_DATE`, `FAUST_DSP_VOICES`, `FAUST_DSP_HAS_EFFECT`)
and adds `faustwasm/index.js` (the one of the page) and the compiled DSP.

| here | in the PWA |
|---|---|
| `index-pwa.html` | `index.html` |
| `index-pwa.js` | `index.js` |
| `faust-pwa.js`, `create-node.js`, `service-worker.js`, `manifest.json`, `icon.png`, `faust-ui/` | same names |

Copyright (C) 2021-2026 GRAME, Centre National de Création Musicale ;
LGPL-2.1 (the license of faustwasm). Update them with faustwasm.
