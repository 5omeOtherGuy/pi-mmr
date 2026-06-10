# mmr-custom-subagents

Discovers project-local and global Markdown subagent definitions and, once enabled through config, registers each as a `sa__<slug>` worker tool for `pi-mmr`.

Package overview: [`../../../README.md`](../../../README.md). Public API: [`../../../docs/public-api.md`](../../../docs/public-api.md). Sibling worker extension: [`../mmr-subagents/README.md`](../mmr-subagents/README.md). Framework boundary: [`../../../docs/subagent-framework.md`](../../../docs/subagent-framework.md).

## At a glance

| Default | Provides | Requires | Diagnostics |
| --- | --- | --- | --- |
| On (loaded; no model-visible tools until you enable a subagent) | `sa__<slug>` worker tools, `/mmr-config` setup/import flow | enabled config record + valid in-scope Markdown | `/mmr-status`, `/mmr-config`, tool result `details` |

## When to use it

- You keep reusable, project-authored Markdown subagent prompts and want them exposed as Pi worker tools.
- You are migrating legacy Markdown agents and want to import them into a Pi-owned root rather than auto-load them.
- You want per-subagent, per-mode control over which custom workers are model-visible.

## Status and enablement

`mmr-custom-subagents` ships loaded but inert. It was extracted from `mmr-subagents` and is registered in `package.json` under `pi.extensions`.

- **Discovery ≠ activation.** A Markdown file under a Pi-owned root is only a *candidate*. It is not registered and not model-visible until an enabled config record references it.
- The feature-gate provider reports the `mmr-custom-subagents` gate **enabled** only when at least one custom subagent is successfully registered (an enabled record exists and its source Markdown is valid and in scope). Otherwise it stays **disabled** with the reason that the extension is loaded but no enabled custom Markdown subagents are in scope.
- Each enabled subagent registers as its record's `sa__<slug>` Pi tool at extension activation. The tool name shape is fixed by `MMR_CUSTOM_SUBAGENT_TOOL_PREFIX` (`sa__`) and built by `toMmrCustomSubagentToolName`.

## Tools / commands / surfaces

| Surface | Kind | Purpose |
| --- | --- | --- |
| `sa__<slug>` | tool (per subagent) | Runs an enabled custom Markdown subagent as a child worker. |
| `/mmr-config` → "subagent (setup/import custom)" | config flow | Scan candidates, recommend a least-privilege config, enable/import a subagent. |

The custom worker tools live in the reserved `sa__*` namespace. There is no fixed catalog — the registered tools are exactly the enabled, in-scope records.

## Configuration

Enablement is config-driven and is the privilege boundary. Records live under `mmrSubagents.custom.agents` and are merged global-then-project, with the project layer overriding by id.

- **Pi-owned roots** are the only auto-registered sources: `<cwd>/.pi/subagents` (project) and `~/.pi/agent/subagents` (global). Legacy `.claude/agents` is scanned **only** as an import candidate by the setup/import flow; it is never auto-registered.
- A record carries `enabled`, `source: { root: "global" | "project", file }`, `toolName`, `modes` scope, optional global-only `projects` scope, and the resolved `model`/`thinkingLevel`/`tools`. The record's fields win over the Markdown frontmatter.
- `toolName` must match the `sa__<slug>` shape; `source.file` must be relative with no `..` segments; reserved ids are rejected. Enabled source files are read with realpath containment under their Pi-owned root, so a symlink pointing outside the root is refused.
- **Per-mode exposure:** an enabled subagent is registered as a tool but only enters a locked mode's active set when that mode is in the record's `modes` scope, merged through `mmr-core`'s mode-extra-tool provider. A custom subagent never appears in Free mode, and the reserved `sa__*` namespace is excluded from hand-listing in the user-controlled extra-tools setting.

The `/mmr-config` setup/import flow writes these records for you: it scans Pi-owned and legacy candidates, recommends a read-only-by-default toolset, maps legacy tool aliases, blocks recursive/advisory/MCP/mutation tools, asks for modes and project scope, copies external Markdown into a Pi-owned root, and writes an enabled record.

## Behavior

### Discovery and parsing

Discovery (`discoverMmrCustomSubagents`/`parseMmrCustomSubagentMarkdown`) is hardened: scans are bounded to local-agent scale, skip symlinked roots and entries, and recheck realpath containment under the configured root before reading. A valid definition (`type: subagent`, `isolatedContext: true`, or a name+description+body) becomes an `MmrCustomSubagentDefinition`.

