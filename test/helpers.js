/**
 * Fixture building.
 *
 * The parsers are only worth trusting if they are tested against a real archive rather than against
 * a hand-made object that skips the format, so the tests write actual ZIP bytes and read them back
 * through the same `openZip` the tool uses. That needs a writer, and a writer is thirty lines.
 */

import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Build a ZIP archive in memory.
 *
 * Both storage methods are exercised deliberately — deflate for anything compressible, stored for
 * short entries where deflate would grow them — because Office writers use both and a reader that
 * only handled one would pass a single-method test and fail on a real file.
 */
export function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const raw = Buffer.from(content, 'utf8');
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** One PowerPoint paragraph, as runs of `[text, bold]`. */
export const para = (runs, level = 0) =>
  `<a:p><a:pPr lvl="${level}"/>${runs
    .map(([text, bold]) => `<a:r><a:rPr${bold ? ' b="1"' : ''}/><a:t>${text}</a:t></a:r>`)
    .join('')}</a:p>`;

/** A slide: a title placeholder plus a body of paragraphs. */
export const slideXml = (title, paragraphs) => `<?xml version="1.0"?>
<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
    <p:txBody>${para([[title, false]])}</p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
    <p:txBody>${paragraphs.join('')}</p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr>
    <p:txBody>${para([['CONFIDENTIAL DRAFT', false]])}</p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

/** A Word paragraph, as runs of `[text, bold]`. */
export const wpara = (runs, style = '') =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}</w:pPr>${runs
    .map(([text, bold]) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`)
    .join('')}</w:p>`;

export const documentXml = (paragraphs) => `<?xml version="1.0"?>
<w:document xmlns:w="w"><w:body>${paragraphs.join('')}</w:body></w:document>`;

/**
 * A deck shaped like the 2026 lectures: slide parts numbered out of presentation order, a hidden
 * slide, an Equation Editor object stored PowerPoint's way (real object plus picture fallback), and
 * text typed with Symbol-font Greek and subscript runs.
 */
export function lectureDeck() {
  const run = (text) => `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`;
  const symRun = (text) => `<a:r><a:rPr lang="en-US"><a:sym typeface="Symbol"/></a:rPr><a:t>${text}</a:t></a:r>`;
  const body = (paras) => `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>${paras}</p:txBody></p:sp>`;
  const title = (text) => `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>${para([[text, false]])}</p:txBody></p:sp>`;
  const sld = (inner, attrs = '') => `<?xml version="1.0"?><p:sld xmlns:p="p" xmlns:a="a"${attrs}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`;
  const equation = `<mc:AlternateContent xmlns:mc="mc"><mc:Choice Requires="v"><p:graphicFrame>
      <p:xfrm><a:off x="914400" y="685800"/><a:ext cx="1828800" cy="342900"/></p:xfrm>
      <a:graphic><a:graphicData><p:oleObj progId="Equation.3" r:id="rId9"><p:embed/></p:oleObj></a:graphicData></a:graphic>
    </p:graphicFrame></mc:Choice><mc:Fallback><p:graphicFrame><p:pic><p:blipFill/></p:pic></p:graphicFrame>
    ${body(para([['FALLBACK COPY', false]]))}</mc:Fallback></mc:AlternateContent>`;

  return makeZip({
    'ppt/presentation.xml': '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>'
      + '<p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId4"/>'
      + '</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships>'
      + '<Relationship Id="rId2" Target="slides/slide1.xml"/>'
      + '<Relationship Id="rId3" Target="slides/slide2.xml"/>'
      + '<Relationship Id="rId4" Target="/ppt/slides/slide3.xml"/></Relationships>',
    // Shown first, though its part is slide2.xml.
    'ppt/slides/slide2.xml': sld(title('Gradient Descent')
      + body(`<a:p>${run('the learning rate ')}${symRun('\uF068')}</a:p>`
        + `<a:p>${run('w')}<a:r><a:rPr lang="en-US" baseline="-25000"/><a:t>i</a:t></a:r>`
        + `<a:r><a:rPr lang="en-US" baseline="-25000"/><a:t>j</a:t></a:r>${run(' is a weight')}</a:p>`)
      + equation),
    'ppt/slides/slide1.xml': sld(title('Backup material') + body(para([['not shown in class', false]])), ' show="0"'),
    'ppt/slides/slide3.xml': sld(title('Summary') + body(para([['Descent follows the negative gradient', false]]))),
  });
}
