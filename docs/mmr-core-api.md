# `mmr-core` public API

**Audience.** Developers writing extensions against `mmr-core`, or packages depending on `pi-mmr`'s core runtime.

**Scope.** The stable programmatic surface that `mmr-core` exposes: runtime singletons, mode/state types, prompt-assembly contract, tool/feature-gate registry, subagent contracts. Non-core extension exports live in [`public-api.md`](./public-api.md).

**Related.** Extension overview: [`../src/extensions/mmr-core/README.md`](../src/extensions/mmr-core/README.md). Documentation conventions: [`documentation-style-guide.md`](./documentation-style-guide.md).

Anything not listed here is internal and may change without warning. The contract has two import paths:

- **Package root** — `import { ... } from "pi-mmr"` (resolves to
  `src/index.ts`). Use this in production code.
- **Extension subpath** — `import { ... } from "pi-mmr/extensions/mmr-core"`
  (resolves to the extension entry point). Use this only when wiring
  the extension into a Pi package manifest.

Internal modules under `pi-mmr/src/extensions/mmr-core/<file>` are not
part of the public contract; only the names re-exported from the
package root are stable.

## Public principles

1. **No mutable singleton in the surface.** The runtime keeps a single
   piece of state for the active MMR mode and one tool/feature-gate
   registry chain. Callers can read snapshots and register providers
   through stable functions, but the singleton object itself is not
   exported.
2. **Snapshot read APIs return deep-cloned snapshots.** Functions
   suffixed with `Snapshot` (and the `onMmrStateChanged` event helper)
   hand callers their own deep clone, safe to keep or mutate.
   `getMmrModeState` returns the runtime's own object and must be
   treated as read-only. Raw `MMR_EVENT_STATE_CHANGED` payloads are
   shared snapshots reused across subscribers for one emission, also
   read-only.
3. **Provider chains, latest wins.** Tool and feature-gate providers
   register into ordered chains; later registrations override earlier
   ones. Tool resolution is identity-only: a requested name activates
   when Pi has registered a tool with exactly that name and either a
   provider claims it `active` or no provider claims it and the live
   inventory match wins; the exact-name status catalog credits the
   owning extension when a tool is deferred.
4. **Diagnostics, not opaque strings.** Policy issues are returned as
   structured `MmrPolicyDiagnostic[]` records with stable `code` values.
   The human-readable `message` field is what `/mmr-status` and the
   activation notification's "Warnings:" block render verbatim.
5. **Free mode is opt-out.** When the active mode is `free`, mmr-core
   does not enforce model/thinking/request/prompt/tool resolution and emits
   no policy diagnostics.

## Modes

```ts
import { DEFAULT_MMR_MODE, MMR_MODE_KEYS, MMR_MODES, getMmrMode, isMmrModeKey } from "pi-mmr";
import type { MmrModeDefinition, MmrModeKey } from "pi-mmr";
```

- `MMR_MODE_KEYS`: ordered tuple `("smart", "smartGPT", "rush", "large", "deep", "free")`.
- `MMR_MODES`: read-only mode table.
- `getMmrMode(key)`: returns the `MmrModeDefinition` for a key.
- `isMmrModeKey(value)`: type guard for incoming user/session strings.
- `DEFAULT_MMR_MODE`: `"smart"`.

## Mode state

```ts
import { getMmrModeState, getMmrModeStateSnapshot } from "pi-mmr";
import type { MmrModeState } from "pi-mmr";
```

- `getMmrModeStateSnapshot()` — **preferred for new code.** Returns a
  deep-cloned copy that callers may keep, mutate, or pass to other code
  paths.
- `getMmrModeState()` — legacy live read. Returns the runtime's own
  state object; **must not be mutated**. Kept exported for backward
  compatibility with callers that only read scalar fields like
  `state.mode`. New consumers should use the snapshot variant instead.

`MmrModeState.effectiveContextWindow`, `effectiveMaxOutputTokens`, and
`effectiveMaxInputTokens` are runtime-only hints for the active mode's
context profile after provider-size clamping. `undefined` means no MMR
override for that dimension (use the selected provider's registered
behavior). These values are not persisted and are never written to provider
payloads. mmr-core passes the selected registry model directly to
`pi.setModel(...)`; Pi-native auto-compaction follows the selected provider
route's registered model metadata. Only `smart` (268k max-input under its
300k profile) and `large` (968k under its 1M profile) carry an MMR context
profile before provider-size clamping; the GPT/Codex-primary modes
(`smartGPT`, `rush`, `deep`) and `free` carry no MMR context override and run
at the selected provider's registered window.

