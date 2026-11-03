// playground-link.js — edit the code of faustmodular modules in faustcode
// (spec_playground_link.md). faustmodular was called faustmodular (extended)
// before 2.10.0, hence the names of this file and of its messages.
//
// faustmodular opens faustcode with ?link=modular (?link=playground before
// 2.10.0, still accepted) in a window it
// keeps a reference to (window.opener here). The two pages may have
// different origins : they talk with postMessage. Every message carries
// `type` and `protocol` (LINK_PROTOCOL) :
//
//   faustcode → playground   faustcode-link-ready   { libfaust? }       ready to edit (libfaust : version
//                                                                        of its compiler, compared by the playground)
//   playground → faustcode   faustcode-link-edit    { id, name, code }  edit this code
//   faustcode → playground   faustcode-link-code    { id, code }        compiled new code
//   playground → faustcode   faustcode-link-result  { id, ok, error? }  applied or not
//   playground → faustcode   faustcode-link-close   { id }              module removed
//
// The other way (faustcode 0.15.0, faustmodular 3.27.0) : the faustmodular
// button of the header opens the session in faustmodular, as a module of its
// open document. faustcode opens faustmodular (FAUSTMODULAR_URL, or
// ?faustmodular=<url> of this page) with ?link=faustcode in a window named
// MODULAR_WINDOW, reused :
//
//   faustmodular → faustcode   faustcode-link-hello    { libfaust? }        opened here, ready ; answered by ready
//   faustcode → faustmodular   faustcode-link-import   { ref, name, code }  add this code as a module
//   faustmodular → faustcode   faustcode-link-imported { ref, ok, id?, name?, error? }
//
// `ref` is the sha1 of the session : once imported, the session is linked to
// the module as above, and each successful save updates it. A session
// already linked is sent as its new code (faustcode-link-code) instead. When
// faustcode was opened by faustmodular, the session goes to that window.
//
// `id` designates a module of the playground. The session created for it
// is linked to the module, and so is every session saved from a linked
// session (Cmd/Ctrl-S in the dsp view or the floating editor, MCP
// submit) : sessions are keyed by the sha1 of their code, so each save
// makes a new one. Each save that compiles without error is sent to the
// playground ; a code with errors stays here.
//
// Messages are only accepted from the faustmodular window (window.opener, or
// the window opened here), and only from the origin of its first message
// (window.opener) or of its URL (opened here) ; replies go to that origin only.
//
// The pure parts (LinkTable, parseLinkMessage, sessionFilename) are
// unit-tested with node --test ; installPlaygroundLink needs a browser.

export const LINK_PROTOCOL = 1;
export const LINK_PARAM = 'link';
export const LINK_VALUES = ['modular', 'playground'];
export const SUBMITTED_EVENT = 'faustcode:submitted';
export const OPEN_IN_MODULAR_EVENT = 'faustcode:open-in-modular';
export const FAUSTMODULAR_URL = 'https://orlarey.github.io/faustmodular/';
export const FAUSTCODE_URL = 'https://orlarey.github.io/faustcode/';
export const MODULAR_PARAM = 'faustmodular';
export const MODULAR_WINDOW = 'faustmodular-faustcode';
// faustmodular loads libfaust and its documents before answering
export const HELLO_TIMEOUT_MS = 30000;

