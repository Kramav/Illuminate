/**
 * The review page: every note beside the slide it claims to come from.
 *
 * Spot-checking notes against slides by hand means opening the deck, finding slide 47, and comparing
 * — slow enough that it gets done for five bullets and assumed for the rest. Putting the bullet, the
 * slide image, its equation crops and its extracted text side by side makes each check a glance, so
 * all of them can be checked. Formula bullets come first because they are where a misread costs the
 * most and where the source is most often an image.
 *
 * A local file, never published: it embeds course material by reference. Math is typeset by KaTeX
 * from a CDN when online and left as readable `$…$` source when not.
 *
 * Pure: returns an HTML string.
 */

import { noteBullets, sectionsOf, imagePath, equationPath } from './study.js';

const KATEX = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Just enough Markdown for a bullet: bold, italics, code, line breaks. Math is left for KaTeX. */
function inline(md) {
  return esc(md)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

const isFormula = (section) => /formula|equation/i.test(section);

/** At most this many slides drawn per bullet; the rest are listed. Ranges can be long. */
const MAX_SHOWN = 4;

function slidePanel(slide, base) {
  if (!slide) return '<div class="slide missing">no such slide</div>';
  const crops = (slide.visuals?.equations ?? [])
    .map((_, k) => `<img class="eq" loading="lazy" src="${esc(base + equationPath(slide.number, k + 1))}" alt="equation ${k + 1}">`)
    .join('');
  const text = [slide.title && `# ${slide.title}`, ...slide.lines.map((l) => `${'  '.repeat(l.level)}- ${l.text}`),
    ...slide.notes.map((n) => `> ${n}`)].filter(Boolean).join('\n');
  return `<figure class="slide">
  <a href="${esc(base + imagePath(slide.number))}" target="_blank"><img loading="lazy" src="${esc(base + imagePath(slide.number))}" alt="slide ${slide.number}"></a>
  <figcaption>${esc(slide.label)}${slide.reasons?.length ? ` · <span class="why">${esc(slide.reasons.join(', '))}</span>` : ''}</figcaption>
  ${crops ? `<div class="crops">${crops}</div>` : ''}
  <details><summary>extracted text</summary><pre>${esc(text || '(no text)')}</pre></details>
</figure>`;
}

function item(bullet, i, resolve) {
  const refs = bullet.refs.map(resolve);
  const shown = refs.slice(0, MAX_SHOWN);
  const more = refs.slice(MAX_SHOWN).map((r) => r.slide?.label ?? r.label);
  return `<article class="item${isFormula(bullet.section) ? ' formula' : ''}" id="b${i}" data-key="${esc(bullet.text.slice(0, 120))}">
  <div class="note">
    <div class="section">${esc(bullet.section || '—')}</div>
    <div class="text">${inline(bullet.text)}</div>
    ${refs.length ? '' : '<div class="warn">no citation</div>'}
    <div class="verdict">
      <label><input type="radio" name="v${i}" value="ok"> matches</label>
      <label><input type="radio" name="v${i}" value="bad"> wrong</label>
    </div>
  </div>
  <div class="slides">${shown.map((r) => slidePanel(r.slide, r.base)).join('')}${more.length ? `<div class="more">also ${esc(more.join(', '))}</div>` : ''}</div>
</article>`;
}

function page({ title, intro, bullets, resolve }) {
  const ordered = [
    ...bullets.map((b, i) => [b, i]).filter(([b]) => isFormula(b.section)),
    ...bullets.map((b, i) => [b, i]).filter(([b]) => !isFormula(b.section)),
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${KATEX}/katex.min.css">
<style>
:root { --bg:#fbfbfa; --fg:#1d1d1b; --muted:#6b6b66; --card:#ffffff; --line:#e3e2dd; --accent:#2b59c3; --warn:#b3261e; --ok:#1e7b34; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ecebe6; --muted:#9b9a94; --card:#1f1f1d; --line:#33332f; --accent:#8fb0ff; --warn:#ff8a80; --ok:#7bd88f; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui, sans-serif; }
header { position:sticky; top:0; z-index:2; background:var(--bg); border-bottom:1px solid var(--line); padding:12px 16px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
header h1 { font-size:17px; margin:0; }
.tally { color:var(--muted); font-variant-numeric:tabular-nums; }
main { max-width:1400px; margin:0 auto; padding:16px; }
.intro { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 16px; margin-bottom:16px; }
.intro pre { white-space:pre-wrap; margin:0; font:13px/1.45 ui-monospace, monospace; }
.item { display:grid; grid-template-columns:minmax(260px, 2fr) 3fr; gap:16px; background:var(--card); border:1px solid var(--line); border-left:4px solid var(--line); border-radius:8px; padding:12px; margin-bottom:12px; }
.item.formula { border-left-color:var(--accent); }
.item.ok { border-left-color:var(--ok); } .item.bad { border-left-color:var(--warn); }
@media (max-width:800px) { .item { grid-template-columns:1fr; } }
.section { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.text { margin:4px 0 8px; overflow-wrap:anywhere; }
.warn { color:var(--warn); font-weight:600; }
.verdict { display:flex; gap:12px; color:var(--muted); font-size:13px; }
.slides { display:grid; gap:12px; }
.slide { margin:0; }
.slide img { width:100%; border:1px solid var(--line); border-radius:4px; background:#fff; }
.slide figcaption { font-size:13px; color:var(--muted); }
.why { color:var(--accent); }
.crops { display:flex; flex-wrap:wrap; gap:8px; margin-top:6px; }
.crops img.eq { max-width:100%; max-height:140px; width:auto; background:#fff; border:1px solid var(--line); }
details pre { white-space:pre-wrap; font:12px/1.4 ui-monospace, monospace; margin:4px 0 0; }
.more, .missing { color:var(--muted); font-size:13px; }
.hide { display:none; }
</style></head><body>
<header><h1>${esc(title)}</h1>
<label><input type="checkbox" id="formulas"> formulas only</label>
<label><input type="checkbox" id="unchecked"> unchecked only</label>
<span class="tally" id="tally"></span></header>
<main>
${intro ? `<section class="intro">${intro}</section>` : ''}
${ordered.map(([b, i]) => item(b, i, resolve)).join('\n')}
</main>
<script>
// Verdicts are a per-reader convenience, kept in this browser only — the notes files are the record.
const KEY = 'illuminate-review:' + document.title;
let saved = {};
try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
const items = [...document.querySelectorAll('.item')];
function paint() {
  let ok = 0, bad = 0;
  const onlyF = document.getElementById('formulas').checked, onlyU = document.getElementById('unchecked').checked;
  for (const el of items) {
    const v = saved[el.dataset.key];
    el.classList.toggle('ok', v === 'ok'); el.classList.toggle('bad', v === 'bad');
    if (v === 'ok') ok++; if (v === 'bad') bad++;
    el.classList.toggle('hide', (onlyF && !el.classList.contains('formula')) || (onlyU && Boolean(v)));
    for (const r of el.querySelectorAll('input[type=radio]')) r.checked = r.value === v;
  }
  document.getElementById('tally').textContent = items.length + ' notes · ' + ok + ' match · ' + bad + ' wrong · ' + (items.length - ok - bad) + ' unchecked';
}
document.addEventListener('change', (e) => {
  const el = e.target.closest('.item');
  if (el && e.target.type === 'radio') { saved[el.dataset.key] = e.target.value; try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch {} }
  paint();
});
paint();
</script>
<script defer src="${KATEX}/katex.min.js"></script>
<script defer src="${KATEX}/contrib/auto-render.min.js" onload="renderMathInElement(document.body,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false})"></script>
</body></html>
`;
}

const label = (lectureNo, n) => (lectureNo == null ? `s${n}` : `L${lectureNo} s${n}`);

/**
 * The review page for one lecture's notes.
 *
 * @param {object} lecture  the lecture record (slides.json)
 * @param {string} notes    notes.md
 * @param {string} [unread] unread.md, shown first: the slides the notes could not cover
 */
export function lectureReview(lecture, notes, unread = '') {
  const bySlide = new Map(lecture.slides.map((s) => [s.number, { ...s, label: label(lecture.lecture, s.number) }]));
  const bullets = noteBullets(notes, { lecture: lecture.lecture })
    .filter((b) => !/^skipped\b/i.test(b.section));
  const skipped = sectionsOf(notes).filter((s) => /^skipped\b/i.test(s.heading)).flatMap((s) => s.lines).join('\n').trim();
  const intro = [
    unread.trim() && `<h2>Could not interpret</h2><pre>${esc(unread.trim())}</pre>`,
    skipped && `<h2>Skipped</h2><pre>${esc(skipped)}</pre>`,
  ].filter(Boolean).join('');
  return page({
    title: `Review — Lecture ${lecture.lecture ?? ''} ${lecture.source}`.replace(/\s+/g, ' '),
    intro,
    bullets,
    resolve: (ref) => ({ slide: bySlide.get(ref.slide), base: '', label: label(lecture.lecture, ref.slide) }),
  });
}

/**
 * The review page for the merged sheet, which cites across lectures.
 *
 * @param {string} sheet  study-sheet.md
 * @param {Map<number, {lecture: object, dir: string}>} lectures  by lecture number; `dir` is the
 *        lecture's folder relative to the sheet
 */
export function sheetReview(sheet, lectures) {
  const bullets = noteBullets(sheet).filter((b) => !/^(?:could not|unread|uninterpret)/i.test(b.section));
  return page({
    title: 'Review — study sheet',
    intro: '',
    bullets,
    resolve: (ref) => {
      const entry = lectures.get(ref.lecture);
      const s = entry?.lecture.slides.find((x) => x.number === ref.slide);
      return {
        slide: s && { ...s, label: label(ref.lecture, s.number) },
        base: entry ? `${entry.dir}/` : '',
        label: label(ref.lecture, ref.slide),
      };
    },
  });
}

