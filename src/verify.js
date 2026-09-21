/**
 * Checking cards against the text they came from.
 *
 * Two checks, in the order the rest of the tool works in: a free, deterministic one first, and a
 * model only for what that cannot judge.
 *
 * **Grounding** is for model-made cards, and costs nothing. A rule-made card is copied out of the
 * source, so asking whether the source supports it is asking whether a string contains itself. A
 * model-made card is the one place a fact can be invented, and the cheapest test for that is also a
 * good one: its words should be in the passage. A model that adds outside knowledge has to use words
 * the lecture never did, and one that misremembers a number writes a number the lecture never had.
 *
 * **Review** asks a model about every card, and asks something different — not "is this true" but
 * "can this be studied as written". Rule-made cards fail that in ways no string check sees: a front
 * of "Function" is sourced, accurate and useless once it leaves its slide. Review flags rather than
 * removes, because the reviewer is less reliable than the rules it is reviewing, and a good card
 * deleted over a false alarm is worse than a doubtful one left where it can be seen.
 */

import { ask, defaultModel, parseJson } from './llm.js';

/** Words any answer can use without the passage having used them. */
const STOPWORDS = new Set(`a about above after again all also an and any are as at be because been
  before being between both but by can could did do does doing down during each few for from further
  had has have having how if in into is it its itself just more most no nor not of off on once only or
  other our out over own same should so some such than that the their them then there these they this
  those through to too under until up very was we were what when where which while who whom why will
  with would you your`.split(/\s+/));

/** A question's own scaffolding — "What is the term for…" names nothing the passage must contain. */
const QUESTION_WORDS = new Set(['called', 'name', 'named', 'term', 'define', 'defined', 'describe',
  'described', 'meaning', 'mean', 'means', 'known', 'refer', 'refers', 'example', 'type', 'kind']);

const SUFFIXES = ['ations', 'ation', 'ments', 'ment', 'ings', 'ing', 'ness', 'ies', 'ied', 'ers', 'er',
  'es', 'ed', 'ly', 's'];

/**
 * One word in three may be the model's own phrasing; one in two may not. A number is never allowed
 * to be — an invented date or quantity is the most damaging thing a flashcard can teach.
 */
const GROUNDED = 2 / 3;

/** How much source text to put in one review request. */
const REVIEW_CHUNK = 4000;

const tokens = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const isNumber = (t) => /^\p{N}/u.test(t);

/**
 * A word reduced to what its other forms share: "moves", "moved", "moving" and "movement" all come
 * to "mov". Deliberately crude. It only has to let a paraphrase meet its source, not be English.
 */
export function stem(word) {
  let w = word.toLowerCase();
  const suffix = SUFFIXES.find((s) => w.endsWith(s) && w.length - s.length >= 3);
  if (suffix) w = w.slice(0, -suffix.length);
  return w.length > 3 ? w.replace(/e$/, '') : w;
}

/**
 * Two stems name the same thing if they are equal, or one runs on from the other — "diffus" and
 * "diffusion". The shorter must be five letters or more, or "cell" would vouch for "cellulose".
 */
function sameStem(a, b) {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 5 && long.startsWith(short);
}

/**
 * Does the passage contain this text's words?
 *
 * @returns {{ ok: boolean, missing: string[] }}  `missing` in the text's own spelling, for the report
 */
export function grounding(text, source, { ignore = new Set() } = {}) {
  const numbers = new Set();
  const stems = [];
  for (const t of tokens(source)) {
    if (isNumber(t)) numbers.add(t);
    else stems.push(stem(t));
  }
  const known = new Set(stems);

  const wrongNumbers = [];
  const missing = [];
  let words = 0;
  let found = 0;
  for (const t of new Set(tokens(text))) {
    if (isNumber(t)) {
      if (!numbers.has(t)) wrongNumbers.push(t);
      continue;
    }
    if (t.length < 2 || STOPWORDS.has(t) || ignore.has(t)) continue;
    words += 1;
    const s = stem(t);
    if (known.has(s) || stems.some((other) => sameStem(s, other))) found += 1;
    else missing.push(t);
  }
  const ok = !wrongNumbers.length && (words === 0 || found / words >= GROUNDED);
  // Numbers first: when one is wrong it is the reason, and the report only has room for a few.
  return { ok, missing: [...wrongNumbers, ...missing] };
}

/** A section's text as the model saw it: its title and its lines, speaker notes included. */
export function sourceOf(doc, ref) {
  const section = doc.sections.find((s) => s.ref === ref);
  return section ? [section.title, ...section.lines.map((l) => l.text)].filter(Boolean).join('\n') : '';
}

/**
 * Split model-made candidates into the ones their passage supports and the ones it does not.
 *
 * Both sides of the card are checked, because QuickMathPlus drills cards in reverse too: an invented
 * term on the front is as much an answer to learn as anything on the back.
 *
 * @param {Array<{ref: string, front: string, back: string}>} items  as `expand` returns them
 * @returns {{ kept: Array, dropped: Array<{front, back, ref, missing: string[]}> }}
 */
