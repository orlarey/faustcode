/**
 * Purpose: Define the generated C++ source view.
 * How: Fetches compiled C++ output, highlights syntax, and offers flags presets/help with scroll persistence.
 */
import { escapeHtml, generateLineNumbers, highlightWithRules } from './shared/text-utils.js';
import { setupCodeEditorInteractions } from './shared/code-editor-view.js';

/**
 * Purpose: Expose the label used by the global view selector.
 * How: Returns the static display name for this module.
 */
export function getName() {
  return 'C++ Code';
}

// C++ keywords used by the syntax highlighter.
const CPP_KEYWORDS = [
  'class', 'struct', 'public', 'private', 'protected',
  'virtual', 'static', 'const', 'constexpr', 'inline',
  'int', 'float', 'double', 'void', 'char', 'bool',
  'long', 'short', 'unsigned', 'signed', 'auto',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'break', 'continue', 'return', 'default', 'goto',
  'namespace', 'using', 'template', 'typename', 'typedef',
  'new', 'delete', 'this', 'nullptr', 'true', 'false',
  'try', 'catch', 'throw', 'noexcept',
  'sizeof', 'alignof', 'decltype', 'explicit',
  'override', 'final', 'enum', 'union'
];

/**
 * Purpose: Apply lightweight C++ syntax highlighting on source text.
 * How: Builds ordered C++ highlight rules and applies them through the shared placeholder-safe highlighter.
 */
