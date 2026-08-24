#!/usr/bin/env node
/**
 * The command line. All the file system and all the printing live here; everything under src/ is
 * pure, which is what will let a GUI call the same code later without any of it moving.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';

import { readPptx } from './src/pptx.js';
import { readDocx } from './src/docx.js';
import { readPdf } from './src/pdf.js';
import { buildDoc, slugify } from './src/doc.js';
import { extract, finalize, merge } from './src/cards.js';
import { expand, check, withoutDuplicates, PROVIDERS } from './src/llm.js';
import { render, FORMATS, EXTENSION } from './src/write.js';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const USAGE = `
illuminate — turn slides, documents and PDFs into a study set

  node illuminate.js <files...> [options]

  --out <path>       where to write (default: <first input>.txt)
  --format <name>    ${FORMATS.join(' | ')}   (default: anki — imports into Anki and QuickMathPlus)
  --llm <provider>   ${PROVIDERS.join(' | ')}   (default: none)
  --model <name>     which model, when --llm is set (default: whatever is loaded)
  --tag <tag>        an extra tag on every card; no spaces
  --min <n>          refuse to write a deck smaller than n cards (default: 1)
  --dry-run          print the cards instead of writing a file
  --residue          also print what no rule could turn into a card
  --check            report what is installed and running, then stop
  --help             --version
`.trim();

const READERS = { '.pptx': readPptx, '.docx': readDocx, '.pdf': readPdf };

/**
 * Say what went wrong in the same voice as the rest of the CLI.
 *
 * Node's own message is accurate and unhelpful — it names an errno and a resolved absolute path for
 * something the user typed as a relative one. Every other guard here explains itself, and a typo in
 * a filename is the most likely mistake of all.
 */
function friendly(err, path, verb) {
  const say = (msg) => Object.assign(new Error(msg), { cause: err });
  if (err.code === 'ENOENT') {
    return verb === 'read'
      ? say(`no such file: ${path}`)
      : say(`cannot write to ${path} — the directory does not exist`);
  }
  if (err.code === 'EACCES' || err.code === 'EPERM') return say(`cannot ${verb} ${path} — permission denied`);
  if (err.code === 'EISDIR') return say(`${path} is a directory, not a file`);
  return err;
}

async function readFile(path) {
  const ext = extname(path).toLowerCase();
  const reader = READERS[ext];
  if (!reader) {
    throw new Error(`cannot read ${ext || 'that'} files (known: ${Object.keys(READERS).join(', ')})`);
  }
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw friendly(err, path, 'read');
  }
  return buildDoc(basename(path), await reader(bytes));
}

async function report() {
  for (const row of await check()) {
    console.log(`${row.ok ? '  ok  ' : ' --   '} ${row.name.padEnd(16)} ${row.detail}`);
    if (!row.ok) console.log(`${' '.repeat(23)}↳ ${row.fix}`);
  }
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      format: { type: 'string', default: 'anki' },
      llm: { type: 'string', default: 'none' },
      model: { type: 'string' },
      tag: { type: 'string', default: '' },
      min: { type: 'string', default: '1' },
      'dry-run': { type: 'boolean', default: false },
      residue: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      version: { type: 'boolean', default: false },
    },
  });

  if (values.version) {
    console.log(version);
    return 0;
  }
  if (values.check) {
    await report();
    return 0;
  }
  if (values.help || !positionals.length) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (!FORMATS.includes(values.format)) {
    throw new Error(`unknown format "${values.format}" — expected one of ${FORMATS.join(', ')}`);
  }
  if (!PROVIDERS.includes(values.llm)) {
    throw new Error(`unknown --llm "${values.llm}" — expected one of ${PROVIDERS.join(', ')}`);
  }
  if (values.tag && /\s/.test(values.tag)) {
    // Tags are separated by spaces in the file format, so one containing a space becomes two tags.
    throw new Error(`--tag cannot contain spaces (got "${values.tag}")`);
  }
  // Checked here rather than where it is used, because `Number('abc')` is NaN and every comparison
  // against NaN is false — an unvalidated --min does not fail, it silently stops guarding. Reading
  // the files first would also mean waiting through the whole run to be told the flag was a typo.
  //
  // The shape of the string is tested rather than the number it coerces to, because the coercion
  // has its own quiet answers: `Number('')` is 0, so an empty --min would read as "no minimum" —
  // which is not what someone who typed the flag and left it blank meant.
  if (!/^\d+$/.test(values.min)) {
    throw new Error(`--min must be a whole number of cards (got "${values.min}")`);
  }
  const min = Number(values.min);

  const decks = [];
  const shown = [];

  for (const path of positionals) {
    const doc = await readFile(path);
    const { cards: found, residue } = extract(doc, { tag: values.tag });
    const deck = { slug: doc.slug, cards: [...found] };
    decks.push(deck);
    shown.push(...residue.map((r) => ({ ...r, source: doc.source })));
    console.error(`${path}: ${found.length} cards from ${doc.sections.length} sections`);

    if (values.llm !== 'none') {
      const items = await expand(residue, {
        provider: values.llm,
        model: values.model,
        refs: new Set(doc.sections.map((s) => s.ref)),
        onProgress: (msg) => console.error(`  ${msg}`),
      });
      // Compared against every card in hand rather than this file's alone: a rule-made card wins
      // over a model-made one wherever it came from, and a restatement caught here costs nothing,
      // where the same card caught in `merge` would survive as a disambiguated near-duplicate.
      const sofar = decks.flatMap((d) => d.cards);
      // Tagged `ai` so a deck can be filtered back to the cards a rule was confident about.
      const extra = finalize(doc, withoutDuplicates(items, sofar).map((item) => ({
        front: item.front,
        back: item.back,
        tags: [doc.slug, item.ref, values.tag, 'ai'].filter(Boolean),
      })));
      deck.cards.push(...extra);
      console.error(`  ${values.llm}: ${extra.length} more from the leftovers`);
    }
  }

  if (values.residue) {
    for (const r of shown) {
      console.error(`\n--- ${r.source} ${r.ref}${r.title ? ` (${r.title})` : ''}\n${r.text}`);
    }
  }

  const { cards, renamed } = merge(decks);
  if (renamed) {
    console.error(`${renamed} question${renamed === 1 ? '' : 's'} appeared in more than one file`
      + ' — disambiguated so the deck imports');
  }

  if (cards.length < min) {
    throw new Error(`only ${cards.length} cards — below --min ${min}, writing nothing`);
  }

  const source = basename(positionals[0]);
  const text = render({ source, slug: slugify(source), cards }, values.format);

  if (values['dry-run']) {
    process.stdout.write(text);
    return 0;
  }

  const out = values.out ?? source.replace(/\.[^.]+$/, '') + EXTENSION[values.format];
  try {
    writeFileSync(out, text, 'utf8');
  } catch (err) {
    throw friendly(err, out, 'write');
  }
  console.error(`wrote ${cards.length} cards to ${out}`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(`illuminate: ${err.message}`);
  process.exitCode = 1;
}
