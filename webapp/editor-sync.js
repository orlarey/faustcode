// editor-sync.js — live mirror bus between Faust CodeMirror editors.
//
// When several editors are live at the same time (the DSP view, the
// floating overlay…), they all edit the same logical session. This bus
// keeps them in agreement :
//
//   - Live mirroring : every keystroke change in one editor is
//     replayed in all the others as a CodeMirror transaction, so they
//     show identical content character by character.
//   - Shared pristine : the "last submitted" snapshot is held here ;
//     all registered editors compute their dirty state against it.
//     A successful submit from any editor updates the shared pristine
//     so the others go clean.
//   - Session load : when the active session changes (navigation,
//     MCP push, fresh boot…), the bus replaces every editor's buffer
//     with the new code and resets pristine — unless that session has
//     an unsaved draft (drafts.js), which is restored instead (dirty).
//   - Drafts : every local edit is recorded as the draft of the current
//     session, so leaving the DSP view or the session no longer loses
//     unsubmitted text.
//
// The bus is exposed on window.__faustEditorBus so the shared editor
// factory (public/vendor/codemirror/faust-editor.js) can opt into it
// without a hard import dependency (the Docker version of the app
// doesn't load this module).

import { getDraft, setDraft, clearDraft, clearDraftsWithCode } from './drafts.js';

class FaustEditorBus {
  constructor() {
    this._editors = new Set();
    this._pristine = '';
    this._sha = null; // session whose code is loaded (drafts are keyed by it)
  }

  /** Current pristine (last submitted) code. */
  getPristine() {
    return this._pristine;
  }

  /**
   * Load a session : `code` (its stored version) becomes the pristine ;
   * every editor shows the session's unsaved draft if any, else `code`.
   * Called on session navigation and when the DSP view mounts. `sha`
   * defaults to the session already loaded.
   */
  loadSession(code, sha = this._sha) {
    const text = typeof code === 'string' ? code : '';
    this._pristine = text;
    this._sha = sha || null;
    const buffer = this.currentBuffer();
    for (const ed of this._editors) {
      ed._setBuffer(buffer, text);
    }
  }

  /** Text an editor should show for the loaded session : draft or stored code. */
  currentBuffer() {
    const draft = getDraft(this._sha);
    return draft !== null ? draft : this._pristine;
  }

  /** Record a local edit as the loaded session's draft. */
  noteEdit(text) {
    if (!this._sha) return;
    if (text === this._pristine) clearDraft(this._sha);
    else setDraft(this._sha, text);
  }

  /**
   * Mark the current buffer as the new pristine (no buffer change).
   * Called by an editor after a successful submit ; all editors then
   * recompute dirty against the new pristine.
   */
  markSubmitted(code) {
    const text = typeof code === 'string' ? code : '';
    this._pristine = text;
    // The submitted text is stored now ; its draft — under the previous
    // session, the active one may already have changed — is obsolete.
    clearDraftsWithCode(text);
    for (const ed of this._editors) {
      ed._onPristineChange(text);
    }
  }

  /** Add an editor to the live mirror. */
  register(editor) {
    this._editors.add(editor);
    // The editor already inherited pristine via its initial doc ;
    // push it again just to keep things consistent.
    editor._onPristineChange(this._pristine);
  }

  unregister(editor) {
    this._editors.delete(editor);
  }

  /**
   * Replay a local keystroke change (a CodeMirror ChangeSet) into all
   * other editors. Each target editor suppresses its own update
   * listener while applying the change to avoid the broadcast loop.
   */
  broadcastChanges(source, changes) {
    for (const ed of this._editors) {
      if (ed === source) continue;
      try {
        ed._applyRemoteChanges(changes);
      } catch (err) {
        // If positions become inconsistent (shouldn't happen with
        // live mirroring, but be defensive), fall back to a full
        // wholesale copy from the source's current buffer.
        console.warn('[editor-sync] change replay failed, falling back to full sync :', err);
        try {
          ed._setBufferAndPristine(source.view.state.doc.toString());
        } catch {}
      }
    }
  }
}

export const bus = new FaustEditorBus();

if (typeof window !== 'undefined') {
  window.__faustEditorBus = bus;
}
