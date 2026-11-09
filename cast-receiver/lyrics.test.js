// Run: node --test cast-receiver/lyrics.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createAssembler, activeIndex, segments, fills, claim } = require('./lyrics.js');

test('joins parts, ignores an older seq', () => {
  const add = createAssembler();
  const json = JSON.stringify({ rows: [{ text: 'a' }], offset: 0 });
  assert.equal(add({ seq: 2, part: 1, parts: 2, data: json.slice(10) }), null);
  assert.equal(add({ seq: 1, part: 0, parts: 1, data: json }), null);
  const doc = add({ seq: 2, part: 0, parts: 2, data: json.slice(0, 10) });
  assert.equal(doc.rows[0].text, 'a');
});

test('active line, byte-cut words and fills', () => {
  const rows = [{ start: 0 }, { start: 1000 }];
  assert.equal(activeIndex(rows, 500, 0), 0);
  assert.equal(activeIndex(rows, 500, 600), 1);
  assert.equal(activeIndex([{ start: 0 }, {}], 5, 0), -1);
  const seg = segments('é bc', [{ byteStart: 0, byteEnd: 2 }, { byteStart: 3, byteEnd: 5 }]);
  assert.deepEqual(seg.map((s) => s.text), ['é', ' ', 'bc']);
  assert.deepEqual(fills([{ start: 0, end: 100 }, { start: 200, end: 300 }], 50, 0), [50, 0]);
});

test('the latest sender to connect owns the lyrics', () => {
  const state = { sender: null };
  assert.equal(claim(state, 'a'), false);
  assert.equal(claim(state, 'a'), false);
  assert.equal(claim(state, 'b'), true);
  assert.equal(state.sender, 'b');
});
