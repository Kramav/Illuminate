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
import { extract, finalize } from './src/cards.js';
import { expand, check, withoutDuplicates, PROVIDERS } from './src/llm.js';
import { render, FORMATS, EXTENSION } from './src/write.js';

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
  --help
`.trim();

const READERS = { '.pptx': readPptx, '.docx': readDocx, '.pdf': readPdf };

async function readFile(path) {
  const ext = extname(path).toLowerCase();
  const reader = READERS[ext];
  if (!reader) {
    throw new Error(`cannot read ${ext || 'that'} files (known: ${Object.keys(READERS).join(', ')})`);
  }
  return buildDoc(basename(path), await reader(readFileSync(path)));
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
    },
  });

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

  const cards = [];
  const shown = [];

  for (const path of positionals) {
    const doc = await readFile(path);
    const { cards: found, residue } = extract(doc, { tag: values.tag });
    cards.push(...found);
    shown.push(...residue.map((r) => ({ ...r, source: doc.source })));
    console.error(`${path}: ${found.length} cards from ${doc.sections.length} sections`);

    if (values.llm !== 'none') {
      const items = await expand(residue, {
        provider: values.llm,
        model: values.model,
        refs: new Set(doc.sections.map((s) => s.ref)),
        onProgress: (msg) => console.error(`  ${msg}`),
      });
      // Tagged `ai` so a deck can be filtered back to the cards a rule was confident about.
      const extra = finalize(doc, withoutDuplicates(items, found).map((item) => ({
        front: item.front,
        back: item.back,
        tags: [doc.slug, item.ref, values.tag, 'ai'].filter(Boolean),
      })));
      cards.push(...extra);
      console.error(`  ${values.llm}: ${extra.length} more from the leftovers`);
    }
  }

  if (values.residue) {
    for (const r of shown) {
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
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  console.error(`illuminate: ${err.message}`);
  process.exitCode = 1;
}
