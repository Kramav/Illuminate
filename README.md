# Illuminate

Take slides, word docs, and pdfs and turn it into a simple study set. Paired with a future implementation of my other repository, QuickMathPlux

```sh
node illuminate.js lecture3.pptx --tag bio101
# → lecture3.txt, importable into Anki and QuickMathPlus unchanged
```

## What it reads

`.pptx`, `.docx` and `.pdf`.

The Office formats need no dependency — both are ZIP archives of XML, so `node:zlib` plus a
central-directory reader covers them. PDF gets the project's only dependency, `pdfjs-dist`, because
PDF text extraction is genuinely hard: text is positioned by matrix rather than written in order, and
reassembling lines from glyph coordinates correctly on real files is thousands of lines nobody should
write twice.

That geometry is worth keeping, not just surviving. A two-column glossary has a wide gutter between
the term and its definition, and Illuminate turns that gutter into a tab — which is the same signal a
Word glossary sends, so both use one rule. Flattening the page to plain text would destroy it.

Slides become one section each, with their speaker notes folded in — in a lecture deck the notes are
often where the actual definitions are. Word documents split at their headings; PDFs split by page,
taking the largest type at the top of each as its heading.

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

## The optional model pass

```sh
node illuminate.js --check                          # what's installed and running
node illuminate.js lecture3.pptx --llm ollama       # or lmstudio, or claude
```

A model sees **only the residue** — the prose the rules already declined. That ordering is the point:
the rules handle everything plainly structured for free, offline, and identically every run, and the
model is asked only about the paragraphs that defeated them. Cheaper, faster, and the deterministic
core stays testable.

`ollama` and `lmstudio` are the same code — Ollama, LM Studio and llama.cpp's server all speak the
OpenAI chat shape, so running locally costs one `fetch` and a different port. `claude` uses the
official SDK, which is **not installed by default**; `npm install @anthropic-ai/sdk` only if you want
it.

Model-made cards go through the same acceptance gate as rule-made ones and are tagged `ai`, so a deck
can be filtered back to what a rule was confident about. A provider that is down, slow, or answering
with prose costs that passage and nothing else — the rule-made cards are already in hand.

## Options

```
--out <path>      where to write        --format anki | quizlet | json
--llm <provider>  none | ollama | lmstudio | claude    --model <name>
--tag <tag>       extra tag, no spaces  --min <n>     refuse to write a deck smaller than n
--dry-run         print, don't write    --residue     show what no rule could read
--check           report what's available and how to get what isn't
```

## Working on it

`npm test` — `node --test`, no framework. The suite writes real ZIP bytes and reads them back
through the real reader, and the last test feeds our output through QuickMathPlus's actual
`parseSet` when that repository is checked out beside this one (it skips itself when it isn't).
That parser rejects rather than repairs, so a duplicate question or a stray `;` fails the whole
import — which is what those tests are guarding.
