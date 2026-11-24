/**
 * Web pages — a saved page, a Google Docs or Notion export, Word's "Save as Web Page".
 *
 * Read the way a Word document is read: headings open sections, bold survives per run, and a table
 * row becomes one line with its cells separated by tabs. HTML adds one structure the Office formats
 * lack, the definition list, and it is the most explicit term/definition marker any of the formats
 * has — so a `<dt>` and its `<dd>` become one tab-joined line and take the same path a table row does.
 *
 * The Office readers pull predictable elements out with regexes, and that does not carry over. HTML
 * leaves end tags out as a matter of course (`<li>`, `<p>`, `<td>`), and a page is mostly furniture
 * — navigation, a site header, a footer — wrapped around the part worth reading. So this tokenizes
 * and walks a stack. It is still not a parser: it implies only the end tags notes actually omit, and
 * it reads CSS only far enough to learn which classes mean bold.
 */

import { decode } from './xml.js';

/**
 * Every entity HTML 4 named, which is the set real pages use. HTML5 added two thousand more; a page
 * using one of those keeps it as written, the same as an entity nobody ever defined.
 */
const ENTITIES = (() => {
  const table = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'" };
  const run = (start, names) => names.split(' ').forEach((name, i) => {
    if (name !== '-') table[name] = String.fromCodePoint(start + i);
  });
  run(0xa0, 'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg '
    + 'plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest '
    + 'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc '
    + 'Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute '
    + 'THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave '
    + 'iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc '
    + 'uuml yacute thorn yuml');
  // 0x3a2 is unassigned — there is no capital final sigma.
  run(0x391, 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho - '
    + 'Sigma Tau Upsilon Phi Chi Psi Omega');
  run(0x3b1, 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho '
    + 'sigmaf sigma tau upsilon phi chi psi omega');
  const rest = `OElig:152 oelig:153 Scaron:160 scaron:161 Yuml:178 fnof:192 circ:2c6 tilde:2dc
    thetasym:3d1 upsih:3d2 piv:3d6 ensp:2002 emsp:2003 thinsp:2009 zwnj:200c zwj:200d lrm:200e
    rlm:200f ndash:2013 mdash:2014 lsquo:2018 rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e
    dagger:2020 Dagger:2021 bull:2022 hellip:2026 permil:2030 prime:2032 Prime:2033 lsaquo:2039
    rsaquo:203a oline:203e frasl:2044 euro:20ac image:2111 weierp:2118 real:211c trade:2122
    alefsym:2135 larr:2190 uarr:2191 rarr:2192 darr:2193 harr:2194 crarr:21b5 lArr:21d0 uArr:21d1
    rArr:21d2 dArr:21d3 hArr:21d4 forall:2200 part:2202 exist:2203 empty:2205 nabla:2207 isin:2208
    notin:2209 ni:220b prod:220f sum:2211 minus:2212 lowast:2217 radic:221a prop:221d infin:221e
    ang:2220 and:2227 or:2228 cap:2229 cup:222a int:222b there4:2234 sim:223c cong:2245 asymp:2248
    ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 nsub:2284 sube:2286 supe:2287 oplus:2295
    otimes:2297 perp:22a5 sdot:22c5 lceil:2308 rceil:2309 lfloor:230a rfloor:230b lang:2329
    rang:232a loz:25ca spades:2660 clubs:2663 hearts:2665 diams:2666`;
  for (const pair of rest.trim().split(/\s+/)) {
    const [name, hex] = pair.split(':');
    table[name] = String.fromCodePoint(parseInt(hex, 16));
  }
  return table;
})();

/** Elements that begin and end a line of their own. */
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd',
  'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'html', 'li', 'main', 'menu', 'nav', 'ol',
  'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);

/** Elements with no content and no end tag. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr']);

/** Elements whose content is not markup at all; the tokenizer steps straight over it. */
const RAW = new Set(['script', 'style', 'title', 'textarea', 'iframe', 'xmp']);

/** Furniture and controls — never material, whatever text they hold. */
const SKIP = new Set(['nav', 'footer', 'noscript', 'template', 'svg', 'canvas', 'button', 'select',
  'object', 'dialog']);
const SKIP_ROLE = new Set(['navigation', 'contentinfo', 'search']);

/**
 * Furniture only outside an article. A page's `<header>` is the site's name and menu, and its
 * `<aside>` is a sidebar — but an article's header holds the article's own title, and an aside inside
 * it is a callout box, which in notes is exactly where a key term gets defined.
 */
const SITE_ONLY = new Set(['header', 'aside']);
const SITE_ONLY_ROLE = new Set(['banner', 'complementary']);

const LIST = new Set(['ul', 'ol', 'menu']);
const HEADING = /^h[1-6]$/;

