/** The PDF reader, against real PDF bytes read by the real pdfjs. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readPdf } from '../src/pdf.js';
import { buildDoc } from '../src/doc.js';
import { extract } from '../src/cards.js';
import { makePdf } from './pdf-fixture.js';

const glossaryPage = [
  { x: 72, y: 720, size: 18, text: 'Cell Transport' },
  { x: 72, y: 690, text: 'Osmosis' },
  { x: 240, y: 690, text: 'the movement of water across a membrane' },
  { x: 72, y: 660, text: 'Diffusion' },
  { x: 240, y: 660, text: 'movement from high to low concentration' },
];

test('groups positioned fragments back into lines, top to bottom', async () => {
  const [page] = await readPdf(makePdf([glossaryPage]));
  assert.equal(page.ref, 'page-1');
  assert.equal(page.lines.length, 2);
  assert.match(page.lines[0].text ?? page.lines[0].runs[0].text, /^Osmosis/);
});

test('the largest type at the top of a page is its heading', async () => {
  const [page] = await readPdf(makePdf([glossaryPage]));
  assert.equal(page.title, 'Cell Transport');
  const body = page.lines.map((l) => l.runs[0].text).join('\n');
  assert.ok(!body.includes('Cell Transport'), 'the heading was also emitted as a body line');
});

test('a column gutter becomes a tab, so the glossary rule reads it', async () => {
  const [page] = await readPdf(makePdf([glossaryPage]));
  assert.equal(page.lines[0].runs[0].text, 'Osmosis\tthe movement of water across a membrane');
});

test('ordinary word spacing does not become a tab', async () => {
  // Same line, consecutive words at natural spacing — the gap must stay a space or the sentence
  // would be split into a term and a definition that were never one.
  const [page] = await readPdf(makePdf([[
    { x: 72, y: 700, text: 'Water always moves' },
    { x: 175, y: 700, text: 'towards the concentrated side' },
  ]]));
  const text = page.lines[0].runs[0].text;
  assert.ok(!text.includes('\t'), text);
});

test('a two-column PDF glossary comes out as cards', async () => {
  const doc = buildDoc('handout.pdf', await readPdf(makePdf([glossaryPage])));
  const { cards } = extract(doc);
  assert.deepEqual(cards.map((c) => c.front).sort(), ['Diffusion', 'Osmosis']);
  assert.equal(cards.find((c) => c.front === 'Osmosis').back,
    'the movement of water across a membrane');
  assert.deepEqual(cards[0].tags, ['handout', 'page-1']);
});

test('every page becomes its own section', async () => {
  const pages = await readPdf(makePdf([
    [{ x: 72, y: 700, text: 'Osmosis: water movement across a membrane' }],
    [{ x: 72, y: 700, text: 'Glycolysis: the breakdown of glucose to pyruvate' }],
  ]));
  assert.deepEqual(pages.map((p) => p.ref), ['page-1', 'page-2']);
});

test('a PDF with no text layer says so instead of writing an empty deck', async () => {
  // A scanned document parses perfectly well and simply contains no text — the failure we want is a
  // clear one, not a deck of zero cards that looks like the rules did badly.
  await assert.rejects(
    () => readPdf(makePdf([[{ x: 72, y: 700, text: 'x' }]])),
    /no text layer/,
  );
});
