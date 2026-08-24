/**
 * A PDF writer, just large enough to test the PDF reader with.
 *
 * pdfjs is the one dependency in this project and the whole reason for it is that PDF text
 * extraction is genuinely hard, so testing `pdf.js` against a hand-made object instead of an actual
 * file would test nothing. This emits a real, if very plain, PDF: catalog, page tree, one Helvetica
 * font, and a content stream of positioned `Tj` operators — which is what a text-layer PDF is once
 * you strip everything optional away.
 *
 * Uncompressed and single-font on purpose. Compression and embedded fonts are pdfjs's problem, not
 * ours, and a fixture that exercised them would be testing the dependency.
 */

/** `(` `)` and `\` are the only characters that need escaping inside a PDF literal string. */
const escape = (s) => String(s).replace(/([\\()])/g, '\\$1');

/**
 * @param {Array<Array<{x: number, y: number, size?: number, text: string}>>} pages
 *        one array of positioned text runs per page, in PDF user space (origin bottom-left)
 */
export function makePdf(pages) {
  const objects = [];
  const add = (body) => objects.push(body) && objects.length; // returns the 1-based object number

  // Object numbers are assigned up front because the page tree and its pages reference each other.
  const catalog = 1;
  const tree = 2;
  const font = 3;
  const firstPage = 4;
  const pageNums = pages.map((_, i) => firstPage + i * 2);
  const contentNums = pages.map((_, i) => firstPage + i * 2 + 1);

  add(`<< /Type /Catalog /Pages ${tree} 0 R >>`);
  add(`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  pages.forEach((runs, i) => {
    add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`);
    const stream = runs
      .map((r) => `BT /F1 ${r.size ?? 12} Tf 1 0 0 1 ${r.x} ${r.y} Tm (${escape(r.text)}) Tj ET`)
      .join('\n');
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });

  // Serialize, recording where each object starts — the cross-reference table is byte offsets, and
  // getting them wrong is the one way to produce a file that looks fine and will not open.
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\n`
    + `startxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}
