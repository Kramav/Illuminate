# Illuminate

Take slides, word docs, and pdfs and turn it into a simple study set. Paired with a future implementation of my other repository, QuickMathPlux

```sh
npm install                                   # once — pdfjs, for reading PDFs
node illuminate.js lecture3.pptx --tag bio101
# → lecture3.txt, importable into Anki and QuickMathPlus unchanged
```

Node 20 or newer. `npm install` pulls one dependency, and only PDFs need it — `.pptx` and `.docx`
work without it, so a clone that skipped the step reads two formats of three and says so clearly on
the third. `node illuminate.js --check` reports which.

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

Tables are read in all three, and they arrive as the same thing a PDF gutter does: a row becomes one
line with its cells separated by tabs. A two-column table *is* a term beside its definition, which
is the shape the tab rule below already reads — so a glossary written as a table, as a typed tab, or
as two columns on a page all take one path through the rules.

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

## Options

```
--out <path>      where to write        --format anki | quizlet | json
--llm <provider>  none | ollama | lmstudio | claude    --model <name>
--tag <tag>       extra tag, no spaces  --min <n>     refuse to write a deck smaller than n
--dry-run         print, don't write    --residue     show what no rule could read
--check           report what's available and how to get what isn't
--help            --version
```

## Study sheets

Cards are for drilling. A whole course for an exam needs a review sheet as well, and `study.js` is
the half of that pipeline that can be computed instead of judged:

```sh
node study.js build E:\Slides\*.pptx --out E:\Slides\illuminate-out   # extract + render each lecture
node study.js status E:\Slides\illuminate-out                         # what is done, what is stale
```

Each lecture gets a folder: `slides.md` (every slide's text, numbered `s1`, `s2`… the way a citation
writes it, with the reason a slide needs looking at), and `images/` with every slide rendered, plus
a **separate high-resolution crop of each equation**. Notes are then written per lecture against
[TEMPLATE.md](TEMPLATE.md), by a model or by hand. The tool doesn't write them; it checks them:

```sh
node study.js stamp    <out> 5         # the first line notes.md must carry
node study.js coverage <out> 5         # every slide cited or listed as skipped, every citation real
node study.js review   <out> 5         # review.html: each note beside the slide it cites
node study.js index    <out>           # terms defined in more than one lecture, for the merge
node study.js coverage <out> --sheet   # nothing the notes cited was merged away
```

The `--out` folder holds course material. Keep it outside the repository; `.gitignore` also
excludes `out/`, `*.pptx`, `*.pdf` and `*.png`.

**Resuming.** Every stage records what it was built from, and a stage whose inputs haven't changed is
skipped. That covers the deck's SHA-256, the extractor and renderer versions, and the template
version stamped into each `notes.md`. Change one deck and only that lecture is redone, and its notes
are reported stale. `--force` redoes everything named.

**What the reader recovers that it used to drop.** These were all found in real lecture decks:

- **Slide order** comes from `presentation.xml`, not file names.
- **Hidden slides** are kept and marked, and they're rendered too, so image N is slide N.
- **Symbol-font Greek** (`U+F062` is β) is decoded through the font's own encoding. This also
  improves flashcard text.
- **Superscript and subscript runs** are written as `w_{ij}`, in study output only.
- **Equation objects** (Equation Editor 3.0, MathType) are counted and cropped. PowerPoint's fallback
  copy of each object is ignored, so equations aren't counted twice and text isn't read twice.

**Rendering needs LibreOffice** (a portable folder is fine). It's found from `--soffice`, then
`ILLUMINATE_SOFFICE`, then `PATH` and the usual install locations. LibreOffice's default PDF export
leaves hidden slides out; we turn that off, and refuse to render if the page count doesn't match the
slide count. `--no-render` gives text only.

Known limit: LibreOffice lays out text that PowerPoint shrinks to fit slightly differently, so an
overfull text box can overlap a neighbour in the image. The extracted text in `slides.md` is
unaffected, and it's always read alongside the image.

## Working on it

`npm test` — `node --test`, no framework. The suite writes real ZIP bytes and reads them back
through the real reader, and `test/cli.test.js` spawns the actual binary, because the parts of a CLI
that go wrong — argument parsing, the loop over several files, what gets written where — are not
reachable by importing a function.

Two tests feed our output through QuickMathPlus's actual `parseSet`, when that repository is checked
out beside this one; both skip themselves when it isn't. That parser rejects rather than repairs, so
a duplicate question or a stray `;` fails the whole import — which is what those tests are guarding.
CI checks QuickMathPlus out so they run there even when they'd skip locally.

The study-sheet render test drives LibreOffice and skips itself unless `ILLUMINATE_SOFFICE` points
at `soffice` (`soffice.com` on Windows). CI installs LibreOffice on one leg so the test runs there.

Running `npm install` under npm 11 rewrites `package-lock.json` slightly — it drops `libc` fields an
older npm wrote. That diff is the npm version, not a dependency change.
