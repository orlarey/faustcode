// pwa-export.test.mjs — node --test webapp/pwa-export.test.mjs
// The filling of the templates, then a mono and a polyphonic PWA compiled by
// the embedded libfaust-wasm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PWA_TEMPLATES, compilePwaDsp, fillTemplate, packPwa, pwaEntries, pwaName, pwaReadme, versionDate } from './pwa-export.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

function templates() {
  return Object.fromEntries(
    Object.values(PWA_TEMPLATES).map((f) => [f, f.endsWith('.png') ? new Uint8Array(readFileSync(here(`./vendor/faust-pwa/${f}`))) : readFileSync(here(`./vendor/faust-pwa/${f}`), 'utf8')]),
  );
}

test('pwaName', () => {
  assert.equal(pwaName('Wahoo.dsp'), 'Wahoo');
  assert.equal(pwaName('my_synth v2.dsp'), 'my_synth-v2');
  assert.equal(pwaName('Écho "x".dsp'), 'Echo-x');
  assert.equal(pwaName(''), 'faust');
});

test('versionDate : YYYYMMDD-HHmm', () => {
  assert.equal(versionDate(new Date(2026, 10, 5, 9, 7)), '20261105-0907');
});

test('fillTemplate : the name, the stamp, the voices of the run view, the effect', () => {
  const t = 'const FAUST_DSP_VOICES = 0;\nconst FAUST_DSP_HAS_EFFECT = false;\nconst CACHE_NAME = "FAUST_DSP_NAME_VERSION_DATE";';
  assert.equal(fillTemplate(t, { name: 'Organ', version: '20261115-1400' }),
    'const FAUST_DSP_VOICES = 0;\nconst FAUST_DSP_HAS_EFFECT = false;\nconst CACHE_NAME = "Organ_20261115-1400";');
  assert.equal(fillTemplate(t, { name: 'Organ', version: 'v', voices: 8, hasEffect: true }),
    'const FAUST_DSP_VOICES = 8;\nconst FAUST_DSP_HAS_EFFECT = true;\nconst CACHE_NAME = "Organ_v";');
  // the effect only for a polyphonic DSP (copyWebPWAAssets)
  assert.match(fillTemplate(t, { name: 'O', version: 'v', voices: 0, hasEffect: true }), /HAS_EFFECT = false/);
});

test('the templates of vendor/faust-pwa have what fillTemplate replaces', () => {
  const t = templates();
  assert.match(t['index-pwa.js'], /const FAUST_DSP_VOICES = 0;/);
  assert.match(t['service-worker.js'], /const FAUST_DSP_VOICES = 0;/);
  assert.match(t['service-worker.js'], /const FAUST_DSP_HAS_EFFECT = false;/);
  assert.match(t['create-node.js'], /const FAUST_DSP_HAS_EFFECT = false;/);
  assert.match(t['service-worker.js'], /"FAUST_DSP_NAME_VERSION_DATE"/);
  assert.match(t['manifest.json'], /FAUST_DSP_NAME/);
  // the fix of faust-pwa.js : the service worker registered when the page is already loaded
  assert.match(t['faust-pwa.js'], /if \(document\.readyState === "complete"\) register\(\);/);
  // the faustwasm of the page is the one the templates were made with
  const pkgFaustwasm = readFileSync(here('./faustwasm/index.js'), 'utf8');
  assert.match(pkgFaustwasm, /var FaustPolyDspGenerator/);
});

let _faust = null;
async function faust() {
  if (_faust) return _faust;
  const mod = await import('./faustwasm/index.js');
  const base = here('./libfaust-wasm/libfaust-wasm.js');
  const em = await mod.instantiateFaustModuleFromFile(base, base.replace(/\.js$/, '.data'), base.replace(/\.js$/, '.wasm'));
  _faust = { compiler: new mod.FaustCompiler(new mod.LibFaust(em)), FaustMonoDspGenerator: mod.FaustMonoDspGenerator, FaustPolyDspGenerator: mod.FaustPolyDspGenerator };
  return _faust;
}

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const isWasm = (bytes) => WASM_MAGIC.every((b, i) => bytes[i] === b);
const byPath = (entries) => Object.fromEntries(entries.map((e) => [e.path, e.data]));

