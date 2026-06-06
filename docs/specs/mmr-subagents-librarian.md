# mmr-subagents librarian behavioral specification

Status: implemented with the `mmr-github` read-only repository provider. Non-GitHub repository-provider variants are deferred.

## Purpose and scope

`librarian` is a standalone `mmr-subagents` worker for researching remote repositories and repository history. It is for code outside the local workspace: architecture explanations, feature tracing, file/directory inspection, commit history, and ref diffs.

`librarian` complements the other workers:

- `finder` — local workspace search only.
- `oracle` — advisory planning, review, and debugging across supplied context.
- `Task` — bounded implementation or investigation worker.
- `librarian` — remote repository research using read-only GitHub tools.

## Non-relaxable invariants

- No MCP: `allowMcp: false`.
- No toolbox: `allowToolbox: false`; no `apply_patch`, `task_list`, local edit, or shell tools.
- No local workspace mutation or local workspace search.
- No parent-prompt inheritance. The worker is standalone and receives only its assembled worker system prompt and first user message.
- The `mmr-core` profile is the source of truth for prompt route, safety flags, and tool allowlist policy.
- Model/thinking overrides must flow through `mmrCore.subagentModelPreferences.librarian` or the resolver test seam so parent and child routes stay aligned.
- Activation failures fail closed before spawning a worker.

## Subagent profile

The profile lives in [`src/extensions/mmr-core/subagent-profiles.ts`](../../src/extensions/mmr-core/subagent-profiles.ts).

```ts
{
  name: "librarian",
  displayName: "Librarian",
  modelPreferences: [
    { model: "claude-opus-4-6" },
    { model: "gpt-5.4" },
  ],
  thinkingLevel: "medium",
  tools: [
    "read_github",
    "list_directory_github",
    "glob_github",
    "search_github",
    "commit_search",
    "diff_github",
    "list_repositories",
  ],
  promptRoute: "standalone",
  promptBuilder: "librarian",
  allowMcp: false,
  allowToolbox: false,
  enforceLockedMode: false,
  persistSubagentState: false,
}
```

## Tool surface

Pi tool name: `librarian`.

Schema:

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "description": "Specific remote-repository research question. Name the repository when you know it; include the feature, API, file, commit, branch, or architecture area you want explained; and state what a complete answer should prove."
    },
    "context": {
      "type": "string",
      "description": "Optional background that helps scope the research: why the answer is needed, relevant branch/revision, known files, related repositories, constraints, or prior findings. Do not put secrets or credentials here."
    }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

Input composition:

- Trim and validate `query` as a non-empty string.
- Validate optional `context` as a string.
- Compose the worker's first user message as `Context: ...\n\nQuery: ...` when context is present; otherwise `Query: ...`.

## Activation and gating

`librarian` resolves to one of these states:

| State | Condition | `/mmr-status` |
| --- | --- | --- |
| `active` | Required GitHub tools are registered and source-owned by `mmr-github` | active via `mmr-subagents`; candidates include `librarian` |
| `gated` | `mmr-github` is disabled, missing, or the tools are not source-owned | gated via `mmr-subagents` with reason |
| `deferred` | Future non-GitHub repository provider is requested | deferred through that future provider |

Gating reason:

```text
librarian: requires mmr-github read-only GitHub tools (set MMR_GITHUB_ENABLE=true).
```

The parent gate checks registration and source ownership rather than parent-active mode tools because the GitHub tools are provider tools activated by the worker profile, not user-facing mode tools.

## Worker tools

The worker can use only the read-only GitHub tools owned by `mmr-github`:

| Tool | Purpose |
| --- | --- |
| `read_github` | Read files or list directories. |
| `list_directory_github` | List directory entries. |
| `glob_github` | Match repository paths. |
| `search_github` | Search code in a repository; token required. |
| `commit_search` | Search/list commits. |
| `diff_github` | Compare refs and optional bounded patches. |
| `list_repositories` | Discover token-accessible and public repositories. |

The worker must not expose shell, local file, web, MCP, or mutation tools.

## System prompt assembly

The worker uses `assembleMmrSubagentSurface` with:

- `profile: getMmrSubagentProfile("librarian")`
- `baseSystemPrompt: ""`
- `activeToolManifest`: the source-owned GitHub tool allowlist
- `systemPromptDelivery: "replace"`

The concrete prompt builder lives in [`src/extensions/mmr-subagents/prompts.ts`](../../src/extensions/mmr-subagents/prompts.ts) and is registered through `registerMmrSubagentsPromptBuilders()`.

Prompt rules:

- No user-provided value (`query`, `context`) is interpolated into the system prompt.
- No tokens or credentials appear in the system prompt.
- The prompt describes read-only GitHub repository research and forbids local workspace work.

## Runner integration

Execution flow:

1. Validate params; on failure return `validation-error`.
2. Resolve `cwd` from `ctx.cwd ?? process.cwd()`.
3. Check GitHub prerequisites with source-ownership; on failure return `provider-gated` with the gating reason and do not spawn.
4. Resolve subagent model/thinking/tool policy through `resolveMmrSubagentInvocation` with the `librarian` profile.
5. Assemble the exact worker system prompt.
6. Invoke `runMmrSubagentWorker` with `profileName: "librarian"`, the composed first user message, resolver-selected model, the GitHub tool allowlist, and `systemPromptDelivery: "replace"`.
7. Forward progress and return the worker's final message plus structured `LibrarianDetails`.

## Status mapping

`LibrarianDetails.status` uses:

- `success`
- `validation-error`
- `provider-gated`
- `activation-error`
- `context-window-exhausted`
- `aborted`
- `spawn-error`
- `worker-error`
- `empty-output`

A clean exit before the agent loop is normalized to `worker-error`. Activation-failure stderr markers are converted into `activation-error` even if Pi exits 0.

## Public API expectations

Package-root exports include the librarian tool factory/registration helpers, constants, prompt/schema helpers, details/status types, GitHub prerequisite checker, and gating reason. Canonical API catalog: [`../public-api.md`](../public-api.md).

## Tests and fixtures

Coverage should include:

- schema validation;
- provider gating and source-ownership checks;
- route-selection failure;
- subprocess failure and cancellation;
- output truncation;
- prompt/worker-tool surface fixtures;
- child activation failure when GitHub tools are not source-owned by `mmr-github`.

## Open follow-ups

- Non-GitHub repository providers.
- Richer repository-provider selection if multiple providers become active.
- Additional diagnostics when a token is missing for search/private repositories.
