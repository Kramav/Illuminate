/** The formats: a real archive, read back through the real reader. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openZip } from '../src/zip.js';
import { readPptx } from '../src/pptx.js';
import { readDocx } from '../src/docx.js';
import { buildDoc } from '../src/doc.js';
import { makeZip, para, slideXml, wpara, documentXml } from './helpers.js';

test('zip: reads stored and deflated entries alike', () => {
  const long = 'the mitochondrion is the powerhouse of the cell. '.repeat(40);
  const zip = openZip(makeZip({ 'a.txt': 'hi', 'b/c.txt': long }));
  assert.deepEqual(zip.names().sort(), ['a.txt', 'b/c.txt']);
  assert.equal(zip.read('a.txt').toString(), 'hi');
  assert.equal(zip.read('b/c.txt').toString(), long);
});

test('zip: rejects a file that is not one, and names that are not there', () => {
  assert.throws(() => openZip(Buffer.alloc(100)), /not a zip file/);
  const zip = openZip(makeZip({ 'a.txt': 'hi' }));
  assert.throws(() => zip.read('nope.txt'), /not in this archive/);
});

function pptx() {
  return makeZip({
    'ppt/slides/slide1.xml': slideXml('Cell Biology', [
      para([['Osmosis', true], [' the movement of water across a membrane', false]]),
      para([['Diffusion: movement from high to low concentration', false]]),
    ]),
    'ppt/slides/slide2.xml': slideXml('Respiration', [
      para([['Glycolysis — the breakdown of glucose into pyruvate', false]]),
    ]),
    // Deliberately out of string order: slide10 sorts before slide2 as text, and if the parser
    // sorted that way every slide reference in the finished deck would be wrong.
    'ppt/slides/slide10.xml': slideXml('Summary', [para([['That is all', false]])]),
    'ppt/slides/_rels/slide1.xml.rels':
      '<Relationships><Relationship Id="rId1" Type="http://x/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
    'ppt/notesSlides/notesSlide1.xml': slideXml('', [
      para([['A membrane is selectively permeable, which is what makes osmosis directional.', false]]),
    ]),
  });
}

test('pptx: slides in numeric order, titles separated from body', () => {
  const sections = readPptx(pptx());
  assert.deepEqual(sections.map((s) => s.title), ['Cell Biology', 'Respiration', 'Summary']);
  assert.deepEqual(sections.map((s) => s.ref), ['slide-1', 'slide-2', 'slide-3']);
  assert.ok(!sections[0].lines.some((l) => l.text.includes('Cell Biology')),
    'the title must not also appear as a body line');
});

test('pptx: keeps bold runs distinct, and reads speaker notes', () => {
  const [first] = readPptx(pptx());
  const bolded = first.lines.find((l) => l.runs[0].bold);
  assert.equal(bolded.runs[0].text, 'Osmosis');
  assert.equal(bolded.runs[1].bold, false);
  assert.match(first.notes, /selectively permeable/);
});

test('pptx: the slide-number placeholder never becomes content', () => {
  const doc = buildDoc('deck.pptx', readPptx(pptx()));
  const all = doc.sections.flatMap((s) => s.lines.map((l) => l.text)).join('\n');
  assert.ok(!all.includes('CONFIDENTIAL DRAFT'), 'footer placeholder leaked into the body');
});

test('docx: headings open sections, bold survives, tabs survive', () => {
  const buf = makeZip({
    'word/document.xml': documentXml([
      wpara([['Front matter before any heading', false]]),
      wpara([['Glossary', false]], 'Heading1'),
      wpara([['Osmosis\tthe movement of water', false]]),
      wpara([['Enzyme', true], [' a biological catalyst', false]]),
    ]),
  });
  const sections = readDocx(buf);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, '');
  assert.equal(sections[1].title, 'Glossary');
  assert.ok(sections[1].lines[0].text.includes('\t'), 'tab separator was collapsed away');
  assert.equal(sections[1].lines[1].runs[0].bold, true);
});

test('docx: <w:b w:val="0"/> is not bold', () => {
  const buf = makeZip({
    'word/document.xml': documentXml([
      `<w:p><w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>Not bold at all</w:t></w:r></w:p>`,
    ]),
  });
  assert.equal(readDocx(buf)[0].lines[0].runs[0].bold, false);
});

test('doc: a line on most slides is furniture and gets dropped', () => {
  const sections = Array.from({ length: 6 }, (_, i) => ({
    title: `Slide ${i + 1}`,
    ref: `slide-${i + 1}`,
    notes: '',
    lines: [
      { runs: [{ text: 'Dr. Kramer · BIO 101 · Spring', bold: false }] },
      { runs: [{ text: `real content ${i}`, bold: false }] },
    ],
  }));
  const doc = buildDoc('deck.pptx', sections);
  const all = doc.sections.flatMap((s) => s.lines.map((l) => l.text));
  assert.ok(!all.some((t) => t.includes('Dr. Kramer')), 'repeated footer survived');
  assert.equal(all.length, 6);
});

test('doc: bullet glyphs and page numbers go away', () => {
  const doc = buildDoc('deck.pptx', [{
    title: 'T',
    ref: 'slide-1',
    notes: '',
    lines: [
      { runs: [{ text: '• Osmosis', bold: true }, { text: ' is water movement', bold: false }] },
      { runs: [{ text: '12', bold: false }] },
    ],
  }]);
  assert.equal(doc.sections[0].lines.length, 1);
  assert.equal(doc.sections[0].lines[0].runs[0].text, 'Osmosis');
});

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

/** A DrawingML table cell, and a row of them. */
const acell = (text) => `<a:tc><a:txBody>${para([[text, false]])}</a:txBody></a:tc>`;
const atable = (rows) => `<a:tbl>${rows.map((cells) => `<a:tr>${cells.map(acell).join('')}</a:tr>`).join('')}</a:tbl>`;