export function keepGrounded(items, doc) {
  const kept = [];
  const dropped = [];
  for (const item of items) {
    const source = sourceOf(doc, item.ref);
    const front = grounding(item.front, source, { ignore: QUESTION_WORDS });
    const back = grounding(item.back, source);
    if (front.ok && back.ok) kept.push(item);
    else dropped.push({ ...item, missing: [...front.missing, ...back.missing] });
  }
  return { kept, dropped };
}

/* -------------------------------------------------------------------------- */
/* Review                                                                     */
/* -------------------------------------------------------------------------- */

export const REASONS = ['unsupported', 'needs-context', 'unclear'];

const REVIEW_SYSTEM = `You check flashcards against the passage they were made from.

For each numbered card, decide whether a student could study it as written:
- "unsupported": the passage does not state the answer.
- "needs-context": the card only makes sense beside the passage. The question is too vague alone
  ("Function", "Main idea"), or the answer points at something not on the card ("as shown above").
- "unclear": the answer does not answer the question, or the question has more than one fair answer.
Otherwise the card is fine. Most cards are fine: flag real problems only, and never flag a card for
style or for being short.

Reply with JSON only, one verdict per card, in this shape:
{"verdicts":[{"n":1,"ok":true,"reason":"none","note":""},{"n":2,"ok":false,"reason":"needs-context","note":"under ten words"}]}`;

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          ok: { type: 'boolean' },
          reason: { type: 'string', enum: ['none', ...REASONS] },
          note: { type: 'string' },
        },
        required: ['n', 'ok', 'reason', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Cards grouped under the passage they came from, packed into request-sized batches and numbered
 * within each. A card finds its section through its tags, which always carry the section's ref.
 */
function batches(cards, doc) {
  const groups = new Map();
  for (const card of cards) {
    const section = doc.sections.find((s) => card.tags.includes(s.ref));
    if (!section) continue;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(card);
  }

  const out = [];
  let batch = null;
  for (const [section, group] of groups) {
    const passage = sourceOf(doc, section.ref);
    if (!batch || (batch.size + passage.length > REVIEW_CHUNK && batch.cards.length)) {
      batch = { blocks: [], cards: [], size: 0 };
      out.push(batch);
    }
    const listed = group.map((card) => {
      batch.cards.push(card);
      return `${batch.cards.length}. Q: ${oneLine(card.front)}\n   A: ${oneLine(card.back)}`;
    });
    batch.blocks.push(`[${section.ref}]\n${passage}\n\nCards from ${section.ref}:\n${listed.join('\n')}`);
    batch.size += passage.length;
  }
  return out.map((b) => ({ prompt: b.blocks.join('\n\n---\n\n'), cards: b.cards }));
}

/**
 * Ask a model which cards need a second look.
 *
 * Returns verdicts rather than changing the cards — what to do with a flag is the caller's decision.
 * A provider that is down or answering nonsense leaves its cards unchecked and says so; it never
 * costs the deck, which is already finished by the time this runs.
 *
 * @param {Array} cards  finished cards from one document
 * @param {{ sections: Array }} doc
 * @param {{ provider: string, model?: string, onProgress?: Function, send?: Function }} options
 *   `send` stands in for `ask` in tests.
 * @returns {Promise<{ flagged: Array<{card, reason, note}>, unchecked: number }>}
 */
export async function review(cards, doc, { provider, model, onProgress = () => {}, send = ask }) {
  if (provider === 'none' || !cards.length) return { flagged: [], unchecked: 0 };

  let chosen;
  try {
    chosen = model ?? await defaultModel(provider);
  } catch (err) {
    onProgress(`verify ${provider}: ${err.message} — cards left unchecked`);
    return { flagged: [], unchecked: cards.length };
  }

  const flagged = [];
  let unchecked = 0;
  const all = batches(cards, doc);
  for (const [i, batch] of all.entries()) {
    onProgress(`verify ${provider}: batch ${i + 1}/${all.length}`);
    const signal = provider === 'claude' ? undefined : AbortSignal.timeout(180_000);
    const request = (prompt) => send({
      provider, model: chosen, system: REVIEW_SYSTEM, schema: REVIEW_SCHEMA, prompt, signal,
    }).then((reply) => parseJson(reply, 'verdicts'));

    let verdicts = null;
    try {
      verdicts = await request(batch.prompt)
        ?? await request(`${batch.prompt}\n\nReply with JSON only — no prose, no code fence.`);
    } catch (err) {
      onProgress(`verify ${provider}: ${err.message}`);
    }
    if (!verdicts) {
      unchecked += batch.cards.length;
      continue;
    }

    const seen = new Set();
    for (const verdict of verdicts) {
      // A verdict for a card that was never asked about, or a second verdict for one that was, is
      // the model losing count — acting on it would flag the wrong card.
      const card = Number.isInteger(verdict?.n) ? batch.cards[verdict.n - 1] : undefined;
      if (!card || seen.has(card)) continue;
      seen.add(card);
      if (verdict.ok !== false) continue;
      flagged.push({
        card,
        reason: REASONS.includes(verdict.reason) ? verdict.reason : 'unclear',
        note: typeof verdict.note === 'string' ? oneLine(verdict.note) : '',
      });
    }
  }
  return { flagged, unchecked };
}