test('a mono PWA : the files of faust2wasm -pwa, filled', async () => {
  const f = await faust();
  const dsp = await compilePwaDsp(f, { code: 'import("stdfaust.lib");\nprocess = os.osc(hslider("freq", 440, 20, 2000, 1)) * 0.1;', name: 'Osc', voices: 0, args: '-ftz 2' });
  const files = byPath(pwaEntries({ name: 'Osc', version: '20261115-1400', templates: templates(), faustwasm: '/* faustwasm */', dsp, readme: pwaReadme({ name: 'Osc' }) }));
  assert.deepEqual(Object.keys(files).sort(), [
    'Osc-pwa/', 'Osc-pwa/README.txt', 'Osc-pwa/create-node.js', 'Osc-pwa/dsp-meta.json', 'Osc-pwa/dsp-module.wasm',
    'Osc-pwa/faust-pwa.js', 'Osc-pwa/faust-ui/', 'Osc-pwa/faust-ui/index.css', 'Osc-pwa/faust-ui/index.js',
    'Osc-pwa/faustwasm/', 'Osc-pwa/faustwasm/index.js', 'Osc-pwa/icon.png', 'Osc-pwa/index.html', 'Osc-pwa/index.js',
    'Osc-pwa/manifest.json', 'Osc-pwa/service-worker.js',
  ]);
  assert.ok(isWasm(files['Osc-pwa/dsp-module.wasm']));
  const meta = JSON.parse(files['Osc-pwa/dsp-meta.json']);
  assert.equal(meta.name, 'Osc');
  assert.match(meta.compile_options, /-ftz 2/);
  assert.equal(JSON.parse(files['Osc-pwa/manifest.json']).short_name, 'Osc');
  assert.match(files['Osc-pwa/index.js'], /dspName: "Osc", voices: FAUST_DSP_VOICES/);
  assert.match(files['Osc-pwa/index.js'], /const FAUST_DSP_VOICES = 0;/);
  assert.match(files['Osc-pwa/service-worker.js'], /const CACHE_NAME = "Osc_20261115-1400";/);
  for (const [path, data] of Object.entries(files)) {
    if (typeof data === 'string') assert.doesNotMatch(data, /FAUST_DSP_NAME|VERSION_DATE/, path);
  }
  assert.deepEqual(files['Osc-pwa/icon.png'].subarray(0, 4), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
});

test('a polyphonic PWA with its effect : the voices of the run view, the mixer, the effect', async () => {
  const f = await faust();
  const code = 'import("stdfaust.lib");\nprocess = os.osc(hslider("freq", 440, 20, 2000, 1)) * hslider("gain", 0.5, 0, 1, 0.01) * button("gate");\neffect = _ <: _, _;';
  const dsp = await compilePwaDsp(f, { code, name: 'Synth', voices: 8, args: '-ftz 2' });
  assert.ok(dsp.effectModule && dsp.mixerModule);
  const pack = await packPwa({ name: 'Synth', voices: 8, version: 'v', templates: templates(), faustwasm: '', dsp });
  assert.equal(pack.filename, 'Synth-pwa.zip');
  assert.equal(pack.hasEffect, true);
  const files = byPath(pwaEntries({ name: 'Synth', voices: 8, version: 'v', templates: templates(), faustwasm: '', dsp }));
  for (const p of ['Synth-pwa/mixer-module.wasm', 'Synth-pwa/effect-module.wasm', 'Synth-pwa/dsp-module.wasm']) assert.ok(isWasm(files[p]), p);
  assert.equal(JSON.parse(files['Synth-pwa/effect-meta.json']).outputs, 2);
  assert.match(files['Synth-pwa/index.js'], /const FAUST_DSP_VOICES = 8;/);
  assert.match(files['Synth-pwa/service-worker.js'], /const FAUST_DSP_VOICES = 8;\n[\s\S]*const FAUST_DSP_HAS_EFFECT = true;/);
  assert.match(files['Synth-pwa/create-node.js'], /const FAUST_DSP_HAS_EFFECT = true;/);
});

test('a code that does not compile : the error of Faust', async () => {
  const f = await faust();
  await assert.rejects(compilePwaDsp(f, { code: 'process = foo;', name: 'Bad', voices: 0, args: '-ftz 2' }), /foo/);
});