### Registration

At activation, enabled records are resolved, their source Markdown parsed, and the record fields overlaid to produce the final definition. Each one registers a subagent profile, a prompt builder, and the `sa__<slug>` Pi tool against the shared `mmr-subagents` framework, so custom workers reuse the same child-worker runner and prompt-assembly contract as the concrete subagents.

### Worker prompt, model, and tools

- The Markdown body is the worker system prompt. `isolatedContext: true` uses exact system-prompt replacement; otherwise the body is appended.
- `model: <route>` pins the worker route; `model: inherit` (or an omitted `model`) forwards the parent model so parent spawn and child activation agree.
- `thinkingLevel` (aliases `thinking`/`effort`) pins a provider-neutral canonical Pi level; vendor-specific aliases are not accepted.
- `tools` names exact Pi tools, intersected with the parent-active registered set before being passed to the child. When no tools field is declared, a fixed standard toolset is used (rather than "all registered tools") so parent and child resolve the same set; an explicitly empty list runs a prompt-only worker.

### Import

`custom-import.ts` is the pure import planner used by the flow: it maps source tool names onto safe Pi names, blocks recursive/advisory/MCP/mutation tools, flags unknown tools and unavailable declared models, and recommends a least-privilege read-only toolset when a source declares none. When legacy `.claude/agents` candidates exist but nothing is enabled, a one-time-per-session notice points the user at the setup/import flow; there is no switch that silently restores legacy auto-loading.

## Diagnostics and troubleshooting

- **My subagent tool is missing.** Discovery is not activation. Confirm an enabled `mmrSubagents.custom.agents.<id>` record references the file and that the source Markdown is valid and in a Pi-owned root. The feature gate stays disabled until at least one registers.
- **The tool exists but is not callable in this mode.** The record's `modes` scope does not include the current locked mode, or the mode is `free` (custom subagents never appear in Free mode).
- **A record was refused.** `toolName` did not match `sa__<slug>`, `source.file` was not a clean relative path, an id was reserved, or the source file failed realpath containment under its Pi-owned root.
- **Legacy agents are not loading.** `.claude/agents` is import-only. Run `/mmr-config` → "subagent (setup/import custom)" to import them into a Pi-owned root and write an enabled record.

## Public API

Stable re-exports from `pi-mmr`. Canonical catalog: [`../../../docs/public-api.md`](../../../docs/public-api.md).

Extension and provider surface:

- `createMmrCustomSubagentsExtension(overrides?)`, `MmrCustomSubagentsFactoryOverrides`.
- `createMmrCustomSubagentsFeatureGateProvider(...)`, `createMmrCustomSubagentsToolProvider(...)`, `MmrCustomSubagentsCapabilities`.
- `MMR_CUSTOM_SUBAGENTS_FEATURE_GATE`, `MMR_CUSTOM_SUBAGENTS_PROVIDER_NAME`.

Loader surface:

- `discoverMmrCustomSubagents`, `parseMmrCustomSubagentMarkdown`, `toMmrCustomSubagentToolName`, `normalizeMmrCustomSubagentToolPatterns`.
- Constants `MMR_CUSTOM_SUBAGENT_TOOL_PREFIX`, `MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH`, `MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES`, `DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_SCAN_DEPTH`.
- Types `MmrCustomSubagentDefinition`, `DiscoverMmrCustomSubagentsArgs`, `ParseMmrCustomSubagentMarkdownArgs`.

## Developer notes

- Config is the enablement boundary by design: it keeps a fresh install from inheriting a harness's broad subagent set and preserves least privilege. Do not reintroduce auto-loading of legacy roots.
- Custom workers route through the shared `mmr-subagents` framework (profile + prompt builder + child-worker runner). Do not hard-code an independent runner or prompt path here.
- The tool provider claims only the reserved `sa__*` namespace and returns `undefined` for everything else, so it never shadows `mmr-core`, `mmr-subagents`, or user aliases.
- Discovery and enabled-record reads enforce realpath containment under Pi-owned roots and refuse symlink escapes; no custom-subagent state is written inside the workspace beyond config records. Durable conventions: [`../../../docs/data-storage-conventions.md`](../../../docs/data-storage-conventions.md).
