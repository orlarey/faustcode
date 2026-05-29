import { generateLineNumbers, highlightWithRules } from './text-utils.js';

let vizScriptsPromise = null;
const VIZ_TOTAL_MEMORY = 512 * 1024 * 1024; // 512 MB

/**
 * Purpose: Render DOT source with lightweight syntax highlighting.
 * How: Builds ordered DOT highlight rules and applies them through the shared placeholder-safe highlighter.
 */
function highlightDot(dot) {
  const rules = [];
  rules.push({ pattern: /(\/\*[\s\S]*?\*\/)/g, className: 'dot-comment' });
  rules.push({ pattern: /(^\s*#.*$)/gm, className: 'dot-comment' });
  rules.push({ pattern: /(\/\/[^\n]*)/g, className: 'dot-comment' });
  rules.push({ pattern: /("(?:[^"\\]|\\.)*")/g, className: 'dot-string' });
  rules.push({
    pattern: /\b(strict|graph|digraph|subgraph|node|edge)\b/g,
    className: 'dot-keyword'
  });
  rules.push({
    pattern:
      /\b(rankdir|rank|label|shape|style|color|fillcolor|fontcolor|fontsize|fontname|penwidth|weight|dir|arrowhead|arrowsize|labelloc|labeljust|splines|constraint|ordering|group|peripheries|margin|width|height|fixedsize)\b/g,
    className: 'dot-attr'
  });
  rules.push({ pattern: /\b(\d+\.?\d*)\b/g, className: 'dot-number' });
  rules.push({ pattern: /(\-\>|--|=|\{|\}|\[|\]|,|:)/g, className: 'dot-operator' });
  return highlightWithRules(dot, rules, '__DOT_TOKEN_');
}

/**
 * Purpose: Render the DOT text panel in editor-like layout.
 * How: Injects line numbers + highlighted code and keeps the number gutter synced on scroll.
 */
function renderDotViewer(dotRoot, dot) {
  const lineCount = dot.split('\n').length;
  dotRoot.innerHTML = `
    <div class="code-editor dot-editor">
      <div class="line-numbers">${generateLineNumbers(lineCount)}</div>
      <div class="code-content">${highlightDot(dot)}</div>
    </div>
  `;
  const lineNumbers = dotRoot.querySelector('.line-numbers');
  const codeContent = dotRoot.querySelector('.code-content');
  codeContent.addEventListener('scroll', () => {
    lineNumbers.scrollTop = codeContent.scrollTop;
  });
}

/**
 * Purpose: Build a safe base filename from one session source filename.
 * How: Removes a trailing `.dsp` extension when present and falls back to `session`.
 */
function getBaseFilename(sessionFilename) {
  const base = String(sessionFilename || '').replace(/\.dsp$/i, '').trim();
  return base || 'session';
}

/**
 * Purpose: Download one SVG string as a local file.
 * How: Builds a Blob URL from SVG text, triggers a temporary anchor download, and revokes the URL.
 */
function downloadSvgText(filename, svgText) {
  const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Purpose: Convert viz.js errors into a user-facing message.
 * How: Detects memory/complexity failures and falls back to a concise title/detail structure.
 */
function getRenderFailureMessage(err) {
  const raw =
    err && typeof err === 'object' && 'message' in err ? String(err.message || '') : String(err || '');
  const isTooComplex = /cannot enlarge memory arrays|out of memory|oom|memory/i.test(raw);
  if (isTooComplex) {
    return {
      title: 'Graph too complex to render as SVG.',
      detail: 'DOT source is shown with priority.'
    };
  }
  if (!raw || raw === 'undefined') {
    return {
      title: 'Graph render failed.',
      detail: 'DOT source is shown with priority.'
    };
  }
  return {
    title: 'Graph render failed.',
    detail: raw
  };
}

/**
 * Purpose: Load an external script exactly once.
 * How: Reuses an existing `<script data-src>` when present, otherwise creates one and resolves on load.
 */
async function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${src}"]`);
    if (existing) {
      if (existing.getAttribute('data-loaded') === '1') {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), {
        once: true
      });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.src = src;
    script.addEventListener('load', () => {
      script.setAttribute('data-loaded', '1');
      resolve();
    });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
    document.head.appendChild(script);
  });
}

/**
 * Purpose: Ensure viz.js renderer is available before graph rendering.
 * How: Initializes Emscripten memory hints, loads viz scripts once, and returns `window.Viz`.
 */
async function ensureViz() {
  if (window.Viz) return window.Viz;
  if (!vizScriptsPromise) {
    vizScriptsPromise = (async () => {
      // Hint Emscripten runtime to allocate more memory for large DOT graphs.
      if (!window.Module || typeof window.Module !== 'object') {
        window.Module = {};
      }
      if (!window.Module.TOTAL_MEMORY || window.Module.TOTAL_MEMORY < VIZ_TOTAL_MEMORY) {
        window.Module.TOTAL_MEMORY = VIZ_TOTAL_MEMORY;
      }
      await loadScriptOnce('/vendor/viz.js/viz.js');
      await loadScriptOnce('/vendor/viz.js/full.render.js');
      if (!window.Viz) {
        throw new Error('viz.js did not expose Viz');
      }
      return window.Viz;
    })();
  }
  return vizScriptsPromise;
}

/**
 * Purpose: Render a DOT-based graph view using shared UI and behaviors.
 * How: Loads one DOT file, builds split graph/source layout, renders SVG via viz.js, and applies zoom/split controls.
 */
export async function renderDotGraphView(container, options) {
  const {
    sha,
    dotFile,
    notAvailableMessage,
    title,
    classPrefix,
    zoomAriaLabel,
    onError,
    onClearError,
    onDownload,
    sessionFilename
  } = options || {};

  let dot = '';
  try {
    const response = await fetch(`/api/${sha}/${dotFile}`);
    if (!response.ok) {
      if (response.status === 404) {
        container.innerHTML = `<div class="info">${notAvailableMessage}</div>`;
        return;
      }
      throw new Error(`Failed to load ${dotFile}`);
    }
    dot = await response.text();
  } catch (err) {
    container.innerHTML = `<div class="error">Error: ${err.message}</div>`;
    return;
  }

  container.innerHTML = `
    <div class="${classPrefix}-view">
      <div class="${classPrefix}-toolbar">
        <span class="${classPrefix}-toolbar-title">${title}</span>
        <div class="${classPrefix}-toolbar-controls">
          <div class="${classPrefix}-zoom-group">
            <span class="${classPrefix}-zoom-label">Zoom</span>
            <select class="${classPrefix}-zoom-select" aria-label="${zoomAriaLabel}">
              <option value="auto">Auto</option>
              <option value="50">50%</option>
              <option value="75">75%</option>
              <option value="100" selected>100%</option>
              <option value="125">125%</option>
              <option value="150">150%</option>
            </select>
          </div>
          <button class="${classPrefix}-toggle-split" title="Show/hide split graph and DOT source">Split view</button>
          <div class="download-select-group toolbar-download-right">
            <button class="download-select-btn ${classPrefix}-download-btn" type="button">Download</button>
            <select class="download-select-value ${classPrefix}-download-format" aria-label="${title} download format">
              <option value="dot">.dot</option>
              <option value="svg" selected>.svg</option>
            </select>
          </div>
        </div>
      </div>
      <div class="${classPrefix}-main">
        <div class="${classPrefix}-container">
          <div class="${classPrefix}-content"><div class="info">Rendering graph...</div></div>
        </div>
        <div class="${classPrefix}-splitter hidden" title="Resize graph / DOT"></div>
        <div class="${classPrefix}-dot hidden"></div>
      </div>
    </div>
  `;

  const content = container.querySelector(`.${classPrefix}-content`);
  const dotPre = container.querySelector(`.${classPrefix}-dot`);
  const splitter = container.querySelector(`.${classPrefix}-splitter`);
  const zoomSelect = container.querySelector(`.${classPrefix}-zoom-select`);
  const downloadBtn = container.querySelector(`.${classPrefix}-download-btn`);
  const downloadFormat = container.querySelector(`.${classPrefix}-download-format`);
  const toggleDotBtn = container.querySelector(`.${classPrefix}-toggle-split`);
  const containerEl = container.querySelector(`.${classPrefix}-container`);
  const mainEl = container.querySelector(`.${classPrefix}-main`);
  let zoom = 100;
  let zoomMode = 'auto';
  let splitPercent = 65;
  let baseWidth = 0;
  let baseHeight = 0;

  renderDotViewer(dotPre, dot);

  /**
   * Purpose: Apply the current split ratio between graph and DOT panels.
   * How: Clamps split percentage and updates panel flex-basis values.
   */
  function applySplit() {
    const safe = Math.max(15, Math.min(85, splitPercent));
    containerEl.style.flex = `0 0 ${safe}%`;
    dotPre.style.flex = '1 1 auto';
  }

  /**
   * Purpose: Toggle split mode visibility for the DOT panel.
   * How: Adds/removes classes and resets flex values depending on current visibility.
   */
  function setDotVisible(visible) {
    if (visible) {
      dotPre.classList.remove('hidden');
      splitter.classList.remove('hidden');
      mainEl.classList.add('split-enabled');
      applySplit();
    } else {
      dotPre.classList.add('hidden');
      splitter.classList.add('hidden');
      mainEl.classList.remove('split-enabled');
      containerEl.style.flex = '1 1 auto';
      dotPre.style.flex = '';
    }
  }

  toggleDotBtn.addEventListener('click', () => {
    setDotVisible(dotPre.classList.contains('hidden'));
  });
  if (downloadBtn && typeof onDownload === 'function') {
    downloadBtn.addEventListener('click', () => {
      const format = downloadFormat ? downloadFormat.value : '';
      if (format === 'svg') {
        const svgEl = content.querySelector('svg');
        if (svgEl) {
          const clone = svgEl.cloneNode(true);
          if (clone instanceof SVGElement) {
            clone.style.width = '';
            clone.style.height = '';
            const serializer = new XMLSerializer();
            const svgText = serializer.serializeToString(clone);
            const base = getBaseFilename(sessionFilename);
            const suffix = classPrefix === 'signals' ? '-sig' : '-tasks';
            downloadSvgText(`${base}${suffix}.svg`, svgText);
            return;
          }
        }
      }
      void onDownload(format);
    });
  }

  splitter.addEventListener('mousedown', (event) => {
    event.preventDefault();

    /**
     * Purpose: Update split ratio while dragging the splitter.
     * How: Maps pointer Y position to a percentage of the main panel height.
     */
    const onMove = (moveEvent) => {
      const rect = mainEl.getBoundingClientRect();
      if (!rect.height) return;
      splitPercent = ((moveEvent.clientY - rect.top) / rect.height) * 100;
      applySplit();
    };

    /**
     * Purpose: Stop splitter drag behavior after mouse release.
     * How: Removes temporary move/up listeners from the window.
     */
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  /**
   * Purpose: Compute automatic zoom that fits SVG inside available space.
   * How: Measures base SVG size and container size, then returns a bounded fit percentage.
   */
  function computeFitZoom() {
    const svg = content.querySelector('svg');
    if (!svg) return zoom;
    if (!baseWidth || !baseHeight) {
      svg.style.width = '';
      svg.style.height = '';
      const svgRect = svg.getBoundingClientRect();
      baseWidth = svgRect.width;
      baseHeight = svgRect.height;
    }
    const cRect = containerEl.getBoundingClientRect();
    if (!baseWidth || !baseHeight || !cRect.width || !cRect.height) return zoom;
    const widthRatio = (cRect.width - 24) / baseWidth;
    const heightRatio = (cRect.height - 24) / baseHeight;
    const fitRatio = Math.min(widthRatio, heightRatio, 1);
    return Math.max(10, Math.round(fitRatio * 100));
  }

  /**
   * Purpose: Apply current zoom mode to the rendered SVG.
   * How: Resolves auto/manual zoom, scales width/height, and toggles auto-centering styling.
   */
  function applyZoom() {
    const svg = content.querySelector('svg');
    if (!svg) return;
    if (!baseWidth || !baseHeight) {
      svg.style.width = '';
      svg.style.height = '';
      const svgRect = svg.getBoundingClientRect();
      baseWidth = svgRect.width;
      baseHeight = svgRect.height;
    }
    if (zoomMode === 'auto') {
      zoom = computeFitZoom();
    }
    const scale = zoom / 100;
    const nextWidth = Math.max(1, Math.round(baseWidth * scale));
    const nextHeight = Math.max(1, Math.round(baseHeight * scale));
    svg.style.width = `${nextWidth}px`;
    svg.style.height = `${nextHeight}px`;
    content.classList.toggle(`${classPrefix}-auto-centered`, zoomMode === 'auto');
  }

  if (zoomSelect) {
    zoomSelect.addEventListener('change', () => {
      if (zoomSelect.value === 'auto') {
        zoomMode = 'auto';
        applyZoom();
        return;
      }
      zoomMode = 'manual';
      const parsed = parseInt(zoomSelect.value, 10);
      zoom = Number.isFinite(parsed) ? parsed : 100;
      applyZoom();
    });
  }

  try {
    const Viz = await ensureViz();
    const viz = new Viz();
    const svg = await viz.renderSVGElement(dot);
    content.innerHTML = '';
    content.appendChild(svg);
    baseWidth = 0;
    baseHeight = 0;
    if (zoomSelect) {
      zoomSelect.value = 'auto';
    }
    zoomMode = 'auto';
    applyZoom();
    if (typeof onClearError === 'function') {
      onClearError();
    }
  } catch (err) {
    const msg = getRenderFailureMessage(err);
    if (typeof onError === 'function') {
      onError(`${msg.title} ${msg.detail}`.trim());
    }
    content.innerHTML = '';
    const main = container.querySelector(`.${classPrefix}-main`);
    if (main) {
      main.classList.add(`${classPrefix}-dot-only`);
    }
    setDotVisible(true);
    splitter.classList.add('hidden');
  }
}

/**
 * Purpose: Expose a disposable hook for DOT views.
 * How: No-op for now because this shared DOT renderer keeps no persistent per-instance resources.
 */
export function disposeDotGraphView() {}