/** URL of faustmodular : ?faustmodular=<http(s) url> of the page, or FAUSTMODULAR_URL. */
export function faustmodularUrl(search, base = 'https://example.invalid/') {
  const requested = new URLSearchParams(search).get(MODULAR_PARAM);
  if (requested) {
    try {
      const url = new URL(requested, base);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {
      // default URL
    }
  }
  return FAUSTMODULAR_URL;
}

/**
 * The URL that opens a session in faustmodular : ?link=faustcode, and, when
 * this faustcode is not the official one (a local one), where it is
 * (faustmodular trusts a local faustcode only).
 */
export function modularOpenUrl(modularUrl, here) {
  const url = new URL(modularUrl);
  url.searchParams.set(LINK_PARAM, 'faustcode');
  const self = new URL(here);
  if (self.origin !== new URL(FAUSTCODE_URL).origin) url.searchParams.set('faustcode', self.origin + self.pathname);
  return url.href;
}

/** Module name of a session : its filename without .dsp. */
export function moduleName(filename) {
  return String(filename || '').replace(/\.dsp$/i, '').trim() || 'module';
}

/** True when faustcode was opened by faustmodular (?link=modular, or ?link=playground). */
export function isPlaygroundLink(search) {
  return LINK_VALUES.includes(new URLSearchParams(search).get(LINK_PARAM));
}

/**
 * Every compilation of a session (shim /api/submit and MCP submit) is
 * announced with the sha1 that was active before it and, for a save from an
 * editor, the sha1 of the session the editor showed (`edited`).
 * @param {{ sha1, previous, edited?, code, filename, errors }} detail
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
  'faustcode-link-hello': [],
  'faustcode-link-imported': ['ref'],
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
  if ((data.type === 'faustcode-link-result' || data.type === 'faustcode-link-imported') && typeof data.ok !== 'boolean') return null;
  if (data.type === 'faustcode-link-imported' && data.ok && (typeof data.id !== 'string' || typeof data.name !== 'string')) return null;
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
   * A session was saved while `previous` was active, from an editor showing
   * `edited` : when one of them is linked (the edited session first, it is
   * the one whose code was changed), the new session is linked to the same
   * module. Returns that module, or null.
   */
  follow(previous, sha1, edited = null) {
    const module = (edited ? this.get(edited) : null) || (previous ? this.get(previous) : null);
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
 * Starts the link : with the faustmodular window that opened faustcode
 * (?link=modular), and with the one faustcode opens to send it a session
 * (OPEN_IN_MODULAR_EVENT).
 * @param {{
 *   submit: (code: string, filename: string) => Promise<{ sha1: string, errors: string }>,
 *   show: (sha1: string) => Promise<void>,   // make the session visible in the dsp view
 *   notify: (message: string, durationMs?: number) => void,
 *   log?: (kind: string, ...parts: string[]) => void,
 *   libfaust?: () => string | Promise<string>,
 * }} hooks
 * @returns {LinkTable | null}
 */
export function installPlaygroundLink({ submit, show, notify, log = () => {}, libfaust }) {
  if (typeof window === 'undefined') return null;
  const table = new LinkTable();
  const opened = isPlaygroundLink(location.search) && window.opener ? window.opener : null;
  let peer = opened;     // the faustmodular window
  let origin = null;     // its origin : from its first message (opener), or of its URL (opened here)
  let ready = false;     // opened here : it said hello
  let pending = [];      // messages for it, until its hello
  let timer = null;
  let explicit = false;  // our own submit of a module's code is not a save
  const modularUrl = faustmodularUrl(location.search, location.href);
  const version = () => Promise.resolve(typeof libfaust === 'function' ? libfaust() : undefined).catch(() => undefined);

  const alive = () => peer && !peer.closed;
  const post = (message) => {
    if (!origin || !alive()) return false;
    peer.postMessage({ protocol: LINK_PROTOCOL, ...message }, origin);
    return true;
  };
  const focus = () => { try { peer.focus(); } catch { /* ignore */ } };

  window.addEventListener('message', async (event) => {
    if (!peer || event.source !== peer) return;
    const m = parseLinkMessage(event.data);
    if (!m) return;
    if (origin && event.origin !== origin) return;
    origin = event.origin;
    switch (m.type) {
      case 'faustcode-link-hello': {
        // faustmodular, opened here, is ready : our version, then the sessions sent to it
        ready = true;
        if (timer) clearTimeout(timer);
        timer = null;
        const v = await version();
        post(typeof v === 'string' ? { type: 'faustcode-link-ready', libfaust: v } : { type: 'faustcode-link-ready' });
        for (const message of pending) post(message);
        pending = [];
        log('info', `playground link : faustmodular ready at ${origin}`);
        break;
      }
      case 'faustcode-link-imported': {
        if (m.ok) {
          table.link(m.ref, { id: m.id, name: m.name });
          notify(`Opened in faustmodular : ${m.name}. Each successful save (Cmd/Ctrl-S) updates the module.`, 8000);
          log('info', `playground link : ${m.name} (${m.ref.slice(0, 8)}) imported in faustmodular`);
        } else {
          notify(`faustmodular could not add the module : ${String(m.error || '').split('\n')[0]}`, 10000);
        }
        break;
      }
      case 'faustcode-link-edit': {
        let result;
        explicit = true;
        try {
          result = await submit(m.code, sessionFilename(m.name));
        } catch (err) {
          notify(`faustmodular : ${m.name} could not be opened (${err && err.message ? err.message : err})`, 10000);
          return;
        } finally {
          explicit = false;
        }
        if (result.errors && String(result.errors).trim()) {
          // not stored : nothing to edit
          notify(`faustmodular : ${m.name} does not compile in faustcode : ${String(result.errors).split('\n')[0]}`, 10000);
          log('warn', `playground link : ${m.name} does not compile`);
          return;
        }
        table.link(result.sha1, { id: m.id, name: m.name });
        log('info', `playground link : ${m.name} (${result.sha1.slice(0, 8)}) from ${origin}`);
        await show(result.sha1);
        notify(`Linked to faustmodular : ${m.name}. Each successful save (Cmd/Ctrl-S) updates the module.`, 8000);
        try { window.focus(); } catch { /* ignore */ }
        break;
      }
      case 'faustcode-link-result': {
        const name = table.nameOf(m.id) || 'module';
        if (m.ok) notify(`faustmodular : ${name} updated`, 2000);
        else notify(`faustmodular did not apply ${name} : ${String(m.error || '').split('\n')[0]}`, 10000);
        break;
      }
      case 'faustcode-link-close': {
        const name = table.unlink(m.id);
        if (name) notify(`faustmodular : ${name} was removed, its sessions are no longer linked`, 8000);
        break;
      }
    }
  });

  document.addEventListener(SUBMITTED_EVENT, (event) => {
    if (explicit) return;
    const { sha1, previous, edited, code, errors } = event.detail || {};
    const module = table.follow(previous, sha1, edited);
    if (!module || (errors && String(errors).trim())) return;
    if (!post({ type: 'faustcode-link-code', id: module.id, code })) {
      notify('faustmodular is closed : the module was not updated', 8000);
    }
  });

  // A session opened in faustmodular : its module updated if it has one,
  // otherwise added to the open document of faustmodular (opened if needed).
  document.addEventListener(OPEN_IN_MODULAR_EVENT, (event) => {
    const { sha1, code, filename } = event.detail || {};
    if (typeof sha1 !== 'string' || typeof code !== 'string') return;
    const module = table.get(sha1);
    if (module && post({ type: 'faustcode-link-code', id: module.id, code })) {
      focus();
      return;
    }
    const message = { type: 'faustcode-link-import', ref: sha1, name: moduleName(filename), code };
    if (alive() && (peer === opened ? origin : ready)) {
      post(message);
      focus();
      return;
    }
    if (!alive() || peer === opened) {
      const url = modularOpenUrl(modularUrl, location.href);
      const w = window.open(url, MODULAR_WINDOW);
      if (!w) {
        notify('faustmodular could not be opened : allow the pop-ups of this page', 10000);
        return;
      }
      peer = w;
      origin = new URL(modularUrl).origin;
      ready = false;
      pending = [];
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!ready) notify(`faustmodular did not answer (${modularUrl}) : this version may not know the link`, 10000);
      }, HELLO_TIMEOUT_MS);
    }
    pending = pending.filter((p) => p.ref !== sha1).concat(message);
  });

  // Opened by faustmodular : it answers with the code to edit (to any
  // opener : this message carries nothing but our version of libfaust,
  // which faustmodular compares with its own).
  if (opened) {
    version().then((v) => {
      const readyMessage = { type: 'faustcode-link-ready', protocol: LINK_PROTOCOL };
      if (typeof v === 'string') readyMessage.libfaust = v;
      opened.postMessage(readyMessage, '*');
      log('info', `playground link : ready${v ? ` (libfaust ${v})` : ''}`);
    });
  }
  return table;
}
