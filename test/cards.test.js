/**
 * The card rules.
 *
 * Weighted deliberately towards what must *not* become a card. Missing a real term costs one card;
 * inventing a fake one costs the learner a hand-edit before the deck is usable, and there is no way
 * for them to tell which cards to check without reading all of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitTermDef, splitBoldLead, accept, extract, guid } from '../src/cards.js';
import { buildDoc } from '../src/doc.js';

const docOf = (lines, ref = 'slide-1') => buildDoc('lecture3.pptx', [{
  title: 'Cells',
  ref,
  notes: '',
  lines: lines.map((l) => (typeof l === 'string'
    ? { runs: [{ text: l, bold: false }] }
    : { runs: l })),
}]);

const frontsOf = (lines) => extract(docOf(lines)).cards.map((c) => c.front);

test('splits a term from its definition', () => {
  assert.deepEqual(splitTermDef('Osmosis — the movement of water across a membrane'),
    { front: 'Osmosis', back: 'the movement of water across a membrane' });
  assert.deepEqual(splitTermDef('Glycolysis: the breakdown of glucose'),
    { front: 'Glycolysis', back: 'the breakdown of glucose' });
  assert.deepEqual(splitTermDef('Mitosis - cell division'),
    { front: 'Mitosis', back: 'cell division' });
  assert.deepEqual(splitTermDef('Osmosis\tmovement of water'),
    { front: 'Osmosis', back: 'movement of water' });
});

test('refuses labels that merely look like terms', () => {
  // The case the whole guard exists for.
  assert.equal(splitTermDef('Note: see chapter 4'), null);
  assert.equal(splitTermDef('Example: a hypertonic solution'), null);
  assert.equal(splitTermDef('Chapter 4 — enzymes'), null);
  assert.equal(splitTermDef('Step 2: add the reagent'), null);
  assert.equal(splitTermDef('Q3: 14% of respondents'), null);
  assert.equal(splitTermDef('Today: enzymes and catalysis'), null);
});

test('refuses prose that happens to contain a dash', () => {
  assert.equal(
    splitTermDef('The mitochondrion is the powerhouse of the cell — everybody knows this'),
    null,
  );
  assert.equal(splitTermDef('Read this first: it explains the rest of the deck properly'), null);
  assert.equal(splitTermDef('See https://example.com — the reference site'), null);
});

test('a bold lead-in is the term', () => {
  assert.deepEqual(
    splitBoldLead({ runs: [{ text: 'Osmosis', bold: true }, { text: ' water movement', bold: false }] }),
    { front: 'Osmosis', back: 'water movement' },
  );
  assert.deepEqual(
    splitBoldLead({ runs: [{ text: 'Enzyme: ', bold: true }, { text: 'a catalyst', bold: false }] }),
    { front: 'Enzyme', back: 'a catalyst' },
  );
  // A line that is bold all the way through is a sub-heading, not a card.
  assert.equal(splitBoldLead({ runs: [{ text: 'Key terms', bold: true }] }), null);
});

test('a question line is answered by the line under it', () => {
  const cards = extract(docOf([
    'What does the mitochondrion do?',
    'It produces ATP for the cell',
    'Unrelated closing line',
  ])).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].front, 'What does the mitochondrion do?');
  assert.equal(cards[0].back, 'It produces ATP for the cell');
});

test('the answer line is consumed, not reused as a term', () => {
  const fronts = frontsOf([
    'What is osmosis?',
    'Diffusion: the movement of water',
  ]);
  assert.deepEqual(fronts, ['What is osmosis?']);
});

test('rejects answers too long to be answers, and questions that ask nothing', () => {
  assert.equal(accept({ front: 'Osmosis', back: 'x'.repeat(400) }), false);
  assert.equal(accept({ front: 'Agenda', back: 'the plan for today' }), false);
  assert.equal(accept({ front: 'Thank you!', back: 'see you next week' }), false);
  assert.equal(accept({ front: '42', back: 'the answer' }), false);
  assert.equal(accept({ front: 'Osmosis', back: 'osmosis' }), false);
  assert.equal(accept({ front: 'Osmosis', back: 'water movement' }), true);
});

test('semicolons in an answer become commas', () => {
  // A study app reads `;` as "or this instead", so leaving it in would split one definition into
  // several answers, all but one of them wrong.
  const [card] = extract(docOf(['Osmosis — water moves in; solute does not'])).cards;
  assert.equal(card.back, 'water moves in, solute does not');
});

test('the same question twice keeps the fuller answer', () => {
  const cards = extract(docOf([
    'Osmosis — water movement',
    'Osmosis — the movement of water across a selectively permeable membrane',
  ])).cards;
  assert.equal(cards.length, 1);
  assert.match(cards[0].back, /selectively permeable/);
});

test('ids are stable across runs and specific to the question', () => {
  assert.equal(guid('lecture3', 'Osmosis'), guid('lecture3', 'Osmosis'));
  assert.notEqual(guid('lecture3', 'Osmosis'), guid('lecture3', 'Diffusion'));
  assert.notEqual(guid('lecture3', 'Osmosis'), guid('lecture4', 'Osmosis'));
});

test('cards carry their source and section as tags', () => {
  const [card] = extract(docOf(['Osmosis — water movement'], 'slide-7'), { tag: 'bio101' }).cards;
  assert.deepEqual(card.tags, ['lecture3', 'slide-7', 'bio101']);
  assert.ok(card.tags.every((t) => !/\s/.test(t)), 'a tag with a space in it becomes two tags');
});

test('what no rule could read is kept as residue rather than forced into a card', () => {
  const { cards, residue } = extract(docOf([
    'Osmosis — water movement',
    'Water always moves towards the more concentrated solution, which is why cells burst.',
  ]));
  assert.equal(cards.length, 1);
  assert.equal(residue.length, 1);
  assert.match(residue[0].text, /which is why cells burst/);
});
