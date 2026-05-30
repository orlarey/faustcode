/**
 * Purpose: Define the Run view runtime for real-time Faust execution.
 * How: Compiles DSP to WebAudio, manages UI/MIDI/orbit interactions, and synchronizes run state locally and remotely.
 */
import { OrbitUI } from '../vendor/faust-orbit-ui/index.js';
import { TOOLTIP_TEXTS } from '../tooltip-texts.js';
import {
  MAX_COMPILED_RUN_CACHE,
  PARAM_SMOOTH_INTERVAL_MS,
  PARAM_SMOOTH_EPSILON,
  ORBIT_PARAM_SYNC_INTERVAL_MS,
  ORBIT_POSITION_EPSILON,
} from './shared/run-constants.js';
import {
  clamp,
  sleep,
  getCanvasSize,
  resizeCanvasToDisplaySize,
  isStaleRunRenderError,
  throwIfStaleRender
} from './shared/run-utils.js';
import {
  normalizeRunParamCells,
  cloneParamCells,
  fingerprintRunParams
} from './shared/run-params-utils.js';
import {
  setMidiUiKeyActive,
  releaseComputerMidiNotes,
  isTypingTarget
} from './shared/run-midi-utils.js';
import {
  buildLogBands,
  detectTopPeaks,
  computeSpectrumFeatures,
  computeAudioQuality
} from './shared/run-spectrum-utils.js';
import {
  findTriggeredWindow,
  drawScopeGrid,
  drawFreqAxis,
  drawSpectrumGrid
} from './shared/run-scope-utils.js';
import { aggregateMaxHold } from '../spectrum.js';

// Audio graph runtime (single active DSP instance for the Run view).
let audioContext = null;
let dspNode = null;
let analyserNode = null;
let outputNode = null;
let audioRunning = false;
let scopeRafId = null;
let scopeState = null;
let currentSha = null;
let compiledGenerator = null;
let compiledGeneratorMode = 'mono';
let compiledUI = null;
let faustUIInstance = null;
let currentUiRoot = null;
let controlsBg = null;
let controlsContent = null;
let controlsSplit = null;
let controlsClassicPane = null;
let controlsOrbitPane = null;
// Shared param state for this view:
// - `paramValues` is the fast numeric cache used by UI rendering and DSP polling.
// - `paramCells` is the authoritative sync shape { v, d } mirrored to backend.
// - `paramMetaByPath` stores min/max bounds extracted from Faust UI JSON.
let paramValues = {};
let paramCells = {};
let paramMetaByPath = new Map();
let uiParamPaths = [];
let uiButtonPaths = new Set();
let uiButtonOrder = [];
let lastUiButtonPath = null;
let pressedUiButtons = new Set();
let uiReleaseHandlersInstalled = false;
let uiReleaseGuardHandler = null;
let emitRunStateFn = null;
let runActivityTick = 0;
let lastSpectrumSentAt = 0;
let lastSpectrumSummary = null;
let lastAudioQuality = null;
let polyVoices = 0;
let midiTargets = null;
let activeMidiNote = null;
let midiAccess = null;
let midiAccessPromise = null;
let midiSource = 'virtual';
let midiInput = null;
let midiOnly = true;
let midiKeyboardKeyDownHandler = null;
let midiKeyboardKeyUpHandler = null;
let midiKeyboardBlurHandler = null;
let midiComputerActiveNotes = new Map();
let midiUiKeyByNote = new Map();
let runSpaceKeyHandler = null;
let runSpaceKeyUpHandler = null;
let runSpaceBlurHandler = null;
let runSpacePressedPath = null;
let paramPollId = null;
let outputParamHandlerAttached = false;
let uiZoom = 'auto';
let orbitZoom = '100';
let uiZoomWrap = null;
let uiZoomStage = null;
let uiResizeObserver = null;
let remoteSyncTimer = null;
let lastRunParamsSentAt = 0;
let lastAppliedTransportNonce = 0;
let lastAppliedTriggerNonce = 0;
let lastAppliedMidiNonce = 0;
let isSwitchingPolyphony = false;
let runViewEnteredAt = 0;
let orbitCanvas = null;
let orbitBody = null;
let orbitCtx = null;
let orbitState = null;
let orbitPointer = null;
let orbitNeedsDraw = false;
let orbitRafId = null;
let orbitResizeObserver = null;
let pendingOrbitUi = null;
let orbitBaseWidth = 0;
let orbitBaseHeight = 0;
let orbitRenderScale = 1;
let orbitRenderOffsetX = 0;
let orbitRenderOffsetY = 0;
let lastOrbitParamSyncAt = 0;
let orbitParamSyncTimer = null;
let orbitUiInstance = null;
let orbitUiBatchDepth = 0;
let orbitUiBatchSnapshotPending = false;
let orbitUiBatchLastSentAt = 0;
let orbitPaneResizeObserver = null;
let orbitPaneResizeRaf = null;
let orbitLayoutRetryTimer = null;
let runRenderSeq = 0;
let remoteSyncInFlight = false;
let suppressUiParamChangeDepth = 0;
const suppressedUiParamEchoByPath = new Map();
const compiledRunCache = new Map();
const paramSmooth = new Map();
const RUN_PERF_LOG_ENABLED = true;

// MCP control surface : populated by render() so external callers
// (handlers.js for MCP tools) can invoke the closures defined inside
// render(). Cleared by dispose() so callers see a clean "not mounted"
// signal between view switches.
let _mcpController = null;

/**
 * Purpose: Provide lightweight performance tracing for Run view critical paths.
 * How: Emits structured console logs with elapsed time from an optional start timestamp.
 */
function logRunPerf(stage, startMs = null, details = '') {
  if (!RUN_PERF_LOG_ENABLED || typeof console === 'undefined') return;
  const elapsed = typeof startMs === 'number'
    ? ` +${Math.round(performance.now() - startMs)}ms`
    : '';
  const suffix = details ? ` | ${details}` : '';
  console.log(`[run-perf] ${stage}${elapsed}${suffix}`);
}

/**
 * Purpose: Execute programmatic UI updates without treating them as local user edits.
 * How: Increments a re-entrant suppression depth around a callback and restores it in `finally`.
 */
function withSuppressedUiParamChange(fn) {
  suppressUiParamChangeDepth += 1;
  try {
    return fn();
  } finally {
    suppressUiParamChangeDepth = Math.max(0, suppressUiParamChangeDepth - 1);
  }
}

/**
 * Purpose: Tag one programmatic DSP->UI param update to avoid feedback loops.
 * How: Stores `{value, until}` for the path so asynchronous UI echo callbacks can be ignored briefly.
 */
function markSuppressedUiParamEcho(path, value, windowMs = 200) {
  if (!path) return;
  const safeWindow = Math.max(40, Math.min(1000, Math.round(windowMs)));
  suppressedUiParamEchoByPath.set(path, {
    value: Number(value),
    until: Date.now() + safeWindow
  });
}

/**
 * Purpose: Detect whether a UI callback is an echo of a recent programmatic update.
 * How: Matches path/value against a short-lived suppression map and clears expired entries lazily.
 */
function isSuppressedUiParamEcho(path, value) {
  if (!path) return false;
  const entry = suppressedUiParamEchoByPath.get(path);
  if (!entry) return false;
  const now = Date.now();
  if (!entry.until || now > entry.until) {
    suppressedUiParamEchoByPath.delete(path);
    return false;
  }
  const uiValue = Number(value);
  if (!Number.isFinite(uiValue) || !Number.isFinite(entry.value)) return false;
  return Math.abs(uiValue - entry.value) <= 1e-6;
}

/**
 * Purpose: Keep compiled run-program cache size bounded.
 * How: Sorts entries by least-recently-used timestamp and removes oldest entries until cap is respected.
 */
function pruneCompiledRunCache() {
  if (compiledRunCache.size <= MAX_COMPILED_RUN_CACHE) return;
  const entries = [...compiledRunCache.entries()]
    .sort((a, b) => Number(a[1]?.usedAt || 0) - Number(b[1]?.usedAt || 0));
  while (compiledRunCache.size > MAX_COMPILED_RUN_CACHE && entries.length > 0) {
    const [key] = entries.shift();
    compiledRunCache.delete(key);
  }
}

