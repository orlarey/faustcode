// drafts.test.mjs — node --test webapp/drafts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDraft } from './drafts.js';
import { bus } from './editor-sync.js';

// Minimal stand-in for a CodeMirror editor registered on the bus.
function fakeEditor() {
  return {
    buffer: null,
    pristine: null,
    _setBuffer(buffer, pristine) { this.buffer = buffer; this.pristine = pristine; },
    _setBufferAndPristine(text) { this.buffer = text; this.pristine = text; },
    _onPristineChange(p) { this.pristine = p; },
    _applyRemoteChanges() {},
  };
}

test('an edit becomes the session draft and is restored when the session is loaded again', () => {
  const ed = fakeEditor();
  bus.register(ed);
  bus.loadSession('process = 0;', 'shaA');
  assert.equal(ed.buffer, 'process = 0;');
  bus.noteEdit('process = 1;');
  assert.equal(getDraft('shaA'), 'process = 1;');

  bus.loadSession('process = _;', 'shaB'); // another session
  assert.equal(ed.buffer, 'process = _;');
  bus.loadSession('process = 0;', 'shaA'); // back : the draft is shown, unsaved
  assert.equal(ed.buffer, 'process = 1;');
  assert.equal(ed.pristine, 'process = 0;');
  assert.equal(bus.currentBuffer(), 'process = 1;');
  bus.unregister(ed);
});

test('editing back to the stored code drops the draft', () => {
  bus.loadSession('a = 1;', 'shaC');
  bus.noteEdit('a = 2;');
  assert.equal(getDraft('shaC'), 'a = 2;');
  bus.noteEdit('a = 1;');
  assert.equal(getDraft('shaC'), null);
});

test('a submitted draft is dropped even if the active session already changed', () => {
  bus.loadSession('b = 1;', 'shaD');
  bus.noteEdit('b = 2;');
  bus.loadSession('b = 2;', 'shaE'); // the submit made a new session active
  bus.markSubmitted('b = 2;');
  assert.equal(getDraft('shaD'), null);
});

test('loadSession without sha keeps the loaded session', () => {
  bus.loadSession('c = 1;', 'shaF');
  bus.noteEdit('c = 9;');
  const ed = fakeEditor();
  bus.register(ed);
  bus.loadSession('c = 1;'); // e.g. the floating editor's setCode
  assert.equal(ed.buffer, 'c = 9;');
  bus.unregister(ed);
});
