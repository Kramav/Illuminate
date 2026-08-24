/**
 * Turning lines into cards.
 *
 * This is the part with judgement in it, and the judgement is mostly about *refusing*. Slides are
 * full of text that reads like a definition and isn't — "Note: see chapter 4", "Today: enzymes",
 * "Q3: 14%" — and a rule permissive enough to catch every real term also catches all of those. A
 * deck of forty cards where six are garbage is worse than a deck of thirty where none are, because
 * the six have to be found and deleted by hand before the deck is usable at all.
 *
 * So every rule below is narrow, the guards reject rather than repair, and anything the rules cannot
 * confidently structure is set aside as `residue` instead of being forced into a card. The residue
 * is what the optional LLM pass reads — which means the model only ever sees the prose the cheap
 * deterministic rules already failed on, and the tested core stays honest.
 */

import { normalize } from './doc.js';

/** A definition longer than this is a paragraph, and nobody recalls a paragraph from a prompt. */
const MAX_BACK = 300;
const MAX_FRONT = 80;

/** Term and definition separators. A tab is included but treated more leniently — see splitAt. */
const SEPARATOR = /\s*[—–]\s*|:\s+|\s+-{1,2}\s+/;

/**
 * Left-hand sides that are labels rather than terms.
 *
 * This list is the difference between the rule working and the rule being useless. Every one of
 * these introduces a definition without being one, and each produced real garbage in testing.
 */
const NOT_A_TERM = /^(?:notes?|examples?|e\.?g\.?|i\.?e\.?|see|sources?|refs?|references?|fig\.?|figures?|tables?|chapters?|sections?|steps?|tips?|warnings?|cautions?|important|remember|hints?|answers?|solutions?|questions?|q|a|summary|goals?|objectives?|definitions?|def|key|topics?|agenda|outline|today|tomorrow|next|recall|aside|links?|urls?|https?|www|part|page|slide|task|exercise|problem|reading|due|deadline)$/i;

/**
 * Words that give away a clause pretending to be a term.
 *
 * "Read this first: it explains the rest" passes every other guard — three words, no punctuation,
 * not a listed label — and is still not a term. What separates it from a real one is that terms name
 * things and clauses point at them, so a demonstrative or a pronoun in the left side is the tell.
 *
 * Only applied to multi-word fronts, so a legitimate one-word "IT" or "We" survives.
 */
const POINTS_AT_SOMETHING = /\b(?:this|that|these|those|here|there|it|its|we|our|us|you|your|i|my|me|he|she|his|her|they|their|them)\b/i;

/** Fronts that are deck furniture rather than material. */
const BOILERPLATE = /^(?:agenda|outline|overview|introduction|intro|summary|conclusions?|references?|bibliography|thank you!*|thanks!*|questions\??|any questions\??|q ?& ?a|contents|table of contents|next time|homework|announcements?|objectives?|learning objectives|goals?|recap|review|the end|welcome|about (?:me|us)|contact|disclaimer)$/i;

/**
 * A card id that survives re-running the tool.
 *
 * FNV-1a over the source name and the front text. Row position would be the obvious choice and is
 * wrong: inserting one slide at the top of a deck would shift every id below it, and a study app
 * would silently hand each card the next card's accumulated progress. Hashing the front means
 * editing one card disturbs only that card — and a card whose question was rewritten becomes a new
 * card, which is the honest reading of "this asks something different now".
 *
 * ponytail: 32 bits. A collision inside one deck is possible in principle; `dedupe` below would
 * merge the two rather than emit a duplicate id, which is the failure mode we can live with.
 */
