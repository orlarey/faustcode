// app-publish.test.mjs — node --test webapp/app-publish.test.mjs
// Share ▸ Publish ▸ As an app, against a GitHub in memory : the commit
// (blobs, tree, commit, ref), the index of the store untouched by apps/,
// GitHub Pages deploying after a few polls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Publishing, StoreReader } from './vendor/fauststore/fauststore.js';
import {
  appCommitMessage, appIsLive, appStoreFiles, pagesBase, pagesSettingsUrl, pagesSite, publishApp,
  publishedAppFor, rememberPublishedApp, waitForApp,
} from './app-publish.js';
import { PWA_TEMPLATES, appFingerprint, compilePwaDsp, pwaEntries } from './pwa-export.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

test('pagesBase : owner.github.io/repo/, or the root for owner.github.io', () => {
  assert.equal(pagesBase({ owner: 'Orlarey', repo: 'faust-store' }), 'https://orlarey.github.io/faust-store/');
  assert.equal(pagesBase({ owner: 'orlarey', repo: 'Orlarey.github.io' }), 'https://orlarey.github.io/');
  assert.equal(pagesSettingsUrl({ owner: 'o', repo: 's' }), 'https://github.com/o/s/settings/pages');
});

test('appStoreFiles : apps/<name>/, no README, .nojekyll', () => {
  const files = appStoreFiles([
    { path: 'Osc-pwa/' }, { path: 'Osc-pwa/index.html', data: '<html>' }, { path: 'Osc-pwa/faust-ui/' },
    { path: 'Osc-pwa/faust-ui/index.js', data: 'js' }, { path: 'Osc-pwa/dsp-module.wasm', data: new Uint8Array([0, 97, 115, 109]) },
    { path: 'Osc-pwa/README.txt', data: 'x' },
  ], 'Osc');
  assert.deepEqual([...files.keys()], ['apps/Osc/index.html', 'apps/Osc/faust-ui/index.js', 'apps/Osc/dsp-module.wasm', '.nojekyll']);
  assert.ok(files.get('apps/Osc/dsp-module.wasm') instanceof Uint8Array);
  assert.equal(appCommitMessage('Osc', 0), 'Publish the app Osc (faustcode)');
  assert.equal(appCommitMessage('Osc', 8), 'Publish the app Osc (8 voices) (faustcode)');
});

test('the records of the published apps : by fingerprint, the newest first', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(publishedAppFor('a', storage), null);
  rememberPublishedApp({ fingerprint: 'a', url: 'u1' }, storage);
  rememberPublishedApp({ fingerprint: 'b', url: 'u2' }, storage);
  rememberPublishedApp({ fingerprint: 'a', url: 'u1', commit: 'c2' }, storage);
  assert.equal(publishedAppFor('a', storage).commit, 'c2');
  assert.equal(JSON.parse(store.get('faustcode.published-apps')).length, 2);
  assert.equal(publishedAppFor('a', undefined), null); // no storage : no record, no error
});

/** A repository o/s on a GitHub in memory, with GitHub Pages deploying after `deployAfter` polls. */
function fakeGitHub({ pages = 'enabled', deployAfter = 2 } = {}) {
  const tree = new Map([['fauststore.json', JSON.stringify({ format: 'fauststore', version: 1, name: 'S' })], ['modules/A/A.dsp', 'process = _;\n']]);
  const blobs = new Map();
  let commitN = 0;
  let head = 'c0';
  const trees = new Map();
  const commits = new Map([['c0', { tree: 't0' }]]);
  trees.set('t0', new Map(tree));
  let deployed = new Map(tree);
  let polls = 0;
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = new URL(url);
    calls.push(`${method} ${u.host}${u.pathname}`);
    if (u.host === 'api.github.com') {
      const p = u.pathname.replace('/repos/o/s', '');
      if (p === '/pages') return pages === 'enabled' ? json({ html_url: 'https://o.github.io/s/' }) : json({ message: 'Not Found' }, 404);
      if (p === '' && method === 'GET') return json({ default_branch: 'main', permissions: { push: true }, private: false });
      if (p === '/git/ref/heads/main') return json({ object: { sha: head } });
      let m;
      if ((m = p.match(/^\/git\/commits\/(\w+)$/))) return json({ tree: { sha: commits.get(m[1]).tree } });
      if ((m = p.match(/^\/git\/trees\/(\w+)$/)) && method === 'GET') {
        return json({ tree: [...trees.get(m[1]).keys()].map((path) => ({ path, type: 'blob', sha: path })) });
      }
      if (p.startsWith('/contents/')) {
        const at = commits.get(u.searchParams.get('ref') || head);
        const data = at ? trees.get(at.tree).get(decodeURIComponent(p.slice('/contents/'.length))) : undefined;
        return data === undefined ? json({ message: 'Not Found' }, 404) : new Response(data);
      }
      const body = init.body ? JSON.parse(init.body) : null;
      if (p === '/git/blobs') {
        const sha = `b${blobs.size}`;
        blobs.set(sha, Uint8Array.from(Buffer.from(body.content, 'base64')));
        return json({ sha });
      }
      if (p === '/git/trees') {
        const t = new Map(trees.get(commits.get(head).tree));
        for (const e of body.tree) t.set(e.path, e.content ?? blobs.get(e.sha));
        const sha = `t${trees.size}`;
        trees.set(sha, t);
        return json({ sha });
      }
      if (p === '/git/commits') {
        const sha = `c${++commitN}`;
        commits.set(sha, { tree: body.tree });
        return json({ sha });
      }
      if (p === '/git/refs/heads/main' && method === 'PATCH') {
        head = body.sha;
        return json({});
      }
    }
    if (u.host === 'raw.githubusercontent.com') return new Response('', { status: 404 });
    if (u.host === 'o.github.io' && u.pathname.startsWith('/s/')) {
      if (++polls > deployAfter) deployed = new Map(trees.get(commits.get(head).tree));
      const path = u.pathname.slice('/s/'.length);
      const data = deployed.get(path);
      return data === undefined ? new Response('', { status: 404 }) : new Response(data);
    }
    return new Response('', { status: 404 });
  };
  const files = () => trees.get(commits.get(head).tree);
  return { fetch, files, calls, get head() { return head; } };
}

