// Model Context Protocol at POST /mcp: JSON-RPC 2.0 over the MCP Streamable HTTP transport.
//
// Two protocol eras, one endpoint (the suite accepts either):
//   modern 2026-07-28: no handshake; `server/discover` returns the identity, capabilities and the
//           supported revisions, and every request declares its revision in `params._meta` plus the
//           `MCP-Protocol-Version` header (both are read but never required).
//   legacy 2025-11-25 and earlier: `initialize` (echoing the client's revision) + `notifications/initialized`.
//
// Every answer is application/json and is written synchronously, well inside the transport's 3 s budget.
// The tools act on the SAME store as the REST surface (ctx.forge), so a repository or issue created
// here reads back over /api/v3 as the same object.

import { sendEmpty, sendError, sendJson, type Ctx } from './http.ts';
import { DEFAULT_LOGIN } from './store.ts';
import type { Issue, Pull, Repo, User } from './store.ts';

/** The revision this server speaks by default (the current one). */
const REVISION = '2026-07-28';

/** The revisions `server/discover` advertises (a non-empty list of YYYY-MM-DD strings). */
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

/** The server's identity. */
const SERVER_INFO: Readonly<{ name: string; version: string }> = Object.freeze({ name: 'makefun-forge', version: '1.0.0' });

/** The capabilities every identity answer carries: a `tools` capability record. */
const CAPABILITIES: Readonly<{ tools: Record<string, unknown> }> = Object.freeze({ tools: Object.freeze({ listChanged: false }) });

const INSTRUCTIONS =
  'A GitHub-compatible forge: repositories, issues and pull requests. Arguments name a repository as ' +
  '{owner, repo}; create_repo takes {name}. The tools share the store with the /api/v3 REST surface.';

