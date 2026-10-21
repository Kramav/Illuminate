/**
 * The study-sheet pipeline's deterministic half.
 *
 * Notes are written by a model reading `slides.md` and the slide images; everything a model should
 * *not* be trusted to do lives here instead. Which slides need looking at, the exact format the
 * model reads, the citation grammar it writes, and the checks that hold it to that — every slide
 * accounted for, every citation real, nothing dropped by the merge. A model that skips slide 31 or
 * cites slide 140 of a 115-slide deck does it silently; these functions make it loud.
 *
 * Pure, like the rest of `src/`. The CLI in study.js at the root does the reading and writing.
 */

import { buildDoc, normalize, tidy } from './doc.js';

/**
 * Bumped whenever extraction changes what `slides.json` holds, so a lecture extracted by an older
 * version is reported stale rather than silently mixed with newer ones.
 */
export const EXTRACTOR_VERSION = 5;

/** Below this much text, a slide is a picture with a caption at best, whatever else it holds. */
const LITTLE_TEXT = 40;

/**
 * The lecture number a file name states, if it states one.
 *
 * Taken from the name rather than from the command line's order so that a lecture keeps its number
 * however many others are run beside it — citations in the merged sheet (`[L3 s12]`) depend on it.
 */
export function lectureNumber(fileName) {
  const m = /(?:lecture|lec|week|class|session|ch(?:apter)?)\W{0,3}(\d+)/i.exec(String(fileName))
    ?? /^(\d+)\D/.exec(String(fileName));
  return m ? Number(m[1]) : null;
}

/**
 * Why a slide needs to be looked at rather than only read, or `[]` if its text is the whole story.
 *
 * Every reason is something the text extraction demonstrably does not carry: pixels, an equation
 * stored as a picture, a chart, or meaning held in a layout of shapes and arrows.
 */
export function classify(slide) {
  const v = slide.visuals ?? {};
  const reasons = [];
  if (v.equations?.length || v.math) reasons.push('equation');
  if (v.pictures) reasons.push('picture');
  if (v.charts) reasons.push('chart');
  if (v.smartart) reasons.push('smartart');
  if (v.objects) reasons.push('embedded-object');
  // Thresholds rather than any-at-all: a single underline or one "x" label is decoration, two
  // strokes or five labels are a drawing whose meaning is in where they sit.
  if (v.groups || v.connectors || v.drawn >= 2 || v.labels >= 5) reasons.push('diagram');
  const text = [slide.title, ...slide.lines.map((l) => l.text)].join(' ').trim();
  if (text.length < LITTLE_TEXT) reasons.push('little-text');
  return reasons;
}

/**
 * A line's text with its superscripts and subscripts written out: `w_{ij}`, `x^{k}`.
 *
 * The card pipeline joins runs as plain text, which is right for a flashcard ("H2O") and wrong for
 * a lecture on weights and indices, where `w_ij` and `wij` are not the same thing to a reader who
 * cannot see the slide. Adjacent runs in the same position are merged first, since PowerPoint often
 * splits one subscript across several runs.
 */
export function scriptedText(line) {
  const runs = line.runs ?? [{ text: line.text }];
  if (!runs.some((r) => r.script)) return line.text;
  const merged = [];
  for (const run of runs) {
    const last = merged.at(-1);
    if (last && last.script === run.script) last.text += run.text;
    else merged.push({ text: run.text, script: run.script });
  }
  return tidy(merged.map((r) => {
    if (!r.script || !r.text.trim()) return r.text;
    return `${r.script === 'sup' ? '^' : '_'}{${r.text.trim()}}`;
  }).join(''));
}

/**
 * Build one lecture's record from the reader's sections.
 *
 * Cleaning goes through `buildDoc` — the same bullet stripping and header/footer removal the card
 * pipeline uses — but the notes are kept apart. `buildDoc` folds them into the slide's lines, which
 * is right for cards and wrong here: a study sheet should be able to say whether something was on
 * the slide or only in what the lecturer meant to say over it.
 */
