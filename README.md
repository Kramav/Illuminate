# Illuminate

Take slides, word docs, pdfs and web pages and turn them into a simple study set. Paired with my other repository, QuickMathPlus, which imports what this writes.

```sh
npm install                                   # once — pdfjs, for reading PDFs
node illuminate.js lecture3.pptx --tag bio101
# → lecture3.txt, importable into Anki and QuickMathPlus unchanged
```

Node 20 or newer. `npm install` pulls one dependency, and only PDFs need it — every other format
works without it, so a clone that skipped the step reads everything but PDFs and says so clearly on
one. `node illuminate.js --check` reports which.

## What it reads

`.pptx`, `.docx`, `.pdf`, and web pages (`.html`, `.htm`).

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

Tables are read in all of them, and they arrive as the same thing a PDF gutter does: a row becomes
one line with its cells separated by tabs. A two-column table *is* a term beside its definition,
which is the shape the tab rule below already reads — so a glossary written as a table, as a typed
tab, or as two columns on a page all take one path through the rules.

Web pages read like Word documents: headings split them, bold is kept, tables become tab rows. HTML's
own glossary markup, `<dl>` with `<dt>` and `<dd>`, becomes the same tab line, so a glossary page
converts almost entirely by rule. The page around the content is left behind — navigation, site
header, footer, sidebar, scripts, anything hidden — and a page that marks its content with `<main>`
is read only inside it. It is written for what actually produces HTML notes: a saved page, a Google
Docs or Notion export, and Word's "Save as Web Page", whose windows-1252 encoding is honoured so its
em dashes still split cards. No dependency; a page that only fills itself in with JavaScript saves as
an empty shell, and the tool says so and suggests printing it to PDF instead.

## What it writes

**Anki's plain-text format** (`--format anki`, the default), which QuickMathPlus reads too, so one
file covers both with no conversion step. `--format quizlet` emits the same rows without the `#`
directives, which Quizlet's importer would otherwise turn into cards. `--format json` for anything
else.

Card ids are hashed from the question, so re-running after editing one slide disturbs one card
instead of renumbering the deck and orphaning a learner's progress.

## Several files at once

```sh
node illuminate.js week*.pptx --out bio101.txt   # one deck from the whole course
```

A course repeats itself — two lectures both define osmosis — and the formats we write do not allow
that: QuickMathPlus's importer rejects a repeated question outright, failing the entire file rather
than the row. So both cards are kept and the later question is named after its source
(`Osmosis (lecture4)`).

Two rules make that safe to re-run. The **first occurrence is never touched**, so a file produces
the same card whether it is converted alone or alongside the rest of the term. And the **id does not
move with the question** — ids already carry the source, so adding another lecture to the command
line cannot hand a card someone else's progress.

## How it decides what's a card

Four rules, in order: a question line answered by the line beneath it; a bold lead-in; a tab; and
`Term — definition` punctuation. Everything else is set aside as **residue** (`--residue` prints it)
rather than forced into a card.

The rules are deliberately narrow. Slides are full of text that reads like a definition and isn't —
`Note: see chapter 4`, `Step 2: add the reagent`, `Q3: 14%` — and a rule loose enough to catch every
real term catches all of those too. Six garbage cards in a deck of forty is worse than thirty clean
ones, because they have to be found by hand first.

A tab settles *where* the split falls, so it is exempt from the word count that guards against a
sentence with a dash in the middle of it. It settles nothing about the left-hand side, so the label
list applies to a tab exactly as it applies to a dash — `Note` names nothing whichever separator
follows it.

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

Residue is batched into request-sized passages, and a section too long for one request is split
across several — so a Word file written without heading styles, which is one section holding the
whole document, does not become a single prompt past what a local model can actually read. The
progress lines count those requests, not your sections.

## Checking the cards

```sh
node illuminate.js lecture3.pptx --llm ollama --verify ollama
```

Two checks, and only the second needs a model.

**Grounding** runs on every model-made card, automatically and for free. It checks that the card's
words are actually in the passage it cites — both sides, since QuickMathPlus drills cards in reverse
too. Rephrasing is allowed (about one word in three, and "moves" matches "movement"); a number the
passage never states is not. A card that fails is dropped and printed with the words that gave it
away, because an invented fact is the one thing a model-made card can add that a rule-made one
cannot. Rule-made cards skip this: they are copied from the source, so they cannot fail it.

**Review** (`--verify <provider>`) asks a model about every card whether it can be studied as
written: is the answer in the passage, does the card make sense away from its slide (`Function` does
not), does the answer answer the question. The same providers as `--llm`, so a local model keeps it
free and keeps your notes on your machine. Flagged cards are **tagged `check`, never removed** — the
reviewer is less reliable than the rules it reviews — and listed with a reason. A reviewer that is
down or answering nonsense leaves its cards unchecked and says so; the deck is written either way.

## Options

```
--out <path>      where to write        --format anki | quizlet | json
--llm <provider>  none | ollama | lmstudio | claude    --model <name>
--verify <provider>  flag cards that need a second look (same providers as --llm)
--tag <tag>       extra tag, no spaces  --min <n>     refuse to write a deck smaller than n
--dry-run         print, don't write    --residue     show what no rule could read
--check           report what's available and how to get what isn't
--help            --version
```

## Working on it

`npm test` — `node --test`, no framework. The suite writes real ZIP bytes and reads them back
through the real reader, and `test/cli.test.js` spawns the actual binary, because the parts of a CLI
that go wrong — argument parsing, the loop over several files, what gets written where — are not
reachable by importing a function.

Two tests feed our output through QuickMathPlus's actual `parseSet`, when that repository is checked
out beside this one; both skip themselves when it isn't. That parser rejects rather than repairs, so
a duplicate question or a stray `;` fails the whole import — which is what those tests are guarding.
CI checks QuickMathPlus out so they run there even when they'd skip locally.

Running `npm install` under npm 11 rewrites `package-lock.json` slightly — it drops `libc` fields an
older npm wrote. That diff is the npm version, not a dependency change.