/**
 * Purpose: Implement `getName` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
export function getName() {
  return 'Run';
}

/**
 * Purpose: Implement `render` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
export async function render(container, { sha, runState, onRunStateChange, onDownload }) {
  const renderStartedAt = performance.now();
  logRunPerf('render:start', null, `sha=${sha} ua=${navigator.userAgent}`);
  // Live auto-refresh can re-render Run without a view switch.
  // Ensure no timer/listener/audio instance from a previous Run render survives.
  dispose();
  const renderSeq = ++runRenderSeq;
  currentSha = sha;
  const isRenderStale = () => renderSeq !== runRenderSeq || currentSha !== sha;
  runViewEnteredAt = Date.now();
  lastSpectrumSummary = null;
  lastAudioQuality = null;
  const previousViewNodes = Array.from(container.children);
  const runRoot = document.createElement('div');
  runRoot.className = 'run-view run-view-pending';
  const useOverlaySwap = previousViewNodes.length > 0;

  runRoot.innerHTML = `
    <div class="run-header">
      <span class="run-note run-header-title">RUN</span>
      <div class="run-midi-inline hidden" id="run-midi-inline"></div>
      <div class="run-header-controls">
        <button id="run-audio-toggle" class="run-audio-toggle is-off" type="button" aria-label="Audio state" aria-pressed="false">
          <span>Audio</span>
          <span id="run-audio-toggle-value" class="run-audio-toggle-value">Off</span>
        </button>
        <label class="run-header-pill">
          <span>Mode</span>
          <select id="run-mode">
            <option value="mono">Mono</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="4">4</option>
            <option value="8">8</option>
            <option value="16">16</option>
            <option value="32">32</option>
            <option value="64">64</option>
          </select>
        </label>
        <label class="run-header-pill">
          <span>MIDI</span>
          <select id="midi-input"></select>
        </label>
        <div class="download-select-group toolbar-download-right">
          <button id="run-download-btn" class="download-select-btn" type="button">Download</button>
          <select id="run-download-format" class="download-select-value" aria-label="Run download format">
            <option value="pwa">pwa (.tar.gz)</option>
          </select>
        </div>
      </div>
    </div>
    <div class="run-controls" id="run-controls"></div>
    <div class="run-scope">
      <div class="run-scope-header">
        <span class="run-scope-title">Oscilloscope</span>
        <div class="run-scope-controls">
          <label class="run-scope-pill">View
            <select id="scope-view">
              <option value="time">Waveform</option>
              <option value="freq">Spectrum</option>
            </select>
          </label>
          <label class="run-scope-pill">Scale
            <select id="scope-scale">
              <option value="log">Log</option>
              <option value="linear">Linear</option>
            </select>
          </label>
          <label class="run-scope-pill">Trigger
            <select id="scope-mode">
              <option value="auto">Auto</option>
              <option value="normal">Normal</option>
            </select>
          </label>
          <label class="run-scope-pill">Slope
            <select id="scope-slope">
              <option value="rising">Rising</option>
              <option value="falling">Falling</option>
            </select>
          </label>
          <label class="run-scope-pill">Threshold
            <input id="scope-threshold" class="scope-input" type="number" step="0.01" value="0.0">
          </label>
          <label class="run-scope-pill">Holdoff (ms)
            <input id="scope-holdoff" class="scope-input" type="number" step="1" value="20">
          </label>
        </div>
      </div>
      <canvas id="scope-canvas" width="640" height="160"></canvas>
    </div>
  `;
  if (useOverlaySwap) {
    container.classList.add('run-view-host-swapping');
  }
  container.appendChild(runRoot);
  /**
   * Purpose: Commit the new Run DOM mount after asynchronous render preparation.
   * How: Removes pending state classes, drops previous view nodes, and clears swap host styling.
   */
  const finalizeRunMount = () => {
    if (!runRoot.isConnected) return;
    runRoot.classList.remove('run-view-pending');
    for (const node of previousViewNodes) {
      if (node && node.parentElement === container) {
        node.remove();
      }
    }
    if (useOverlaySwap) {
      container.classList.remove('run-view-host-swapping');
    }
  };
  /**
   * Purpose: Roll back a partially mounted Run DOM tree when render is aborted.
   * How: Removes transient mount nodes and restores host swap styling to default.
   */
  const discardRunMount = () => {
    if (runRoot && runRoot.parentElement === container) {
      runRoot.remove();
    }
    if (useOverlaySwap) {
      container.classList.remove('run-view-host-swapping');
    }
  };

  const audioToggleButton = runRoot.querySelector('#run-audio-toggle');
  const audioToggleValue = runRoot.querySelector('#run-audio-toggle-value');
  const modeSelect = runRoot.querySelector('#run-mode');
  const midiInputSelect = runRoot.querySelector('#midi-input');
  const downloadButton = runRoot.querySelector('#run-download-btn');
  const downloadFormatSelect = runRoot.querySelector('#run-download-format');
  const midiInlineEl = runRoot.querySelector('#run-midi-inline');
  const controlsEl = runRoot.querySelector('#run-controls');
  const scopeCanvas = runRoot.querySelector('#scope-canvas');
  const scopeView = runRoot.querySelector('#scope-view');
  const scopeScale = runRoot.querySelector('#scope-scale');
  const scopeMode = runRoot.querySelector('#scope-mode');
  const scopeSlope = runRoot.querySelector('#scope-slope');
  const scopeThreshold = runRoot.querySelector('#scope-threshold');
  const scopeHoldoff = runRoot.querySelector('#scope-holdoff');
  const noteEl = runRoot.querySelector('.run-note');
  let audioLocked = false;
  /**
   * Purpose: Implement `setAudioToggleState` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const setAudioToggleState = (isOn) => {
    if (!audioToggleButton || !audioToggleValue) return;
    const safeIsOn = !!isOn;
    audioToggleButton.classList.toggle('is-on', safeIsOn);
    audioToggleButton.classList.toggle('is-off', !safeIsOn);
    audioToggleButton.setAttribute('aria-pressed', safeIsOn ? 'true' : 'false');
    audioToggleValue.textContent = safeIsOn ? 'On' : 'Off';
  };
  /**
   * Purpose: Implement `setAudioToggleDisabled` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const setAudioToggleDisabled = (disabled) => {
    if (!audioToggleButton) return;
    audioToggleButton.disabled = !!disabled;
  };

  function updateRunNote() {
    if (!noteEl) return;
    noteEl.textContent = 'RUN';
    noteEl.classList.toggle('run-note-locked', audioLocked);
    noteEl.title = audioLocked ? 'Audio is locked in this browser tab' : 'Run view';
  }

  /**
   * Purpose: Implement `setAudioLocked` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  function setAudioLocked(locked) {
    audioLocked = !!locked;
    updateRunNote();
  }

  updateRunNote();
  if (downloadButton && typeof onDownload === 'function') {
    downloadButton.addEventListener('click', () => {
      const format = downloadFormatSelect ? downloadFormatSelect.value : '';
      void onDownload(format);
    });
  }

  scopeState = createScopeState(scopeCanvas);
  drawScopePlaceholder(scopeState);
  applyRunState(runState, {
    scopeView,
    scopeScale,
    scopeMode,
    scopeSlope,
    scopeThreshold,
    scopeHoldoff,
    modeSelect,
    midiInputSelect
  });
  // Keep control labels aligned with effective internal scope state.
  scopeView.value = scopeState.view;
  scopeScale.value = scopeState.spectrumScale;
  scopeMode.value = scopeState.mode;
  scopeSlope.value = scopeState.slope;
  scopeThreshold.value = String(scopeState.threshold);
  scopeHoldoff.value = String(scopeState.holdoffMs);
  paramValues = runState && runState.params ? { ...runState.params } : {};
  paramCells = normalizeRunParamCells(runState && runState.paramCells ? runState.paramCells : runState?.params);
  for (const [path, cell] of Object.entries(paramCells)) {
    paramValues[path] = cell.v;
  }
  paramMetaByPath = new Map();
  pendingOrbitUi = runState && runState.orbitUi ? runState.orbitUi : null;
  /**
   * Purpose: Implement `emitRunState` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const emitRunState = () => {
    if (typeof onRunStateChange === 'function') {
      onRunStateChange(getState());
    }
  };
  emitRunStateFn = emitRunState;
  scopeView.addEventListener('change', () => {
    scopeState.view = scopeView.value;
    if (!audioRunning) drawScopePlaceholder(scopeState);
    emitRunState();
  });
  scopeScale.addEventListener('change', () => {
    scopeState.spectrumScale = scopeScale.value;
    if (!audioRunning) drawScopePlaceholder(scopeState);
    emitRunState();
  });
  scopeMode.addEventListener('change', () => {
    scopeState.mode = scopeMode.value;
    if (!audioRunning) drawScopePlaceholder(scopeState);
    emitRunState();
  });
  scopeSlope.addEventListener('change', () => {
    scopeState.slope = scopeSlope.value;
    if (!audioRunning) drawScopePlaceholder(scopeState);
    emitRunState();
  });
  scopeThreshold.addEventListener('change', () => {
    scopeState.threshold = parseFloat(scopeThreshold.value);
    if (!audioRunning) drawScopePlaceholder(scopeState);
    emitRunState();
  });
  scopeHoldoff.addEventListener('change', () => {
    scopeState.holdoffMs = parseFloat(scopeHoldoff.value);
    if (!audioRunning) drawScopePlaceholder(scopeState);
    emitRunState();
  });

  /**
   * Purpose: Implement `renderInlineVirtualKeyboard` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const renderInlineVirtualKeyboard = () => {
    if (!midiInlineEl) return;
    renderMidiKeyboard(midiInlineEl, compiledUI, {
      noteOn: async (note, velocity) => {
        if (!audioRunning) await startAudio();
        noteOnMidi(note, velocity);
      },
      noteOff: (note) => noteOffMidi(note)
    }, { compact: true, showHint: false, showEmptyMessage: false });
  };

  /**
   * Purpose: Implement `updateMidi` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const updateMidi = async () => {
    if (!midiInlineEl) return;
    if (polyVoices > 0) {
      renderInlineVirtualKeyboard();
      if (midiSource === 'virtual') {
        midiInlineEl.classList.remove('hidden');
      } else {
        midiInlineEl.classList.add('hidden');
        midiInlineEl.innerHTML = '';
        detachComputerMidiKeyboard();
      }
    } else {
      midiInlineEl.classList.add('hidden');
      midiInlineEl.innerHTML = '';
      detachComputerMidiKeyboard();
      noteOffMidi();
    }
    await updateMidiSourceUi();
  };

  /**
   * Purpose: Implement `updateMidiSourceUi` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const updateMidiSourceUi = async (selectedValue = null) => {
    if (!midiInputSelect) return;
    const preferred =
      selectedValue || midiSource || midiInputSelect.value || 'virtual';
    await refreshMidiInputs(midiInputSelect, preferred);
    const value = midiInputSelect.value || preferred || 'virtual';
    midiSource = value;
    if (value === 'virtual') {
      disconnectMidiDevice();
      if (polyVoices > 0) {
        midiInlineEl.classList.remove('hidden');
        if (!midiInlineEl.firstElementChild) {
          renderInlineVirtualKeyboard();
        }
      }
    } else {
      midiInlineEl.classList.add('hidden');
      midiInlineEl.innerHTML = '';
      detachComputerMidiKeyboard();
      await selectMidiDevice(value);
    }
    midiOnly = true;
  };

  /**
   * Purpose: Implement `publishPolyphonyState` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  async function publishPolyphonyState() {
    try {
      await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runPolyphony: polyVoices })
      });
    } catch {
      // ignore
    }
  }

  /**
   * Purpose: Implement `applyPolyphonyChange` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  async function applyPolyphonyChange(nextVoices) {
    if (isSwitchingPolyphony) return;
    const allowed = new Set([0, 1, 2, 4, 8, 16, 32, 64]);
    const normalized = Math.max(0, Math.round(Number(nextVoices) || 0));
    const safeVoices = allowed.has(normalized) ? normalized : 0;
    if (safeVoices === polyVoices) return;
    isSwitchingPolyphony = true;
    polyVoices = safeVoices;
    modeSelect.value = polyVoices > 0 ? String(polyVoices) : 'mono';
    setAudioToggleDisabled(true);
    setAudioToggleState(audioRunning);
    emitRunState();
    const wasRunning = audioRunning;
    try {
      cleanupAudio();
      compiledGenerator = null;
      compiledGeneratorMode = 'mono';
      await compileAndRenderUI(controlsEl, sha, polyVoices, { isStale: isRenderStale });
      throwIfStaleRender(isRenderStale);
      await updateMidi();
      throwIfStaleRender(isRenderStale);
      await publishPolyphonyState();
      throwIfStaleRender(isRenderStale);
      if (wasRunning) {
        await startAudio();
      } else {
        setAudioToggleState(false);
      }
    } catch (err) {
      if (!isStaleRunRenderError(err)) {
        throw err;
      }
    } finally {
      setAudioToggleDisabled(false);
      isSwitchingPolyphony = false;
    }
  }

  midiInputSelect.addEventListener('change', async () => {
    await updateMidiSourceUi(midiInputSelect.value);
    emitRunState();
  });

  modeSelect.addEventListener('change', async () => {
    const value = modeSelect.value;
    const voices = value === 'mono' ? 0 : Math.max(1, parseInt(value, 10));
    await applyPolyphonyChange(voices);
  });

  setAudioToggleDisabled(true);
  setAudioToggleState(audioRunning);

  try {
    const compileStartedAt = performance.now();
    await compileAndRenderUI(controlsEl, sha, polyVoices, { isStale: isRenderStale });
    logRunPerf('render:compileAndRenderUI:done', compileStartedAt, `sha=${sha} mode=${polyVoices > 0 ? `poly:${polyVoices}` : 'mono'}`);
    throwIfStaleRender(isRenderStale);
    const midiStartedAt = performance.now();
    void updateMidi()
      .then(() => {
        logRunPerf('render:updateMidi:done', midiStartedAt, `sha=${sha}`);
      })
      .catch(() => {
        logRunPerf('render:updateMidi:error', midiStartedAt, `sha=${sha}`);
      });
    throwIfStaleRender(isRenderStale);
    setAudioToggleState(audioRunning);
  } catch (err) {
    if (isStaleRunRenderError(err)) {
      discardRunMount();
      return;
    }
    setAudioToggleState(false);
    const message = err && err.message ? err.message : String(err);
    if (controlsContent) {
      controlsContent.innerHTML = `<div class="error">Error: ${message}</div>`;
    } else {
      controlsEl.innerHTML = `<div class="error">Error: ${message}</div>`;
    }
  } finally {
    setAudioToggleDisabled(false);
    finalizeRunMount();
  }

  /**
   * Purpose: Implement `startAudio` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const startAudio = async () => {
    if (audioRunning) return;
    setAudioToggleDisabled(true);
    setAudioToggleState(false);

    try {
      const desiredMode = polyVoices > 0 ? `poly:${polyVoices}` : 'mono';
      if (!compiledGenerator || compiledGeneratorMode !== desiredMode) {
        await compileAndRenderUI(controlsEl, sha, polyVoices, { isStale: isRenderStale });
        throwIfStaleRender(isRenderStale);
      }
      if (!compiledGenerator) {
        throw new Error('Compilation failed');
      }

      if (!audioContext) {
        audioContext = new AudioContext();
        dspNode =
          polyVoices > 0
            ? await compiledGenerator.createNode(audioContext, polyVoices)
            : await compiledGenerator.createNode(audioContext);
        attachOutputParamHandler();
        outputNode = setupScope(audioContext, dspNode, scopeState);
      }
      applyParamValues();
      await resumeAudioContext();
      throwIfStaleRender(isRenderStale);
      setAudioLocked(false);
      startAudioOutput();
      startParamPolling();

      setAudioToggleState(true);
      emitRunState();
    } catch (err) {
      if (isStaleRunRenderError(err)) return;
      console.error('Run view error:', err);
      const message = err && err.message ? err.message : String(err);
      const isLocked =
        typeof message === 'string' &&
        message.toLowerCase().includes('audio start blocked by browser policy');
      if (isLocked) {
        setAudioLocked(true);
      }
      cleanupAudio();
      setAudioToggleState(false);
      const stack = err && err.stack ? err.stack : '';
      if (controlsContent) {
        controlsContent.innerHTML = `
          <div class="error">Error: ${message}</div>
          <pre class="run-stack">${stack}</pre>
        `;
      } else {
        controlsEl.innerHTML = `
          <div class="error">Error: ${message}</div>
          <pre class="run-stack">${stack}</pre>
        `;
      }
    } finally {
      setAudioToggleDisabled(false);
    }
  };

  /**
   * Purpose: Implement `stopAudio` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const stopAudio = () => {
    if (!audioRunning) return;
    stopAudioOutput();
    noteOffMidi();
    stopParamPolling();
    setAudioToggleState(false);
    emitRunState();
  };

  audioToggleButton.addEventListener('click', async () => {
    if (audioToggleButton.disabled) return;
    if (audioRunning) {
      stopAudio();
    } else {
      await startAudio();
    }
  });

  // Expose the startAudio / stopAudio / polyphony closures so MCP
  // handlers can drive this same runtime instead of a parallel one.
  _mcpController = { startAudio, stopAudio, applyPolyphonyChange };

  remoteSyncTimer = setInterval(syncRemoteRunState, 120);
  const firstSyncStartedAt = performance.now();
  await syncRemoteRunState();
  logRunPerf('render:firstRemoteSync:done', firstSyncStartedAt, `sha=${sha}`);

  if (runState && runState.audioRunning) {
    const startAudioStartedAt = performance.now();
    await startAudio();
    logRunPerf('render:startAudio:done', startAudioStartedAt, `sha=${sha}`);
  }
  await publishPolyphonyState();
  logRunPerf('render:done', renderStartedAt, `sha=${sha}`);
  emitRunState();

  /**
   * Purpose: Implement `executeRemoteMidi` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  async function executeRemoteMidi(runMidi) {
    if (!runMidi || typeof runMidi !== 'object') return;
    const action = runMidi.action;
    const note =
      typeof runMidi.note === 'number' && Number.isFinite(runMidi.note)
        ? Math.max(0, Math.min(127, Math.round(runMidi.note)))
        : 60;
    const velocity =
      typeof runMidi.velocity === 'number' && Number.isFinite(runMidi.velocity)
        ? Math.max(0, Math.min(1, runMidi.velocity))
        : 0.8;
    const holdMs =
      typeof runMidi.holdMs === 'number' && Number.isFinite(runMidi.holdMs)
        ? Math.max(1, Math.min(5000, Math.round(runMidi.holdMs)))
        : 120;
    if (action === 'on') {
      if (!audioRunning) await startAudio();
      noteOnMidi(note, velocity);
      return;
    }
    if (action === 'off') {
      noteOffMidi(note);
      return;
    }
    if (action === 'pulse') {
      if (!audioRunning) await startAudio();
      noteOnMidi(note, velocity);
      await sleep(holdMs);
      noteOffMidi(note);
    }
  }

/**
 * Purpose: Reconcile local and backend run-parameter snapshots during one SYNC tick.
 * How: Builds `D'` per path by timestamp, applies local value deltas via hub path (`setParamValue`), then conditionally publishes.
 */
function reconcileRemoteRunParams(remoteParams) {
  const now = Date.now();
  const localSnapshot = cloneParamCells(normalizeRunParamCells(paramCells, now));
  const remoteSnapshot = normalizeRunParamCells(remoteParams, now);
  const reconciled = {};
  const keys = new Set([...Object.keys(localSnapshot), ...Object.keys(remoteSnapshot)]);

  for (const path of keys) {
    const localCell = localSnapshot[path];
    const remoteCell = remoteSnapshot[path];
    if (localCell && !remoteCell) {
      reconciled[path] = { v: localCell.v, d: localCell.d, owner: null };
      continue;
    }
    if (!localCell && remoteCell) {
      reconciled[path] = { v: remoteCell.v, d: remoteCell.d, owner: null };
      continue;
    }
    if (!localCell || !remoteCell) continue;
    if (localCell.d >= remoteCell.d) {
      reconciled[path] = { v: localCell.v, d: localCell.d, owner: null };
    } else {
      reconciled[path] = { v: remoteCell.v, d: remoteCell.d, owner: null };
    }
  }

  let anyLocalDelta = false;
  for (const [path, cell] of Object.entries(reconciled)) {
    const localCell = localSnapshot[path];
    const localValue = localCell ? Number(localCell.v) : NaN;
    const nextValue = Number(cell.v);
    if (!Number.isFinite(localValue) || Math.abs(localValue - nextValue) > 1e-9) {
      if (uiButtonPaths.has(path) && nextValue <= 0) {
        pressedUiButtons.delete(path);
      }
      setParamValue(path, nextValue, {
        timestamp: Number(cell.d),
        skipSnapshot: true,
        skipEmit: true,
        skipOrbitSync: true
      });
      anyLocalDelta = true;
    }
  }

  // Commit freshness timestamps (`L := D'`) without overwriting newer local writes.
  let anyFreshnessCommit = false;
  for (const [path, cell] of Object.entries(reconciled)) {
    const current = paramCells[path];
    if (!current || current.d <= cell.d) {
      paramCells[path] = { v: cell.v, d: cell.d, owner: null };
      paramValues[path] = cell.v;
      anyFreshnessCommit = true;
    }
  }

  if (anyLocalDelta || anyFreshnessCommit) {
    requestOrbitSyncFromParams();
    if (emitRunStateFn) emitRunStateFn();
  }

  const remoteFingerprint = fingerprintRunParams(remoteSnapshot);
  const reconciledFingerprint = fingerprintRunParams(reconciled);
  return {
    shouldPublish: remoteFingerprint !== reconciledFingerprint,
    reconciled
  };
}

