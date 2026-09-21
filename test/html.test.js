/**
 * Web pages, read back through the real reader.
 *
 * The fixtures are shaped after what actually produces HTML notes rather than after tidy markup: a
 * site's chrome around an article, Google Docs' class-only bold and its `font-weight:normal` wrapper,
 * Word's windows-1252 output, and hand-written pages that leave their end tags off.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readHtml } from '../src/html.js';
import { buildDoc } from '../src/doc.js';
import { extract } from '../src/cards.js';

const read = (html) => readHtml(Buffer.from(html, 'utf8'));
const textOf = (sections) => sections.flatMap((s) => s.lines.map((l) => l.text));
const cardsOf = (html) => extract(buildDoc('notes.html', read(html))).cards
  .map((c) => [c.front, c.back]);

test('html: headings open sections, bold survives, head and scripts are not content', () => {
  const sections = read(`<!doctype html>
    <html><head><title>BIO 101</title>
      <script>const s = "<h1>not a heading</h1>";</script>
    </head><body>
      <p>Front matter before any heading</p>
      <h2>Cell <em>Transport</em></h2>
      <p><strong>Osmosis</strong> the movement of water across a membrane</p>
      <p>Diffusion — movement from high to low concentration</p>
    </body></html>`);

  assert.deepEqual(sections.map((s) => s.title), ['', 'Cell Transport']);
  assert.deepEqual(sections.map((s) => s.ref), ['sec-1', 'sec-2']);
  const [bolded] = sections[1].lines;
  assert.deepEqual(bolded.runs[0], { text: 'Osmosis', bold: true });
  assert.equal(bolded.runs[1].bold, false);
  const all = textOf(sections).join('\n');
  assert.ok(!all.includes('not a heading') && !all.includes('BIO 101'), all);
});

test('html: site furniture is dropped, an article keeps its own header and callouts', () => {
  const sections = read(`<body>
    <header><a href="/">Course Site</a></header>
    <nav><ul><li>Home — the start page</li></ul></nav>
    <aside>Sidebar: popular posts</aside>
    <article>
      <header><h1>Cell Transport</h1></header>
      <p>Osmosis — the movement of water across a membrane</p>
      <aside><p>Diffusion — movement from high to low concentration</p></aside>
      <p hidden>Hidden — should not appear</p>
      <p aria-hidden="true">Aria — should not appear</p>
      <p style="color:red; display: none">Invisible — should not appear</p>
      <noscript>Enable JavaScript — to continue</noscript>
    </article>
    <footer>© 2026 Course Site</footer>
  </body>`);

  assert.deepEqual(sections.map((s) => s.title), ['Cell Transport']);
  assert.deepEqual(textOf(sections), [
    'Osmosis — the movement of water across a membrane',
    'Diffusion — movement from high to low concentration',
  ]);
});

test('html: a page with <main> is read only inside it', () => {
  const sections = read(`<body>
    <div class="banner">Welcome — to the course portal</div>
    <main><h1>Enzymes</h1><p>Catalyst — a substance that speeds a reaction up</p></main>
    <div class="legal">Terms — of service</div>
  </body>`);
  assert.deepEqual(textOf(sections), ['Catalyst — a substance that speeds a reaction up']);
});

test('html: a table row is one line, its cells separated by tabs', () => {
  const sections = read(`<h2>Glossary</h2>
    <table>
      <thead><tr><th>Term</th><th>Definition</th></tr></thead>
      <tbody>
        <tr><td>Osmosis</td><td><p>the movement of water</p><p>across a membrane</p></td></tr>
        <tr><td>Diffusion<td>movement from high to low concentration
      </tbody>
    </table>`);

  assert.deepEqual(textOf(sections), [
    'Term\tDefinition',
    'Osmosis\tthe movement of water across a membrane',
    'Diffusion\tmovement from high to low concentration',
  ]);
});

test('html: a table nested in a cell stays in that cell, and the outer rows survive', () => {
  // The Office readers lose an outer table's remaining rows here (see the ponytail in xml.js). A
  // stack does not have that limit, so this reader is held to the better behaviour.
  const sections = read(`<table>
    <tr><td>Enzyme</td><td>a catalyst <table><tr><td>see</td><td>chapter 4</td></tr></table></td></tr>
    <tr><td>Substrate</td><td>what an enzyme acts on</td></tr>
  </table>`);

  assert.deepEqual(textOf(sections), [
    'Enzyme\ta catalyst see chapter 4',
    'Substrate\twhat an enzyme acts on',
  ]);
});

test('html: a definition list is a glossary, and becomes one', () => {
  const html = `<dl>
    <dt>Osmosis</dt><dd>the movement of water across a membrane</dd>
    <dt>Diffusion<dd>movement from high to low concentration<dd>driven by a gradient
  </dl>`;
  assert.deepEqual(textOf(read(html)), [
    'Osmosis\tthe movement of water across a membrane',
    'Diffusion\tmovement from high to low concentration driven by a gradient',
  ]);
  assert.deepEqual(cardsOf(html), [
    ['Osmosis', 'the movement of water across a membrane'],
    ['Diffusion', 'movement from high to low concentration driven by a gradient'],
  ]);
});

test('html: end tags left off close where a browser would close them', () => {
  const sections = read(`<ul>
      <li>Osmosis — water across a membrane
      <li>Diffusion — solutes down a gradient
        <ul><li>Facilitated diffusion — through a channel protein</ul>
    </ul>
    <p>First paragraph<p>Second paragraph`);

  const lines = sections[0].lines;
  assert.deepEqual(lines.map((l) => l.text.trim()), [
    'Osmosis — water across a membrane',
    'Diffusion — solutes down a gradient',
    'Facilitated diffusion — through a channel protein',
    'First paragraph',
    'Second paragraph',
  ]);
  assert.deepEqual(lines.map((l) => l.level), [0, 0, 1, 0, 0]);
});

test('html: Google Docs bold — inline weights, class weights, and the font-weight:normal wrapper', () => {
  // Copied from Docs: the whole selection sits inside a <b> that switches bold back off.
  const [copied] = read(`<b style="font-weight:normal;" id="docs-internal-guid-1a2b">
    <p><span style="font-weight:700">Osmosis</span><span style="font-weight:400"> the movement of water</span></p>
  </b>`)[0].lines;
  assert.deepEqual(copied.runs.map((r) => r.bold), [true, false]);

  // Exported from Docs: no <b> anywhere, only generated classes.
  const exported = `<html><head><style type="text/css">
      .c0{margin:0} .c1{color:#000;font-weight:700} .c2{font-weight:400;color:#000}
      /* .c2{font-weight:700} — a comment, not a rule */
    </style></head><body>
      <p class="c0"><span class="c1">Enzyme</span><span class="c2"> a biological catalyst</span></p>
    </body></html>`;
  assert.deepEqual(read(exported)[0].lines[0].runs.map((r) => r.bold), [true, false]);
  assert.deepEqual(cardsOf(exported), [['Enzyme', 'a biological catalyst']]);
});

test('html: entities decode, and source indentation never becomes a column', () => {
  const [line, glucose, odd, greek] = textOf(read(`
    <p>Osmosis&nbsp;&mdash; the movement of water&hellip; in caf&eacute;s</p>
    <p>Glucose\t\tC&#8326;H&#x2081;&#x2082;O&#8326;</p>
    <p>&constructor; &#99999999; &notanentity;</p>
    <p>&yuml; &times; &Omega; &omega; &sigmaf;</p>`));

  assert.equal(line, 'Osmosis — the movement of water… in cafés');
  assert.equal(glucose, 'Glucose C₆H₁₂O₆', 'a tab in the source is indentation, not a boundary');
  assert.equal(odd, '&constructor; &#99999999; &notanentity;');
  assert.equal(greek, 'ÿ × Ω ω ς');
});

test('html: Word\'s windows-1252 output decodes, so its em dashes still split cards', () => {
  const ascii = (s) => Buffer.from(s, 'latin1');
  const page = Buffer.concat([
    ascii('<html><head><meta http-equiv=Content-Type content="text/html; charset=windows-1252"></head>'),
    ascii('<body><p class=MsoNormal>Osmosis '), Buffer.from([0x97]),
    ascii(' the '), Buffer.from([0x93]), ascii('movement'), Buffer.from([0x94]),
    ascii(' of water in a caf'), Buffer.from([0xe9]), ascii('<o:p></o:p></p></body></html>'),
  ]);
  const doc = buildDoc('notes.htm', readHtml(page));
  assert.equal(doc.sections[0].lines[0].text, 'Osmosis — the “movement” of water in a café');
  assert.deepEqual(extract(doc).cards.map((c) => c.front), ['Osmosis']);
});

test('html: a page declaring iso-8859-1 is read as windows-1252, as browsers read it', () => {
  // The bytes at 0x80–0x9F are where the two differ, and where Node 20's own decoder got it wrong:
  // it returned control characters for them, which CI caught.
  const page = Buffer.concat([
    Buffer.from('<meta charset="ISO-8859-1"><p>', 'latin1'),
    Buffer.from([0x80, 0x20, 0x85, 0x20, 0x99, 0x20, 0x9f, 0x20, 0x81]),
    Buffer.from('</p>', 'latin1'),
  ]);
  assert.equal(readHtml(page)[0].lines[0].text, '€ … ™ Ÿ \u0081');
});

test('html: <pre> keeps its line breaks and its tabs', () => {
  assert.deepEqual(textOf(read('<pre>Osmosis\twater across a membrane\nDiffusion\tdown a gradient</pre>')), [
    'Osmosis\twater across a membrane',
    'Diffusion\tdown a gradient',
  ]);
});

test('html: a page with nothing to read says what to do about it', () => {
  // The shape a single-page app saves as: a script and an empty mount point.
  assert.throws(() => read('<html><body><div id="root"></div><script src="app.js"></script></body></html>'),
    /no readable text.*print it to PDF/);
});