const STRING: Readonly<Record<string, unknown>> = Object.freeze({ type: 'string' });
const INTEGER: Readonly<Record<string, unknown>> = Object.freeze({ type: 'integer' });
const BOOLEAN: Readonly<Record<string, unknown>> = Object.freeze({ type: 'boolean' });
const STRING_LIST: Readonly<Record<string, unknown>> = Object.freeze({ type: 'array', items: Object.freeze({ type: 'string' }) });

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * The tool surface. Six tools are the conformance suite's contract (create_repo, get_repo, create_issue,
 * list_issues, create_pull_request, merge_pull_request); the rest round the surface out. The array is
 * built once and frozen, so two `tools/list` answers are byte-identical.
 */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by a login. Returns the created repository object.',
    inputSchema: { type: 'object', properties: { name: STRING, owner: STRING, description: STRING, private: BOOLEAN }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name. Returns the repository object.',
    inputSchema: { type: 'object', properties: { owner: STRING, repo: STRING, full_name: STRING }, required: ['owner', 'repo'] },
  },
  {
    name: 'list_repos',
    description: 'List the repositories the request login owns (or that a given owner owns).',
    inputSchema: { type: 'object', properties: { owner: STRING }, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository. Returns the created issue object with its number.',
    inputSchema: { type: 'object', properties: { owner: STRING, repo: STRING, title: STRING, body: STRING, labels: STRING_LIST, full_name: STRING }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List the issues a repository holds, optionally filtered by state (open, closed or all).',
    inputSchema: { type: 'object', properties: { owner: STRING, repo: STRING, state: STRING, full_name: STRING }, required: ['owner', 'repo'] },
  },
  {
    name: 'get_issue',
    description: 'Read one issue of a repository by its number.',
    inputSchema: { type: 'object', properties: { owner: STRING, repo: STRING, issue_number: INTEGER, full_name: STRING }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'update_issue',
    description: 'Update an issue: set its state (open or closed), its title or its body.',
    inputSchema: { type: 'object', properties: { owner: STRING, repo: STRING, issue_number: INTEGER, state: STRING, title: STRING, body: STRING }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'create_comment',
    description: 'Add a comment to an issue. Returns the created comment object.',
    inputSchema: { type: 'object', properties: { owner: STRING, repo: STRING, issue_number: INTEGER, body: STRING }, required: ['owner', 'repo', 'issue_number', 'body'] },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch. Returns the pull request object.',
    inputSchema: { type: 'object', properties: { owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING, draft: BOOLEAN }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'list_pulls',
    description: 'List the pull requests of a repository, optionally filtered by state (open, closed or all).',
    inputSchema: { type: 'object', properties: { owner: STRING, repo: STRING, state: STRING, full_name: STRING }, required: ['owner', 'repo'] },
  },
  {
    name: 'get_pull_request',
    description: 'Read one pull request of a repository by its number.',
    inputSchema: { type: 'object', properties: { owner: STRING, repo: STRING, pull_number: INTEGER, full_name: STRING }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number. Returns the merge result (sha, merged, message).',
    inputSchema: { type: 'object', properties: { owner: STRING, repo: STRING, pull_number: INTEGER, merge_method: STRING }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'get_user',
    description: 'Read the authenticated user the Authorization header names.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
]);

/** The tools by name, for a tools/call lookup. */
const TOOLS_BY_NAME = new Map<string, ToolDef>(TOOLS.map((tool) => [tool.name, tool]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string (numbers and booleans are accepted, as the transport encodes them that way). */
function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return undefined;
}

/** An integer (a numeric string is accepted). */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true';
}

/** The owner/repo a tool call names (a `full_name` property wins when it carries a slash). */
function repoArgs(args: Record<string, unknown>): { owner: string | undefined; name: string | undefined } {
  let owner = str(args.owner) ?? str(args.owner_login) ?? str(args.org) ?? str(args.organization) ?? str(args.login);
  let name = str(args.repo) ?? str(args.repository) ?? str(args.repo_name) ?? str(args.repository_name) ?? str(args.name) ?? str(args.project);
  const full = str(args.full_name) ?? str(args.repo_full_name) ?? str(args.repository_full_name);
  if (full !== undefined) {
    const slash = full.indexOf('/');
    if (slash > 0 && slash < full.length - 1) {
      owner = full.slice(0, slash);
      name = full.slice(slash + 1);
    }
  }
  return { owner, name };
}

/** The repository a call names, resolved (and bound) against the same store REST serves. */
function resolveRepo(ctx: Ctx, args: Record<string, unknown>): Repo | undefined {
  const { owner, name } = repoArgs(args);
  if (name === undefined) return undefined;
  return ctx.forge.findRepo(owner ?? ctx.login ?? DEFAULT_LOGIN, name);
}

function ownerOf(repo: Repo): string {
  return repo.owner ?? DEFAULT_LOGIN;
}

function repoPayload(repo: Repo): Record<string, unknown> {
  const owner = ownerOf(repo);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, node_id: 'U_1', type: 'User', html_url: `https://github.com/${owner}` },
    private: repo.privateRepo,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    html_url: `http://forge.local/${owner}/${repo.name}`,
    clone_url: `http://forge.local/${owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issuePayload(repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = ownerOf(repo);
  const base = `http://forge.local/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: null,
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description })),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    locked: false,
    html_url: `http://forge.local/${owner}/${repo.name}/issues/${issue.number}`,
    url: base,
    repository_url: `http://forge.local/api/v3/repos/${owner}/${repo.name}`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

function pullPayload(repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = ownerOf(repo);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { label: `${owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, user: { login: owner, id: 1, type: 'User' } },
    base: { label: `${owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, user: { login: owner, id: 1, type: 'User' } },
    user: { login: pull.user.login, id: pull.user.id, type: 'User' },
    labels: [],
    html_url: `http://forge.local/${owner}/${repo.name}/pull/${pull.number}`,
    url: `http://forge.local/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : null,
    author_association: 'OWNER',
  };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

interface ToolOutcome {
  kind: 'ok' | 'error' | 'missing';
  payload?: unknown;
  message?: string;
}

function ok(payload: unknown): ToolOutcome {
  return { kind: 'ok', payload };
}

function failed(message: string): ToolOutcome {
  return { kind: 'error', message };
}

function missing(names: string[]): ToolOutcome {
  return { kind: 'missing', message: names.join(', ') };
}

/** Strip an `owner:` prefix a caller may put on a branch name. */
function branchName(value: string): string {
  const at = value.indexOf(':');
  return at >= 0 ? value.slice(at + 1) : value;
}

/** The arguments each tool needs before it can act (the schema's `required` list, by tool name). */
const REQUIRED_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  create_repo: ['name'],
  get_repo: ['repo'],
  list_repos: [],
  create_issue: ['repo', 'title'],
  list_issues: ['repo'],
  get_issue: ['repo', 'issue_number'],
  update_issue: ['repo', 'issue_number'],
  create_comment: ['repo', 'issue_number', 'body'],
  create_pull_request: ['repo', 'title', 'head', 'base'],
  list_pulls: ['repo'],
  get_pull_request: ['repo', 'pull_number'],
  merge_pull_request: ['repo', 'pull_number'],
  get_user: [],
});

/** The required arguments a call left out (a numbers/strings-aware check, `repo` satisfiable by full_name). */
function requiredMissing(name: string, args: Record<string, unknown>): string[] {
  const names = REQUIRED_ARGS[name] ?? [];
  const out: string[] = [];
  const repoNamed = repoArgs(args).name;
  for (const key of names) {
    if (key === 'repo') {
      if (repoNamed === undefined) out.push(key);
      continue;
    }
    if (key === 'pull_number' || key === 'issue_number') {
      if (num(args[key]) === undefined) out.push(key);
      continue;
    }
    if (str(args[key]) === undefined) out.push(key);
  }
  return out;
}

function runTool(ctx: Ctx, name: string, args: Record<string, unknown>): ToolOutcome {
  const forge = ctx.forge;
  const author: User = forge.user(ctx.login ?? DEFAULT_LOGIN);
  const absent = requiredMissing(name, args);
  if (absent.length > 0) return missing(absent);
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name) ?? str(args.repo) ?? str(args.repository);
      if (repoName === undefined) return missing(['name']);
      const owner = str(args.owner) ?? ctx.login ?? DEFAULT_LOGIN;
      if (forge.findRepo(owner, repoName, false) !== undefined) return failed(`repository ${owner}/${repoName} already exists`);
      const repo = forge.createRepo({ name: repoName, owner, description: str(args.description) ?? '', private: truthy(args.private) });
      return ok(repoPayload(repo));
    }

    case 'get_repo': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return failed('Not Found: no such repository');
      return ok(repoPayload(repo));
    }

    case 'list_repos': {
      const owner = str(args.owner) ?? ctx.login ?? DEFAULT_LOGIN;
      const repos = forge.listRepos(owner).map((repo) => repoPayload(repo));
      return ok({ total_count: repos.length, repositories: repos });
    }

    case 'create_issue': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return failed('Not Found: no such repository');
      const title = str(args.title);
      if (title === undefined) return missing(['title']);
      const labelNames: string[] = [];
      if (Array.isArray(args.labels)) {
        for (const entry of args.labels) {
          const label = str(entry) ?? (isRecord(entry) ? str(entry.name) : undefined);
          if (label !== undefined) labelNames.push(label);
        }
      }
      const created = forge.createIssue(repo, { title, body: str(args.body) ?? '', labelNames, author });
      if ('error' in created) return failed(created.error);
      return ok(issuePayload(repo, created.issue));
    }

    case 'list_issues': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return failed('Not Found: no such repository');
      const state = (str(args.state) ?? 'open').toLowerCase();
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issuePayload(repo, issue));
      return ok({ total_count: issues.length, issues });
    }

    case 'get_issue': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return failed('Not Found: no such repository');
      const number = num(args.issue_number) ?? num(args.number);
      if (number === undefined) return missing(['issue_number']);
      const issue = repo.issueByNumber.get(number);
      if (issue === undefined) return failed(`Not Found: issue #${number}`);
      return ok(issuePayload(repo, issue));
    }

    case 'update_issue': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return failed('Not Found: no such repository');
      const number = num(args.issue_number) ?? num(args.number);
      if (number === undefined) return missing(['issue_number']);
      const issue = repo.issueByNumber.get(number);
      if (issue === undefined) return failed(`Not Found: issue #${number}`);
      let touched = false;
      const state = str(args.state);
      if (state === 'open' || state === 'closed') {
        forge.setIssueState(repo, issue, state);
        touched = true;
      }
      const title = str(args.title);
      if (title !== undefined) {
        issue.title = title;
        touched = true;
      }
      const body = str(args.body);
      if (body !== undefined) {
        issue.body = body;
        touched = true;
      }
      if (touched) forge.touchIssue(repo, issue);
      return ok(issuePayload(repo, issue));
    }

    case 'create_comment': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return failed('Not Found: no such repository');
      const number = num(args.issue_number) ?? num(args.number);
      if (number === undefined) return missing(['issue_number']);
      const issue = repo.issueByNumber.get(number);
      if (issue === undefined) return failed(`Not Found: issue #${number}`);
      const body = str(args.body);
      if (body === undefined) return missing(['body']);
      const comment = forge.createComment(repo, issue, body, author);
      return ok({ id: comment.id, node_id: `IC_${comment.id}`, body: comment.body, user: { login: comment.user.login, id: comment.user.id }, created_at: comment.createdAt, updated_at: comment.createdAt });
    }

    case 'create_pull_request': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return failed('Not Found: no such repository');
      const title = str(args.title);
      const head = str(args.head);
      const base = str(args.base);
      const absent2: string[] = [];
      if (title === undefined) absent2.push('title');
      if (head === undefined) absent2.push('head');
      if (base === undefined) absent2.push('base');
      if (absent2.length > 0) return missing(absent2);
      const created = forge.createPull(repo, {
        title: title as string,
        body: str(args.body) ?? '',
        head: branchName(head as string),
        base: branchName(base as string),
        author,
      });
      if ('error' in created) return failed(created.error);
      return ok(pullPayload(repo, created.pull));
    }

    case 'list_pulls': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return failed('Not Found: no such repository');
      const state = (str(args.state) ?? 'open').toLowerCase();
      const pulls = repo.pulls
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => a.number - b.number)
        .map((pull) => pullPayload(repo, pull));
      return ok({ total_count: pulls.length, pulls });
    }

    case 'get_pull_request': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return failed('Not Found: no such repository');
      const number = num(args.pull_number) ?? num(args.pull_request_number) ?? num(args.number);
      if (number === undefined) return missing(['pull_number']);
      const pull = forge.pullByNumber(repo, number);
      if (pull === undefined) return failed(`Not Found: pull request #${number}`);
      return ok(pullPayload(repo, pull));
    }

    case 'merge_pull_request': {
      const repo = resolveRepo(ctx, args);
      if (repo === undefined) return failed('Not Found: no such repository');
      const number = num(args.pull_number) ?? num(args.pull_request_number) ?? num(args.number);
      if (number === undefined) return missing(['pull_number']);
      const pull = forge.pullByNumber(repo, number);
      if (pull === undefined) return failed(`Not Found: pull request #${number}`);
      const method = (str(args.merge_method) ?? 'merge').toLowerCase();
      const merged = forge.mergePull(repo, pull, method, author);
      if (!merged.ok) return failed(merged.message);
      return ok({ number: pull.number, merged: true, sha: merged.sha, message: merged.message });
    }

    case 'get_user':
      return ok({ login: author.login, id: author.id, name: author.name, type: 'User' });

    default:
      return failed(`unknown tool ${name}`);
  }
}

