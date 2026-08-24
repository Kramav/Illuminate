/**
 * PowerPoint decks.
 *
 * One section per slide: its title, its bullets, and its speaker notes. Notes are read because in a
 * lecture deck they are often where the actual definitions live — the slide says "Mitochondria" and
 * the notes say what one is. A parser that only read the visible text would leave the better half
 * of the content on the floor.
 *
 * Runs are kept rather than flattened to a string, because a bold lead-in ("**Osmosis** — movement
 * of water across…") is the single strongest term marker in real slides, and concatenating `<a:t>`
 * elements throws that signal away before anything can use it.
 */

import { openZip } from './zip.js';
import { decode, elements } from './xml.js';

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;

/** Placeholder types that hold a slide's title. */
const TITLE_PH = /<p:ph[^>]*\btype="(?:ctrTitle|title)"/;
/** Placeholder types that are deck furniture, never content. */
const CHROME_PH = /<p:ph[^>]*\btype="(?:sldNum|dt|ftr)"/;

/**
 * Split a slide into its shapes.
 *
 * ponytail: shapes inside a group (`<p:grpSp>`) are still matched individually, because the split is
 * on the opening tag rather than on tree structure — which is what we want. The real limit is a
 * `<p:sp>` nested inside another `<p:sp>`, which PowerPoint does not produce.
 */
function shapesOf(xml) {
  return xml.split(/<p:sp[\s>]/).slice(1).map((chunk) => {
    const end = chunk.indexOf('</p:sp>');
    return end < 0 ? chunk : chunk.slice(0, end);
  });
}

/** A DrawingML paragraph becomes one line: its indent level and its runs. */
function linesOf(xml) {
  const out = [];
  for (const para of elements(xml, 'a:p')) {
    const level = Number(/<a:pPr[^>]*\blvl="(\d+)"/.exec(para)?.[1] ?? 0);
    const runs = [];
    for (const run of elements(para, 'a:r')) {
      // Only `<a:r>` runs are collected, which quietly excludes `<a:fld>` — the element holding
      // auto-updating slide numbers and dates. Those carry an `<a:t>` too and would otherwise
      // arrive as a line of body text on every single slide.
      const text = elements(run, 'a:t').map(decode).join('');
      if (!text) continue;
      const bold = /<a:rPr[^>]*\bb="(?:1|true)"/.test(run);
      runs.push({ text, bold });
    }
    if (runs.length) out.push({ text: runs.map((r) => r.text).join(''), runs, level });
  }
  return out;
}

/** Where slideN's notes live, per its relationship file. */
function notesPathFor(zip, slideName) {
  const relsName = slideName.replace(/([^/]+)$/, '_rels/$1.rels');
  if (!zip.has(relsName)) return null;
  const rels = zip.read(relsName).toString('utf8');
  const target = /Target="([^"]*notesSlide[^"]*)"/.exec(rels)?.[1];
  if (!target) return null;
  // Targets are relative to the slide's own directory: "../notesSlides/notesSlide1.xml".
  return `ppt/${target.replace(/^\.\.\//, '')}`;
}

function notesText(zip, path) {
  if (!path || !zip.has(path)) return '';
  const xml = zip.read(path).toString('utf8');
  return shapesOf(xml)
    .filter((shape) => !CHROME_PH.test(shape))
    .flatMap((shape) => linesOf(shape).map((l) => l.text))
    .join('\n')
    .trim();
}

/**
 * Read a deck into sections, one per slide, in slide order.
 *
 * @param {Buffer} buf
 * @returns {Array<{ title: string, ref: string, lines: Array, notes: string }>}
 */
export function readPptx(buf) {
  const zip = openZip(buf);
  const slides = zip.names()
    .filter((n) => SLIDE_PATH.test(n))
    // Numeric sort: string order would put slide10 immediately after slide1, and every section
    // reference in the finished deck would name the wrong slide.
    .sort((a, b) => Number(SLIDE_PATH.exec(a)[1]) - Number(SLIDE_PATH.exec(b)[1]));

  if (!slides.length) throw new Error('no slides found — is this really a .pptx?');

  return slides.map((name, i) => {
    const xml = zip.read(name).toString('utf8');
    const shapes = shapesOf(xml).filter((shape) => !CHROME_PH.test(shape));
    const titleShape = shapes.find((shape) => TITLE_PH.test(shape));
    const body = shapes.filter((shape) => shape !== titleShape);
    return {
      title: titleShape ? linesOf(titleShape).map((l) => l.text).join(' ').trim() : '',
      ref: `slide-${i + 1}`,
      lines: body.flatMap(linesOf),
      notes: notesText(zip, notesPathFor(zip, name)),
    };
  });
}
