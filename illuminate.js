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
import { buildDoc, slugify } from './src/doc.js';
import { extract } from './src/cards.js';
import { render, FORMATS, EXTENSION } from './src/write.js';

const USAGE = `
illuminate — turn slides and documents into a study set

  node illuminate.js <files...> [options]

  --out <path>       where to write (default: <first input>.txt)
  --format <name>    ${FORMATS.join(' | ')}   (default: anki — imports into Anki and QuickMathPlus)
  --tag <tag>        an extra tag on every card; no spaces
  --min <n>          drop the deck if it has fewer than n cards (default: 1)
  --dry-run          print the cards instead of writing a file
  --residue          also print what no rule could turn into a card
  --help
`.trim();

const READERS = { '.pptx': readPptx, '.docx': readDocx };

function readFile(path) {
  const ext = extname(path).toLowerCase();
  const reader = READERS[ext];
  if (!reader) {
    const known = Object.keys(READERS).join(', ');
    // .pdf is named explicitly because it is the format people will reach for first, and "unsupported
    // file type" would read as "never will be" rather than "not yet".
    const soon = ext === '.pdf' ? ' — PDF support is not built yet' : '';
    throw new Error(`cannot read ${ext || 'that'} files${soon} (known: ${known})`);
  }
  return buildDoc(basename(path), reader(readFileSync(path)));
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      format: { type: 'string', default: 'anki' },
      tag: { type: 'string', default: '' },
      min: { type: 'string', default: '1' },
      'dry-run': { type: 'boolean', default: false },
      residue: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || !positionals.length) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  if (!FORMATS.includes(values.format)) {
    throw new Error(`unknown format "${values.format}" — expected one of ${FORMATS.join(', ')}`);
  }
  if (values.tag && /\s/.test(values.tag)) {
    // Tags are separated by spaces in the file format, so one containing a space becomes two tags.
    throw new Error(`--tag cannot contain spaces (got "${values.tag}")`);
  }

  const cards = [];
  const residue = [];
  for (const path of positionals) {
    const doc = readFile(path);
    const result = extract(doc, { tag: values.tag });
    cards.push(...result.cards);
    residue.push(...result.residue.map((r) => ({ ...r, source: doc.source })));
    console.error(`${path}: ${result.cards.length} cards from ${doc.sections.length} sections`);
  }

  if (values.residue) {
    for (const r of residue) {
      console.error(`\n--- ${r.source} ${r.ref}${r.title ? ` (${r.title})` : ''}\n${r.text}`);
    }
  }

  const min = Number(values.min);
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
  writeFileSync(out, text, 'utf8');
  console.error(`wrote ${cards.length} cards to ${out}`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(`illuminate: ${err.message}`);
  process.exitCode = 1;
}
