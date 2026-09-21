/**
 * Checking cards against their source.
 *
 * Grounding is deterministic, so it is tested on the exact phrasings it has to tell apart: a model's
 * paraphrase of the passage against a model's addition to it. Review's answers come from a model and
 * cannot be asserted on, so it is tested the way llm.test.js tests the model pass — on everything
 * around the request: what is asked, how a reply is read, and what a bad reply is allowed to cost.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { grounding, keepGrounded, review, stem } from '../src/verify.js';
import { buildDoc } from '../src/doc.js';

const PASSAGE = 'Osmosis is the movement of water across a selectively permeable membrane. It was first '
  + 'described in 1748. Diffusion moves solutes from high to low concentration.';

const doc = buildDoc('lecture3.pptx', [
  { title: 'Cell Transport', ref: 'slide-1', notes: '', lines: [{ runs: [{ text: PASSAGE, bold: false }] }] },
  { title: 'Enzymes', ref: 'slide-2', notes: '',
    lines: [{ runs: [{ text: 'A catalyst speeds a reaction up without being used up.', bold: false }] }] },
]);

test('stem: the forms of a word meet, and short stems stay whole', () => {
  for (const w of ['moves', 'moved', 'moving', 'movement']) assert.equal(stem(w), 'mov', w);
  assert.equal(stem('cells'), 'cell');
  assert.notEqual(stem('cellulose'), 'cell');
});

test('grounding: a paraphrase of the passage passes', () => {
  assert.equal(grounding('water moves across a membrane', PASSAGE).ok, true);
  assert.equal(grounding('solutes move from high to low', PASSAGE).ok, true);
  // One word in three may be the model's own.
  assert.equal(grounding('a selectively permeable barrier', PASSAGE).ok, true);
});

test('grounding: outside knowledge and a changed number do not', () => {
  const added = grounding('powered by ATP hydrolysis and aquaporins', PASSAGE);
  assert.equal(added.ok, false);
  assert.deepEqual(added.missing, ['powered', 'atp', 'hydrolysis', 'aquaporins']);

  // Every word is right except the year, and the year is the thing that would be learned.
  assert.deepEqual(grounding('first described in 1749', PASSAGE), { ok: false, missing: ['1749'] });
  // A wrong number leads the report even when other words are missing too, since it is the reason.
  assert.equal(grounding('discovered by Peter Agre in 1992', PASSAGE).missing[0], '1992');
});

test('keepGrounded: checks both sides, since a card is drilled in both directions', () => {
  const { kept, dropped } = keepGrounded([
    { ref: 'slide-1', front: 'What is osmosis?', back: 'the movement of water across a membrane' },
    { ref: 'slide-1', front: 'Plasmolysis', back: 'movement of water across a membrane' },
    { ref: 'slide-1', front: 'When was osmosis first described?', back: '1827' },
    // Grounded in slide-2, not slide-1: the passage a card cites is the one it is checked against.
    { ref: 'slide-1', front: 'Catalyst', back: 'speeds a reaction up without being used up' },
    { ref: 'slide-2', front: 'What is the term for a substance that speeds a reaction up?', back: 'a catalyst' },
  ], doc);

  assert.deepEqual(kept.map((k) => k.front), [
    'What is osmosis?',
    'What is the term for a substance that speeds a reaction up?',
  ]);
  assert.deepEqual(dropped.map((d) => [d.front, d.missing]), [
    ['Plasmolysis', ['plasmolysis']],
    ['When was osmosis first described?', ['1827']],
    ['Catalyst', ['catalyst', 'speeds', 'reaction', 'without', 'used']],
  ]);
});

/* -------------------------------------------------------------------------- */
/* Review                                                                     */
/* -------------------------------------------------------------------------- */

