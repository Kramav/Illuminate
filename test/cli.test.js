/**
 * The binary itself, spawned as a real process.
 *
 * Everything else in this suite imports from `src/` and tests a function. That left argument
 * parsing, the multi-file loop, `--min` and `--out` — all of `illuminate.js` — as the only code in
 * the repository no test had ever executed, which is exactly where the cross-file duplicate bug
 * lived: each file was internally clean, and nothing looked at the deck they added up to.
 *
 * So these run the command the way a user does, and assert on the exit code, on what it said, and
 * on the file it left behind.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { makeZip, para, slideXml } from './helpers.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../illuminate.js', import.meta.url));

/** A two-slide deck with one card per slide, plus prose no rule will take. */
const DECK = makeZip({
  '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
  'ppt/slides/slide1.xml': slideXml('Cell Transport', [
    para([['Osmosis — the movement of water across a membrane', false]]),
    para([['Cells do a great many things, and this sentence is prose that no rule should ever '
      + 'turn into a card, it simply runs on.', false]]),
  ]),
  'ppt/slides/slide2.xml': slideXml('Enzymes', [
    para([['Catalyst — a substance that speeds a reaction up', false]]),
  ]),
});

/**
 * Run the CLI in a scratch directory.
 *
 * `cwd` matters: the tool writes its default output beside nothing in particular, and a test that
 * let it write into the repository would leave files behind and pass on a dirty tree.
 */
function inTempDir(fn) {
  return async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'illuminate-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const cli = (...args) => run(process.execPath, [CLI, ...args], { cwd: dir });
    await fn({ dir, cli, t, write: (name, bytes) => writeFileSync(join(dir, name), bytes) });
  };
}

/** execFile rejects on a non-zero exit; the error carries the streams and the code. */
async function failing(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  return assert.fail('expected a non-zero exit');
}

