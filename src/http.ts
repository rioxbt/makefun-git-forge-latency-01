// The HTTP plumbing every surface shares: the request context, the JSON writers and one error body.
//
// One reply, one object: a JSON answer is serialized once into a Buffer, measured once, and written
// with its own content-length, so Node never falls back to chunked encoding on a keep-alive
// connection (the read workload's 2,000 replies ride one socket).

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly method: string;
  /** The raw request target, query string and all, exactly as it arrived. */
  readonly rawUrl: string;
  readonly path: string;
  readonly segments: readonly string[];
  readonly query: URLSearchParams | null;
  readonly token: string | null;
  readonly login: string | null;
  readonly body: Buffer;
  /** The parsed JSON body, or undefined when the body is empty or not JSON (never throws). */
  readonly json: unknown;
  readonly forge: Forge;
  readonly requestId: string;
}

let requestCounter = 0;

/** A unique, non-empty request id: GitHub answers every reply with one. */
export function makeRequestId(): string {
  requestCounter += 1;
  return `FORGE:${requestCounter.toString(16).toUpperCase()}`;
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('the request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Write one JSON body: serialized once, measured once, keep-alive friendly. */
export function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(text);
}

/** Write bytes some other surface already serialized (a git response, a cached body). */
export function sendRaw(ctx: Ctx, status: number, body: Buffer, headers: Record<string, string | number>): void {
  const out: Record<string, string | number> = { 'x-github-request-id': ctx.requestId, ...headers };
  ctx.res.writeHead(status, out);
  ctx.res.end(body);
}

export function sendEmpty(ctx: Ctx, status: number, headers: Record<string, string> = {}): void {
  ctx.res.writeHead(status, { 'x-github-request-id': ctx.requestId, ...headers });
  ctx.res.end();
}

/** GitHub's error body: a JSON object with a message string. */
export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

export const JSON_CONTENT_TYPE = JSON_TYPE;