export function buildLecture({ source, sha256, sections, lecture }) {
  const doc = buildDoc(source, sections.map((s) => ({ ...s, notes: '' })));
  const slides = doc.sections.map((clean, i) => {
    const raw = sections[i];
    const slide = {
      number: raw.number ?? i + 1,
      title: clean.title,
      hidden: Boolean(raw.hidden),
      lines: clean.lines.map((l) => ({ text: scriptedText(l), level: l.level ?? 0 })),
      notes: String(raw.notes ?? '').split(/\r?\n/).map(tidy).filter(Boolean),
      visuals: raw.visuals ?? {},
    };
    slide.reasons = classify(slide);
    return slide;
  });
  return {
    source,
    slug: doc.slug,
    lecture: lecture ?? lectureNumber(source),
    sha256,
    extractor: EXTRACTOR_VERSION,
    slides,
  };
}

/** `s007` — padded so a directory listing of images sorts in slide order. */
export const slideId = (n) => `s${String(n).padStart(3, '0')}`;

/** Where a slide's rendered image and its equation crops live, relative to the lecture folder. */
export const imagePath = (n) => `images/${slideId(n)}.png`;
export const equationPath = (n, k) => `images/${slideId(n)}-eq${k}.png`;

/**
 * The lecture as the note-writer reads it.
 *
 * One `##` per slide, carrying the slide number in the exact form a citation uses (`s7`), so that
 * what the model reads and what it must write back are the same token. A slide that needs an image
 * says so and why, with the path, and lists its equation crops individually — an equation is the
 * one thing most worth reading at full size and least possible to recover from the text.
 */
export function slidesMarkdown(lecture) {
  const out = [
    `# Lecture ${lecture.lecture ?? '?'} — ${lecture.source}`,
    '',
    `${lecture.slides.length} slides · ${lecture.slides.filter((s) => s.reasons.length).length} need an image`
      + ` · source sha256 ${lecture.sha256.slice(0, 12)}`,
    '',
  ];
  for (const s of lecture.slides) {
    out.push(`## s${s.number}${s.title ? ` · ${s.title}` : ''}${s.hidden ? ' (hidden)' : ''}`, '');
    // A scatter plot drawn in text boxes is seventy lines of "X". Repeats are collapsed to one line
    // with a count, so the reader sees the label once and the slide's prose stays findable.
    for (let i = 0; i < s.lines.length; i++) {
      const line = s.lines[i];
      let j = i;
      while (j + 1 < s.lines.length && s.lines[j + 1].text === line.text && s.lines[j + 1].level === line.level) j++;
      // A tab-joined line is a table row or a column gutter; a pipe reads as one in Markdown.
      out.push(`${'  '.repeat(line.level)}- ${line.text.replace(/\t/g, ' | ')}${j > i ? ` (×${j - i + 1})` : ''}`);
      i = j;
    }
    if (s.notes.length) {
      out.push('', ...s.notes.map((n) => `> ${n}`));
    }
    if (s.reasons.length) {
      out.push('', `[image-needed: ${s.reasons.join(', ')} → ${imagePath(s.number)}]`);
      (s.visuals.equations ?? []).forEach((eq, k) => {
        out.push(`[equation ${k + 1} (${eq.kind}) → ${equationPath(s.number, k + 1)}]`);
      });
    }
    out.push('');
  }
  return out.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Citations                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One citation item: `s12`, `s12-14`, `L3 s12`, `L3 s12-s14`.
 *
 * The grammar is deliberately small. Everything downstream — coverage, merge preservation, the
 * review page — parses the same brackets, and a citation the parser cannot read is a slide the
 * checks cannot see. So anything outside it is reported, not guessed at.
 */
const ITEM = /^(?:L(\d+)\s+)?s(\d+)(?:\s*[-–]\s*s?(\d+))?$/i;
const BRACKET = /\[((?:L\d+\s+)?s\d+[^\]]*)\]/gi;

/** Longest range a single citation may span — past this it is a typo, not a passage. */
const MAX_RANGE = 40;

/**
 * Every citation in a piece of text, expanded to individual slides.
 *
 * Within one bracket, a lecture carries forward: `[L3 s4, s9; L5 s2]` is L3's 4 and 9 and L5's 2.
 * Without one, `lecture` is the default — a lecture's own notes never need to name themselves.
 *
 * @returns {{ refs: Array<{lecture: number|null, slide: number}>, bad: string[] }}
 */
