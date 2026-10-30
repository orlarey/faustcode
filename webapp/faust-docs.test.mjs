// faust-docs.test.mjs — node --test webapp/faust-docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  expandName,
  parseDocBlocks,
  parseLibraryRefs,
  collectDocs,
  docSummary,
  compactDoc,
  resolveDottedName,
  markdownToHtml,
} from './faust-docs.js';

const OSC_LIB = `//############ oscillators.lib ############
// A library of oscillators.
//##########################################
ba = library("basics.lib");

//-----------------------\`(os.)osc\`------------------------
// Default sine wave oscillator.
//
// #### Usage
//
// \`\`\`
// osc(freq) : _
// \`\`\`
//
// Where:
//
// * \`freq\`: the frequency in Hz
//-----------------------------------------------------------
osc(f) = sin(2*ma.PI*phasor(f));

//---\`(an.)octave_analyzer\`, \`(an.)third_octave_analyzer\`---
// Octave analyzers.
//------------------------------------------------------------
`;

const STD = `// stdfaust.lib
os = library("oscillators.lib");
// not = library("commented.lib");
import("extra.lib");
`;

test('expandName : optional and alternative parts', () => {
  assert.deepEqual(expandName('osc'), ['osc']);
  assert.deepEqual(expandName('lowpass[3]'), ['lowpass', 'lowpass3']);
  assert.deepEqual(expandName('[third|half]_octave'), ['third_octave', 'half_octave']);
});

test('parseDocBlocks : names, doc text, multi-name headers', () => {
  const blocks = parseDocBlocks(OSC_LIB);
  assert.deepEqual(blocks.map((b) => b.name), ['osc', 'octave_analyzer', 'third_octave_analyzer']);
  const osc = blocks[0];
  assert.match(osc.doc, /^Default sine wave oscillator\./);
  assert.match(osc.doc, /```\nosc\(freq\) : _\n```/);
  assert.match(osc.doc, /\* `freq`: the frequency in Hz$/);
  assert.equal(blocks[2].doc, 'Octave analyzers.');
});

test('parseLibraryRefs ignores commented code', () => {
  assert.deepEqual(parseLibraryRefs(STD), {
    libraries: [{ namespace: 'os', file: 'oscillators.lib' }],
    imports: ['extra.lib'],
  });
});

test('collectDocs : namespaces from library(), import() keeps the prefix, depth 2', async () => {
  const files = {
    'stdfaust.lib': STD,
    'oscillators.lib': OSC_LIB,
    'extra.lib': '//------`top`------\n// Top level.\n//------------\n',
    'basics.lib': '//------`time`------\n// Counter.\n//------------\n',
  };
  const docs = await collectDocs(async (f) => files[f] ?? null);
  assert.deepEqual([...docs.keys()].sort(), ['os.octave_analyzer', 'os.osc', 'os.third_octave_analyzer', 'top']);
  assert.equal(docs.get('os.osc').file, 'oscillators.lib');
  // basics.lib is a library of oscillators.lib : beyond depth 2, not followed.
  assert.ok(!docs.has('os.ba.time'));
});

test('docSummary skips headings and fences', () => {
  assert.equal(docSummary('#### Usage\n```\nx\n```\nThe `real` summary.'), 'The real summary.');
});

test('resolveDottedName : longest documented suffix around the cursor', () => {
  const has = (k) => ['os.osc', 'osc', 'hslider'].includes(k);
  assert.deepEqual(resolveDottedName('process = os.osc(440);', 13, has), { key: 'os.osc', from: 10, to: 16 });
  assert.deepEqual(resolveDottedName('x = foo.osc;', 9, has), { key: 'osc', from: 8, to: 11 });
  assert.equal(resolveDottedName('x = foo;', 5, has), null);
});

test('markdownToHtml escapes and renders the doc subset', () => {
  const html = markdownToHtml('A <b>tag</b> and `code`.\n\n#### Usage\n```\na < b\n```\n* `freq`: Hz\n[link](#x)');
  assert.ok(html.includes('&lt;b&gt;tag&lt;/b&gt;'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<div class="cm-faust-doc-h">Usage</div>'));
  assert.ok(html.includes('<pre>a &lt; b</pre>'));
  assert.ok(html.includes('<li><code>freq</code>: Hz</li>'));
  assert.ok(html.includes('<p>link</p>'));
});

test('compactDoc keeps the summary and the Usage section only', () => {
  const doc = 'Sine oscillator.\n\n#### Usage\n\n```\n# not a heading\nosc(f) : _\n```\n\nWhere:\n\n* `f`: Hz\n\n#### Test\n```\nx = osc(1);\n```\n#### References\n* somewhere';
  assert.equal(compactDoc(doc), 'Sine oscillator.\n\n#### Usage\n\n```\n# not a heading\nosc(f) : _\n```\n\nWhere:\n\n* `f`: Hz');
  assert.equal(compactDoc('Just a summary.'), 'Just a summary.');
});