/**
 * Purpose: Implement `syncRemoteRunState` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
async function syncRemoteRunState() {
    if (!currentSha) return;
    if (remoteSyncInFlight) return;
    remoteSyncInFlight = true;
    try {
      const response = await fetch('/api/state');
      if (!response.ok) return;
      const remote = await response.json();
      if (!remote || remote.sha1 !== currentSha) return;

      {
        const remoteRunParams =
          remote.runParams && typeof remote.runParams === 'object'
            ? remote.runParams
            : {};
        const reconciled = reconcileRemoteRunParams(remoteRunParams);
        if (reconciled.shouldPublish) {
          sendRunParamsSnapshot();
        }
      }

      if (remote.runTransport && typeof remote.runTransport.nonce === 'number') {
        const cmd = remote.runTransport;
        if (cmd.nonce < runViewEnteredAt) {
          // Ignore stale transport commands created before entering this Run instance.
          // Still advance local nonce tracker to avoid re-checking the same stale command forever.
          lastAppliedTransportNonce = Math.max(lastAppliedTransportNonce, cmd.nonce);
        } else if (cmd.nonce !== lastAppliedTransportNonce) {
          lastAppliedTransportNonce = cmd.nonce;
          if (!isSwitchingPolyphony) {
            if (cmd.action === 'start') {
              if (!audioRunning) await startAudio();
            } else if (cmd.action === 'stop') {
              if (audioRunning) stopAudio();
            } else if (cmd.action === 'toggle') {
              if (audioRunning) {
                stopAudio();
              } else {
                await startAudio();
              }
            }
          } else {
            // Re-apply later once polyphony switch is complete.
            lastAppliedTransportNonce = cmd.nonce - 1;
          }
        }
      }

      if (typeof remote.runPolyphony === 'number' && Number.isFinite(remote.runPolyphony)) {
        const remoteVoices = Math.max(0, Math.round(remote.runPolyphony));
        if (remoteVoices !== polyVoices) {
          await applyPolyphonyChange(remoteVoices);
        }
      }

      if (remote.runTrigger && typeof remote.runTrigger.nonce === 'number') {
        const trigger = remote.runTrigger;
        if (trigger.nonce !== lastAppliedTriggerNonce && trigger.nonce >= runViewEnteredAt) {
          lastAppliedTriggerNonce = trigger.nonce;
          await executeLocalTrigger(trigger.path, trigger.holdMs);
        }
      }

      if (remote.runMidi && typeof remote.runMidi.nonce === 'number') {
        const cmd = remote.runMidi;
        if (cmd.nonce !== lastAppliedMidiNonce && cmd.nonce >= runViewEnteredAt) {
          lastAppliedMidiNonce = cmd.nonce;
          await executeRemoteMidi(cmd);
        }
      }

    } catch {
      // ignore sync errors
    } finally {
      remoteSyncInFlight = false;
    }
  }
}

/**
 * Purpose: Implement `getState` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
export function getState() {
  if (!scopeState) return null;
  // Expose both formats:
  // - `params` keeps compatibility with older consumers.
  // - `paramCells` preserves per-param timestamp/owner semantics.
  return {
    audioRunning,
    polyVoices,
    midiSource,
    uiZoom,
    orbitZoom,
    scope: {
      view: scopeState.view,
      spectrumScale: scopeState.spectrumScale,
      mode: scopeState.mode,
      slope: scopeState.slope,
      threshold: scopeState.threshold,
      holdoffMs: scopeState.holdoffMs
    },
    activityTick: runActivityTick,
    params: { ...paramValues },
    paramCells: cloneParamCells(paramCells),
    orbitUi: buildRunOrbitSnapshot(false)
  };
}

/**
 * Purpose: Implement `markRunActivity` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function markRunActivity() {
  runActivityTick += 1;
  if (emitRunStateFn) emitRunStateFn();
}
/**
 * Purpose: Implement `compileAndRenderUI` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
async function compileAndRenderUI(container, sha, voices = 0, options = {}) {
  const compileStartedAt = performance.now();
  const isStale = options && typeof options.isStale === 'function' ? options.isStale : null;
  throwIfStaleRender(isStale);
  const fetchCodeStartedAt = performance.now();
  const codeResponse = await fetch(`/api/${sha}/user_code.dsp`);
  logRunPerf('compile:fetchCode:done', fetchCodeStartedAt, `sha=${sha} status=${codeResponse.status}`);
  throwIfStaleRender(isStale);
  if (!codeResponse.ok) {
    throw new Error('DSP code not found');
  }
  const codeReadStartedAt = performance.now();
  const code = await codeResponse.text();
  logRunPerf('compile:readCodeText:done', codeReadStartedAt, `sha=${sha} bytes=${code.length}`);
  throwIfStaleRender(isStale);
  const modeKey = voices > 0 ? `poly:${voices}` : 'mono';
  const cacheKey = `${sha}::${modeKey}`;
  const cached = compiledRunCache.get(cacheKey);

  if (cached && cached.code === code && cached.generator) {
    logRunPerf('compile:cache:hit', compileStartedAt, `sha=${sha} mode=${modeKey}`);
    cached.usedAt = Date.now();
    compiledGenerator = cached.generator;
    compiledGeneratorMode = modeKey;
    compiledUI = cached.ui;
  } else {
    logRunPerf('compile:cache:miss', compileStartedAt, `sha=${sha} mode=${modeKey}`);
    const importStartedAt = performance.now();
    const {
      FaustCompiler,
      LibFaust,
      FaustMonoDspGenerator,
      FaustPolyDspGenerator,
      instantiateFaustModuleFromFile
    } = await import('../vendor/faustwasm/index.js');
    logRunPerf('compile:importFaustWasm:done', importStartedAt, `sha=${sha}`);
    throwIfStaleRender(isStale);

    const base = new URL('libfaust-wasm/libfaust-wasm.js', document.baseURI).href;
    const instantiateStartedAt = performance.now();
    const module = await instantiateFaustModuleFromFile(
      base,
      base.replace(/\.js$/, '.data'),
      base.replace(/\.js$/, '.wasm')
    );
    logRunPerf('compile:instantiateModule:done', instantiateStartedAt, `sha=${sha}`);
    throwIfStaleRender(isStale);
    const compiler = new FaustCompiler(new LibFaust(module));
    const generator = voices > 0 ? new FaustPolyDspGenerator() : new FaustMonoDspGenerator();
    const generatorCompileStartedAt = performance.now();
    const compiled = await generator.compile(compiler, 'dsp', code, '-ftz 2');
    logRunPerf('compile:generatorCompile:done', generatorCompileStartedAt, `sha=${sha} mode=${modeKey} ok=${compiled ? 'true' : 'false'}`);
    throwIfStaleRender(isStale);
    if (!compiled) {
      throw new Error('Compilation failed');
    }

    compiledGenerator = generator;
    compiledGeneratorMode = modeKey;
    compiledUI = generator.getUI();
    compiledRunCache.set(cacheKey, {
      code,
      generator,
      ui: compiledUI,
      usedAt: Date.now()
    });
    pruneCompiledRunCache();
  }

  seedParamValuesFromUiDefaults(compiledUI);
  uiParamPaths = collectParamPaths(compiledUI);
  uiButtonOrder = collectButtonPaths(compiledUI);
  uiButtonPaths = new Set(uiButtonOrder);
  if (lastUiButtonPath && !uiButtonPaths.has(lastUiButtonPath)) {
    lastUiButtonPath = null;
  }
  const hadLatchedButtons = normalizeLatchedButtonParams();
  pressedUiButtons.clear();
  if (hadLatchedButtons) {
    // Persist normalization so first Run entry does not replay stale button=1 state.
    sendRunParamsSnapshot(true);
  }
  const postStateStartedAt = performance.now();
  try {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ui: compiledUI })
    });
  } catch {
    // ignore
  }
  logRunPerf('compile:postUiState:done', postStateStartedAt, `sha=${sha}`);
  throwIfStaleRender(isStale);
  const controlsRenderStartedAt = performance.now();
  const prepared = prepareControlsContainer(container);
  controlsBg = prepared.bg;
  controlsContent = prepared.content;
  controlsSplit = prepared.split;
  controlsClassicPane = prepared.classicPane;
  controlsOrbitPane = prepared.orbitPane;
  renderControls(controlsContent, compiledUI);
  requestAnimationFrame(() => {
    if (controlsContent) {
      controlsContent.classList.remove('run-controls-content-pending');
    }
    if (controlsSplit) {
      controlsSplit.classList.remove('run-controls-split-pending');
    }
    finalizeControlsContainerSwap(container, controlsBg, controlsContent);
  });
  updateUiRoot(controlsContent);
  logRunPerf('compile:renderControls:done', controlsRenderStartedAt, `sha=${sha}`);
  logRunPerf('compile:done', compileStartedAt, `sha=${sha} mode=${modeKey}`);
}

/**
 * Purpose: Implement `renderControls` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function renderControls(container, ui) {
  if (Array.isArray(ui) && ui.length > 0) {
    renderFaustUi(controlsClassicPane || container, ui);
    renderOrbitUi(controlsOrbitPane || container, ui);
    return;
  }

  container.innerHTML = '<div class="info">No parameters.</div>';
  updateUiRoot(container);
}

/**
 * Purpose: Implement `collectParamPaths` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function collectParamPaths(ui) {
  if (!Array.isArray(ui)) return [];
  const paths = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.items) node.items.forEach(walk);
    const address = node.address || node.path;
    if (node.type && address) {
      paths.push(address);
    }
  };
  walk(ui);
  return paths;
}

/**
 * Purpose: Implement `seedParamValuesFromUiDefaults` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function seedParamValuesFromUiDefaults(ui) {
  if (!Array.isArray(ui)) return;
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (Array.isArray(node.items)) node.items.forEach(walk);
    const path = node.address || node.path;
    if (!path) return;
    const min = Number(node.min);
    const max = Number(node.max);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      paramMetaByPath.set(path, { min, max });
    }
    const init = node.init;
    if (!Number.isFinite(init)) return;
    if (typeof paramValues[path] === 'number' && Number.isFinite(paramValues[path])) {
      const clamped = clampParamValue(path, paramValues[path]);
      paramValues[path] = clamped;
      const existing = paramCells[path];
      if (!existing || !Number.isFinite(existing.d)) {
        paramCells[path] = { v: clamped, d: Date.now(), owner: null };
      } else if (existing.v !== clamped) {
        paramCells[path] = { ...existing, v: clamped };
      }
      return;
    }
    const clampedInit = clampParamValue(path, Number(init));
    paramValues[path] = clampedInit;
    if (!paramCells[path]) {
      paramCells[path] = { v: clampedInit, d: Date.now(), owner: null };
    }
  };
  walk(ui);
}
/**
 * Purpose: Implement `renderMidiKeyboard` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function renderMidiKeyboard(container, ui, handlers, options = {}) {
  if (!container) return;
  detachComputerMidiKeyboard();
  const compact = options && options.compact === true;
  const showHint = options ? options.showHint !== false : true;
  const showEmptyMessage = options ? options.showEmptyMessage !== false : true;
  const targets = findMidiTargets(ui);
  midiTargets = targets;
  container.innerHTML = '';

  if (!targets || (!targets.freq && !targets.key && !targets.gate)) {
    if (showEmptyMessage) {
      container.innerHTML = '<div class="info">No MIDI parameters detected.</div>';
    }
    return;
  }

  const keyboard = document.createElement('div');
  keyboard.className = compact ? 'midi-keyboard midi-keyboard-compact' : 'midi-keyboard';
  const notes = [
    { note: 60, label: 'C4', black: false },
    { note: 61, label: 'C#', black: true },
    { note: 62, label: 'D', black: false },
    { note: 63, label: 'D#', black: true },
    { note: 64, label: 'E', black: false },
    { note: 65, label: 'F', black: false },
    { note: 66, label: 'F#', black: true },
    { note: 67, label: 'G', black: false },
    { note: 68, label: 'G#', black: true },
    { note: 69, label: 'A', black: false },
    { note: 70, label: 'A#', black: true },
    { note: 71, label: 'B', black: false }
  ];

  notes.forEach((entry) => {
    const key = document.createElement('button');
    key.type = 'button';
    key.className = `midi-key ${entry.black ? 'black' : 'white'}`;
    key.dataset.note = String(entry.note);
    key.textContent = entry.label;
    keyboard.appendChild(key);
    midiUiKeyByNote.set(entry.note, key);
  });

  /**
   * Purpose: Implement `noteOn` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const noteOn = async (note) => {
    if (activeMidiNote !== null) return;
    activeMidiNote = note;
    setMidiUiKeyActive(midiUiKeyByNote, note, true);
    if (handlers && handlers.noteOn) {
      await handlers.noteOn(note, 0.8);
    }
  };
  /**
   * Purpose: Implement `noteOff` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const noteOff = () => {
    if (activeMidiNote === null) return;
    const note = activeMidiNote;
    activeMidiNote = null;
    setMidiUiKeyActive(midiUiKeyByNote, note, false);
    if (handlers && handlers.noteOff) {
      handlers.noteOff(note);
    }
  };

  /**
   * Purpose: Implement `onPointerDown` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const onPointerDown = async (event) => {
    const key = event.target.closest('.midi-key');
    if (!key) return;
    event.preventDefault();
    key.setPointerCapture(event.pointerId);
    const note = parseInt(key.dataset.note, 10);
    await noteOn(note);
  };
  /**
   * Purpose: Implement `onPointerUp` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const onPointerUp = (event) => {
    const key = event.target.closest('.midi-key');
    if (key) {
      key.releasePointerCapture(event.pointerId);
    }
    noteOff();
  };

  keyboard.addEventListener('pointerdown', onPointerDown);
  keyboard.addEventListener('pointerup', onPointerUp);
  keyboard.addEventListener('pointercancel', () => {
    noteOff();
  });

  let octaveShift = 0;
  const baseNote = 60; // C4
  const keyToSemitone = {
    KeyA: 0,
    KeyW: 1,
    KeyS: 2,
    KeyE: 3,
    KeyD: 4,
    KeyF: 5,
    KeyT: 6,
    KeyG: 7,
    KeyY: 8,
    KeyH: 9,
    KeyU: 10,
    KeyJ: 11
  };

  midiKeyboardKeyDownHandler = (event) => {
    if (event.repeat) return;
    if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
    const pressedKey = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (pressedKey === 'z' || pressedKey === 'x') {
      event.preventDefault();
      if (pressedKey === 'z') {
        if (octaveShift > -4) {
          releaseComputerMidiNotes(
            midiComputerActiveNotes,
            midiUiKeyByNote,
            handlers,
            setMidiUiKeyActive
          );
          octaveShift -= 1;
          updateMidiHint();
        }
      } else if (octaveShift < 4) {
        releaseComputerMidiNotes(
          midiComputerActiveNotes,
          midiUiKeyByNote,
          handlers,
          setMidiUiKeyActive
        );
        octaveShift += 1;
        updateMidiHint();
      }
      return;
    }
    const semitone = keyToSemitone[event.code];
    if (!Number.isFinite(semitone)) return;
    const note = Math.max(0, Math.min(127, baseNote + semitone + octaveShift * 12));
    if (!Number.isFinite(note)) return;
    event.preventDefault();
    if (midiComputerActiveNotes.has(event.code)) return;
    midiComputerActiveNotes.set(event.code, note);
    setMidiUiKeyActive(midiUiKeyByNote, note, true);
    if (handlers && handlers.noteOn) {
      Promise.resolve(handlers.noteOn(note, 0.8)).catch(() => {});
    }
  };

  midiKeyboardKeyUpHandler = (event) => {
    const note = midiComputerActiveNotes.get(event.code);
    if (!Number.isFinite(note)) return;
    event.preventDefault();
    midiComputerActiveNotes.delete(event.code);
    setMidiUiKeyActive(midiUiKeyByNote, note, false);
    if (handlers && handlers.noteOff) {
      handlers.noteOff(note);
    }
  };

  midiKeyboardBlurHandler = () => {
    releaseComputerMidiNotes(
      midiComputerActiveNotes,
      midiUiKeyByNote,
      handlers,
      setMidiUiKeyActive
    );
  };

  window.addEventListener('keydown', midiKeyboardKeyDownHandler);
  window.addEventListener('keyup', midiKeyboardKeyUpHandler);
  window.addEventListener('blur', midiKeyboardBlurHandler);

  let hint = null;
  if (showHint) {
    hint = document.createElement('div');
    hint.className = 'midi-hint';
  }
  /**
   * Purpose: Implement `updateMidiHint` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const updateMidiHint = () => {
    if (!hint) return;
    const low = baseNote + octaveShift * 12;
    const high = low + 11;
    const octaveLabel = 4 + octaveShift;
    hint.textContent = `Click to play or keyboard: A W S E D F T G Y H U J (${low}-${high}, C${octaveLabel}-B${octaveLabel}). Octave: Z/X.`;
  };
  updateMidiHint();

  container.appendChild(keyboard);
  if (hint) {
    container.appendChild(hint);
  }
}

/**
 * Purpose: Implement `detachComputerMidiKeyboard` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function detachComputerMidiKeyboard() {
  if (midiKeyboardKeyDownHandler) {
    window.removeEventListener('keydown', midiKeyboardKeyDownHandler);
    midiKeyboardKeyDownHandler = null;
  }
  if (midiKeyboardKeyUpHandler) {
    window.removeEventListener('keyup', midiKeyboardKeyUpHandler);
    midiKeyboardKeyUpHandler = null;
  }
  if (midiKeyboardBlurHandler) {
    window.removeEventListener('blur', midiKeyboardBlurHandler);
    midiKeyboardBlurHandler = null;
  }
  const notes = new Set(midiComputerActiveNotes.values());
  midiComputerActiveNotes.clear();
  for (const note of notes) {
    noteOffMidi(note);
  }
  for (const key of midiUiKeyByNote.values()) {
    key.classList.remove('active');
  }
  midiUiKeyByNote.clear();
}

/**
 * Purpose: Implement `renderFaustUi` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
async function renderFaustUi(container, ui) {
  ensureFaustUiCss();
  container.innerHTML = `
    <div class="regular-wrap">
      <div class="regular-header">
        <span class="regular-title">Regular UI</span>
        <div class="regular-zoom-wrap">
          <div class="regular-zoom-group" aria-label="Regular UI zoom selector">
            <span class="regular-zoom-label">Zoom</span>
            <select class="regular-zoom">
              <option value="auto">Auto</option>
              <option value="50">50%</option>
              <option value="75">75%</option>
              <option value="100">100%</option>
              <option value="125">125%</option>
              <option value="150">150%</option>
            </select>
          </div>
        </div>
      </div>
      <div class="regular-content"><div class="info">Loading UI...</div></div>
    </div>
  `;
  const regularContent = container.querySelector('.regular-content') || container;
  const regularZoomSelect = container.querySelector('.regular-zoom');
  if (regularZoomSelect) {
    regularZoomSelect.value = uiZoom;
    regularZoomSelect.addEventListener('change', () => {
      uiZoom = regularZoomSelect.value;
      applyUiZoom();
      if (emitRunStateFn) emitRunStateFn();
    });
  }

  try {
    const { FaustUI } = await import('../vendor/faust-ui/index.js');
    regularContent.innerHTML = '';
    const zoomWrap = document.createElement('div');
    zoomWrap.className = 'run-ui-zoom-wrap';
    const stage = document.createElement('div');
    stage.className = 'run-ui-zoom-stage';
    const uiRoot = document.createElement('div');
    uiRoot.className = 'faust-ui-root';
    stage.appendChild(uiRoot);
    zoomWrap.appendChild(stage);
    regularContent.appendChild(zoomWrap);
    uiZoomWrap = zoomWrap;
    uiZoomStage = stage;
    currentUiRoot = uiRoot;

    faustUIInstance = new FaustUI({
      root: uiRoot,
      ui,
      listenWindowMessage: false,
      listenWindowResize: true
    });

    faustUIInstance.paramChangeByUI = (path, value) => {
      if (suppressUiParamChangeDepth > 0) return;
      if (isSuppressedUiParamEcho(path, value)) return;
      try {
        let forceSnapshot = false;
        const isButton = uiButtonPaths.has(path);
        if (uiButtonPaths.has(path)) {
          forceSnapshot = true;
          if (value > 0) {
            pressedUiButtons.add(path);
            lastUiButtonPath = path;
          } else {
            pressedUiButtons.delete(path);
          }
        }
        setParamValue(path, value, {
          smooth: !isButton,
          skipSnapshot: isButton
        });
        if (forceSnapshot) {
          sendRunParamsSnapshot(true);
        }
      } catch {
        // ignore
      }
    };

    applyParamValues();
    resetUiButtonsToZero();
    installUiReleaseGuard();
    installRunSpaceShortcut();
    setupUiZoomObserver();
    applyUiZoom();
  } catch (err) {
    console.error('Faust UI render error:', err);
    regularContent.innerHTML = '<div class="error">Failed to load Faust UI.</div>';
    updateUiRoot(regularContent);
  }
}

/**
 * Purpose: Implement `renderOrbitUi` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function renderOrbitUi(container, ui) {
  if (!container) return;
  teardownOrbitPaneResizeObserver();
  if (orbitUiInstance) {
    orbitUiInstance.destroy();
    orbitUiInstance = null;
  }

  orbitUiInstance = new OrbitUI(container, {
    uiDescriptor: ui,
    onParamChange: (path, value) => {
      const isButton = uiButtonPaths.has(path);
      setParamValue(path, value, {
        smooth: !isButton,
        skipSnapshot: true,
        skipEmit: true,
        skipOrbitSync: true
      });
      if (orbitUiBatchDepth > 0) {
        orbitUiBatchSnapshotPending = true;
        const now = Date.now();
        if (now - orbitUiBatchLastSentAt >= 150) {
          orbitUiBatchLastSentAt = now;
          sendRunParamsSnapshot();
        }
      } else {
        orbitUiBatchLastSentAt = Date.now();
        sendRunParamsSnapshot();
      }
      if (emitRunStateFn) emitRunStateFn();
    },
    tooltips: TOOLTIP_TEXTS.orbit,
    onInteractionStart: () => {
      orbitUiBatchDepth += 1;
    },
    onInteractionEnd: () => {
      orbitUiBatchDepth = Math.max(0, orbitUiBatchDepth - 1);
      if (orbitUiBatchDepth === 0 && orbitUiBatchSnapshotPending) {
        orbitUiBatchSnapshotPending = false;
        orbitUiBatchLastSentAt = Date.now();
        sendRunParamsSnapshot(true);
      }
    },
    onOrbitStateChange: (state) => {
      orbitZoom = String(Math.round(state.zoom));
      if (emitRunStateFn) emitRunStateFn();
    }
  });

  // Ensure geometry is initialized before restoring remote state.
  orbitUiInstance.resize();
  let baseOrbitState = null;
  orbitUiInstance.beginUpdate();
  try {
    let nextState = orbitUiInstance.buildControlsFromUnknown(ui);
    baseOrbitState = nextState;
    if (pendingOrbitUi && typeof pendingOrbitUi === 'object') {
      nextState = mergeRemoteOrbitState(nextState, pendingOrbitUi);
    }
    const parsedZoom = parseInt(orbitZoom, 10);
    nextState.zoom = Number.isFinite(parsedZoom) ? parsedZoom : 100;
    orbitUiInstance.setOrbitState(nextState);
    orbitZoom = String(Math.round(orbitUiInstance.getZoom()));
    pendingOrbitUi = null;
  } finally {
    orbitUiInstance.endUpdate();
  }

  setupOrbitPaneResizeObserver(container);
  orbitUiInstance.resize();
  requestOrbitSyncFromParams(true);
  enforceOrbitGeometryFromParams(paramValues);
  scheduleOrbitLayoutRecovery();
  if (baseOrbitState && shouldForceOrbitReprojection(baseOrbitState, orbitUiInstance.getOrbitState(), paramValues)) {
    forceOrbitReprojection(baseOrbitState, paramValues);
  }
}

/**
 * Purpose: Recover Orbit drawing when pane dimensions are transiently zero during a session switch.
 * How: Retries resize/reprojection briefly until the orbit body has stable dimensions.
 */