export function parseCitations(text, { lecture = null } = {}) {
  const refs = [];
  const bad = [];
  for (const [whole, body] of String(text).matchAll(BRACKET)) {
    let current = lecture;
    for (const item of body.split(/\s*[,;]\s*/)) {
      const m = ITEM.exec(item.trim());
      if (!m) {
        bad.push(whole);
        break;
      }
      if (m[1]) current = Number(m[1]);
      const from = Number(m[2]);
      const to = m[3] ? Number(m[3]) : from;
      if (to < from || to - from > MAX_RANGE) {
        bad.push(whole);
        continue;
      }
      for (let n = from; n <= to; n++) refs.push({ lecture: current, slide: n });
    }
  }
  return { refs, bad };
}

/** Split Markdown into `##` sections, keeping the text before the first one as heading `''`. */
export function sectionsOf(markdown) {
  const sections = [{ heading: '', lines: [] }];
  for (const line of String(markdown).split(/\r?\n/)) {
    const h = /^##\s+(.*)$/.exec(line);
    if (h) sections.push({ heading: h[1].trim(), lines: [] });
    else sections.at(-1).lines.push(line);
  }
  return sections;
}

const isSkipped = (heading) => /^skipped\b/i.test(heading);

/**
 * Is every slide of a lecture accounted for in its notes?
 *
 * Accounted for means cited somewhere, or listed under `## Skipped` with a reason — a title slide
 * or an agenda has nothing examinable, and saying so is different from forgetting it. Hidden slides
 * are not required. A citation of a slide the lecture does not have is its own failure: it is the
 * signature of a model that lost count.
 */
export function coverage(lecture, notes) {
  const count = lecture.slides.length;
  const cited = new Set();
  const skipped = new Set();
  const invalid = [];
  const { bad } = parseCitations(notes, { lecture: lecture.lecture });

  for (const section of sectionsOf(notes)) {
    const { refs } = parseCitations(section.lines.join('\n'), { lecture: lecture.lecture });
    for (const ref of refs) {
      if (ref.lecture !== lecture.lecture || ref.slide < 1 || ref.slide > count) {
        invalid.push(ref.lecture === lecture.lecture ? `s${ref.slide}` : `L${ref.lecture} s${ref.slide}`);
        continue;
      }
      (isSkipped(section.heading) ? skipped : cited).add(ref.slide);
    }
  }

  const missing = lecture.slides
    .filter((s) => !s.hidden && !cited.has(s.number) && !skipped.has(s.number))
    .map((s) => s.number);
  return {
    ok: !missing.length && !invalid.length && !bad.length,
    cited,
    skipped,
    missing,
    invalid: [...new Set(invalid)],
    malformed: bad,
  };
}

/**
 * Did the merge keep every citation the lecture notes made?
 *
 * The merged sheet is written from the notes, never from the slides, so a citation that does not
 * survive into it is content that was merged away without a trace. Each (lecture, slide) cited in a
 * notes file outside `## Skipped` must appear somewhere in the sheet; a sheet citation with no
 * lecture is reported too, because it cannot be traced back to anything.
 */
export function preservation(notesByLecture, sheet) {
  const { refs, bad } = parseCitations(sheet);
  const have = new Set(refs.filter((r) => r.lecture !== null).map((r) => `${r.lecture}:${r.slide}`));
  const dropped = [];
  for (const { lecture, notes } of notesByLecture) {
    const seen = new Set();
    for (const section of sectionsOf(notes)) {
      if (isSkipped(section.heading)) continue;
      for (const ref of parseCitations(section.lines.join('\n'), { lecture }).refs) {
        const key = `${ref.lecture}:${ref.slide}`;
        if (!have.has(key) && !seen.has(key)) dropped.push({ lecture: ref.lecture, slide: ref.slide });
        seen.add(key);
      }
    }
  }
  return {
    ok: !dropped.length && !bad.length && refs.every((r) => r.lecture !== null),
    dropped,
    unattributed: refs.filter((r) => r.lecture === null).length,
    malformed: bad,
  };
}

/* -------------------------------------------------------------------------- */
/* Notes files                                                                */
/* -------------------------------------------------------------------------- */

/** The template's version, from its first line: `<!-- illuminate-template v1 -->`. */
export function templateVersion(template) {
  const m = /<!--\s*illuminate-template\s+v(\d+)\s*-->/.exec(String(template));
  return m ? Number(m[1]) : null;
}

/** The stamp a notes file opens with, naming the deck and template it was written from. */
export const notesStamp = ({ sha256, template }) =>
  `<!-- illuminate-notes deck=${sha256.slice(0, 12)} template=v${template} -->`;

