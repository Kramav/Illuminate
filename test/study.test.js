/**
 * The study-sheet pipeline's checks.
 *
 * These functions exist to catch what a model writing notes does silently — skip a slide, cite one
 * that does not exist, merge a citation away — so each is tested by failing it on purpose, not only
 * by passing it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readPptx } from '../src/pptx.js';
import { decodeSymbol, symbolChar } from '../src/symbol.js';
import {
  buildLecture, classify, lectureNumber, slidesMarkdown, parseCitations, coverage, preservation,
  conceptIndex, indexMarkdown, formatRefs, notesStamp, readStamp, templateVersion, noteBullets, scriptedText,
} from '../src/study.js';
import { lectureReview, sheetReview } from '../src/review.js';
import { lectureDeck } from './helpers.js';

const lecture = () => buildLecture({
  source: 'Lecture7_Optimisation.pptx',
  sha256: 'ab'.repeat(32),
  sections: readPptx(lectureDeck()),
});

/** A minimal lecture record with `n` plain slides, for the citation checks. */
const plain = (n, { number = 4, hidden = [] } = {}) => ({
  lecture: number,
  slides: Array.from({ length: n }, (_, i) => ({ number: i + 1, hidden: hidden.includes(i + 1), title: '', lines: [], notes: [], visuals: {}, reasons: [] })),
});

/* -------------------------------------------------------------------------- */
/* Extraction                                                                 */
/* -------------------------------------------------------------------------- */

test('study: a lecture number comes from the file name, not the run order', () => {
  assert.equal(lectureNumber('Lecture5_Classification_2026.pptx'), 5);
  assert.equal(lectureNumber('lec-12 intro.pptx'), 12);
  assert.equal(lectureNumber('03 Search.pptx'), 3);
  // The year must not be mistaken for a lecture number.
  assert.equal(lectureNumber('Intro_2026.pptx'), null);
});

test('study: each slide says why it needs an image, or that it does not', () => {
  const L = lecture();
  assert.deepEqual(L.slides.map((s) => s.reasons), [['equation'], ['little-text'], []]);
  assert.deepEqual(classify({ title: 'x', lines: [], visuals: { pictures: 1, groups: 2 } }), ['picture', 'diagram', 'little-text']);
});

test('study: subscripts are written out, Greek is decoded, notes stay apart from the slide', () => {
  const L = lecture();
  const text = L.slides[0].lines.map((l) => l.text);
  assert.ok(text.includes('w_{ij} is a weight'), text.join(' / '));
  assert.ok(text.includes('the learning rate η'));
  assert.equal(scriptedText({ text: 'x2', runs: [{ text: 'x' }, { text: '2', script: 'sup' }] }), 'x^{2}');
  assert.deepEqual(L.slides[0].notes, []);
  assert.equal(L.lecture, 7);
});