test('writes a deck beside the input, named after it', inTempDir(async ({ dir, cli, write }) => {
  write('lecture3.pptx', DECK);
  const { stderr } = await cli('lecture3.pptx');

  assert.match(stderr, /wrote 2 cards to lecture3\.txt/);
  const out = readFileSync(join(dir, 'lecture3.txt'), 'utf8');
  assert.match(out, /^#separator:Tab/);
  assert.match(out, /\tOsmosis\t/);
}));

test('--dry-run prints the deck and writes nothing', inTempDir(async ({ dir, cli, write }) => {
  write('lecture3.pptx', DECK);
  const { stdout } = await cli('lecture3.pptx', '--dry-run');

  assert.match(stdout, /\tOsmosis\t/);
  assert.ok(!existsSync(join(dir, 'lecture3.txt')), 'a dry run left a file behind');
}));

test('--format picks the writer and the extension together', inTempDir(async ({ dir, cli, write }) => {
  write('lecture3.pptx', DECK);
  await cli('lecture3.pptx', '--format', 'quizlet');

  const out = readFileSync(join(dir, 'lecture3.tsv'), 'utf8');
  assert.ok(!out.includes('#separator'), 'Quizlet would read a directive line as a card');
}));

test('--out is honoured verbatim', inTempDir(async ({ dir, cli, write }) => {
  write('lecture3.pptx', DECK);
  await cli('lecture3.pptx', '--out', 'bio.txt');
  assert.ok(existsSync(join(dir, 'bio.txt')));
}));

test('--tag lands on every card', inTempDir(async ({ cli, write }) => {
  write('lecture3.pptx', DECK);
  const { stdout } = await cli('lecture3.pptx', '--dry-run', '--tag', 'bio101');

  const rows = stdout.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(rows.length, 2);
  for (const row of rows) assert.match(row, /bio101/);
}));

test('--version and --help answer without needing a file', inTempDir(async ({ cli }) => {
  const { stdout: version } = await cli('--version');
  assert.match(version.trim(), /^\d+\.\d+\.\d+$/);

  const { stdout: help } = await cli('--help');
  assert.match(help, /--residue/);
}));

test('no arguments prints usage and exits non-zero', inTempDir(async ({ cli }) => {
  const err = await failing(cli());
  assert.equal(err.code, 1);
  assert.match(err.stdout, /turn slides, documents and PDFs/);
}));

/* -------------------------------------------------------------------------- */
/* Refusals — each one has to say something the user can act on               */
/* -------------------------------------------------------------------------- */

test('a bad --format or --llm names what was expected', inTempDir(async ({ cli, write }) => {
  write('lecture3.pptx', DECK);

  const format = await failing(cli('lecture3.pptx', '--format', 'apkg'));
  assert.match(format.stderr, /unknown format "apkg".*anki, quizlet, json/);

  const llm = await failing(cli('lecture3.pptx', '--llm', 'gpt'));
  assert.match(llm.stderr, /unknown --llm "gpt".*ollama/);
}));

test('--min that is not a number is refused, not ignored', inTempDir(async ({ cli, write }) => {
  write('lecture3.pptx', DECK);

  // `Number('abc')` is NaN and `2 < NaN` is false, so an unvalidated --min silently writes the deck
  // it was told to withhold — the failure mode this guard exists to prevent.
  // `--min=-1` rather than `--min -1`: parseArgs reads a bare leading dash as another option and
  // rejects it with its own message, so the `=` form is the one that reaches this guard at all.
  for (const bad of ['abc', '2.5', '', '--min=-1']) {
    const args = bad.startsWith('--') ? [bad] : ['--min', bad];
    const err = await failing(cli('lecture3.pptx', ...args, '--dry-run'));
    assert.match(err.stderr, /--min must be a whole number of cards/, `--min ${bad} was accepted`);
    assert.equal(err.stdout, '', `--min ${bad} printed a deck anyway`);
  }
}));

test('--min refuses a deck that is too small, and writes nothing',
  inTempDir(async ({ dir, cli, write }) => {
    write('lecture3.pptx', DECK);
    const err = await failing(cli('lecture3.pptx', '--min', '50'));

    assert.match(err.stderr, /only 2 cards — below --min 50/);
    assert.ok(!existsSync(join(dir, 'lecture3.txt')));
  }));

test('a missing file, a bad extension, and a missing output directory each say so',
  inTempDir(async ({ cli, write }) => {
    const missing = await failing(cli('nope.pptx'));
    assert.match(missing.stderr, /illuminate: no such file: nope\.pptx/);
    assert.ok(!/ENOENT/.test(missing.stderr), `leaked Node's own error: ${missing.stderr}`);

    const unknown = await failing(cli('notes.key'));
    assert.match(unknown.stderr, /cannot read \.key files \(known: \.pptx, \.docx, \.pdf\)/);

    write('lecture3.pptx', DECK);
    const nodir = await failing(cli('lecture3.pptx', '--out', 'nodir/deck.txt'));
    assert.match(nodir.stderr, /the directory does not exist/);
    assert.ok(!/ENOENT/.test(nodir.stderr), `leaked Node's own error: ${nodir.stderr}`);
  }));

/* -------------------------------------------------------------------------- */
/* The bug this file exists for                                               */
/* -------------------------------------------------------------------------- */

test('two files sharing a question both survive, and the deck still imports',
  inTempDir(async ({ cli, write }) => {
    write('lecture3.pptx', DECK);
    write('lecture4.pptx', DECK);
    const { stdout, stderr } = await cli('lecture3.pptx', 'lecture4.pptx', '--dry-run');

    const rows = stdout.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.equal(rows.length, 4, 'a card was dropped instead of disambiguated');
    assert.match(stderr, /appeared in more than one file/);

    const fronts = rows.map((r) => r.split('\t')[1]);
    assert.deepEqual(new Set(fronts).size, 4, `repeated front in ${fronts.join(', ')}`);
    // The first file's cards are the ones a learner already has; they must not move.
    assert.ok(fronts.includes('Osmosis'), 'the first occurrence was renamed');
    assert.ok(fronts.includes('Osmosis (lecture4)'), `unexpected suffix in ${fronts.join(', ')}`);

    const ids = rows.map((r) => r.split('\t')[0]);
    assert.equal(new Set(ids).size, 4, 'two cards share an id');
  }));

test('converting a file alone or in a batch produces the same card for it',
  inTempDir(async ({ cli, write }) => {
    write('lecture3.pptx', DECK);
    write('lecture4.pptx', DECK);

    const alone = (await cli('lecture3.pptx', '--dry-run')).stdout;
    const batch = (await cli('lecture3.pptx', 'lecture4.pptx', '--dry-run')).stdout;

    const rows = (s) => s.split('\n').filter((l) => l && !l.startsWith('#'));
    // Byte-identical rows, ids included — adding another lecture to the command line must not
    // renumber cards the learner is already studying.
    for (const row of rows(alone)) {
      assert.ok(rows(batch).includes(row), `"${row.split('\t')[1]}" changed when batched`);
    }
  }));

/**
 * The contract test, at the CLI level.
 *
 * `write.test.js` already feeds a hand-built deck through QuickMathPlus's parser. This feeds it a
 * file the binary actually produced from two overlapping inputs — the case that used to fail the
 * import outright, and the one no unit test was positioned to see.
 */
test('the multi-file deck imports into QuickMathPlus', inTempDir(async ({ dir, cli, write, t }) => {
  const url = new URL('../../QuickMathPlus/www/src/cards.js', import.meta.url);
  if (!existsSync(fileURLToPath(url))) {
    return t.skip('QuickMathPlus is not checked out beside this repo');
  }

  write('lecture3.pptx', DECK);
  write('lecture4.pptx', DECK);
  await cli('lecture3.pptx', 'lecture4.pptx', '--out', 'combined.txt');

  const { parseSet } = await import(url.href);
  const set = parseSet(readFileSync(join(dir, 'combined.txt'), 'utf8'), { name: 'combined.txt' });
  assert.equal(set.cards.length, 4);
}));
