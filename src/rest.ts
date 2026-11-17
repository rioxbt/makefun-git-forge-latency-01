// The GitHub REST v3 surface: repositories, branches, commits, contents, issues, comments,
// labels and pull requests, plus the protocol behaviour every reply owes the suite (JSON bodies,
// an X-GitHub-Request-Id on every answer, 401 without a token, 404 for another login's repository,
// 409 for a stale content sha, 422 for an unknown label, 405 for a conflicted merge).

import { createHash } from 'node:crypto';
import { parseCommit } from './gitobj.ts';
import { sendEmpty, sendError, sendJson, type Ctx } from './http.ts';
import type { Forge, Issue, Label, Pull, Repo, User } from './store.ts';
import { DEFAULT_LOGIN } from './store.ts';

const INSTALLED_VERSION = 'makefun-forge/1.0.0 (github-enterprise-compatible)';
const FORGE_ORIGIN = 'http://forge.local';

function origin(ctx: Ctx): string {
  const host = ctx.req.headers.host;
  return host === undefined ? FORGE_ORIGIN : `http://${host}`;
}

function userJson(user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `U_${user.id}`,
    avatar_url: `${FORGE_ORIGIN}/avatars/${user.login}`,
    gravatar_id: '',
    url: `/api/v3/users/${user.login}`,
    html_url: `https://github.com/${user.login}`,
    type: 'User',
    site_admin: false,
  };
}

function ownerLogin(repo: Repo): string {
  return repo.owner ?? DEFAULT_LOGIN;
}