const CARDS = [
  { id: 'a', front: 'Osmosis', back: 'the movement of water across a membrane', tags: ['lecture3', 'slide-1'] },
  { id: 'b', front: 'Function', back: 'moves solutes', tags: ['lecture3', 'slide-1'] },
  { id: 'c', front: 'Catalyst', back: 'speeds a reaction up', tags: ['lecture3', 'slide-2'] },
];

/** A stand-in model: records what it was asked, and answers from a script. */
function scripted(...replies) {
  const asked = [];
  const send = async (request) => {
    asked.push(request);
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return typeof reply === 'string' ? reply : JSON.stringify(reply);
  };
  return { asked, send };
}

test('review: each card is asked about beside its own passage, and a flag names the card', async () => {
  const { asked, send } = scripted({ verdicts: [
    { n: 1, ok: true, reason: 'none', note: '' },
    { n: 2, ok: false, reason: 'needs-context', note: 'function of what?' },
    { n: 3, ok: true, reason: 'none', note: '' },
  ] });
  const { flagged, unchecked } = await review(CARDS, doc, { provider: 'ollama', model: 'm', send });

  assert.equal(asked.length, 1, 'two short passages belong in one request');
  const { prompt, system, schema } = asked[0];
  assert.match(prompt, /\[slide-1\][\s\S]*selectively permeable[\s\S]*1\. Q: Osmosis[\s\S]*2\. Q: Function/);
  assert.match(prompt, /\[slide-2\][\s\S]*catalyst speeds[\s\S]*3\. Q: Catalyst/);
  assert.match(system, /needs-context/);
  assert.deepEqual(schema.required, ['verdicts']);

  assert.equal(unchecked, 0);
  assert.deepEqual(flagged.map((f) => [f.card.id, f.reason, f.note]), [['b', 'needs-context', 'function of what?']]);
});

test('review: a model that loses count cannot flag the wrong card', async () => {
  const { send } = scripted({ verdicts: [
    { n: 7, ok: false, reason: 'unclear', note: 'no such card' },
    { n: '2', ok: false, reason: 'unclear', note: 'n is not a number' },
    { n: 1, ok: false, reason: 'made-up-reason', note: '' },
    { n: 1, ok: true, reason: 'none', note: 'a second verdict for card 1' },
  ] });
  const { flagged } = await review(CARDS, doc, { provider: 'ollama', model: 'm', send });
  // Card 1's first verdict stands; an unknown reason is still a flag, filed under the general one.
  assert.deepEqual(flagged.map((f) => [f.card.id, f.reason]), [['a', 'unclear']]);
});

test('review: a rambling reply gets one retry, then its cards are counted as unchecked', async () => {
  const retried = scripted('Here is my review!', { verdicts: [{ n: 2, ok: false, reason: 'unclear', note: '' }] });
  const once = await review(CARDS, doc, { provider: 'ollama', model: 'm', send: retried.send });
  assert.equal(retried.asked.length, 2);
  assert.match(retried.asked[1].prompt, /JSON only/);
  assert.deepEqual(once.flagged.map((f) => f.card.id), ['b']);

  const hopeless = scripted('no', 'still no');
  assert.deepEqual(await review(CARDS, doc, { provider: 'ollama', model: 'm', send: hopeless.send }),
    { flagged: [], unchecked: 3 });
});

test('review: a provider that fails costs its checks and says so, never the deck', async () => {
  const messages = [];
  const { send } = scripted(new Error('LM Studio returned 500: boom'));
  const out = await review(CARDS, doc, {
    provider: 'lmstudio', model: 'm', send, onProgress: (m) => messages.push(m),
  });
  assert.deepEqual(out, { flagged: [], unchecked: 3 });
  assert.ok(messages.some((m) => /boom/.test(m)), messages.join('\n'));
});

test('review: provider none asks nothing', async () => {
  const { asked, send } = scripted();
  assert.deepEqual(await review(CARDS, doc, { provider: 'none', send }), { flagged: [], unchecked: 0 });
  assert.equal(asked.length, 0);
});
