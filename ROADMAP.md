# What's left

Illuminate reads all three formats, applies the rules, runs the optional model pass, and writes
files that import. The suite is 46 tests and they pass. What remains is not new capability — it is
the gap between "works on my deck" and "I trust this with a semester of lectures."

The target is a **solid, trustworthy tool**: a repo you clone and rely on. Not an npm package, not a
feature expansion. Publishing, `CONTRIBUTING.md`, OCR and new input formats are all deliberately out
of scope, listed at the bottom so the decision is on the record rather than forgotten.

Five items, in the order they should be done. The first is a real bug that silently breaks the
thing the project exists to do.

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

- **`--min -1` never reaches our guard.** `parseArgs` reads a bare leading dash as another option and
  rejects it first, with its own message pointing at `--min=-1`. That form is what the test uses.
- **`Number('')` is `0`**, so an empty `--min` would have read as "no minimum" — the same class of
  quiet coercion as the `NaN` bug it was added to fix. The guard tests the string's shape instead.