`MmrModeState.baselineCaptured` / `baselineModel` are runtime-only
status diagnostics. They show whether mmr-core has a pre-MMR restore
snapshot and the provider/model id when known. They are not persisted
and never include auth material.

`setMmrModeState` is intentionally **not** exported from the package
root. Only the `mmr-core` extension itself updates the runtime state.

## Tool resolution

```ts
import {
  registerMmrToolProvider,
  resolveMmrTools,
  isToolAllowed,
} from "pi-mmr";
import type { MmrToolProvider, MmrToolResolution, MmrToolRule } from "pi-mmr";
```

- `registerMmrToolProvider(provider)` — register an extension-owned
  status provider. Provider order is latest-wins. A provider claims
  ownership for the exact tool names it owns and reports `active`,
  `gated`, `disabled`, or `deferred`.
- `resolveMmrTools(modeKey, availableTools)` — synchronously resolve
  the active/missing/deferred/gated/disabled tool lists for a mode
  against a Pi-tool inventory.
- `isToolAllowed(toolName)` — quick check against the current state's
  `activeTools`.

Resolution is **identity-only**. A requested tool name activates iff a
provider claims it as `active` AND a Pi tool with that exact name is
registered, OR no provider claims it AND a Pi tool with that exact
name is registered. There are no aliases or candidate fallbacks: modes,
profiles, subagents, and user tool allowlists must use the exact Pi
tool name they want activated.

`MmrToolRule` kinds: `active`, `deferred`, `gated`, `disabled` (see
`src/extensions/mmr-core/types.ts`). A provider returns `undefined`
for names it does not own; the registry then walks lower-priority
providers and finally falls back to the exact-name status catalog
(`DEFAULT_TOOL_CATALOG`) plus identity match against the live Pi
inventory.

The acceptance contract: a future module can call
`registerMmrToolProvider(...)` once at extension load and have the
next mode resolution include its rules without ordering constraints.

## Worker-tool model resolution

```ts
import { selectMmrModelRoute, resolveAndApplyMmrModel } from "pi-mmr";
import type {
  MmrModelPreference,
  MmrModelRouteSelection,
  MmrRegisteredModelLike,
  MmrModelRegistryLike,
  ResolveAndApplyMmrModelArgs,
  SelectMmrModelRouteArgs,
} from "pi-mmr";
```

- `selectMmrModelRoute({ modelPreferences, modeThinkingLevel?, registry })`
  — synchronous, **non-mutating**. Picks the highest-priority
  registered + authenticated provider/model from a preference list.
  Use this from worker tools (subagents, oracle, librarian, etc.) that
  need their own route without changing Pi's currently active model.
  Returns `{ selected?, candidates }` where `selected` carries the
  chosen `provider`, `model`, `thinkingLevel`, and the underlying
  registered model object; `candidates` is the full list of considered
  routes with skip reasons.
- `resolveAndApplyMmrModel(args)` — async, **mutating**. Used by the
  `mmr-core` extension itself to apply the selected route via Pi's
  `setModel`. It enumerates the same candidate list as
  `selectMmrModelRoute` and iterates until Pi accepts a route.

Worker tools should never call `resolveAndApplyMmrModel`.

## Feature gates

```ts
import {
  createMmrFeatureGateRegistry,
  registerMmrFeatureGateProvider,
  resolveMmrFeatureGates,
} from "pi-mmr";
import type {
  MmrFeatureGateDecision,
  MmrFeatureGateProvider,
  MmrFeatureGateProviderDecision,
  MmrFeatureGateRegistry,
} from "pi-mmr";
```

- `registerMmrFeatureGateProvider(provider)` — push a provider onto
  the runtime registry. Later registrations take precedence.
- `resolveMmrFeatureGates(gates)` — runtime-bound resolver. Always
  reflects providers added through
  `registerMmrFeatureGateProvider`. Built-in providers
  `mmr-core.reserved` (named-reason missing for known names) and
  `mmr-core.unknown` (terminal catch-all) always sit below registered
  providers.
- `createMmrFeatureGateRegistry()` — build a fresh, isolated registry
  with only the two built-ins. Useful for tests and ad-hoc
  decisions; this registry does not see runtime registrations.