function scheduleOrbitLayoutRecovery(attempt = 0) {
  if (!orbitUiInstance) return;
  orbitUiInstance.resize();
  enforceOrbitGeometryFromParams(paramValues);
  const body = orbitUiInstance.body;
  const width = body && Number.isFinite(body.clientWidth) ? body.clientWidth : 0;
  const height = body && Number.isFinite(body.clientHeight) ? body.clientHeight : 0;
  if (width >= 2 && height >= 2) {
    requestOrbitSyncFromParams(true);
    return;
  }
  if (attempt >= 8) return;
  if (orbitLayoutRetryTimer) {
    clearTimeout(orbitLayoutRetryTimer);
    orbitLayoutRetryTimer = null;
  }
  orbitLayoutRetryTimer = setTimeout(() => {
    orbitLayoutRetryTimer = null;
    scheduleOrbitLayoutRecovery(attempt + 1);
  }, 80);
}

/**
 * Purpose: Implement `setupOrbitPaneResizeObserver` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function setupOrbitPaneResizeObserver(container) {
  if (!container || typeof ResizeObserver === 'undefined') return;
  orbitPaneResizeObserver = new ResizeObserver(() => {
    if (!orbitUiInstance) return;
    if (orbitPaneResizeRaf) return;
    orbitPaneResizeRaf = requestAnimationFrame(() => {
      orbitPaneResizeRaf = null;
      if (!orbitUiInstance) return;
      orbitUiInstance.resize();
      enforceOrbitGeometryFromParams(paramValues);
    });
  });
  orbitPaneResizeObserver.observe(container);
}

/**
 * Purpose: Implement `teardownOrbitPaneResizeObserver` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function teardownOrbitPaneResizeObserver() {
  if (orbitPaneResizeObserver) {
    orbitPaneResizeObserver.disconnect();
    orbitPaneResizeObserver = null;
  }
  if (orbitPaneResizeRaf) {
    cancelAnimationFrame(orbitPaneResizeRaf);
    orbitPaneResizeRaf = null;
  }
}

/**
 * Purpose: Implement `collectOrbitSliders` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function collectOrbitSliders(ui) {
  if (!Array.isArray(ui)) return [];
  const sliders = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (Array.isArray(node.items)) node.items.forEach(walk);
    const type = node.type;
    const path = node.address || node.path;
    if (!path) return;
    if (type !== 'hslider' && type !== 'vslider' && type !== 'nentry') return;
    const min = Number.isFinite(node.min) ? Number(node.min) : 0;
    const max = Number.isFinite(node.max) ? Number(node.max) : 1;
    if (max <= min) return;
    sliders.push({
      path,
      label: String(node.label || path.split('/').filter(Boolean).pop() || path),
      min,
      max,
      step: Number.isFinite(node.step) ? Number(node.step) : 0,
      color: colorFromPath(path)
    });
  };
  walk(ui);
  return sliders;
}

/**
 * Purpose: Implement `colorFromPath` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function colorFromPath(path) {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 68% 62%)`;
}
/**
 * Purpose: Implement `shouldAutoDisableOrbitSlider` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function shouldAutoDisableOrbitSlider(slider) {
  if (!slider) return false;
  if (polyVoices <= 0) return false;
  const text = `${slider.path || ''} ${slider.label || ''}`.toLowerCase();
  const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
  const controlled = new Set(['freq', 'gate', 'gain']);
  return tokens.some((token) => controlled.has(token));
}

/**
 * Purpose: Implement `isOrbitSliderDisabled` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function isOrbitSliderDisabled(path) {
  return !!(orbitState && orbitState.disabledPaths && orbitState.disabledPaths.has(path));
}

function toggleOrbitSliderDisabled(path) {
  if (!orbitState || !path) return false;
  if (!orbitState.disabledPaths) {
    orbitState.disabledPaths = new Set();
  }
  if (orbitState.disabledPaths.has(path)) {
    orbitState.disabledPaths.delete(path);
    requestOrbitSyncFromParams(true);
    return false;
  }
  orbitState.disabledPaths.add(path);
  return true;
}
/**
 * Purpose: Implement `setupOrbitCanvasResize` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function setupOrbitCanvasResize() {
  teardownOrbitCanvasResize();
  if (!orbitCanvas) return;
  orbitResizeObserver = new ResizeObserver(() => {
    const resized = resizeOrbitCanvas();
    if (!resized) return;
    if (orbitState) {
      orbitState.width = orbitBaseWidth || orbitState.width;
      orbitState.height = orbitBaseHeight || orbitState.height;
      orbitState.center.x = clamp(orbitState.center.x, 0, orbitState.width);
      orbitState.center.y = clamp(orbitState.center.y, 0, orbitState.height);
      ensureOrbitRadii();
      constrainOrbitPositions();
      scheduleOrbitDraw();
    }
  });
  orbitResizeObserver.observe(orbitCanvas);
  resizeOrbitCanvas();
}

/**
 * Purpose: Implement `teardownOrbitCanvasResize` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function teardownOrbitCanvasResize() {
  if (orbitResizeObserver) {
    orbitResizeObserver.disconnect();
    orbitResizeObserver = null;
  }
}

/**
 * Purpose: Implement `resizeOrbitCanvas` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function resizeOrbitCanvas(options = {}) {
  if (!orbitCanvas || !orbitCtx || !orbitBody) return false;
  const keepViewportCenter = !!options.keepViewportCenter;
  const oldScale = orbitRenderScale || 1;
  const oldOffsetX = orbitRenderOffsetX || 0;
  const oldOffsetY = orbitRenderOffsetY || 0;
  const centerWorldX = ((orbitBody.scrollLeft + (orbitBody.clientWidth / 2)) - oldOffsetX) / oldScale;
  const centerWorldY = ((orbitBody.scrollTop + (orbitBody.clientHeight / 2)) - oldOffsetY) / oldScale;
  const dpr = window.devicePixelRatio || 1;
  const rawWidth = orbitBody.clientWidth || 0;
  const rawHeight = orbitBody.clientHeight || 0;
  // Ignore transient hidden/collapsed layout states to avoid collapsing orbit
  // dimensions and snapping center to top-left.
  if (rawWidth < 2 || rawHeight < 2) return false;
  const baseWidth = rawWidth;
  const baseHeight = rawHeight;
  orbitBaseWidth = baseWidth;
  orbitBaseHeight = baseHeight;
  const parsed = parseInt(orbitZoom, 10);
  const scale = Number.isFinite(parsed) ? clamp(parsed / 100, 0.5, 3) : 1;
  // Keep the canvas filling the pane when zooming out so the grid background
  // still occupies the entire Orbit area.
  const cssWidth = scale < 1 ? baseWidth : Math.max(1, Math.round(baseWidth * scale));
  const cssHeight = scale < 1 ? baseHeight : Math.max(1, Math.round(baseHeight * scale));
  const offsetX = scale < 1 ? (baseWidth - (baseWidth * scale)) / 2 : 0;
  const offsetY = scale < 1 ? (baseHeight - (baseHeight * scale)) / 2 : 0;
  orbitCanvas.style.width = `${cssWidth}px`;
  orbitCanvas.style.height = `${cssHeight}px`;
  orbitCanvas.width = Math.round((scale < 1 ? baseWidth : cssWidth) * dpr);
  orbitCanvas.height = Math.round((scale < 1 ? baseHeight : cssHeight) * dpr);
  orbitRenderScale = scale;
  orbitRenderOffsetX = offsetX;
  orbitRenderOffsetY = offsetY;
  orbitCtx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offsetX, dpr * offsetY);
  if (keepViewportCenter) {
    const targetCenterX = centerWorldX * scale + offsetX;
    const targetCenterY = centerWorldY * scale + offsetY;
    const maxScrollLeft = Math.max(0, cssWidth - orbitBody.clientWidth);
    const maxScrollTop = Math.max(0, cssHeight - orbitBody.clientHeight);
    orbitBody.scrollLeft = clamp(targetCenterX - (orbitBody.clientWidth / 2), 0, maxScrollLeft);
    orbitBody.scrollTop = clamp(targetCenterY - (orbitBody.clientHeight / 2), 0, maxScrollTop);
  }
  return true;
}

/**
 * Purpose: Implement `initOrbitState` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function initOrbitState(sliders, persisted) {
  if (!orbitCanvas) return;
  const width = Math.max(1, orbitBaseWidth || orbitCanvas.clientWidth || 1);
  const height = Math.max(1, orbitBaseHeight || orbitCanvas.clientHeight || 1);
  const defaultOuter = Math.max(60, Math.min(width, height) * 0.36);
  const defaultInner = Math.max(14, defaultOuter * 0.18);
  const center = persisted && persisted.center
    ? { x: Number(persisted.center.x) || width / 2, y: Number(persisted.center.y) || height / 2 }
    : { x: width / 2, y: height / 2 };
  orbitState = {
    width,
    height,
    center: {
      x: clamp(center.x, 0, width),
      y: clamp(center.y, 0, height)
    },
    innerRadius:
      persisted && Number.isFinite(persisted.innerRadius)
        ? Math.max(8, Number(persisted.innerRadius))
        : defaultInner,
    outerRadius:
      persisted && Number.isFinite(persisted.outerRadius)
        ? Math.max(defaultInner + 10, Number(persisted.outerRadius))
        : defaultOuter,
    sliders,
    positions: {},
    disabledPaths: new Set(),
    initialOuterRadius: 0,
    gridOrigin: { x: 0, y: 0 }
  };
  ensureOrbitRadii();
  orbitState.initialOuterRadius = orbitState.outerRadius;
  orbitState.gridOrigin = { x: orbitState.center.x, y: orbitState.center.y };

  const persistedPositions =
    persisted && persisted.positions && typeof persisted.positions === 'object'
      ? persisted.positions
      : {};
  const persistedDisabled =
    persisted && Array.isArray(persisted.disabledPaths)
      ? persisted.disabledPaths
      : [];
  for (const path of persistedDisabled) {
    if (typeof path === 'string') {
      orbitState.disabledPaths.add(path);
    }
  }
  for (const slider of sliders) {
    if (shouldAutoDisableOrbitSlider(slider)) {
      orbitState.disabledPaths.add(slider.path);
    }
  }

  const count = Math.max(1, sliders.length);
  sliders.forEach((slider, index) => {
    const p = persistedPositions[slider.path];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      orbitState.positions[slider.path] = {
        x: clamp(Number(p.x), 0, orbitState.width),
        y: clamp(Number(p.y), 0, orbitState.height)
      };
      return;
    }
    const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
    const raw = paramValues[slider.path];
    const current = Number.isFinite(raw) ? raw : slider.min;
    const u = clamp((current - slider.min) / (slider.max - slider.min), 0, 1);
    const distance = distanceFromNormalized(u);
    orbitState.positions[slider.path] = {
      x: orbitState.center.x + Math.cos(angle) * distance,
      y: orbitState.center.y + Math.sin(angle) * distance
    };
  });
  constrainOrbitPositions();
}

/**
 * Purpose: Implement `ensureOrbitRadii` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function ensureOrbitRadii() {
  if (!orbitState) return;
  const maxOuter = Math.max(40, Math.min(orbitState.width, orbitState.height) * 0.47);
  orbitState.outerRadius = clamp(orbitState.outerRadius, 30, maxOuter);
  orbitState.innerRadius = clamp(orbitState.innerRadius, 8, orbitState.outerRadius - 6);
}

/**
 * Purpose: Implement `installOrbitPointerHandlers` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function installOrbitPointerHandlers() {
  if (!orbitCanvas) return;
  orbitCanvas.onpointerdown = (event) => {
    if (!orbitState) return;
    const p = orbitPointerPosition(event);
    const hit = hitTestOrbit(p.x, p.y);
    if (!hit) return;
    if (hit.mode === 'slider' && hit.path && event.shiftKey) {
      event.preventDefault();
      toggleOrbitSliderDisabled(hit.path);
      scheduleOrbitDraw();
      return;
    }
    event.preventDefault();
    orbitCanvas.setPointerCapture(event.pointerId);
    orbitPointer = {
      pointerId: event.pointerId,
      mode: hit.mode,
      path: hit.path || null
    };
    updateOrbitCursor(orbitPointer.mode);
  };
  orbitCanvas.onpointermove = (event) => {
    const p = orbitPointerPosition(event);
    if (!orbitState) return;
    if (!orbitPointer) {
      const hit = hitTestOrbit(p.x, p.y);
      updateOrbitCursor(hit ? hit.mode : null);
      return;
    }
    if (event.pointerId !== orbitPointer.pointerId) return;
    if (orbitPointer.mode === 'slider' && orbitPointer.path) {
      const nextPos = {
        x: clamp(p.x, 0, orbitState.width),
        y: clamp(p.y, 0, orbitState.height)
      };
      orbitState.positions[orbitPointer.path] = nextPos;
      applyOrbitValueForPath(orbitPointer.path);
      scheduleOrbitDraw();
      return;
    }
    if (orbitPointer.mode === 'outer') {
      const d = Math.hypot(p.x - orbitState.center.x, p.y - orbitState.center.y);
      orbitState.outerRadius = d;
      ensureOrbitRadii();
      applyOrbitValuesForAll();
      scheduleOrbitDraw();
      return;
    }
    if (orbitPointer.mode === 'center') {
      orbitState.center.x = clamp(p.x, 0, orbitState.width);
      orbitState.center.y = clamp(p.y, 0, orbitState.height);
      applyOrbitValuesForAll();
      scheduleOrbitDraw();
    }
  };
  orbitCanvas.onpointerup = (event) => {
    if (!orbitPointer || event.pointerId !== orbitPointer.pointerId) return;
    if (orbitPointer.mode === 'slider' && orbitPointer.path) {
      const path = orbitPointer.path;
      const value = paramValues[path];
      if (typeof value === 'number' && !isOrbitSliderDisabled(path)) {
        applyParamToDsp(path, value, { smooth: true, commit: true });
      }
    } else if (orbitPointer.mode === 'center' && orbitState) {
      for (const slider of orbitState.sliders) {
        if (isOrbitSliderDisabled(slider.path)) continue;
        const value = paramValues[slider.path];
        if (typeof value === 'number') {
          applyParamToDsp(slider.path, value, { smooth: true, commit: true });
        }
      }
    } else if (orbitPointer.mode === 'outer' && orbitState) {
      for (const slider of orbitState.sliders) {
        if (isOrbitSliderDisabled(slider.path)) continue;
        const value = paramValues[slider.path];
        if (typeof value === 'number') {
          applyParamToDsp(slider.path, value, { smooth: true, commit: true });
        }
      }
    }
    orbitPointer = null;
    updateOrbitCursor(null);
  };
  orbitCanvas.onpointercancel = () => {
    orbitPointer = null;
    updateOrbitCursor(null);
  };
  orbitCanvas.onpointerleave = () => {
    if (!orbitPointer) {
      updateOrbitCursor(null);
    }
  };
}

/**
 * Purpose: Implement `orbitPointerPosition` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function orbitPointerPosition(event) {
  const rect = orbitCanvas.getBoundingClientRect();
  const scale = orbitRenderScale || 1;
  const offsetX = orbitRenderOffsetX || 0;
  const offsetY = orbitRenderOffsetY || 0;
  const rawX = event.clientX - rect.left;
  const rawY = event.clientY - rect.top;
  return {
    x: (rawX - offsetX) / scale,
    y: (rawY - offsetY) / scale
  };
}

/**
 * Purpose: Implement `hitTestOrbit` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function hitTestOrbit(x, y) {
  if (!orbitState) return null;
  const iconRadius = 9;
  for (const slider of orbitState.sliders) {
    const p = orbitState.positions[slider.path];
    if (!p) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= iconRadius + 4) {
      return { mode: 'slider', path: slider.path };
    }
  }
  const centerDistance = Math.hypot(orbitState.center.x - x, orbitState.center.y - y);
  if (centerDistance <= orbitState.innerRadius + 6) {
    return { mode: 'center' };
  }
  if (Math.abs(centerDistance - orbitState.outerRadius) <= 8) {
    return { mode: 'outer' };
  }
  return null;
}

/**
 * Purpose: Implement `updateOrbitCursor` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function updateOrbitCursor(mode) {
  if (!orbitCanvas) return;
  if (mode === 'slider') {
    orbitCanvas.style.cursor = 'pointer';
    return;
  }
  if (mode === 'center') {
    orbitCanvas.style.cursor = 'move';
    return;
  }
  if (mode === 'outer') {
    orbitCanvas.style.cursor = orbitPointer ? 'grabbing' : 'grab';
    return;
  }
  orbitCanvas.style.cursor = 'default';
}

/**
 * Purpose: Implement `applyOrbitValueForPath` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function applyOrbitValueForPath(path) {
  if (!orbitState) return;
  if (isOrbitSliderDisabled(path)) return;
  const slider = orbitState.sliders.find((s) => s.path === path);
  const p = orbitState.positions[path];
  if (!slider || !p) return;
  const value = sliderValueFromPosition(slider, p.x, p.y);
  setParamValue(path, value, {
    skipSnapshot: true,
    skipEmit: true,
    skipOrbitSync: true,
    smooth: true
  });
  sendRunParamsSnapshot();
  if (emitRunStateFn) emitRunStateFn();
}

/**
 * Purpose: Implement `applyOrbitValuesForAll` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function applyOrbitValuesForAll() {
  if (!orbitState) return;
  for (const slider of orbitState.sliders) {
    if (isOrbitSliderDisabled(slider.path)) continue;
    const p = orbitState.positions[slider.path];
    if (!p) continue;
    const value = sliderValueFromPosition(slider, p.x, p.y);
    setParamValue(slider.path, value, {
      skipSnapshot: true,
      skipEmit: true,
      skipOrbitSync: true,
      smooth: true
    });
  }
  sendRunParamsSnapshot();
  if (emitRunStateFn) emitRunStateFn();
}
/**
 * Purpose: Implement `sliderValueFromPosition` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function sliderValueFromPosition(slider, x, y) {
  if (!orbitState) return slider.min;
  const d = Math.hypot(x - orbitState.center.x, y - orbitState.center.y);
  const u = normalizedFromDistance(d);
  let value = slider.min + u * (slider.max - slider.min);
  if (slider.step > 0) {
    const steps = Math.round((value - slider.min) / slider.step);
    value = slider.min + steps * slider.step;
  }
  return clamp(value, slider.min, slider.max);
}

/**
 * Purpose: Implement `normalizedFromDistance` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function normalizedFromDistance(distance) {
  if (!orbitState) return 0;
  if (distance <= orbitState.innerRadius) return 1;
  if (distance >= orbitState.outerRadius) return 0;
  return (orbitState.outerRadius - distance) / (orbitState.outerRadius - orbitState.innerRadius);
}

/**
 * Purpose: Implement `distanceFromNormalized` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function distanceFromNormalized(u) {
  if (!orbitState) return 0;
  const clamped = clamp(u, 0, 1);
  return orbitState.outerRadius - clamped * (orbitState.outerRadius - orbitState.innerRadius);
}
/**
 * Purpose: Implement `syncOrbitFromParams` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function syncOrbitFromParams() {
  if (!orbitState) return;
  if (orbitPointer) {
    // During any local drag, icon positions are user-authoritative.
    // This prevents unrelated icon motion while dragging one slider or the center.
    return false;
  }
  const sliders = orbitState.sliders;
  const count = Math.max(1, sliders.length);
  let changed = false;
  sliders.forEach((slider, index) => {
    if (isOrbitSliderDisabled(slider.path)) {
      return;
    }
    const raw = paramValues[slider.path];
    const current = Number.isFinite(raw) ? raw : slider.min;
    const u = clamp((current - slider.min) / (slider.max - slider.min), 0, 1);
    const distance = distanceFromNormalized(u);
    const p = orbitState.positions[slider.path] || { x: orbitState.center.x, y: orbitState.center.y };
    let dx = p.x - orbitState.center.x;
    let dy = p.y - orbitState.center.y;
    const mag = Math.hypot(dx, dy);
    if (mag < 1e-6) {
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    } else {
      dx /= mag;
      dy /= mag;
    }
    const nextX = clamp(orbitState.center.x + dx * distance, 0, orbitState.width);
    const nextY = clamp(orbitState.center.y + dy * distance, 0, orbitState.height);
    const prev = orbitState.positions[slider.path];
    if (!prev || Math.abs(prev.x - nextX) > ORBIT_POSITION_EPSILON || Math.abs(prev.y - nextY) > ORBIT_POSITION_EPSILON) {
      orbitState.positions[slider.path] = { x: nextX, y: nextY };
      changed = true;
    }
  });
  if (changed) {
    scheduleOrbitDraw();
  }
  return changed;
}

/**
 * Purpose: Implement `requestOrbitSyncFromParams` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function requestOrbitSyncFromParams(force = false) {
  if (!orbitUiInstance) return;
  if (force) {
    if (orbitParamSyncTimer) {
      clearTimeout(orbitParamSyncTimer);
      orbitParamSyncTimer = null;
    }
    lastOrbitParamSyncAt = Date.now();
    orbitUiInstance.setParams(paramValues);
    return;
  }
  const now = Date.now();
  const elapsed = now - lastOrbitParamSyncAt;
  if (elapsed >= ORBIT_PARAM_SYNC_INTERVAL_MS) {
    lastOrbitParamSyncAt = now;
    orbitUiInstance.setParams(paramValues);
    return;
  }
  if (orbitParamSyncTimer) return;
  orbitParamSyncTimer = setTimeout(() => {
    orbitParamSyncTimer = null;
    lastOrbitParamSyncAt = Date.now();
    if (!orbitUiInstance) return;
    orbitUiInstance.setParams(paramValues);
  }, Math.max(0, ORBIT_PARAM_SYNC_INTERVAL_MS - elapsed));
}

/**
 * Purpose: Implement `drawOrbitNow` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function drawOrbitNow() {
  if (!orbitState || !orbitCtx || !orbitCanvas) return;
  const ctx = orbitCtx;
  const scale = orbitRenderScale || 1;
  const offsetX = orbitRenderOffsetX || 0;
  const offsetY = orbitRenderOffsetY || 0;
  const width = orbitState.width;
  const height = orbitState.height;
  const canvasCssWidth = Math.max(1, orbitCanvas.clientWidth || width);
  const canvasCssHeight = Math.max(1, orbitCanvas.clientHeight || height);
  const minX = -offsetX / scale;
  const minY = -offsetY / scale;
  const drawWidth = canvasCssWidth / scale;
  const drawHeight = canvasCssHeight / scale;
  const maxX = minX + drawWidth;
  const maxY = minY + drawHeight;
  ctx.clearRect(minX, minY, drawWidth, drawHeight);
  ctx.fillStyle = '#111';
  ctx.fillRect(minX, minY, drawWidth, drawHeight);

  // Discrete centered grid to suggest draggable 2D space.
  const gridStep = Math.max(8, (orbitState.initialOuterRadius || orbitState.outerRadius) / 2);
  const gridOrigin = orbitState.gridOrigin || orbitState.center;
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let x = gridOrigin.x; x <= maxX; x += gridStep) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, minY);
    ctx.lineTo(Math.round(x) + 0.5, maxY);
    ctx.stroke();
  }
  for (let x = gridOrigin.x - gridStep; x >= minX; x -= gridStep) {
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, minY);
    ctx.lineTo(Math.round(x) + 0.5, maxY);
    ctx.stroke();
  }
  for (let y = gridOrigin.y; y <= maxY; y += gridStep) {
    ctx.beginPath();
    ctx.moveTo(minX, Math.round(y) + 0.5);
    ctx.lineTo(maxX, Math.round(y) + 0.5);
    ctx.stroke();
  }
  for (let y = gridOrigin.y - gridStep; y >= minY; y -= gridStep) {
    ctx.beginPath();
    ctx.moveTo(minX, Math.round(y) + 0.5);
    ctx.lineTo(maxX, Math.round(y) + 0.5);
    ctx.stroke();
  }

  // Outer circle = min zone frontier.
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(orbitState.center.x, orbitState.center.y, orbitState.outerRadius, 0, Math.PI * 2);
  ctx.stroke();

  // Inner disk = max zone.
  ctx.fillStyle = 'rgba(250,250,250,0.15)';
  ctx.beginPath();
  ctx.arc(orbitState.center.x, orbitState.center.y, orbitState.innerRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(250,250,250,0.35)';
  ctx.stroke();

  ctx.font = '11px system-ui, sans-serif';
  for (const slider of orbitState.sliders) {
    const p = orbitState.positions[slider.path];
    if (!p) continue;
    const disabled = isOrbitSliderDisabled(slider.path);
    const iconColor = disabled ? 'rgba(85,85,85,0.5)' : slider.color;
    const labelColor = disabled ? 'rgba(105,105,105,0.68)' : 'rgba(255,255,255,0.85)';
    ctx.fillStyle = iconColor;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = disabled ? 'rgba(60,60,60,0.82)' : 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const label = shortOrbitLabel(slider.label);
    ctx.fillStyle = labelColor;
    ctx.fillText(label, p.x + 10, p.y - 10);
  }
}

/**
 * Purpose: Implement `shortOrbitLabel` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function shortOrbitLabel(label) {
  if (!label) return '';
  const max = 16;
}
/**
 * Purpose: Implement `scheduleOrbitDraw` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function scheduleOrbitDraw() {
  orbitNeedsDraw = true;
  if (orbitRafId) return;
  orbitRafId = requestAnimationFrame(() => {
    orbitRafId = null;
    if (!orbitNeedsDraw) return;
    orbitNeedsDraw = false;
    drawOrbitNow();
  });
}
/**
 * Purpose: Implement `constrainOrbitPositions` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function constrainOrbitPositions() {
  if (!orbitState) return;
  for (const slider of orbitState.sliders) {
    const p = orbitState.positions[slider.path];
    if (!p) continue;
    p.x = clamp(p.x, 0, orbitState.width);
    p.y = clamp(p.y, 0, orbitState.height);
  }
}

/**
 * Purpose: Implement `buildRunOrbitSnapshot` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function buildRunOrbitSnapshot(includeNonce = true) {
  if (!orbitUiInstance) return null;
  const orbitStateNow = orbitUiInstance.getOrbitState();
  const snapshot = {
    zoom: Math.round(orbitStateNow.zoom),
    center: {
      x: Math.round(orbitStateNow.center.x),
      y: Math.round(orbitStateNow.center.y)
    },
    innerRadius: Math.round(orbitStateNow.innerRadius),
    outerRadius: Math.round(orbitStateNow.outerRadius),
    controls: orbitStateNow.controls
  };
  if (includeNonce) {
    snapshot.nonce = Date.now();
  }
  return snapshot;
}

/**
 * Purpose: Implement `mergeRemoteOrbitState` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function mergeRemoteOrbitState(baseState, remoteOrbit) {
  const next = {
    zoom: Number.isFinite(remoteOrbit.zoom) ? Number(remoteOrbit.zoom) : baseState.zoom,
    center: {
      x: Number.isFinite(remoteOrbit.center && remoteOrbit.center.x)
        ? Number(remoteOrbit.center.x)
        : baseState.center.x,
      y: Number.isFinite(remoteOrbit.center && remoteOrbit.center.y)
        ? Number(remoteOrbit.center.y)
        : baseState.center.y
    },
    innerRadius: Number.isFinite(remoteOrbit.innerRadius) ? Number(remoteOrbit.innerRadius) : baseState.innerRadius,
    outerRadius: Number.isFinite(remoteOrbit.outerRadius) ? Number(remoteOrbit.outerRadius) : baseState.outerRadius,
    controls: { ...baseState.controls }
  };

  if (remoteOrbit.controls && typeof remoteOrbit.controls === 'object') {
    for (const [path, local] of Object.entries(baseState.controls)) {
      const incoming = remoteOrbit.controls[path];
      if (!incoming || typeof incoming !== 'object') continue;
      next.controls[path] = {
        ...local,
        x: Number.isFinite(incoming.x) ? Number(incoming.x) : local.x,
        y: Number.isFinite(incoming.y) ? Number(incoming.y) : local.y,
        enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : local.enabled,
        label: typeof incoming.label === 'string' ? incoming.label : local.label,
        color: typeof incoming.color === 'string' ? incoming.color : local.color,
        step: Number.isFinite(incoming.step) ? Number(incoming.step) : local.step
      };
    }
    return sanitizeMergedOrbitState(baseState, next);
  }

  const positions = remoteOrbit.positions && typeof remoteOrbit.positions === 'object' ? remoteOrbit.positions : {};
  const disabledPaths = new Set(Array.isArray(remoteOrbit.disabledPaths) ? remoteOrbit.disabledPaths : []);
  for (const [path, local] of Object.entries(baseState.controls)) {
    const incoming = positions[path];
    next.controls[path] = {
      ...local,
      x: incoming && Number.isFinite(incoming.x) ? Number(incoming.x) : local.x,
      y: incoming && Number.isFinite(incoming.y) ? Number(incoming.y) : local.y,
      enabled: disabledPaths.has(path) ? false : local.enabled
    };
  }
  return sanitizeMergedOrbitState(baseState, next);
}

/**
 * Purpose: Implement `sanitizeMergedOrbitState` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function sanitizeMergedOrbitState(baseState, mergedState) {
  const next = {
    ...mergedState,
    center: {
      x: Number(mergedState.center.x),
      y: Number(mergedState.center.y)
    }
  };
  const baseInner = Number(baseState.innerRadius || 0);
  const baseOuter = Number(baseState.outerRadius || 0);
  const mergedInner = Number(mergedState.innerRadius || 0);
  const mergedOuter = Number(mergedState.outerRadius || 0);
  // Guard against stale snapshots captured during transient invalid layout
  // where center may collapse to (0,0). Keep current base center in that case.
  const baseCenterX = Number(baseState.center?.x || 0);
  const baseCenterY = Number(baseState.center?.y || 0);
  if (next.center.x <= 1 && next.center.y <= 1 && baseCenterX > 20 && baseCenterY > 20) {
    next.center.x = baseCenterX;
    next.center.y = baseCenterY;
  }
  // Guard against stale snapshots with collapsed radii/geometry:
  // keep current base geometry when incoming radii are implausibly small.
  const minReasonableOuter = Math.max(24, baseOuter * 0.35);
  const invalidRadii =
    !Number.isFinite(mergedInner)
    || !Number.isFinite(mergedOuter)
    || mergedOuter <= 0
    || mergedInner < 0
    || mergedInner >= mergedOuter
    || mergedOuter < minReasonableOuter;
  if (invalidRadii && baseOuter > 0 && baseInner >= 0) {
    next.innerRadius = baseInner;
    next.outerRadius = baseOuter;
    next.center.x = baseCenterX;
    next.center.y = baseCenterY;
    if (baseState.controls && typeof baseState.controls === 'object') {
      const patched = { ...(next.controls || {}) };
      for (const [path, baseCtrl] of Object.entries(baseState.controls)) {
        const local = patched[path] || {};
        patched[path] = {
          ...local,
          x: Number(baseCtrl.x),
          y: Number(baseCtrl.y)
        };
      }
      next.controls = patched;
    }
  }
  return next;
}

/**
 * Purpose: Compute the value implied by a control point position in Orbit coordinates.
 * How: Reuses Orbit radial geometry rules (inner/outer radii and control range) to map XY back to a parameter value.
 */
