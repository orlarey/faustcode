// notice.js — short, non-blocking message at the bottom of the page
// (fades out by itself ; styled by .app-notice in webapp.css).

export function showNotice(message, durationMs = 6000) {
  const el = document.createElement('div');
  el.className = 'app-notice';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), durationMs);
}
