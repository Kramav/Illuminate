/**
 * The language-model pass, tested where it is testable: everything around the request.
 *
 * A model's answers cannot be asserted on, but every failure mode this code exists to survive can
 * be — a fenced reply, a preamble, invented section references, restating a card the rules already
 * made. Those are the parts that decide whether a bad response costs a card or the whole deck.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCards, withoutDuplicates, expand, PROVIDERS } from '../src/llm.js';

test('reads a plain JSON reply', () => {
  assert.deepEqual(parseCards('{"cards":[{"ref":"slide-1","front":"A","back":"B"}]}'),
    [{ ref: 'slide-1', front: 'A', back: 'B' }]);
});

test('reads a reply the model wrapped in a code fence', () => {
  const reply = 'Sure! Here are the cards:\n```json\n{"cards":[{"ref":"p-1","front":"A","back":"B"}]}\n```';
  assert.deepEqual(parseCards(reply), [{ ref: 'p-1', front: 'A', back: 'B' }]);
});

test('reads a reply with a preamble and no fence', () => {
  assert.deepEqual(parseCards('Certainly. {"cards":[{"ref":"p-1","front":"A","back":"B"}]} Hope that helps!'),
    [{ ref: 'p-1', front: 'A', back: 'B' }]);
});

test('an empty result is a valid answer, not a failure', () => {
  assert.deepEqual(parseCards('{"cards":[]}'), []);
});

test('unparseable or wrong-shaped replies come back null, not thrown', () => {
  assert.equal(parseCards('I could not find any flashcards in that text.'), null);
  assert.equal(parseCards('{"cards": "lots"}'), null);
  assert.equal(parseCards('{"cards":[{"front":"A"'), null);
  assert.equal(parseCards(''), null);
});

test('the model does not get to restate a card the rules already made', () => {
  const existing = [{ front: 'Osmosis', back: 'water movement' }];
  const items = [
    { ref: 'slide-1', front: 'osmosis', back: 'the movement of water' }, // same question, recased
    { ref: 'slide-1', front: 'Turgor', back: 'pressure against a cell wall' },
    { ref: 'slide-2', front: 'Turgor', back: 'said twice by the model' },
  ];
  assert.deepEqual(withoutDuplicates(items, existing).map((i) => i.front), ['Turgor']);
});

test('provider none does no work at all', async () => {
  const residue = [{ ref: 'slide-1', title: '', text: 'x'.repeat(200) }];
  assert.deepEqual(await expand(residue, { provider: 'none', refs: new Set(['slide-1']) }), []);
});

test('a provider that is not running loses its passage, not the run', async () => {
  // The rule-made cards are already in hand by this point; a dead local server must not take them
  // down with it.
  const residue = [{ ref: 'slide-1', title: 'Cells', text: 'Water moves towards solute. '.repeat(6) }];
  const messages = [];
  const out = await expand(residue, {
    provider: 'lmstudio',
    model: 'nothing-is-listening',
    refs: new Set(['slide-1']),
    onProgress: (m) => messages.push(m),
  });
  assert.deepEqual(out, []);
  assert.ok(messages.some((m) => /lmstudio/.test(m)), messages.join('\n'));
});

test('the provider list is what the CLI advertises', () => {
  assert.deepEqual(PROVIDERS, ['none', 'ollama', 'lmstudio', 'claude']);
});