/**
 * End tags HTML lets an author leave out: which open elements a start tag closes, and which it will
 * not look past. A new `<li>` closes the open one, but not one belonging to a list further out.
 */
const IMPLIED = {
  li: [['li'], ['ul', 'ol', 'menu', 'table']],
  dt: [['dt', 'dd'], ['dl', 'table']],
  dd: [['dt', 'dd'], ['dl', 'table']],
  tr: [['tr'], ['table', 'thead', 'tbody', 'tfoot']],
  td: [['td', 'th'], ['tr', 'table']],
  th: [['td', 'th'], ['tr', 'table']],
  thead: [['thead', 'tbody', 'tfoot'], ['table']],
  tbody: [['thead', 'tbody', 'tfoot'], ['table']],
  tfoot: [['thead', 'tbody', 'tfoot'], ['table']],
};

/** Comments and declarations, an end tag, a start tag, a run of text — or a `<` that is just text. */
const TOKEN = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\?[^>]*>|<\/([A-Za-z][^\s/>]*)[^>]*>|<([A-Za-z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</y;
const ATTRIBUTE = /([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/**
 * Every name browsers read as windows-1252 — ISO-8859-1 and ASCII included, per the WHATWG encoding
 * standard, because pages that declare those were almost always written in windows-1252 anyway.
 */
const WINDOWS_1252 = new Set(['ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819',
  'iso-8859-1', 'iso-ir-100', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1',
  'us-ascii', 'windows-1252', 'x-cp1252']);

/** What windows-1252 puts at 0x80–0x9F, where ISO-8859-1 has control codes. Unassigned bytes pass through. */
const CP1252_HIGH = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160,
  0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc,
  0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];

/**
 * windows-1252 by hand rather than through TextDecoder, which on Node 20 reads the label as plain
 * ISO-8859-1 and returns control characters for exactly the bytes this exists to get right — the em
 * dash and the curly quotes. Everything outside 0x80–0x9F is the byte's own code point.
 */
function cp1252(bytes) {
  let out = '';
  for (const b of bytes) out += String.fromCharCode(b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80] : b);
  return out;
}

/**
 * The page's text, in whatever encoding it says it is in.
 *
 * Mostly UTF-8 — but Word's "Save as Web Page" writes windows-1252, and read as UTF-8 every curly
 * quote and em dash in it turns to `�`. The em dash is the separator the `Term — definition` rule
 * looks for, so a mis-decoded Word page loses cards, not just punctuation. Browsers look for the
 * declaration in the first 1024 bytes; so does this.
 */
function textOf(buf) {
  const bytes = Buffer.from(buf);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8'
    : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  const declared = /<meta[^>]*charset\s*=\s*["']?\s*([\w.:-]+)/i
    .exec(bytes.subarray(0, 1024).toString('latin1'))?.[1];
  // A page whose declaration could be read as ASCII is not UTF-16, whatever it says — browsers
  // settle that contradiction as UTF-8, and so does this.
  const label = bom ?? (declared && !/^utf-?16/i.test(declared) ? declared : 'utf-8');
  if (WINDOWS_1252.has(label.toLowerCase())) return cp1252(bytes);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function attributesOf(s) {
  const out = Object.create(null);
  for (const [, name, dq, sq, bare] of s.matchAll(ATTRIBUTE)) {
    out[name.toLowerCase()] ??= decode(dq ?? sq ?? bare ?? '', ENTITIES);
  }
  return out;
}

/** The page as tokens, plus the contents of its `<style>` blocks. */
function tokenize(html) {
  const tokens = [];
  const styles = [];
  const re = new RegExp(TOKEN);
  while (re.lastIndex < html.length) {
    const [whole, close, open, attrs = ''] = re.exec(html);
    if (close) {
      tokens.push({ type: 'close', name: close.toLowerCase() });
    } else if (open) {
      const name = open.toLowerCase();
      const selfClosing = /\/\s*$/.test(attrs);
      if (RAW.has(name) && !selfClosing) {
        const end = new RegExp(`</${name}(?=[\\s/>])[^>]*>`, 'gi');
        end.lastIndex = re.lastIndex;
        const found = end.exec(html);
        if (name === 'style') styles.push(html.slice(re.lastIndex, found ? found.index : html.length));
        re.lastIndex = found ? end.lastIndex : html.length;
        continue;
      }
      tokens.push({ type: 'open', name, attrs: attributesOf(attrs), selfClosing });
    } else if (whole === '<' || whole[0] !== '<') {
      tokens.push({ type: 'text', text: whole });
    }
  }
  return { tokens, styles };
}

/** true for a bold `font-weight`, false for a normal one, null when the declarations do not say. */
function weightOf(declarations) {
  const value = [...declarations.matchAll(/font-weight\s*:\s*([\w-]+)/gi)].at(-1)?.[1].toLowerCase();
  if (!value) return null;
  if (value === 'bold' || value === 'bolder') return true;
  if (value === 'normal' || value === 'lighter') return false;
  return /^\d+$/.test(value) ? Number(value) >= 600 : null;
}

/**
 * Which classes the page's own stylesheet makes bold, or makes explicitly not bold.
 *
 * This much CSS is here for one producer: Google Docs, whose HTML export marks bold with a generated
 * class (`.c7{font-weight:700}`) and never with `<b>`. Without it every bold lead-in in a Docs export
 * — the strongest term marker there is — would arrive as plain text. Only rules whose selector is a
 * bare class are read. Anything more specific depends on where the element sits, and guessing at
 * that is how a whole page ends up bold.
 *
 * @returns {Map<string, { bold: boolean, order: number }>}  `order` settles an element carrying two
 *   classes that disagree: as in CSS, the rule written later wins.
 */
function weightClasses(styles) {
  const classes = new Map();
  let order = 0;
  for (const css of styles) {
    for (const [, selectors, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const bold = weightOf(body);
      if (bold === null) continue;
      order += 1;
      for (const selector of selectors.split(',')) {
        const name = /^\s*\.([\w-]+)\s*$/.exec(selector)?.[1];
        if (name) classes.set(name, { bold, order });
      }
    }
  }
  return classes;
}

/**
 * Whether an element's text is bold: its own style, then its classes, then what its tag means, then
 * whatever it sits inside — the order CSS resolves it in.
 *
 * The explicit "not bold" answers matter as much as the bold ones. Google Docs wraps copied text in
 * `<b style="font-weight:normal">`, and reading the tag alone would make the entire page bold. A line
 * bold all the way through is a sub-heading to the bold rule, so every real bold lead-in on the page
 * would be lost — the same inversion `<w:b w:val="0"/>` causes in a Word file.
 */
function boldOf(tok, parent, weights) {
  const inline = weightOf(tok.attrs.style ?? '');
  if (inline !== null) return inline;
  let ruled = null;
  for (const name of (tok.attrs.class ?? '').split(/\s+/)) {
    const rule = weights.get(name);
    if (rule && (!ruled || rule.order > ruled.order)) ruled = rule;
  }
  if (ruled) return ruled.bold;
  if (tok.name === 'b' || tok.name === 'strong') return true;
  return parent.bold;
}

const isMain = (tok) => tok.name === 'main' || tok.attrs.role?.toLowerCase() === 'main';
const isHidden = (tok) => 'hidden' in tok.attrs || tok.attrs['aria-hidden'] === 'true'
  || /display\s*:\s*none/i.test(tok.attrs.style ?? '');

/** A cell's or a definition's collected text, with its internal line breaks flattened to spaces. */
const squash = (buffer) => buffer.text.replace(/\s+/g, ' ').trim();

/**
 * Read a page into sections, split at headings.
 *
 * @param {Buffer} buf
 * @returns {Array<{ title: string, ref: string, lines: Array, notes: string }>}
 */
export function readHtml(buf) {
  const { tokens, styles } = tokenize(textOf(buf));
  const weights = weightClasses(styles);
  // A page that marks its content with <main> has said where the material is, and everything outside
  // it is chrome however it is marked up. Without one, furniture is recognized element by element.
  const scoped = tokens.some((t) => t.type === 'open' && isMain(t) && !isHidden(t));

  const sections = [];
  let current = null;
  const open = (title) => {
    sections.push({ title, ref: `sec-${sections.length + 1}`, lines: [], notes: '' });
    current = sections[sections.length - 1];
  };
  const addLine = (l) => {
    if (!current) open('');
    current.lines.push(l);
  };

  let line = null;
  const flush = () => {
    if (line) addLine({ text: line.runs.map((r) => r.text).join(''), runs: line.runs, level: line.level });
    line = null;
  };
  /** A table row or a definition: one unbolded run, exactly as the Office readers emit a row. */
  const emit = (text) => {
    flush();
    if (text) addLine({ text, runs: [{ text, bold: false }], level: 0 });
  };

  const root = {
    name: '', skip: scoped, bold: false, depth: 0, article: false, pre: false,
    capture: null, row: null, dl: null, owns: null,
  };
  const stack = [root];
  const top = () => stack[stack.length - 1];

  /**
   * A line ends here — or, inside a cell, a definition or a heading, a space does the same job. A
   * paragraph break inside a table cell is not a new line of the page; the cell wall is the boundary.
   */
  const boundary = () => {
    const { capture } = top();
    if (capture) capture.text += ' ';
    else flush();
  };

  /** A definition list's pending terms and definitions, as one tab-joined line. */
  const pair = (dl) => {
    const terms = dl.terms.map(squash).filter(Boolean);
    const defs = dl.defs.map(squash).filter(Boolean);
    dl.terms = [];
    dl.defs = [];
    emit([terms.join(', '), defs.join(' ')].filter(Boolean).join('\t'));
  };

  const pop = () => {
    const entry = stack.pop();
    if (entry.owns === 'row') {
      const cells = entry.row.cells.map(squash);
      if (cells.some(Boolean)) emit(cells.join('\t'));
    } else if (entry.owns === 'dl') {
      pair(entry.dl);
    } else if (entry.owns === 'heading') {
      const title = squash(entry.capture);
      if (title) {
        flush();
        open(title);
      }
    }
    if (BLOCK.has(entry.name)) boundary();
  };

  /** Close the nearest open element named in `targets`, unless `stops` says to look no further. */
  const closeImplied = (targets, stops) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (targets.includes(stack[i].name)) {
        while (stack.length > i) pop();
        return;
      }
      if (stops(stack[i].name)) return;
    }
  };

  const append = (s, at) => {
    if (!line) {
      if (!s.trim()) return;
      line = { runs: [], level: Math.max(0, at.depth - 1) };
    }
    const last = line.runs[line.runs.length - 1];
    if (last && last.bold === at.bold) last.text += s;
    else line.runs.push({ text: s, bold: at.bold });
  };

  const text = (raw) => {
    const at = top();
    if (at.skip) return;
    const s = decode(raw, ENTITIES);
    if (at.pre && !at.capture) {
      // Preformatted text keeps its line breaks, and its tabs: one typed there is as deliberate as
      // one typed into a Word glossary.
      s.split(/\r?\n/).forEach((piece, i) => {
        if (i) flush();
        append(piece, at);
      });
      return;
    }
    // Everywhere else a tab in the source is indentation, not a column. Left as a tab it would reach
    // the tab rule as a term/definition boundary the author never drew.
    const flat = s.replace(/[\t\n\f\r ]+/g, ' ');
    if (at.capture) at.capture.text += flat;
    else append(flat, at);
  };

  const enter = (tok) => {
    const { name } = tok;
    if (BLOCK.has(name)) closeImplied(['p'], (n) => BLOCK.has(n));
    if (IMPLIED[name]) {
      const [targets, stops] = IMPLIED[name];
      closeImplied(targets, (n) => stops.includes(n));
    }
    if (BLOCK.has(name) || name === 'br') boundary();
    if (VOID.has(name)) return;

    const parent = top();
    const role = tok.attrs.role?.toLowerCase() ?? '';
    const furniture = SKIP.has(name) || SKIP_ROLE.has(role)
      || ((SITE_ONLY.has(name) || SITE_ONLY_ROLE.has(role)) && !parent.article);
    const entry = {
      name,
      skip: isHidden(tok) || furniture || (parent.skip && !(scoped && isMain(tok))),
      bold: boldOf(tok, parent, weights),
      depth: parent.depth + (LIST.has(name) ? 1 : 0),
      article: parent.article || name === 'article' || isMain(tok),
      pre: parent.pre || name === 'pre',
      capture: parent.capture,
      row: parent.row,
      dl: parent.dl,
      owns: null,
    };

    // Structure nested inside a cell or a definition is read as that cell's text, not as a table or
    // a list of its own. That keeps a nested table from cutting its outer row in half — the limit the
    // Office readers note for themselves.
    if (!parent.capture && !entry.skip) {
      if (name === 'tr') {
        entry.row = { cells: [] };
        entry.owns = 'row';
      } else if ((name === 'td' || name === 'th') && parent.row) {
        entry.capture = { text: '' };
        parent.row.cells.push(entry.capture);
      } else if (name === 'dl') {
        entry.dl = { terms: [], defs: [] };
        entry.owns = 'dl';
      } else if ((name === 'dt' || name === 'dd') && parent.dl) {
        // A term after a definition starts the next pair; a second <dt> or <dd> in a row joins this one.
        if (name === 'dt' && parent.dl.defs.length) pair(parent.dl);
        entry.capture = { text: '' };
        parent.dl[name === 'dt' ? 'terms' : 'defs'].push(entry.capture);
      } else if (HEADING.test(name)) {
        entry.capture = { text: '' };
        entry.owns = 'heading';
      }
    }

    stack.push(entry);
    if (tok.selfClosing) pop();
  };

  const leave = (name) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].name === name) {
        while (stack.length > i) pop();
        return;
      }
    }
  };

  for (const tok of tokens) {
    if (tok.type === 'text') text(tok.text);
    else if (tok.type === 'open') enter(tok);
    else leave(tok.name);
  }
  while (stack.length > 1) pop();
  flush();

  if (!sections.length) {
    throw new Error('this page has no readable text — a page that builds itself with JavaScript saves '
      + 'as an empty shell; print it to PDF instead');
  }
  return sections;
}