A provider returns `MmrFeatureGateProviderDecision` (no `source`); the
runtime tags decisions with the producing provider name.

## Subagent profiles

```ts
import {
  MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX,
  extractExplicitWorkerCliFlags,
  extractMmrSubagentActivationFailure,
  getMmrSubagentProfile,
  getMmrSubagentState,
  listMmrSubagentProfiles,
  resolveMmrSubagentInvocation,
} from "pi-mmr";
import type {
  ExplicitWorkerCliFlags,
  MmrSubagentBaseMode,
  MmrSubagentInvocation,
  MmrSubagentInvocationFail,
  MmrSubagentInvocationOk,
  MmrSubagentProfile,
  MmrSubagentPromptRoute,
  MmrSubagentResolveCode,
  MmrSubagentResolveDiagnostic,
  MmrSubagentState,
  MmrSubagentToolResolution,
  ResolveMmrSubagentInvocationArgs,
} from "pi-mmr";
```

Subagent workers run as a dedicated, non-locked execution route in a
child Pi process, activated through the `--mmr-subagent <name>` CLI
flag. A subagent profile is the single source of truth for that
worker's model preferences, thinking level, tool allowlist, and prompt
route. Activation never captures or restores a Pi baseline, never
emits `MMR_EVENT_STATE_CHANGED`, never persists `mmr-core.mode-state`,
never applies locked-mode prompt templates / request policy / Free-mode
tool restoration, and never injects MMR-owned tools beyond the profile
allowlist.

- `getMmrSubagentProfile(name)` — look up a registered
  `MmrSubagentProfile` by name. Returns `undefined` for unknown or
  empty names. Profiles are deep-frozen at module load.
- `listMmrSubagentProfiles()` — enumerate registered profile names in
  stable order.
- `resolveMmrSubagentInvocation({ profile, registry, parentMode?, registeredTools?, parentActiveTools?, explicitModel?, explicitTools?, modelPreferencesOverride?, invocationContext? })`
  — single public resolver for parent spawn and child activation. Picks
  the first registered + authenticated provider/model from the profile's
  preferences via `selectMmrModelRoute`, then layers on subagent-specific
  policy:
  - resolves `promptBaseMode` from `profile.baseMode` (concrete mode key,
    or `from-parent` aliased through `deep → smart`);
  - computes the effective `workerTools` as
    `(profile.tools \ profile.denyTools) ∩ registeredTools`;
  - fails closed when `profile.tools.length > 0` collapses to an empty
    `workerTools` (intentional `tools: []` profiles pass through);
  - applies `profile.modeModelPreferences[promptBaseMode ?? parentMode]`
    when present so mode-derived workers can use parent-mode-specific
    routes while preserving prompt-base aliases such as `deep → smart`;
  - validates any caller-supplied `explicitModel` against the resolved
    route and `explicitTools` against `workerTools` order-independent;
  - forwards `modelPreferencesOverride` for settings-driven Task model preferences
    overrides without mutating `profile.modelPreferences`.

  Returns `MmrSubagentInvocationOk` on success (with `modelArg`,
  `workerTools`, `toolResolution`, and `promptBaseMode`) or
  `MmrSubagentInvocationFail` with a stable failure code on rejection.
  Never mutates caller state.

  `invocationContext` identifies which side of the parent/child boundary
  is calling. It is a caller-identity marker, not a safety toggle, and
  does not loosen deny-list, tool intersection, model route, or
  explicit-tools validation:

  - `"parent-spawn"` (default) — the parent (Task tool, or any future
    parent that spawns a worker through this resolver) is computing the
    invocation. A missing or `"free"` `parentMode` on a `from-parent`
    profile fails closed with `prompt-base.unresolved` because the
    parent owns prompt assembly and cannot build a worker system prompt
    for an unresolved mode.
  - `"child-activation"` — the child Pi process (`applySubagentProfile`)
    is validating its CLI flags. The parent already delivered the
    worker system prompt via `--system-prompt` before spawning. When the
    runner supplied `--mmr-parent-mode`, the child uses that mode for
    parent-mode-specific worker routes; when it is absent, the resolver
    returns `promptBaseMode: undefined` for missing parent modes instead
    of failing closed and uses the profile's default preferences. All
    other validation (model route, deny set, registered-tool
    intersection, explicit-tools equality) still runs.

  The `toolResolution` field carries the deny-aware, registered-tool

  observability detail (`intendedTools`, `deniedTools`, `registeredTools`,
  `parentActiveTools`, `omittedTools`) so consumers can render
  `/mmr-status`-style breakdowns of what the worker actually got.