function orbitValueFromPosition(control, state) {
  const d = Math.hypot(Number(control.x) - Number(state.center.x), Number(control.y) - Number(state.center.y));
  const inner = Number(state.innerRadius);
  const outer = Number(state.outerRadius);
  const u = d <= inner
    ? 1
    : d >= outer
      ? 0
      : (outer - d) / Math.max(1e-9, outer - inner);
  if (control.type === 'button' || control.type === 'checkbox') {
    const threshold = (inner + outer) / 2;
    return d <= threshold ? 1 : 0;
  }
  let value = Number(control.min) + u * (Number(control.max) - Number(control.min));
  const step = Number(control.step);
  if (Number.isFinite(step) && step > 0) {
    const steps = Math.round((value - Number(control.min)) / step);
    value = Number(control.min) + steps * step;
  }
  return clamp(value, Number(control.min), Number(control.max));
}

/**
 * Purpose: Compute the expected radial distance for a parameter value in current Orbit geometry.
 * How: Applies the same inner/outer normalization as Orbit so value==min always maps exactly to outerRadius.
 */
function orbitDistanceFromValue(control, state, value) {
  const min = Number(control.min);
  const max = Number(control.max);
  const inner = Number(state.innerRadius);
  const outer = Number(state.outerRadius);
  const v = Number.isFinite(value) ? Number(value) : min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(inner) || !Number.isFinite(outer) || max <= min) {
    return outer;
  }
  const u = clamp((v - min) / (max - min), 0, 1);
  return outer - u * (outer - inner);
}

