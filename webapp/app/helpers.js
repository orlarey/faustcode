/**
 * Purpose: Provide shared helper utilities used across app orchestration flows.
 * How: Exports pure helpers and small browser utility wrappers for comparison, naming, escaping, clipboard, download, and editor URL dispatch.
 */

/**
 * Purpose: Detect meaningful parameter differences between two parameter maps.
 * How: Compares numeric entries with an epsilon threshold and returns true on first semantic difference.
 */
export function hasParamDiff(prevParams, nextParams) {
  if (!prevParams || !nextParams) return false;
  const prevEntries = Object.entries(prevParams);
  const nextEntries = Object.entries(nextParams);
  if (prevEntries.length !== nextEntries.length) return true;
  for (const [key, nextValue] of nextEntries) {
    const prevValue = prevParams[key];
    if (!Number.isFinite(nextValue) || !Number.isFinite(prevValue)) continue;
    if (Math.abs(Number(nextValue) - Number(prevValue)) > 1e-6) return true;
  }
  return false;
}

/**
 * Purpose: Provide a simple asynchronous delay primitive.
 * How: Resolves a Promise after `ms` milliseconds through `setTimeout`.
 */
export function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Purpose: Build a deterministic clip filename from current date/time.
 * How: Builds a compact `YYYYMMDDHHMMSS` timestamp from local date parts and appends `.dsp`.
 */
export function makeClipFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `clip-${ts}.dsp`;
}

/**
 * Purpose: Determine whether a target is an editable text field.
 * How: Checks editable element classes (`input`, `textarea`, `select`) and contenteditable ancestors.
 */
export function isTextInputTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return !!target.closest('[contenteditable="true"]');
}

/**
 * Purpose: Build the MCP configuration snippet shown in the empty-state panel.
 * How: Points the user's MCP client (Claude Desktop, …) at the local
 *      faustcode-mcp binary, which speaks MCP over stdio and bridges
 *      to this browser tab over WebSocket.
 */
export function getClaudeMcpConfigText() {
  return JSON.stringify(
    {
      mcpServers: {
        faustcode: {
          command: '/path/to/faustcode-mcp'
        }
      }
    },
    null,
    2
  );
}

/**
 * Purpose: Escape unsafe HTML characters in text fragments.
 * How: Replaces reserved characters by their HTML entity equivalents.
 */
export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Purpose: Copy text to the system clipboard when available.
 * How: Uses `navigator.clipboard.writeText` and silently ignores clipboard API failures.
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore clipboard errors silently
  }
}

/**
 * Purpose: Download a resource URL as a local file.
 * How: Fetches the URL, validates response, converts to Blob, and triggers a transient anchor download.
 */
export async function downloadFromUrl(url, filename, fallbackError = 'Download failed') {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let result = {};
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      // ignore JSON parse errors and fallback to raw text message
    }
    const serverError =
      (result && typeof result.error === 'string' && result.error.trim())
      || (text && text.trim())
      || '';
    throw new Error(serverError || `${fallbackError} (HTTP ${response.status})`);
  }
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

/**
 * Purpose: Fire a custom editor URL without navigating away from the current page.
 * How: Uses an invisible iframe probe and removes it after a short timeout.
 */
export function openEditorUrl(url) {
  if (!url || typeof url !== 'string') return;
  const probe = document.createElement('iframe');
  probe.style.display = 'none';
  probe.src = url;
  document.body.appendChild(probe);
  setTimeout(() => {
    probe.remove();
  }, 1500);
}
