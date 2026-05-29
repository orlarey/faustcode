/**
 * Purpose: Centralize mutable application state and static showcase payloads.
 * How: Exports one shared state object and constants consumed by the app orchestration module.
 */

export const state = {
  currentSha: null,
  currentView: 'dsp',
  sessionOrder: 'chronological', // chronological | usage
  views: [],
  sessions: [],        // Sessions sorted according to sessionOrder.
  sessionIndex: -1,    // -1 = uninitialized, sessions.length = empty-session slot.
  dragCounter: 0,      // Counter used to balance dragenter/dragleave events.
  runStateBySha: {},   // Run state persisted per session (params, orbit, etc.).
  audioUnlocked: false,
  runGlobal: {
    audioRunning: false,
    scope: null,
    polyVoices: 0,
    midiSource: 'virtual',
    uiZoom: 'auto',
    orbitZoom: '100',
    orbitUi: null,
    lastRunInteractionAt: 0
  },
  viewScroll: {
    dsp: { line: 1 },
    cpp: { line: 1 }
  },
  viewScrollBySha: {},
  showcase: {
    active: false,
    sha: null,
    viewTimer: null
  }
};

export const SHOWCASE_FILENAME = 'showcase-organ.dsp';
export const SHOWCASE_CODE = `import("stdfaust.lib");

process = organ;

organ = timbre (freq) * gate * gain * volume
with {
    freq = hslider("freq", 440, 40, 8000, 1);
    gate = button("gate") : fi.lowpass(1,1);
    gain = hslider("gain", 0, 0, 1, 0.01);
    volume = hslider("volume", 0.25, 0, 1, 0.01);
    timbre(f) = osc(f) * 0.5 + osc(2*f) * 0.25;
    osc(f) = phase(f) * 2 * ma.PI : sin;
    phase(f) = f/ma.SR : (+ : %(1.0)) ~ _;
};
`;
