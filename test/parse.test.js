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
