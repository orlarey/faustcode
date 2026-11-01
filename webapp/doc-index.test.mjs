// The index of the documentation of the Faust libraries (webapp/faust-doc-index.json) is built by
// scripts/build-doc-index.mjs from the libraries faustcode embeds: it must stay up to date with them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildIndex, parseLibrary, signalsOf, environments } from '../scripts/build-doc-index.mjs';

const LIB = `
//-------\`(xx.)lowpass\`----------
// Nth-order lowpass filter.
//
// Second paragraph.
//
// #### Usage
//
// \`\`\`
// lowpass(N,fc)
// _ : lowpass(N,fc) : _ // a comment
// \`\`\`
//
// Where:
//
// * \`N\`: filter order, which
//   continues here
// * \`fc\`: cutoff frequency
//    - fc > 0: a sub-item of fc
//
// #### Test
// \`\`\`
// xx = library("x.lib");
// lowpass_test = xx.lowpass(2, 1000);
// \`\`\`
//---------------------------------
lowpass(N,fc) = _;

//---------------\`(xx.)if\`-------------- ----
// if-then-else.
//
// #### Usage
//
// *   \`if(cond, then, else) : _\`
//----------------------------
if(c,t,e) = select2(c,e,t);
`;

test('parses a documentation block: summary, usage, parameters, test, source', () => {
  const [lowpass, iff] = parseLibrary('x.lib', LIB, 'xx');
  assert.deepEqual(lowpass, {
    id: 'x.lowpass', name: 'lowpass', qualifiedName: 'xx.lowpass', header: '(xx.)lowpass',
    summary: 'Nth-order lowpass filter. Second paragraph.',
    usage: '_ : lowpass(N,fc) : _ // a comment',
    params: [
      { name: 'N', description: 'filter order, which continues here' },
      { name: 'fc', description: 'cutoff frequency - fc > 0: a sub-item of fc' },
    ],
    io: { inSignals: 1, outSignals: 1, raw: '_ : lowpass(N,fc) : _ // a comment' },
    testCode: 'xx = library("x.lib");\nlowpass_test = xx.lowpass(2, 1000);',
    tags: ['x'],
    source: { file: 'x.lib', lineStart: 2, lineEnd: 26 },
  });
  assert.equal(iff.usage, 'if(cond, then, else) : _');
  assert.deepEqual(iff.io, { inSignals: 0, outSignals: 1, raw: 'if(cond, then, else) : _' });
});

test('reads inputs and outputs from a usage', () => {
  assert.deepEqual(signalsOf('_,_ : f(a, b) : _', 'f').inSignals, 2);
  assert.deepEqual(signalsOf('si.bus(4) : f : _,_', 'f'), { inSignals: null, outSignals: 2, raw: 'si.bus(4) : f : _,_' });
  assert.deepEqual(signalsOf('_ <: f(x) :> _', 'f').inSignals, null);
});

test('lists the libraries of stdfaust.lib in order, with their environment', () => {
  assert.deepEqual(environments('aa = library("aanl.lib");\nba = library("basics.lib");'), [{ alias: 'aa', file: 'aanl.lib' }, { alias: 'ba', file: 'basics.lib' }]);
  const index = buildIndex(new Map([['stdfaust.lib', 'xx = library("x.lib");'], ['x.lib', LIB]]), 'now');
  assert.deepEqual(index.libraries.map((l) => [l.file, l.aliasHints, l.symbols.length]), [['stdfaust.lib', [], 0], ['x.lib', ['xx'], 2]]);
  assert.equal(index.symbols.length, 2);
});

test('the committed index is up to date with the embedded libraries (node scripts/build-doc-index.mjs)', async () => {
  const { embeddedIndex } = await import('../scripts/build-doc-index.mjs');
  const fresh = await embeddedIndex();
  const committed = JSON.parse(readFileSync(new URL('./faust-doc-index.json', import.meta.url), 'utf8'));
  delete fresh.generatedAt;
  delete committed.generatedAt;
  assert.deepEqual(committed, fresh);
});
