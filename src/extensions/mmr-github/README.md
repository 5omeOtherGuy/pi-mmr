# mmr-github

Read-only GitHub repository tools for `pi-mmr`. `mmr-github` is also the repository-provider prerequisite for the `mmr-subagents` `librarian` worker.

Package overview: [`../../../README.md`](../../../README.md). Planning: [`../../../ROADMAP.md`](../../../ROADMAP.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| Off | GitHub read/list/search/diff tools | `MMR_GITHUB_ENABLE=true`; token for search/private | `/mmr-status`, tool result `details` |

## When to use it

- Read files, directories, commit history, or diffs from GitHub without cloning.
- Let `librarian` research public or token-accessible repositories.
- Inspect private repositories already available to `MMR_GITHUB_TOKEN`.
- Keep GitHub access read-only and feature-gated.

## Status and enablement

Disabled by default. Set `MMR_GITHUB_ENABLE=true` or `mmrGithub.enabled=true` and restart Pi to register the tools.

A token is optional for public file reads/listings, but required for code search, private repositories, and higher rate limits. Tokens are read from the environment only; settings-file tokens are ignored with a warning.

## Tools

All tools are **read-only**. There is no issue, pull request, branch, or write endpoint surface.

| Tool | Purpose |
| --- | --- |
| `read_github` | Read a file with optional `read_range`, or list a directory. |
| `list_directory_github` | List directory entries; directories end with `/`. |
| `glob_github` | Match repository paths with `*`, `**`, `?`, `{a,b}`, and a validated `[...]` character-class subset. |
| `search_github` | Search code within one repository; requires a token. |
| `commit_search` | Search commit messages or list recent commits filtered by path, author, or date. |
| `diff_github` | Compare refs and return file-level stats; optionally include bounded patches. |
| `list_repositories` | Discover repositories by pattern, organization, and language. |

`diff_github` deliberately keeps a `_github` suffix to avoid colliding with unrelated tool names.

## Configuration

Non-secret settings live in Pi settings files. Secrets live in environment variables.

```json
{
  "mmrGithub": { "enabled": true }
}
```

```bash
export MMR_GITHUB_ENABLE=true
export MMR_GITHUB_TOKEN="ghp_xxx"   # optional; env only
```

| Setting | Env | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | `MMR_GITHUB_ENABLE` | `false` | Master switch for outbound GitHub access. |
| `token` | `MMR_GITHUB_TOKEN` / `GITHUB_TOKEN` | unset | Env only; required for search/private/higher limits. |
| `apiBaseUrl` | `MMR_GITHUB_API_URL` | `https://api.github.com` | Test override; GitHub Enterprise Server is not supported in this slice. |
| `requestTimeoutMs` | `MMR_GITHUB_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `maxResultBytes` | `MMR_GITHUB_MAX_RESULT_BYTES` | `200000` | Response cap; file contents have a larger bounded path before slicing. |

Settings are sampled once at extension load. Restart Pi after changing fields that gate registration.

## Behavior

### Ownership and librarian gating

`mmr-github` records its extension entrypoint path so consumers can confirm that a live GitHub tool registration belongs to this extension by source path, not just by name.

`librarian` stays `gated` until every required GitHub tool is registered and source-owned by `mmr-github`. Same-named tools from other extensions do not satisfy the gate.

### Reading large files

`read_github` fetches the whole file within GitHub's contents-API ceiling, applies `read_range` first, then gates the resulting slice at 128 KiB. If the requested slice is too large, the tool returns a clear retry-with-smaller-range error and reports the file's total line count.

Directory listings accept `limit` to bound large directories. Files larger than GitHub's inline contents-API limit are reported as too large.

### Glob matching and errors

`glob_github` uses a documented, hand-rolled matcher (no glob dependency) compiled to a single anchored, case-sensitive pattern. It supports:

- `*` — any run of characters except `/`
- `**` — any run of characters including `/`; a `**/` segment also matches zero leading path segments
- `?` — exactly one character except `/`
- `{a,b}` — brace alternation
- `[...]` — character classes restricted to ASCII letters, digits, `_`, and `.` as literal members, ascending ranges of those characters (e.g. `[a-z]`, `[0-9]`), and an optional leading `!`/`^` negation

Unsupported or malformed class syntax (an empty class, an out-of-order range such as `[z-a]`, or any other member character) is rejected with a clear glob-specific error that names the offending pattern; no internal regex error text is surfaced.

### Errors

All `mmr-github` tools intentionally **return** a normal result whose `details.error` (and text body) carries the failure message instead of throwing. This applies uniformly across the suite — invalid parameters, repository parse failures, rate limits, truncated trees, slice-too-large reads, and malformed glob input all surface as readable error-shaped results so the model can read `details.error` and adapt within the same turn. A malformed `glob_github` pattern returns the glob-syntax error described above rather than throwing.

## Safety and privacy

- Only read-only GitHub requests are exposed; mutation endpoints are not registered.
- Repository inputs accept exactly `owner/repo` or `https://github.com/owner/repo`; search, organization, and profile pages are rejected.
- `list_repositories` surfaces repositories the configured token can already access and works without a token by falling back to public search.
- Tokens are read from environment variables only and are never logged or echoed.
- Response sizes, file slices, search fragments, patches, and directory listings are bounded.

## Diagnostics and troubleshooting

- **Tools are `missing`.** `MMR_GITHUB_ENABLE` is unset or Pi was not restarted after enabling it.
- **Tools are `gated`.** The extension is known but disabled; set `MMR_GITHUB_ENABLE=true` or `mmrGithub.enabled=true` and restart.
- **`search_github` fails.** Code search requires `MMR_GITHUB_TOKEN` or `GITHUB_TOKEN`.
- **Private repo read fails.** The token is missing or does not have access to that repository.
- **`librarian` stays `gated`.** Ensure `mmr-github` tools are registered by this extension, then inspect `/mmr-status debug`.
- **Large file read fails.** Retry with a smaller `read_range`.

## Public API

Re-exported from `pi-mmr`: `createMmrGithubExtension`, settings helpers, feature-gate and tool-provider helpers, ownership predicates, tool-name constants, parser/client errors, and tool registration helpers. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

## Developer notes

- Keep GitHub tools read-only; do not add mutation endpoints to this extension.
- Keep `librarian` gating source-owned, not name-only.
- Keep tokens env-only; settings-file token handling should stay reject-with-warning.
- Update effective-surface fixtures when tool descriptions, schemas, or prompt guidelines change.
