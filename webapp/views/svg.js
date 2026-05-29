/**
 * Purpose: Define the SVG diagrams view.
 * How: Loads generated SVG files for a session, supports drill-down navigation, and applies zoom controls.
 */

/**
 * Purpose: Expose the label used by the global view selector.
 * How: Returns the static display name for this module.
 */
export function getName() {
  return 'Diagrams';
}

/**
 * Purpose: Render the SVG diagrams browser for one session.
 * How: Loads available diagram files, builds navigation UI, and manages SVG loading/zoom/history state.
 */
export async function render(container, { sha, onDownload }) {
  try {
    // Fetch the available SVG file list.
    const response = await fetch(`/api/${sha}/svg`);

    if (!response.ok) {
      if (response.status === 404) {
        container.innerHTML = `<div class="info">Diagrams not available (compilation error?)</div>`;
        return;
      }
      throw new Error('Failed to load SVG list');
    }

    const { files } = await response.json();

    if (!files || files.length === 0) {
      container.innerHTML = `<div class="info">No diagrams available</div>`;
      return;
    }

    // Resolve the root diagram file (`process.svg` when available).
    const mainFile = files.find(f => f === 'process.svg') || files[0];

    // Navigation history used by the "up" action.
    const history = [];
    let currentFile = null;

    // Build the view UI.
    container.innerHTML = `
      <div class="svg-view">
        <div class="svg-toolbar">
          <span class="svg-toolbar-title">Diagrams</span>
          <div class="svg-toolbar-controls">
            <div class="svg-toolbar-pill svg-file-pill">
              <span>File</span>
              <span class="svg-current-file"></span>
            </div>
            <div class="svg-toolbar-pill svg-nav-pill">
              <button class="svg-nav-btn svg-pill-action svg-nav-single" data-action="up" disabled title="Up to parent">Nav &#8593;</button>
            </div>
            <div class="svg-toolbar-pill svg-zoom-pill">
              <span>Zoom</span>
              <div class="svg-pill-value">
                <select class="svg-zoom-select" aria-label="Diagram zoom">
                  <option value="auto">Auto</option>
                  <option value="50">50%</option>
                  <option value="75">75%</option>
                  <option value="100" selected>100%</option>
                  <option value="125">125%</option>
                  <option value="150">150%</option>
                </select>
              </div>
            </div>
            <div class="download-select-group toolbar-download-right">
              <button class="download-select-btn svg-download-btn" type="button">Download</button>
              <select class="download-select-value svg-download-format" aria-label="Diagram download format">
                <option value="svg">.svg (.tar.gz)</option>
              </select>
            </div>
          </div>
        </div>
        <div class="svg-container">
          <div class="svg-progress hidden">
            <div class="svg-progress-text">Loading...</div>
          </div>
          <div class="svg-content"></div>
        </div>
      </div>
    `;

    const svgContent = container.querySelector('.svg-content');
    const svgContainer = container.querySelector('.svg-container');
    const zoomSelect = container.querySelector('.svg-zoom-select');
    const upBtn = container.querySelector('[data-action="up"]');
    const currentFileLabel = container.querySelector('.svg-current-file');
    const downloadBtn = container.querySelector('.svg-download-btn');
    const downloadFormat = container.querySelector('.svg-download-format');
    const progressOverlay = container.querySelector('.svg-progress');
    let currentZoom = 100;
    let zoomMode = 'manual';
    if (downloadBtn && typeof onDownload === 'function') {
      downloadBtn.addEventListener('click', () => {
        const format = downloadFormat ? downloadFormat.value : '';
        void onDownload(format);
      });
    }

    /**
     * Purpose: Intercept clicks on links inside rendered SVG diagrams.
     * How: Walks up from event target to `<a>`, resolves target filename, and loads matching local SVG files.
     */
    function svgClickHandler(e) {
      // Find a parent link.
      let target = e.target;
      while (target && target !== svgContent) {
        if (target.tagName.toLowerCase() === 'a') {
          const href = target.getAttribute('xlink:href') || target.getAttribute('href');
          if (href) {
            // Extract the linked SVG filename.
            const match = href.match(/(?:.*\/)?([^\/]+\.svg)$/);
            if (match) {
              const filename = match[1];
              if (files.includes(filename)) {
                e.preventDefault();
                e.stopPropagation();
                loadSvg(filename);
                return;
              }
            }
          }
        }
        target = target.parentElement;
      }
    }

    /**
     * Purpose: Control the loading overlay visibility.
     * How: Toggles the `hidden` class on the progress element.
     */
    function showProgress(show) {
      progressOverlay.classList.toggle('hidden', !show);
    }

    /**
     * Purpose: Load and display one SVG file in the viewer.
     * How: Updates history/UI state, fetches the SVG content, injects it, and reattaches click interception.
     */
    async function loadSvg(filename, addToHistory = true) {
      showProgress(true);

      // Push previous file to history for forward navigation semantics.
      if (addToHistory && currentFile && currentFile !== filename) {
        history.push(currentFile);
      }
      currentFile = filename;

      // Update navigation and current file indicators.
      upBtn.disabled = currentFile === mainFile;
      currentFileLabel.textContent = filename;

      try {
        const svgResponse = await fetch(`/api/${sha}/svg/${filename}`);
        if (!svgResponse.ok) {
          svgContent.innerHTML = `<div class="error">Failed to load ${filename}</div>`;
          return;
        }
        const svgText = await svgResponse.text();
        svgContent.innerHTML = svgText;

        // Re-apply current zoom mode after content replacement.
        applyZoom();

        // Rebind click interception in capture phase.
        svgContent.removeEventListener('click', svgClickHandler, true);
        svgContent.addEventListener('click', svgClickHandler, true);

      } finally {
        showProgress(false);
      }
    }

    /**
     * Purpose: Navigate one level back toward the root diagram.
     * How: Pops history when available, otherwise returns to `mainFile`.
     */
    function goUp() {
      if (currentFile === mainFile) return;
      if (history.length > 0) {
        const prev = history.pop();
        loadSvg(prev, false);
        return;
      }
      loadSvg(mainFile, false);
    }

    /**
     * Purpose: Compute automatic zoom that fits SVG inside the viewport.
     * How: Measures current SVG and container dimensions and returns a bounded fit percentage.
     */
    function computeFitZoom() {
      const svg = svgContent.querySelector('svg');
      if (!svg) return currentZoom;
      svg.style.transform = 'none';
      const svgRect = svg.getBoundingClientRect();
      const containerRect = svgContainer.getBoundingClientRect();
      if (!svgRect.width || !svgRect.height) return currentZoom;
      const widthRatio = (containerRect.width - 40) / svgRect.width;
      const heightRatio = (containerRect.height - 40) / svgRect.height;
      const fitRatio = Math.min(widthRatio, heightRatio, 1);
      return Math.max(25, Math.min(400, Math.round(fitRatio * 100)));
    }

    /**
     * Purpose: Apply current zoom settings to the displayed SVG.
     * How: Resolves auto/manual zoom and writes a CSS scale transform anchored at top-left.
     */
    function applyZoom() {
      const svg = svgContent.querySelector('svg');
      if (!svg) return;
      if (zoomMode === 'auto') {
        currentZoom = computeFitZoom();
      }
      svg.style.transform = `scale(${currentZoom / 100})`;
      svg.style.transformOrigin = 'top left';
    }

    // Bind navigation actions.
    container.querySelectorAll('.svg-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'up') goUp();
      });
    });

    if (zoomSelect) {
      zoomSelect.addEventListener('change', () => {
        if (zoomSelect.value === 'auto') {
          zoomMode = 'auto';
          applyZoom();
          return;
        }
        zoomMode = 'manual';
        const parsed = parseInt(zoomSelect.value, 10);
        currentZoom = Number.isFinite(parsed) ? parsed : 100;
        applyZoom();
      });
    }

    // Load initial SVG file.
    if (zoomSelect) {
      zoomSelect.value = 'auto';
      zoomMode = 'auto';
    }
    await loadSvg(mainFile, false);

  } catch (err) {
    container.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}