/**
 * Purpose: Force Orbit control geometry to match current parameter values exactly.
 * How: Reprojects each control along its current angular direction to the exact target radius for its parameter value.
 */
function enforceOrbitGeometryFromParams(values) {
  if (!orbitUiInstance || !values || typeof values !== 'object') return false;
  const current = orbitUiInstance.getOrbitState();
  const controls = current.controls && typeof current.controls === 'object'
    ? Object.entries(current.controls)
    : [];
  if (controls.length === 0) return false;

  const repaired = {
    ...current,
    controls: { ...current.controls }
  };
  const tolerance = 0.75;
  let changed = false;
  const sortedPaths = controls.map(([path]) => path).sort();
  const total = Math.max(1, sortedPaths.length);

  for (const [path, control] of controls) {
    const expected = values[path];
    if (!Number.isFinite(expected)) continue;
    const dxRaw = Number(control.x) - Number(current.center.x);
    const dyRaw = Number(control.y) - Number(current.center.y);
    const mag = Math.hypot(dxRaw, dyRaw);
    let dx = 0;
    let dy = -1;
    if (mag > 1e-6) {
      dx = dxRaw / mag;
      dy = dyRaw / mag;
    } else {
      const idx = Math.max(0, sortedPaths.indexOf(path));
      const angle = (idx / total) * Math.PI * 2 - Math.PI / 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
    }
    const targetDistance = orbitDistanceFromValue(control, current, Number(expected));
    if (Math.abs(mag - targetDistance) <= tolerance) continue;
    const nextX = clamp(Number(current.center.x) + dx * targetDistance, 0, Number.MAX_SAFE_INTEGER);
    const nextY = clamp(Number(current.center.y) + dy * targetDistance, 0, Number.MAX_SAFE_INTEGER);
    repaired.controls[path] = {
      ...control,
      x: nextX,
      y: nextY
    };
    changed = true;
  }

  if (!changed) return false;
  orbitUiInstance.setOrbitState(repaired);
  return true;
}

/**
 * Purpose: Decide whether restored Orbit control geometry is inconsistent with current parameter values.
 * How: Compares value implied by each point position against `paramValues` and flags restoration when mismatch ratio is high.
 */
function shouldForceOrbitReprojection(baseState, currentState, values) {
  if (!baseState || !currentState || !values) return false;
  const controls = currentState.controls && typeof currentState.controls === 'object'
    ? Object.entries(currentState.controls)
    : [];
  if (controls.length === 0) return false;
  let compared = 0;
  let mismatched = 0;
  for (const [path, control] of controls) {
    const expected = values[path];
    if (!Number.isFinite(expected)) continue;
    compared += 1;
    const implied = orbitValueFromPosition(control, currentState);
    if (control.type === 'button' || control.type === 'checkbox') {
      if (Math.round(expected) !== Math.round(implied)) mismatched += 1;
      continue;
    }
    const min = Number(control.min);
    const max = Number(control.max);
    const range = Math.max(1e-9, max - min);
    const step = Number(control.step);
    const tolerance = Number.isFinite(step) && step > 0 ? (step / 2) + 1e-9 : range * 1e-3;
    if (Math.abs(Number(expected) - Number(implied)) > tolerance) {
      mismatched += 1;
    }
  }
  if (compared === 0) return false;
  // Trigger repair when mismatch is frequent enough to indicate a stale/invalid restore.
  return (mismatched / compared) >= 0.25;
}

/**
 * Purpose: Reproject Orbit points from current parameter values using stable base control directions.
 * How: Resets XY from base control layout, reapplies state, then pushes `setParams` to position points consistently with values.
 */
function forceOrbitReprojection(baseState, values) {
  if (!orbitUiInstance || !baseState || !baseState.controls) return;
  const current = orbitUiInstance.getOrbitState();
  const repaired = {
    ...current,
    controls: { ...current.controls }
  };
  for (const [path, baseControl] of Object.entries(baseState.controls)) {
    const local = repaired.controls[path];
    if (!local) continue;
    repaired.controls[path] = {
      ...local,
      x: Number(baseControl.x),
      y: Number(baseControl.y)
    };
  }
  orbitUiInstance.setOrbitState(repaired);
  orbitUiInstance.setParams(values || {});
  enforceOrbitGeometryFromParams(values || {});
}

