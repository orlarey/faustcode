// faust-doc.js — client-side port of the Faust library doc helpers.
//
// The precompiled index (dist/faust-doc-index.json, symlinked into
// webapp/ at dev time) contains :
//   - symbols[] : flat list of every documented function / operator,
//                 each with { id, name, qualifiedName, summary, usage,
//                 params, source, testCode, header, ... }
//   - libraries[] : per-.lib aggregate { file, aliasHints, symbols[] }
//
// Helpers mirror the matching logic of mcp.mjs so the faustcode webapp
// returns the same shape for the 5 library tools and the onboarding
// guide (which is itself just static data).

let _indexPromise = null;

async function getIndex() {
  if (_indexPromise) return _indexPromise;
  _indexPromise = (async () => {
    const resp = await fetch('./faust-doc-index.json', { cache: 'no-cache' });
    if (!resp.ok) {
      throw new Error(`faust-doc-index.json not available (HTTP ${resp.status})`);
    }
    return resp.json();
  })();
  return _indexPromise;
}

function rankSymbolMatch(symbol, queryLower) {
  const q = queryLower;
  if (symbol.qualifiedName.toLowerCase() === q) return 120;
  if (symbol.name.toLowerCase() === q) return 110;
  if (symbol.id.toLowerCase() === q) return 105;
  let score = 0;
  const haystacks = [
    symbol.name,
    symbol.qualifiedName,
    symbol.summary || '',
    symbol.source && symbol.source.file ? symbol.source.file : '',
  ].map((s) => String(s).toLowerCase());
  for (const h of haystacks) {
    if (h.includes(q)) score += 20;
  }
  return score;
}

