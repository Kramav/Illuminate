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

const realFetch = globalThis.fetch;

/**
 * Stand in for a local model server.
 *
 * `expand` reaches Ollama and LM Studio through global `fetch` and nothing else, so replacing it
 * tests everything between the reply and the deck — the reference check, the batching, the retry —
 * without a model, a server, or a network. Returns the prompts it was sent, in order, which is what
 * the batching assertions are about.
 */
function stubProvider(t, replies) {
  const prompts = [];
  let n = 0;
  globalThis.fetch = async (url, opts) => {
    prompts.push(JSON.parse(opts.body).messages[1].content);
    const content = replies[Math.min(n++, replies.length - 1)];
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return prompts;
}

const passage = (ref, title, text) => ({ ref, title, text });
const prose = (n) => Array.from({ length: n },
  (_, i) => `Osmosis is the passive movement of water across a membrane, line ${i}.`).join('\n');

const ask = (residue, options = {}) => expand(residue, {
  provider: 'lmstudio',
  model: 'test-model',
  refs: new Set(residue.map((r) => r.ref)),
  ...options,
});

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

test('a reply becomes cards, and a section the model invented is dropped', async (t) => {
  stubProvider(t, ['{"cards":['
    + '{"ref":"slide-1","front":"Osmosis","back":"water crossing a membrane"},'
    + '{"ref":"slide-9","front":"Ghost","back":"from a slide that was never read"}]}']);

  const out = await ask([passage('slide-1', 'Cells', prose(4))]);

  // The second card names a ref that was not in this document — tagging it would file the card
  // against a slide the model never saw.
  assert.deepEqual(out, [{ ref: 'slide-1', front: 'Osmosis', back: 'water crossing a membrane' }]);
});

test('a passage too short to hold a fact costs no request at all', async (t) => {
  const prompts = stubProvider(t, ['{"cards":[]}']);

  assert.deepEqual(await ask([passage('slide-1', '', 'Too short.')]), []);
  assert.equal(prompts.length, 0);
});

test('passages are batched into request-sized prompts, not sent one at a time', async (t) => {
  const prompts = stubProvider(t, ['{"cards":[]}']);
  const many = Array.from({ length: 12 }, (_, i) => passage(`slide-${i}`, '', prose(8)));

  await ask(many);

  assert.ok(prompts.length < many.length, `sent ${prompts.length} requests for 12 passages`);
  for (const p of prompts) assert.ok(p.length <= 4000, `a prompt was ${p.length} characters`);
});

test('one long passage is split, so no prompt runs past the request size', async (t) => {
  // The failure this catches: `chunk` used to batch between passages but never within one, so a
  // .docx with no headings — one section holding the whole document — became a single prompt of
  // whatever size the handout happened to be. Reproduced at 7,700 characters against CHUNK's 3,500.
  const prompts = stubProvider(t, ['{"cards":[]}']);

  await ask([passage('sec-1', 'Handout', prose(120))]);

  assert.ok(prompts.length > 1, 'a passage past the request size must be split, not sent whole');
  for (const p of prompts) {
    assert.ok(p.length <= 4000, `a prompt was ${p.length} characters`);
    // Every piece keeps the label, or cards made from the tail lose their section.
    assert.match(p, /^\[sec-1\] Handout\n/);
  }
});

test('a first reply that is prose costs exactly one retry, and the retry lands', async (t) => {
  const prompts = stubProvider(t, [
    'I could not find any flashcards in that text.',
    '{"cards":[{"ref":"slide-1","front":"Osmosis","back":"water crossing a membrane"}]}',
  ]);

  const out = await ask([passage('slide-1', 'Cells', prose(4))]);

  assert.equal(prompts.length, 2, 'one retry, not none and not a loop');
  assert.match(prompts[1], /JSON only/);
  assert.deepEqual(out.map((c) => c.front), ['Osmosis']);
});