function collectButtonPaths(ui) {
  const paths = [];
  if (!Array.isArray(ui)) return paths;
  /**
   * Purpose: Implement `walk` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (Array.isArray(node.items)) node.items.forEach(walk);
    if (node.type === 'button') {
      const address = node.address || node.path;
      if (address && !paths.includes(address)) paths.push(address);
    }
  };
  walk(ui);
  return paths;
}
/**
 * Purpose: Implement `installRunSpaceShortcut` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function installRunSpaceShortcut() {
  if (runSpaceKeyHandler || runSpaceKeyUpHandler) return;
  runSpaceKeyHandler = async (event) => {
    if (event.defaultPrevented) return;
    if (event.code !== 'Space') return;
    if (event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
    const targetPath =
      (lastUiButtonPath && uiButtonPaths.has(lastUiButtonPath) ? lastUiButtonPath : null) ||
      (uiButtonOrder.length > 0 ? uiButtonOrder[0] : null);
    if (!targetPath) return;
    event.preventDefault();
    if (runSpacePressedPath) return;
    if (!audioRunning && typeof outputNode !== 'undefined') {
      startAudioOutput();
    }
    runSpacePressedPath = targetPath;
    pressedUiButtons.add(targetPath);
    setParamValue(targetPath, 1, { skipSnapshot: true });
    sendRunParamsSnapshot(true);
  };
  runSpaceKeyUpHandler = (event) => {
    if (event.code !== 'Space') return;
    if (!runSpacePressedPath) return;
    event.preventDefault();
    const path = runSpacePressedPath;
    runSpacePressedPath = null;
    pressedUiButtons.delete(path);
    setParamValue(path, 0, { skipSnapshot: true });
    sendRunParamsSnapshot(true);
  };
  runSpaceBlurHandler = () => {
    if (!runSpacePressedPath) return;
    const path = runSpacePressedPath;
    runSpacePressedPath = null;
    pressedUiButtons.delete(path);
    setParamValue(path, 0, { skipSnapshot: true });
    sendRunParamsSnapshot(true);
  };
  window.addEventListener('keydown', runSpaceKeyHandler);
  window.addEventListener('keyup', runSpaceKeyUpHandler);
  window.addEventListener('blur', runSpaceBlurHandler, true);
}

/**
 * Purpose: Implement `uninstallRunSpaceShortcut` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function uninstallRunSpaceShortcut() {
  if (runSpaceKeyHandler) {
    window.removeEventListener('keydown', runSpaceKeyHandler);
    runSpaceKeyHandler = null;
  }
  if (runSpaceKeyUpHandler) {
    window.removeEventListener('keyup', runSpaceKeyUpHandler);
    runSpaceKeyUpHandler = null;
  }
  if (runSpaceBlurHandler) {
    window.removeEventListener('blur', runSpaceBlurHandler, true);
    runSpaceBlurHandler = null;
  }
  if (runSpacePressedPath) {
    const path = runSpacePressedPath;
    runSpacePressedPath = null;
    pressedUiButtons.delete(path);
    setParamValue(path, 0, { skipSnapshot: true });
    sendRunParamsSnapshot(true);
  }
}

/**
 * Purpose: Implement `releasePressedUiButtons` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function releasePressedUiButtons() {
  if (pressedUiButtons.size === 0) return;
  const protectedPath = runSpacePressedPath;
  let releasedAny = false;
  for (const path of Array.from(pressedUiButtons)) {
    if (protectedPath && path === protectedPath) {
      continue;
    }
    setParamValue(path, 0);
    releasedAny = true;
  }
  if (protectedPath) {
    pressedUiButtons = new Set([protectedPath]);
  } else {
    pressedUiButtons.clear();
  }
  if (releasedAny) {
    sendRunParamsSnapshot(true);
  }
}

/**
 * Purpose: Implement `installUiReleaseGuard` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function installUiReleaseGuard() {
  if (uiReleaseHandlersInstalled) return;
  const handler = () => releasePressedUiButtons();
  window.addEventListener('pointerup', handler, true);
  window.addEventListener('pointercancel', handler, true);
  window.addEventListener('blur', handler, true);
  uiReleaseGuardHandler = handler;
  uiReleaseHandlersInstalled = true;
}

/**
 * Purpose: Implement `uninstallUiReleaseGuard` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function uninstallUiReleaseGuard() {
  if (!uiReleaseHandlersInstalled) return;
  const handler = uiReleaseGuardHandler;
  if (handler) {
    window.removeEventListener('pointerup', handler, true);
    window.removeEventListener('pointercancel', handler, true);
    window.removeEventListener('blur', handler, true);
  }
  uiReleaseGuardHandler = null;
  uiReleaseHandlersInstalled = false;
}

/**
 * Purpose: Implement `applyUiZoom` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function applyUiZoom() {
  const zoomHost = controlsClassicPane || controlsContent;
  if (!zoomHost || !uiZoomWrap || !uiZoomStage || !currentUiRoot) return;
  const naturalWidth = Math.max(currentUiRoot.scrollWidth, currentUiRoot.offsetWidth, 1);
  const naturalHeight = Math.max(currentUiRoot.scrollHeight, currentUiRoot.offsetHeight, 1);
  const availableWidth = Math.max(zoomHost.clientWidth - 20, 1);
  const availableHeight = Math.max(zoomHost.clientHeight - 20, 1);
  const fitScale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
  const manualScale =
    uiZoom === 'auto'
      ? fitScale
      : Math.max(0.25, Math.min(2, parseInt(uiZoom, 10) / 100));
  const scale = Number.isFinite(manualScale) ? manualScale : fitScale;
  uiZoomStage.style.transform = `scale(${scale})`;
  uiZoomStage.style.width = `${naturalWidth * scale}px`;
  uiZoomStage.style.height = `${naturalHeight * scale}px`;
}
/**
 * Purpose: Implement `setupUiZoomObserver` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function setupUiZoomObserver() {
  teardownUiZoomObserver();
  const zoomHost = controlsClassicPane || controlsContent;
  if (!zoomHost || !currentUiRoot) return;
  uiResizeObserver = new ResizeObserver(() => applyUiZoom());
  uiResizeObserver.observe(zoomHost);
  uiResizeObserver.observe(currentUiRoot);
}

/**
 * Purpose: Implement `teardownUiZoomObserver` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function teardownUiZoomObserver() {
  if (uiResizeObserver) {
    uiResizeObserver.disconnect();
    uiResizeObserver = null;
  }
}

/**
 * Purpose: Implement `ensureMidiAccess` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
async function ensureMidiAccess() {
  if (!('requestMIDIAccess' in navigator)) {
    midiAccess = null;
    midiAccessPromise = null;
    return null;
  }
  if (midiAccess) return midiAccess;
  if (midiAccessPromise) return midiAccessPromise;
  midiAccessPromise = navigator.requestMIDIAccess()
    .then((access) => {
      midiAccess = access;
      return access;
    })
    .catch(() => {
      midiAccess = null;
      return null;
    })
    .finally(() => {
      midiAccessPromise = null;
    });
  try {
    return await midiAccessPromise;
  } catch {
    midiAccess = null;
    midiAccessPromise = null;
    return null;
  }
}

/**
 * Purpose: Implement `refreshMidiInputs` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
async function refreshMidiInputs(selectEl, preferredValue) {
  selectEl.innerHTML = '';
  const virtualOption = document.createElement('option');
  virtualOption.value = 'virtual';
  virtualOption.textContent = 'Virtual';
  selectEl.appendChild(virtualOption);

  const access = await ensureMidiAccess();
  if (!access) {
    selectEl.disabled = false;
    selectEl.value = 'virtual';
    return;
  }

  const inputs = Array.from(access.inputs.values());
  selectEl.disabled = false;
  inputs.forEach((input, idx) => {
    const option = document.createElement('option');
    option.value = input.id;
    option.textContent = input.name || `MIDI Device ${idx + 1}`;
    selectEl.appendChild(option);
  });

  // Preserve explicit virtual selection before falling back to previous device.
  if (preferredValue === 'virtual') {
    selectEl.value = 'virtual';
  } else if (preferredValue && inputs.some((i) => i.id === preferredValue)) {
    selectEl.value = preferredValue;
  } else if (midiInput && inputs.some((i) => i.id === midiInput.id)) {
    selectEl.value = midiInput.id;
  } else {
    selectEl.value = 'virtual';
  }
}

/**
 * Purpose: Implement `selectMidiDevice` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
async function selectMidiDevice(id) {
  const access = await ensureMidiAccess();
  if (!access) return;
  const input = Array.from(access.inputs.values()).find((i) => i.id === id);
  if (!input) return;
  disconnectMidiDevice();
  midiInput = input;
  midiInput.onmidimessage = async (event) => {
    const data = event.data;
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const note = data[1];
    const velocity = data.length > 2 ? data[2] : 0;
    if (status === 0x90 && velocity > 0) {
      if (!audioRunning) await startAudio();
      noteOnMidi(note, velocity / 127);
    } else if (status === 0x80 || (status === 0x90 && velocity === 0)) {
      noteOffMidi(note);
    } else if (dspNode && typeof dspNode.midiMessage === 'function') {
      try {
        dspNode.midiMessage(data);
      } catch {
        // ignore
      }
    }
  };
}

/**
 * Purpose: Implement `disconnectMidiDevice` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function disconnectMidiDevice() {
  if (midiInput) {
    midiInput.onmidimessage = null;
    midiInput = null;
  }
}

/**
 * Purpose: Implement `findMidiTargets` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function findMidiTargets(ui) {
  if (!Array.isArray(ui)) return null;
  const items = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.items) {
      node.items.forEach(walk);
    }
    if (node.type && node.address) {
      items.push(node);
    } else if (node.type && node.path) {
      items.push(node);
    }
  };
  walk(ui);

  /**
   * Purpose: Implement `findMatch` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const findMatch = (pattern) => {
    const regex = new RegExp(pattern, 'i');
    const match = items.find((item) => {
      const label = item.label || '';
      const address = item.address || item.path || '';
      return regex.test(label) || regex.test(address);
    });
    return match ? match.address || match.path : null;
  };

  return {
    gate: findMatch('gate|trig|trigger|noteon|keyon|on'),
    freq: findMatch('freq|frequency|hz|pitch'),
    key: findMatch('midi|key|note'),
    gain: findMatch('gain|amp|velocity|vel')
  };
}

/**
 * Purpose: Implement `clampParamValue` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function clampParamValue(path, value) {
  // Frontend clamp guarantees UI writes respect Faust min/max bounds.
  if (!Number.isFinite(value)) return value;
  const meta = paramMetaByPath.get(path);
  if (!meta) return value;
  let next = value;
  if (Number.isFinite(meta.min)) next = Math.max(meta.min, next);
  if (Number.isFinite(meta.max)) next = Math.min(meta.max, next);
  return next;
}

/**
 * Purpose: Implement `setParamCell` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function setParamCell(path, value, options = {}) {
  // Local LWW register update per parameter:
  // - stale timestamps are rejected
  // - stored value is always clamped
  const normalizedValue = clampParamValue(path, value);
  const timestamp =
    typeof options.timestamp === 'number' && Number.isFinite(options.timestamp)
      ? options.timestamp
      : Date.now();
  const current = paramCells[path];
  if (current && timestamp < current.d) {
    return { changed: false, value: current.v };
  }
  const sameValue = current && current.v === normalizedValue;
  const sameTimestamp = current && current.d === timestamp;
  if (sameValue && sameTimestamp) {
    return { changed: false, value: normalizedValue };
  }
  paramCells[path] = {
    v: normalizedValue,
    d: timestamp,
    owner: null
  };
  paramValues[path] = normalizedValue;
  return { changed: !sameValue, value: normalizedValue };
}

/**
 * Purpose: Implement `setParamValue` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function setParamValue(path, value, options = {}) {
  if (!path) return;
  const skipSnapshot = options && options.skipSnapshot === true;
  const skipEmit = options && options.skipEmit === true;
  const skipOrbitSync = options && options.skipOrbitSync === true;
  const smooth = options && options.smooth === true;
  const commit = options && options.commit === true;
  const timestamp =
    typeof options.timestamp === 'number' && Number.isFinite(options.timestamp)
      ? options.timestamp
      : Date.now();
  try {
    const nextCell = setParamCell(path, value, {
      timestamp
    });
    const nextValue = nextCell.value;
    if (!nextCell.changed) {
      return;
    }
    applyParamToDsp(path, nextValue, { smooth, commit });
    if (faustUIInstance) {
      markSuppressedUiParamEcho(path, nextValue);
      withSuppressedUiParamChange(() => {
        faustUIInstance.paramChangeByDSP(path, nextValue);
      });
    }
    if (!skipSnapshot) {
      sendRunParamsSnapshot();
    }
    if (!skipOrbitSync) {
      requestOrbitSyncFromParams();
    }
    if (!skipEmit && emitRunStateFn) emitRunStateFn();
  } catch {
    // ignore
  }
}

/**
 * Purpose: Implement `applyParamToDsp` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function applyParamToDsp(path, value, options = {}) {
  if (!dspNode) return;
  clearParamSmooth(path);
  try {
    dspNode.setParamValue(path, value);
  } catch {
    // ignore
  }
}

/**
 * Purpose: Implement `clearParamSmooth` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function clearParamSmooth(path) {
  const entry = paramSmooth.get(path);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  paramSmooth.delete(path);
}

/**
 * Purpose: Implement `clearAllParamSmoothing` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function clearAllParamSmoothing() {
  for (const [path, entry] of paramSmooth.entries()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    paramSmooth.delete(path);
  }
}

/**
 * Purpose: Implement `noteOnMidi` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function noteOnMidi(note, velocity) {
  markRunActivity();
  if (dspNode && typeof dspNode.keyOn === 'function') {
    const vel = Math.max(0, Math.min(127, Math.round(velocity * 127)));
    try {
      dspNode.keyOn(0, note, vel);
    } catch {
      // ignore
    }
    return;
  }
  if (midiOnly) return;
  if (!midiTargets) return;
  const freq = 440 * Math.pow(2, (note - 69) / 12);
  if (midiTargets.key) {
    setParamValue(midiTargets.key, note);
  }
  if (midiTargets.freq) {
    setParamValue(midiTargets.freq, freq);
  }
  if (midiTargets.gain) {
    setParamValue(midiTargets.gain, Math.max(0, Math.min(1, velocity)));
  }
  if (midiTargets.gate) {
    setParamValue(midiTargets.gate, 1);
  }
}

/**
 * Purpose: Implement `noteOffMidi` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function noteOffMidi(note = null) {
  markRunActivity();
  if (dspNode && typeof dspNode.keyOff === 'function') {
    try {
      if (note !== null) {
        dspNode.keyOff(0, note, 0);
      } else if (activeMidiNote !== null) {
        dspNode.keyOff(0, activeMidiNote, 0);
      } else if (typeof dspNode.allNotesOff === 'function') {
        dspNode.allNotesOff(true);
      }
    } catch {
      // ignore
    }
    return;
  }
  if (midiOnly) return;
  if (!midiTargets) return;
  if (midiTargets.gate) {
    setParamValue(midiTargets.gate, 0);
  }
}

/**
 * Purpose: Implement `applyParamValues` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function applyParamValues() {
  for (const [path, cell] of Object.entries(paramCells)) {
    const normalizedValue = normalizeRestoredParamValue(path, cell.v);
    try {
      if (dspNode) {
        dspNode.setParamValue(path, normalizedValue);
      }
      if (faustUIInstance) {
        markSuppressedUiParamEcho(path, normalizedValue);
        withSuppressedUiParamChange(() => {
          faustUIInstance.paramChangeByDSP(path, normalizedValue);
        });
      }
      if (paramValues[path] !== normalizedValue) {
        paramValues[path] = normalizedValue;
      }
      if (paramCells[path] && paramCells[path].v !== normalizedValue) {
        paramCells[path] = { ...paramCells[path], v: normalizedValue };
      }
    } catch {
      // ignore
    }
  }
  requestOrbitSyncFromParams(true);
}

/**
 * Purpose: Implement `normalizeRestoredParamValue` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function normalizeRestoredParamValue(path, value) {
  // Faust buttons are impulse controls and must not stay latched on restore.
  if (uiButtonPaths.has(path) && value > 0) return 0;
  return value;
}

/**
 * Purpose: Implement `normalizeLatchedButtonParams` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function normalizeLatchedButtonParams() {
  let changed = false;
  for (const path of uiButtonPaths) {
    const current = paramValues[path];
    if (typeof current === 'number' && current > 0) {
      paramValues[path] = 0;
      const cell = paramCells[path];
      if (cell) {
        paramCells[path] = { ...cell, v: 0, d: Date.now(), owner: null };
      } else {
        paramCells[path] = { v: 0, d: Date.now(), owner: null };
      }
      changed = true;
    }
  }
  return changed;
}

/**
 * Purpose: Implement `resetUiButtonsToZero` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function resetUiButtonsToZero() {
  if (uiButtonPaths.size === 0) return;
  let changed = false;
  for (const path of uiButtonPaths) {
    if (paramValues[path] !== 0) {
      changed = true;
    }
    try {
      if (dspNode) {
        dspNode.setParamValue(path, 0);
      }
      if (faustUIInstance) {
        faustUIInstance.paramChangeByDSP(path, 0);
      }
    } catch {
      // ignore
    }
    paramValues[path] = 0;
    paramCells[path] = { v: 0, d: Date.now(), owner: null };
  }
  pressedUiButtons.clear();
  if (changed) {
    sendRunParamsSnapshot(true);
  }
}
/**
 * Purpose: Implement `attachOutputParamHandler` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function attachOutputParamHandler() {
  if (!dspNode || typeof dspNode.setOutputParamHandler !== 'function') return;
  dspNode.setOutputParamHandler((path, value) => {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    if (typeof paramValues[path] === 'number' && Math.abs(paramValues[path] - value) < PARAM_SMOOTH_EPSILON) {
      return;
    }
    const current = paramCells[path];
    paramCells[path] = {
      v: clampParamValue(path, value),
      d: Date.now(),
      owner: null
    };
    paramValues[path] = paramCells[path].v;
    if (faustUIInstance) {
      faustUIInstance.paramChangeByDSP(path, paramValues[path]);
    }
    requestOrbitSyncFromParams();
    sendRunParamsSnapshot();
    if (emitRunStateFn) emitRunStateFn();
  });
  outputParamHandlerAttached = true;
}

/**
 * Purpose: Implement `startParamPolling` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function startParamPolling() {
  // Fallback bridge when DSP output handler is unavailable:
  // poll DSP values and reflect back into ParamCell state at a fixed cadence.
  if (outputParamHandlerAttached) return;
  if (paramPollId) return;
  if (!dspNode || typeof dspNode.getParamValue !== 'function') return;
  if (!faustUIInstance) return;
  const paths = uiParamPaths.length > 0 ? uiParamPaths : Object.keys(paramValues);
  if (paths.length === 0) return;
  paramPollId = setInterval(() => {
    if (!dspNode || !faustUIInstance) return;
    let changed = false;
    for (const path of paths) {
      try {
        const value = dspNode.getParamValue(path);
        if (typeof value !== 'number' || Number.isNaN(value)) continue;
        if (typeof paramValues[path] !== 'number' || Math.abs(paramValues[path] - value) >= PARAM_SMOOTH_EPSILON) {
          const current = paramCells[path];
          paramCells[path] = {
            v: clampParamValue(path, value),
            d: Date.now(),
            owner: null
          };
          paramValues[path] = paramCells[path].v;
          faustUIInstance.paramChangeByDSP(path, paramValues[path]);
          changed = true;
        }
      } catch {
        // ignore
      }
    }
    if (changed) {
      requestOrbitSyncFromParams();
      if (emitRunStateFn) emitRunStateFn();
    }
  }, 120);
}

/**
 * Purpose: Implement `stopParamPolling` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function stopParamPolling() {
  if (paramPollId) {
    clearInterval(paramPollId);
    paramPollId = null;
  }
}

/**
 * Purpose: Implement `updateUiRoot` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function updateUiRoot(container) {
  currentUiRoot =
    container.querySelector('.faust-ui-root') || container.firstElementChild || null;
}

/**
 * Purpose: Implement `prepareControlsContainer` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function prepareControlsContainer(container) {
  const hasExistingContent = !!container.querySelector('.run-controls-content');
  const bg = document.createElement('div');
  bg.className = 'run-controls-bg';
  const content = document.createElement('div');
  content.className = 'run-controls-content';
  if (hasExistingContent) {
    content.classList.add('run-controls-content-pending');
  }
  const split = document.createElement('div');
  split.className = 'run-controls-split';
  if (hasExistingContent) {
    split.classList.add('run-controls-split-pending');
  }
  const classicPane = document.createElement('div');
  classicPane.className = 'run-controls-pane run-controls-pane-classic';
  const orbitPane = document.createElement('div');
  orbitPane.className = 'run-controls-pane run-controls-pane-orbit';
  split.appendChild(classicPane);
  split.appendChild(orbitPane);
  content.appendChild(split);
  container.appendChild(bg);
  container.appendChild(content);
  return { bg, content, split, classicPane, orbitPane, hasExistingContent };
}

/**
 * Purpose: Finalize controls-panel DOM swap without clearing panel backgrounds.
 * How: Removes stale controls nodes while preserving the currently active background/content nodes.
 */
function finalizeControlsContainerSwap(container, keepBg, keepContent) {
  if (!container) return;
  const staleNodes = container.querySelectorAll('.run-controls-bg, .run-controls-content');
  for (const node of staleNodes) {
    if (node === keepBg || node === keepContent) continue;
    node.remove();
  }
}
/**
 * Purpose: Implement `ensureFaustUiCss` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function ensureFaustUiCss() {
  if (document.getElementById('faust-ui-css')) return;
  const link = document.createElement('link');
  link.id = 'faust-ui-css';
  link.rel = 'stylesheet';
  link.href = './vendor/faust-ui/index.css';
  document.head.appendChild(link);
}

/**
 * Purpose: Implement `sendSpectrumSnapshot` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function sendSpectrumSnapshot(scope, data, meta) {
  const now = Date.now();
  if (now - lastSpectrumSentAt < 100) return;
  lastSpectrumSentAt = now;
  const floorDb = typeof meta.floorDb === 'number' ? meta.floorDb : -110;
  const safeData = Array.from(data, (v) => (Number.isFinite(v) ? v : floorDb));
  const summary = buildSpectrumSummary(scope, safeData, {
    capturedAt: now,
    fmin: meta.fmin,
    fmax: meta.fmax,
    floorDb,
    audioQuality: meta.audioQuality
  });
  if (summary) {
    lastSpectrumSummary = summary;
  }
  const payload = {
    capturedAt: now,
    scale: meta.scale,
    fftSize: scope.fftSize || 2048,
    sampleRate: scope.sampleRate || 44100,
    fmin: meta.fmin,
    fmax: meta.fmax,
    floorDb,
    data: safeData
  };
  fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      spectrum: payload,
      spectrumSummary: summary || undefined
    })
  }).catch(() => {});
}

/**
 * Purpose: Implement `buildSpectrumSummary` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function buildSpectrumSummary(scope, data, meta) {
  if (!Array.isArray(data) || data.length < 8) return null;
  const sampleRate = Number.isFinite(scope.sampleRate) ? scope.sampleRate : 44100;
  const fftSize = Number.isFinite(scope.fftSize) ? scope.fftSize : 2048;
  const fmin = Number.isFinite(meta.fmin) ? meta.fmin : 20;
  const fmax = Number.isFinite(meta.fmax) ? meta.fmax : sampleRate / 2;
  const floorDb = Number.isFinite(meta.floorDb) ? meta.floorDb : -110;
  const bandsCount = 32;
  const peaksCount = 8;
  const bandsDbQ = buildLogBands(data, sampleRate, fmin, fmax, bandsCount, floorDb);
  const peaks = detectTopPeaks(data, sampleRate, fmax, floorDb, peaksCount);
  const features = computeSpectrumFeatures(data, sampleRate, fmax, floorDb);
  const previous = lastSpectrumSummary && lastSpectrumSummary.features ? lastSpectrumSummary.features : null;
  const delta = previous
    ? {
        rmsDbQ: features.rmsDbQ - previous.rmsDbQ,
        centroidHz: features.centroidHz - previous.centroidHz,
        rolloff95Hz: features.rolloff95Hz - previous.rolloff95Hz,
        flatnessQ: features.flatnessQ - previous.flatnessQ,
        crestDbQ: features.crestDbQ - previous.crestDbQ
      }
    : undefined;
  return {
    type: 'spectrum_summary_v1',
    capturedAt: meta.capturedAt,
    frame: {
      sampleRate: Math.round(sampleRate),
      fftSize: Math.round(fftSize),
      fmin: Math.round(fmin),
      fmax: Math.round(fmax),
      floorDb: Math.round(floorDb),
      bandsCount
    },
    bandsDbQ,
    peaks,
    features,
    audioQuality: meta.audioQuality || undefined,
    delta
  };
}

/**
 * Purpose: Implement `sendRunParamsSnapshot` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function sendRunParamsSnapshot(force = false) {
  // Periodically publish the full ParamCell map to backend arbitration.
  const now = Date.now();
  if (!force && now - lastRunParamsSentAt < 150) return;
  lastRunParamsSentAt = now;
  fetch('/api/state', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runStateSha: currentSha,
      runParams: cloneParamCells(paramCells)
    })
  }).catch(() => {});
}

/**
 * Purpose: Implement `executeLocalTrigger` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
async function executeLocalTrigger(path, holdMs) {
  if (!path || typeof path !== 'string') return;
  const duration =
    typeof holdMs === 'number' && Number.isFinite(holdMs)
      ? Math.max(1, Math.min(5000, Math.round(holdMs)))
      : 80;
  if (!audioRunning && typeof outputNode !== 'undefined') {
    startAudioOutput();
  }
  setParamValue(path, 1);
  await sleep(duration);
  setParamValue(path, 0);
  // Ensure remote shared state reflects button release even with throttle.
  sendRunParamsSnapshot(true);
}
function applyRunState(runState, controls) {
  if (!runState) return;
  if (runState.orbitUi && typeof runState.orbitUi === 'object') {
    pendingOrbitUi = runState.orbitUi;
  }
  if (runState.uiZoom) {
    uiZoom = String(runState.uiZoom);
  }
  if (runState.orbitZoom) {
    orbitZoom = String(runState.orbitZoom);
  }
  if (typeof runState.midiSource === 'string') {
    midiSource = runState.midiSource;
    if (controls.midiInputSelect) {
      controls.midiInputSelect.value = midiSource;
    }
  }
  const scope = runState.scope || {};
  if (typeof runState.polyVoices === 'number' && controls.modeSelect) {
    polyVoices = Math.max(0, runState.polyVoices);
    const desired = polyVoices > 0 ? String(polyVoices) : 'mono';
    if ([...controls.modeSelect.options].some((opt) => opt.value === desired)) {
      controls.modeSelect.value = desired;
    } else {
      controls.modeSelect.value = 'mono';
      polyVoices = 0;
    }
  }
  if (scope.view) {
    scopeState.view = scope.view;
    controls.scopeView.value = scope.view;
  }
  if (scope.spectrumScale) {
    scopeState.spectrumScale = scope.spectrumScale;
    controls.scopeScale.value = scope.spectrumScale;
  }
  if (scope.mode) {
    scopeState.mode = scope.mode;
    controls.scopeMode.value = scope.mode;
  }
  if (scope.slope) {
    scopeState.slope = scope.slope;
    controls.scopeSlope.value = scope.slope;
  }
  if (typeof scope.threshold === 'number') {
    scopeState.threshold = scope.threshold;
    controls.scopeThreshold.value = String(scope.threshold);
  }
  if (typeof scope.holdoffMs === 'number') {
    scopeState.holdoffMs = scope.holdoffMs;
    controls.scopeHoldoff.value = String(scope.holdoffMs);
  }
}

/**
 * Purpose: Implement `dispose` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
export function dispose() {
  // Full teardown is required because Run can be re-rendered in place
  // (for example on live session refresh) without an explicit view switch.
  uninstallRunSpaceShortcut();
  detachComputerMidiKeyboard();
  releasePressedUiButtons();
  uninstallUiReleaseGuard();
  cleanupAudio();
  compiledGenerator = null;
  compiledUI = null;
  faustUIInstance = null;
  emitRunStateFn = null;
  runActivityTick = 0;
  midiTargets = null;
  activeMidiNote = null;
  midiAccess = null;
  midiAccessPromise = null;
  midiSource = 'virtual';
  midiInput = null;
  uiParamPaths = [];
  paramValues = {};
  paramCells = {};
  paramMetaByPath = new Map();
  uiButtonPaths = new Set();
  uiButtonOrder = [];
  lastUiButtonPath = null;
  pressedUiButtons.clear();
  stopParamPolling();
  outputParamHandlerAttached = false;
  uiZoom = 'auto';
  orbitZoom = '100';
  orbitUiBatchDepth = 0;
  orbitUiBatchSnapshotPending = false;
  orbitUiBatchLastSentAt = 0;
  if (orbitUiInstance) {
    orbitUiInstance.destroy();
    orbitUiInstance = null;
  }
  teardownOrbitPaneResizeObserver();
  uiZoomWrap = null;
  uiZoomStage = null;
  teardownUiZoomObserver();
  teardownOrbitCanvasResize();
  if (orbitRafId) {
    cancelAnimationFrame(orbitRafId);
    orbitRafId = null;
  }
  orbitCanvas = null;
  orbitBody = null;
  orbitCtx = null;
  orbitState = null;
  orbitPointer = null;
  orbitNeedsDraw = false;
  orbitBaseWidth = 0;
  orbitBaseHeight = 0;
  lastOrbitParamSyncAt = 0;
  if (orbitParamSyncTimer) {
    clearTimeout(orbitParamSyncTimer);
    orbitParamSyncTimer = null;
  }
  if (orbitLayoutRetryTimer) {
    clearTimeout(orbitLayoutRetryTimer);
    orbitLayoutRetryTimer = null;
  }
  runRenderSeq += 1;
  remoteSyncInFlight = false;
  suppressUiParamChangeDepth = 0;
  suppressedUiParamEchoByPath.clear();
  controlsSplit = null;
  controlsClassicPane = null;
  controlsOrbitPane = null;
  if (remoteSyncTimer) {
    clearInterval(remoteSyncTimer);
    remoteSyncTimer = null;
  }
  lastAppliedTriggerNonce = 0;
  pendingOrbitUi = null;
  lastSpectrumSummary = null;
  _mcpController = null;
  clearAllParamSmoothing();
}

/**
 * Purpose: Implement `cleanupAudio` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function cleanupAudio() {
  releasePressedUiButtons();
  uninstallUiReleaseGuard();
  if (scopeRafId) {
    cancelAnimationFrame(scopeRafId);
    scopeRafId = null;
  }
  noteOffMidi();
  stopParamPolling();
  disconnectMidiDevice();
  stopAudioOutput();
  if (dspNode) {
    try {
      dspNode.disconnect();
    } catch {
      // ignore
    }
    dspNode = null;
  }
  if (audioContext) {
    try {
      audioContext.close();
    } catch {
      // ignore
    }
    audioContext = null;
  }
  analyserNode = null;
  outputNode = null;
  audioRunning = false;
  outputParamHandlerAttached = false;
  teardownUiZoomObserver();
  uiZoomWrap = null;
  uiZoomStage = null;
  clearAllParamSmoothing();
}

/**
 * Purpose: Implement `createScopeState` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function createScopeState(canvas) {
  const ctx = canvas.getContext('2d');
  resizeCanvasToDisplaySize(canvas, ctx);
  return {
    canvas,
    ctx,
    view: 'freq',
    spectrumScale: 'log',
    mode: 'auto',
    slope: 'rising',
    threshold: 0.0,
    holdoffMs: 20,
    windowSize: 1024,
    sampleRate: 44100,
    fftSize: 2048,
    lastTriggerSample: -Infinity,
    sampleCounter: 0,
    lastWindow: null
  };
}

/**
 * Purpose: Implement `setupScope` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function setupScope(context, node, scope) {
  resizeCanvasToDisplaySize(scope.canvas, scope.ctx);
  analyserNode = context.createAnalyser();
  analyserNode.fftSize = Math.max(8192, scope.windowSize * 2);
  analyserNode.smoothingTimeConstant = 0;
  scope.sampleRate = context.sampleRate;
  scope.fftSize = analyserNode.fftSize;

  node.connect(analyserNode);
  const gain = context.createGain();
  analyserNode.connect(gain);

  const buffer = new Float32Array(analyserNode.fftSize);
  const freqBuffer = new Float32Array(analyserNode.frequencyBinCount);

  /**
   * Purpose: Implement `draw` in the Run view.
   * How: Updates Run view audio, MIDI, UI, and sync state for this step.
   */
  const draw = () => {
    analyserNode.getFloatTimeDomainData(buffer);
    lastAudioQuality = computeAudioQuality(buffer);
    if (scope.view === 'freq') {
      analyserNode.getFloatFrequencyData(freqBuffer);
      drawSpectrum(scope, freqBuffer);
    } else {
      // Even when the user picked Waveform, keep lastSpectrumSummary
      // fresh so MCP callers (get_spectrum, *_and_get_spectrum) always
      // have a current snapshot. sendSpectrumSnapshot is throttled
      // internally (~10 Hz) so the extra FFT pull is cheap.
      analyserNode.getFloatFrequencyData(freqBuffer);
      sendSpectrumSnapshot(scope, freqBuffer, {
        scale: scope.spectrumScale || 'log',
        fmin: 20,
        fmax: scope.sampleRate / 2,
        floorDb: -110,
        audioQuality: lastAudioQuality || undefined
      });
      scope.sampleCounter += buffer.length;
      const window = findTriggeredWindow(buffer, scope);
      if (window) {
        scope.lastWindow = window;
        drawScope(scope, window);
      } else if (scope.mode === 'auto') {
        const fallback = buffer.slice(0, scope.windowSize);
        scope.lastWindow = fallback;
        drawScope(scope, fallback);
      } else if (scope.lastWindow) {
        drawScope(scope, scope.lastWindow);
      }
    }
    scopeRafId = requestAnimationFrame(draw);
  };

  scopeRafId = requestAnimationFrame(draw);
  return gain;
}

