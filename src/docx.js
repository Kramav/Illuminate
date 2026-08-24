/**
 * Word documents.
 *
 * A .docx has no slides to divide it, so headings are the section boundary — which is also how the
 * author already divided it. Text before the first heading becomes its own untitled section rather
 * than being discarded or folded into the first real one.
 *
 * Tabs are preserved as tabs. In a Word document a tab is frequently the separator in a hand-made
 * glossary ("Osmosis→the movement of water…"), and it is a far more reliable term/definition marker
 * than any punctuation, so it is worth carrying through instead of collapsing into a space.
 */

import { openZip } from './zip.js';
import { decode, elements } from './xml.js';

const HEADING = /^(?:Heading[1-9]|Title|Subtitle)$/i;

/** Run content in document order: text elements and tabs, interleaved as they appear. */
function runText(run) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>/g;
  let m;
  while ((m = re.exec(run)) !== null) out += m[1] === undefined ? '\t' : decode(m[1]);
  return out;
}

function paragraphsOf(xml) {
  return elements(xml, 'w:p').map((para) => {
    const props = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(para)?.[1] ?? '';
    const style = /<w:pStyle[^>]*\bw:val="([^"]*)"/.exec(props)?.[1] ?? '';
    const level = Number(/<w:ilvl[^>]*\bw:val="(\d+)"/.exec(props)?.[1] ?? 0);
    const runs = [];
    for (const run of elements(para, 'w:r')) {
      const text = runText(run);
      if (!text) continue;
      const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? '';
      // `<w:b w:val="0"/>` is how Word switches bold *off* inside a bold paragraph style. Matching
      // the bare tag alone would read those runs as bold and invert the emphasis.
      const bold = /<w:b\s*\/>|<w:b[^>]*\bw:val="(?:1|true|on)"/.test(rPr);
      runs.push({ text, bold });
    }
    return { style, level, runs, text: runs.map((r) => r.text).join('') };
  });
}

/**
 * Read a document into sections, split at headings.
 *
 * @param {Buffer} buf
 * @returns {Array<{ title: string, ref: string, lines: Array, notes: string }>}
 */
export function readDocx(buf) {
  const zip = openZip(buf);
  if (!zip.has('word/document.xml')) throw new Error('no document body found — is this really a .docx?');
  const paragraphs = paragraphsOf(zip.read('word/document.xml').toString('utf8'));

  const sections = [];
  const open = (title) => {
    sections.push({ title, ref: `sec-${sections.length + 1}`, lines: [], notes: '' });
    return sections[sections.length - 1];
  };
  let current = null;

  for (const para of paragraphs) {
    if (HEADING.test(para.style) && para.text.trim()) {
      current = open(para.text.trim());
      continue;
    }
    if (!para.runs.length) continue;
    if (!current) current = open('');
    current.lines.push({ text: para.text, runs: para.runs, level: para.level });
  }

  if (!sections.length) throw new Error('this document has no text in it');
  return sections;
}
