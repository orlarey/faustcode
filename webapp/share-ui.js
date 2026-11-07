// share-ui.js — the header Share dialog (spec_share_url.md, part 2) :
// QR code of the active session's link, Copy link, and a full-screen
// Projection mode a room can scan.

import qrcode from './vendor/qrcode-generator/qrcode.mjs';
import { buildShareUrl } from './share-link.js';

export const LONG_LINK_CHARS = 1000;
const MIN_MODULE_PX = 4;
const QUIET_ZONE = 4; // modules of white margin required around a QR code

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

let openDialog = null;

/**
 * @param {{ code: string, filename: string, poly?: number, storeUrl?: string|null, storeName?: string|null }} session
 * storeUrl : the link of the store, for a file published there and unchanged
 * (spec_files_store.md, « Le bouton Share ») : shown first, the link with the
 * code (self-contained) one click away.
 */
export async function openShareDialog({ code, filename, poly = 0, storeUrl = null, storeName = null }) {
  closeShareDialog();
  const codeUrl = await buildShareUrl(location, { code, name: filename, view: 'run', poly });
  let url = storeUrl || codeUrl;
  let qr = buildQr(url);

  const backdrop = document.createElement('div');
  backdrop.className = 'share-dialog';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', 'Share');
  backdrop.innerHTML = `
    <div class="share-card">
      <div class="share-head">
        <h2>Share</h2>
        <button type="button" class="icon-btn share-close" aria-label="Close">✕</button>
      </div>
      <div class="share-kind hidden" role="radiogroup" aria-label="Link">
        <button type="button" class="share-kind-btn" data-kind="store"></button>
        <button type="button" class="share-kind-btn" data-kind="code">With the code</button>
      </div>
      <div class="share-qr"></div>
      <div class="share-warning hidden"></div>
      <div class="share-meta"></div>
      <textarea class="share-url" readonly rows="3" spellcheck="false"></textarea>
      <div class="share-actions">
        <button type="button" class="primary-btn share-copy">Copy link</button>
        <button type="button" class="primary-btn share-project">Projection</button>
      </div>
    </div>`;
  const qrEl = backdrop.querySelector('.share-qr');
  const warnEl = backdrop.querySelector('.share-warning');
  const urlEl = backdrop.querySelector('.share-url');
  const copyBtn = backdrop.querySelector('.share-copy');
  const projectBtn = backdrop.querySelector('.share-project');

  const metaEl = backdrop.querySelector('.share-meta');
  const show = (kind) => {
    url = kind === 'store' && storeUrl ? storeUrl : codeUrl;
    qr = buildQr(url);
    metaEl.textContent = `${filename} · ${url.length} characters${kind === 'store' && storeUrl ? ` · from the store ${storeName || ''}` : ''}`;
    urlEl.value = url;
    warnEl.classList.add('hidden');
    if (qr) {
      qrEl.classList.remove('hidden');
      qrEl.innerHTML = qr.svg;
      // At least MIN_MODULE_PX per module on screen.
      const px = Math.max(420, (qr.modules + 2 * QUIET_ZONE) * MIN_MODULE_PX);
      qrEl.style.width = `${px}px`;
      projectBtn.disabled = false;
    } else {
      qrEl.classList.add('hidden');
      projectBtn.disabled = true;
    }
    if (!qr) {
      showWarning(warnEl, 'Link too long for a QR code : use Copy link.');
    } else if (url.length > LONG_LINK_CHARS) {
      showWarning(warnEl, 'Long link : the QR code may be hard to scan from a distance.');
    }
    for (const b of backdrop.querySelectorAll('.share-kind-btn')) b.classList.toggle('active', b.dataset.kind === kind);
  };
  if (storeUrl) {
    const kindEl = backdrop.querySelector('.share-kind');
    kindEl.classList.remove('hidden');
    kindEl.querySelector('[data-kind="store"]').textContent = 'From the store';
    kindEl.addEventListener('click', (e) => {
      const b = e.target.closest('.share-kind-btn');
      if (b) show(b.dataset.kind);
    });
  }
  show(storeUrl ? 'store' : 'code');

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      urlEl.select();
      document.execCommand('copy');
    }
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1500);
  });
  urlEl.addEventListener('focus', () => urlEl.select());
  projectBtn.addEventListener('click', () => { if (qr) openProjection(qr.svg, filename); });
  backdrop.querySelector('.share-close').addEventListener('click', closeShareDialog);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeShareDialog(); });

  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.share-projection')) closeShareDialog(); };
  document.addEventListener('keydown', onKey);
  openDialog = { backdrop, onKey };
  document.body.appendChild(backdrop);
  copyBtn.focus();
  return { url, qr };
}

export function closeShareDialog() {
  if (!openDialog) return;
  document.removeEventListener('keydown', openDialog.onKey);
  openDialog.backdrop.remove();
  openDialog = null;
}

function showWarning(el, text) {
  el.textContent = text;
  el.classList.remove('hidden');
}

/** Full-screen white page : QR as large as possible + session name. Esc or click closes. */
function openProjection(svg, filename) {
  const el = document.createElement('div');
  el.className = 'share-projection';
  el.innerHTML = `<div class="share-projection-qr">${svg}</div><div class="share-projection-name"></div>`;
  el.querySelector('.share-projection-name').textContent = filename.replace(/\.dsp$/i, '');
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    if (document.fullscreenElement === el && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    el.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  el.addEventListener('click', close);
  // Leaving browser fullscreen with Esc does not deliver the keydown : close too.
  el.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) close(); });
  document.body.appendChild(el);
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}