export function guid(slug, front) {
  const s = `${slug}|${front}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Split "Term — definition" if and only if the left side really looks like a term.
 *
 * The word count is the load-bearing guard. Almost every false positive is a full sentence with a
 * dash or colon in the middle of it, and almost every true positive names something in one to three
 * words. Six is generous enough for "Second law of thermodynamics" and tight enough to reject prose.
 *
 * @returns {{front: string, back: string} | null}
 */
export function splitTermDef(text) {
  // A tab is an explicit column break someone typed on purpose, so it skips the guesswork below —
  // but not the sanity checks, which are applied to every candidate by `accept`.
  if (text.includes('\t')) {
    const at = text.indexOf('\t');
    return { front: text.slice(0, at).trim(), back: text.slice(at + 1).trim() };
  }

  const match = SEPARATOR.exec(text);
  if (!match || match.index === 0) return null;

  const front = text.slice(0, match.index).trim();
  const back = text.slice(match.index + match[0].length).trim();
  if (!front || !back) return null;

  if (front.length > MAX_FRONT) return null;
  const words = front.split(/\s+/).length;
  if (words > 6) return null;
  if (words > 1 && POINTS_AT_SOMETHING.test(front)) return null;
  // A term does not end in sentence punctuation; a clause that happens to precede a dash does.
  if (/[.,;!?]$/.test(front)) return null;
  // Compared with punctuation and digits removed, so that "Chapter 4", "Step 2" and "Q3" are caught
  // by the plain words in the list rather than needing an entry each.
  const label = front.toLowerCase().replace(/[^a-z\s.]/g, '').replace(/\s+/g, ' ').trim();
  if (NOT_A_TERM.test(label)) return null;
  if (/https?:\/\//i.test(front)) return null;
  // "Chapter 4", "Step 2" — a label plus a number is still a label.
  if (/^\W*\d+\W*$/.test(front)) return null;

  return { front, back };
}

/**
 * Split a line whose opening run is bold: "**Osmosis** the movement of water across a membrane".
 *
 * Requires a non-bold remainder, because a line that is bold all the way through is a sub-heading —
 * turning it into a card with an empty back would be caught by `accept` anyway, but recognising it
 * here keeps the line available for the separator rule instead of consuming it.
 */
export function splitBoldLead(line) {
  const runs = line.runs ?? [];
  if (!runs.length || !runs[0].bold) return null;
  let i = 0;
  while (i < runs.length && runs[i].bold) i++;
  if (i === runs.length) return null;

  const front = runs.slice(0, i).map((r) => r.text).join('').trim().replace(/[\s:—–-]+$/, '');
  const back = runs.slice(i).map((r) => r.text).join('').trim().replace(/^[\s:—–-]+/, '');
  return front && back ? { front, back } : null;
}

/**
 * The gate every candidate passes through, whether a rule or a language model produced it.
 *
 * Sharing it is the point: an LLM asked for flashcards will cheerfully return a card whose answer is
 * three sentences long or whose question is "Summary", and there is no reason to check that twice in
 * two places with two slightly different opinions about what is acceptable.
 */
export function accept(card) {
  if (!card) return false;
  const { front, back } = card;
  if (!front || !back) return false;
  if (front.length < 2 || back.length < 2) return false;
  if (front.length > MAX_FRONT || back.length > MAX_BACK) return false;
  if (normalize(front) === normalize(back)) return false;
  if (BOILERPLATE.test(front.replace(/[^\w &?!']/g, ' ').trim())) return false;
  if (!/[a-z]/i.test(front)) return false;   // pure numbers or symbols ask nothing
  return true;
}

/**
 * `;` in an answer means "or this instead" to the study apps that read our output, so a definition
 * containing one would silently become several answers, most of them wrong. Commas say the same
 * thing to a reader and nothing at all to the parser.
 */
const safeBack = (s) => s.replace(/;/g, ',').trim();

/** Keep one card per question, preferring the fullest answer we saw for it. */
function dedupe(cards) {
  const byFront = new Map();
  for (const card of cards) {
    const key = normalize(card.front);
    const seen = byFront.get(key);
    if (!seen || card.back.length > seen.back.length) byFront.set(key, card);
  }
  return [...byFront.values()];
}

/**
 * Read a document into cards, plus whatever could not be read.
 *
 * @param {{source: string, slug: string, sections: Array}} doc
 * @param {{ tag?: string }} [options]
 * @returns {{ cards: Array, residue: Array<{ref: string, title: string, text: string}> }}
 */
export function extract(doc, { tag = '' } = {}) {
  const found = [];
  const residue = [];

  for (const section of doc.sections) {
    const tags = [doc.slug, section.ref, tag].filter(Boolean);
    const leftovers = [];
    const lines = section.lines;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // A question line answered by the line under it. Checked first because when a deck states a
      // question outright, that phrasing beats anything the other rules would infer.
      const next = lines[i + 1];
      if (/\?$/.test(line.text) && next && !/\?$/.test(next.text)) {
        found.push({ front: line.text, back: next.text, tags });
        i++;
        continue;
      }

      const split = splitBoldLead(line) ?? splitTermDef(line.text);
      if (split && accept(split)) {
        found.push({ ...split, tags });
        continue;
      }
      leftovers.push(line.text);
    }

    if (leftovers.length) {
      residue.push({ ref: section.ref, title: section.title, text: leftovers.join('\n') });
    }
  }

  const cards = dedupe(found.filter(accept)).map((card) => ({
    front: card.front,
    back: safeBack(card.back),
    tags: card.tags,
    id: guid(doc.slug, card.front),
  }));

  return { cards, residue };
}