- `extractExplicitWorkerCliFlags(argv)` — pure helper that pulls
  explicit `--model`, `--tools`, and `--mmr-parent-mode` values out of a
  Pi-style argv slice (`process.argv.slice(2)`) so activation can
  distinguish runner-supplied flags from Pi's own default/restored model
  and validate parent-mode-specific model preferences. Supports `--flag <value>`,
  `--flag=<value>`, and the `--tools` short alias `-t`.
- `getMmrSubagentState()` — returns the current process-singleton
  `MmrSubagentState | undefined`. Non-empty inside a subagent worker
  after `session_start`; `undefined` in every normal session.
  `before_provider_request`, `before_agent_start`, `tool_call`,
  `model_select`, and `thinking_level_select` consumers can use this
  to early-return so they do not apply locked-mode policy to worker
  turns.

Stable resolver failure codes:

| Code                     | When                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `model.no-route`         | None of the profile's `modelPreferences` resolved to a registered + authenticated provider route. |
| `model.mismatch`         | An explicit `--model` value on the worker argv does not match the profile-resolved route.         |
| `tools.mismatch`         | An explicit `--tools` value on the worker argv does not match the resolved `workerTools` set.     |
| `tools.empty`            | `profile.tools` is non-empty but the deny-aware, registered-tool intersection collapses to empty. |
| `prompt-base.unresolved` | A `from-parent` profile was resolved with `invocationContext: "parent-spawn"` and no `parentMode`. |

Fail-closed startup signaling (mmr-core writes; runner reads):

- `MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX` — stable marker that
  the child Pi process writes to its own stderr (`pi-mmr: subagent
  activation failed: <reason>`) when subagent activation rejects.
- `extractMmrSubagentActivationFailure(stderr)` — pure parser that
  returns the trimmed reason from the last marker occurrence, or
  `undefined` when no marker is present. The runner in `mmr-subagents`
  uses this to convert the marker into an unmissable hard failure
  even when Pi itself exits 0 (Pi currently does not propagate
  extension `session_start` throws into a nonzero exit code).

Subagent profiles are an `mmr-core` concept; concrete subagent worker
tools live in `mmr-subagents` and use these APIs to drive the child
worker. New profiles are registered by editing
`extensions/mmr-core/subagent-profiles.ts`; the table is intentionally
not user-extensible at runtime.

## Prompt route

```ts
import { getMmrPromptRoute } from "pi-mmr";
import type { MmrPromptRoute } from "pi-mmr";
```

- `getMmrPromptRoute(modeKey)` — returns `"default" | "rush" | "deep"`.
  Prompt-aware extensions branch on this rather than reading mode
  definitions or `MmrModeState.promptRoute` directly through internal
  modules.

## Policy diagnostics

```ts
import { getMmrPolicyDiagnostics } from "pi-mmr";
import type {
  MmrPolicyDiagnostic,
  MmrPolicyDiagnosticCode,
  MmrPolicyDiagnosticSeverity,
} from "pi-mmr";
```

- `getMmrPolicyDiagnostics(state)` — returns a list of structured
  policy diagnostics for an `MmrModeState`. Free mode always returns
  `[]`. The set of stable codes is:

| Code                       | When                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `model.not-applied`        | Locked mode resolved with no usable model (no auth or no candidates).                |
| `model.fallback-applied`   | Active model is not the first preference in the mode's preference list.              |
| `tools.none-active`        | Active tool set is empty.                                                            |
| `tools.missing`            | Some logical tools could not be resolved to an active Pi tool.                       |
| `tools.gated`              | Logical tools are gated behind an off feature gate.                                  |
| `tools.disabled`           | Logical tools were administratively disabled.                                        |
| `availability`             | One per `mode.availabilityNotes` entry (e.g. "subagents not yet shipped").           |

Each diagnostic has `code`, `severity`, `source: "mmr-core"`, and a
human-readable `message`. Some carry a small `data` payload (for
example `tools.missing` includes `{ tools: [...] }`). `/mmr-status`
renders `message` verbatim, joined by `; `. The activation notification
renders the same messages as warning bullets, then appends per-decision
diagnostics for any deferred tools.

## Event bus

