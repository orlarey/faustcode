// playground-link.js — edit the code of FaustPlayground modules in faustcode
// (spec_playground_link.md).
//
// FaustPlayground opens faustcode with ?link=playground in a window it
// keeps a reference to (window.opener here). The two pages may have
// different origins : they talk with postMessage. Every message carries
// `type` and `protocol` (LINK_PROTOCOL) :
//
//   faustcode → playground   faustcode-link-ready   { }                 ready to edit
//   playground → faustcode   faustcode-link-edit    { id, name, code }  edit this code
//   faustcode → playground   faustcode-link-code    { id, code }        compiled new code
//   playground → faustcode   faustcode-link-result  { id, ok, error? }  applied or not
//   playground → faustcode   faustcode-link-close   { id }              module removed
//
// `id` designates a module of the playground. The session created for it
// is linked to the module, and so is every session saved from a linked
// session (Cmd/Ctrl-S in the dsp view or the floating editor, MCP
// submit) : sessions are keyed by the sha1 of their code, so each save
// makes a new one. Each save that compiles without error is sent to the
// playground ; a code with errors stays here.
//
// Messages are only accepted from window.opener, and only from the origin
// of its first message ; replies go to that origin only.
//
// The pure parts (LinkTable, parseLinkMessage, sessionFilename) are
// unit-tested with node --test ; installPlaygroundLink needs a browser.

export const LINK_PROTOCOL = 1;
export const LINK_PARAM = 'link';
export const LINK_VALUE = 'playground';
export const SUBMITTED_EVENT = 'faustcode:submitted';

/** True when faustcode was opened by FaustPlayground (?link=playground). */
export function isPlaygroundLink(search) {
  return new URLSearchParams(search).get(LINK_PARAM) === LINK_VALUE;
}

/**
 * Every compilation of a session (shim /api/submit and MCP submit) is
 * announced with the sha1 that was active before it.
 * @param {{ sha1, previous, code, filename, errors }} detail
 */
export function announceSubmit(detail) {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(SUBMITTED_EVENT, { detail }));
}

/** Session filename of a module : its name, made acceptable (.dsp). */
export function sessionFilename(name) {
  const base = String(name || '').replace(/\.dsp$/i, '').replace(/[^A-Za-z0-9_ -]/g, '_').trim();
  return `${base || 'module'}.dsp`;
}

const STRING_FIELDS = {
  'faustcode-link-edit': ['id', 'name', 'code'],
  'faustcode-link-result': ['id'],
  'faustcode-link-close': ['id'],
};

/**
 * A message of the playground, checked ; null if it is not one (other
 * messages of the page, other protocol version, missing fields).
 */
export function parseLinkMessage(data) {
  if (!data || typeof data !== 'object' || data.protocol !== LINK_PROTOCOL) return null;
  const fields = STRING_FIELDS[data.type];
  if (!fields || fields.some((f) => typeof data[f] !== 'string')) return null;
  if (data.type === 'faustcode-link-result' && typeof data.ok !== 'boolean') return null;
  return data;
}

/** Which sessions are linked to which module of the playground. */
export class LinkTable {
  constructor() {
    this.bySha = new Map(); // sha1 → { id, name }
  }

  link(sha1, module) {
    this.bySha.set(sha1, { id: module.id, name: module.name });
  }

  get(sha1) {
    return this.bySha.get(sha1) || null;
  }

  /**
   * A session was saved while `previous` was active : when `previous` is
   * linked, the new session is linked to the same module. Returns that
   * module, or null.
   */
  follow(previous, sha1) {
    const module = previous ? this.get(previous) : null;
    if (module && sha1) this.bySha.set(sha1, module);
    return module;
  }

  /** The module was removed from the playground. Returns its name, or null. */
  unlink(id) {
    let name = null;
    for (const [sha1, module] of this.bySha) {
      if (module.id === id) {
        name = module.name;
        this.bySha.delete(sha1);
      }
    }
    return name;
  }

  nameOf(id) {
    for (const module of this.bySha.values()) if (module.id === id) return module.name;
    return null;
  }
}

/**
 * Starts the link when faustcode was opened by FaustPlayground.
 * @param {{
 *   submit: (code: string, filename: string) => Promise<{ sha1: string, errors: string }>,
 *   show: (sha1: string) => Promise<void>,   // make the session visible in the dsp view
 *   notify: (message: string, durationMs?: number) => void,
 *   log?: (kind: string, ...parts: string[]) => void,
 * }} hooks
 * @returns {LinkTable | null}
 */
export function installPlaygroundLink({ submit, show, notify, log = () => {} }) {
  if (typeof window === 'undefined' || !isPlaygroundLink(location.search) || !window.opener) return null;
  const opener = window.opener;
  const table = new LinkTable();
  let origin = null;     // the playground's, from its first message
  let explicit = false;  // our own submit of a module's code is not a save

  const post = (message) => {
    if (!origin || opener.closed) return false;
    opener.postMessage({ protocol: LINK_PROTOCOL, ...message }, origin);
    return true;
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== opener) return;
    const m = parseLinkMessage(event.data);
    if (!m) return;
    if (origin && event.origin !== origin) return;
    origin = event.origin;
    switch (m.type) {
      case 'faustcode-link-edit': {
        let result;
        explicit = true;
        try {
          result = await submit(m.code, sessionFilename(m.name));
        } catch (err) {
          notify(`FaustPlayground : ${m.name} could not be opened (${err && err.message ? err.message : err})`, 10000);
          return;
        } finally {
          explicit = false;
        }
        if (result.errors && String(result.errors).trim()) {
          // not stored : nothing to edit
          notify(`FaustPlayground : ${m.name} does not compile in faustcode : ${String(result.errors).split('\n')[0]}`, 10000);
          log('warn', `playground link : ${m.name} does not compile`);
          return;
        }
        table.link(result.sha1, { id: m.id, name: m.name });
        log('info', `playground link : ${m.name} (${result.sha1.slice(0, 8)}) from ${origin}`);
        await show(result.sha1);
        notify(`Linked to FaustPlayground : ${m.name}. Each successful save (Cmd/Ctrl-S) updates the module.`, 8000);
        try { window.focus(); } catch { /* ignore */ }
        break;
      }
      case 'faustcode-link-result': {
        const name = table.nameOf(m.id) || 'module';
        if (m.ok) notify(`FaustPlayground : ${name} updated`, 2000);
        else notify(`FaustPlayground did not apply ${name} : ${String(m.error || '').split('\n')[0]}`, 10000);
        break;
      }
      case 'faustcode-link-close': {
        const name = table.unlink(m.id);
        if (name) notify(`FaustPlayground : ${name} was removed, its sessions are no longer linked`, 8000);
        break;
      }
    }
  });

  document.addEventListener(SUBMITTED_EVENT, (event) => {
    if (explicit) return;
    const { sha1, previous, code, errors } = event.detail || {};
    const module = table.follow(previous, sha1);
    if (!module || (errors && String(errors).trim())) return;
    if (!post({ type: 'faustcode-link-code', id: module.id, code })) {
      notify('FaustPlayground is closed : the module was not updated', 8000);
    }
  });

  // The playground answers with the code to edit (to any opener : this
  // message carries nothing).
  opener.postMessage({ type: 'faustcode-link-ready', protocol: LINK_PROTOCOL }, '*');
  log('info', 'playground link : ready');
  return table;
}
