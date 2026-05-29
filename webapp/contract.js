// contract.js — load the shared tools.json contract.
//
// At dev time the file lives at the repo root, two levels up from
// webapp/index.html when served via `python3 -m http.server` from the
// repo root. At production time (GitHub Pages bundle) tools.json will
// be copied alongside index.html, so we try both locations in turn.

const CANDIDATE_URLS = [
  './tools.json',     // bundled next to index.html (GitHub Pages)
  '../tools.json',    // repo-root copy during local dev
];

export async function loadContract() {
  let lastErr = null;
  for (const url of CANDIDATE_URLS) {
    try {
      const resp = await fetch(url, { cache: 'no-cache' });
      if (!resp.ok) {
        lastErr = new Error(`${url} : HTTP ${resp.status}`);
        continue;
      }
      const c = await resp.json();
      validateContract(c, url);
      return c;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no tools.json found');
}

function validateContract(c, source) {
  if (!c || typeof c !== 'object') {
    throw new Error(`${source} : not an object`);
  }
  if (!c.contractVersion) {
    throw new Error(`${source} : missing contractVersion`);
  }
  if (!Array.isArray(c.tools) || c.tools.length === 0) {
    throw new Error(`${source} : empty or missing tools array`);
  }
  const seen = new Set();
  for (const t of c.tools) {
    if (!t.name) throw new Error(`${source} : tool with empty name`);
    if (seen.has(t.name)) throw new Error(`${source} : duplicate tool name ${t.name}`);
    seen.add(t.name);
  }
}
