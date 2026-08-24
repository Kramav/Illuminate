/**
 * PDFs.
 *
 * This is the one format worth a dependency. A .pptx is a zip of XML and yields to a regex; a PDF is
 * a graph of indirect objects with its own compression, its own font encodings, and text positioned
 * by matrix rather than written in order — "extract the text" means reassembling lines from glyph
 * coordinates, and the correct-on-real-files version of that is thousands of lines. pdfjs is the
 * same engine Firefox renders PDFs with, so it has met every strange file already.
 *
 * What pdfjs does *not* do is decide what a line is. It hands back positioned fragments; grouping
 * them into lines and spotting the two-column layout of a glossary is this file's job, and it is the
 * reason PDFs can produce good cards at all. A plain text dump destroys that geometry — and with it
 * the only reliable signal that "Osmosis" and the paragraph 100pt to its right are a term and its
 * definition rather than one run-on sentence.
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Below this much text across the whole file, there is no text layer worth reading. */
const MIN_TEXT = 40;

/**
 * Group positioned fragments into lines.
 *
 * Same line means same baseline, within half a line's height — fragments on one visual line rarely
 * share a y value exactly, because superscripts, inline maths and font changes all nudge it.
 */
function linesFrom(items) {
  const glyphs = items
    .filter((it) => it.str && it.str.trim() !== '')
    .map((it) => ({ text: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || 10 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const glyph of glyphs) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - glyph.y) <= Math.max(2, glyph.h * 0.5)) {
      line.parts.push(glyph);
      line.h = Math.max(line.h, glyph.h);
    } else {
      lines.push({ y: glyph.y, h: glyph.h, parts: [glyph] });
    }
  }

  for (const line of lines) line.parts.sort((a, b) => a.x - b.x);
  return lines;
}

/**
 * Join one line's fragments, marking a column break with a tab.
 *
 * The tab is not cosmetic: `splitTermDef` already treats a tab as an explicit, deliberate separator
 * — that is how Word glossaries arrive — so turning the geometry into a tab here lets the layout of
 * a two-column PDF glossary use the rule that already exists instead of needing one of its own.
 *
 * A gap earns a tab only when it is wide relative to the type size. Word spacing is a fraction of the
 * font height; a column gutter is multiples of it, and scaling the threshold to the text means it
 * holds for a footnote and a heading alike.
 */
function textOf(line) {
  let out = line.parts[0].text;
  for (let i = 1; i < line.parts.length; i++) {
    const prev = line.parts[i - 1];
    const part = line.parts[i];
    const gap = part.x - (prev.x + prev.w);
    if (gap > Math.max(12, part.h * 1.5)) out += '\t';
    else if (gap > part.h * 0.15 && !/\s$/.test(out)) out += ' ';
    out += part.text;
  }
  return out;
}

/**
 * Read a PDF into sections, one per page.
 *
 * @param {Buffer} buf
 * @returns {Promise<Array<{title: string, ref: string, lines: Array, notes: string}>>}
 */
export async function readPdf(buf) {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  const sections = [];
  let total = 0;

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const lines = linesFrom((await page.getTextContent()).items)
      .map((line) => ({ text: textOf(line), h: line.h }))
      .filter((line) => line.text.trim() !== '');
    total += lines.reduce((sum, l) => sum + l.text.length, 0);

    // The biggest type on the page, if it is also at the top of it, is that page's heading. Font
    // size is the only thing a PDF preserves about a heading — the structure that said so is gone.
    const biggest = Math.max(0, ...lines.map((l) => l.h));
    const isTitle = lines.length > 1 && lines[0].h === biggest
      && biggest > (lines[1]?.h ?? 0) * 1.15 && lines[0].text.length <= 80;

    sections.push({
      title: isTitle ? lines[0].text : '',
      ref: `page-${n}`,
      notes: '',
      // ponytail: every run is reported unbolded. A PDF records bold as a different embedded font
      // whose name may or may not say so, which is a guess where the other formats have a flag —
      // and the column-gap tab above already covers the layout this would have helped with.
      lines: lines.slice(isTitle ? 1 : 0).map((l) => ({ runs: [{ text: l.text, bold: false }], level: 0 })),
    });
  }

  if (total < MIN_TEXT) {
    throw new Error(
      'this PDF has no text layer — it is probably scanned pages or images. '
      + 'Illuminate cannot read those (that needs OCR, which is not built).',
    );
  }

  return sections;
}
