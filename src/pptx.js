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
import { decode, elements, tableRows } from './xml.js';
import { decodeSymbol } from './symbol.js';

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
      const text = decodeSymbol(elements(run, 'a:t').map(decode).join(''), {
        sym: /<a:sym\b[^>]*\btypeface="Symbol"/.test(run),
        latin: /<a:latin\b[^>]*\btypeface="Symbol"/.test(run),
      });
      if (!text) continue;
      const bold = /<a:rPr[^>]*\bb="(?:1|true)"/.test(run);
      // Superscript and subscript are a baseline shift on an ordinary run, which is how a lecture
      // types w_ij or x^k outside an equation object. Flattened, "x^k" reads as "xk" — so the shift
      // is kept on the run for readers that can say it, and the text itself is left alone.
      const baseline = Number(/<a:rPr[^>]*\bbaseline="(-?\d+)"/.exec(run)?.[1] ?? 0);
      runs.push(baseline ? { text, bold, script: baseline > 0 ? 'sup' : 'sub' } : { text, bold });
    }
    if (runs.length) out.push({ text: runs.map((r) => r.text).join(''), runs, level });
  }
  return out;
}

/**
 * A slide's tables, one line per row, cells joined by tabs.
 *
 * Tables were invisible before this: `shapesOf` splits on `<p:sp>`, and a table is not one — it
 * hangs off a `<p:graphicFrame>` instead. So a slide whose content was a term table produced no
 * lines at all, which is worse than producing bad ones. There was no card, no residue, and nothing
 * for the model pass to read either, so a deck built on tables converted to an empty file with
 * nothing to say why.
 *
 * The tab is the same device the PDF reader uses for a column gutter, and for the same reason: a
 * table row *is* a term and its definition side by side, and `splitTermDef` already knows how to
 * read that. Nothing new is needed downstream.
 */
function tableLines(xml) {
  return tableRows(xml, { table: 'a:tbl', row: 'a:tr', cell: 'a:tc' })
    .map((cells) => cells.map((cell) => linesOf(cell).map((l) => l.text).join(' ').trim()))
    .filter((cells) => cells.some(Boolean))
    // One run, unbolded, exactly as the PDF reader emits a tab-joined line: the tab is the signal
    // here, and a per-cell bold flag would only give `splitBoldLead` a second opinion about a split
    // the tab has already settled.
    .map((cells) => ({ text: cells.join('\t'), runs: [{ text: cells.join('\t'), bold: false }], level: 0 }));
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

/**
 * The slides in the order the presentation shows them.
 *
 * File names are not that order. `slideN.xml` is a part name, and the deck's actual sequence is the
 * `sldIdLst` in presentation.xml — a slide moved in PowerPoint can keep its old file name, and every
 * citation after it would then point one slide off. The numeric file-name sort survives only as the
 * fallback for an archive without a presentation part, which real decks always have.
 */
function slideOrder(zip) {
  const byName = zip.names()
    .filter((n) => SLIDE_PATH.test(n))
    // Numeric sort: string order would put slide10 immediately after slide1.
    .sort((a, b) => Number(SLIDE_PATH.exec(a)[1]) - Number(SLIDE_PATH.exec(b)[1]));

  if (!zip.has('ppt/presentation.xml') || !zip.has('ppt/_rels/presentation.xml.rels')) return byName;
  const pres = zip.read('ppt/presentation.xml').toString('utf8');
  const rels = zip.read('ppt/_rels/presentation.xml.rels').toString('utf8');
  const target = new Map();
  for (const [rel] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(rel)?.[1];
    const to = /\bTarget="([^"]+)"/.exec(rel)?.[1];
    // Relative to ppt/ ("slides/slide1.xml"), or absolute ("/ppt/slides/slide1.xml").
    if (id && to) target.set(id, to.startsWith('/') ? to.slice(1) : `ppt/${to}`);
  }
  const ordered = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
    .map((m) => target.get(m[1]))
    .filter((name) => name && zip.has(name));
  return ordered.length ? ordered : byName;
}

/** Slide dimensions in EMU, so a shape's position can be stated as a fraction of the slide. */
function slideSize(zip) {
  const pres = zip.has('ppt/presentation.xml') ? zip.read('ppt/presentation.xml').toString('utf8') : '';
  const m = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(pres);
  // 4:3 at PowerPoint's default size, which is what a deck without the element was drawn on.
  return m ? { cx: Number(m[1]), cy: Number(m[2]) } : { cx: 9144000, cy: 6858000 };
}

/**
 * Drop the fallback half of every `mc:AlternateContent`.
 *
 * PowerPoint writes anything a reader might not understand twice — once as the real object
 * (`mc:Choice`), once as a picture of it (`mc:Fallback`). Read both and every equation counts as an
 * equation *and* a picture, and a text box saved this way has its text read twice. The choice is the
 * truth; the fallback is a rendering of it.
 *
 * ponytail: non-greedy, so a fallback nested inside a fallback would close early. PowerPoint writes
 * AlternateContent one level deep; a nested one would leave a stray fragment, not lose content.
 */
const withoutFallbacks = (xml) => xml.replace(/<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>/g, '');

