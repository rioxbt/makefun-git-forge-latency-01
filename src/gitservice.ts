// git smart HTTP: the ref/capability advertisement, upload-pack (protocol v2 and v0) and
// receive-pack (v0), all served from the forge's own object store with no git binary anywhere.
//
// Speed rules that hold here:
//   - the v0/v2 advertisements are built once per repository state (repo.stamp) and replayed from
//     the cache afterwards, so a clone's `info/refs` is a Map lookup and a write;
//   - a fetch answer (the packfile for a want set) is cached under the repository state it was built
//     from, so 50 concurrent shallow clones of one tip share one pack build;
//   - a push never walks the object graph further than it must: the fast-forward test stops at the
//     first parent link it can answer.

import {
  DELIM_PKT,
  FLUSH_PKT,
  parseCommit,
  parsePackets,
  parseTree,
  pktLine,
  pktLines,
  readPack,
  writePack,
  type GitObject,
} from './gitobj.ts';
import type { Repo } from './store.ts';
import { sendError, sendRaw, type Ctx } from './http.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_PACK_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
const RECEIVE_PACK_ADVERTISEMENT = 'application/x-git-receive-pack-advertisement';
const UPLOAD_PACK_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_PACK_RESULT = 'application/x-git-receive-pack-result';
const ZERO = '0'.repeat(40);
const SIDEBAND_LIMIT = 65515;
const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta shallow no-progress multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want';
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
const UPLOAD_RESULT_HEADERS = { 'content-type': UPLOAD_PACK_RESULT } as const;
const RECEIVE_RESULT_HEADERS = { 'content-type': RECEIVE_PACK_RESULT } as const;

export interface GitTarget {
  owner: string;
  name: string;
  suffix: string;
  query: string;
}

/** Match `/<owner>/<repo>.git/...`; the `.git` suffix is what marks the smart-HTTP route. */
export function matchGitPath(path: string, query: string): GitTarget | null {
  if (path.length < 7 || path.charCodeAt(0) !== 47) return null;
  const secondSlash = path.indexOf('/', 1);
  if (secondSlash < 0) return null;
  const thirdSlash = path.indexOf('/', secondSlash + 1);
  const repoPart = path.slice(secondSlash + 1, thirdSlash < 0 ? path.length : thirdSlash);
  if (!repoPart.endsWith('.git')) return null;
  const name = repoPart.slice(0, -4);
  if (name === '' || secondSlash === 1) return null;
  return {
    owner: decode(path.slice(1, secondSlash)),
    name: decode(name),
    suffix: thirdSlash < 0 ? '' : path.slice(thirdSlash + 1),
    query,
  };
}