function publishingOn(gh) {
  const stores = { reader: new StoreReader(gh.fetch), get: () => null, follow: async () => {}, refresh: async () => {} };
  const tokens = { get: () => 'token' };
  return new Publishing(tokens, stores, new (Object.getPrototypeOf(new Publishing(tokens, stores).publisher).constructor)(gh.fetch));
}

let _built = null;
async function built(voices = 0) {
  const mod = await import('./faustwasm/index.js');
  const base = here('./libfaust-wasm/libfaust-wasm.js');
  const em = await mod.instantiateFaustModuleFromFile(base, base.replace(/\.js$/, '.data'), base.replace(/\.js$/, '.wasm'));
  const faust = { compiler: new mod.FaustCompiler(new mod.LibFaust(em)), FaustMonoDspGenerator: mod.FaustMonoDspGenerator, FaustPolyDspGenerator: mod.FaustPolyDspGenerator };
  const templates = Object.fromEntries(Object.values(PWA_TEMPLATES).map((f) => [f, f.endsWith('.png') ? new Uint8Array(readFileSync(here(`./vendor/faust-pwa/${f}`))) : readFileSync(here(`./vendor/faust-pwa/${f}`), 'utf8')]));
  const dsp = await compilePwaDsp(faust, { code: CODE, name: 'Osc', voices, args: '-ftz 2' });
  return { name: 'Osc', voices, version: '20261115-1700', templates, faustwasm: '/* faustwasm */', dsp };
}
const CODE = 'import("stdfaust.lib");\nprocess = os.osc(440) * 0.1;';

test('publishApp : one commit at apps/Osc/, the index untouched, live after the deployment', async () => {
  const gh = fakeGitHub({ deployAfter: 2 });
  _built = _built || (await built(0));
  const stages = [];
  const result = await publishApp({
    publishing: publishingOn(gh), store: 'o/s', code: CODE, filename: 'Osc.dsp', built: _built,
    onStatus: (s, d) => stages.push(d === undefined ? s : `${s}:${d}`), fetchFn: gh.fetch,
    wait: { intervalMs: 1, sleep: async () => {} },
  });
  assert.equal(result.url, 'https://o.github.io/s/apps/Osc/');
  assert.equal(result.live, true);
  assert.equal(result.pages, 'enabled');
  assert.equal(result.fingerprint, await appFingerprint(CODE, 0));
  assert.deepEqual([...new Set(stages)], ['compiling', 'publishing', 'deploying:0', 'live']);
  const files = gh.files();
  for (const p of ['apps/Osc/index.html', 'apps/Osc/index.js', 'apps/Osc/service-worker.js', 'apps/Osc/manifest.json', 'apps/Osc/dsp-module.wasm', 'apps/Osc/faustwasm/index.js', '.nojekyll', 'index.json']) {
    assert.ok(files.has(p), p);
  }
  assert.ok(!files.has('apps/Osc/README.txt'));
  assert.deepEqual([...files.get('apps/Osc/dsp-module.wasm').subarray(0, 4)], [0, 97, 115, 109]);
  assert.equal(JSON.parse(files.get('apps/Osc/manifest.json')).faustcode.fingerprint, result.fingerprint);
  const index = JSON.parse(files.get('index.json'));
  assert.deepEqual(index.modules.map((m) => m.path), ['modules/A/A.dsp']); // apps/ is not a module
  assert.equal(gh.calls.filter((c) => c === 'PATCH api.github.com/repos/o/s/git/refs/heads/main').length, 1);
});

test('publishApp : GitHub Pages not enabled, the address and where to enable it', async () => {
  const gh = fakeGitHub({ pages: 'disabled' });
  _built = _built || (await built(0));
  const result = await publishApp({ publishing: publishingOn(gh), store: 'o/s', code: CODE, filename: 'Osc.dsp', built: _built, fetchFn: gh.fetch });
  assert.equal(result.live, false);
  assert.equal(result.pages, 'disabled');
  assert.equal(result.url, 'https://o.github.io/s/apps/Osc/');
  assert.equal(result.settings, 'https://github.com/o/s/settings/pages');
  assert.ok(gh.files().has('apps/Osc/index.html')); // published all the same
});

test('waitForApp : the version of the manifest, a timeout', async () => {
  const fp = 'abc';
  let served = { faustcode: { fingerprint: 'old' } };
  const fetchFn = async () => new Response(JSON.stringify(served));
  assert.equal(await appIsLive('https://o.github.io/s/apps/A/', fp, fetchFn), false);
  let ticks = 0;
  const live = waitForApp('https://o.github.io/s/apps/A/', fp, { fetchFn, intervalMs: 1, sleep: async () => { if (++ticks === 3) served = { faustcode: { fingerprint: fp } }; } });
  assert.equal(await live, true);
  assert.equal(await waitForApp('https://o.github.io/s/apps/A/', 'never', { fetchFn, timeoutMs: 0, sleep: async () => {} }), false);
  assert.deepEqual(await pagesSite({ owner: 'o', repo: 's' }, async () => { throw new Error('offline'); }), { url: 'https://o.github.io/s/', status: 'unknown' });
});
