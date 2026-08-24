/**
 * The two things both Office parsers need from XML, and nothing more.
 *
 * These files are read with regexes rather than a parser, which is a deliberate limit: OOXML is
 * enormous, we want four things out of it (paragraph, run, bold, text), and those four sit in
 * predictable elements. A real parser would be a dependency and a lot of tree-walking to arrive at
 * the same strings. What the regexes cannot survive is unusual nesting — see the note in pptx.js.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Undo XML escaping, including the numeric forms Word writes for typographic punctuation. */
export function decode(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/**
 * Every `<tag>…</tag>` at any depth, as raw inner strings.
 *
 * Non-greedy, so a tag that legitimately nests inside itself would close early. None of the elements
 * this is used on (`a:p`, `a:r`, `w:p`, `w:r`) ever do.
 */
export function elements(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}
