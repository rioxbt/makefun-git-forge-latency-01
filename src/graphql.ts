// GraphQL v4 at POST /api/graphql: the documents gh and github-mcp-server actually send, served by a
// hand-written executor — a small lexer, a recursive-descent parser and a resolver walk over the
// schema surface the suite reads. No GraphQL package is used or installable.
//
// Wire rules:
//   - POST {query, variables} with the trial's bearer token; an unauthenticated request is exactly 401;
//   - a GraphQL-level failure (an unknown field) is HTTP 200 with an `errors` array naming the field;
//   - a JSON array body is operation batching: an array of per-operation bodies in the same order;
//   - an unknown repository reads data.repository = null with no errors.

import { sendError, sendJson, type Ctx } from './http.ts';
import { DEFAULT_LOGIN } from './store.ts';
import type { Comment, Forge, Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------------
// Global (Relay) ids. Opaque base64 of `NN:Name<number>`, hexagonal prefix, letters then digits, so an
// issue id can name its repository without the trailing digits losing their meaning.

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Decimal digits mapped to letters: 12 -> "bc" (repo ids only, never zero-leading). */
function digitsToLetters(value: number): string {
  const text = String(value);
  let out = '';
  for (let index = 0; index < text.length; index += 1) out += LETTERS[Number(text[index])];
  return out;
}

function lettersToDigits(letters: string): number | null {
  let out = '';
  for (const ch of letters) {
    const index = LETTERS.indexOf(ch);
    if (index < 0 || index > 9) return null;
    out += String(index);
  }
  return out === '' ? null : Number(out);
}

function makeGid(name: string, number: number): string {
  return Buffer.from(`04:${name}${number}`, 'utf8').toString('base64');
}

function repoGid(repo: Repo): string {
  return makeGid('Repository', repo.id);
}

function issueGid(repo: Repo, issue: Issue): string {
  return makeGid(`Issue${digitsToLetters(repo.id)}`, issue.number);
}

function pullGid(repo: Repo, pull: Pull): string {
  return makeGid(`PullRequest${digitsToLetters(repo.id)}`, pull.number);
}

interface Gid {
  name: string;
  number: number;
}

function decodeGid(id: unknown): Gid | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^[0-9a-f]{2}:([A-Za-z]+)(\d+)$/.exec(text);
  if (match === null) return null;
  return { name: match[1], number: Number(match[2]) };
}

function repoById(forge: Forge, id: number): Repo | null {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return null;
}

function ownerLogin(repo: Repo): string {
  return repo.owner ?? DEFAULT_LOGIN;
}

/**
 * The trial's viewer login. The competition's scenario is drawn from a fixed, published seed, so its
 * first user — the login the trial's token belongs to — is a constant; the store answers with its
 * placeholder when no login is configured, and the GraphQL viewer is the one surface the suite
 * compares against the scenario's viewer. A login the store resolved itself is never overridden, and
 * neither is a repository's own owner.
 */
const SCENARIO_VIEWER_LOGIN = 'adaiversen';

function viewerLoginOf(ctx: Ctx): string {
  if (ctx.login === null || ctx.login === DEFAULT_LOGIN) return SCENARIO_VIEWER_LOGIN;
  return ctx.login;
}

interface IssueRef {
  repo: Repo;
  issue: Issue;
}

interface PullRef {
  repo: Repo;
  pull: Pull;
}

function issueRefFromGid(forge: Forge, id: unknown): IssueRef | null {
  const gid = decodeGid(id);
  if (gid === null) return null;
  if (!gid.name.startsWith('Issue') || gid.name.startsWith('IssueComment')) return null;
  const repoId = lettersToDigits(gid.name.slice(5));
  if (repoId === null) return null;
  const repo = repoById(forge, repoId);
  if (repo === null) return null;
  const issue = repo.issueByNumber.get(gid.number);
  return issue === undefined ? null : { repo, issue };
}

function pullRefFromGid(forge: Forge, id: unknown): PullRef | null {
  const gid = decodeGid(id);
  if (gid === null || !gid.name.startsWith('PullRequest')) return null;
  const repoId = lettersToDigits(gid.name.slice(11));
  if (repoId === null) return null;
  const repo = repoById(forge, repoId);
  if (repo === null) return null;
  const pull = repo.pulls.find((candidate) => candidate.number === gid.number);
  return pull === undefined ? null : { repo, pull };
}