/**
 * Purpose: Implement `startAudioOutput` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function startAudioOutput() {
  if (!audioContext || !outputNode) return;
  if (audioRunning) return;
  try {
    outputNode.connect(audioContext.destination);
    audioRunning = true;
  } catch {
    // ignore
  }
}

/**
 * Purpose: Implement `stopAudioOutput` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function stopAudioOutput() {
  if (!outputNode) return;
  try {
    outputNode.disconnect();
  } catch {
    // ignore
  }
  audioRunning = false;
}

/**
 * Purpose: Implement `resumeAudioContext` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
async function resumeAudioContext() {
  if (!audioContext) return;
  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
  if (audioContext.state !== 'running') {
    throw new Error(
      'Audio start blocked by browser policy. Click "Audio : Off" once in Run view to unlock audio.'
    );
  }
}

/**
 * Purpose: Implement `drawScope` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function drawScope(scope, data) {
  resizeCanvasToDisplaySize(scope.canvas, scope.ctx);
  const { ctx, canvas } = scope;
  if (!ctx) return;
  const { width, height } = getCanvasSize(canvas);
  const innerWidth = Math.max(0, width - 1);
  const innerHeight = Math.max(0, height - 1);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, width, height);
  drawScopeGrid(ctx, innerWidth, innerHeight);
  ctx.strokeStyle = '#4bd';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const midY = innerHeight / 2;
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * innerWidth;
    const y = midY - data[i] * (innerHeight * 0.45);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // draw threshold
  const tY = midY - scope.threshold * (innerHeight * 0.45);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.beginPath();
  ctx.moveTo(0, tY);
  ctx.lineTo(innerWidth, tY);
  ctx.stroke();
}

/**
 * Purpose: Implement `drawScopePlaceholder` in the Run view.
 * How: Keeps the scope grid visible while audio rendering is inactive.
 */
function drawScopePlaceholder(scope) {
  if (!scope || !scope.ctx || !scope.canvas) return;
  resizeCanvasToDisplaySize(scope.canvas, scope.ctx);
  const { ctx, canvas } = scope;
  const { width, height } = getCanvasSize(canvas);
  const innerWidth = Math.max(0, width - 1);
  const innerHeight = Math.max(0, height - 1);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, width, height);
  if (scope.view === 'freq') {
    drawSpectrumGrid(ctx, innerWidth, innerHeight, scope);
    const fmin = scope.spectrumScale === 'linear' ? 0 : 20;
    const fmax = scope.sampleRate ? scope.sampleRate / 2 : 22050;
    drawFreqAxis(ctx, innerWidth, innerHeight, fmin, fmax, scope.spectrumScale);
  } else {
    drawScopeGrid(ctx, innerWidth, innerHeight);
  }
}

/**
 * Purpose: Implement `drawSpectrum` in the Run view.
 * How: Updates Run view audio, MIDI, UI, and sync state for this step.
 */
function drawSpectrum(scope, data) {
  resizeCanvasToDisplaySize(scope.canvas, scope.ctx);
  const { ctx, canvas } = scope;
  if (!ctx) return;
  const { width, height } = getCanvasSize(canvas);
  const innerWidth = Math.max(0, width - 1);
  const innerHeight = Math.max(0, height - 1);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, width, height);
  drawSpectrumGrid(ctx, innerWidth, innerHeight, scope);

  const sampleRate = scope.sampleRate || 44100;
  const fftSize = scope.fftSize || 2048;
  const linear = scope.spectrumScale === 'linear';
  const fmin = linear ? 0 : 20;
  const fmax = sampleRate / 2;
  const logMin = Math.log10(fmin || 1);
  const logMax = Math.log10(fmax);
  ctx.fillStyle = '#4bd';
  const binCount = data.length;
  if (true) {
    const floorDb = -110;
    const smoothRadius = 2;
    const smoothed = new Float32Array(binCount);
    for (let i = 0; i < binCount; i++) {
      let sum = 0;
      let count = 0;
      for (let k = -smoothRadius; k <= smoothRadius; k++) {
        const idx = i + k;
        if (idx < 0 || idx >= binCount) continue;
        sum += data[idx];
        count += 1;
      }
      smoothed[i] = count > 0 ? sum / count : data[i];
    }
    ctx.save();
    ctx.translate(0.5, 0.5);
    ctx.strokeStyle = '#4bd';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let i = 1; i < binCount; i++) {
      const f = (i / binCount) * fmax;
      if (!linear && f < fmin) continue;
      const x = linear
        ? (i / (binCount - 1)) * innerWidth
        : ((Math.log10(f) - logMin) / (logMax - logMin)) * innerWidth;
      const v = smoothed[i];
      const norm = Math.max(0, Math.min(1, (v - floorDb) / (-floorDb)));
      const y = innerHeight - norm * innerHeight;
      const px = Math.round(x);
      const py = Math.round(y);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#111';
    ctx.fillRect(0, innerHeight+1, innerWidth, 2);
    sendSpectrumSnapshot(scope, smoothed, {
      scale: linear ? 'linear' : 'log',
      fmin,
      fmax,
      floorDb,
      audioQuality: lastAudioQuality || undefined
    });
  }

  drawFreqAxis(ctx, innerWidth, innerHeight, fmin, fmax, scope.spectrumScale);
}

// ---------------------------------------------------------------------
// MCP control surface
//
// These exports let `webapp/handlers.js` (and through it the MCP server)
// drive the same audio + UI runtime the human user manipulates. Every
// write goes through `setParamValue` so the visible slider follows along
// (it calls `faustUIInstance.paramChangeByDSP`).
//
// `mcpIsMounted` is the gate : it is true only between `render()` and
// the next `dispose()`. Callers should `await mcpWaitForMount(timeoutMs)`
// after switching to the Run view, because app.js mounts the view on its
// own polling cadence.
// ---------------------------------------------------------------------

export function mcpIsMounted() {
  return _mcpController !== null;
}

export async function mcpWaitForMount(timeoutMs = 3000) {
  const start = performance.now();
  while (!mcpIsMounted()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error('Run view not mounted within ' + timeoutMs + 'ms');
    }
    await sleep(50);
  }
}

function mcpAssertMounted() {
  if (!mcpIsMounted()) {
    throw new Error(
      'Run view not mounted. Call set_view with view="run" first and ' +
      'wait for the UI to come up.'
    );
  }
}

export function mcpGetSha() {
  return currentSha;
}

export function mcpGetUI() {
  mcpAssertMounted();
  return compiledUI;
}

export function mcpGetParams() {
  mcpAssertMounted();
  return { ...paramValues };
}

export function mcpIsAudioRunning() {
  return audioRunning;
}

export async function mcpStartAudio() {
  mcpAssertMounted();
  await _mcpController.startAudio();
}

export async function mcpStopAudio() {
  mcpAssertMounted();
  _mcpController.stopAudio();
}

export function mcpSetParam(path, value) {
  mcpAssertMounted();
  setParamValue(path, value);
}

export async function mcpTriggerButton(path, holdMs = 80) {
  mcpAssertMounted();
  if (!audioRunning) await _mcpController.startAudio();
  await executeLocalTrigger(path, holdMs);
}

export function mcpGetPolyphony() {
  return polyVoices;
}

export async function mcpSetPolyphony(voices) {
  mcpAssertMounted();
  await _mcpController.applyPolyphonyChange(voices);
}

export async function mcpSendMidi(ev) {
  mcpAssertMounted();
  const action = ev && ev.action;
  const note = Number(ev && ev.note);
  const velocity = typeof ev?.velocity === 'number' ? ev.velocity : 0.8;
  const holdMs = typeof ev?.holdMs === 'number' ? ev.holdMs : 120;
  if (!audioRunning && (action === 'on' || action === 'pulse')) {
    await _mcpController.startAudio();
  }
  if (action === 'on') {
    noteOnMidi(note, velocity);
  } else if (action === 'off') {
    noteOffMidi(note);
  } else if (action === 'pulse') {
    noteOnMidi(note, velocity);
    await sleep(Math.max(1, Math.min(5000, holdMs)));
    noteOffMidi(note);
  } else {
    throw new Error('Invalid MIDI action (expected on/off/pulse)');
  }
}

export function mcpGetLatestSpectrum() {
  if (!audioRunning) {
    throw new Error('Spectrum not available — audio not running');
  }
  if (!lastSpectrumSummary) {
    throw new Error('Spectrum not yet captured — wait a few hundred ms after starting audio');
  }
  return lastSpectrumSummary;
}

export async function mcpCaptureSpectrumSeries({ settleMs = 0, captureMs = 300, sampleEveryMs = 80, maxFrames = 10 } = {}) {
  mcpAssertMounted();
  if (!audioRunning) {
    throw new Error('Capture requested but audio is not running');
  }
  if (settleMs > 0) await sleep(settleMs);
  const start = performance.now();
  const series = [];
  while (series.length < maxFrames) {
    const elapsed = performance.now() - start;
    if (elapsed > captureMs) break;
    if (lastSpectrumSummary) {
      series.push({ tMs: Math.round(elapsed), summary: lastSpectrumSummary });
    }
    await sleep(sampleEveryMs);
  }
  if (series.length === 0) {
    throw new Error('No spectrum summary captured');
  }
  return {
    series,
    aggregate: {
      mode: 'max_hold',
      summary: aggregateMaxHold(series.map((s) => s.summary))
    }
  };
}