function decode(text: string): string {
  if (text.indexOf('%') < 0) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** The `service=` parameter of an `info/refs` request, read straight off the query string. */
export function serviceParam(query: string): string {
  const at = query.indexOf('service=');
  if (at < 0) return '';
  const rest = query.slice(at + 8);
  const end = rest.indexOf('&');
  return end < 0 ? rest : rest.slice(0, end);
}

/** The byte form of a decimal ASCII header, without a string allocation. */
function capabilityLine(oid: string, ref: string | null, capabilities: string): Buffer {
  if (ref === null) return pktLine(`${oid} capabilities^{}\u0000${capabilities}\n`);
  return pktLine(`${oid} ${ref}\u0000${capabilities}\n`);
}

/** The v0 ref advertisement: the service preamble, HEAD, then every ref. */
function advertisementV0(repo: Repo, service: string, capabilities: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH_PKT];
  const headRef = repo.headTarget;
  const headOid = repo.refs.get(headRef);
  const caps = `${capabilities} symref=HEAD:${headRef} agent=${AGENT}`;
  const names = [...repo.refs.keys()].sort();
  if (names.length === 0) {
    parts.push(capabilityLine(ZERO, null, caps));
  } else {
    const ordered = headOid !== undefined ? ['HEAD', ...names.filter((name) => name !== 'HEAD')] : names;
    let first = true;
    for (const name of ordered) {
      const oid = name === 'HEAD' ? (headOid as string) : (repo.refs.get(name) as string);
      parts.push(first ? capabilityLine(oid, name, caps) : pktLine(`${oid} ${name}\n`));
      first = false;
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') parts.push(pktLine(`${peel(repo, oid)} ${name}^{}\n`));
    }
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

const ADVERTISEMENT_V2 = pktLines(['version 2\n', `agent=${AGENT}\n`, 'ls-refs\n', 'fetch=shallow\n', 'object-format=sha1\n', 'flush']);

export const ADVERTISEMENT_HEADERS = { 'content-type': UPLOAD_PACK_ADVERTISEMENT, 'cache-control': 'no-cache, max-age=0, must-revalidate' };
export const RECEIVE_ADVERTISEMENT_HEADERS = { 'content-type': RECEIVE_PACK_ADVERTISEMENT, 'cache-control': 'no-cache, max-age=0, must-revalidate' };

/** The advertisements, one per (repository state, service): the cache the clone path rides. */
const advertisementCache = new Map<string, { stamp: number; body: Buffer }>();

export function advertisementFor(repo: Repo, service: string, wantsV2: boolean): Buffer {
  const key = `${repo.id}:${service}:${wantsV2 ? 2 : 0}:${repo.stamp}`;
  const hit = advertisementCache.get(key);
  if (hit !== undefined && hit.stamp === repo.stamp) return hit.body;
  const body = wantsV2 ? ADVERTISEMENT_V2 : advertisementV0(repo, service, service === 'git-receive-pack' ? RECEIVE_V0_CAPS : UPLOAD_V0_CAPS);
  if (advertisementCache.size > 64) advertisementCache.clear();
  advertisementCache.set(key, { stamp: repo.stamp, body });
  return body;
}

export function handleInfoRefs(ctx: Ctx, repo: Repo, service: string, wantsV2: boolean): void {
  const body = advertisementFor(repo, service, wantsV2);
  sendRaw(ctx, 200, body, service === 'git-receive-pack' ? RECEIVE_ADVERTISEMENT_HEADERS : ADVERTISEMENT_HEADERS);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

function peel(repo: Repo, oid: string): string {
  let current = oid;
  for (let hop = 0; hop < 16; hop += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    const text = object.data.toString('utf8');
    const at = text.indexOf('object ');
    if (at < 0) return current;
    current = text.slice(at + 7, at + 47);
  }
  return current;
}

function lsRefsBody(repo: Repo, args: readonly string[]): Buffer {
  let peelWanted = false;
  let symrefs = false;
  let prefixes: string[] | null = null;
  for (const arg of args) {
    if (arg === 'peel') peelWanted = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) {
      if (prefixes === null) prefixes = [];
      prefixes.push(arg.slice(11));
    }
  }
  const keep = (name: string): boolean => prefixes === null || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(repo.headTarget);
  if (headOid !== undefined && keep('HEAD')) {
    parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${repo.headTarget}` : ''}\n`));
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (symrefs && name === repo.headTarget) line += ` symref-target:${repo.headTarget}`;
    if (peelWanted && repo.objects.get(oid)?.type === 'tag') line += ` peeled:${peel(repo, oid)}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch object selection

interface Selection {
  oids: string[];
  shallow: string[];
  unshallow: string[];
}

/** Every object reachable from the roots, optionally stopping the history at named commits. */
function collectObjects(repo: Repo, roots: readonly string[], stopCommits: ReadonlySet<string> | null): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (stopCommits === null || !stopCommits.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(peel(repo, oid));
    }
  }
  return seen;
}

/** The commit generation walk: `depth` generations from the wants when a deepen was requested. */
function walkCommits(
  repo: Repo,
  roots: readonly string[],
  depth: number | null,
  stopCommits: ReadonlySet<string>,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  let frontier: string[] = [];
  for (const root of roots) {
    const peeled = peel(repo, root);
    if (repo.objects.get(peeled)?.type === 'commit') frontier.push(peeled);
  }
  let generation = 1;
  while (frontier.length > 0 && (depth === null || generation <= depth)) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (included.has(oid)) continue;
      included.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents.filter((parent) => repo.objects.has(parent));
      const cut = depth !== null ? generation + 1 > depth : stopCommits.has(oid);
      if (cut) {
        if (parents.length > 0) boundary.add(oid);
        continue;
      }
      for (const parent of parents) next.push(parent);
    }
    frontier = next;
    generation += 1;
  }
  return { included, boundary };
}

/** The objects a fetch delivers, with the shallow boundary the client is told about. */
function selectObjects(
  repo: Repo,
  request: { wants: readonly string[]; haves: readonly string[]; shallow: readonly string[]; depth: number | null },
): Selection {
  const existingShallow = new Set(request.shallow);
  const wants: string[] = [];
  for (const want of request.wants) if (!wants.includes(want)) wants.push(want);
  const walked = walkCommits(repo, wants, request.depth, existingShallow);
  const included = walked.included;

  const include = new Set<string>();
  for (const want of wants) if (repo.objects.get(want)?.type === 'tag') include.add(want);
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    include.add(oid);
    if (object.type === 'commit') for (const oid2 of collectObjects(repo, [parseCommit(object.data).tree], null)) include.add(oid2);
  }

  let exclude: Set<string> | null = null;
  if (request.haves.length > 0) exclude = collectObjects(repo, request.haves, existingShallow);

  const oids: string[] = [];
  for (const oid of include) if (exclude === null || !exclude.has(oid)) oids.push(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (request.depth !== null) {
    for (const oid of walked.boundary) if (!existingShallow.has(oid)) shallow.push(oid);
    for (const oid of existingShallow) {
      if (!included.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const inside = parseCommit(object.data).parents.every((parent) => !repo.objects.has(parent) || included.has(parent));
      if (inside) unshallow.push(oid);
    }
  }
  return { oids, shallow, unshallow };
}

function packOf(repo: Repo, oids: readonly string[]): Buffer {
  const objects: GitObject[] = [];
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return writePack(objects);
}

function sideband(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_LIMIT) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), data.subarray(offset, Math.min(data.length, offset + SIDEBAND_LIMIT))])));
  }
  if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

// ---------------------------------------------------------------------------------------------
// upload-pack

/**
 * The fetch answers this repository state already produced, keyed by the request that asked for
 * them: the clone workload's 50 concurrent shallow clones of one tip share one pack build and one
 * framing pass. The key carries the repository's stamp, so a moved repository never replays an old
 * pack.
 */
const fetchCache = new Map<string, { stamp: number; body: Buffer }>();
const FETCH_CACHE_MAX = 32;

export function handleUploadPack(ctx: Ctx, repo: Repo, isV2: boolean): void {
  const { packets } = parsePackets(ctx.body);
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));

  if (isV2) {
    let command = '';
    for (const line of lines) {
      if (line.startsWith('command=')) {
        command = line.slice(8).trim();
        break;
      }
    }
    if (command === 'ls-refs') {
      const args: string[] = [];
      for (const line of lines) {
        const trimmed = line.replace(/\n$/, '');
        if (trimmed.startsWith('command=') || trimmed.startsWith('agent=') || trimmed.startsWith('object-format=')) continue;
        args.push(trimmed);
      }
      sendRaw(ctx, 200, lsRefsBody(repo, args), UPLOAD_RESULT_HEADERS);
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      let done = false;
      for (const line of lines) {
        const trimmed = line.replace(/\n$/, '');
        if (trimmed.startsWith('want ')) wants.push(trimmed.slice(5).trim());
        else if (trimmed.startsWith('have ')) haves.push(trimmed.slice(5).trim());
        else if (trimmed.startsWith('shallow ')) shallow.push(trimmed.slice(8).trim());
        else if (trimmed.startsWith('deepen ')) depth = Number.parseInt(trimmed.slice(7), 10);
        else if (trimmed === 'done') done = true;
      }
      const cacheKey = `${repo.id}:${repo.stamp}:${depth ?? 'n'}:${wants.join(',')}:${haves.join(',')}:${shallow.join(',')}`;
      if (done) {
        const hit = fetchCache.get(cacheKey);
        if (hit !== undefined && hit.stamp === repo.stamp) {
          sendRaw(ctx, 200, hit.body, UPLOAD_RESULT_HEADERS);
          return;
        }
      }
      const parts: Buffer[] = [];
      if (!done) {
        parts.push(pktLine('acknowledgments\n'));
        let acknowledged = false;
        for (const oid of haves) {
          if (repo.objects.has(oid)) {
            parts.push(pktLine(`ACK ${oid}\n`));
            acknowledged = true;
            break;
          }
        }
        if (!acknowledged) parts.push(pktLine('NAK\n'));
        parts.push(pktLine('ready\n'), FLUSH_PKT);
      } else {
        const selection = selectObjects(repo, { wants, haves, shallow, depth });
        if (depth !== null || shallow.length > 0) {
          parts.push(pktLine('shallow-info\n'));
          for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
          for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
          parts.push(DELIM_PKT);
        }
        parts.push(pktLine('packfile\n'));
        parts.push(...sideband(packOf(repo, selection.oids)));
        parts.push(FLUSH_PKT);
      }
      const body = Buffer.concat(parts);
      if (done) {
        if (fetchCache.size >= FETCH_CACHE_MAX) fetchCache.clear();
        fetchCache.set(cacheKey, { stamp: repo.stamp, body });
      }
      sendRaw(ctx, 200, body, UPLOAD_RESULT_HEADERS);
      return;
    }
    sendError(ctx, 400, 'unsupported protocol v2 command');
    return;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const line of lines) {
    const trimmed = line.replace(/\n$/, '');
    if (trimmed.startsWith('want ')) wants.push(trimmed.slice(5).trim().split(' ')[0]);
    else if (trimmed.startsWith('have ')) haves.push(trimmed.slice(5).trim());
    else if (trimmed.startsWith('shallow ')) shallow.push(trimmed.slice(8).trim());
    else if (trimmed.startsWith('deepen ')) depth = Number.parseInt(trimmed.slice(7), 10);
    else if (trimmed === 'done') done = true;
  }
  if (wants.length === 0) {
    sendError(ctx, 400, 'no wants in the fetch request');
    return;
  }
  const selection = selectObjects(repo, { wants, haves, shallow, depth });
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  if (!done) {
    parts.push(FLUSH_PKT);
  } else {
    parts.push(...sideband(packOf(repo, selection.oids)), FLUSH_PKT);
  }
  sendRaw(ctx, 200, Buffer.concat(parts), UPLOAD_RESULT_HEADERS);
}

// ---------------------------------------------------------------------------------------------
// receive-pack

export function handleReceivePack(ctx: Ctx, repo: Repo): void {
  const { packets, rest } = parsePackets(ctx.body);
  const commandNew: string[] = [];
  const commandRef: string[] = [];
  let wantsSideband = false;
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    const commandText = nul >= 0 ? text.slice(0, nul) : text.replace(/\n$/, '');
    if (nul >= 0 && first && text.indexOf('side-band-64k', nul) >= 0) wantsSideband = true;
    first = false;
    const parts = commandText.split(' ');
    if (parts.length < 3) continue;
    commandNew.push(parts[1]);
    commandRef.push(parts.slice(2).join(' ').replace(/\n$/, ''));
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  let changed = false;
  if (rest.length > 0) {
    try {
      if (rest[0] !== 0x50) throw new Error('the pack section does not start with PACK');
      const read = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type, data: object.data });
      }
      changed = true;
    } catch (err) {
      unpackOk = false;
      unpackDetail = `error ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const report: Array<string | 'flush'> = [`unpack ${unpackDetail}\n`];
  if (unpackOk) {
    for (let index = 0; index < commandRef.length; index += 1) {
      const ref = commandRef[index];
      const newOid = commandNew[index];
      if (newOid === ZERO) {
        repo.refs.delete(ref);
        changed = true;
        report.push(`ok ${ref}\n`);
        continue;
      }
      const current = repo.refs.get(ref);
      if (ref.startsWith('refs/heads/') && current !== undefined && current !== newOid) {
        const object = repo.objects.get(newOid);
        if (object === undefined) {
          report.push(`ng ${ref} missing necessary objects\n`);
          continue;
        }
        if (!fastForward(repo, current, newOid)) {
          report.push(`ng ${ref} non-fast-forward\n`);
          continue;
        }
      }
      repo.refs.set(ref, newOid);
      changed = true;
      report.push(`ok ${ref}\n`);
    }
  } else {
    for (const ref of commandRef) report.push(`ng ${ref} unpacker error\n`);
  }
  // One clock reading per push, and only when the repository actually moved.
  if (changed) {
    repo.updatedAt = new Date().toISOString();
    repo.stamp += 1;
    ctx.forge.version += 1;
  }
  report.push('flush');
  const reportBytes = pktLines(report);
  const body = wantsSideband ? Buffer.concat([...sideband(reportBytes), FLUSH_PKT]) : reportBytes;
  sendRaw(ctx, 200, body, RECEIVE_RESULT_HEADERS);
}

/** Whether `descendant` reaches `ancestor`: the fastest answer is usually the first parent link. */
function fastForward(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** A dumb-protocol HEAD answer, so a real git client can probe the repository. */
export function handleGitHead(ctx: Ctx, repo: Repo): void {
  const text = `ref: ${repo.headTarget}\n`;
  const body = Buffer.from(text, 'utf8');
  sendRaw(ctx, 200, body, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length });
}
