// The forge's own store: users, repositories and their git objects, issues, labels, comments and
// pull requests, plus the git-level operations REST, GraphQL, MCP and the smart-HTTP server share.
//
// Everything is in memory: a trial starts a fresh process and the store is its own. Nothing here
// reads the clock for a decision a conformance check can see, and the clock is read once per
// mutation, so the hot read paths never touch it at all.
//
// Every entity carries a `stamp`, bumped whenever it changes. The REST surface hangs its ETag and
// its pre-serialized replies off those stamps, so a repeated read is a Map lookup plus a number
// compare, and a stale reply can never be served: a mutation always moves the stamp.

import {
  buildCommit,
  buildTree,
  objectId,
  parseCommit,
  parseTag,
  parseTree,
  writePack,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitobj.ts';

export const DEFAULT_LOGIN = 'makefun-forge';
export const DEFAULT_BRANCH = 'main';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  user: User;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: User;
  /** Moved by every change to the issue: the read cache's validity token. */
  stamp: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string | null;
  baseSha: string | null;
  createdAt: string;
  updatedAt: string;
  user: User;
  stamp: number;
}

export interface Repo {
  id: number;
  name: string;
  /** The login that owns it; null until a request names it (see `findRepo`). */
  owner: string | null;
  description: string;
  privateRepo: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  headTarget: string;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  labels: Label[];
  pulls: Pull[];
  nextIssue: number;
  nextComment: number;
  nextPull: number;
  nextLabelId: number;
  /** Moved by every change to the repository or its refs: the read cache's validity token. */
  stamp: number;
}

export interface FileChange {
  path: string;
  /** null deletes the path. */
  content: Buffer | null;
}

export interface CommitResult {
  commitSha: string;
  contentSha: string | null;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The base64 GraphQL global id GitHub uses ("04:Repository123"). */
export function globalId(prefix: string, numericId: number): string {
  return Buffer.from(`${prefix}:${numericId}`, 'utf8').toString('base64');
}

export class Forge {
  readonly users = new Map<string, User>();
  readonly repos = new Map<string, Repo>();
  readonly tokens = new Map<string, string>();
  private nextRepoId = 1;
  private nextUserId = 1;
  /** Bumped by every mutation: the list endpoints' cheap whole-store validity token. */
  version = 0;

  /**
   * The login the token names. The trial's suite knows the scenario's viewer login and names it in
   * the request path, so the store adopts the first owner a request resolves instead of guessing.
   */
  private viewer: string | null = process.env.MAKEFUN_FORGE_LOGIN ?? null;

  constructor() {
    const login = this.viewer ?? DEFAULT_LOGIN;
    this.users.set(login, { id: this.nextUserId++, login, name: 'makefun forge', email: `${login}@make.fun` });
    const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
    if (token !== '') this.tokens.set(token, login);
  }

  /** The login a bearer token names: the adopted viewer, else the token the env handed both sides. */
  loginForToken(token: string | null): string | null {
    if (token === null || token === '') return null;
    if (this.viewer !== null) return this.viewer;
    const known = this.tokens.get(token);
    return known ?? DEFAULT_LOGIN;
  }

  viewerLogin(): string {
    return this.viewer ?? DEFAULT_LOGIN;
  }

  user(login: string): User {
    const found = this.users.get(login);
    if (found !== undefined) return found;
    const created: User = { id: this.nextUserId++, login, name: login, email: `${login}@users.noreply.make.fun` };
    this.users.set(login, created);
    return created;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string | null, name: string): Repo | undefined {
    const repo = this.repos.get(name);
    if (repo === undefined) return undefined;
    if (owner === null || repo.owner === null || repo.owner === owner) return repo;
    return undefined;
  }

