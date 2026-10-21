#!/usr/bin/env node
/**
 * The study-sheet command line: slides in, a folder per lecture out, ready for notes to be written
 * against and checked.
 *
 * Every stage writes files and records what it was made from, so any stage of any lecture can be
 * re-run alone — and a stage whose inputs have not changed is skipped. Only this file touches the
 * disk or spawns anything; the logic is in src/study.js, src/render.js and src/review.js.
 *
 *   <out>/<lecture>/manifest.json   what each stage was built from (hashes and versions)
 *   <out>/<lecture>/slides.json     the extracted lecture
 *   <out>/<lecture>/slides.md       what the note-writer reads
 *   <out>/<lecture>/deck.pdf        LibreOffice's rendering of the deck
 *   <out>/<lecture>/images/         s007.png per slide, s007-eq1.png per equation
 *   <out>/<lecture>/notes.md        written from TEMPLATE.md — not by this tool
 *   <out>/<lecture>/unread.md       slides the notes could not interpret — not by this tool
 *   <out>/study-sheet.md            the merge — not by this tool
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, promisify } from 'node:util';

import { readPptx } from './src/pptx.js';
import { slugify } from './src/doc.js';
import {
  EXTRACTOR_VERSION, buildLecture, slidesMarkdown, coverage, preservation, conceptIndex, indexMarkdown,
  templateVersion, readStamp, notesStamp, imagePath, equationPath,
} from './src/study.js';
import { RENDER_VERSION, renderSlides, pageCount } from './src/render.js';
import { lectureReview, sheetReview } from './src/review.js';

const run = promisify(execFile);

const USAGE = `
study — turn lecture decks into a folder per lecture, ready for notes, and check the notes

  node study.js build <decks...> --out <dir> [--force] [--no-render] [--soffice <path>]
      extract each deck (slides.json, slides.md) and render its slides and equations to PNG;
      stages whose inputs are unchanged are skipped, --force redoes them
  node study.js status <dir>              one line per lecture: what is done, what is stale
  node study.js coverage <dir> [lecture...]
      every slide cited or listed as skipped, every citation real; exits 1 if not
  node study.js coverage <dir> --sheet    every citation in the notes survives into study-sheet.md
  node study.js index <dir>               index.md: terms across lectures, merge candidates first
  node study.js review <dir> [lecture...] review.html per lecture: each note beside its slide
  node study.js review <dir> --sheet      review.html for study-sheet.md
  node study.js stamp <dir> <lecture>     print the line notes.md must start with

  Rendering needs LibreOffice. It is found from --soffice, then $ILLUMINATE_SOFFICE, then PATH,
  then the usual install locations.
`.trim();

const TEMPLATE_PATH = new URL('./TEMPLATE.md', import.meta.url);

/* -------------------------------------------------------------------------- */
/* Small file helpers                                                         */
/* -------------------------------------------------------------------------- */

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Write via a temporary file and a rename, so an interrupted run never leaves half a file. */
function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);
const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

function currentTemplate() {
  const text = readText(TEMPLATE_PATH);
  const version = text && templateVersion(text);
  if (!version) throw new Error('TEMPLATE.md is missing or has no "<!-- illuminate-template vN -->" first line');
  return version;
}

/** Every lecture folder under `out`, in lecture order. */
function lecturesIn(out) {
  if (!existsSync(out)) throw new Error(`no such folder: ${out}`);
  return readdirSync(out, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(out, d.name, 'slides.json')))
    .map((d) => ({ dir: join(out, d.name), name: d.name, lecture: readJson(join(out, d.name, 'slides.json')) }))
    .sort((a, b) => (a.lecture.lecture ?? 1e9) - (b.lecture.lecture ?? 1e9) || a.name.localeCompare(b.name));
}

/** The lectures a command was pointed at — all of them when none are named. */
function selected(out, names) {
  const all = lecturesIn(out);
  if (!names.length) return all;
  return names.map((name) => {
    const found = all.find((l) => l.name === name || l.name === slugify(name) || String(l.lecture.lecture) === name);
    if (!found) throw new Error(`no lecture "${name}" in ${out} (have: ${all.map((l) => l.name).join(', ')})`);
    return found;
  });
}

/* -------------------------------------------------------------------------- */
/* LibreOffice                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where LibreOffice is.
 *
 * `soffice.com` on Windows rather than `soffice.exe`: the .exe returns immediately and leaves the
 * conversion running in the background, so the PDF would not exist yet when we went to read it.
 */