```ts
import { MMR_EVENT_STATE_CHANGED, onMmrStateChanged } from "pi-mmr";
import type { MmrEventBusHost, MmrStateChangedHandler } from "pi-mmr";
```

The `mmr-core` extension emits `MMR_EVENT_STATE_CHANGED`
(`"mmr-core:state-changed"`) on `pi.events` whenever the active MMR
mode state is replaced (mode switch, free-mode opt-out, native control
fallback). The payload is a deep-cloned `MmrModeState` snapshot, or
`undefined` when state was cleared.

Pi's event bus fans the **same** payload object out to every subscriber
for a given emission. That means raw `pi.events.on(...)` handlers share
the payload and must treat it as read-only:

```ts
// Read-only: payload is shared across all listeners for this emission.
pi.events.on(MMR_EVENT_STATE_CHANGED, (state) => {
  console.log("mode is now", (state as MmrModeState | undefined)?.mode);
});
```

For handlers that need a payload they can keep or mutate, use the
`onMmrStateChanged` helper, which deep-clones the snapshot per
invocation:

```ts
// Per-invocation deep clone: each handler call gets its own payload.
onMmrStateChanged(pi, (state) => {
  if (state) state.activeTools.push("local-only"); // safe; isolated copy
});
```

The event bus is a notification channel only; it does not support
request/response. For queries, use the read APIs above.

## Persisted state

```ts
import { MMR_MODE_STATE_ENTRY, findLatestPersistedModeState } from "pi-mmr";
import type { MmrModeState } from "pi-mmr";
```

- `MMR_MODE_STATE_ENTRY` — the `customType` string used for persisted
  session entries (`"mmr-core.mode-state"`).
- `findLatestPersistedModeState(entries)` — locate the most recent
  valid persisted mode state; rejects malformed/future-version
  records. Currently versioned at `1`.

Other extensions should treat persisted state as **read-only**: do not
write `mmr-core.mode-state` entries from outside `mmr-core`.

## Additional exported helpers

The package root re-exports a few lower-level helpers used by tests,
the `mmr-core` extension's own setup, and adjacent tooling. They are
exposed for completeness; new extensions should prefer the stable APIs
above unless they have a specific reason to use these.

- `createMmrCoreRuntime(toolRegistry?, featureGateRegistry?)` — build
  an isolated runtime instance with its own state and registries.
  Useful for tests. Not the singleton used by the running extension.
- `createMmrFeatureGateRegistry()` / `createMmrToolRegistry(initialAliases?)`
  — build standalone registries. Registrations on these instances do
  not affect the runtime singleton.
- `loadMmrCoreSettings(cwd)` — read MMR settings from Pi's normal
  settings files (`~/.pi/agent/settings.json`, `.pi/settings.json`).
- `resolveMmrModeSelection({ flagValue, persistedMode, settingsMode, defaultMode })`
  — pick a mode from the documented precedence chain (flag → persisted
  session → settings → default).
- `resolveMmrModel(modeKey)` — build an empty `MmrModelResolution`
  scaffold for a mode's preferences. Used by `createMmrCoreRuntime`
  consumers; most callers should use `selectMmrModelRoute` or
  `resolveAndApplyMmrModel`.
- `resolveMmrToolNames(requestedTools, availableTools, extraAliases?)`
  — module-level tool resolution against a fresh registry; bypasses
  the runtime singleton's registered providers.
- `isMmrToolAllowed(toolName, resolution)` — stateless check against a
  pre-resolved `MmrToolResolution`. Use `isToolAllowed` for the
  current runtime state.
- `buildMmrPromptLayer(context)`, `MMR_PROMPT_LAYER_START`,
  `MMR_PROMPT_LAYER_END` — the prompt assembly helper used by the
  `mmr-core` extension's `before_agent_start` hook, plus legacy
  delimiter constants. Not currently emitted around the rendered
  prompt; kept exported for downstream tooling that searched on them.

## What is intentionally not exported

- The runtime singleton object itself (`mmrCoreRuntime` / equivalent).
- `setMmrModeState` (only `mmr-core` updates the runtime).
- `setMmrSubagentState` (only `mmr-core` updates subagent activation
  state; readers use the exported `getMmrSubagentState`).
- Raw mutable registries (`getMmrToolRegistry`,
  `getMmrFeatureGateRegistry`).
- Any helper not re-exported from `src/index.ts`.

If you find yourself reaching past the public surface, open an issue
proposing a new stable API rather than depending on internals.
