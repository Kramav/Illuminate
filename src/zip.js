/**
 * Reading a ZIP archive, which is all a .pptx or .docx is.
 *
 * There is no zip module in Node, but there is `zlib`, and the only thing standing between the two
 * is a header format that has not changed since 1989. Office files use exactly two of its storage
 * methods — stored and deflate — so the whole reader is the central directory walk below plus one
 * call to `inflateRawSync`. A dependency here would be several thousand lines to avoid seventy.
 *
 * Entries are located through the **central directory** rather than by scanning local headers, which
 * matters: a local header is allowed to carry zeroes for the sizes and defer them to a descriptor
 * that follows the data, and Office writers do exactly that. The central directory always has the
 * real numbers.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const STORED = 0;
const DEFLATED = 8;

/**
 * The End of Central Directory record, found by scanning backwards.
 *
 * It has no fixed position because a trailing comment of up to 64KB may follow it, so the format
 * offers no way to find it other than looking for the signature from the end — which is also why
 * the scan is bounded: past 64KB + the record's own 22 bytes, a match is a coincidence in file data.
 */
function findEndRecord(buf) {
  const earliest = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= earliest; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip file (no end-of-central-directory record)');
}

/**
 * Open an archive held in memory.
 *
 * ponytail: no zip64. That format extends past 4GB and 65535 entries; a slide deck reaches neither,
 * and the marker for it — 0xffff/0xffffffff in the fields read below — would surface as an obviously
 * wrong offset rather than as silently wrong data. Add it if a real file ever needs it.
 *
 * @returns {{ names: () => string[], has: (name: string) => boolean, read: (name: string) => Buffer }}
 */
export function openZip(buf) {
  const end = findEndRecord(buf);
  const count = buf.readUInt16LE(end + 10);
  const entries = new Map();

  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error(`corrupt zip: central directory entry ${i + 1} has no signature`);
    }
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const read = (name) => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`${name} is not in this archive`);
    if (buf.readUInt32LE(entry.offset) !== LOCAL_SIG) {
      throw new Error(`corrupt zip: ${name} has no local header`);
    }
    // The local header's own name and extra lengths are read here rather than reused from the
    // central directory, because the two are allowed to differ — writers pad the local extra field
    // for alignment. Trusting the central copy would start the read a few bytes into the data.
    const start = entry.offset + 30
      + buf.readUInt16LE(entry.offset + 26)
      + buf.readUInt16LE(entry.offset + 28);
    const data = buf.subarray(start, start + entry.size);
    if (entry.method === STORED) return data;
    if (entry.method === DEFLATED) return inflateRawSync(data);
    throw new Error(`${name} uses unsupported compression method ${entry.method}`);
  };

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read,
  };
}
