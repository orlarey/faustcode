// share-ui.js — the Share panel (spec_partage.md) : everything that leaves
// faustcode, by destination, in four tabs :
//   Audience : a link and its QR code (Projection, Copy link) ;
//   Apps     : install as an app on this computer, open in faustmodular ;
//   Files    : .dsp, the diagrams, the math documentation, the PWA ;
//   Publish  : the module to a store.
// The voices are chosen once, in the head of the panel, for the link, the
// app and the PWA. The panel only shows and asks : the work is done by the
// actions app.js gives it (openSharePanel).

import qrcode from './vendor/qrcode-generator/qrcode.mjs';
import { buildPlayUrl, buildShareUrl, playUrlOf } from './share-link.js';

export const LONG_LINK_CHARS = 1000;
const MIN_MODULE_PX = 4;
const QUIET_ZONE = 4; // modules of white margin required around a QR code

export const SHARE_TABS = ['audience', 'apps', 'files', 'publish'];
export const SHARE_VOICES = [0, 1, 2, 4, 8, 16, 32, 64];
const TAB_LABELS = { audience: 'Audience', apps: 'Apps', files: 'Files', publish: 'Publish' };
const TAB_HINTS = {
  audience: 'people, on their phone',
  apps: 'this computer, faustmodular',
  files: 'a file to download',
  publish: 'a store : durable, short link',
};
const MATHDOC_LANGS = [
  ['en', 'English'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['it', 'Italiano'],
];
const TAB_KEY = 'faustcode.share.tab';

/**
 * QR code of `text` as an SVG string (scalable, white background), or
 * null when the text exceeds the capacity of a QR code at that level.
 * Level M by default, L above LONG_LINK_CHARS (spec).
 */
export function buildQr(text) {
  const level = text.length > LONG_LINK_CHARS ? 'L' : 'M';
  const qr = qrcode(0, level);
  qr.addData(text, 'Byte');
  try {
    qr.make();
  } catch {
    return null; // "code length overflow"
  }
  const svg = qr
    .createSvgTag({ cellSize: 1, margin: QUIET_ZONE, scalable: true })
    .replace('<svg ', '<svg shape-rendering="crispEdges" ');
  return { svg, level, modules: qr.getModuleCount() };
}

/** `mono`, `1 voice`, `8 voices`. */
export function voicesLabel(voices) {
  const n = Number(voices) || 0;
  return n <= 0 ? 'mono' : n === 1 ? '1 voice' : `${n} voices`;
}

/**
 * What the file allows, and why not (spec_partage.md, « Ce qui est commun ») :
 * a .lib has no `process` ; a code that does not compile can only be
 * downloaded or opened to be edited.
 *
 * @param {{ isLib?: boolean, errors?: string }} file
 * @returns {{ play: string|null, apps: string|null, diagrams: string|null, pwa: string|null, publish: string|null }}
 *   for each, null when possible, else the reason
 */
export function shareAvailability({ isLib = false, errors = '' } = {}) {
  const lib = isLib ? 'A .lib has no process : it is not a program to play.' : null;
  const broken = !lib && String(errors || '').trim() ? 'The code does not compile : fix it first.' : null;
  const reason = lib || broken;
  return {
    play: reason,
    apps: reason,
    diagrams: reason,
    pwa: reason,
    publish: lib ? 'A .lib is not published as a module.' : broken,
  };
}

function readTab() {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return SHARE_TABS.includes(t) ? t : null;
  } catch {
    return null;
  }
}

function writeTab(tab) {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch { /* a convenience only */ }
}

let openPanel = null;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

/**
 * Opens the Share panel.
 *
 * @param {object} ctx
 * @param {string} ctx.filename        the name of the open file
 * @param {string} [ctx.version]       `v3/5`
 * @param {string} ctx.code            the code of the version shown (saved)
 * @param {boolean} [ctx.isLib]
 * @param {string} [ctx.errors]        the errors of its compilation
 * @param {boolean} [ctx.unsaved]      the editor has changes not saved
 * @param {number} [ctx.voices]        initial voices (the run view's)
 * @param {string|null} [ctx.storeUrl] the link of the store, for a module published and unchanged
 * @param {string|null} [ctx.storeName]
 * @param {string[]} [ctx.writableStores]
 * @param {object} ctx.actions         installApp(voices), openInModular(), downloadDsp(), downloadDiagrams(),
 *                                     downloadMathdoc(lang), downloadPwa(voices), publish(store), openStores(),
 *                                     publishApp(store, voices, onStatus) → { url, live, pages, settings },
 *                                     appFor(voices) → the address of the published app of this code, or null
 */