test('study: slides.md names every slide the way a citation does, with its images', () => {
  const md = slidesMarkdown(lecture());
  assert.match(md, /^## s1 · Gradient Descent$/m);
  assert.match(md, /^## s2 · Backup material \(hidden\)$/m);
  assert.match(md, /\[image-needed: equation → images\/s001\.png\]/);
  assert.match(md, /\[equation 1 \(Equation\.3\) → images\/s001-eq1\.png\]/);
  assert.ok(!/## s3[^\n]*\n[\s\S]*?image-needed[\s\S]*?## /.test(md), 'a text-only slide asked for an image');
});

test('study: a run of identical diagram labels is one line with a count', () => {
  const L = { lecture: 1, source: 'x.pptx', sha256: 'cd'.repeat(32), slides: [{
    number: 1, title: 'Scatter', hidden: false, notes: [], visuals: {}, reasons: ['diagram'],
    lines: ['X', 'X', 'X', 'O', 'X'].map((text) => ({ text, level: 0 })),
  }] };
  assert.match(slidesMarkdown(L), /^- X \(×3\)\n- O\n- X\n/m);
});

test('symbol: the table is the Symbol font\'s, at both ends and in the middle', () => {
  assert.equal(symbolChar(0x20), ' ');
  assert.equal(symbolChar(0x61), 'α');
  assert.equal(symbolChar(0x53), 'Σ');
  assert.equal(symbolChar(0x7e), '∼');
  assert.equal(symbolChar(0xa3), '≤');
  assert.equal(symbolChar(0xe5), '∑');
  assert.equal(symbolChar(0xfe), '⎭');
  assert.equal(symbolChar(0xf0), null);
  assert.equal(decodeSymbol('a', { sym: true }), 'aβ', 'a symbol font maps only private-use codes');
  assert.equal(decodeSymbol('ab', { latin: true }), 'αβ', 'a Symbol text font maps the plain keys');
  assert.equal(decodeSymbol('', {}), '', 'without a Symbol font nothing is touched');
});

/* -------------------------------------------------------------------------- */
/* Citations                                                                  */
/* -------------------------------------------------------------------------- */

test('citations: single, range, list, and a lecture that carries forward', () => {
  const { refs, bad } = parseCitations('a [s3] b [s5-7] c [s9, s11-12] d [L3 s4; s6, L5 s2]', { lecture: 1 });
  assert.deepEqual(bad, []);
  assert.deepEqual(refs.map((r) => `${r.lecture}:${r.slide}`),
    ['1:3', '1:5', '1:6', '1:7', '1:9', '1:11', '1:12', '3:4', '3:6', '5:2']);
});

test('citations: what the grammar does not allow is reported, not guessed at', () => {
  assert.deepEqual(parseCitations('[s3 and s5]').bad, ['[s3 and s5]']);
  assert.deepEqual(parseCitations('[s9-4]').bad, ['[s9-4]'], 'a backwards range');
  assert.deepEqual(parseCitations('[s1-500]').bad, ['[s1-500]'], 'a range no passage spans');
  assert.deepEqual(parseCitations('a [link](x) and [see above]').refs, [], 'ordinary brackets are not citations');
});

test('coverage: every slide cited or skipped passes', () => {
  const notes = '## Concepts\n- **A** — x [s1-2]\n- **B** — y [s4]\n\n## Skipped\n- [s3] title slide\n';
  const c = coverage(plain(4), notes);
  assert.equal(c.ok, true);
  assert.deepEqual([...c.skipped], [3]);
});

test('coverage: a forgotten slide, an invented one, and a malformed citation all fail', () => {
  const c = coverage(plain(4), '- **A** — x [s1-2]\n- **B** — y [s9]\n- **C** — z [s4 maybe]\n');
  assert.equal(c.ok, false);
  assert.deepEqual(c.missing, [3, 4]);
  assert.deepEqual(c.invalid, ['s9']);
  assert.deepEqual(c.malformed, ['[s4 maybe]']);
});

test('coverage: hidden slides are not required, and citing another lecture is invalid', () => {
  const c = coverage(plain(3, { hidden: [2] }), '- x [s1, s3]\n- y [L9 s1]\n');
  assert.deepEqual(c.missing, []);
  assert.deepEqual(c.invalid, ['L9 s1']);
});

test('preservation: the merge must keep every non-skipped citation, with its lecture', () => {
  const notes = [
    { lecture: 3, notes: '## Concepts\n- **A** — x [s1-2]\n## Skipped\n- [s3] title\n' },
    { lecture: 5, notes: '- **A** — again [s4]\n' },
  ];
  assert.equal(preservation(notes, '- **A** [L3 s1-2; L5 s4]').ok, true);

  const lost = preservation(notes, '- **A** [L3 s1]\n- **B** [s4]');
  assert.equal(lost.ok, false);
  assert.deepEqual(lost.dropped, [{ lecture: 3, slide: 2 }, { lecture: 5, slide: 4 }]);
  assert.equal(lost.unattributed, 1, 'a sheet citation without a lecture traces back to nothing');
});

/* -------------------------------------------------------------------------- */
/* Notes files, index, review                                                 */
/* -------------------------------------------------------------------------- */

test('notes: the stamp round-trips, and the template declares its version', () => {
  const stamp = notesStamp({ sha256: 'ab'.repeat(32), template: 3 });
  assert.deepEqual(readStamp(`${stamp}\n# Lecture 1`), { deck: 'abababababab', template: 3 });
  assert.equal(readStamp('# no stamp'), null);
  const template = readFileSync(new URL('../TEMPLATE.md', import.meta.url), 'utf8');
  assert.ok(templateVersion(template) >= 1, 'TEMPLATE.md has lost its version line');
});

test('notes: a bullet keeps its continuation lines and its section', () => {
  const bullets = noteBullets('## Worked examples\n- **XOR** — setup\n  step one [s4]\n\n## Formulas\n1. **Loss**: $E$ [s5]\n', { lecture: 2 });
  assert.deepEqual(bullets.map((b) => [b.section, b.refs.map((r) => r.slide)]), [['Worked examples', [4]], ['Formulas', [5]]]);
  assert.match(bullets[0].text, /step one/);
});

test('index: a term defined in two lectures is one entry with both, listed first', () => {
  const entries = conceptIndex([
    { lecture: 3, notes: '## Definitions\n- **Perceptrons** — a unit [s4]\n- **Bias** — offset [s5]\n' },
    { lecture: 5, notes: '## Definitions\n- **Perceptron (single-layer)** — again [s2-3]\n## Skipped\n- **Ignored** [s1]\n' },
  ]);
  assert.equal(entries[0].key, 'perceptron');
  assert.deepEqual(entries[0].uses, [{ lecture: 3, slides: [4] }, { lecture: 5, slides: [2, 3] }]);
  assert.ok(!entries.some((e) => e.key === 'ignored'), 'skipped slides are not concepts');
  assert.match(indexMarkdown(entries), /merge candidates\n\n- \*\*Perceptrons\*\* — \[L3 s4\] \[L5 s2-3\]/);
  assert.equal(formatRefs(2, [1, 2, 3, 7, 9, 10]), 'L2 s1-3, s7, s9-10');
});

test('review: formulas first, each beside its slide, and nothing from the notes runs as HTML', () => {
  const L = lecture();
  const html = lectureReview(L, '## Concepts\n- **Step** — <script>alert(1)</script> [s3]\n\n## Formulas\n- **Update**: $w - \\eta g$ [s1]\n',
    '- s2: illegible');
  assert.ok(html.indexOf('Update') < html.indexOf('Step'), 'formula bullets come first');
  assert.match(html, /src="images\/s001\.png"/);
  assert.match(html, /src="images\/s001-eq1\.png"/);
  assert.match(html, /Could not interpret[\s\S]*s2: illegible/);
  assert.ok(!html.includes('<script>alert'), 'note text was not escaped');
});

test('review: the sheet page resolves each lecture\'s images from its own folder', () => {
  const L = lecture();
  const html = sheetReview('## Optimisation\n- **Update** [L7 s1]\n', new Map([[7, { lecture: L, dir: 'lecture7-optimisation' }]]));
  assert.match(html, /src="lecture7-optimisation\/images\/s001\.png"/);
});

test('study: loose strokes or a crowd of labels make a slide a diagram; one of each does not', () => {
  const slide = (visuals) => classify({ title: 'A slide with plenty of explanatory text on it', lines: [], visuals });
  assert.deepEqual(slide({ drawn: 2 }), ['diagram']);
  assert.deepEqual(slide({ labels: 5 }), ['diagram']);
  assert.deepEqual(slide({ drawn: 1, labels: 4 }), []);
});
