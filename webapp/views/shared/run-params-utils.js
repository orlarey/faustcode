/**
 * Purpose: Normalize one run parameter cell payload before local/remote merge.
 * How: Accepts legacy numeric values, validates `{ v, d }` objects, and applies timestamp fallback for missing `d`.
 */
export function normalizeRunParamCell(path, input, fallbackTs = Date.now()) {
  if (!path) return null;
  if (typeof input === 'number' && Number.isFinite(input)) {
    return { v: input, d: fallbackTs, owner: null };
  }
  if (!input || typeof input !== 'object') return null;
  const v = Number(input.v);
  if (!Number.isFinite(v)) return null;
  const dRaw = Number(input.d);
  const d = Number.isFinite(dRaw) ? dRaw : fallbackTs;
  // Ownerless sync model: owner is ignored by frontend reconciliation.
  return { v, d, owner: null };
}

/**
 * Purpose: Normalize a full run-parameter map into valid ParamCell entries.
 * How: Iterates object entries, normalizes each cell independently, and drops invalid paths/cells.
 */
export function normalizeRunParamCells(input, fallbackTs = Date.now()) {
  const cells = {};
  if (!input || typeof input !== 'object') return cells;
  for (const [path, value] of Object.entries(input)) {
    const cell = normalizeRunParamCell(path, value, fallbackTs);
    if (!cell) continue;
    cells[path] = cell;
  }
  return cells;
}

/**
 * Purpose: Clone a run-parameter cell map without preserving source object references.
 * How: Rebuilds every cell with primitive copies of `{ v, d }` in ownerless mode.
 */
export function cloneParamCells(input) {
  const output = {};
  for (const [path, cell] of Object.entries(input || {})) {
    output[path] = { v: cell.v, d: cell.d, owner: null };
  }
  return output;
}

/**
 * Purpose: Produce a deterministic fingerprint for semantic run-parameter comparisons.
 * How: Normalizes cells, sorts by path, and concatenates value/timestamp tuples into one stable string.
 */
export function fingerprintRunParams(input) {
  const cells = normalizeRunParamCells(input, 0);
  const entries = Object.entries(cells)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, cell]) => `${path}:${Number(cell.v)}:${Number(cell.d)}`);
  return entries.join('|');
}
