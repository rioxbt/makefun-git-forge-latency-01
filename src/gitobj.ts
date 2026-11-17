// git object primitives: SHA-1 ids, pkt-lines, packfiles, trees, commits and tags.
//
// There is no git binary in the trial pod and nothing to install, so a smart-HTTP server has to
// bring its own object layer: ids and zlib framing on node:crypto and node:zlib, packfile read
// (including OFS_DELTA and REF_DELTA) and packfile write.

import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
/** One entry per code, so the hot paths index an array instead of walking a record. */
const CODE_TYPE_LIST: Array<ObjType | undefined> = [undefined, 'commit', 'tree', 'blob', 'tag'];

export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** The id git gives an object: sha1 of `<type> <len>\0` plus its bytes. */
export function objectId(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'utf8'), data]));
}

// ----------------------------------------------------------------- pkt-line

const PKT_HEADER_CACHE = new Map<number, Buffer>();

export function pktLine(text: string | Buffer): Buffer {
  const payload = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const length = payload.length + 4;
  let header = PKT_HEADER_CACHE.get(length);
  if (header === undefined) {
    header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
    if (PKT_HEADER_CACHE.size < 4096) PKT_HEADER_CACHE.set(length, header);
  }
  return Buffer.concat([header, payload]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');
export const RESPONSE_END_PKT = Buffer.from('0002', 'ascii');

export function pktLines(parts: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    if (part === 'flush') out.push(FLUSH_PKT);
    else if (part === 'delim') out.push(DELIM_PKT);
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** A pkt-line length header's four hex digits, decoded from a byte-level table (no allocation). */
const HEX_NIBBLE = new Int8Array(256).fill(-1);
for (let code = 48; code <= 57; code += 1) HEX_NIBBLE[code] = code - 48;
for (let code = 97; code <= 102; code += 1) HEX_NIBBLE[code] = code - 87;
for (let code = 65; code <= 70; code += 1) HEX_NIBBLE[code] = code - 55;

/** Parse a pkt-line stream; a truncated or malformed stream stops at the damage. */
export function parsePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const n0 = HEX_NIBBLE[buf[pos]];
    const n1 = HEX_NIBBLE[buf[pos + 1]];
    const n2 = HEX_NIBBLE[buf[pos + 2]];
    const n3 = HEX_NIBBLE[buf[pos + 3]];
    if (n0 < 0 || n1 < 0 || n2 < 0 || n3 < 0) break;
    const length = (n0 << 12) | (n1 << 8) | (n2 << 4) | n3;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: buf.subarray(pos, pos + 4) });
      pos += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: buf.subarray(pos, pos + 4) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: buf.subarray(pos, pos + 4) });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, rest: buf.subarray(pos) };
}

// ----------------------------------------------------------------- zlib

/**
 * Inflate the zlib stream at `offset`, in one pass.
 *
 * zlib.inflateSync accepts trailing bytes and stops at the stream's own end, and with `info: true`
 * it hands back the engine, whose bytesWritten is exactly how many input bytes the stream took.
 * One inflation per object, with no search for the stream's end.
 */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const available = buf.length - offset;
  if (available <= 0) throw new Error('zlib stream is empty');
  const result = zlib.inflateSync(buf.subarray(offset), { info: true });
  const consumed = result.engine.bytesWritten;
  if (consumed <= 0 || consumed > available) throw new Error('the zlib stream did not end inside the buffer');
  return { data: result.buffer, consumed };
}

// ----------------------------------------------------------------- delta

/** Apply a git delta (copy/insert instruction stream) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('truncated delta size');
      const byte = delta[pos++];
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift > 56) throw new Error('delta size too long');
    }
  };
  const baseSize = readVarint();
  const targetSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta wants a ${baseSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) copyOffset += delta[pos++];
      if ((op & 0x02) !== 0) copyOffset += delta[pos++] * 2 ** 8;
      if ((op & 0x04) !== 0) copyOffset += delta[pos++] * 2 ** 16;
      if ((op & 0x08) !== 0) copyOffset += delta[pos++] * 2 ** 24;
      if ((op & 0x10) !== 0) copySize += delta[pos++];
      if ((op & 0x20) !== 0) copySize += delta[pos++] * 2 ** 8;
      if ((op & 0x40) !== 0) copySize += delta[pos++] * 2 ** 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy leaves the base');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
      continue;
    }
    if (op === 0) throw new Error('delta opcode 0');
    if (pos + op > delta.length) throw new Error('truncated delta insert');
    delta.copy(out, written, pos, pos + op);
    written += op;
    pos += op;
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ----------------------------------------------------------------- packfile

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  declaredCount: number;
}

export interface PackReadOptions {
  /** A base object a thin pack leaves out, looked up by id. */
  resolveBase?: (oid: string) => GitObject | undefined;
}

/**
 * Read a packfile: version 2 or 3, zlib objects, OFS_DELTA and REF_DELTA resolved recursively
 * (thin-pack bases come from `options.resolveBase`), trailer checksum verified.
 */