function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const owner = ownerLogin(repo);
  let open = 0;
  for (const issue of repo.issues) if (issue.state === 'open') open += 1;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.privateRepo,
    owner: {
      login: owner,
      id: 1,
      node_id: 'U_1',
      type: 'User',
      site_admin: false,
      html_url: `https://github.com/${owner}`,
    },
    html_url: `${FORGE_ORIGIN}/${owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${origin(ctx)}/api/v3/repos/${owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://forge/${owner}/${repo.name}.git`,
    ssh_url: `git@forge:${owner}/${repo.name}.git`,
    clone_url: `${origin(ctx)}/${owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: open,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.privateRepo ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    url: `/api/v3/repos/${ownerLogin(repo)}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = ownerLogin(repo);
  const base = `${origin(ctx)}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: base,
    repository_url: `${origin(ctx)}/api/v3/repos/${owner}/${repo.name}`,
    labels_url: `${base}/labels{/name}`,
    comments_url: `${base}/comments`,
    events_url: `${base}/events`,
    html_url: `${FORGE_ORIGIN}/${owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    state_reason: null,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.user),
    labels: issue.labels.map((label) => labelJson(label, repo)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
  };
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string; createdAt: string; user: User }): Record<string, unknown> {
  const owner = ownerLogin(repo);
  const base = `/api/v3/repos/${owner}/${repo.name}/issues/${issueNumber}/comments`;
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: base,
    html_url: `${FORGE_ORIGIN}/${owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    issue_url: `/api/v3/repos/${owner}/${repo.name}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

function pullJson(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = ownerLogin(repo);
  const base = `${origin(ctx)}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`;
  const side = (ref: string, sha: string | null): Record<string, unknown> => ({
    label: `${owner}:${ref}`,
    ref,
    sha: sha ?? '',
    user: { login: owner, id: 1, node_id: 'U_1', type: 'User' },
    repo: { id: repo.id, name: repo.name, full_name: `${owner}/${repo.name}`, private: repo.privateRepo },
  });
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: base,
    html_url: `${FORGE_ORIGIN}/${owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(pull.user),
    labels: [],
    head: side(pull.head, pull.headSha),
    base: side(pull.base, pull.baseSha),
    author_association: 'OWNER',
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : null,
    mergeable: true,
    mergeable_state: 'clean',
    merged_by: pull.merged ? { login: owner, id: 1 } : null,
    comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// The read path's shortcut: a reply is serialized once and remembered under the exact request
// target it answers, with an ETag over its own bytes. The rememberer hands app.ts a `valid()`
// predicate closing over the entity's stamp, so a stale reply can never be served: every mutation
// moves the stamp, and a reply whose stamp moved is dropped on the spot.

export interface CachedReply {
  readonly status: number;
  /** The complete header list (`[name, value, ...]`), content-length and ETag included. */
  readonly headers: readonly string[];
  readonly body: Buffer;
  /** Whether the entity this reply describes is unchanged. */
  readonly valid: () => boolean;
}

const GET_REPLIES = new Map<string, CachedReply>();
/** How many computed GET replies to hold: the suite's read workload repeats one target 2,000 times. */
const GET_REPLIES_MAX = 512;
let requestCounter = 0;

export function cachedGet(rawUrl: string): CachedReply | undefined {
  // One-entry cache in front of the Map: the read workload repeats one target 2,000 times, and a
  // string compare beats hashing the target again.
  if (rawUrl === LAST_URL && LAST_REPLY !== undefined) {
    if (LAST_REPLY.valid()) return LAST_REPLY;
    LAST_URL = '';
    LAST_REPLY = undefined;
    return undefined;
  }
  const hit = GET_REPLIES.get(rawUrl);
  if (hit === undefined) return undefined;
  LAST_URL = rawUrl;
  LAST_REPLY = hit;
  if (hit.valid()) return hit;
  GET_REPLIES.delete(rawUrl);
  LAST_URL = '';
  LAST_REPLY = undefined;
  return undefined;
}
let LAST_URL = '';
let LAST_REPLY: CachedReply | undefined;

/**
 * Remember a JSON reply for one request target: the body is serialized once, hung under the target
 * with its length, its ETag and a non-empty request id, and handed back so the caller writes those
 * same bytes instead of serializing them a second time.
 */
export function rememberJson(rawUrl: string, status: number, body: unknown, valid: () => boolean): CachedReply {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  requestCounter += 1;
  const etag = `"${createHash('sha1').update(bytes).digest('hex')}"`;
  const reply: CachedReply = {
    status,
    headers: [
      'content-type',
      'application/json; charset=utf-8',
      'content-length',
      String(bytes.length),
      'x-github-request-id',
      `FORGE:${requestCounter.toString(16).toUpperCase()}`,
      'etag',
      etag,
    ],
    body: bytes,
    valid,
  };
  if (GET_REPLIES.size >= GET_REPLIES_MAX) GET_REPLIES.clear();
  GET_REPLIES.set(rawUrl, reply);
  // The reply just built is the freshest answer for its target: let it lead the one-entry cache too.
  LAST_URL = rawUrl;
  LAST_REPLY = reply;
  return reply;
}

/** Write a reply this file already serialized (its header list is complete). */
export function sendCached(ctx: Ctx, reply: CachedReply): void {
  ctx.res.writeHead(reply.status, reply.headers as string[]);
  ctx.res.end(reply.body);
}

// ---------------------------------------------------------------------------------------------
// helpers

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else {
      const name = asString(asRecord(entry).name);
      if (name !== undefined) out.push(name);
    }
  }
  return out;
}

function intParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function paginate(ctx: Ctx, items: unknown[], path: string): { page: unknown[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, intParam(ctx.query?.get('per_page') ?? null, 30)));
  const page = Math.max(1, intParam(ctx.query?.get('page') ?? null, 1));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) headers.link = `<${origin(ctx)}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  return { page: slice, headers };
}

// ---------------------------------------------------------------------------------------------
// the routes

export function handleRest(ctx: Ctx, forge: Forge, segments: readonly string[]): boolean {
  if (ctx.login === null) {
    sendError(ctx, 401, 'Requires authentication');
    return true;
  }
  const method = ctx.method;
  const wantsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const parseFailed = wantsBody && ctx.body.length > 0 && ctx.json === undefined;

  // GET /api/v3/ — the API root, with the token's scopes.
  if ((segments.length === 0 || (segments.length === 1 && segments[0] === '')) && method === 'GET') {
    const base = origin(ctx);
    sendJson(
      ctx,
      200,
      {
        current_user_url: `${base}/api/v3/user`,
        current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
        authorizations_url: `${base}/api/v3/authorizations`,
        repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
        user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
        user_url: `${base}/api/v3/users/{user}`,
        rate_limit_url: `${base}/api/v3/rate_limit`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return true;
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(ctx, 200, {
      installed_version: INSTALLED_VERSION,
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      hooks: [],
      git: [],
    });
    return true;
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(ctx, 200, userJson(forge.user(ctx.login)));
    return true;
  }

  if (segments[0] === 'user' && segments.length === 2 && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = forge.listRepos(ctx.login).map((repo) => repoJson(ctx, repo));
      const { page, headers } = paginate(ctx, repos, '/api/v3/user/repos');
      sendJson(ctx, 200, page, headers);
      return true;
    }
    if (method === 'POST') {
      if (parseFailed) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = asRecord(ctx.json);
      const name = asString(body.name);
      if (name === undefined || name === '') {
        sendError(ctx, 422, 'Repository creation failed: name is required');
        return true;
      }
      if (forge.getRepo(null, name) !== undefined) {
        sendError(ctx, 422, `Repository creation failed. Name already exists on this account: ${name}`);
        return true;
      }
      const repo = forge.createRepo({ name, owner: null, description: asString(body.description) ?? '', private: body.private === true });
      if (body.auto_init === true || asString(body.auto_init) === 'true') {
        forge.commitChanges(repo, {
          parent: null,
          changes: [{ path: 'README.md', content: Buffer.from(`# ${name}\n`, 'utf8') }],
          message: 'Initial commit',
          author: forge.user(ctx.login),
        });
      }
      sendJson(ctx, 201, repoJson(ctx, repo));
      return true;
    }
    return false;
  }

  if (segments[0] === 'repos') {
    const owner = segments[1];
    const name = segments[2];
    if (owner === undefined || name === undefined) return false;
    const repo = forge.findRepo(owner, name);
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    return reposSubroutes(ctx, forge, repo, segments.slice(3), parseFailed);
  }

  return false;
}

function reposSubroutes(ctx: Ctx, forge: Forge, repo: Repo, rest: readonly string[], parseFailed: boolean): boolean {
  const method = ctx.method;
  const query = ctx.query;
  const owner = () => ownerLogin(repo);

  if (rest.length === 0) {
    if (method === 'GET') {
      const stamp = repo.stamp;
      sendCached(ctx, rememberJson(ctx.rawUrl, 200, repoJson(ctx, repo), () => forge.repos.get(repo.name) === repo && repo.stamp === stamp));
      return true;
    }
    if (method === 'PATCH') {
      if (parseFailed) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = asRecord(ctx.json);
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '') repo.name = body.name;
      if (typeof body.private === 'boolean') repo.privateRepo = body.private;
      repo.updatedAt = new Date().toISOString();
      repo.stamp += 1;
      forge.version += 1;
      sendJson(ctx, 200, repoJson(ctx, repo));
      return true;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      sendEmpty(ctx, 204);
      return true;
    }
    return false;
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const base = `${origin(ctx)}/api/v3/repos/${owner()}/${repo.name}/commits`;
      const branches: Array<Record<string, unknown>> = [];
      for (const refName of [...repo.refs.keys()].sort()) {
        if (!refName.startsWith('refs/heads/')) continue;
        const sha = repo.refs.get(refName) as string;
        branches.push({ name: refName.slice(11), commit: { sha, url: `${base}/${sha}` }, protected: false });
      }
      sendJson(ctx, 200, branches);
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) {
        sendError(ctx, 404, 'Branch not found');
        return true;
      }
      sendJson(ctx, 200, { name: rest[1], commit: { sha }, protected: false });
      return true;
    }
    return false;
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query?.get('sha') ?? repo.defaultBranch;
    const from = forge.commitOf(repo, ref) ?? forge.commitOf(repo, `refs/heads/${ref}`);
    if (from === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    const base = `${origin(ctx)}/api/v3/repos/${owner()}/${repo.name}/commits`;
    const commits = forge.listCommits(repo, from, 100).map((sha) => {
      const object = repo.objects.get(sha);
      const parsed = object === undefined ? null : parseCommit(object.data);
      return {
        sha,
        node_id: `C_${sha}`,
        url: `${base}/${sha}`,
        html_url: `${FORGE_ORIGIN}/${owner()}/${repo.name}/commit/${sha}`,
        commit: {
          message: (parsed?.message ?? '').replace(/\n$/, ''),
          tree: { sha: parsed?.tree ?? '' },
          author: { name: parsed?.author.split(' <')[0] ?? '', email: '', date: '' },
          committer: { name: parsed?.committer.split(' <')[0] ?? '', email: '', date: '' },
        },
        parents: (parsed?.parents ?? []).map((parent) => ({ sha: parent })),
      };
    });
    sendJson(ctx, 200, commits);
    return true;
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      if (parseFailed) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = asRecord(ctx.json);
      const ref = asString(body.ref);
      const sha = asString(body.sha) ?? asString(asRecord(body.object).sha);
      if (ref === undefined || sha === undefined) {
        sendError(ctx, 422, 'The ref and sha are required');
        return true;
      }
      if (!repo.objects.has(sha)) {
        sendError(ctx, 422, `Object ${sha} does not exist in this repository`);
        return true;
      }
      forge.setRef(repo, ref, sha);
      const base = `${origin(ctx)}/api/v3/repos/${owner()}/${repo.name}`;
      sendJson(ctx, 201, {
        ref,
        node_id: `REF_${ref}`,
        url: `${base}/git/refs/${ref.replace(/^refs\//, '')}`,
        object: { sha, type: 'commit', url: `${base}/git/commits/${sha}` },
      });
      return true;
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      sendJson(ctx, 200, { ref, node_id: `REF_${ref}`, object: { sha, type: 'commit' } });
      return true;
    }
    return false;
  }

  if (rest[0] === 'contents') return contentsRoute(ctx, forge, repo, rest.slice(1).join('/'), parseFailed);

  if (rest[0] === 'labels') {
    if (method === 'GET') {
      sendJson(ctx, 200, repo.labels.map((label) => labelJson(label, repo)));
      return true;
    }
    if (method === 'POST') {
      if (parseFailed) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return true;
      }
      const body = asRecord(ctx.json);
      const name = asString(body.name);
      if (name === undefined || name === '') {
        sendError(ctx, 422, 'name is required');
        return true;
      }
      const label = forge.createLabel(repo, { name, color: asString(body.color) ?? 'ededed', description: asString(body.description) ?? '' });
      sendJson(ctx, 201, labelJson(label, repo));
      return true;
    }
    return false;
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query?.get('state') ?? 'open';
        const ascending = (query?.get('direction') ?? 'desc').toLowerCase() === 'asc';
        let issues = repo.issues;
        if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
        const ordered = [...issues].sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
        const { page, headers } = paginate(ctx, ordered.map((issue) => issueJson(ctx, repo, issue)), `/api/v3/repos/${owner()}/${repo.name}/issues`);
        sendJson(ctx, 200, page, headers);
        return true;
      }
      if (method === 'POST') {
        if (parseFailed) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const body = asRecord(ctx.json);
        const result = forge.createIssue(repo, {
          title: asString(body.title) ?? '',
          body: asString(body.body) ?? '',
          labelNames: asStringArray(body.labels),
          author: forge.user(ctx.login ?? DEFAULT_LOGIN),
        });
        if ('error' in result) {
          sendError(ctx, 422, `Validation Failed: ${result.error}`);
          return true;
        }
        sendJson(ctx, 201, issueJson(ctx, repo, result.issue));
        return true;
      }
      return false;
    }
    const number = Number.parseInt(rest[1], 10);
    const issue = Number.isFinite(number) ? forge.issueOf(repo, number) : undefined;
    if (rest.length === 2) {
      if (method === 'GET') {
        if (issue === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        // The read workload's target: serialized once, then replayed from the header list.
        const stamp = issue.stamp;
        const number = issue.number;
        sendCached(ctx, rememberJson(ctx.rawUrl, 200, issueJson(ctx, repo, issue), () => repo.issueByNumber.get(number)?.stamp === stamp));
        return true;
      }
      if (method === 'PATCH' || method === 'POST') {
        if (issue === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        if (parseFailed) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const body = asRecord(ctx.json);
        const state = asString(body.state);
        if (state === 'closed' || state === 'open') forge.setIssueState(repo, issue, state);
        let touched = state === 'closed' || state === 'open';
        if (typeof body.title === 'string') {
          issue.title = body.title;
          touched = true;
        }
        if (typeof body.body === 'string') {
          issue.body = body.body;
          touched = true;
        }
        if (touched) forge.touchIssue(repo, issue);
        sendJson(ctx, 200, issueJson(ctx, repo, issue));
        return true;
      }
      return false;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendJson(ctx, 200, issue.comments.map((comment) => commentJson(repo, issue.number, comment)));
        return true;
      }
      if (method === 'POST') {
        if (parseFailed) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const body = asRecord(ctx.json);
        const comment = forge.createComment(repo, issue, asString(body.body) ?? '', forge.user(ctx.login ?? DEFAULT_LOGIN));
        sendJson(ctx, 201, commentJson(repo, issue.number, comment));
        return true;
      }
    }
    return false;
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query?.get('state') ?? 'open';
        let pulls = repo.pulls;
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        const ordered = [...pulls].sort((a, b) => a.number - b.number);
        const { page, headers } = paginate(ctx, ordered.map((pull) => pullJson(ctx, repo, pull)), `/api/v3/repos/${owner()}/${repo.name}/pulls`);
        sendJson(ctx, 200, page, headers);
        return true;
      }
      if (method === 'POST') {
        if (parseFailed) {
          sendError(ctx, 400, 'Problems parsing JSON');
          return true;
        }
        const body = asRecord(ctx.json);
        const clean = (value: string | undefined): string | undefined => (value === undefined ? undefined : value.includes(':') ? value.slice(value.indexOf(':') + 1) : value);
        const head = clean(asString(body.head));
        const base = clean(asString(body.base));
        if (head === undefined || base === undefined) {
          sendError(ctx, 422, 'Validation Failed: head and base are required');
          return true;
        }
        const result = forge.createPull(repo, { title: asString(body.title) ?? '', body: asString(body.body) ?? '', head, base, author: forge.user(ctx.login ?? DEFAULT_LOGIN) });
        if ('error' in result) {
          sendError(ctx, 422, `Validation Failed: ${result.error}`);
          return true;
        }
        sendJson(ctx, 201, pullJson(ctx, repo, result.pull));
        return true;
      }
      return false;
    }
    const number = Number.parseInt(rest[1], 10);
    const pull = Number.isFinite(number) ? forge.pullByNumber(repo, number) : undefined;
    if (rest.length === 2) {
      if (method === 'GET') {
        if (pull === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        sendJson(ctx, 200, pullJson(ctx, repo, pull));
        return true;
      }
      if (method === 'PATCH') {
        if (pull === undefined) {
          sendError(ctx, 404, 'Not Found');
          return true;
        }
        const body = asRecord(ctx.json);
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        const state = asString(body.state);
        if (state === 'closed' || state === 'open') pull.state = state;
        pull.stamp += 1;
        repo.stamp += 1;
        forge.version += 1;
        sendJson(ctx, 200, pullJson(ctx, repo, pull));
        return true;
      }
      return false;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const base = `${origin(ctx)}/api/v3/repos/${owner()}/${repo.name}`;
      const files = forge.pullFiles(repo, pull).map((file) => ({
        sha: repo.objects.has(file.filename) ? file.filename : `F_${pull.number}`,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        blob_url: `${base}/blob/${pull.head}/${file.filename}`,
        raw_url: `${origin(ctx)}/${owner()}/${repo.name}/raw/${pull.head}/${file.filename}`,
        contents_url: `${base}/contents/${file.filename}`,
        patch: file.patch,
      }));
      sendJson(ctx, 200, files);
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge' && (method === 'PUT' || method === 'POST')) {
      if (pull === undefined) {
        sendError(ctx, 404, 'Not Found');
        return true;
      }
      const body = asRecord(ctx.json);
      const method2 = (asString(body.merge_method) ?? 'merge').toLowerCase();
      const result = forge.mergePull(repo, pull, method2, forge.user(ctx.login ?? DEFAULT_LOGIN));
      if (!result.ok) {
        sendError(ctx, result.code, result.message);
        return true;
      }
      sendJson(ctx, 200, { sha: result.sha, merged: true, message: result.message });
      return true;
    }
    return false;
  }

  return false;
}