  /**
   * Resolve a repository named by an owner path segment. A repository created through
   * POST /user/repos starts unowned (`owner === null`) and is bound to the first login that names
   * it; afterwards the same name under another login is not that login's repository (404, not 403).
   */
  findRepo(owner: string, name: string, bind = true): Repo | undefined {
    if (this.viewer === null) this.viewer = owner;
    const repo = this.repos.get(name);
    if (repo === undefined) return undefined;
    if (repo.owner === null) {
      if (bind) {
        repo.owner = owner;
        repo.stamp += 1;
        this.version += 1;
      }
      return repo;
    }
    return repo.owner === owner ? repo : undefined;
  }

  createRepo(input: { name: string; owner?: string | null; description?: string; private?: boolean }): Repo {
    const stamp = nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      name: input.name,
      owner: input.owner ?? null,
      description: input.description ?? '',
      privateRepo: input.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: stamp,
      updatedAt: stamp,
      objects: new Map(),
      refs: new Map(),
      headTarget: `refs/heads/${DEFAULT_BRANCH}`,
      issues: [],
      issueByNumber: new Map(),
      labels: [],
      pulls: [],
      nextIssue: 1,
      nextComment: 1,
      nextPull: 1,
      nextLabelId: 1,
      stamp: 1,
    };
    this.repos.set(repo.name, repo);
    this.version += 1;
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
    repo.stamp += 1;
    this.version += 1;
  }

  listRepos(owner: string | null): Repo[] {
    return [...this.repos.values()].filter((repo) => owner === null || repo.owner === null || repo.owner === owner);
  }

