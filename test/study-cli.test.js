/**
 * The study command, spawned as a real process against a real deck in a scratch folder.
 *
 * Resumability is a property of the files a run leaves behind and what the next run makes of them,
 * so it is only testable here: run, run again, change something, run again.
 *
 * Rendering needs LibreOffice, which CI does not have. The one end-to-end render test runs only when
 * ILLUMINATE_SOFFICE points at it; everything else uses --no-render.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { lectureDeck, makeZip, para, slideXml } from './helpers.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../study.js', import.meta.url));
const LECTURE = 'lecture7-optimisation';

function inTempDir(fn) {
  return async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'illuminate-study-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'Lecture7_Optimisation.pptx'), lectureDeck());
    const study = (...args) => run(process.execPath, [CLI, ...args], { cwd: dir });
    const failing = async (...args) => {
      try {
        await study(...args);
      } catch (err) {
        return err;
      }
      return assert.fail('expected a non-zero exit');
    };
    const read = (...p) => readFileSync(join(dir, 'out', ...p), 'utf8');
    const write = (p, text) => writeFileSync(join(dir, 'out', ...p), text);
    await fn({ dir, study, failing, read, write });
  };
}

/** Notes that account for all three slides of the fixture deck. */
async function goodNotes(study) {
  const { stdout: stamp } = await study('stamp', 'out', '7');
  return `${stamp.trim()}\n# Lecture 7 — Optimisation\n\n## Formulas\n- **Update**: $w - \\eta g$ [s1]\n\n`
    + '## Concepts\n- **Descent** — follows the negative gradient [s3]\n\n## Skipped\n- [s2] backup slide\n';
}