export async function openSharePanel(ctx) {
  closeShareDialog();
  const actions = ctx.actions || {};
  const can = shareAvailability(ctx);
  const st = {
    tab: readTab() || 'audience',
    voices: SHARE_VOICES.includes(Number(ctx.voices)) ? Number(ctx.voices) : 0,
    opens: can.play ? 'edit' : 'play',
    source: ctx.storeUrl ? 'store' : 'code',
    appUrl: null, // the published app of this code at these voices
    url: '',
    qr: null,
  };
  const base = String(ctx.filename || 'session.dsp').replace(/\.(dsp|lib)$/i, '') || 'session';

  // ---- head
  const voicesSelect = el('select', { 'aria-label': 'Voices', class: 'share-voices-select' },
    ...SHARE_VOICES.map((n) => el('option', { value: String(n), text: n === 0 ? 'Mono' : String(n) })));
  voicesSelect.value = String(st.voices);
  const closeBtn = el('button', { type: 'button', class: 'icon-btn share-close', 'aria-label': 'Close', text: '✕' });
  const head = el('div', { class: 'share-head' },
    el('h2', { text: 'Share' }),
    el('span', { class: 'share-file', text: `${ctx.filename || ''}${ctx.version ? ` · ${ctx.version}` : ''}` }),
    el('span', { class: 'share-spacer' }),
    el('label', { class: 'share-voices' }, el('span', { text: 'Voices' }), voicesSelect),
    closeBtn);
  const banner = ctx.unsaved
    ? el('div', { class: 'share-banner', text: 'Unsaved changes : save them (Cmd/Ctrl-S) to share them. The saved version is what is shared.' })
    : null;

  // ---- tabs
  const tabButtons = {};
  const tabHint = el('span', { class: 'share-tab-hint' });
  const tabList = el('div', { class: 'share-tabs', role: 'tablist' });
  for (const t of SHARE_TABS) {
    tabButtons[t] = el('button', { type: 'button', role: 'tab', class: 'share-tab', 'data-tab': t, text: TAB_LABELS[t] });
    tabList.append(tabButtons[t]);
  }
  tabList.append(el('span', { class: 'share-spacer' }), tabHint);

  // ---- Audience
  const qrEl = el('div', { class: 'share-qr' });
  const seg = (name, items) => {
    const box = el('div', { class: 'share-seg', role: 'radiogroup', 'aria-label': name });
    const buttons = {};
    for (const [value, label] of items) {
      buttons[value] = el('button', { type: 'button', class: 'share-seg-btn', 'data-value': value, text: label });
      box.append(buttons[value]);
    }
    return { box, buttons };
  };
  const opensSeg = seg('Opens', [['play', 'Play'], ['edit', 'Edit']]);
  const sourceSeg = seg('Link', [['code', 'With the code'], ['store', 'From the store'], ['app', 'Published app']]);
  if (!ctx.storeUrl) sourceSeg.buttons.store.hidden = true;
  const sourceRow = el('div', { class: 'share-row' }, el('span', { class: 'share-row-label', text: 'Link' }), sourceSeg.box);
  const opensText = el('span', { class: 'share-note' });
  const metaEl = el('div', { class: 'share-meta' });
  const warnEl = el('div', { class: 'share-warning hidden' });
  const urlEl = el('textarea', { class: 'share-url', readonly: true, rows: '4', spellcheck: 'false', 'aria-label': 'Link' });
  const projectBtn = el('button', { type: 'button', class: 'primary-btn share-project', text: 'Projection' });
  const copyBtn = el('button', { type: 'button', class: 'primary-btn share-copy', text: 'Copy link' });
  const audience = el('div', { class: 'share-pane share-audience' },
    qrEl,
    el('div', { class: 'share-audience-side' },
      el('div', { class: 'share-row' }, el('span', { class: 'share-row-label', text: 'Opens' }), opensSeg.box, opensText),
      sourceRow,
      metaEl, warnEl, urlEl,
      el('div', { class: 'share-actions' }, projectBtn, copyBtn)));

  // ---- cards (Apps, Publish)
  const card = (title, text, buttonLabel, onClick, reason, primary = false) => {
    const b = el('button', { type: 'button', class: primary ? 'primary-btn share-go is-primary' : 'primary-btn share-go', text: buttonLabel, disabled: !!reason });
    if (!reason) b.addEventListener('click', onClick);
    return el('div', { class: 'share-card-row' + (reason ? ' is-disabled' : '') },
      el('div', { class: 'share-card-text' },
        el('div', { class: 'share-card-title', text: title }),
        el('div', { class: 'share-card-desc', text: reason || text })),
      b);
  };
  const apps = el('div', { class: 'share-pane share-apps' },
    card('Install on this computer', '', 'Install', () => {
      // synchronous up to the window it opens (a pop-up otherwise)
      void actions.installApp(st.voices);
      closeShareDialog();
    }, can.apps, true),
    card('Open in faustmodular', 'As a module of its open document. Linked : each Save updates the module.', 'Open', () => {
      void actions.openInModular();
      closeShareDialog();
    }, can.apps));
  const installDesc = apps.querySelector('.share-card-desc');

  // ---- Files
  const langSelect = el('select', { class: 'share-lang', 'aria-label': 'Language of the documentation' },
    ...MATHDOC_LANGS.map(([v, l]) => el('option', { value: v, text: l })));
  try {
    const lang = (navigator.language || '').slice(0, 2);
    if (MATHDOC_LANGS.some(([v]) => v === lang)) langSelect.value = lang;
  } catch { /* default */ }
  const pwaWhat = el('span', { class: 'share-file-what' });
  const fileRow = (name, what, onClick, reason, extra = null) => {
    const b = el('button', { type: 'button', class: 'primary-btn share-go', text: 'Download', disabled: !!reason });
    if (!reason) b.addEventListener('click', () => void onClick());
    return el('div', { class: 'share-file-row' + (reason ? ' is-disabled' : '') },
      el('span', { class: 'share-file-name', text: name }),
      typeof what === 'string' ? el('span', { class: 'share-file-what', text: reason || what }) : what,
      extra, b);
  };
  const files = el('div', { class: 'share-pane share-files' },
    fileRow(ctx.filename || `${base}.dsp`, 'the source of the version shown', () => actions.downloadDsp(), null),
    fileRow(`${base}-svg.zip`, 'every block diagram', () => actions.downloadDiagrams(), can.diagrams),
    fileRow(`${base}-mdoc.zip`, 'the mathematical documentation (LaTeX)', () => actions.downloadMathdoc(langSelect.value), can.diagrams, can.diagrams ? null : langSelect),
    fileRow(`${base}-pwa.zip`, can.pwa ? can.pwa : pwaWhat, () => actions.downloadPwa(st.voices), can.pwa));

  // ---- Publish
  const stores = ctx.writableStores || [];
  const unsavedReason = ctx.unsaved ? 'Save your changes first : the saved version is published.' : null;
  const appCard = (store) => {
    const reason = can.pwa || unsavedReason;
    const statusEl = el('div', { class: 'share-card-status', 'aria-live': 'polite' });
    const descEl = el('div', { class: 'share-card-desc' });
    const b = el('button', { type: 'button', class: 'primary-btn share-go', text: 'Publish app', disabled: !!reason });
    const row = el('div', { class: 'share-card-row share-app-row' + (reason ? ' is-disabled' : '') },
      el('div', { class: 'share-card-text' }, el('div', { class: 'share-card-title', text: `Publish as an app to ${store}` }), descEl, statusEl), b);
    const describe = () => {
      descEl.textContent = reason || `The app compiled, ${voicesLabel(st.voices)}, at apps/ of the store, served by GitHub Pages about a minute later : its QR code opens the app at once, without faustcode.`;
    };
    appDescribers.push(describe);
    describe();
    if (!reason) {
      b.addEventListener('click', async () => {
        b.disabled = true;
        statusEl.classList.remove('error');
        const say = {
          compiling: () => 'Compiling…',
          publishing: () => `Publishing to ${store}…`,
          deploying: (sec) => `Published. Waiting for GitHub Pages… ${sec ? `(${sec} s)` : ''}`,
          live: () => 'Live.',
        };
        try {
          const result = await actions.publishApp(store, st.voices, (stage, detail) => {
            statusEl.textContent = say[stage] ? say[stage](detail) : stage;
          });
          statusEl.replaceChildren();
          if (result.pages === 'disabled') {
            statusEl.classList.add('error');
            statusEl.append('Published, but GitHub Pages is not enabled on this store : ',
              el('a', { href: result.settings, target: '_blank', rel: 'noopener', text: 'enable it' }),
              ' (Deploy from a branch ▸ main ▸ / (root)). The app will then be at ',
              el('a', { href: result.url, target: '_blank', rel: 'noopener', text: result.url }), '.');
          } else if (!result.live) {
            statusEl.append('Published ; GitHub Pages does not serve it yet (it can take a few minutes) : ',
              el('a', { href: result.url, target: '_blank', rel: 'noopener', text: result.url }), '.');
          } else {
            statusEl.append('Live at ', el('a', { href: result.url, target: '_blank', rel: 'noopener', text: result.url }), ' : Audience shows its QR code.');
          }
          st.appUrl = result.url;
          st.opens = 'play';
          st.source = 'app';
          await refreshLink();
          if (result.live) showTab('audience');
        } catch (err) {
          statusEl.classList.add('error');
          statusEl.textContent = err && err.message ? err.message : String(err);
        } finally {
          b.disabled = false;
        }
      });
    }
    return row;
  };
  const appDescribers = [];
  const publishRows = stores.length
    ? stores.flatMap((store) => [card(`Publish ${ctx.filename} to ${store}`,
      'The saved version, as a module of the store, in one commit. Its short link is copied, and Audience then offers it : a QR code readable from the back of the room.',
      'Publish', () => {
        closeShareDialog();
        void actions.publish(store);
      }, can.publish, true), appCard(store)])
    : [card('No store to write to', 'Follow a store and give its token (File ▸ Stores…, a click on its badge read) : then publish here.', 'Stores…', () => {
      closeShareDialog();
      void actions.openStores();
    }, null)];
  const publish = el('div', { class: 'share-pane share-publish' }, ...publishRows);

  const panes = { audience, apps, files, publish };
  const cardEl = el('div', { class: 'share-card share-panel' }, head, banner, tabList, audience, apps, files, publish);
  const backdrop = el('div', { class: 'share-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Share' }, cardEl);

  // ---- behaviour
  const showTab = (tab) => {
    st.tab = tab;
    writeTab(tab);
    for (const t of SHARE_TABS) {
      const on = t === tab;
      tabButtons[t].classList.toggle('active', on);
      tabButtons[t].setAttribute('aria-selected', on ? 'true' : 'false');
      panes[t].hidden = !on;
    }
    tabHint.textContent = TAB_HINTS[tab];
  };

  let linkSeq = 0;
  const refreshLink = async () => {
    const seq = ++linkSeq;
    for (const [v, b] of Object.entries(opensSeg.buttons)) {
      b.classList.toggle('active', v === st.opens);
      b.disabled = v === 'play' && !!can.play;
    }
    sourceSeg.buttons.app.hidden = !st.appUrl;
    sourceSeg.buttons.app.disabled = st.opens !== 'play';
    sourceRow.hidden = !ctx.storeUrl && !st.appUrl;
    if (st.source === 'app' && (!st.appUrl || st.opens !== 'play')) st.source = ctx.storeUrl ? 'store' : 'code';
    for (const [v, b] of Object.entries(sourceSeg.buttons)) b.classList.toggle('active', v === st.source);
    opensText.textContent = st.opens === 'play' ? `the app itself, ready to install (${voicesLabel(st.voices)})` : 'faustcode, on the code';
    let url;
    const play = st.opens === 'play';
    if (st.source === 'app' && st.appUrl) {
      url = st.appUrl;
    } else if (st.source === 'store' && ctx.storeUrl) {
      if (play) url = playUrlOf(ctx.storeUrl, st.voices);
      else {
        const u = new URL(ctx.storeUrl);
        u.searchParams.set('view', 'dsp');
        u.searchParams.delete('poly');
        url = u.toString();
      }
    } else if (play) {
      // play.html : the app, built on the phone, then opened (never the editor)
      url = await buildPlayUrl(location, { code: ctx.code, name: ctx.filename, poly: st.voices });
    } else {
      url = await buildShareUrl(location, { code: ctx.code, name: ctx.filename, view: 'dsp' });
    }
    if (seq !== linkSeq) return;
    st.url = url;
    st.qr = buildQr(url);
    urlEl.value = url;
    metaEl.textContent = `${ctx.filename} · ${url.length} characters · ${{
      app: 'the published app : it opens at once',
      store: `from the store ${ctx.storeName || ''}${play ? ' : the phone builds the app, a few seconds the first time' : ''}`,
      code: play ? 'the code is in the link : the phone builds the app, a few seconds the first time' : 'the code is in the link',
    }[st.source]}`;
    warnEl.classList.add('hidden');
    if (st.qr) {
      qrEl.hidden = false;
      qrEl.innerHTML = st.qr.svg;
      qrEl.style.width = `${Math.max(236, Math.min(320, (st.qr.modules + 2 * QUIET_ZONE) * 3))}px`;
      projectBtn.disabled = false;
    } else {
      qrEl.hidden = true;
      projectBtn.disabled = true;
    }
    if (!st.qr) showWarning(warnEl, 'Link too long for a QR code : publish the module (Publish) for a short link, or use Copy link.');
    else if (url.length > LONG_LINK_CHARS) showWarning(warnEl, 'Long link : the QR code may be hard to scan from a distance. Publishing the module gives a short link.');
  };

  const refreshVoices = () => {
    const label = voicesLabel(st.voices);
    // a disabled card shows its reason instead
    if (!can.apps) installDesc.textContent = `${base} opens as an app in its own window, ${label}, with an Install button. It runs offline.`;
    pwaWhat.textContent = `the app to serve yourself, ${label}`;
  };

  for (const t of SHARE_TABS) tabButtons[t].addEventListener('click', () => showTab(t));
  opensSeg.box.addEventListener('click', (e) => {
    const b = e.target.closest('.share-seg-btn');
    if (!b || b.disabled) return;
    st.opens = b.dataset.value;
    void refreshLink();
  });
  sourceSeg.box.addEventListener('click', (e) => {
    const b = e.target.closest('.share-seg-btn');
    if (!b) return;
    st.source = b.dataset.value;
    void refreshLink();
  });
  const findApp = async () => {
    st.appUrl = actions.appFor ? await actions.appFor(st.voices) : null;
  };
  voicesSelect.addEventListener('change', async () => {
    st.voices = Number(voicesSelect.value) || 0;
    refreshVoices();
    for (const d of appDescribers) d();
    await findApp();
    void refreshLink();
  });
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(st.url);
    } catch {
      urlEl.select();
      document.execCommand('copy');
    }
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1500);
  });
  urlEl.addEventListener('focus', () => urlEl.select());
  projectBtn.addEventListener('click', () => { if (st.qr) openProjection(st.qr.svg, ctx.filename); });
  closeBtn.addEventListener('click', closeShareDialog);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeShareDialog(); });
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.share-projection')) closeShareDialog(); };
  document.addEventListener('keydown', onKey);

  showTab(st.tab);
  refreshVoices();
  await findApp();
  // the best link there is : the published app, then the store, then the code
  if (st.appUrl && !can.play) {
    st.opens = 'play';
    st.source = 'app';
  }
  await refreshLink();
  openPanel = { backdrop, onKey };
  document.body.appendChild(backdrop);
  tabButtons[st.tab].focus();
  return { url: st.url, qr: st.qr };
}

export function closeShareDialog() {
  if (!openPanel) return;
  document.removeEventListener('keydown', openPanel.onKey);
  openPanel.backdrop.remove();
  openPanel = null;
}

function showWarning(node, text) {
  node.textContent = text;
  node.classList.remove('hidden');
}

/** Full-screen white page : QR as large as possible + session name. Esc or click closes. */
function openProjection(svg, filename) {
  const node = document.createElement('div');
  node.className = 'share-projection';
  node.innerHTML = `<div class="share-projection-qr">${svg}</div><div class="share-projection-name"></div>`;
  node.querySelector('.share-projection-name').textContent = String(filename || '').replace(/\.dsp$/i, '');
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    if (document.fullscreenElement === node && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    node.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  node.addEventListener('click', close);
  // Leaving browser fullscreen with Esc does not deliver the keydown : close too.
  node.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) close(); });
  document.body.appendChild(node);
  if (node.requestFullscreen) node.requestFullscreen().catch(() => {});
}
