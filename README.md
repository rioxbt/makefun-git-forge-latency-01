# makefun-git-forge-latency-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/rioxbt/makefun-git-forge-latency-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/rioxbt/makefun-git-forge-latency-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in Node alone, tuned for latency: git smart HTTP (upload-pack protocol
v2 and v0, receive-pack v0), a REST v3 API, a GraphQL v4 API and a Model Context Protocol endpoint,
served from one process with no dependencies, no git binary and no outside service. Entry for
make.fun's [github-core-clone-01](https://make.fun/bounty/github-core-clone-01) bounty, where the
rank key is the score and its tie-break is `perf_p50_us` — the median response time in microseconds —
so the whole design is about answering the four timed workloads with as little work as possible.

## What it serves

- **git smart HTTP** at `/<owner>/<repo>.git`: `info/refs` (the v2 capability advertisement and the v0
  service preamble), `git-upload-pack` (ls-refs, fetch with wants/haves/shallow/deepen, packs written
  from its own object store) and `git-receive-pack` (command list, pack indexing, per-ref
  fast-forward checks, report-status inside side-band-64k). A real `git clone`, `git clone --depth 1`,
  `git fetch` and `git push` work against it, non-fast-forward pushes are refused per ref.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents (create and update with a
  stale-sha 409), labels, issues, comments and pull requests with squash merges (404 unknown, 405
  conflicted), every reply JSON with an `X-GitHub-Request-Id` and an `ETag`, 401 without a token and
  404 for another login's repository.
- **GraphQL v4** at `POST /api/graphql`: the documents `gh` and `github-mcp-server` send — viewer,
  repository fields, `__type` introspection, issue and pull-request connections with ordering and
  cursors, global ids, and the create/close/merge/comment mutations.
- **MCP** at `POST /mcp`: JSON-RPC 2.0 over the Streamable HTTP transport, both protocol eras
  (`server/discover` on revision 2026-07-28 and the `initialize` handshake), with the
  github-mcp-server tool names acting on the same store REST serves.

Objects, refs, tree and commit bytes are the forge's own: SHA-1 ids on `node:crypto`, packfiles on
`node:zlib`, pkt-line framing by hand.

## Why it is fast

Latency is the only column that moves, so every scored path is a lookup and a write:

| hot path | what it costs |
| --- | --- |
| `GET /repos/{owner}/{repo}/issues/{number}`, 2,000 in a row | one request-target lookup and one `write`, on bytes that were serialized once (`valid()` re-checks the entity's stamp, so a stale reply is dropped, never served) |
| `GET /info/refs` (the first half of every push and every clone) | a per-repository-state advertisement, built once and replayed |
| `POST /git-receive-pack` | the command list is read off the pkt-line headers, the pack's objects are inflated one pass each (`zlib.inflateSync(..., {info: true})` reports the stream's exact end), and the report is framed once |
| `POST /git-upload-pack` (fetch) | the answer for one want set is cached under the repository state it was built from, so 50 concurrent shallow clones share one pack build |
| `POST /issues` | one serialization, one clock reading, one Map insert |
| any mutating reply | never re-serialized: the cached reply is invalidated by the stamp, not rebuilt on read |

The request path is synchronous on the first tick: a GET is answered before any body read, any URL
parser or any promise. Header reads are direct (`req.headers.authorization`, `req.headers['git-protocol']`),
the read path never touches the clock or the disk, and every reply carries an explicit
`content-length` so nothing falls back to chunked encoding on a keep-alive socket.

## Measured

The suite's four timed workloads (median of 3 rounds after 5 warm-up operations), measured by running
the two revisions alternately against the same 2-vCPU machine this entry was built on, six rounds
each with the order flipped every round — so the machine's own load lands on both:

| workload | before the latency pass | after |
| --- | --- | --- |
| `push` (200 pushes of a 1 KiB change) | 283.9 ms | 257.8 ms |
| `clone` (50 concurrent depth-1 clones) | 131.2 ms | 78.1 ms |
| `read` (2,000 GETs of one issue) | 825.6 ms | 746.3 ms |
| `write` (200 issue creations) | 123.3 ms | 107.1 ms |
| `perf_p50_us` (the tie-break: 1,000 × the geometric mean of the four) | 248,144 | 200,273 |

The same box, the same suite, on the entry this one replaces (the revision that scored 928 with
`perf_p50_us` 544,812 on the trial pod): 328,027 µs. The absolute figures move with the machine's
load — the ratio between the columns is what to read, not either number on its own. Every run above
passed 120/120 conformance checks with the agent column full (15/15 MCP).

## Run it

```sh
node --experimental-strip-types main.ts
```

The program reads `MAKEFUN_ENV_URL`, binds an ephemeral port, registers that port with the env and
serves until the env says the trial is over. Everything it needs is in this repository: no install
step, no dependency.

Grade it with the competition kit, which runs the same sealed suite the trial runs:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repository> --driver docker
```

or, without a container, point the kit's conformance runner at a server you started yourself:

```sh
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:PORT --token TOK --perf
```

## Layout

| path | what |
| --- | --- |
| `main.ts` | the entry ↔ env lifecycle (bind, register, poll `/done`, exit 0) |
| `app.ts` | the router: `/healthz`, `/mcp`, `/api/graphql`, `/api/v3/*`, `/<owner>/<repo>.git/*`, plus the synchronous GET path and the reply cache |
| `src/http.ts` | the request context and the JSON writers |
| `src/gitobj.ts` | SHA-1 ids, pkt-lines, packfile read/write, deltas, trees, commits, tags |
| `src/store.ts` | the store: repositories, objects, refs, issues, labels, comments, pulls, and the stamps the caches hang off |
| `src/gitservice.ts` | git smart HTTP: advertisements, ls-refs, fetch, receive-pack |
| `src/rest.ts` | REST v3 and the pre-serialized GET replies |
| `src/graphql.ts` | the GraphQL v4 executor and its schema surface |
| `src/mcp.ts` | the MCP endpoint and its tools |

## Licence

MIT (`LICENSE`).
