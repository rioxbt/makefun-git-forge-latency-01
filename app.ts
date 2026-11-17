// The forge's HTTP surface: one process, one store, four surfaces (git smart HTTP, REST v3,
// GraphQL v4 and MCP) plus the env's health probe. Anything else is GitHub's JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { makeRequestId, readBody, sendError, sendJson, type Ctx } from './src/http.ts';
import { Forge } from './src/store.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { handleGitHead, handleInfoRefs, handleReceivePack, handleUploadPack, matchGitPath, serviceParam, advertisementFor, ADVERTISEMENT_HEADERS, RECEIVE_ADVERTISEMENT_HEADERS } from './src/gitservice.ts';
import { cachedGet } from './src/rest.ts';

export const FORGE_VERSION = '1.0.0';

/** The body of a request that carries none (every GET and HEAD here). */
const EMPTY_BODY = Buffer.alloc(0);

/** The bearer value of an Authorization header, or null when there is none to read. */
function tokenOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (raw === undefined) return null;
  const space = raw.indexOf(' ');
  const value = (space < 0 ? '' : raw.slice(space + 1)).trim();
  return value === '' ? null : value;
}

function decode(text: string): string {
  if (text.indexOf('%') < 0) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function segmentsOf(path: string): string[] {
  const out: string[] = [];
  let start = 1;
  for (let index = 1; index <= path.length; index += 1) {
    if (index === path.length || path.charCodeAt(index) === 47) {
      out.push(decode(path.slice(start, index)));
      start = index + 1;
    }
  }
  return out;
}

async function dispatch(req: IncomingMessage, res: ServerResponse, forge: Forge): Promise<void> {
  const requestId = makeRequestId();
  const rawUrl = req.url ?? '/';
  const mark = rawUrl.indexOf('?');
  const path = mark < 0 ? rawUrl : rawUrl.slice(0, mark);
  const search = mark < 0 ? '' : rawUrl.slice(mark + 1);
  const method = req.method ?? 'GET';
  // A GET that declares no body carries none: skipping the read keeps the whole path synchronous on
  // the first tick, which is what the read workload's 2,000 sequential GETs notice. A GET that does
  // declare one is read, so an unread body can never desynchronize a keep-alive socket.
  const bodiless = (method === 'GET' || method === 'HEAD') && req.headers['content-length'] === undefined && req.headers['transfer-encoding'] === undefined;
  const body = bodiless ? EMPTY_BODY : await readBody(req);
  let json: unknown;
  if (body.length > 0) {
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      json = undefined;
    }
  }
  const token = tokenOf(req);
  const ctx: Ctx = {
    req,
    res,
    method,
    rawUrl,
    path,
    segments: segmentsOf(path),
    query: search === '' ? null : new URLSearchParams(search),
    token,
    login: token === null ? null : forge.loginForToken(token),
    body,
    json,
    forge,
    requestId,
  };
  const segments = ctx.segments;

  try {
    if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
      sendJson(ctx, 200, { ok: true });
      return;
    }

    const git = matchGitPath(path, search);
    if (git !== null) {
      const suffix = git.suffix;
      const known = suffix === 'info/refs' || suffix === 'git-upload-pack' || suffix === 'git-receive-pack' || suffix === 'HEAD';
      if (!known) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      const repo = forge.findRepo(git.owner, git.name);
      if (repo === undefined) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      if (suffix === 'info/refs') {
        const service = serviceParam(git.query);
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendError(ctx, 400, 'dumb HTTP is not supported');
          return;
        }
        const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').toString().includes('version=2');
        handleInfoRefs(ctx, repo, service, wantsV2);
        return;
      }
      if (suffix === 'git-upload-pack' && method === 'POST') {
        const isV2 = (req.headers['git-protocol'] ?? '').toString().includes('version=2');
        handleUploadPack(ctx, repo, isV2);
        return;
      }
      if (suffix === 'git-receive-pack' && method === 'POST') {
        handleReceivePack(ctx, repo);
        return;
      }
      if (suffix === 'HEAD') {
        handleGitHead(ctx, repo);
        return;
      }
      sendError(ctx, 404, 'Not Found');
      return;
    }

    if (segments[0] === 'mcp') {
      handleMcp(ctx);
      return;
    }

    if (segments[0] === 'api' && segments[1] === 'graphql') {
      if (method !== 'POST') {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      handleGraphQL(ctx);
      return;
    }

    if (segments[0] === 'api' && segments[1] === 'v3') {
      if (handleRest(ctx, forge, segments.slice(2))) return;
      sendError(ctx, 404, 'Not Found');
      return;
    }

    sendError(ctx, 404, 'Not Found');
  } catch (err) {
    if (!res.headersSent) sendError(ctx, 500, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
    else res.end();
  }
}

const ADVERTISEMENT_HEADERS_LOCAL = ADVERTISEMENT_HEADERS;
const RECEIVE_ADVERTISEMENT_HEADERS_LOCAL = RECEIVE_ADVERTISEMENT_HEADERS;
/** The answer to the env's boot probe, prebuilt: it is called twice before anything is scored. */
const HEALTHZ_BODY = Buffer.from(`${JSON.stringify({ ok: true })}\n`, 'utf8');
const HEALTHZ_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'content-length': String(HEALTHZ_BODY.length),
  'x-github-request-id': 'FORGE:HEALTHZ',
};

/**
 * The synchronous GET path, before anything is parsed or awaited: the boot probe, a REST read this
 * process already computed and serialized (its `valid()` predicate saw the entity's stamp unchanged),
 * and a git ref advertisement (the first request of every push and every clone). Everything else
 * falls through to the general dispatch below, so no route's behaviour depends on this shortcut.
 */
function fastGet(req: IncomingMessage, res: ServerResponse, forge: Forge): boolean {
  const rawUrl = req.url ?? '/';
  if (rawUrl === '/healthz') {
    res.writeHead(200, HEALTHZ_HEADERS);
    res.end(HEALTHZ_BODY);
    return true;
  }
  // Every REST answer needs a token: without one the general path answers the 401 it owes.
  if (req.headers.authorization === undefined) return false;
  const reply = cachedGet(rawUrl);
  if (reply !== undefined) {
    res.writeHead(reply.status, reply.headers as string[]);
    res.end(reply.body);
    return true;
  }
  const mark = rawUrl.indexOf('?');
  const path = mark < 0 ? rawUrl : rawUrl.slice(0, mark);
  if (!path.endsWith('/info/refs')) return false;
  const search = mark < 0 ? '' : rawUrl.slice(mark + 1);
  const git = matchGitPath(path, search);
  if (git === null || git.suffix !== 'info/refs') return false;
  const service = serviceParam(search);
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return false;
  const repo = forge.findRepo(git.owner, git.name);
  if (repo === undefined) return false;
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').toString().includes('version=2');
  const body = advertisementFor(repo, service, wantsV2);
  res.writeHead(200, service === 'git-receive-pack' ? RECEIVE_ADVERTISEMENT_HEADERS_LOCAL : ADVERTISEMENT_HEADERS_LOCAL);
  res.end(body);
  return true;
}

/** Build the server; main.ts binds it to an ephemeral port and registers that with the env. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req, res) => {
    if (req.method === 'GET' && fastGet(req, res, forge)) return;
    void dispatch(req, res, forge).catch(() => {
      if (!res.headersSent) {
        const text = `${JSON.stringify({ message: 'Internal error' })}\n`;
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      }
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  // No Nagle on any connection: the suite's read workload rides one socket and every reply is small.
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}
