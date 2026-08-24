/**
 * The output file, checked against the thing that has to read it.
 *
 * The invariants below are not our preferences — they are QuickMathPlus's parser rejecting rather
 * than repairing. A duplicate front, an empty back or a stray `;` does not degrade the import, it
 * fails the whole file. So the last test feeds our output through that parser directly, which is the
 * only check that stays true when the other repository changes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { toAnki, toQuizlet, toJson, render } from '../src/write.js';
import { extract } from '../src/cards.js';
import { buildDoc } from '../src/doc.js';

const deck = () => {
  const doc = buildDoc('lecture3.pptx', [{
    title: 'Cells',
    ref: 'slide-1',
    notes: '',
    lines: [
      'Osmosis — the movement of water across a membrane',
      'Diffusion: movement from high to low concentration',
      'Turgor\tthe pressure of water against a cell wall',
    ].map((text) => ({ runs: [{ text, bold: false }] })),
  }]);
  return { source: doc.source, slug: doc.slug, cards: extract(doc).cards };
};

test('the anki header is what QuickMathPlus expects', () => {
  const lines = toAnki(deck()).split('\n');
  assert.deepEqual(lines.slice(0, 5), [
    '#separator:Tab',
    '#html:false',
    '#columns:guid\tfront\tback\ttags',
    '#guid column:1',
    '#tags column:4',
  ]);
});

test('every row has the four declared columns', () => {
  const rows = toAnki(deck()).trim().split('\n').filter((l) => !l.startsWith('#'));
  assert.ok(rows.length >= 3);
  for (const row of rows) assert.equal(row.split('\t').length, 4, row);
});

test('the quizlet variant carries no directives', () => {
  const text = toQuizlet(deck());
  assert.ok(!text.includes('#'), 'a # line would import as a card of its own');
  for (const row of text.trim().split('\n')) assert.equal(row.split('\t').length, 2, row);
});

test('a tab inside a field is quoted, not left to shift the columns', () => {
  const text = toAnki({ cards: [{ id: 'x', front: 'A\tB', back: 'c', tags: [] }] });
  const row = text.trim().split('\n').at(-1);
  assert.ok(row.includes('"A\tB"'), row);
  assert.equal(row.split('\t').length, 4, 'the embedded tab broke the row into five fields');
});

test('json round-trips', () => {
  const parsed = JSON.parse(toJson(deck()));
  assert.equal(parsed.source, 'lecture3.pptx');
  assert.equal(parsed.cards.length, deck().cards.length);
});

test('an unknown format is refused rather than guessed at', () => {
  assert.throws(() => render(deck(), 'apkg'), /unknown format/);
});

/**
 * The real check: our file, their parser.
 *
 * Skipped rather than failed when the sibling repository is not checked out, so the suite still runs
 * for anyone who only cloned this one.
 */
test('QuickMathPlus imports the deck we write', async (t) => {
  const url = new URL('../../QuickMathPlus/www/src/cards.js', import.meta.url);
  if (!existsSync(fileURLToPath(url))) return t.skip('QuickMathPlus is not checked out beside this repo');

  // Imported by URL, not by path: on Windows a bare "E:\..." is not a scheme the ESM loader accepts.
  const { parseSet } = await import(url.href);
  const set = parseSet(toAnki(deck()), { name: 'lecture3.txt' });

  assert.equal(set.cards.length, deck().cards.length);
  assert.deepEqual(set.cards.map((c) => c.id), deck().cards.map((c) => c.id),
    'our guids must survive the round trip, or re-importing loses the learner\'s progress');
  assert.deepEqual(set.cards[0].tags, ['lecture3', 'slide-1']);
  for (const card of set.cards) {
    assert.ok(card.front && card.back, 'parseSet rejects an empty side outright');
  }
});