function highlightCpp(code) {
  const rules = [];
  rules.push({ pattern: /(\/\/[^\n]*)/g, className: 'cpp-comment' });
  rules.push({ pattern: /(\/\*[\s\S]*?\*\/)/g, className: 'cpp-comment' });
  rules.push({ pattern: /(#\s*\w+[^\n]*)/g, className: 'cpp-preprocessor' });
  rules.push({ pattern: /("(?:[^"\\]|\\.)*")/g, className: 'cpp-string' });
  rules.push({ pattern: /('(?:[^'\\]|\\.)')/g, className: 'cpp-string' });
  rules.push({
    pattern: /\b(0x[0-9a-fA-F]+|\d+\.?\d*(?:e[+-]?\d+)?[fFlL]?)\b/g,
    className: 'cpp-number'
  });
  const keywordPattern = new RegExp(`\\b(${CPP_KEYWORDS.join('|')})\\b`, 'g');
  rules.push({ pattern: keywordPattern, className: 'cpp-keyword' });
  rules.push({ pattern: /\b([A-Z][a-zA-Z0-9_]*)\b/g, className: 'cpp-type' });
  return highlightWithRules(code, rules, '__CPP_TOKEN_');
}

const CPP_PRESETS_STORAGE_KEY = 'faustcode.cpp.presets.v1';
const cppFlagsBySha = Object.create(null);

/**
 * Purpose: Normalize compiler flags for stable comparison and storage.
 * How: Trims input and collapses consecutive spaces into single spaces.
 */
function normalizeFlags(input) {
  return String(input || '').trim().replace(/\s+/g, ' ');
}

/**
 * Purpose: Load persisted C++ flag presets from local storage.
 * How: Parses JSON, normalizes each entry, and filters out invalid or empty presets.
 */
function loadCppPresets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CPP_PRESETS_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x) => ({
        flags: normalizeFlags(x?.flags || ''),
        status: x?.status === 'invalid' ? 'invalid' : 'valid',
        lastUsedAt: Number.isFinite(Number(x?.lastUsedAt)) ? Number(x.lastUsedAt) : 0
      }))
      .filter((x) => x.flags.length > 0);
  } catch {
    return [];
  }
}

/**
 * Purpose: Persist C++ flag presets for future sessions.
 * How: Serializes presets to local storage and ignores storage failures.
 */
function saveCppPresets(presets) {
  try {
    localStorage.setItem(CPP_PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // ignore storage issues
  }
}

/**
 * Purpose: Insert or update one preset entry in memory.
 * How: Normalizes the flag string, updates existing entry when present, otherwise appends a new one.
 */
function upsertCppPreset(presets, flags, status, lastUsedAt = Date.now()) {
  const norm = normalizeFlags(flags);
  if (!norm) return presets;
  const idx = presets.findIndex((p) => p.flags === norm);
  if (idx >= 0) {
    presets[idx] = {
      ...presets[idx],
      status,
      lastUsedAt
    };
    return presets;
  }
  presets.push({ flags: norm, status, lastUsedAt });
  return presets;
}

/**
 * Purpose: Provide selectable presets ordered by relevance.
 * How: Keeps only valid entries and sorts them by descending `lastUsedAt`.
 */
function getValidPresetsSorted(presets) {
  return presets
    .filter((p) => p.status === 'valid' && p.flags)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/**
 * Purpose: Retrieve the generated C++ code for a session.
 * How: Calls `/generated.cpp`, maps 404 to an empty marker, and returns code text on success.
 */
async function fetchCppCode(sha) {
  const response = await fetch(`/api/${sha}/generated.cpp`);
  if (!response.ok) {
    if (response.status === 404) {
      return { ok: false, empty: true, code: '' };
    }
    throw new Error('Failed to load C++ code');
  }
  return { ok: true, empty: false, code: await response.text() };
}

/**
 * Purpose: Load persisted C++ flags associated with one session.
 * How: Reads `/metadata.json`, extracts `cpp_flags`, and falls back to empty flags when unavailable.
 */
async function fetchPersistedCppFlags(sha) {
  const response = await fetch(`/api/${sha}/metadata.json`);
  if (!response.ok) return '';
  const data = await response.json().catch(() => ({}));
  return normalizeFlags(data?.cpp_flags || '');
}

/**
 * Purpose: Ask backend to recompile C++ with custom Faust flags.
 * How: Sends flags to `/compile/cpp` and raises backend errors as exceptions.
 */
async function compileCppWithFlags(sha, flags) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  const response = await fetch(`/api/${sha}/compile/cpp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flags }),
    signal: controller.signal
  }).catch((err) => {
    if (err?.name === 'AbortError') {
      throw new Error('C++ compilation timeout');
    }
    throw err;
  }).finally(() => {
    clearTimeout(timer);
  });
  // Important: on success we do not wait for body parsing. Some environments
  // can produce a hanging body stream while compilation has already completed.
  if (response.ok) {
    return;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'C++ compilation failed');
  }
}

/**
 * Purpose: Load Faust compiler help text for the flags help panel.
 * How: Requests `/api/faust/help` and returns normalized text with backend error mapping.
 */
async function fetchFaustHelp() {
  const response = await fetch('/api/faust/help');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Failed to load Faust help');
  }
  return String(data.help || 'Faust help unavailable');
}

/**
 * Purpose: Resolve a currently visible mount point for in-view re-renders.
 * How: Reuses the provided container when connected, otherwise falls back to the active `#view-container` host.
 */
function resolveVisibleRenderContainer(container) {
  if (container instanceof HTMLElement && container.isConnected) {
    return container;
  }
  const host = document.getElementById('view-container');
  if (!host) return container;
  const currentCodeView = host.querySelector('.code-view');
  if (currentCodeView && currentCodeView.parentElement) {
    return currentCodeView.parentElement;
  }
  return host;
}

/**
 * Purpose: Render the C++ code pane for one session.
 * How: Builds toolbar/editor UI, manages presets/help/actions, and maintains zoom/scroll synchronization.
 */
export async function render(container, { sha, scrollState, onScrollChange, onDownload }) {
  try {
    let presets = loadCppPresets();
    const hasLocalFlags = Object.prototype.hasOwnProperty.call(cppFlagsBySha, sha);
    const persistedFlags = hasLocalFlags ? '' : await fetchPersistedCppFlags(sha);
    const appliedFlags = normalizeFlags(
      hasLocalFlags ? cppFlagsBySha[sha] || '' : persistedFlags
    );
    cppFlagsBySha[sha] = appliedFlags;
    const cpp = await fetchCppCode(sha);
    if (!cpp.ok) {
      container.innerHTML = `<div class="info">C++ code not available (compilation error?)</div>`;
      return;
    }
    const code = cpp.code;
    const lines = code.split('\n');
    const lineCount = lines.length;
    const validPresets = getValidPresetsSorted(presets);
    const otherPresets = validPresets.filter((p) => p.flags && p.flags !== appliedFlags);
    const presetParts = [
      '<button class="code-preset-item code-preset-item-default" type="button" data-flags="">No options (default)</button>'
    ];
    if (appliedFlags) {
      presetParts.push(
        `<button class="code-preset-item code-preset-item-current" type="button" data-flags="${escapeHtml(appliedFlags)}">${escapeHtml(appliedFlags)} (current)</button>`
      );
    }
    presetParts.push(
      ...otherPresets.map(
        (p) =>
          `<button class="code-preset-item" type="button" data-flags="${escapeHtml(p.flags)}">${escapeHtml(p.flags)}</button>`
      )
    );
    if (otherPresets.length === 0 && !appliedFlags) {
      presetParts.push('<div class="code-preset-empty">No custom presets yet</div>');
    }
    const presetOptions = presetParts.join('');

    container.innerHTML = `
      <div class="code-view">
        <div class="code-toolbar">
          <span class="code-toolbar-title">C++ CODE</span>
          <div class="code-toolbar-controls">
            <div class="code-zoom-group code-flags-group">
              <span class="code-zoom-label">Flags</span>
              <div class="code-flags-combo">
                <input class="code-flags-input" value="${escapeHtml(appliedFlags)}" placeholder="No options" />
                <button class="code-preset-toggle" type="button" aria-label="Show presets">▾</button>
                <div class="code-preset-menu hidden">${presetOptions}</div>
              </div>
            </div>
            <button class="primary-btn code-flags-help" type="button">Help</button>
            <div class="code-zoom-group">
              <span class="code-zoom-label">Zoom</span>
              <select class="code-zoom-select" aria-label="C++ code zoom">
                <option value="50">50%</option>
                <option value="75">75%</option>
                <option value="100" selected>100%</option>
                <option value="125">125%</option>
                <option value="150">150%</option>
                <option value="200">200%</option>
              </select>
            </div>
            <div class="download-select-group toolbar-download-right">
              <button class="download-select-btn code-download-btn" type="button">Download</button>
              <select class="download-select-value code-download-format" aria-label="C++ download format">
                <option value="cpp">.cpp</option>
              </select>
            </div>
          </div>
        </div>
        <div class="code-flags-status"></div>
        <div class="code-help-panel hidden">
          <div class="code-help-header">
            <span>Faust compiler options (faust -h)</span>
            <button class="code-help-close" type="button">Close</button>
          </div>
          <pre class="code-help-content"></pre>
        </div>
        <div class="code-editor">
          <div class="line-numbers">${generateLineNumbers(lineCount)}</div>
          <div class="code-content">${highlightCpp(code)}</div>
        </div>
      </div>
    `;

    const lineNumbers = container.querySelector('.line-numbers');
    const codeContent = container.querySelector('.code-content');
    const flagsInput = container.querySelector('.code-flags-input');
    const presetToggle = container.querySelector('.code-preset-toggle');
    const presetMenu = container.querySelector('.code-preset-menu');
    const flagsHelp = container.querySelector('.code-flags-help');
    const downloadBtn = container.querySelector('.code-download-btn');
    const downloadFormat = container.querySelector('.code-download-format');
    const flagsStatus = container.querySelector('.code-flags-status');
    const helpPanel = container.querySelector('.code-help-panel');
    const helpContent = container.querySelector('.code-help-content');
    const helpClose = container.querySelector('.code-help-close');
    if (downloadBtn && typeof onDownload === 'function') {
      downloadBtn.addEventListener('click', () => {
        const format = downloadFormat ? downloadFormat.value : '';
        void onDownload(format);
      });
    }

    const zoomSelect = container.querySelector('.code-zoom-select');
    const { getTopLine } = setupCodeEditorInteractions({
      lineNumbersEl: lineNumbers,
      codeContentEl: codeContent,
      zoomSelectEl: zoomSelect,
      lineCount,
      scrollState,
      onScrollChange,
      minZoom: 50,
      maxZoom: 200,
      defaultZoom: 100
    });

    /**
     * Purpose: Display the current flags operation status in the toolbar.
     * How: Writes text content and toggles error coloring when needed.
     */
    const setFlagsStatus = (text, isError = false) => {
      if (!flagsStatus) return;
      flagsStatus.textContent = text || '';
      flagsStatus.style.color = isError ? '#ff7a7a' : '';
    };

    /**
     * Purpose: Apply the currently entered Faust flags to regenerate C++ output.
     * How: Validates input/preset state, triggers backend compilation, updates preset metadata, and re-renders.
     */
    const applyFlags = async (options = {}) => {
      const force = options && options.force === true;
      if (!flagsInput) return;
      const nextFlags = normalizeFlags(flagsInput.value);
      if (!force && nextFlags === cppFlagsBySha[sha]) {
        setFlagsStatus('Already applied.');
        return;
      }
      const existing = presets.find((p) => p.flags === nextFlags);
      if (existing && existing.status === 'invalid') {
        setFlagsStatus('This preset is marked invalid. Edit flags before applying.', true);
        return;
      }
      setFlagsStatus('Compiling...');
      try {
        await compileCppWithFlags(sha, nextFlags);
        cppFlagsBySha[sha] = nextFlags;
        presets = upsertCppPreset(presets, nextFlags, 'valid', Date.now());
        saveCppPresets(presets);
        const liveContainer = resolveVisibleRenderContainer(container);
        await render(liveContainer, { sha, scrollState: { line: getTopLine() }, onScrollChange });
      } catch (err) {
        // Fallback: if the compile response hangs but the file is already updated
        // on disk, re-render anyway so the editor can recover from "Compiling...".
        const message = err && err.message ? err.message : String(err);
        if (message.toLowerCase().includes('timeout')) {
          try {
            cppFlagsBySha[sha] = nextFlags;
            presets = upsertCppPreset(presets, nextFlags, 'valid', Date.now());
            saveCppPresets(presets);
            const liveContainer = resolveVisibleRenderContainer(container);
            await render(liveContainer, { sha, scrollState: { line: getTopLine() }, onScrollChange });
            return;
          } catch {
            // fall through to status error display below
          }
        }
        presets = upsertCppPreset(presets, nextFlags, 'invalid', Date.now());
        saveCppPresets(presets);
        setFlagsStatus(message, true);
      }
    };

    if (presetToggle && presetMenu) {
      let docListenersInstalled = false;
      const onDocClick = (event) => {
        if (container.contains(event.target)) return;
        closePresetMenu();
      };
      const onDocKeyDown = (event) => {
        if (event.key !== 'Escape') return;
        closePresetMenu();
      };
      const installDocListeners = () => {
        if (docListenersInstalled) return;
        docListenersInstalled = true;
        document.addEventListener('click', onDocClick);
        document.addEventListener('keydown', onDocKeyDown);
      };
      const removeDocListeners = () => {
        if (!docListenersInstalled) return;
        docListenersInstalled = false;
        document.removeEventListener('click', onDocClick);
        document.removeEventListener('keydown', onDocKeyDown);
      };
      const closePresetMenu = () => {
        presetMenu.classList.add('hidden');
        removeDocListeners();
      };
      presetToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const willOpen = presetMenu.classList.contains('hidden');
        presetMenu.classList.toggle('hidden');
        if (willOpen) {
          installDocListeners();
        } else {
          removeDocListeners();
        }
      });
      presetMenu.addEventListener('click', (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const item = target.closest('.code-preset-item');
        if (!item || !flagsInput) return;
        const selected = normalizeFlags(item.getAttribute('data-flags') || '');
        const force = item.classList.contains('code-preset-item-default');
        flagsInput.value = selected;
        closePresetMenu();
        void applyFlags({ force });
      });
      container.addEventListener('click', (event) => {
        if (!(event.target instanceof HTMLElement)) return;
        if (event.target.closest('.code-flags-combo')) return;
        closePresetMenu();
      });
    }
    if (flagsInput) {
      flagsInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void applyFlags();
      });
    }

    if (flagsHelp && helpPanel && helpContent) {
      let helpEscapeListenerInstalled = false;
      let helpOutsideClickListenerInstalled = false;
      const onHelpEscape = (event) => {
        if (event.key !== 'Escape') return;
        closeHelpPanel();
      };
      const onHelpOutsideClick = (event) => {
        if (container.contains(event.target)) return;
        closeHelpPanel();
      };
      const openHelpPanel = () => {
        helpPanel.classList.remove('hidden');
        if (!helpEscapeListenerInstalled) {
          helpEscapeListenerInstalled = true;
          document.addEventListener('keydown', onHelpEscape);
        }
        if (!helpOutsideClickListenerInstalled) {
          helpOutsideClickListenerInstalled = true;
          document.addEventListener('click', onHelpOutsideClick);
        }
      };
      const closeHelpPanel = () => {
        helpPanel.classList.add('hidden');
        if (helpEscapeListenerInstalled) {
          helpEscapeListenerInstalled = false;
          document.removeEventListener('keydown', onHelpEscape);
        }
        if (helpOutsideClickListenerInstalled) {
          helpOutsideClickListenerInstalled = false;
          document.removeEventListener('click', onHelpOutsideClick);
        }
      };

      flagsHelp.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!helpPanel.classList.contains('hidden')) {
          closeHelpPanel();
          return;
        }
        openHelpPanel();
        if (helpContent.textContent && helpContent.textContent.trim()) return;
        helpContent.textContent = 'Loading...';
        try {
          helpContent.textContent = await fetchFaustHelp();
        } catch (err) {
          helpContent.textContent = err && err.message ? err.message : String(err);
        }
      });

      if (helpClose) {
        helpClose.addEventListener('click', (event) => {
          event.stopPropagation();
          closeHelpPanel();
        });
      }
    }

  } catch (err) {
    container.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}
