/**
 * The card rules.
 *
 * Weighted deliberately towards what must *not* become a card. Missing a real term costs one card;
 * inventing a fake one costs the learner a hand-edit before the deck is usable, and there is no way
 * for them to tell which cards to check without reading all of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { splitTermDef, splitBoldLead, accept, extract, guid, merge } from '../src/cards.js';
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

/* -------------------------------------------------------------------------- */
/* Merging several documents into one deck                                    */
/* -------------------------------------------------------------------------- */

/** Cards as `finalize` leaves them, which is what `merge` is handed. */
const deckOf = (slug, fronts) => ({
  slug,
  cards: fronts.map((front) => ({ front, back: 'water movement', tags: [slug], id: guid(slug, front) })),
});

test('merge: a question asked in only one file is left exactly alone', () => {
  const { cards, renamed } = merge([deckOf('lecture3', ['Osmosis']), deckOf('lecture4', ['Enzyme'])]);
  assert.deepEqual(cards.map((c) => c.front), ['Osmosis', 'Enzyme']);
  assert.equal(renamed, 0);
});

test('merge: a repeated question keeps both cards, naming the later one', () => {
  const { cards, renamed } = merge([deckOf('lecture3', ['Osmosis']), deckOf('lecture4', ['Osmosis'])]);
  assert.deepEqual(cards.map((c) => c.front), ['Osmosis', 'Osmosis (lecture4)']);
  assert.equal(renamed, 1);
});

test('merge: the first occurrence never moves, so a re-run does not renumber a learner\'s deck', () => {
  const alone = merge([deckOf('lecture3', ['Osmosis'])]).cards[0];
  const batched = merge([deckOf('lecture3', ['Osmosis']), deckOf('lecture4', ['Osmosis'])]).cards[0];
  assert.deepEqual(batched, alone);
});

test('merge: a renamed card keeps the id derived from its original question', () => {
  const { cards } = merge([deckOf('lecture3', ['Osmosis']), deckOf('lecture4', ['Osmosis'])]);
  // Adding a lecture to the command line must not hand this card someone else's progress.
  assert.equal(cards[1].id, guid('lecture4', 'Osmosis'));
});

test('merge: fronts differing only in case or spacing still count as the same question', () => {
  // `parseSet` compares raw text, but a deck asking "Osmosis" and "osmosis" is two cards for one
  // fact — the drill would treat them as unrelated and the learner would answer both.
  const { cards, renamed } = merge([deckOf('lecture3', ['Osmosis']), deckOf('lecture4', ['  osmosis'])]);
  assert.equal(renamed, 1);
  assert.equal(new Set(cards.map((c) => c.front)).size, 2);
});

test('merge: two files with the same name are separated, ids included', () => {
  // week1/lecture3.pptx and week2/lecture3.pptx share a slug, so their cards arrive with the same
  // front *and* the same guid(slug, front) — the one case where an id has to be re-derived, since
  // parseSet rejects a repeated id as flatly as a repeated question.
  const { cards, renamed } = merge([deckOf('lecture3', ['Osmosis']), deckOf('lecture3', ['Osmosis'])]);
  assert.equal(renamed, 1);
  assert.deepEqual(cards.map((c) => c.front), ['Osmosis', 'Osmosis (lecture3)']);
  assert.equal(new Set(cards.map((c) => c.id)).size, 2, 'both cards kept the same id');
});

test('merge: a third file of the same name falls back to a counter', () => {
  // "(lecture3)" is itself taken by then, so the slug alone can no longer settle it.
  const { cards } = merge([
    deckOf('lecture3', ['Osmosis']), deckOf('lecture3', ['Osmosis']), deckOf('lecture3', ['Osmosis']),
  ]);
  assert.deepEqual(cards.map((c) => c.front),
    ['Osmosis', 'Osmosis (lecture3)', 'Osmosis (lecture3) 2']);
  assert.equal(new Set(cards.map((c) => c.id)).size, 3);
});

test('merge: a question repeated across three files gets three distinct cards', () => {
  const { cards } = merge([
    deckOf('wk1', ['Osmosis']), deckOf('wk2', ['Osmosis']), deckOf('wk3', ['Osmosis']),
  ]);
  assert.deepEqual(cards.map((c) => c.front), ['Osmosis', 'Osmosis (wk2)', 'Osmosis (wk3)']);
  assert.equal(new Set(cards.map((c) => c.id)).size, 3);
});