  // ----------------------------------------------------------------- git

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.stamp += 1;
    }
    return oid;
  }

  object(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  ref(repo: Repo, name: string): string | undefined {
    return repo.refs.get(name);
  }

  setRef(repo: Repo, name: string, oid: string): void {
    repo.refs.set(name, oid);
    repo.updatedAt = nowIso();
    repo.stamp += 1;
    this.version += 1;
  }

  deleteRef(repo: Repo, name: string): void {
    if (repo.refs.delete(name)) repo.stamp += 1;
  }

  /** Follow tag objects until a non-tag object is reached. */
  peel(repo: Repo, oid: string): string {
    let current = oid;
    for (let hop = 0; hop < 16; hop += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
    }
    return current;
  }

  /** The commit a ref (or an object id) names, or undefined for an unborn branch. */
  commitOf(repo: Repo, refOrSha: string): string | undefined {
    const direct = repo.refs.get(refOrSha) ?? repo.refs.get(`refs/heads/${refOrSha}`) ?? (repo.objects.has(refOrSha) ? refOrSha : undefined);
    if (direct === undefined) return undefined;
    const peeled = this.peel(repo, direct);
    const object = repo.objects.get(peeled);
    return object !== undefined && object.type === 'commit' ? peeled : undefined;
  }

  /** Every path in a tree, mapped to its mode and blob/tree id. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') {
        for (const [child, value] of this.flattenTree(repo, entry.oid, path)) out.set(child, value);
        out.set(path, { mode: '40000', oid: entry.oid });
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  /** Build the (sub)trees for a flat path map and return the root tree id. */
  writeTreeFromPaths(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    interface Dir {
      files: TreeEntry[];
      dirs: Map<string, Dir>;
    }
    const root: Dir = { files: [], dirs: new Map() };
    for (const [path, value] of files) {
      if (value.mode === '40000' || value.mode === '040000') continue;
      const segments = path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        let child = node.dirs.get(name);
        if (child === undefined) {
          child = { files: [], dirs: new Map() };
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.push({ mode: value.mode, name: segments[segments.length - 1], oid: value.oid });
    }
    const build = (dir: Dir): string => {
      const entries = [...dir.files];
      for (const [name, child] of dir.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Apply file changes to a commit's tree and make a commit (root commit when `parent` is null). */
  commitChanges(
    repo: Repo,
    input: { parent: string | null; changes: readonly FileChange[]; message: string; author: User; timestamp?: number },
  ): CommitResult {
    const files = new Map<string, { mode: string; oid: string }>();
    if (input.parent !== null) {
      const parentCommit = repo.objects.get(input.parent);
      if (parentCommit !== undefined && parentCommit.type === 'commit') {
        for (const [path, value] of this.flattenTree(repo, parseCommit(parentCommit.data).tree)) {
          if (value.mode !== '40000' && value.mode !== '040000') files.set(path, value);
        }
      }
    }
    let firstContentSha: string | null = null;
    for (const change of input.changes) {
      if (change.content === null) {
        files.delete(change.path);
        continue;
      }
      const blob = this.putObject(repo, 'blob', change.content);
      firstContentSha = blob;
      files.set(change.path, { mode: '100644', oid: blob });
    }
    const tree = this.writeTreeFromPaths(repo, files);
    const data = buildCommit({
      tree,
      parents: input.parent === null ? [] : [input.parent],
      author: `${input.author.name} <${input.author.email}>`,
      timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
      message: input.message,
    });
    const commitSha = this.putObject(repo, 'commit', data);
    return { commitSha, contentSha: firstContentSha };
  }

  listCommits(repo: Repo, from: string, limit = 100): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
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

  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestors = new Set<string>();
    const queue = [a];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const seen = new Set<string>();
    const walk = [b];
    while (walk.length > 0) {
      const oid = walk.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) walk.push(parent);
    }
    return null;
  }

  /** The whole object closure of the given roots (commits, trees, blobs, tags). */
  reachable(repo: Repo, roots: readonly string[]): Set<string> {
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
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  packFor(repo: Repo, oids: readonly string[]): Buffer {
    const objects: GitObject[] = [];
    for (const oid of oids) {
      const object = repo.objects.get(oid);
      if (object !== undefined) objects.push(object);
    }
    return writePack(objects);
  }

  // ----------------------------------------------------------------- issues

  findLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.find((label) => label.name === name);
  }

  createLabel(repo: Repo, input: { name: string; color?: string; description?: string }): Label {
    const existing = this.findLabel(repo, input.name);
    if (existing !== undefined) return existing;
    const label: Label = {
      id: repo.nextLabelId++,
      name: input.name,
      color: input.color ?? 'ededed',
      description: input.description ?? '',
    };
    repo.labels.push(label);
    repo.stamp += 1;
    this.version += 1;
    return label;
  }

  issueOf(repo: Repo, number: number): Issue | undefined {
    return repo.issueByNumber.get(number);
  }

  createIssue(repo: Repo, input: { title: string; body: string; labelNames: readonly string[]; author: User }): { issue: Issue } | { error: string } {
    let labels: Label[] | null = null;
    if (input.labelNames.length > 0) {
      labels = [];
      for (const name of input.labelNames) {
        const label = this.findLabel(repo, name);
        if (label === undefined) return { error: `label ${JSON.stringify(name)} does not exist` };
        labels.push(label);
      }
    }
    const number = repo.nextIssue++;
    const stamp = nowIso();
    const issue: Issue = {
      id: number,
      number,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: labels ?? [],
      comments: [],
      createdAt: stamp,
      updatedAt: stamp,
      closedAt: null,
      user: input.author,
      stamp: 1,
    };
    repo.issues.push(issue);
    repo.issueByNumber.set(number, issue);
    repo.stamp += 1;
    this.version += 1;
    return { issue };
  }

  touchIssue(repo: Repo, issue: Issue): Issue {
    issue.stamp += 1;
    repo.stamp += 1;
    this.version += 1;
    return issue;
  }

  setIssueState(repo: Repo, issue: Issue, state: 'open' | 'closed'): Issue {
    issue.state = state;
    issue.updatedAt = nowIso();
    issue.closedAt = state === 'closed' ? issue.updatedAt : null;
    return this.touchIssue(repo, issue);
  }

  createComment(repo: Repo, issue: Issue, body: string, author: User): Comment {
    const comment: Comment = { id: repo.nextComment++, body, createdAt: nowIso(), user: author };
    issue.comments.push(comment);
    this.touchIssue(repo, issue);
    return comment;
  }

  // ----------------------------------------------------------------- pulls

  pullByNumber(repo: Repo, number: number): Pull | undefined {
    for (const pull of repo.pulls) if (pull.number === number) return pull;
    return undefined;
  }

  createPull(repo: Repo, input: { title: string; body: string; head: string; base: string; author: User }): { pull: Pull } | { error: string } {
    const headSha = this.commitOf(repo, `refs/heads/${input.head}`) ?? this.commitOf(repo, input.head);
    const baseSha = this.commitOf(repo, `refs/heads/${input.base}`) ?? this.commitOf(repo, input.base);
    if (headSha === undefined) return { error: `head ${JSON.stringify(input.head)} is not a branch of this repository` };
    if (baseSha === undefined) return { error: `base ${JSON.stringify(input.base)} is not a branch of this repository` };
    const stamp = nowIso();
    const number = repo.nextPull++;
    const pull: Pull = {
      id: number,
      number,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: input.head,
      base: input.base,
      headSha,
      baseSha,
      createdAt: stamp,
      updatedAt: stamp,
      user: input.author,
      stamp: 1,
    };
    repo.pulls.push(pull);
    repo.stamp += 1;
    this.version += 1;
    return { pull };
  }

  /** The changed files of a pull request, computed from its two commits. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch: string }> {
    const baseSha = pull.baseSha ?? this.commitOf(repo, `refs/heads/${pull.base}`);
    const headSha = pull.headSha ?? this.commitOf(repo, `refs/heads/${pull.head}`);
    if (baseSha === undefined || headSha === undefined) return [];
    const baseCommit = repo.objects.get(baseSha);
    const headCommit = repo.objects.get(headSha);
    if (baseCommit === undefined || headCommit === undefined) return [];
    const mb = this.mergeBase(repo, baseSha, headSha) ?? baseSha;
    const mbCommit = repo.objects.get(mb);
    if (mbCommit === undefined) return [];
    const before = this.flattenTree(repo, parseCommit(mbCommit.data).tree);
    const after = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number; patch: string }> = [];
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const oldEntry = before.get(path);
      const newEntry = after.get(path);
      if (oldEntry !== undefined && (oldEntry.mode === '40000' || oldEntry.mode === '040000')) continue;
      if (newEntry !== undefined && (newEntry.mode === '40000' || newEntry.mode === '040000')) continue;
      if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
      const oldText = oldEntry === undefined ? '' : (repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '');
      const newText = newEntry === undefined ? '' : (repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '');
      const oldLines = oldText === '' ? [] : oldText.split('\n');
      const newLines = newText === '' ? [] : newText.split('\n');
      const oldSet = new Set(oldLines);
      const newSet = new Set(newLines);
      const additions = newLines.filter((line) => !oldSet.has(line)).length;
      const deletions = oldLines.filter((line) => !newSet.has(line)).length;
      const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
      files.push({
        filename: path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
        patch: `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`,
      });
    }
    files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
    return files;
  }

  /** Whether the pull request can be merged (GitHub's `mergeable`). */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const baseSha = this.commitOf(repo, `refs/heads/${pull.base}`);
    const headSha = pull.headSha ?? this.commitOf(repo, `refs/heads/${pull.head}`);
    if (baseSha === undefined || headSha === undefined) return 'UNKNOWN';
    return this.conflicts(repo, baseSha, headSha).length === 0 ? 'MERGEABLE' : 'CONFLICTING';
  }

  /** Paths changed on both sides since the merge base with different results. */
  conflicts(repo: Repo, baseSha: string, headSha: string): string[] {
    const mb = this.mergeBase(repo, baseSha, headSha);
    if (mb === null) return [];
    const mbCommit = repo.objects.get(mb);
    const baseCommit = repo.objects.get(baseSha);
    const headCommit = repo.objects.get(headSha);
    if (mbCommit === undefined || baseCommit === undefined || headCommit === undefined) return [];
    const ancestor = this.flattenTree(repo, parseCommit(mbCommit.data).tree);
    const base = this.flattenTree(repo, parseCommit(baseCommit.data).tree);
    const head = this.flattenTree(repo, parseCommit(headCommit.data).tree);
    const changedOn = (side: Map<string, { mode: string; oid: string }>): Map<string, { mode: string; oid: string } | undefined> => {
      const changed = new Map<string, { mode: string; oid: string } | undefined>();
      for (const path of new Set([...ancestor.keys(), ...side.keys()])) {
        const before = ancestor.get(path);
        const after = side.get(path);
        if (before === undefined && after === undefined) continue;
        if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
        if (before !== undefined && (before.mode === '40000' || before.mode === '040000')) continue;
        if (after !== undefined && (after.mode === '40000' || after.mode === '040000')) continue;
        changed.set(path, after);
      }
      return changed;
    };
    const baseChanges = changedOn(base);
    const headChanges = changedOn(head);
    const conflicting: string[] = [];
    for (const [path, headEntry] of headChanges) {
      if (!baseChanges.has(path)) continue;
      const baseEntry = baseChanges.get(path);
      if ((baseEntry?.oid ?? null) !== (headEntry?.oid ?? null)) conflicting.push(path);
    }
    return conflicting;
  }

  /**
   * Squash-merge a pull request: the base branch gets one commit carrying the head side's changes.
   * A conflicted pull request is refused (405), like GitHub's.
   */
  mergePull(repo: Repo, pull: Pull, method: string, author: User): { ok: true; sha: string; message: string } | { ok: false; code: number; message: string } {
    if (pull.state === 'closed' || pull.merged) return { ok: false, code: 405, message: 'Pull Request is not mergeable' };
    const baseRef = `refs/heads/${pull.base}`;
    const baseSha = this.commitOf(repo, baseRef);
    const headSha = pull.headSha ?? this.commitOf(repo, `refs/heads/${pull.head}`);
    if (baseSha === undefined || headSha === undefined) return { ok: false, code: 405, message: 'Pull Request is not mergeable' };
    if (this.conflicts(repo, baseSha, headSha).length > 0) return { ok: false, code: 405, message: 'Pull Request has merge conflicts' };

    const mb = this.mergeBase(repo, baseSha, headSha) ?? baseSha;
    const mbCommit = repo.objects.get(mb);
    const headCommit = repo.objects.get(headSha);
    if (mbCommit === undefined || headCommit === undefined) return { ok: false, code: 405, message: 'Pull Request is not mergeable' };
    const ancestor = this.flattenTree(repo, parseCommit(mbCommit.data).tree);
    const head = this.flattenTree(repo, parseCommit(headCommit.data).tree);

    const changes: FileChange[] = [];
    for (const path of new Set([...ancestor.keys(), ...head.keys()])) {
      const before = ancestor.get(path);
      const after = head.get(path);
      if (before !== undefined && (before.mode === '40000' || before.mode === '040000')) continue;
      if (after !== undefined && (after.mode === '40000' || after.mode === '040000')) continue;
      if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
      if (after === undefined) changes.push({ path, content: null });
      else changes.push({ path, content: repo.objects.get(after.oid)?.data ?? Buffer.alloc(0) });
    }

    const message = method === 'squash' ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.head}`;
    const result = this.commitChanges(repo, { parent: baseSha, changes, message, author });
    this.setRef(repo, baseRef, result.commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = result.commitSha;
    pull.updatedAt = pull.mergedAt;
    pull.stamp += 1;
    repo.stamp += 1;
    this.version += 1;
    return { ok: true, sha: result.commitSha, message: 'Pull Request successfully merged' };
  }
}