test('study build: writes the lecture folder, and a second run skips it', inTempDir(async ({ study, read }) => {
  const first = await study('build', 'Lecture7_Optimisation.pptx', '--out', 'out', '--no-render');
  assert.match(first.stderr, /extracted 3 slides, 2 need an image/);
  assert.match(read(LECTURE, 'slides.md'), /^## s1 · Gradient Descent$/m);
  const manifest = JSON.parse(read(LECTURE, 'manifest.json'));
  assert.equal(manifest.extract.slides, 3);
  assert.equal(JSON.parse(read(LECTURE, 'slides.json')).lecture, 7);

  const second = await study('build', 'Lecture7_Optimisation.pptx', '--out', 'out', '--no-render');
  assert.match(second.stderr, /extract current/);

  const forced = await study('build', 'Lecture7_Optimisation.pptx', '--out', 'out', '--no-render', '--force');
  assert.match(forced.stderr, /extracted 3 slides/);
}));

test('study build: a changed deck is re-extracted, and its notes are reported stale', inTempDir(async ({ dir, study, write }) => {
  await study('build', 'Lecture7_Optimisation.pptx', '--out', 'out', '--no-render');
  write([LECTURE, 'notes.md'], await goodNotes(study));
  assert.match((await study('status', 'out')).stdout, /current\s+not rendered\s+current\s+ok/);

  writeFileSync(join(dir, 'Lecture7_Optimisation.pptx'), makeZip({
    'ppt/slides/slide1.xml': slideXml('Gradient Descent', [para([['now with different content', false]])]),
  }));
  assert.match((await study('status', 'out')).stdout, /stale: deck changed/);
  const rebuilt = await study('build', 'Lecture7_Optimisation.pptx', '--out', 'out', '--no-render');
  assert.match(rebuilt.stderr, /extracted 1 slides/);
  assert.match((await study('status', 'out')).stdout, /stale: deck changed/, 'the notes were written from the old deck');
}));

test('study coverage: fails without notes, fails on a forgotten slide, passes on complete notes', inTempDir(async ({ study, failing, write }) => {
  await study('build', 'Lecture7_Optimisation.pptx', '--out', 'out', '--no-render');
  assert.match((await failing('coverage', 'out')).stdout, /no notes\.md yet/);

  const notes = await goodNotes(study);
  // s2 is the hidden slide, which is not required; forgetting s3 is what must fail.
  write([LECTURE, 'notes.md'], notes.replace('- **Descent** — follows the negative gradient [s3]\n', ''));
  const forgot = await failing('coverage', 'out', '7');
  assert.equal(forgot.code, 1);
  assert.match(forgot.stdout, /FAIL[\s\S]*not accounted for: s3/);

  write([LECTURE, 'notes.md'], notes);
  assert.match((await study('coverage', 'out', LECTURE)).stdout, /ok — 2 cited, 1 skipped, of 3 slides/);
}));

test('study index, review and the sheet check work from the notes alone', inTempDir(async ({ study, failing, read, write }) => {
  await study('build', 'Lecture7_Optimisation.pptx', '--out', 'out', '--no-render');
  write([LECTURE, 'notes.md'], await goodNotes(study));

  await study('index', 'out');
  assert.match(read('index.md'), /\*\*Update\*\* — \[L7 s1\]/);

  await study('review', 'out');
  assert.match(read(LECTURE, 'review.html'), /images\/s001-eq1\.png/);

  write(['study-sheet.md'], '## Optimisation\n- **Update** [L7 s1]\n');
  const dropped = await failing('coverage', 'out', '--sheet');
  assert.match(dropped.stdout, /dropped: L7 s3/);

  write(['study-sheet.md'], '## Optimisation\n- **Update** [L7 s1]\n- **Descent** [L7 s3]\n');
  assert.match((await study('coverage', 'out', '--sheet')).stdout, /study-sheet\.md: ok/);
  await study('review', 'out', '--sheet');
  assert.match(read('review.html'), /src="lecture7-optimisation\/images\/s003\.png"/);
}));

test('study: refusals say what to do', inTempDir(async ({ failing }) => {
  assert.match((await failing('build', 'Lecture7_Optimisation.pptx', '--no-render')).stderr, /needs --out/);
  assert.match((await failing('build', 'nope.pptx', '--out', 'out', '--no-render')).stderr, /no such file: nope\.pptx/);
  assert.match((await failing('frobnicate')).stderr, /unknown command "frobnicate"/);
  assert.match((await failing('coverage', 'missing-dir')).stderr, /no such folder/);
}));

/**
 * A three-slide presentation whose middle slide is hidden, as flat ODF — one XML file LibreOffice
 * opens directly. The hand-built fixture decks are only valid enough for our own reader; this one is
 * turned into a .pptx by LibreOffice itself, so the render test runs against a deck a real
 * application wrote.
 */
const FODP = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
 <office:automatic-styles>
  <style:style style:name="hidden" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style>
 </office:automatic-styles>
 <office:body><office:presentation>${['Gradient descent follows the negative gradient', 'Backup slide, hidden in class',
  'Summary of the optimisation lecture'].map((text, i) => `
  <draw:page draw:name="p${i + 1}"${i === 1 ? ' draw:style-name="hidden"' : ''}><draw:frame svg:x="2cm" svg:y="2cm"
    svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>${text}</text:p></draw:text-box></draw:frame></draw:page>`).join('')}
 </office:presentation></office:body>
</office:document>`;

test('study build renders every slide with LibreOffice, hidden ones included, then skips the render',
  { skip: !process.env.ILLUMINATE_SOFFICE && 'set ILLUMINATE_SOFFICE to run the LibreOffice render' },
  inTempDir(async ({ dir, study }) => {
    writeFileSync(join(dir, 'Lecture8_Hidden.fodp'), FODP);
    await run(process.env.ILLUMINATE_SOFFICE, ['--headless', '--convert-to', 'pptx', '--outdir', dir,
      join(dir, 'Lecture8_Hidden.fodp')], { timeout: 120_000 });

    const { stderr } = await study('build', 'Lecture8_Hidden.pptx', '--out', 'out');
    // LibreOffice's default export leaves the hidden slide out, which would make this 2 pages for
    // 3 slides and fail the page-count check — so this passing means hidden slides were exported.
    assert.match(stderr, /rendered 3 slides/);
    for (const n of ['001', '002', '003']) {
      assert.ok(existsSync(join(dir, 'out', 'lecture8-hidden', 'images', `s${n}.png`)), `s${n}.png missing`);
    }
    const slides = JSON.parse(readFileSync(join(dir, 'out', 'lecture8-hidden', 'slides.json'), 'utf8')).slides;
    assert.deepEqual(slides.map((s) => s.hidden), [false, true, false]);
    assert.match((await study('build', 'Lecture8_Hidden.pptx', '--out', 'out')).stderr, /render current/);
  }));