/** Read a notes file's stamp back, or `null` for a file that has none. */
export function readStamp(notes) {
  const m = /<!--\s*illuminate-notes\s+deck=([0-9a-f]+)\s+template=v(\d+)\s*-->/.exec(String(notes));
  return m ? { deck: m[1], template: Number(m[2]) } : null;
}

/**
 * Every bullet in a notes file, with the section it sits in and the slides it cites.
 *
 * A bullet's continuation lines (indented, not themselves bullets) belong to it, which is how a
 * worked example spanning several lines stays one item with one set of citations.
 */
export function noteBullets(notes, { lecture = null } = {}) {
  const out = [];
  for (const section of sectionsOf(notes)) {
    let current = null;
    for (const line of section.lines) {
      const bullet = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (bullet) {
        current = { section: section.heading, text: bullet[1] };
        out.push(current);
      } else if (current && /^\s+\S/.test(line)) {
        current.text += `\n${line.trim()}`;
      } else if (!line.trim()) {
        current = null;
      }
    }
  }
  for (const item of out) item.refs = parseCitations(item.text, { lecture }).refs;
  return out;
}

/* -------------------------------------------------------------------------- */
/* Concept index                                                              */
/* -------------------------------------------------------------------------- */

/** The bold lead term of a bullet — `**Perceptron** — a …` — which the template asks every entry for. */
const TERM = /^\*\*(.+?)\*\*/;

/** A term reduced to what two lectures would agree on: no case, no parenthetical, no plural `s`. */
function termKey(term) {
  return normalize(term.replace(/\([^)]*\)/g, ' ').replace(/[:.,;]+$/, ''))
    .replace(/[^a-z0-9α-ω ]+/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

/**
 * Every bolded term across all lectures' notes, with where each lecture defines it.
 *
 * This is the merge pass's worklist. Deduplication done from memory over ten files misses things in
 * proportion to how much there is to remember; a term defined in three lectures is listed here
 * once, with all three, before anyone decides how to merge it.
 */
export function conceptIndex(notesByLecture) {
  const byKey = new Map();
  for (const { lecture, notes } of notesByLecture) {
    for (const item of noteBullets(notes, { lecture })) {
      if (isSkipped(item.section)) continue;
      const m = TERM.exec(item.text);
      if (!m) continue;
      const key = termKey(m[1]);
      if (!key) continue;
      const entry = byKey.get(key) ?? { term: m[1].trim(), key, sections: new Set(), uses: new Map() };
      entry.sections.add(item.section);
      const slides = entry.uses.get(lecture) ?? new Set();
      for (const ref of item.refs) slides.add(ref.slide);
      entry.uses.set(lecture, slides);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()]
    .map((e) => ({
      term: e.term,
      key: e.key,
      sections: [...e.sections],
      uses: [...e.uses].map(([lecture, slides]) => ({ lecture, slides: [...slides].sort((a, b) => a - b) }))
        .sort((a, b) => a.lecture - b.lecture),
    }))
    .sort((a, b) => b.uses.length - a.uses.length || a.key.localeCompare(b.key));
}

/** A citation for a list of slides in one lecture, ranges collapsed: `L3 s4-6, s9`. */
export function formatRefs(lecture, slides) {
  const parts = [];
  for (let i = 0; i < slides.length; i++) {
    let j = i;
    while (j + 1 < slides.length && slides[j + 1] === slides[j] + 1) j++;
    parts.push(j > i ? `s${slides[i]}-${slides[j]}` : `s${slides[i]}`);
    i = j;
  }
  return parts.length ? `L${lecture} ${parts.join(', ')}` : `L${lecture}`;
}

export function indexMarkdown(entries) {
  const shared = entries.filter((e) => e.uses.length > 1);
  const single = entries.filter((e) => e.uses.length === 1);
  const row = (e) => `- **${e.term}** — ${e.uses.map((u) => `[${formatRefs(u.lecture, u.slides)}]`).join(' ')}`
    + ` _(${e.sections.join(', ')})_`;
  return [
    '# Concept index',
    '',
    `${entries.length} terms · ${shared.length} appear in more than one lecture.`,
    '',
    '## In more than one lecture — merge candidates',
    '',
    ...(shared.length ? shared.map(row) : ['_none_']),
    '',
    '## In one lecture',
    '',
    ...(single.length ? single.map(row) : ['_none_']),
    '',
  ].join('\n');
}

