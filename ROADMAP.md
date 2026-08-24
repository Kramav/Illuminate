# What's left

Illuminate reads all three formats, applies the rules, runs the optional model pass, and writes
files that import. What remained was not new capability — it was the gap between "works on my deck"
and "I trust this with a semester of lectures."

The target is a **solid, trustworthy tool**: a repo you clone and rely on. Not an npm package, not a
feature expansion. Publishing, `CONTRIBUTING.md`, OCR and new input formats are all deliberately out
of scope, listed at the bottom so the decision is on the record rather than forgotten.

**Ten items shipped**, one open ([11](#11-on-the-claude-path-max_tokens-is-now-shared-with-thinking)).
The suite went 46 → 68 → 80 → 85.

- **Round one (1–5)** was the repo: a bug that silently broke the thing the project exists to do, no
  tests on the binary, no CI, a README a fresh clone couldn't follow.
- **Round two (6–8)** was the reading — the shapes real lecture material actually arrives in, which
  round one never tested. Two of the three were silent: content dropped with no card, no residue and
  no warning.
- **Round three (9–11)** is the model pass, the one part of the pipeline neither earlier round looked
  at. 9 and 10 are shipped; 11 is open, because confirming it costs real API calls.

Started at 46 tests passing, which is worth saying plainly: **a green suite is what every round of
findings has hidden behind.**

---

## 1. Two files that share a question produce a deck QuickMathPlus refuses

**The bug.** Card de-duplication happens once per document, inside `finalize` — [cards.js:173](src/cards.js#L173)
keeps one card per question, preferring the fullest answer. But [illuminate.js:97](illuminate.js#L97)
accumulates across files:

```js
for (const path of positionals) {
  const doc = await readFile(path);
  const { cards: found, residue } = extract(doc, { tag: values.tag });
  cards.push(...found);          // ← nothing dedupes across this boundary
```

So each file is internally clean and the combined deck is not. Reproduced end to end:

```
$ node illuminate.js lecture3.pptx lecture4.pptx --out combined.txt
wrote 6 cards to combined.txt

$ parseSet(combined.txt)
IMPORT REJECTED: row 4 repeats the front "Osmosis"
```

QuickMathPlus rejects rather than repairs — [`parseSet`](../QuickMathPlus/www/src/cards.js) throws on
`byFront.has(front)` — so this is not a warning or a dropped card. **The entire import fails.** Two
lectures that both define osmosis is not an exotic input; it is what a course looks like. The one
workflow the README advertises as the point of the project ("importable into Anki and
QuickMathPlus unchanged") is the workflow that breaks.

The same root cause reaches the model pass. [illuminate.js:109](illuminate.js#L109) calls
`withoutDuplicates(items, found)`, where `found` is *this document's* rule cards — so the model is
free to restate a card an earlier file already made.

**The fix: keep both cards, disambiguate the later front.**

Nothing is lost, which matters when the same term is genuinely taught twice with different emphasis.
Three constraints keep this from becoming the thing `cards.js` otherwise refuses to do — inventing
text that was never in the source:

- **Only on an actual collision.** A front that appears once is never touched. Disambiguation is a
  collision resolver, not a naming convention.
- **First occurrence stays exactly as written.** Only the second and later get a suffix. Running
  `illuminate lecture3.pptx` alone and running it as part of a batch produce a byte-identical card
  for lecture3 — the batch only affects the file that arrived later.
- **The id does not move.** `guid` is already `guid(doc.slug, front)` ([cards.js:56](src/cards.js#L56)),
  and the slug differs per file, so ids are *already* unique across a run. Keep deriving the id from
  the **original** front. The suffix is a display disambiguator; identity stays anchored to source +
  original question, so a learner's progress survives whether or not the other file was in the run.

```
eprje9   Osmosis                 the movement of water across a membrane   lecture3 slide-1
wtglzg   Osmosis (lecture4)      the movement of water across a membrane   lecture4 slide-1
```

The suffix is the source slug, which is already a tag on the card — so it names something the deck
already told you, rather than introducing a new vocabulary.

**Where it goes.** Shipped as `merge(decks)` in [cards.js](src/cards.js), called from
`illuminate.js` after the file loop — one step off the plan, which said to put the pass in
`illuminate.js` itself. The reasoning that moved it is [illuminate.js](illuminate.js)'s own header:
*"everything under src/ is pure, which is what will let a GUI call the same code later without any of
it moving."* Merging two decks is exactly what a GUI would need, and a pass living in the CLI could
not be reused. `extract`'s one-document contract is untouched either way, which was the actual
concern. Reported on stderr so the overlap is visible rather than silent.

**Tests.** Two files with an overlapping term → both cards present, first front untouched, ids
unchanged from the single-file run, and the output survives `parseSet`. That last assertion is the
one that would have caught this.

---

## 2. The CLI itself has no tests

Every test imports from `src/` directly. `illuminate.js` — argument parsing, the multi-file loop,
`--min`, `--out`, format selection — has **zero coverage**. That is not a coincidence about where
bug #1 lives: it is the only part of the codebase a test has never executed.

Add `test/cli.test.js` that spawns the real binary via `node:child_process` against a fixture
written to a temp directory, and asserts on exit code, stdout and the file on disk. `test/helpers.js`
already builds real `.pptx` bytes, so the fixture is a few lines.

Worth covering: a normal run writes the expected file; `--dry-run` writes nothing; `--format` picks
the right extension; a bad `--format` and a bad `--llm` exit non-zero with a useful message; the
multi-file case from #1; and `--min` refusing a deck.

---

## 3. Three CLI edges that fail quietly or badly

Small, but each one either lies or leaks.

**`--min` accepts nonsense and ignores it.** [illuminate.js:125](illuminate.js#L125) is
`Number(values.min)`, so `--min abc` is `NaN`, and `cards.length < NaN` is `false` — the guard the
user just asked for silently does not run:

```
$ node illuminate.js lecture3.pptx --min abc --dry-run
#separator:Tab                            ← wrote the deck anyway
```

Validate it as a non-negative integer and throw the way the `--format` and `--tag` guards already do.
Those two are good models: they name what was wrong and what was expected.

**Missing files leak a stack-trace error.** A typo'd input, or `--out` into a directory that does not
exist, surfaces raw Node:

```
illuminate: ENOENT: no such file or directory, open 'C:\...\nope.pptx'
```

The rest of the CLI speaks plainly (`cannot read .key files (known: .pptx, .docx, .pdf)`). Catch
`ENOENT`/`EACCES` at [illuminate.js:44](illuminate.js#L44) and at the write, and say
`no such file: nope.pptx` and `cannot write to nodir/ — the directory does not exist`.

**No `--version`.** `--help` exists; `--version` is an unknown-option error. One line reading the
version from `package.json`.

---

## 4. CI, so the suite actually runs

There is no `.github/workflows/`. The tests are good and nothing enforces them — including the
QuickMathPlus contract test, which is the most valuable one in the repo and also the one that
**skips itself** when the sibling repo is not checked out ([write.test.js](test/write.test.js)). On a
fresh clone it is invisible: it passes by not running.

A workflow on push and PR, running `npm ci && npm test` on Node 20, 22 and 24 (`package.json`
declares `>=20`; nothing has ever verified 20 specifically). Check out QuickMathPlus beside the repo
in a second step so the contract test actually executes — that is the assertion that catches a
format regression before it reaches a study session.

---

## 5. A fresh clone can't read PDFs, and the README doesn't say so

`pdfjs-dist` is a real dependency and the README's first code block is `node illuminate.js
lecture3.pptx`. Clone, follow the README, hand it a PDF, and it fails on a missing module. Verified:
before `npm install`, `pdf.test.js` dies with `ERR_MODULE_NOT_FOUND`.

Add the install step to the top of the README. `--check` already reports `PDF reading — ready` and
tells you to run `npm install` when it isn't, which is the right behaviour; the README simply never
sends anyone there.

**Also worth a line:** `npm install` under npm 11 strips `libc` fields from `package-lock.json` that
an older npm wrote — a 15-line phantom diff on a repo nobody changed. Either re-commit the lockfile
under current npm or note the npm version, so the next `git status` surprise is explained.

---

## Order

1 first — it is the only item that produces a wrong result rather than a rough edge, and it is
load-bearing for the QuickMathPlus pairing. 2 immediately after, because the CLI test is what proves
1 is fixed and is the standing guard against the next bug in the same blind spot. 3 and 5 are quick.
4 last, so CI turns green on a suite that already covers the thing that was broken.

## Explicitly not doing

Recorded so these stay decisions rather than oversights:

- **npm publishing.** `private: true` stays. Installed by cloning.
- **`CONTRIBUTING.md`, `CHANGELOG.md`, issue templates.** For a repo taking outside contributions.
- **OCR for scanned PDFs.** [pdf.js](src/pdf.js) already fails clearly and says OCR is not built,
  which is the honest answer. A dependency and an accuracy problem for later.
- **Bold detection in PDFs.** The `ponytail` note at [pdf.js:107](src/pdf.js#L107) — PDFs record bold
  as a differently-named embedded font, which is a guess where the other formats have a flag. The
  column-gap tab already covers the layout it would have helped with.
- **zip64, and `<p:sp>` nested in `<p:sp>`.** The other two `ponytail` notes. Both are documented
  limits with reasoning, both fail visibly rather than silently, and neither is reachable from a
  lecture deck.
- **New input formats.** `.pptx`, `.docx`, `.pdf` covers what lectures are distributed as.

## Done

All five, and the suite went from 46 tests to 68.

- [x] **Two files sharing a question import cleanly, with both cards intact.** `merge` in
  [cards.js](src/cards.js). The deck that reported `IMPORT REJECTED: row 4 repeats the front
  "Osmosis"` now imports as six cards, and the first file's ids are unchanged from converting it
  alone.
- [x] **`npm test` exercises the binary, not just the modules.** [test/cli.test.js](test/cli.test.js)
  spawns the real command — 14 tests, including the multi-file case and a second QuickMathPlus
  contract check on a file the CLI actually produced.
- [x] **`--min abc`, a missing file, and a missing output directory each fail with a sentence you can
  act on.** Plus `--version`, and `--min` validated before any file is read rather than after.
- [x] **CI runs the suite on every push** — [test.yml](.github/workflows/test.yml), Node 20 / 22 / 24,
  checking QuickMathPlus out beside the repo so the contract tests execute instead of skipping.
- [x] **A fresh clone can read a PDF by following the README.** Install step added, along with the
  multi-file behaviour and the npm-11 lockfile note.

Two things worth knowing that only surfaced in the building:

*(A second round followed — three more findings, below.)*

- **`--min -1` never reaches our guard.** `parseArgs` reads a bare leading dash as another option and
  rejects it first, with its own message pointing at `--min=-1`. That form is what the test uses.
- **`Number('')` is `0`**, so an empty `--min` would have read as "no minimum" — the same class of
  quiet coercion as the `NaN` bug it was added to fix. The guard tests the string's shape instead.

---

# Round two — what the first pass didn't look at

The five items above were about the repo: its bug, its tests, its CI, its docs. They left the
*reading* untested against the shapes real lecture material comes in. Three findings, all in the core
path, all shipped.

## 6. PowerPoint tables were dropped without a trace

`shapesOf` splits a slide on `<p:sp>`, and a table is not one — it hangs off a `<p:graphicFrame>`.
So a slide whose content was a term table produced **nothing**:

```
=== pptx TABLE ===
lines: []
cards: []
```

The worst of the three, because it was invisible. No card, no residue, no warning — and nothing for
`--llm` to read either, since the model only ever sees residue. A deck built on tables converted to
an empty file with nothing to explain why.

**Fixed** in [pptx.js](src/pptx.js): each `<a:tr>` becomes one line, cells joined by tabs.

## 7. The tab path skipped the label guard

`splitTermDef` short-circuited on a tab and returned before the `NOT_A_TERM` list was ever consulted.
Its comment claimed the sanity checks still applied "by `accept`" — but `accept` checks lengths and
`BOILERPLATE`, never `NOT_A_TERM`. So the list [cards.js](src/cards.js) calls *"the difference
between the rule working and the rule being useless"* did not run on the tab path at all:

```
"Note — see chapter 4"  -> null                              ← refused, correctly
"Note\tsee chapter 4"   -> {front:"Note", back:"see chapter 4"}
```

And the tab path is exactly what the PDF column-gutter rule feeds. On a realistic two-column handout
that was **four garbage cards out of six**, with zero residue — the precise failure the file's own
header argues against.

**Fixed** by splitting the two questions apart. `looksLikeTerm` asks whether the left side names
anything and runs on both paths; the word count, which is only about *where* the split falls, stays
the tab's exemption — a tab states the boundary a dash merely implies. Same handout now:

```
cards produced: 2 (2 are real terms)   ← was 6
residue passages: 1                    ← was 0; --llm can still reach the rest
```

## 8. Word table glossaries produced no cards

The ordinary way to write a glossary in Word is a two-column table. `paragraphsOf` picked up the
`w:p` inside each cell but lost the cell wall, so term and definition arrived as unrelated lines that
paired with nothing.

**Fixed** in [docx.js](src/docx.js), the same way as 6 — with one wrinkle worth its own test:
`paragraphsOf` walks *every* `<w:p>` in the file, cells included, so emitting rows as well would have
put every glossary entry into the deck twice, once paired and once in pieces. `blocksOf` substitutes
rows for the paragraphs inside them rather than adding to them.

## What tied them together

One rule, three formats: **a table row is a line whose cells are separated by tabs** — the same
device [pdf.js](src/pdf.js) already used for a column gutter. The shared walk is `tableRows` in
[xml.js](src/xml.js), which is one function rather than two because DrawingML and WordprocessingML
differ here only in their prefix (`a:tbl/a:tr/a:tc` against `w:tbl/w:tr/w:tc`).

Order mattered: 7 had to be fixed **before** 6 and 8, because tables funnel far more content into the
tab path. Fixing them first would have multiplied the garbage-card leak instead of fixing it.

The header row a glossary table starts with — "Term | Definition" — reads as a card that is true of
every glossary ever written and worth recalling from none, so `term`, `word`, `concept`, `meaning`,
`description` and `explanation` joined the label list. That covers headers wherever they arrive from,
including a two-column PDF, rather than needing a rule per reader.

## Done

- [x] **A slide's table becomes cards instead of vanishing.**
- [x] **A label is refused whether a dash or a tab introduces it** — and a real term still reads
  through a tab, including one too long for the punctuation rule.
- [x] **A Word glossary table becomes cards**, and its entries are not also counted singly.
- [x] **A third column is answer material, not another boundary** — extra tabs would otherwise reach
  the file as columns of their own.

**80 tests**, up from 68. README updated on both: tables under *What it reads*, and the tab's exact
privilege under *How it decides what's a card*.

## Still not doing

Unchanged from above — npm publishing, contributor docs, OCR, PDF bold detection, zip64, new input
formats. One limit added while building tables: **a table nested inside a table's cell** loses the
outer table's remaining rows, because the element walk is non-greedy. Word permits the nesting and a
glossary does not use it, and the failure is missing rows rather than wrong ones. Noted as a
`ponytail` in [xml.js](src/xml.js) and [docx.js](src/docx.js) beside the others.

---

# Round three — the model pass

**9 and 10 shipped. [11](#11-on-the-claude-path-max_tokens-is-now-shared-with-thinking) is open.**

Round one was the repo, round two was the reading. Neither looked at [llm.js](src/llm.js), and the
gap shows in the same shape as before: the suite has nine tests naming the model pass, and **not one
of them has ever seen a model reply that worked.** Every existing test asserts on a failure —
unparseable text, a dead server, `provider: none`. The success path, the batching, and the reference
check are executed for the first time by a real user, on their own lecture notes.

That is the round-two lesson again. `--llm` is optional, so an empty deck from it reads as "the
model found nothing" rather than as a bug, which is exactly the kind of silence rounds one and two
kept turning up.

## 9. A Word handout without headings becomes one 7,700-character prompt

`chunk` in [llm.js:67](src/llm.js#L67) batches *between* passages and never splits *within* one:

```js
if (size + block.length > CHUNK && current.length) {   // ← `current.length` is the escape hatch
  chunks.push(current); current = []; size = 0;
}
current.push(block);
```

When `current` is empty the guard short-circuits and the block is pushed whole, however large. So
`CHUNK = 3500` is a floor on batching, not a ceiling on prompt size.

That would be academic if a passage could not get big. It can, because
[docx.js:116](src/docx.js#L116) opens a new section only at a heading — so **a `.docx` with no
Heading styles is one section**, and its residue is the whole document. A lecture handout typed in
Word without using the heading styles is not an exotic input; it is the default way people write
one. Reproduced end to end through the real reader, 40 paragraphs of prose:

```
sections: 1 | cards: 0 | residue entries: 1
residue chars: [ 7709 ]
requests: 1 | prompt chars: [ 7717 ]     ← CHUNK is 3500
```

It scales linearly with the handout: 100 paragraphs is one ~19,000-character request. The size cap
that matters is not ours — Ollama's default context is 4096 tokens, roughly 16,000 characters, and
it does not refuse an over-long prompt. It drops what does not fit. **The tail of the document
silently pushes the beginning of the passage, and eventually the `SYSTEM` prompt with its rules,
out of the model's view** — so the failure is not a crash but cards that quietly stop obeying the
instructions, on the longest documents, where the model pass is worth the most.

**The fix:** split an over-long block on paragraph boundaries before batching, so `CHUNK` bounds
every prompt rather than most of them. The split is on `\n` between leftover lines, which is where
`extract` joined them ([cards.js:311](src/cards.js#L311)) — no new notion of a boundary is needed.
The `[ref]` label has to be repeated on each piece, or every card from the tail loses its section.

## 10. The success path of `--llm` has never been executed by a test

[llm.test.js](test/llm.test.js) is nine tests. Six are `parseCards` on strings, one is
`withoutDuplicates`, one is `provider: none` (which returns before doing anything), one is a dead
server. `expand` has never returned a card in a test.

Everything between the reply and the deck is therefore unverified: the ref check that stops a model
tagging a card onto a slide it never read, the `text.length < 60` skip, the batching in #9, the
retry, and the `onProgress` reporting. `chunk` is not even exported.

None of this needs a model. `expand` reaches the local providers through global `fetch`, so a stub
covers all of it — that is how #9 above was reproduced:

```js
globalThis.fetch = async (url, opts) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: '{"cards":[...]}' } }] }),
});
```

Worth asserting: a good reply becomes a card; **an invented `ref` is dropped** (verified by hand —
it is, but nothing holds it there); a passage under 60 characters costs no request; twelve passages
become four batched requests, not twelve; a first reply that is prose triggers exactly one retry;
and the case in #9, which is the assertion that would have caught it.

## 11. On the Claude path, `max_tokens` is now shared with thinking

[llm.js:137](src/llm.js#L137) asks for `max_tokens: 8000` with `model: 'claude-opus-5'` and no
`thinking` field. On Opus 5 that no longer means "8000 tokens of JSON": **thinking is on by default
when the parameter is omitted** — a change from Opus 4.8, where omitting it meant no thinking — and
`max_tokens` caps thinking *plus* the response together.

The failure this produces is bad in a specific way. A truncated reply is invalid JSON, so
`parseCards` returns `null`, which [llm.js:185](src/llm.js#L185) cannot distinguish from a model
that rambled — so it spends a **second** full request on the identical prompt, which truncates in
the same place, and the passage is dropped with `did not come back as JSON`. Two requests billed,
no cards, and a message that names the wrong cause.

Unlike 9 and 10 this one is reasoned from Anthropic's current API documentation, not reproduced —
checking it costs real API calls, so it is worth confirming before changing anything.

**The fix is two lines.** Raise `max_tokens` so thinking has its own room, and read
`stop_reason === 'max_tokens'` where `refusal` is already read one line above
([llm.js:146](src/llm.js#L146)) — a truncated reply should say so and skip the retry, since
re-sending an identical prompt cannot fix a length cap. `effort: 'low'` is already right and should
stay; disabling thinking outright is the wrong lever here, because on Opus 5 that risks `<thinking>`
tags leaking into the visible text, which is precisely what `parseCards` then has to survive.

## Order

**10 first**, which reverses round one's ordering and for a reason. There the bug came first because
it produced a wrong deck; here 9 and 11 both fail *quietly and expensively*, and neither can be
demonstrated — or shown fixed — without the stub harness. Then **9**, the one with a reproduction
and a realistic input behind it. **11** last, since it wants confirmation against the live API
before the code moves.

Held to, and the ordering paid for itself: the split assertion was written against the old `chunk`
and failed there before `blocksFor` existed, which is the only reason it is a guard rather than a
description.

## Done (9 and 10)

- [x] **A section too long for one request is split instead of sent whole.** `blocksFor` in
  [llm.js](src/llm.js), cutting on the newline `extract` joined the leftover lines with and
  repeating the `[ref]` label on each piece. The 40-paragraph heading-less handout that produced one
  7,717-character prompt now produces three, of 3,471 / 3,481 / 779 — `CHUNK` is a ceiling now, not
  only a floor.
- [x] **The model pass has tests that watch it succeed, not only fail.** Five in
  [llm.test.js](test/llm.test.js), against a stubbed `fetch` — no model, no server, no network.
  A reply becomes a card; **an invented `ref` is dropped**; a passage under 60 characters costs no
  request; twelve passages become fewer than twelve prompts; a prose reply costs exactly one retry
  and the retry lands.

**85 tests**, up from 80. README updated: the batching is now described where the model pass is,
since `--llm` progress lines count requests rather than sections and a long handout will report more
of them than it used to.

Two things worth knowing that only surfaced in the building:

- **A single line longer than `CHUNK` is still sent whole.** There is no boundary inside one line
  worth trusting, and it is a far smaller object than the document it used to drag along with it.
  Marked as a `ponytail` on `blocksFor` rather than left implicit.
- **The label eats into the budget**, so `room` is `CHUNK` minus the label, not `CHUNK`. A section
  with a long title would otherwise push each of its own pieces slightly over the size the split
  exists to enforce.

## Still not doing

Unchanged. Two things looked at in this round and deliberately left alone:

- **Splitting a section that has no headings into pseudo-sections.** It would shrink the passages in
  #9, but it invents structure the document does not have, and every card's `ref` tag would then
  point at a section number the reader cannot find in their own file. Bounding the prompt is the
  honest fix; re-cutting the document is not.
- **A token counter for prompt sizing.** `CHUNK` is characters, which is a rough proxy for tokens
  and always will be. A real count means a tokenizer per provider, and the thing it would buy —
  packing prompts closer to the true limit — is not worth a dependency when the current problem is
  prompts that exceed it by 5×.