function contentsRoute(ctx: Ctx, forge: Forge, repo: Repo, path: string, parseFailed: boolean): boolean {
  const method = ctx.method;
  const body = asRecord(ctx.json);
  const written = method === 'PUT' || method === 'POST' || method === 'DELETE';
  const branch = (written ? asString(body.branch) : undefined) ?? ctx.query?.get('ref') ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const commitSha = forge.commitOf(repo, refName);
  const tree = commitSha === undefined
    ? new Map<string, { mode: string; oid: string }>()
    : (() => {
        const object = repo.objects.get(commitSha);
        return object === undefined ? new Map<string, { mode: string; oid: string }>() : forge.flattenTree(repo, parseCommit(object.data).tree);
      })();
  const owner = ownerLogin(repo);
  const base = `${origin(ctx)}/api/v3/repos/${owner}/${repo.name}`;
  const entry = path === '' ? undefined : tree.get(path);
  const dirPrefix = path === '' ? '' : `${path}/`;

  if (method === 'GET') {
    if (entry !== undefined && entry.mode !== '40000' && entry.mode !== '040000') {
      const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: data.toString('base64'),
        sha: entry.oid,
        url: `${base}/contents/${path}`,
        html_url: `${FORGE_ORIGIN}/${owner}/${repo.name}/blob/${branch}/${path}`,
        git_url: `${base}/git/blobs/${entry.oid}`,
        download_url: `${FORGE_ORIGIN}/${owner}/${repo.name}/raw/${branch}/${path}`,
        _links: {},
      });
      return true;
    }
    const direct = new Map<string, { name: string; type: string; path: string; sha: string; size: number }>();
    for (const [candidate, value] of tree) {
      if (!candidate.startsWith(dirPrefix) || candidate === path) continue;
      const remainder = candidate.slice(dirPrefix.length);
      if (remainder === '' || remainder.includes('/')) continue;
      const isDir = value.mode === '40000' || value.mode === '040000';
      direct.set(remainder, {
        name: remainder,
        type: isDir ? 'dir' : 'file',
        path: candidate,
        sha: value.oid,
        size: isDir ? 0 : (repo.objects.get(value.oid)?.data.length ?? 0),
      });
    }
    if (direct.size > 0) {
      sendJson(
        ctx,
        200,
        [...direct.values()].map((item) => ({
          ...item,
          url: `${base}/contents/${item.path}`,
          html_url: `${FORGE_ORIGIN}/${owner}/${repo.name}/blob/${branch}/${item.path}`,
          git_url: null,
          download_url: item.type === 'file' ? `${FORGE_ORIGIN}/${owner}/${repo.name}/raw/${branch}/${item.path}` : null,
          _links: {},
        })),
      );
      return true;
    }
    sendError(ctx, 404, 'Not Found');
    return true;
  }

  const author = forge.user(ctx.login ?? DEFAULT_LOGIN);
  const message = asString(body.message) ?? (method === 'DELETE' ? 'Delete' : 'Update');
  const sha = asString(body.sha);

  if (method === 'PUT' || method === 'POST') {
    if (parseFailed) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return true;
    }
    const contentBase64 = asString(body.content);
    if (contentBase64 === undefined) {
      sendError(ctx, 422, 'Validation Failed: content is required');
      return true;
    }
    if (sha !== undefined) {
      if (entry === undefined) {
        sendError(ctx, 422, `Invalid request: sha ${sha} does not match any file`);
        return true;
      }
      if (entry.oid !== sha) {
        sendError(ctx, 409, `sha ${sha} does not match the current file sha ${entry.oid}`);
        return true;
      }
    }
    const content = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    const result = forge.commitChanges(repo, { parent: commitSha ?? null, changes: [{ path, content }], message, author });
    forge.setRef(repo, refName, result.commitSha);
    const name = path.split('/').pop() ?? path;
    sendJson(ctx, entry === undefined ? 201 : 200, {
      content: {
        name,
        path,
        sha: result.contentSha,
        size: content.length,
        url: `${base}/contents/${path}`,
        html_url: `${FORGE_ORIGIN}/${owner}/${repo.name}/blob/${branch}/${path}`,
        git_url: `${base}/git/blobs/${result.contentSha}`,
        download_url: `${FORGE_ORIGIN}/${owner}/${repo.name}/raw/${branch}/${path}`,
        type: 'file',
        encoding: 'base64',
        _links: {},
      },
      commit: {
        sha: result.commitSha,
        node_id: `C_${result.commitSha}`,
        url: `${base}/git/commits/${result.commitSha}`,
        message,
        author: { name: author.name, email: author.email, date: new Date().toISOString() },
        committer: { name: author.name, email: author.email, date: new Date().toISOString() },
        tree: { sha: '', url: '' },
      },
    });
    return true;
  }

  if (method === 'DELETE') {
    if (parseFailed) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return true;
    }
    if (entry === undefined) {
      sendError(ctx, 404, 'Not Found');
      return true;
    }
    if (sha !== undefined && sha !== entry.oid) {
      sendError(ctx, 409, `sha ${sha} does not match the current file sha ${entry.oid}`);
      return true;
    }
    const result = forge.commitChanges(repo, { parent: commitSha ?? null, changes: [{ path, content: null }], message, author });
    forge.setRef(repo, refName, result.commitSha);
    sendJson(ctx, 200, {
      content: null,
      commit: { sha: result.commitSha, message, author: { name: author.name, email: author.email, date: new Date().toISOString() } },
    });
    return true;
  }

  return false;
}

export { repoJson, issueJson, pullJson, userJson };
