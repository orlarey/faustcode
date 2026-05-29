// setup-mcp.js — populates the "Setup MCP" dialog with OS-specific
// download links and launch instructions, following the contract laid
// out in SPECIFICATION-STANDALONE.md §Distribution.

const RELEASES_BASE = 'https://github.com/orlarey/faustcode/releases/download';

const TARGETS = [
  { slug: 'darwin-arm64', label: 'macOS · Apple Silicon (arm64)' },
  { slug: 'darwin-amd64', label: 'macOS · Intel (x86_64)' },
  { slug: 'linux-amd64',  label: 'Linux · x86_64' },
  { slug: 'linux-arm64',  label: 'Linux · arm64' },
  { slug: 'windows-amd64',label: 'Windows · x86_64' },
];

/**
 * Detects the visitor's (OS, arch) and returns the matching TARGETS entry,
 * or null if no good guess can be made.
 */
function detectTarget() {
  const ua = navigator.userAgent || '';
  let isARM = false;
  if (navigator.userAgentData && Array.isArray(navigator.userAgentData.brands)) {
    // userAgentData is async via getHighEntropyValues, but we already
    // have synchronous low-entropy hints. arm detection is best-effort.
    if (navigator.userAgentData.platform === 'macOS') {
      // Default to arm64 on modern Macs ; the user can switch via the
      // "Other platforms" disclosure.
      isARM = true;
    }
  }
  if (/arm64|aarch64/i.test(ua)) isARM = true;

  if (/Mac/i.test(ua) || /Macintosh/i.test(ua)) {
    return TARGETS.find((t) => t.slug === (isARM ? 'darwin-arm64' : 'darwin-amd64'));
  }
  if (/Windows/i.test(ua)) {
    return TARGETS.find((t) => t.slug === 'windows-amd64');
  }
  if (/Linux|X11/i.test(ua)) {
    return TARGETS.find((t) => t.slug === (isARM ? 'linux-arm64' : 'linux-amd64'));
  }
  return null;
}

function downloadUrl(contractVersion, slug) {
  const ext = slug.startsWith('windows-') ? '.exe' : '';
  return `${RELEASES_BASE}/v${contractVersion}/faustcode-mcp-${slug}${ext}`;
}

function runCommandFor(slug) {
  if (slug.startsWith('windows-')) {
    return [
      '# Windows : double-click the downloaded .exe.',
      '# If SmartScreen blocks it : "More info" → "Run anyway".',
      '.\\faustcode-mcp.exe',
    ].join('\n');
  }
  if (slug.startsWith('darwin-')) {
    return [
      '# macOS : strip the Gatekeeper quarantine flag, then run.',
      'chmod +x ./faustcode-mcp-' + slug,
      'xattr -d com.apple.quarantine ./faustcode-mcp-' + slug + ' 2>/dev/null || true',
      './faustcode-mcp-' + slug,
    ].join('\n');
  }
  return [
    '# Linux : just chmod and run.',
    'chmod +x ./faustcode-mcp-' + slug,
    './faustcode-mcp-' + slug,
  ].join('\n');
}

function osNoteFor(slug) {
  if (slug.startsWith('windows-')) {
    return 'Windows SmartScreen will flag the unsigned binary at first launch ; click "More info" then "Run anyway".';
  }
  if (slug.startsWith('darwin-')) {
    return 'macOS Gatekeeper will refuse to open the unsigned binary by default ; the xattr command above removes the quarantine flag.';
  }
  return 'No extra steps on Linux.';
}

/**
 * initSetupMcp wires the dialog buttons and prepares the per-target
 * information when the dialog is opened. Called once at boot.
 *
 * @param {() => string} getContractVersion — returns the version to
 *   embed in the GitHub Releases URL.
 * @param {() => string} getWsUrl — returns the WS URL currently in
 *   use (only shown in step 3 for reference).
 */
export function initSetupMcp(getContractVersion, getWsUrl) {
  // The setup steps now live inline inside the MCP drawer. We populate
  // them once at boot ; the user opens the drawer to see them.
  const detectedP = document.getElementById('setup-os-detected');
  const downloadA = document.getElementById('setup-download');
  const otherUl   = document.getElementById('setup-other-links');
  const runCmdEl  = document.getElementById('setup-run-cmd');
  const osNoteEl  = document.getElementById('setup-os-note');
  const wsUrlEl   = document.getElementById('setup-ws-url');

  if (!detectedP) return;

  const contractVersion = (getContractVersion && getContractVersion()) || '0.0.0';
  const target = detectTarget();
  if (target) {
    detectedP.textContent = `Detected : ${target.label}`;
    downloadA.href = downloadUrl(contractVersion, target.slug);
    downloadA.textContent = `faustcode-mcp-${target.slug}${target.slug.startsWith('windows-') ? '.exe' : ''}`;
    runCmdEl.textContent = runCommandFor(target.slug);
    osNoteEl.textContent = osNoteFor(target.slug);
  } else {
    detectedP.textContent = 'Could not detect the platform automatically — pick one below.';
    downloadA.removeAttribute('href');
    downloadA.textContent = '(no auto-detected platform)';
    runCmdEl.textContent = '# pick a platform below';
    osNoteEl.textContent = '';
  }
  otherUl.innerHTML = '';
  for (const t of TARGETS) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = downloadUrl(contractVersion, t.slug);
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = t.label;
    li.appendChild(a);
    otherUl.appendChild(li);
  }
  if (wsUrlEl && getWsUrl) wsUrlEl.textContent = getWsUrl() || 'ws://localhost:7777/ws';
}