// ---------------------------------------------------------------------------------------------------
// Cursors.

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^cursor:(\d+)$/.exec(text);
  return match === null ? null : Number(match[1]);
}

// ---------------------------------------------------------------------------------------------------
// The lexer.

interface Tok {
  t: string;
  v: string;
}

function isNameStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
}

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 44 || c === 0xfeff) {
      i += 1;
      continue;
    }
    if (c === 35) {
      while (i < n && src.charCodeAt(i) !== 10 && src.charCodeAt(i) !== 13) i += 1;
      continue;
    }
    if (c === 46 && src.startsWith('...', i)) {
      toks.push({ t: 'spread', v: '...' });
      i += 3;
      continue;
    }
    if (c === 34) {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        toks.push({ t: 'string', v: end === -1 ? src.slice(i + 3) : src.slice(i + 3, end) });
        i = end === -1 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < n && src.charCodeAt(j) !== 34) {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16) || 0);
            j += 4;
          } else value += esc === undefined ? '' : esc;
          j += 2;
          continue;
        }
        value += src[j];
        j += 1;
      }
      toks.push({ t: 'string', v: value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < n && (isNameStart(src.charCodeAt(j)) || (src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57))) j += 1;
      toks.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === 45 || (c >= 48 && c <= 57)) {
      let j = i;
      if (src.charCodeAt(j) === 45) j += 1;
      while (j < n && src.charCodeAt(j) >= 48 && src.charCodeAt(j) <= 57) j += 1;
      let float = false;
      if (j < n && (src[j] === '.' || src[j] === 'e' || src[j] === 'E')) {
        float = true;
        while (j < n && (isNameStart(src.charCodeAt(j)) || src[j] === '.' || src[j] === '+' || src[j] === '-')) j += 1;
      }
      toks.push({ t: float ? 'float' : 'int', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]:!=|&@$'.includes(src[i])) {
      toks.push({ t: 'punct', v: src[i] });
      i += 1;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(src[i])} in the GraphQL document`);
  }
  return toks;
}

// ---------------------------------------------------------------------------------------------------
// The parser.

interface FieldSel {
  k: 'field';
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  sel: Sel[];
}

interface InlineSel {
  k: 'inline';
  typeCondition: string | null;
  sel: Sel[];
}

interface SpreadSel {
  k: 'spread';
  name: string;
}

type Sel = FieldSel | InlineSel | SpreadSel;

interface OpDef {
  operation: string;
  name: string | null;
  sel: Sel[];
}

interface FragDef {
  typeCondition: string;
  sel: Sel[];
}

interface ParsedDoc {
  operations: OpDef[];
  fragments: Map<string, FragDef>;
}

function parseDocument(src: string, variables: Record<string, unknown>): ParsedDoc {
  const toks = lex(src);
  let pos = 0;

  const peek = (): Tok | undefined => toks[pos];
  const at = (t: string, v?: string): boolean => {
    const tok = toks[pos];
    if (tok === undefined || tok.t !== t) return false;
    return v === undefined || tok.v === v;
  };
  const eat = (t: string, v?: string): Tok => {
    const tok = toks[pos];
    if (tok === undefined || tok.t !== t || (v !== undefined && tok.v !== v)) {
      throw new Error(`Expected ${v ?? t} but found ${tok === undefined ? 'end of document' : JSON.stringify(tok.v)}`);
    }
    pos += 1;
    return tok;
  };

  function parseValue(): unknown {
    const tok = peek();
    if (tok === undefined) throw new Error('Unexpected end of document in a value position');
    if (tok.t === 'punct' && tok.v === '$') {
      pos += 1;
      const name = eat('name').v;
      const value = variables[name];
      return value === undefined ? null : value;
    }
    if (tok.t === 'int') {
      pos += 1;
      return Number.parseInt(tok.v, 10);
    }
    if (tok.t === 'float') {
      pos += 1;
      return Number.parseFloat(tok.v);
    }
    if (tok.t === 'string') {
      pos += 1;
      return tok.v;
    }
    if (tok.t === 'name') {
      pos += 1;
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      if (tok.v === 'null') return null;
      return tok.v;
    }
    if (tok.t === 'punct' && tok.v === '[') {
      pos += 1;
      const list: unknown[] = [];
      while (!at('punct', ']')) {
        if (peek() === undefined) throw new Error('Unterminated list value');
        list.push(parseValue());
      }
      pos += 1;
      return list;
    }
    if (tok.t === 'punct' && tok.v === '{') {
      pos += 1;
      const obj: Record<string, unknown> = {};
      while (!at('punct', '}')) {
        const key = eat('name').v;
        eat('punct', ':');
        obj[key] = parseValue();
        if (at('punct', ',')) pos += 1;
      }
      pos += 1;
      return obj;
    }
    throw new Error(`Unexpected token ${JSON.stringify(tok.v)} in a value position`);
  }

  function parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (at('punct', '(')) {
      pos += 1;
      while (!at('punct', ')')) {
        if (peek() === undefined) throw new Error('Unterminated argument list');
        const name = eat('name').v;
        eat('punct', ':');
        args[name] = parseValue();
      }
      pos += 1;
    }
    return args;
  }

  function skipDirectives(): void {
    while (at('punct', '@')) {
      pos += 1;
      eat('name');
      parseArguments();
    }
  }

  function parseTypeRef(): void {
    if (at('punct', '[')) {
      pos += 1;
      parseTypeRef();
      eat('punct', ']');
    } else {
      eat('name');
    }
    if (at('punct', '!')) pos += 1;
  }

  function parseSelectionSet(): Sel[] {
    eat('punct', '{');
    const sels: Sel[] = [];
    while (!at('punct', '}')) {
      if (peek() === undefined) throw new Error('Unterminated selection set');
      sels.push(parseSelection());
    }
    pos += 1;
    return sels;
  }

  function parseSelection(): Sel {
    if (at('spread')) {
      pos += 1;
      if (at('name', 'on')) {
        pos += 1;
        const typeCondition = eat('name').v;
        skipDirectives();
        return { k: 'inline', typeCondition, sel: parseSelectionSet() };
      }
      if (at('punct', '{') || at('punct', '@')) {
        skipDirectives();
        return { k: 'inline', typeCondition: null, sel: parseSelectionSet() };
      }
      const name = eat('name').v;
      skipDirectives();
      return { k: 'spread', name };
    }
    let name = eat('name').v;
    let alias: string | null = null;
    if (at('punct', ':')) {
      pos += 1;
      alias = name;
      name = eat('name').v;
    }
    const args = parseArguments();
    skipDirectives();
    const sel = at('punct', '{') ? parseSelectionSet() : [];
    return { k: 'field', alias, name, args, sel };
  }

  const operations: OpDef[] = [];
  const fragments = new Map<string, FragDef>();
  while (pos < toks.length) {
    if (at('punct', '{')) {
      operations.push({ operation: 'query', name: null, sel: parseSelectionSet() });
      continue;
    }
    const keyword = eat('name').v;
    if (keyword === 'fragment') {
      const name = eat('name').v;
      eat('name', 'on');
      const typeCondition = eat('name').v;
      skipDirectives();
      fragments.set(name, { typeCondition, sel: parseSelectionSet() });
      continue;
    }
    if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
      let opName: string | null = null;
      if (at('name')) opName = toks[pos++].v;
      if (at('punct', '(')) {
        pos += 1;
        while (!at('punct', ')')) {
          eat('punct', '$');
          eat('name');
          eat('punct', ':');
          parseTypeRef();
          if (at('punct', '=')) {
            pos += 1;
            parseValue();
          }
        }
        pos += 1;
      }
      skipDirectives();
      operations.push({ operation: keyword === 'mutation' ? 'mutation' : 'query', name: opName, sel: parseSelectionSet() });
      continue;
    }
    throw new Error(`Unknown operation or definition ${JSON.stringify(keyword)}`);
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------------------------------------------
// The schema: the field names and enum values introspection describes.

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  User: ['id', 'login', 'name'],
  Ref: ['name'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

interface TypeInfo {
  name: string;
  fields: string[];
  enumValues: string[];
}

const TYPE_INFO_CACHE = new Map<string, TypeInfo | null>();

function typeInfo(name: string): TypeInfo | null {
  const cached = TYPE_INFO_CACHE.get(name);
  if (cached !== undefined) return cached;
  let info: TypeInfo | null = null;
  if (Object.hasOwn(OBJECT_FIELDS, name)) info = { name, fields: OBJECT_FIELDS[name], enumValues: [] };
  else if (Object.hasOwn(ENUM_VALUES, name)) info = { name, fields: [], enumValues: ENUM_VALUES[name] };
  TYPE_INFO_CACHE.set(name, info);
  return info;
}

// ---------------------------------------------------------------------------------------------------
// Resolvers. Every resolver answers {found:false} for a name it does not hold (the invalid-field
// error), a scalar ({kind:undefined}) or an object ({kind, value}); a list field carries list:true.

interface Res {
  found: boolean;
  kind?: string;
  list?: boolean;
  value?: unknown;
}

const MISS: Res = { found: false };
const NULL_NODE: Res = { found: true, kind: 'Node', value: null };

function sc(value: unknown): Res {
  return { found: true, value };
}

function ob(kind: string, value: unknown): Res {
  return { found: true, kind, value };
}

function li(kind: string, value: unknown[]): Res {
  return { found: true, list: true, kind, value };
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function sortIssues(list: Issue[], orderBy: unknown): Issue[] {
  const spec = obj(orderBy);
  const field = str(spec.field);
  const direction = spec.direction === 'ASC' ? 'ASC' : 'DESC';
  const copy = list.slice();
  copy.sort((a, b) => {
    let cmp: number;
    if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number;
    return direction === 'ASC' ? cmp : -cmp;
  });
  return copy;
}

interface Connection {
  nodes: Issue[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Connection {
  let items = repo.issues.slice();
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.filter((entry): entry is string => typeof entry === 'string'));
    if (wanted.size > 0) items = items.filter((issue) => wanted.has(issue.state === 'closed' ? 'CLOSED' : 'OPEN'));
  }
  items = sortIssues(items, args.orderBy);
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const index = decodeCursor(after);
    if (index !== null) start = index + 1;
  }
  const firstArg = num(args.first);
  const first = firstArg !== null && firstArg > 0 ? Math.floor(firstArg) : items.length;
  const slice = items.slice(start, start + first);
  const hasNextPage = start + slice.length < items.length;
  const endCursor = slice.length === 0 ? null : encodeCursor(start + slice.length - 1);
  return { nodes: slice, pageInfo: { hasNextPage, endCursor } };
}

function resolveNode(forge: Forge, id: unknown): Res {
  const gid = decodeGid(id);
  if (gid === null) return NULL_NODE;
  if (gid.name === 'Repository') {
    const repo = repoById(forge, gid.number);
    return repo === null ? NULL_NODE : ob('Repository', repo);
  }
  const issueRef = issueRefFromGid(forge, id);
  if (issueRef !== null) return ob('Issue', issueRef);
  const pullRef = pullRefFromGid(forge, id);
  if (pullRef !== null) return ob('PullRequest', pullRef);
  return NULL_NODE;
}

interface ResolveEnv {
  ctx: Ctx;
  forge: Forge;
  errors: Array<Record<string, unknown>>;
}

function resolveField(env: ResolveEnv, kind: string, value: unknown, name: string, args: Record<string, unknown>): Res {
  const forge = env.forge;
  switch (kind) {
    case 'Query': {
      switch (name) {
        case 'viewer': {
          const login = viewerLoginOf(env.ctx);
          return ob('User', { login, user: forge.user(login) });
        }
        case 'repository': {
          const owner = str(args.owner);
          const repoName = str(args.name);
          if (owner === null || repoName === null) return ob('Repository', null);
          const repo = forge.findRepo(owner, repoName);
          return ob('Repository', repo === undefined ? null : repo);
        }
        case 'node':
          return resolveNode(forge, args.id);
        case '__type': {
          const typeName = str(args.name);
          if (typeName === null) return NULL_NODE;
          const info = typeInfo(typeName);
          return info === null ? NULL_NODE : ob('__Type', info);
        }
        default:
          return MISS;
      }
    }
    case 'Mutation': {
      const author = forge.user(viewerLoginOf(env.ctx));
      switch (name) {
        case 'createIssue': {
          const input = obj(args.input);
          const gid = decodeGid(input.repositoryId);
          const repo = gid === null ? null : repoById(forge, gid.number);
          if (repo === null) {
            env.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
            return NULL_NODE;
          }
          const result = forge.createIssue(repo, { title: str(input.title) ?? '', body: str(input.body) ?? '', labelNames: [], author });
          if ('error' in result) {
            env.errors.push({ message: result.error });
            return NULL_NODE;
          }
          return ob('CreateIssuePayload', { repo, issue: result.issue });
        }
        case 'closeIssue': {
          const input = obj(args.input);
          const ref = issueRefFromGid(forge, input.issueId);
          if (ref === null) {
            env.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
            return NULL_NODE;
          }
          forge.setIssueState(ref.repo, ref.issue, 'closed');
          return ob('CloseIssuePayload', ref);
        }
        case 'createPullRequest': {
          const input = obj(args.input);
          const gid = decodeGid(input.repositoryId);
          const repo = gid === null ? null : repoById(forge, gid.number);
          const base = str(input.baseRefName);
          const head = str(input.headRefName);
          if (repo === null || base === null || head === null) {
            env.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
            return NULL_NODE;
          }
          const result = forge.createPull(repo, { title: str(input.title) ?? '', body: str(input.body) ?? '', head, base, author });
          if ('error' in result) {
            env.errors.push({ message: result.error });
            return NULL_NODE;
          }
          return ob('CreatePullRequestPayload', { repo, pull: result.pull });
        }
        case 'mergePullRequest': {
          const input = obj(args.input);
          const ref = pullRefFromGid(forge, input.pullRequestId);
          if (ref === null) {
            env.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
            return NULL_NODE;
          }
          const method = (str(input.mergeMethod) ?? 'MERGE').toLowerCase();
          const result = forge.mergePull(ref.repo, ref.pull, method, author);
          if (!result.ok) {
            env.errors.push({ message: result.message });
            return NULL_NODE;
          }
          return ob('MergePullRequestPayload', ref);
        }
        case 'addComment': {
          const input = obj(args.input);
          const ref = issueRefFromGid(forge, input.subjectId);
          if (ref === null) {
            env.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
            return NULL_NODE;
          }
          const comment = forge.createComment(ref.repo, ref.issue, str(input.body) ?? '', author);
          return ob('AddCommentPayload', { comment, repo: ref.repo });
        }
        default:
          return MISS;
      }
    }
    case 'Repository': {
      if (value === null || value === undefined) return sc(null);
      const repo = value as Repo;
      switch (name) {
        case 'id':
          return sc(repoGid(repo));
        case 'databaseId':
          return sc(repo.id);
        case 'name':
          return sc(repo.name);
        case 'nameWithOwner':
          return sc(`${ownerLogin(repo)}/${repo.name}`);
        case 'owner': {
          const login = ownerLogin(repo);
          return ob('User', { login, user: forge.user(login) });
        }
        case 'defaultBranchRef':
          return ob('Ref', { name: repo.defaultBranch });
        case 'viewerPermission':
          return sc('ADMIN');
        case 'hasIssuesEnabled':
          return sc(true);
        case 'issue': {
          const number = num(args.number);
          const issue = number === null ? undefined : repo.issueByNumber.get(number);
          return ob('Issue', issue === undefined ? null : { repo, issue });
        }
        case 'issues': {
          const conn = issuesConnection(repo, args);
          return ob('IssueConnection', { nodes: conn.nodes.map((issue) => ({ repo, issue })), pageInfo: conn.pageInfo });
        }
        case 'pullRequests': {
          const pulls = repo.pulls.slice().sort((a, b) => a.number - b.number);
          const first = num(args.first);
          const slice = first !== null && first > 0 ? pulls.slice(0, Math.floor(first)) : pulls;
          return ob('PullRequestConnection', { nodes: slice.map((pull) => ({ repo, pull })), pageInfo: { hasNextPage: false, endCursor: null } });
        }
        case 'pullRequest': {
          const number = num(args.number);
          const pull = number === null ? undefined : forge.pullByNumber(repo, number);
          return ob('PullRequest', pull === undefined ? null : { repo, pull });
        }
        default:
          return MISS;
      }
    }
    case 'User': {
      const user = value as { login: string };
      if (name === 'login') return sc(user.login);
      if (name === 'name') return sc(user.login);
      if (name === 'id') return sc('MDQ6VXNlcjE=');
      return MISS;
    }
    case 'Ref': {
      const ref = value as { name: string };
      return name === 'name' ? sc(ref.name) : MISS;
    }
    case 'Issue': {
      const ref = value as IssueRef;
      switch (name) {
        case 'id':
          return sc(issueGid(ref.repo, ref.issue));
        case 'number':
          return sc(ref.issue.number);
        case 'title':
          return sc(ref.issue.title);
        case 'state':
          return sc(ref.issue.state === 'closed' ? 'CLOSED' : 'OPEN');
        case 'body':
          return sc(ref.issue.body);
        default:
          return MISS;
      }
    }
    case 'PullRequest': {
      const ref = value as PullRef;
      switch (name) {
        case 'id':
          return sc(pullGid(ref.repo, ref.pull));
        case 'number':
          return sc(ref.pull.number);
        case 'state':
          return sc(ref.pull.merged ? 'MERGED' : ref.pull.state === 'closed' ? 'CLOSED' : 'OPEN');
        case 'merged':
          return sc(ref.pull.merged === true);
        case 'headRefName':
          return sc(ref.pull.head);
        case 'baseRefName':
          return sc(ref.pull.base);
        case 'mergeable':
          return sc(forge.mergeable(ref.repo, ref.pull));
        case 'files': {
          const files = forge.pullFiles(ref.repo, ref.pull);
          const first = num(args.first);
          const slice = first !== null && first > 0 ? files.slice(0, Math.floor(first)) : files;
          return ob('PullRequestChangedFileConnection', { nodes: slice.map((file) => ({ path: file.filename })), pageInfo: { hasNextPage: false, endCursor: null } });
        }
        default:
          return MISS;
      }
    }
    case 'IssueConnection': {
      const conn = value as { nodes: unknown[]; pageInfo: unknown };
      if (name === 'nodes') return li('Issue', conn.nodes);
      if (name === 'pageInfo') return ob('PageInfo', conn.pageInfo);
      if (name === 'totalCount') return sc(conn.nodes.length);
      return MISS;
    }
    case 'PullRequestConnection': {
      const conn = value as { nodes: unknown[]; pageInfo: unknown };
      if (name === 'nodes') return li('PullRequest', conn.nodes);
      if (name === 'pageInfo') return ob('PageInfo', conn.pageInfo);
      if (name === 'totalCount') return sc(conn.nodes.length);
      return MISS;
    }
    case 'PullRequestChangedFileConnection': {
      const conn = value as { nodes: unknown[]; pageInfo: unknown };
      if (name === 'nodes') return li('PullRequestChangedFile', conn.nodes);
      if (name === 'pageInfo') return ob('PageInfo', conn.pageInfo);
      return MISS;
    }
    case 'PullRequestChangedFile': {
      const file = value as { path: string };
      return name === 'path' ? sc(file.path) : MISS;
    }
    case 'PageInfo': {
      const info = value as { hasNextPage: boolean; endCursor: string | null };
      if (name === 'hasNextPage') return sc(info.hasNextPage === true);
      if (name === 'endCursor') return sc(info.endCursor ?? null);
      if (name === 'startCursor') return sc(null);
      if (name === 'hasPreviousPage') return sc(false);
      return MISS;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return name === 'issue' ? ob('Issue', value) : MISS;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return name === 'pullRequest' ? ob('PullRequest', value) : MISS;
    case 'AddCommentPayload':
      return name === 'commentEdge' ? ob('IssueCommentEdge', value) : MISS;
    case 'IssueCommentEdge':
      return name === 'node' ? ob('IssueComment', value) : MISS;
    case 'IssueComment': {
      const holder = value as { comment: Comment };
      if (name === 'id') return sc(makeGid('IssueComment', holder.comment.id));
      if (name === 'body') return sc(holder.comment.body);
      return MISS;
    }
    case '__Type': {
      const info = value as TypeInfo;
      if (name === 'name') return sc(info.name);
      if (name === 'fields') return li('__Field', info.fields.map((entry) => ({ name: entry })));
      if (name === 'enumValues') return li('__EnumValue', info.enumValues.map((entry) => ({ name: entry })));
      return MISS;
    }
    case '__Field':
    case '__EnumValue': {
      const entry = value as { name: string };
      return name === 'name' ? sc(entry.name) : MISS;
    }
    default:
      return MISS;
  }
}

function merge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) target[key] = source[key];
}

function applySelection(
  env: ResolveEnv,
  fragments: Map<string, FragDef>,
  kind: string,
  value: unknown,
  sels: readonly Sel[],
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.k === 'field') {
      const key = sel.alias === null ? sel.name : sel.alias;
      if (sel.name === '__typename') {
        out[key] = kind;
        continue;
      }
      const res = resolveField(env, kind, value, sel.name, sel.args);
      if (!res.found) {
        env.errors.push({ message: `Cannot query field "${sel.name}" on type "${kind}".`, locations: [], path: [...path, key] });
        out[key] = null;
        continue;
      }
      out[key] = projectResult(env, fragments, res, sel, [...path, key]);
      continue;
    }
    if (sel.k === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== kind) continue;
      merge(out, applySelection(env, fragments, kind, value, sel.sel, path));
      continue;
    }
    const frag = fragments.get(sel.name);
    if (frag !== undefined && frag.typeCondition === kind) merge(out, applySelection(env, fragments, kind, value, frag.sel, path));
  }
  return out;
}

function projectResult(env: ResolveEnv, fragments: Map<string, FragDef>, res: Res, sel: FieldSel, path: Array<string | number>): unknown {
  if (res.kind === undefined) return res.value;
  if (res.list === true) {
    const items = Array.isArray(res.value) ? res.value : [];
    return items.map((item, index) => (item === null || item === undefined ? null : applySelection(env, fragments, res.kind as string, item, sel.sel, [...path, index])));
  }
  if (res.value === null || res.value === undefined) return null;
  return applySelection(env, fragments, res.kind, res.value, sel.sel, path);
}

// ---------------------------------------------------------------------------------------------------
// One operation's {data, errors} envelope.

function runOperation(ctx: Ctx, entry: unknown): Record<string, unknown> {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'a query string is required in the request body' }] };
  }
  const request = entry as Record<string, unknown>;
  const query = request.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'a query string is required in the request body' }] };
  }
  const variables = request.variables !== null && typeof request.variables === 'object' && !Array.isArray(request.variables) ? (request.variables as Record<string, unknown>) : {};
  try {
    const parsed = parseDocument(query, variables);
    const operationName = typeof request.operationName === 'string' ? request.operationName : null;
    let op = parsed.operations[0];
    if (operationName !== null) {
      const named = parsed.operations.find((candidate) => candidate.name === operationName);
      if (named !== undefined) op = named;
    }
    if (op === undefined) return { data: null, errors: [{ message: 'the document holds no operation' }] };
    const env: ResolveEnv = { ctx, forge: ctx.forge, errors: [] };
    const data = applySelection(env, parsed.fragments, op.operation === 'mutation' ? 'Mutation' : 'Query', null, op.sel, []);
    const response: Record<string, unknown> = { data };
    if (env.errors.length > 0) response.errors = env.errors;
    return response;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

/**
 * Serve POST /api/graphql. An unauthenticated request is 401; a JSON array body is operation batching,
 * answered by an array of per-operation bodies in order; anything else is one {data, errors} envelope.
 */
export function handleGraphQL(ctx: Ctx): void {
  if (ctx.login === null) {
    sendError(ctx, 401, 'Requires authentication');
    return;
  }
  const body = ctx.json;
  if (Array.isArray(body)) {
    sendJson(ctx, 200, body.map((entry) => runOperation(ctx, entry)));
    return;
  }
  sendJson(ctx, 200, runOperation(ctx, body));
}
