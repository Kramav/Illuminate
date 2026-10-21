<!-- illuminate-template v1 -->
# Notes template

How lecture notes and the study sheet are written. `study.js` checks the parts of this that can be
checked: citations, coverage, and what the merge keeps. The rest is on whoever writes the notes. Bump
the version on the first line whenever the format changes; `study.js status` then marks every
`notes.md` written against the old one as stale.

## Per-lecture notes: `<out>/<lecture>/notes.md`

### Inputs

- `slides.md`: every slide's extracted text, numbered the way a citation writes it (`## s7`).
- Every slide marked `[image-needed: …]`: **open its image** (`images/s007.png`). The reason says
  what the text is missing.
- Every `[equation k → images/s007-eqk.png]`: **read the formula from that crop**, not from the full
  slide. These decks store equations as pictures, so the crop is the only source for the formula.

### Rules

1. **Slides only.** Every statement comes from the slides. Anything you add to make a point clear (a
   missing step, an intuition, a definition the slide assumes) ends with `(added)`. Never present
   outside knowledge as something the lecture said.
2. **Cite every bullet** at its end, using exactly this grammar:
   `[s12]` · `[s12-14]` · `[s3, s7-8]`. No other forms. The checker can't read anything else, and
   a citation it can't read counts as a missing slide.
3. **Account for every slide.** Each visible slide is cited by at least one bullet or listed under
   `## Skipped` with a reason. `node study.js coverage <out> <lecture>` must pass.
4. **Lead with the term.** Every bullet under Concepts, Definitions and Formulas starts with the
   term in bold: `- **Perceptron** — …`. The concept index for the merge is built from these.
5. **Formulas in LaTeX** (`$…$` inline, `$$…$$` on its own line), with every symbol defined the
   way the slide defines it. If a symbol can't be made out, write `(?)` in its place and add the slide
   to `unread.md`. Never guess a symbol.
6. **Worked examples only if the slides have them.** Keep the numbers and the steps. Don't invent
   an example.
7. **Exam questions are generated and labelled as such.** Base them on what the lecture spends
   time on: repeated points, worked examples, things stated as important. Each one cites the slides
   it tests.
8. **Anything you can't interpret** goes in `unread.md`, one line per slide:
   `- s47: diagram labels illegible even in the image`. It's better to list a slide there than to
   paper over it.

### Format

```markdown
<!-- illuminate-notes deck=<first 12 of sha256> template=v1 -->   ← node study.js stamp <out> <lecture>
# Lecture N — <topic>

## Concepts
- **Term** — the idea, in the lecture's own terms. [s4-5]

## Definitions
- **Term** — the definition as stated. [s6]

## Formulas
- **Name**: $y = \sigma\left(\sum_i w_i x_i + b\right)$ — where $w_i$ is …, $b$ is … [s12]

## Worked examples
- **What is being worked out** — setup, steps, result. [s20-22]

## Likely exam questions
_Generated from the lecture's emphasis, not from the slides._
- Explain why … [s12-14]

## Skipped
- [s1] title slide
- [s2] agenda
```

## The study sheet: `<out>/study-sheet.md`

1. **Merge from the notes, never from the slides.** The notes are the checked record. Going back
   to the slides at this stage brings back everything the checks were for.
2. **Start from `index.md`** (`node study.js index <out>`). Its "merge candidates" list every term
   defined in more than one lecture. Decide each one deliberately: merge the entries if they say the
   same thing, or keep both with their differences if they don't.
3. **Organise by topic, in lecture order.** The course builds in that order. Group related material
   under `##` topic headings, and within a topic put it in the order it was taught.
4. **Keep every citation, with its lecture:** `[L3 s12]`, `[L3 s12-14; L5 s4]`. A merged entry
   carries the citations of everything merged into it. `node study.js coverage <out> --sheet` must
   report nothing dropped.
5. **Keep the `(added)` markers and the generated-question label.**
6. **End with `## Could not interpret`**, collecting every lecture's `unread.md`, so the gaps stay
   visible in the finished sheet.