function sendResult(ctx: Ctx, id: unknown, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id, result });
}

function sendRpcError(ctx: Ctx, id: unknown, code: number, message: string): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

export function handleMcp(ctx: Ctx): void {
  // Authentication gates every method: an unauthenticated call is exactly 401, before any tool exists.
  if (ctx.login === null) {
    sendError(ctx, 401, 'Requires authentication');
    return;
  }
  if (ctx.method === 'DELETE') {
    sendEmpty(ctx, 204);
    return;
  }
  if (ctx.method !== 'POST') {
    sendError(ctx, 405, 'Method Not Allowed');
    return;
  }
  // An empty POST is a liveness probe of the transport, not a JSON-RPC message.
  if (ctx.body.length === 0) {
    sendEmpty(ctx, 202);
    return;
  }
  // A body that is not JSON (a record) is JSON-RPC's parse error, over HTTP 400.
  const request = isRecord(ctx.json) ? ctx.json : null;
  if (request === null) {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const params = isRecord(request.params) ? request.params : {};
  const method = typeof request.method === 'string' ? request.method : '';
  // A notification carries no id and is answered with an empty 202 (never a body).
  if (request.id === undefined) {
    sendEmpty(ctx, 202);
    return;
  }
  const id = request.id;

  if (method === 'server/discover') {
    sendResult(ctx, id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: CAPABILITIES,
      serverInfo: SERVER_INFO,
      instructions: INSTRUCTIONS,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    return;
  }

  if (method === 'initialize') {
    const asked = str(params.protocolVersion);
    const version = asked !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : REVISION;
    sendResult(ctx, id, { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    return;
  }

  if (method === 'ping') {
    sendResult(ctx, id, {});
    return;
  }

  if (method === 'tools/list') {
    sendResult(ctx, id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = str(params.name);
    if (name === undefined) {
      sendRpcError(ctx, id, -32602, 'Invalid params: tools/call needs a tool name');
      return;
    }
    if (!TOOLS_BY_NAME.has(name)) {
      sendRpcError(ctx, id, -32602, `Invalid params: unknown tool ${JSON.stringify(name)}`);
      return;
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const outcome = runTool(ctx, name, args);
    if (outcome.kind === 'missing') {
      sendRpcError(ctx, id, -32602, `Invalid params: ${name} requires ${outcome.message as string}`);
      return;
    }
    if (outcome.kind === 'error') {
      sendResult(ctx, id, toolError(outcome.message ?? 'the tool failed'));
      return;
    }
    sendResult(ctx, id, toolResult(outcome.payload));
    return;
  }

  if (method.startsWith('notifications/')) {
    sendEmpty(ctx, 202);
    return;
  }

  sendRpcError(ctx, id, -32601, `Method not found: ${method}`);
}
