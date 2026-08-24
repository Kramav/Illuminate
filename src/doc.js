/**
 * The shape every parser produces and the card rules consume.
 *
 * Keeping one model in the middle is what lets `cards.js` stay ignorant of whether a section was a
 * slide, a heading, or a page — it sees titles and lines either way. It is also where the text gets
 * cleaned, once, instead of three times in three parsers.
 *
 * The interesting work here is chrome removal. A deck with the lecturer's name in the footer puts
 * that name on every slide, and without this it becomes a line the card rules will happily read,
 * fail to match, and hand to the LLM as content. Anything appearing on most of the sections is
 * furniture by definition, and the cheapest way to know that is to count.
 */

const BULLET = /^[\s ]*[-•◦▪▫‣⁃*·–—]+[\s ]+/;

/** Always furniture, however few times it appears. */
const FURNITURE = [
  /^\d+$/,                       // bare page or slide number
  /^page\s+\d+/i,
  /^\d+\s*(?:\/|of)\s*\d+$/i,    // "3 / 40"
  /^[©(]c?\)?\s*\d{4}/i,
  /^\s*$/,
];

/** Spaces collapse; tabs survive, because a tab is a column separator worth reading later. */
export const tidy = (s) => String(s).replace(/[  \r\n]+/g, ' ').replace(/[ ]*\t[ ]*/g, '\t').trim();

/** For comparing two pieces of text as "the same thing said twice". */
export const normalize = (s) => tidy(s).toLowerCase().replace(/\t/g, ' ');

/** A file name reduced to something safe to use as a tag — no spaces, since tags are space-separated. */
export function slugify(name) {
  const s = String(name).replace(/\.[^.]+$/, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'set';
}

/**
 * Tidy one line's runs and recompute its text.
 *
 * The bullet glyph is stripped from the first run rather than from the joined string, so that a line
 * whose term is bold still reports that term as `runs[0]` afterwards — stripping the glyph off the
 * flattened text would leave the runs disagreeing with it.
 */
function cleanLine(line) {
  const runs = line.runs.map((r) => ({ ...r, text: r.text.replace(/[ \r\n]+/g, ' ') }));
  if (runs.length) runs[0] = { ...runs[0], text: runs[0].text.replace(BULLET, '') };
  const kept = runs.filter((r) => r.text.trim() !== '' || r.text.includes('\t'));
  if (!kept.length) return null;
  const text = tidy(kept.map((r) => r.text).join(''));
  if (!text || FURNITURE.some((re) => re.test(text))) return null;
  return { text, runs: kept.map((r) => ({ ...r, text: r.text })), level: line.level ?? 0 };
}

/** Text appearing in more than half the sections is a header or footer, not content. */
function chromeOf(sections) {
  if (sections.length < 4) return new Set();
  const seen = new Map();
  for (const section of sections) {
    for (const key of new Set(section.lines.map((l) => normalize(l.text)))) {
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const threshold = sections.length / 2;
  return new Set([...seen].filter(([, n]) => n > threshold).map(([key]) => key));
}

/**
 * Clean parser output into a document.
 *
 * @param {string} source  file name, used for tags and card ids
 * @param {Array} rawSections
 * @returns {{ source: string, slug: string, sections: Array }}
 */
export function buildDoc(source, rawSections) {
  const sections = rawSections.map((section) => ({
    title: tidy(section.title ?? ''),
    ref: section.ref,
    // Speaker notes join the section's lines rather than staying a separate field: they are prose
    // the card rules should read on exactly the same terms, and nothing downstream benefits from
    // knowing which half of a slide a definition came from.
    lines: [
      ...section.lines,
      ...String(section.notes ?? '').split(/\r?\n/).map((text) => ({ runs: [{ text, bold: false }] })),
    ].map(cleanLine).filter(Boolean),
  }));

  const chrome = chromeOf(sections);
  // A title repeated across most sections is the deck's own name on every slide, not a heading.
  const titles = new Map();
  for (const s of sections) {
    if (s.title) titles.set(normalize(s.title), (titles.get(normalize(s.title)) ?? 0) + 1);
  }

  for (const section of sections) {
    section.lines = section.lines.filter((l) => !chrome.has(normalize(l.text)));
    if (sections.length >= 4 && (titles.get(normalize(section.title)) ?? 0) > sections.length / 2) {
      section.title = '';
    }
  }

  return { source, slug: slugify(source), sections };
}