function findFaustSymbolIn(index, symbolInput) {
  const key = String(symbolInput || '').trim().toLowerCase();
  if (!key) return { symbol: null, alternatives: [] };

  // 1. exact match on name / id / qualifiedName / header
  const exact = index.symbols.find((s) => {
    const header = String(s.header || '').toLowerCase();
    return (
      s.name.toLowerCase() === key ||
      s.id.toLowerCase() === key ||
      s.qualifiedName.toLowerCase() === key ||
      header === key ||
      header.replace(/[`()]/g, '') === key.replace(/[`()]/g, '')
    );
  });
  if (exact) return { symbol: exact, alternatives: [] };

  // 2. fuzzy ranking
  const ranked = index.symbols
    .map((s) => ({ s, score: rankSymbolMatch(s, key) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return { symbol: null, alternatives: [] };
  return {
    symbol: ranked[0].s,
    alternatives: ranked.slice(1, 6).map((x) => x.s),
  };
}

function summarize(s) {
  return {
    id: s.id,
    name: s.name,
    qualifiedName: s.qualifiedName,
    summary: s.summary,
    usage: s.usage,
    source: s.source,
  };
}

// ----- public API -----

export async function searchFaustLib({ query, limit, module }) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) throw new Error('Missing query');
  const max = typeof limit === 'number' ? limit : 10;
  const mod = module ? String(module).trim().toLowerCase() : '';
  const index = await getIndex();
  const results = index.symbols
    .filter((s) => {
      if (!mod) return true;
      const sourceFile = (s.source && s.source.file ? s.source.file : '').toLowerCase();
      const modName = sourceFile.replace(/\.lib$/i, '');
      return modName === mod || sourceFile === `${mod}.lib` ||
        s.qualifiedName.toLowerCase().startsWith(`${mod}.`);
    })
    .map((s) => ({ symbol: s, score: rankSymbolMatch(s, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => summarize(x.symbol));
  return { query, module: module || null, results };
}

export async function getFaustSymbol({ symbol }) {
  const key = String(symbol || '').trim();
  if (!key) throw new Error('Missing symbol');
  const index = await getIndex();
  const found = findFaustSymbolIn(index, key);
  if (!found.symbol) throw new Error(`Symbol not found: ${key}`);
  return {
    symbol: found.symbol,
    alternatives: found.alternatives.map((s) => ({
      id: s.id,
      qualifiedName: s.qualifiedName,
      summary: s.summary,
    })),
  };
}

export async function listFaustModule({ module, limit }) {
  const mod = String(module || '').trim().toLowerCase();
  if (!mod) throw new Error('Missing module');
  const max = typeof limit === 'number' ? limit : 200;
  const index = await getIndex();
  const lib = index.libraries.find((l) => {
    const name = String(l.file || '').toLowerCase().replace(/\.lib$/i, '');
    const aliases = Array.isArray(l.aliasHints)
      ? l.aliasHints.map((a) => String(a).toLowerCase())
      : [];
    return name === mod || aliases.includes(mod);
  });
  if (!lib) throw new Error(`Module not found: ${module}`);
  const symbols = (lib.symbols || []).slice(0, max).map(summarize);
  return {
    module: mod,
    file: lib.file,
    aliasHints: lib.aliasHints || [],
    symbols,
  };
}

export async function getFaustExamples({ symbolOrModule, limit }) {
  const key = String(symbolOrModule || '').trim();
  if (!key) throw new Error('Missing symbolOrModule');
  const max = typeof limit === 'number' ? limit : 10;
  const index = await getIndex();

  // Try symbol scope first.
  const { symbol } = findFaustSymbolIn(index, key);
  if (symbol) {
    const examples = symbol.testCode
      ? [{ symbol: symbol.qualifiedName, code: symbol.testCode, source: symbol.source }]
      : [];
    return { scope: 'symbol', query: key, examples };
  }

  // Fall back to module scope.
  const mod = key.toLowerCase();
  const lib = index.libraries.find((l) => {
    const name = String(l.file || '').toLowerCase().replace(/\.lib$/i, '');
    const aliases = Array.isArray(l.aliasHints)
      ? l.aliasHints.map((a) => String(a).toLowerCase())
      : [];
    return name === mod || aliases.includes(mod);
  });
  if (!lib) throw new Error(`No symbol/module found: ${key}`);

  const examples = [];
  for (const s of lib.symbols || []) {
    if (!s.testCode) continue;
    examples.push({ symbol: s.qualifiedName, code: s.testCode, source: s.source });
    if (examples.length >= max) break;
  }
  return { scope: 'module', query: key, file: lib.file, examples };
}

export async function explainFaustSymbolForGoal({ symbol, goal }) {
  const key = String(symbol || '').trim();
  if (!key) throw new Error('Missing symbol');
  const index = await getIndex();
  const found = findFaustSymbolIn(index, key);
  if (!found.symbol) throw new Error(`Symbol not found: ${key}`);
  const goalText = String(goal || '').trim();
  const params = Array.isArray(found.symbol.params) ? found.symbol.params : [];
  const paramHint = params.length
    ? `Key params: ${params.map((p) => `${p.name} (${p.description})`).join('; ')}`
    : 'No explicit parameter notes found.';
  const usage = found.symbol.usage ? `Usage: ${found.symbol.usage}` : 'Usage not documented.';
  return {
    symbol: found.symbol.qualifiedName,
    goal: goalText,
    recommendation: [
      `Use ${found.symbol.qualifiedName} when it matches this goal: ${goalText || 'general DSP design'}.`,
      found.symbol.summary || 'No summary found in comments.',
      usage,
      paramHint,
      found.symbol.testCode
        ? 'A test snippet is available via get_faust_examples.'
        : 'No test snippet found.',
    ].join(' '),
  };
}

// Onboarding payload — identical to the Docker version (mcp.mjs).
export const ONBOARDING_GUIDE = {
  version: 1,
  goals: [
    'Design and iterate Faust DSP',
    'Control run parameters safely',
    'Measure spectral impact and audio quality',
    'Control polyphony and MIDI notes when relevant',
  ],
  prerequisites: [
    'If audio tools fail with "Audio is locked", ask the user to switch Audio to "On" once in Run view.',
  ],
  workflow: [
    '1) set_view("run")',
    '2) get_polyphony() then set_polyphony(...) if needed (0=mono)',
    '3) get_run_ui() and get_run_params()',
    '4) run_audio("on")',
    '5) For continuous params: set_run_param_and_get_spectrum(...)',
    '6) For transient buttons: trigger_button_and_get_spectrum(...)',
    '7) For note events: prefer midi_note_*_and_get_spectrum(...)',
    '8) Compare aggregate.summary and iterate one parameter at a time',
  ],
  toolHints: {
    polyphony: 'Use set_polyphony(0) for mono, else 1/2/4/8/16/32/64.',
    midi: 'Prefer midi_note_pulse(note, velocity, holdMs) for deterministic one-shot tests.',
  },
  qualityThresholds: {
    clipRatioQ_warn: 1,
    clipRatioQ_severe: 5,
    clickScoreQ_warn: 20,
    clickScoreQ_severe: 40,
  },
  policy: [
    'Do not optimize timbre while ignoring audioQuality.',
    'Flag severe clipping and click risk unless explicitly requested.',
  ],
  libraryDiscovery: [
    'Use search_faust_lib(query) to find relevant functions without loading whole libraries.',
    'Use get_faust_symbol(symbol) to retrieve usage, parameters, and test snippets.',
    'Use list_faust_module(module) and get_faust_examples(symbolOrModule) for exploration.',
  ],
};
