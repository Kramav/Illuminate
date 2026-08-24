/**
 * Writing the deck out.
 *
 * The default format is **Anki's** documented plain-text import — `#key:value` directives followed
 * by tab-delimited rows — and it was not chosen for Anki's sake. QuickMathPlus reads the same
 * format, so one file covers both without a conversion step, which is the entire point of exporting
 * to a format rather than inventing one.
 *
 * Quizlet is the exception, and it is why there are two writers instead of one flag: its paste
 * importer has no notion of directives and would turn each `#` line into a card of its own. So that
 * variant emits the bare rows.
 */

/** RFC 4180 quoting, which is what both Anki and QuickMathPlus expect. */
const quote = (s) => (/["\t\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

/**
 * The format Anki and QuickMathPlus both read.
 *
 * `#guid column:1` is what makes re-importing an updated deck keep a learner's progress instead of
 * creating a second copy of every card — the ids are stable across runs (see `guid` in cards.js),
 * so a re-run after editing one slide disturbs one card.
 *
 * The `connects` column QuickMathPlus also understands is deliberately absent. It declares that two
 * cards interfere with each other and should not be drilled together; we have no honest way to know
 * that, and a file claiming an interference the drill then honours is worse than one that stays
 * quiet.
 */
export function toAnki(deck) {
  const rows = deck.cards.map((c) => [c.id, c.front, c.back, c.tags.join(' ')].map(quote).join('\t'));
  return [
    '#separator:Tab',
    '#html:false',
    '#columns:guid\tfront\tback\ttags',
    '#guid column:1',
    '#tags column:4',
    ...rows,
  ].join('\n') + '\n';
}

/** Bare term/definition rows — no directives, nothing Quizlet would read as a card. */
export function toQuizlet(deck) {
  return deck.cards.map((c) => [c.front, c.back].map(quote).join('\t')).join('\n') + '\n';
}

export function toJson(deck) {
  return JSON.stringify({ source: deck.source, cards: deck.cards }, null, 2) + '\n';
}

const WRITERS = { anki: toAnki, quizlet: toQuizlet, json: toJson };

export const FORMATS = Object.keys(WRITERS);

/** Default file extension per format — `.txt` is what Anki writes and what QuickMathPlus offers. */
export const EXTENSION = { anki: '.txt', quizlet: '.tsv', json: '.json' };

export function render(deck, format) {
  const writer = WRITERS[format];
  if (!writer) throw new Error(`unknown format "${format}" — expected one of ${FORMATS.join(', ')}`);
  return writer(deck);
}
