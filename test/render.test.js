/** Slide rendering, against a real PDF drawn by the real pdfjs onto a real canvas. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderSlides, pageCount, SLIDE_WIDTH } from '../src/render.js';
import { makePdf } from './pdf-fixture.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const width = (png) => png.readUInt32BE(16);

const pdf = makePdf([
  [{ x: 72, y: 700, size: 24, text: 'Slide one' }],
  [{ x: 72, y: 700, size: 24, text: 'Slide two' }, { x: 200, y: 400, size: 30, text: 'E = mc2' }],
]);

test('render: counts pages without drawing them', async () => {
  assert.equal(await pageCount(pdf), 2);
});

test('render: one PNG per slide at slide width, and a crop per boxed equation', async () => {
  const slides = [
    { number: 1, visuals: {} },
    { number: 2, visuals: { equations: [{ box: { x: 0.3, y: 0.45, w: 0.3, h: 0.08 } }, { box: null }] } },
  ];
  const out = [];
  for await (const r of renderSlides(pdf, slides)) out.push(r);

  assert.deepEqual(out.map((r) => r.number), [1, 2]);
  for (const r of out) {
    assert.deepEqual(r.png.subarray(0, 4), PNG);
    assert.equal(width(r.png), SLIDE_WIDTH);
  }
  assert.equal(out[0].equations.length, 0);
  assert.equal(out[1].equations.length, 2);
  assert.deepEqual(out[1].equations[0].subarray(0, 4), PNG);
  assert.ok(width(out[1].equations[0]) > SLIDE_WIDTH * 0.3, 'a crop should be sharper than the slide it came from');
  assert.equal(out[1].equations[1], null, 'an equation without a box has no crop, rather than a wrong one');
});

test('render: asking for a slide the PDF does not have is an error, not a blank image', async () => {
  const run = async () => {
    for await (const _ of renderSlides(pdf, [{ number: 3, visuals: {} }])) { /* drain */ }
  };
  await assert.rejects(run, /no page 3/);
});