/** A frame's box as fractions of the slide — what a renderer needs to crop it from a page image. */
function boxOf(xml, size) {
  const off = /<a:off\b[^>]*\bx="(-?\d+)"[^>]*\by="(-?\d+)"/.exec(xml);
  const ext = /<a:ext\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(xml);
  if (!off || !ext) return null;
  const r = (n) => Math.round(n * 10000) / 10000;
  return {
    x: r(Number(off[1]) / size.cx),
    y: r(Number(off[2]) / size.cy),
    w: r(Number(ext[1]) / size.cx),
    h: r(Number(ext[2]) / size.cy),
  };
}

/**
 * What on a slide the text reader cannot see.
 *
 * Everything counted here either has no text at all (a picture, an embedded equation) or has text
 * whose meaning is in its arrangement (a chart, a diagram drawn from grouped shapes and connectors).
 * The counts are what lets a later stage send only the slides that need looking at as images — and,
 * more importantly, say so, rather than presenting a slide's text as all there was.
 *
 * Embedded equations are listed one by one with their boxes. In older decks they are Equation
 * Editor 3.0 or MathType OLE objects, which carry no text a reader can use — only a picture — so the
 * box is what lets each one be cropped from the rendered slide and read on its own.
 */
function visualsOf(xml, size) {
  const frames = xml.split(/<p:graphicFrame[\s>]/).slice(1).map((chunk) => {
    const end = chunk.indexOf('</p:graphicFrame>');
    return end < 0 ? chunk : chunk.slice(0, end);
  });
  const equations = [];
  let objects = 0;
  let charts = 0;
  let smartart = 0;
  for (const frame of frames) {
    const progId = /<p:oleObj\b[^>]*\bprogId="([^"]+)"/.exec(frame)?.[1];
    if (progId && /^Equation\./i.test(progId)) equations.push({ kind: progId, box: boxOf(frame, size) });
    else if (/<p:oleObj\b/.test(frame)) objects++;
    if (/drawingml\/2006\/chart"/.test(frame)) charts++;
    if (/drawingml\/2006\/diagram"/.test(frame)) smartart++;
  }
  // A diagram drawn shape by shape — a freehand class boundary, an arrow, a brace — is ungrouped and
  // has no connectors, so neither count above sees it. Two other things give it away: shapes with a
  // geometry but no text (the strokes), and a crowd of one- to three-character text boxes (the
  // points of a scatter plot, the labels on axes). A text slide has neither.
  const shapes = shapesOf(xml);
  const textOf = (shape) => elements(shape, 'a:t').map(decode).join('').trim();
  const drawn = shapes.filter((shape) => !textOf(shape)
    && (/<a:custGeom[\s>/]/.test(shape) || /<a:prstGeom\b[^>]*\bprst="(?!rect")/.test(shape))).length;
  const labels = shapes.filter((shape) => {
    const text = textOf(shape);
    return text && text.length <= 3;
  }).length;
  return {
    drawn,
    labels,
    pictures: (xml.match(/<p:pic[\s>]/g) ?? []).length,
    charts,
    smartart,
    equations,
    // ponytail: native Office Math is counted, not read — `linesOf` takes `<a:r>` runs and an
    // equation's runs are `<m:r>`, so its text is absent from the lines. Counting it routes the slide
    // to an image instead of letting the gap pass silently. An OMML → LaTeX reader is the upgrade,
    // worth building when a deck that uses native equations arrives (the 2026 decks use none).
    math: (xml.match(/<a14:m[\s>]/g) ?? []).length,
    objects,
    groups: (xml.match(/<p:grpSp[\s>]/g) ?? []).length,
    connectors: (xml.match(/<p:cxnSp[\s>]/g) ?? []).length,
  };
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
 * Read a deck into sections, one per slide, in the order the presentation shows them.
 *
 * `ref` and `number` are the slide's position in that order — the number PowerPoint displays — so a
 * citation of `slide-7` is the seventh slide a student pages to, hidden slides included. `hidden`
 * and `visuals` are extra: the card rules ignore them, the study-sheet pipeline depends on them.
 *
 * @param {Buffer} buf
 * @returns {Array<{ title: string, ref: string, number: number, hidden: boolean, lines: Array,
 *   notes: string, visuals: object }>}
 */
export function readPptx(buf) {
  const zip = openZip(buf);
  const slides = slideOrder(zip);
  if (!slides.length) throw new Error('no slides found — is this really a .pptx?');
  const size = slideSize(zip);

  return slides.map((name, i) => {
    const raw = zip.read(name).toString('utf8');
    const xml = withoutFallbacks(raw);
    const shapes = shapesOf(xml).filter((shape) => !CHROME_PH.test(shape));
    const titleShape = shapes.find((shape) => TITLE_PH.test(shape));
    const body = shapes.filter((shape) => shape !== titleShape);
    return {
      title: titleShape ? linesOf(titleShape).map((l) => l.text).join(' ').trim() : '',
      ref: `slide-${i + 1}`,
      number: i + 1,
      hidden: /<p:sld\b[^>]*\bshow="(?:0|false)"/.test(raw),
      // Tables come after the shapes rather than in their position on the slide: they live outside
      // the `<p:sp>` sequence entirely, so there is no shared order to interleave them into without
      // walking the tree. Within a section the order only affects which line answers a question
      // line, and a table row carries its own answer.
      lines: [...body.flatMap(linesOf), ...tableLines(xml)],
      notes: notesText(zip, notesPathFor(zip, name)),
      visuals: visualsOf(xml, size),
    };
  });
}
