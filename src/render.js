/**
 * Slide images, from a PDF of the deck.
 *
 * The PDF comes from LibreOffice (see the root study.js), because nothing in Node can lay out a
 * PowerPoint slide — but once it is a PDF, pdfjs already draws it, and `@napi-rs/canvas` gives it
 * somewhere to draw. So a slide image costs no renderer of our own, only the page-to-PNG step here.
 *
 * Equations get a second, larger render. The decks this was built for store every equation as an
 * Equation Editor or MathType object — a picture with no text behind it — so reading the formula
 * means reading pixels, and a subscript at slide scale is a few pixels tall. Cropping each equation's
 * box out of a high-resolution render gives the reader something it can actually make out.
 *
 * Pure: bytes in, PNG buffers out.
 */

import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';

/** Bumped when the images this produces change, so earlier renders are reported stale. */
export const RENDER_VERSION = 1;

/** Width of a full-slide image. Enough to read body text; small enough that 300 of them are cheap. */
export const SLIDE_WIDTH = 1600;
/** Width the page is drawn at before an equation is cropped out of it. */
const CROP_PAGE_WIDTH = 4800;
/** Margin around an equation's box, as a fraction of the page — frames are often drawn tight. */
const PAD = 0.01;

/** How many pages, without drawing any — the check that page N really is slide N. */
export async function pageCount(pdf) {
  const task = open(pdf);
  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy();
  }
}

/** A loading task — what pdfjs (v6) lets you destroy, rather than the document it resolves to. */
const open = (pdf) => pdfjs.getDocument({ data: new Uint8Array(pdf), verbosity: 0, isEvalSupported: false });

async function draw(page, width) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  // White first: a PDF page with no background paints onto transparency, which reads as black in
  // some viewers and makes dark text vanish.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  return canvas;
}

function crop(canvas, box) {
  const x = Math.max(0, Math.floor((box.x - PAD) * canvas.width));
  const y = Math.max(0, Math.floor((box.y - PAD) * canvas.height));
  const w = Math.min(canvas.width - x, Math.ceil((box.w + 2 * PAD) * canvas.width));
  const h = Math.min(canvas.height - y, Math.ceil((box.h + 2 * PAD) * canvas.height));
  if (w < 4 || h < 4) return null;
  const out = createCanvas(w, h);
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return out.toBuffer('image/png');
}

/**
 * Render each slide, and each of its equations, to PNG.
 *
 * `slides` is the lecture's slide list: page `number` is drawn, and any `visuals.equations` with a
 * box are cropped from a high-resolution render of the same page. Yields one slide at a time so a
 * 115-slide deck is never held in memory as images all at once.
 *
 * @param {Buffer} pdf
 * @param {Array<{number: number, visuals?: {equations?: Array<{box: object|null}>}}>} slides
 */
export async function* renderSlides(pdf, slides, { width = SLIDE_WIDTH } = {}) {
  const task = open(pdf);
  try {
    const doc = await task.promise;
    for (const slide of slides) {
      if (slide.number > doc.numPages) throw new Error(`the PDF has no page ${slide.number}`);
      const page = await doc.getPage(slide.number);
      const png = (await draw(page, width)).toBuffer('image/png');
      const boxes = (slide.visuals?.equations ?? []).map((eq) => eq.box);
      let equations = [];
      if (boxes.some(Boolean)) {
        const big = await draw(page, CROP_PAGE_WIDTH);
        equations = boxes.map((box) => (box ? crop(big, box) : null));
      }
      page.cleanup();
      yield { number: slide.number, png, equations };
    }
  } finally {
    await task.destroy();
  }
}
