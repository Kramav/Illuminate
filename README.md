# Illuminate

Take slides, word docs, and pdfs and turn it into a simple study set. Paired with a future implementation of my other repository, QuickMathPlux

```sh
node illuminate.js lecture3.pptx --tag bio101
# → lecture3.txt, importable into Anki and QuickMathPlus unchanged
```

## What it reads

`.pptx` and `.docx`, with no dependencies — both are ZIP archives of XML, and `node:zlib` plus a
central-directory reader covers them. PDF is next; it needs a real parser and will bring the
project's only dependency with it.

Slides become one section each, with their speaker notes folded in — in a lecture deck the notes are
often where the actual definitions are. Word documents split at their headings.

## What it writes

**Anki's plain-text format** (`--format anki`, the default), which QuickMathPlus reads too, so one
file covers both with no conversion step. `--format quizlet` emits the same rows without the `#`
directives, which Quizlet's importer would otherwise turn into cards. `--format json` for anything
else.

Card ids are hashed from the question, so re-running after editing one slide disturbs one card
instead of renumbering the deck and orphaning a learner's progress.

## How it decides what's a card

Four rules, in order: a question line answered by the line beneath it; a bold lead-in; a tab; and
`Term — definition` punctuation. Everything else is set aside as **residue** (`--residue` prints it)
rather than forced into a card.

The rules are deliberately narrow. Slides are full of text that reads like a definition and isn't —
`Note: see chapter 4`, `Step 2: add the reagent`, `Q3: 14%` — and a rule loose enough to catch every
real term catches all of those too. Six garbage cards in a deck of forty is worse than thirty clean
ones, because they have to be found by hand first.

## Options

```
--out <path>      where to write        --format anki | quizlet | json
--tag <tag>       extra tag, no spaces  --min <n>     refuse to write a deck smaller than n
--dry-run         print, don't write    --residue     show what no rule could read
```

## Working on it

`npm test` — `node --test`, no framework. The suite writes real ZIP bytes and reads them back
through the real reader, and the last test feeds our output through QuickMathPlus's actual
`parseSet` when that repository is checked out beside this one (it skips itself when it isn't).
That parser rejects rather than repairs, so a duplicate question or a stray `;` fails the whole
import — which is what those tests are guarding.
