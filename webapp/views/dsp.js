/**
 * Purpose: Define the DSP source view as a live editor.
 * How: Fetches `user_code.dsp` into a CodeMirror 6 editor with Faust
 *      language support via the shared createFaustEditor() factory.
 *      Submit (button or Cmd/Ctrl+S) calls onSubmit, which the parent
 *      app maps to submitCode (creates a new sha1 and navigates).
 *      A dirty marker in the toolbar shows when the buffer is ahead of
 *      the persisted session.
 */
import { createFaustEditor } from '../vendor/codemirror/faust-editor.js';

export function getName() {
  return 'DSP Code';
}

// Only one DSP editor is alive at a time (the app destroys the previous
// view container before re-rendering).
let editor = null;
let titleEl = null;
let submitBtnEl = null;
let onSubmitCb = null;
let currentFilename = '';

function updateDirty(b) {
  if (titleEl) {
    titleEl.textContent = b ? 'DSP CODE ●' : 'DSP CODE';
    titleEl.classList.toggle('is-dirty', b);
  }
  if (submitBtnEl) submitBtnEl.disabled = !b;
}

export async function render(container, { sha, sessionFilename, onSubmit, onDownload }) {
  // Tear down any previous instance for this view.
  if (editor) { editor.destroy(); editor = null; }
  titleEl = null;
  submitBtnEl = null;
  onSubmitCb = typeof onSubmit === 'function' ? onSubmit : null;
  currentFilename = typeof sessionFilename === 'string' && sessionFilename
    ? sessionFilename
    : 'patch.dsp';

  try {
    const response = await fetch(`/api/${sha}/user_code.dsp`);
    if (!response.ok) throw new Error('Failed to load DSP code');
    const code = await response.text();

    container.innerHTML = `
      <div class="code-view">
        <div class="code-toolbar">
          <span class="code-toolbar-title">DSP CODE</span>
          <div class="code-toolbar-controls">
            <button class="primary-btn dsp-submit-btn" type="button" disabled
                    title="Compile and create a new session (Cmd/Ctrl+S)">Submit</button>
            <div class="code-zoom-group">
              <span class="code-zoom-label">Zoom</span>
              <select class="code-zoom-select" aria-label="DSP code zoom">
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
              <select class="download-select-value code-download-format" aria-label="DSP download format">
                <option value="dsp">.dsp</option>
              </select>
            </div>
          </div>
        </div>
        <div class="cm-host"></div>
      </div>
    `;

    titleEl = container.querySelector('.code-toolbar-title');
    submitBtnEl = container.querySelector('.dsp-submit-btn');
    const host = container.querySelector('.cm-host');
    const zoomSelect = container.querySelector('.code-zoom-select');
    const downloadBtn = container.querySelector('.code-download-btn');
    const downloadFormat = container.querySelector('.code-download-format');

    editor = createFaustEditor({
      doc: code,
      parent: host,
      onSubmit: (text) => onSubmitCb ? onSubmitCb(text, currentFilename) : Promise.resolve(),
      onDirty: updateDirty,
    });

    submitBtnEl.addEventListener('click', () => { void editor.submit(); });

    if (zoomSelect) {
      zoomSelect.addEventListener('change', () => {
        editor.setZoom(Number(zoomSelect.value) || 100);
      });
    }
    if (downloadBtn && typeof onDownload === 'function') {
      downloadBtn.addEventListener('click', () => {
        const format = downloadFormat ? downloadFormat.value : 'dsp';
        void onDownload(format);
      });
    }
  } catch (err) {
    container.innerHTML = `<div class="error">Error: ${err.message}</div>`;
  }
}

export function dispose() {
  if (editor) { editor.destroy(); editor = null; }
  titleEl = null;
  submitBtnEl = null;
  onSubmitCb = null;
}