function findSoffice(flag) {
  const exe = process.platform === 'win32' ? 'soffice.com' : 'soffice';
  const candidates = [
    flag,
    process.env.ILLUMINATE_SOFFICE,
    ...String(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, exe)),
    'C:\\Program Files\\LibreOffice\\program\\soffice.com',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.com',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error('LibreOffice not found — install it, then pass --soffice <path to soffice'
      + `${process.platform === 'win32' ? '.com' : ''}> or set ILLUMINATE_SOFFICE (or use --no-render)`);
  }
  return found;
}

/**
 * Convert a deck to PDF with hidden slides included, so page N is slide N.
 *
 * PowerPoint's own export and LibreOffice's default both leave hidden slides out, which shifts every
 * page after the first hidden one — the one mismatch a page-count check catches but cannot repair.
 * A private profile keeps this from touching (or waiting on) a LibreOffice the user has open.
 */
async function toPdf(soffice, deck) {
  const work = mkdtempSync(join(tmpdir(), 'illuminate-render-'));
  try {
    const profile = pathToFileURL(join(tmpdir(), 'illuminate-libreoffice-profile')).href;
    const filter = 'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"},'
      + '"ExportNotesPages":{"type":"boolean","value":"false"}}';
    await run(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--nolockcheck',
      '--convert-to', filter, '--outdir', work, resolve(deck)], { timeout: 15 * 60_000, windowsHide: true });
    const pdf = join(work, `${basename(deck, extname(deck))}.pdf`);
    if (!existsSync(pdf)) throw new Error(`LibreOffice produced no PDF for ${basename(deck)}`);
    return readFileSync(pdf);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* build                                                                      */
/* -------------------------------------------------------------------------- */

async function build(decks, { out, force, render, soffice }) {
  if (!out) throw new Error('build needs --out <dir> — keep it outside the repository; it holds course material');
  if (!decks.length) throw new Error('build needs at least one .pptx');
  const sofficePath = render ? findSoffice(soffice) : null;
  const numbers = new Map();

  for (const deck of decks) {
    if (extname(deck).toLowerCase() !== '.pptx') throw new Error(`${deck}: only .pptx decks are supported here`);
    if (!existsSync(deck)) throw new Error(`no such file: ${deck}`);
    const bytes = readFileSync(deck);
    const hash = sha256(bytes);
    const dir = join(out, slugify(basename(deck)));
    const manifestPath = join(dir, 'manifest.json');
    const manifest = readJson(manifestPath) ?? {};
    const say = (msg) => console.error(`${basename(deck)}: ${msg}`);

    // Extract.
    let lecture = readJson(join(dir, 'slides.json'));
    const extracted = lecture && manifest.extract?.sha256 === hash && manifest.extract?.version === EXTRACTOR_VERSION;
    if (extracted && !force) {
      say(`extract current (${lecture.slides.length} slides)`);
    } else {
      lecture = buildLecture({ source: basename(deck), sha256: hash, sections: readPptx(bytes) });
      writeAtomic(join(dir, 'slides.json'), `${JSON.stringify(lecture, null, 1)}\n`);
      writeAtomic(join(dir, 'slides.md'), slidesMarkdown(lecture));
      manifest.source = resolve(deck);
      manifest.extract = { sha256: hash, version: EXTRACTOR_VERSION, slides: lecture.slides.length };
      // The render is left alone: it depends on the deck's bytes and the renderer, both of which it
      // records, not on how the text was read — so a re-extraction of an unchanged deck keeps it.
      writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const needing = lecture.slides.filter((s) => s.reasons.length).length;
      say(`extracted ${lecture.slides.length} slides, ${needing} need an image`);
    }
    if (lecture.lecture == null) say('warning: no lecture number in the file name — citations will read "L? sN"');
    if (numbers.has(lecture.lecture) && lecture.lecture != null) {
      throw new Error(`${basename(deck)} and ${numbers.get(lecture.lecture)} both read as lecture ${lecture.lecture}`);
    }
    numbers.set(lecture.lecture, basename(deck));

    if (!render) continue;

    // Render.
    const expected = lecture.slides.flatMap((s) => [imagePath(s.number),
      ...(s.visuals.equations ?? []).map((eq, k) => (eq.box ? equationPath(s.number, k + 1) : null)).filter(Boolean)]);
    const rendered = manifest.render?.sha256 === hash && manifest.render?.version === RENDER_VERSION
      && expected.every((p) => existsSync(join(dir, p)));
    if (rendered && !force) {
      say('render current');
      continue;
    }
    say('rendering with LibreOffice…');
    const pdf = await toPdf(sofficePath, deck);
    const pages = await pageCount(pdf);
    if (pages !== lecture.slides.length) {
      throw new Error(`${basename(deck)}: the PDF has ${pages} pages for ${lecture.slides.length} slides — `
        + 'slide images would not line up with slide numbers, so nothing was rendered');
    }
    writeAtomic(join(dir, 'deck.pdf'), pdf);
    rmSync(join(dir, 'images'), { recursive: true, force: true });
    mkdirSync(join(dir, 'images'), { recursive: true });
    let crops = 0;
    for await (const { number, png, equations } of renderSlides(pdf, lecture.slides)) {
      writeFileSync(join(dir, imagePath(number)), png);
      equations.forEach((eq, k) => {
        if (eq) writeFileSync(join(dir, equationPath(number, k + 1)), eq);
        if (eq) crops++;
      });
    }
    manifest.render = { sha256: hash, version: RENDER_VERSION, pages, crops };
    writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    say(`rendered ${pages} slides and ${crops} equation crops`);
  }
}

/* -------------------------------------------------------------------------- */
/* status, coverage, index, review, stamp                                     */
/* -------------------------------------------------------------------------- */

function notesState(entry, template) {
  const notes = readText(join(entry.dir, 'notes.md'));
  if (notes === null) return { label: 'missing' };
  const stamp = readStamp(notes);
  if (!stamp) return { label: 'no stamp', notes };
  if (!entry.lecture.sha256.startsWith(stamp.deck)) return { label: 'stale: deck changed', notes };
  if (stamp.template !== template) return { label: `stale: template v${stamp.template}→v${template}`, notes };
  return { label: 'current', notes, current: true };
}

function status(out) {
  const template = currentTemplate();
  const rows = [['lecture', 'slides', 'images', 'extract', 'render', 'notes', 'coverage']];
  for (const entry of lecturesIn(out)) {
    const { lecture } = entry;
    const manifest = readJson(join(entry.dir, 'manifest.json')) ?? {};
    const extractOk = manifest.extract?.version === EXTRACTOR_VERSION && manifest.extract?.sha256 === lecture.sha256;
    let source = 'source missing';
    if (manifest.source && existsSync(manifest.source)) {
      source = sha256(readFileSync(manifest.source)) === lecture.sha256 ? '' : 'deck changed';
    }
    const renderOk = manifest.render?.version === RENDER_VERSION && manifest.render?.sha256 === lecture.sha256;
    const notes = notesState(entry, template);
    const cov = notes.notes == null ? '—' : (() => {
      const c = coverage(lecture, notes.notes);
      return c.ok ? 'ok' : `${c.missing.length} missing, ${c.invalid.length + c.malformed.length} bad`;
    })();
    rows.push([
      `L${lecture.lecture ?? '?'} ${entry.name}`,
      String(lecture.slides.length),
      String(lecture.slides.filter((s) => s.reasons.length).length),
      extractOk ? (source ? `stale: ${source}` : 'current') : 'stale',
      renderOk ? 'current' : manifest.render ? 'stale' : 'not rendered',
      notes.label,
      cov,
    ]);
  }
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  for (const row of rows) console.log(row.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
  const sheet = readText(join(out, 'study-sheet.md'));
  console.log(`\nstudy-sheet.md: ${sheet === null ? 'not written' : 'present — check with: coverage <dir> --sheet'}`);
  return 0;
}

function checkCoverage(out, names) {
  let failed = 0;
  for (const entry of selected(out, names)) {
    const notes = readText(join(entry.dir, 'notes.md'));
    const tag = `L${entry.lecture.lecture ?? '?'} ${entry.name}`;
    if (notes === null) {
      console.log(`${tag}: no notes.md yet`);
      failed++;
      continue;
    }
    const c = coverage(entry.lecture, notes);
    const total = entry.lecture.slides.length;
    const hidden = entry.lecture.slides.filter((s) => s.hidden).length;
    console.log(`${tag}: ${c.ok ? 'ok' : 'FAIL'} — ${c.cited.size} cited, ${c.skipped.size} skipped, of ${total} slides`
      + `${hidden ? ` (${hidden} hidden, not required)` : ''}`);
    if (c.missing.length) console.log(`  not accounted for: ${c.missing.map((n) => `s${n}`).join(', ')}`);
    if (c.invalid.length) console.log(`  cites slides that do not exist: ${c.invalid.join(', ')}`);
    if (c.malformed.length) console.log(`  unreadable citations: ${c.malformed.join(' ')}`);
    if (!c.ok) failed++;
  }
  return failed ? 1 : 0;
}

function notesByLecture(out) {
  return lecturesIn(out)
    .map((entry) => ({ entry, lecture: entry.lecture.lecture, notes: readText(join(entry.dir, 'notes.md')) }))
    .filter((n) => n.notes !== null);
}

function checkSheet(out) {
  const sheet = readText(join(out, 'study-sheet.md'));
  if (sheet === null) throw new Error(`no study-sheet.md in ${out}`);
  const all = notesByLecture(out);
  const p = preservation(all, sheet);
  console.log(`study-sheet.md: ${p.ok ? 'ok' : 'FAIL'} — checked against ${all.length} lectures' notes`);
  if (p.dropped.length) {
    const byLecture = new Map();
    for (const d of p.dropped) byLecture.set(d.lecture, [...(byLecture.get(d.lecture) ?? []), d.slide]);
    for (const [lecture, slides] of byLecture) console.log(`  dropped: L${lecture} ${slides.map((s) => `s${s}`).join(', ')}`);
  }
  if (p.unattributed) console.log(`  ${p.unattributed} citation(s) with no lecture — write them as [L3 s12]`);
  if (p.malformed.length) console.log(`  unreadable citations: ${p.malformed.join(' ')}`);
  return p.ok ? 0 : 1;
}

function writeIndex(out) {
  const entries = conceptIndex(notesByLecture(out));
  writeAtomic(join(out, 'index.md'), indexMarkdown(entries));
  console.error(`wrote ${join(out, 'index.md')}: ${entries.length} terms, `
    + `${entries.filter((e) => e.uses.length > 1).length} in more than one lecture`);
  return 0;
}

function writeReview(out, names, sheet) {
  if (sheet) {
    const text = readText(join(out, 'study-sheet.md'));
    if (text === null) throw new Error(`no study-sheet.md in ${out}`);
    const lectures = new Map(lecturesIn(out).map((e) => [e.lecture.lecture, { lecture: e.lecture, dir: relative(out, e.dir).replace(/\\/g, '/') }]));
    writeAtomic(join(out, 'review.html'), sheetReview(text, lectures));
    console.error(`wrote ${join(out, 'review.html')}`);
    return 0;
  }
  for (const entry of selected(out, names)) {
    const notes = readText(join(entry.dir, 'notes.md'));
    if (notes === null) {
      console.error(`${entry.name}: no notes.md yet — skipped`);
      continue;
    }
    writeAtomic(join(entry.dir, 'review.html'), lectureReview(entry.lecture, notes, readText(join(entry.dir, 'unread.md')) ?? ''));
    console.error(`wrote ${join(entry.dir, 'review.html')}`);
  }
  return 0;
}

function printStamp(out, name) {
  const [entry] = selected(out, [name]);
  console.log(notesStamp({ sha256: entry.lecture.sha256, template: currentTemplate() }));
  return 0;
}

/* -------------------------------------------------------------------------- */

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      force: { type: 'boolean', default: false },
      'no-render': { type: 'boolean', default: false },
      soffice: { type: 'string' },
      sheet: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const needDir = () => {
    if (!rest[0]) throw new Error(`${command} needs the output folder`);
    return rest[0];
  };
  switch (command) {
    case 'build':
      await build(rest, { out: values.out, force: values.force, render: !values['no-render'], soffice: values.soffice });
      return 0;
    case 'status': return status(needDir());
    case 'coverage': return values.sheet ? checkSheet(needDir()) : checkCoverage(needDir(), rest.slice(1));
    case 'index': return writeIndex(needDir());
    case 'review': return writeReview(needDir(), rest.slice(1), values.sheet);
    case 'stamp':
      if (!rest[1]) throw new Error('stamp needs the output folder and a lecture');
      return printStamp(rest[0], rest[1]);
    default:
      throw new Error(`unknown command "${command}" — expected build, status, coverage, index, review or stamp`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(`study: ${err.message}`);
  process.exitCode = 1;
}
