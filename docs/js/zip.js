/* Minimal ZIP (and therefore OOXML) reader — no dependencies.
   Uses the platform DecompressionStream for deflate payloads (Chrome 80+, Edge, Safari 16.4+, Node 18+). */

const utf8 = new TextDecoder('utf-8');

function findEOCD(view, len) {
  const max = Math.min(len, 65557);
  for (let i = len - 22; i >= len - max && i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress .pptx/.docx files (no DecompressionStream). Use Chrome, Edge, Safari 16.4+ or Firefox 113+.');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a zip archive.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<{names: string[], has(name): boolean, read(name): Promise<string|null>, readBytes(name): Promise<Uint8Array|null>}>}
 */
export async function openZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEOCD(view, bytes.byteLength);
  if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record).');

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const rawSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = utf8.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    // Zip64 escape values (0xFFFFFFFF) — we only support the normal sizes.
    entries.set(name, { name, method, compSize, rawSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }

  const cache = new Map();

  async function readBytes(name) {
    if (cache.has(name)) return cache.get(name);
    const e = entries.get(name);
    if (!e) return null;
    const lo = e.localOffset;
    if (view.getUint32(lo, true) !== 0x04034b50) throw new Error(`Corrupt local header for ${name}`);
    const lnameLen = view.getUint16(lo + 26, true);
    const lextraLen = view.getUint16(lo + 28, true);
    const start = lo + 30 + lnameLen + lextraLen;
    const raw = bytes.subarray(start, start + (e.compSize || e.rawSize));
    let out;
    if (e.method === 0) out = raw.slice();
    else if (e.method === 8) out = await inflateRaw(raw);
    else throw new Error(`Unsupported zip compression method ${e.method} in ${name}`);
    cache.set(name, out);
    return out;
  }

  async function read(name) {
    const b = await readBytes(name);
    return b ? utf8.decode(b) : null;
  }

  return {
    names: [...entries.keys()],
    has: name => entries.has(name),
    read,
    readBytes,
  };
}

export function isOoxml(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b;
}
