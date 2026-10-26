// tab-handoff.test.mjs — node --test webapp/tab-handoff.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseTarget } from './tab-handoff.js';

const tab = (tabId, o = {}) => ({ tabId, audioUnlocked: false, mcpConnected: false, lastActiveAt: 0, ...o });

test('no reply → null', () => {
  assert.equal(chooseTarget([]), null);
  assert.equal(chooseTarget(undefined), null);
});

test('the MCP tab wins, even if older and locked', () => {
  const r = [tab('a', { audioUnlocked: true, lastActiveAt: 900 }), tab('mcp', { mcpConnected: true, lastActiveAt: 100 })];
  assert.equal(chooseTarget(r).tabId, 'mcp');
});

test('then the most recent tab with audio unlocked', () => {
  const r = [
    tab('locked-recent', { lastActiveAt: 999 }),
    tab('old', { audioUnlocked: true, lastActiveAt: 100 }),
    tab('recent', { audioUnlocked: true, lastActiveAt: 500 }),
  ];
  assert.equal(chooseTarget(r).tabId, 'recent');
});

test('then the most recent tab', () => {
  assert.equal(chooseTarget([tab('x', { lastActiveAt: 1 }), tab('y', { lastActiveAt: 2 })]).tabId, 'y');
});