/** A slide holding a table, which hangs off a graphicFrame rather than a shape. */
const tableSlide = (title, rows) => `<?xml version="1.0"?>
<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
    <p:txBody>${para([[title, false]])}</p:txBody></p:sp>
  <p:graphicFrame><a:graphic><a:graphicData>${atable(rows)}</a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>`;

test('pptx: a table becomes rows, not nothing at all', () => {
  // A table is not a `<p:sp>`, so the shape walk never saw one — a slide whose content was a term
  // table produced no lines, no residue, and nothing for the model pass to read either.
  const [slide] = readPptx(makeZip({
    'ppt/slides/slide1.xml': tableSlide('Terms', [
      ['Osmosis', 'the movement of water across a membrane'],
      ['Diffusion', 'movement from high to low concentration'],
    ]),
  }));

  assert.equal(slide.lines.length, 2, 'the table was dropped');
  assert.equal(slide.lines[0].text ?? slide.lines[0].runs[0].text,
    'Osmosis\tthe movement of water across a membrane');
});

test('pptx: a table and the slide body both survive together', () => {
  const xml = tableSlide('Terms', [['Osmosis', 'water movement']])
    .replace('<p:graphicFrame>', `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
      <p:txBody>${para([['Covered in the lab', false]])}</p:txBody></p:sp><p:graphicFrame>`);
  const [slide] = readPptx(makeZip({ 'ppt/slides/slide1.xml': xml }));

  const texts = slide.lines.map((l) => l.runs.map((r) => r.text).join(''));
  assert.ok(texts.includes('Covered in the lab'), 'the body shape was lost to the table');
  assert.ok(texts.some((t) => t.startsWith('Osmosis\t')), 'the table was lost to the body shape');
});

/** A Word table cell, and a row of them. */
const wcell = (text) => `<w:tc><w:tcPr/>${wpara([[text, false]])}</w:tc>`;
const wtable = (rows) => `<w:tbl><w:tblPr/>${
  rows.map((cells) => `<w:tr>${cells.map(wcell).join('')}</w:tr>`).join('')}</w:tbl>`;

test('docx: a two-column table is a glossary, not four loose lines', () => {
  // The ordinary way to write a glossary in Word. The cell walls used to vanish, leaving term and
  // definition as unrelated lines that paired with nothing.
  const [section] = readDocx(makeZip({
    'word/document.xml': documentXml([
      wpara([['Glossary', false]], 'Heading1'),
      wtable([['Osmosis', 'the movement of water across a membrane']]),
    ]),
  }));

  assert.equal(section.title, 'Glossary');
  assert.equal(section.lines.length, 1);
  assert.equal(section.lines[0].text, 'Osmosis\tthe movement of water across a membrane');
});

test('docx: a table\'s paragraphs are not also counted on their own', () => {
  // `paragraphsOf` walks every <w:p> in the file, cells included — so emitting rows *as well* would
  // put every entry into the deck twice, once paired and once in pieces.
  const [section] = readDocx(makeZip({
    'word/document.xml': documentXml([wtable([['Osmosis', 'water movement']])]),
  }));
  assert.equal(section.lines.length, 1, `double-counted: ${JSON.stringify(section.lines.map((l) => l.text))}`);
});

test('docx: text before, inside and after a table keeps its order', () => {
  const [section] = readDocx(makeZip({
    'word/document.xml': documentXml([
      wpara([['Before the table', false]]),
      wtable([['Osmosis', 'water movement']]),
      wpara([['After the table', false]]),
    ]),
  }));
  assert.deepEqual(section.lines.map((l) => l.text),
    ['Before the table', 'Osmosis\twater movement', 'After the table']);
});

test('docx: a tab typed inside a cell is not a second column break', () => {
  const [section] = readDocx(makeZip({
    'word/document.xml': documentXml([wtable([['Osmosis', 'water\tmovement']])]),
  }));
  // The cell wall is the boundary; a tab within a cell is the author's spacing, not their structure.
  assert.equal(section.lines[0].text, 'Osmosis\twater movement');
});