export function readPack(buf: Buffer, options: PackReadOptions = {}): PackReadResult {
  if (buf.length < 32 || buf[0] !== 0x50 || buf[1] !== 0x41 || buf[2] !== 0x43 || buf[3] !== 0x4b) throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const declaredCount = buf.readUInt32BE(8);
  const body = buf.subarray(12, buf.length - 20);
  const trailer = buf.subarray(buf.length - 20);
  const digest = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    baseOffset: number;
    baseOid: string;
    delta: Buffer | null;
    resolved: GitObject | null;
  }
  const raws: Raw[] = [];
  let pos = 0;
  let deltaCount = 0;
  for (let index = 0; index < declaredCount; index += 1) {
    const start = pos;
    let byte = body[pos++];
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = body[pos++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const entry: Raw = { offset: start, typeCode, baseOffset: -1, baseOid: '', delta: null, resolved: null };
    if (typeCode === 6) {
      let value = body[pos++];
      let distance = value & 0x7f;
      while ((value & 0x80) !== 0) {
        value = body[pos++];
        distance = ((distance + 1) << 7) | (value & 0x7f);
      }
      entry.baseOffset = start - distance;
      deltaCount += 1;
    } else if (typeCode === 7) {
      entry.baseOid = body.toString('hex', pos, pos + 20);
      pos += 20;
      deltaCount += 1;
    } else if (CODE_TYPE_LIST[typeCode] === undefined) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const inflated = inflateAt(body, pos);
    pos += inflated.consumed;
    if (typeCode === 6 || typeCode === 7) entry.delta = inflated.data;
    else entry.resolved = { type: CODE_TYPE_LIST[typeCode] as ObjType, data: inflated.data };
    raws.push(entry);
  }

  const byOffset = new Map<number, Raw>();
  for (const raw of raws) byOffset.set(raw.offset, raw);
  const byOid = new Map<string, GitObject>();
  const resolving = new Set<number>();

  const resolve = (raw: Raw): GitObject => {
    if (raw.resolved !== null) return raw.resolved;
    if (resolving.has(raw.offset)) throw new Error('delta cycle');
    resolving.add(raw.offset);
    let base: GitObject;
    if (raw.baseOffset >= 0) {
      const baseRaw = byOffset.get(raw.baseOffset);
      if (baseRaw === undefined) throw new Error('ofs-delta base is not in the pack');
      base = resolve(baseRaw);
    } else {
      const found = byOid.get(raw.baseOid) ?? options.resolveBase?.(raw.baseOid);
      if (found === undefined) throw new Error(`ref-delta base ${raw.baseOid} is not in the pack`);
      base = found;
    }
    const delta = raw.delta;
    if (delta === null) throw new Error('a delta entry carries no delta');
    const data = applyDelta(base.data, delta);
    const resolved: GitObject = { type: base.type, data };
    raw.resolved = resolved;
    byOid.set(objectId(resolved.type, data), resolved);
    resolving.delete(raw.offset);
    return resolved;
  };

  const objects = new Map<string, GitObject>();
  for (const raw of raws) {
    const object = resolve(raw);
    objects.set(objectId(object.type, object.data), object);
  }
  return { objects, deltaCount, declaredCount };
}

/** Build a packfile of plain objects (no deltas); the trailer is SHA-1 over everything before it. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const first = Buffer.allocUnsafe(8);
    first[0] = (TYPE_CODE[object.type] << 4) | (size & 0x0f) | (size > 0x0f ? 0x80 : 0x00);
    let at = 1;
    size = Math.floor(size / 16);
    while (size > 0) {
      first[at++] = (size & 0x7f) | (size > 0x7f ? 0x80 : 0x00);
      size = Math.floor(size / 128);
    }
    parts.push(first.subarray(0, at), zlib.deflateSync(object.data, { level: 1 }));
  }
  const digest = createHash('sha1').update(Buffer.concat(parts)).digest();
  parts.push(digest);
  return Buffer.concat(parts);
}

// ----------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const MODE_TEXT: Record<string, string> = { '100644': '100644', '100755': '100755', '120000': '120000', '160000': '160000', '40000': '40000', '040000': '40000' };

function modeText(mode: string): string {
  const known = MODE_TEXT[mode];
  if (known !== undefined) return known;
  return parseInt(mode, 8).toString(8);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
    const right = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${modeText(entry.mode)} ${entry.name}\u0000`, 'utf8'), Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const nul = data.indexOf(0, pos);
    if (nul < 0) break;
    const text = data.toString('utf8', pos, nul);
    const space = text.indexOf(' ');
    entries.push({ mode: text.slice(0, space), name: text.slice(space + 1), oid: data.toString('hex', nul + 1, nul + 21) });
    pos = nul + 21;
  }
  return entries;
}

// ----------------------------------------------------------------- commits and tags

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  extra: string[];
}

export function buildCommit(input: {
  tree: string;
  parents?: readonly string[];
  author: string;
  committer?: string;
  timestamp: number;
  timezone?: string;
  message: string;
}): Buffer {
  const when = `${input.timestamp} ${input.timezone ?? '+0000'}`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${when}`);
  lines.push(`committer ${input.committer ?? input.author} ${when}`);
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line.length > 0) extra.push(line);
  }
  return { tree, parents, author, committer, message, extra };
}

export interface TagData {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(input: { object: string; type: string; tag: string; tagger: string; timestamp: number; message: string }): Buffer {
  const message = input.message.endsWith('\n') ? input.message : `${input.message}\n`;
  return Buffer.from(
    `object ${input.object}\ntype ${input.type}\ntag ${input.tag}\ntagger ${input.tagger} ${input.timestamp} +0000\n\n${message}`,
    'utf8',
  );
}

export function parseTag(data: Buffer): TagData {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Follow tag objects to the object they ultimately name (a commit, usually). */
export function peelObject(store: { objects: Map<string, GitObject> }, oid: string): string {
  let current = oid;
  for (let hop = 0; hop < 16; hop += 1) {
    const object = store.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}
