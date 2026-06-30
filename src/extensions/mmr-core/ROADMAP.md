# mmr-core roadmap

This roadmap covers the `mmr-core` extension: locked modes, model
resolution, tool registry, prompt assembly, diagnostics, and shared
contracts for sibling extensions. Cross-cutting concerns (release plan,
public-safety checklist, planned-but-not-yet-implemented extensions) live
in the top-level [`../../../ROADMAP.md`](../../../ROADMAP.md).

Sibling extension roadmaps:

- [`../mmr-toolbox/ROADMAP.md`](../mmr-toolbox/ROADMAP.md)
- [`../mmr-web/ROADMAP.md`](../mmr-web/ROADMAP.md)
- [`../mmr-subagents/ROADMAP.md`](../mmr-subagents/ROADMAP.md)

## Current baseline

`mmr-core` provides the locked-mode spine:

```text
selected mode → resolved model/thinking → active tools → system prompt note
```

Current modes:

| Mode | Current target model | Thinking | Prompt route |
| --- | --- | --- | --- |
| `smart` | `claude-opus-4-8` → `gpt-5.5` | Anthropic adaptive/high or OpenAI Responses medium | `default` |
| `smartGPT` | `gpt-5.5` | OpenAI Responses | `default` |
| `smartSonnet` | `claude-sonnet-5` (claude-subscription) | Anthropic adaptive, toggleable low/medium/high | `default` |
| `rush` | `gpt-5.5` → `claude-haiku-4-5-20251001` → `claude-haiku-4-5` | OpenAI Responses none, Haiku fallback thinking off | `rush` |
| `test` | `claude-opus-4-8` | Rush-style request policy with medium Pi thinking | `rush` |
| `large` | `claude-opus-4-6` → `gpt-5.4` | Anthropic adaptive/medium or OpenAI Responses medium | `default` |
| `deep` | `gpt-5.5` → `claude-opus-4-8` | OpenAI Responses medium or Anthropic adaptive/xhigh | `deep` |
| `open` | native Pi controls | native Pi controls | Pi standard prompt |
| `free` | native Pi controls | native Pi controls | Pi standard prompt |

`smart`, `smartGPT`, `smartSonnet`, `rush`, `test`, `large`, `deep`, `open`, and
`free` are stable development mode keys; see the public-safety checklist in the
top-level roadmap.

Implemented surfaces:

- `--mmr-mode smart|smartGPT|smartSonnet|rush|test|large|deep|open|free`
- `/mode`, `/mode <mode>`
- `/mmr-status` (with mode/source, model found/applied, active/missing/deferred/gated tools, settings files read, diagnostics by severity, optional `Debug` section)
- `/mmr-status` policy warnings for fallback, missing-tool, zero-tool, and mode availability diagnostics
- mode selection precedence: flag → persisted session state → settings → `smart`
- settings support via `mmr.core` or `mmrCore`
- subscription-first model route resolution against registered/authenticated Pi models
- ordered model fallback application through Pi APIs
- logical MMR tool-name resolution to registered Pi tools
- active tool filtering and `tool_call` blocking for locked MMR modes
- fail-closed zero-active-tools policy for locked mode activation
- `open` mode for native Pi model/thinking/prompt controls with Smart-equivalent tools
- `free` mode for native Pi model/thinking controls, baseline Pi tools, and no MMR prompt/tool enforcement
- automatic switch to `free` when native Pi model/thinking controls are used from a locked mode
- per-mode system-prompt rewrite that replaces Pi's auto-rendered head only and preserves Pi's tail, `appendSystemPrompt`, and other extension content byte-for-byte
- per-mode `before_provider_request` policy that rewrites only allowed token/reasoning fields
- persisted `mmr-core.mode-state` session entries
- ordered prompt-block assembly with planned-tool negative-injection invariants and per-built-in tool guidance (see Milestone 6)
- shared helpers for later MMR modules

## Guiding boundaries

`mmr-core` owns locked-mode consistency only. It should not implement:

- `Task`, `finder`, `oracle`, or `librarian` (belong to `mmr-subagents`)
- handoff (belongs to `mmr-history`)
- toolbox protocol or MCP bridge (belong to `mmr-toolbox-mcp`)
- broader provider parity beyond the narrow per-mode token/reasoning
  rewrites already shipped (belongs to `mmr-provider-parity`)

Those belong in later dedicated MMR extensions.

## Milestone 0 — stabilize the current foundation

Status: ✅ Complete.

Goal: make the existing locked-mode spine safe and predictable before adding fidelity.

Tasks:

- Add an explicit zero-active-tools policy instead of blindly accepting `pi.setActiveTools([])`. ✅ Implemented as fail-closed: refuse activation before model/tool mutation, keep previous MMR state/tools/model, and show a clear error.
- Add model resolver policy for unavailable models. ✅ Baseline implemented with subscription-first route resolution and ordered model fallbacks.
- Resolve deep-mode provider mismatch. ✅ Baseline uses provider-neutral `gpt-5.5` and lets the resolver prefer `openai-codex` over API providers.
- Add lifecycle smoke tests around extension load, mode command, and prompt hook behavior. ✅
- Expand `/mmr-status` to show mode source, model found/applied, active/missing/deferred tools, and policy warnings. ✅

Acceptance criteria:

- ✅ Mode changes cannot silently leave the session with no usable tools.
- ✅ Missing models/tools produce actionable diagnostics.
- ✅ Tests cover mode selection, model resolution, zero-tool policy, persisted state, and tool enforcement.

## Milestone 1 — high-fidelity mode resolution

Status: ✅ Complete.

Goal: make MMR mode state a stable contract, not just a static table.

Implemented:

- ✅ Mode definitions include mode key, display name, provider-neutral model preferences, thinking level, prompt route, logical tools, deferred tools, feature gate names, and availability notes.
- ✅ `MmrModeState` records selected source, model preference order/resolved model, configured fallback status/reason, model candidates, prompt surface, active/missing/deferred tools, feature gate names, and availability notes.
- ✅ `mmr-core.mode-state` entries persist explicit mode changes and restore the latest valid mode on session start.
- ✅ Feature-gate resolver with an ordered provider chain. Built-ins: `mmr-core.reserved` and `mmr-core.unknown`. For shipped extensions (`mmr-subagents`, `mmr-web`) the reserved entry is a fallback only — those extensions ship their own feature-gate providers that take precedence. `MmrFeatureGateProvider` is the documented extension point for future server or package-provided gates; `registerMmrFeatureGateProvider(...)` plugs them into the runtime registry, and later registrations override earlier ones.
- ✅ Richer mode-resolution diagnostics in `MmrModeState.resolution`: rejected invalid sources, full tool-resolution diagnostics (requested → chosen + candidates), and feature-gate statuses tagged with the resolving provider.
- ✅ `mmr-core.mode-state` entries are versioned (`MMR_MODE_STATE_VERSION = 1`); legacy unversioned records are normalized to v1, future/malformed versions are rejected.

Acceptance criteria:

- ✅ `getMmrModeState()` returns a complete, versioned, explainable locked-mode state.
- ✅ `/mmr-status` can explain why the current mode/model/tools were chosen, including per-gate provider attribution.

## Milestone 2 — tool registry and allowlist fidelity

Status: ✅ Complete.

Goal: make active tools accurately match the selected mode.

Implemented:

- ✅ Requested tool names resolve by identity against Pi's live tool inventory; no aliases or candidate fallbacks.
- ✅ Exported helper APIs include `registerMmrToolProvider(...)`, `resolveMmrTools(...)`, and `isToolAllowed(...)`.
- ✅ Missing reserved tools are non-fatal and are shown as missing/deferred in status and prompt text.
- ✅ Locked modes set active tools, block disallowed `tool_call` events, and fail closed when no active tools resolve.
- ✅ Prompt snapshot/consistency tests catch active/missing/deferred tool drift.
- ✅ Per-mode tool matrices follow the project tool capability matrix: smart/large delegate search/list to model-backed tools, rush keeps direct `grep`/`find`, deep requests `bash`, `apply_patch`, and `write` directly.
- ✅ Registry rules carry metadata: requested name, chosen Pi tool name, owner extension (e.g. `mmr-subagents`, `mmr-history`, `mmr-web`, `mmr-toolbox`, `mmr-toolbox-mcp`, `mmr-skills`), explicit status (`active`/`missing`/`deferred`/`gated`/`disabled`), and user-facing diagnostic text exposed in `MmrToolDecision`.
- ✅ `registerMmrToolProvider(...)` API: later extensions claim ownership for the exact names they own and report `active`/`gated`/`disabled`/`deferred` status; latest registration wins. An exact-name catalog credits owning extensions for deferred tools.
- ✅ Tests cover identity dedup (same name requested twice) and gated/disabled tools (excluded from `activeTools`, surfaced in dedicated `gatedTools` / `disabledTools` buckets, blocked by `tool_call`).

Acceptance criteria:

- ✅ Switching modes predictably changes active tools.
- ✅ Missing future-module tools are reported as deferred/gated, not confused with ordinary missing Pi tools.
- ✅ Tool policy and prompt text cannot disagree without a test failure.

## Milestone 3 — prompt integration

Status: ✅ Complete (assembly maturity extensions tracked in Milestone 6).

Goal: make the model-visible system prompt reflect the resolved mode while keeping all other Pi/extension content authoritative.

Current status: MMR-authored per-mode templates and snapshots are implemented. `before_agent_start` surgically replaces Pi's auto-rendered head (identity line through the `Pi documentation` block) with a custom mode prompt. The only MMR-owned XML-style marker is the initial one-line role marker (`<mmr_mode name="smart">...</mmr_mode>`); mode sections use Markdown headings. Pi's auto `Available tools:` and `Guidelines:` are embedded under `## Tool use` so they stay in sync with active tools and are passed through byte-identically. Mode/tool/policy diagnostics are kept out of the prompt and surfaced through `/mmr-status`, activation warnings, and the status bar.

Tasks:

- [x] Introduce per-mode prompt templates for `smart`, `smartGPT`, `rush`, `large`, and `deep`.
- [x] Keep the rewrite scoped to Pi's auto head; preserve any content prepended by earlier handlers, Pi's `appendSystemPrompt`, `# Project Context` / AGENTS.md, `<available_skills>`, future subagents block, `Current date:`, `Current working directory:`, and any extension-appended tail content byte-for-byte.
- [x] Embed Pi's auto-rendered `Available tools:` and `Guidelines:` under `## Tool use` so the model never sees a stale or duplicated tool list. (Initial implementation stripped two unconditional Pi bullets the mode prompt covers; current policy is byte-identical passthrough — see Milestone 6.)
- [x] Add prompt snapshot tests for each mode plus behavioral tests covering free mode, custom-prompt passthrough, prepended-extension preservation, `appendSystemPrompt` preservation, and tail-appended preservation.
- [x] Keep mode/tool/policy diagnostics out of the model prompt; assert via tests that they do not appear.
- [x] Define prompt-source provenance in [`../../../docs/prompt-provenance.md`](../../../docs/prompt-provenance.md); do not copy third-party prompt material into this repo.

Acceptance criteria:

- ✅ `before_agent_start` produces a deterministic custom mode prompt for each non-`free` mode and passes Pi's prompt through unchanged in `free` or when the auto head cannot be located.
- ✅ Snapshot tests catch mode/template drift; behavioral tests catch loss of any out-of-head Pi/extension content.
- ✅ Prompt assembly remains MMR-named and does not expose historical source naming as public UX.

## Milestone 4 — shared contracts for later modules

Status: ✅ Complete.

Goal: let future extensions plug into `mmr-core` without duplicating locked-mode state.

- ✅ Root exports expose shared types and helpers for modes, model resolution, prompt assembly, state lookup, and tool resolution.
- ✅ Runtime helpers expose current mode state, model planning, tool resolution, tool allow checks, and alias registration.
- ✅ Tests assert helper exports exist without exposing the mutable runtime singleton object.
- ✅ Public `mmr-core` API documented in [`../../../docs/mmr-core-api.md`](../../../docs/mmr-core-api.md).
- ✅ Lightweight extension-to-extension contract: stable exported helpers plus the `MMR_EVENT_STATE_CHANGED` Pi event-bus topic carrying deep-cloned `MmrModeState` snapshots.
- ✅ Stable APIs:
  - `selectMmrModelRoute` for non-mutating worker-tool model resolution.
  - `registerMmrFeatureGateProvider` / `resolveMmrFeatureGates` / `createMmrFeatureGateRegistry` for feature gates.
  - `getMmrPromptRoute` for prompt route.
  - `getMmrPolicyDiagnostics` for structured policy diagnostics.
- ✅ Mutable singleton internals kept out of the public surface: `setMmrModeState`, raw tool/feature-gate registries, and the runtime object itself are not exported from the package root. `getMmrModeStateSnapshot` returns a deep copy so callers cannot mutate live state.

Acceptance criteria:

- ✅ A future module can ask "what mode are we in?" and "is this tool allowed?" without reading session entries directly. (`getMmrModeStateSnapshot`, `isToolAllowed`.)
- ✅ A future module can register a tool provider and have `mmr-core` include it on the next mode resolution. (`registerMmrToolProvider`.)

## Milestone 5 — diagnostics and hardening

Status: ✅ Complete (residual doc task tracked below).

Goal: make failures understandable during real interactive use.

Implemented:

- ✅ `/mmr-status` reports active locked mode/source, resolved model/applied/configured fallback, thinking, prompt surface, active tools, missing logical tools, deferred tools, gated tools, settings files read, and diagnostics grouped by severity.
- ✅ Activation failures for unavailable models and zero active tools preserve previous state and produce actionable diagnostics.
- ✅ Optional `Debug` section in `/mmr-status` for model/tool resolution diagnostics.
- ✅ Lifecycle smoke tests cover extension load, session start, `/mode`, and prompt-hook behavior.
- ✅ Status formatting tests cover warning and no-warning paths.
- ✅ Malformed settings tests in `mmr-core-settings.test.mjs`.
- ✅ Opt-in real-Pi lifecycle/integration tests in `mmr-core-pi-integration.test.mjs` (skipped without `PI_MMR_REAL_PI=1`).

Residual:

- [ ] Add a `docs/troubleshooting.md` covering common failure modes:
  - `claude-subscription` provider not installed
  - model missing or auth unavailable
  - future-module tools missing
  - no active tools resolved
  - `mmr-web` disabled or `web_search` missing `BRAVE_API_KEY`

Acceptance criteria:

- ✅ Users can diagnose common setup problems from `/mmr-status` output.
- ✅ Test coverage includes error paths, not just happy paths.

## Milestone 6 — prompt/tool assembly maturity

Status: ✅ Complete.

Goal: make the model-facing prompt and active-tool manifest auditable as a single ordered surface, with explicit invariants on what may and may not leak into it.

Implemented:

- ✅ `assembleActiveSurface(input)` returns an ordered sequence of `MmrPromptBlock` entries (`identity`, `tool-lead-in`, `active-tools`, `active-guidelines`, `shared-tool-guidance`, `shared-coding-guidance`, `builtin-tool-guidance`, `pi-docs`, `mode-posture`, `preserved-tail`) plus a `systemPrompt` string that is the byte-identical concatenation of those blocks. For `free` mode the result is a single `preserved-tail` passthrough with `systemPrompt === baseSystemPrompt`.
- ✅ Pi-authored auto-section blocks (`Available tools:`, `Guidelines:`, `Pi documentation`) are passed through byte-identically; no MMR-side filtering of Pi bullets.
- ✅ `## Built-in tool guidance` block scoped to whichever Pi built-ins (`bash`, `read`, `edit`, `write`, `grep`, `find`) actually appear in Pi's `Available tools:` block; omitted when no covered built-in is active.
- ✅ Shared `## Tool use` and coding-guidance blocks inserted after Pi documentation and before mode posture for every prompted mode.
- ✅ Planned-tool catalog (`MMR_PLANNED_TOOL_CATALOG`) describing scoped-but-not-implemented tools. Catalog entries are inert by construction: never reach the active manifest, never appear in the model-facing prompt. A negative-injection invariant covers every (mode × baseline-tool-set) combination.
- ✅ Developer-only debug fixture renderer (`renderMmrPromptDebugFixture`) producing a stable Markdown artifact (`=== System Messages ===` / `=== Tools ===`). Deterministic JSON via `stringifyMmrToolSchema`.
- ✅ Mode/tool-set matrix coverage: 16 renderer-flattened fixtures spanning `{smart, rush, large, deep} × {core-only, core+toolbox, core+web, core+toolbox+web}` plus per-mode structural invariants including `smartGPT`.

Public exports added by this milestone:

- `assembleActiveSurface`, `AssembleActiveSurfaceInput`
- `MmrPromptBlock`, `MmrPromptBlockKind`, `MmrPromptAssemblyResult`, `MmrActiveToolManifestEntry`
- `MMR_IDENTITY_LINE`, `MMR_TOOL_USE_HEADING`, `MMR_TOOL_USE_POSTURE_LINE`, `MMR_ADDITIONAL_TOOLS_LINE`, `MMR_RESPONSE_STYLE_HEADING`, `MMR_BUILTIN_TOOL_GUIDANCE_HEADING`
- `MMR_PLANNED_TOOL_CATALOG`, `MmrPlannedToolMetadata`
- `buildBuiltinToolGuidance`, `extractActiveBuiltinToolNames`, `listBuiltinToolGuidanceTools`
- `renderMmrPromptDebugFixture`, `stringifyMmrToolSchema`

Acceptance criteria:

- ✅ Every (mode × tool-set) effective surface is reviewable via a snapshot.
- ✅ Planned/inactive/gated/deferred/disabled tools cannot leak into any model-visible surface (enforced by negative-injection invariants at the renderer-flattened level).
- ✅ Pi-authored prompt blocks remain byte-identical through MMR assembly.

## Milestone 7 — subagent execution route

Status: ✅ Complete.

Goal: expose a dedicated, non-locked execution route in the child Pi
process for subagent workers, so concrete worker tools in
`mmr-subagents` (and future packages) can apply a profile-resolved
model / thinking level / tool allowlist verbatim without inheriting
locked-mode policy or accidentally interacting with it.

Implemented:

- ✅ `--mmr-subagent <name>` CLI flag registered in the child Pi process.
- ✅ Deep-frozen subagent profile registry
  (`MMR_SUBAGENT_PROFILE_TABLE`, `getMmrSubagentProfile`,
  `listMmrSubagentProfiles`). Initial profile: `finder` (worker model
  `antigravity/gemini-3.5-flash` → `gpt-5.4-mini` →
  `claude-haiku-4-5`, LOW thinking, tool allowlist
  `[grep, find, read]`).
- ✅ Pure subagent route resolver (`resolveMmrSubagentRoute`) that picks
  the first registered + authenticated provider/model from the
  profile preferences via `selectMmrModelRoute`, and validates any
  caller-supplied `explicitModel` / `explicitTools` against the
  profile. Stable failure codes: `model.no-route`, `model.mismatch`,
  `tools.mismatch`.
- ✅ Pure argv helper (`extractExplicitWorkerCliFlags`) extracts
  explicit `--model` / `--tools` (`-t`) values from
  `process.argv.slice(2)` so activation can distinguish runner-
  supplied flags from Pi's own default/restored model.
- ✅ `applySubagentProfile` activates the resolved route via
  `pi.setModel` / `pi.setThinkingLevel` / `pi.setActiveTools` inside
  the existing `applyingMmrMode` transaction guard, and stores the
  resulting `MmrSubagentState` in the runtime singleton. When
  `--mmr-subagent` is absent, `session_start` explicitly clears any
  prior `MmrSubagentState` before locked-mode activation so previous
  subagent posture cannot leak into a normal session.
- ✅ Subagent activation does NOT capture/restore a Pi baseline, emit
  `MMR_EVENT_STATE_CHANGED`, persist `mmr-core.mode-state`, apply
  locked-mode prompt templates, apply locked-mode request policy, or
  invoke Free-mode tool restoration. `before_provider_request`,
  `before_agent_start`, `tool_call`, `model_select`, and
  `thinking_level_select` consumers early-return whenever
  `getMmrSubagentState()` is non-empty.
- ✅ Fail-closed lifecycle: unknown profile name, unresolvable model
  route, explicit `--model` mismatch, and explicit `--tools` mismatch
  all reject before any mutation. The failure path emits an error
  notification, writes the canonical marker
  `pi-mmr: subagent activation failed: <reason>` (exported as
  `MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX`) to the child's
  stderr, and throws from `session_start`.
- ✅ Pure stderr parser (`extractMmrSubagentActivationFailure`)
  consumed by the `mmr-subagents` runner to convert the marker into
  an unmissable hard failure even when Pi itself exits 0 (Pi
  currently does not propagate extension `session_start` throws into
  a nonzero exit code).

Public exports added by this milestone:

- `getMmrSubagentProfile`, `listMmrSubagentProfiles`
- `MmrSubagentProfile`, `MmrSubagentPromptRoute`, `MmrSubagentExtensionPolicy`
- `resolveMmrSubagentRoute`, `ResolveMmrSubagentRouteArgs`
- `MmrSubagentRouteSelection`, `MmrSubagentRouteSelectionOk`, `MmrSubagentRouteSelectionFail`
- `MmrSubagentResolveCode`, `MmrSubagentResolveDiagnostic`
- `MMR_SUBAGENT_ACTIVATION_FAILURE_STDERR_PREFIX`
- `extractMmrSubagentActivationFailure`
- `extractExplicitWorkerCliFlags`, `ExplicitWorkerCliFlags`
- `getMmrSubagentState`, `MmrSubagentState`

`setMmrSubagentState` remains intentionally **not** exported — only
`mmr-core` updates subagent activation state.

Acceptance criteria:

- ✅ Subagent activation never captures/restores a Pi baseline, never
  emits `MMR_EVENT_STATE_CHANGED`, never persists `mmr-core.mode-state`,
  never applies locked-mode prompt templates, never injects MMR-owned
  tools beyond the profile allowlist. (Pinned by
  `tests/mmr-core-subagent-activation.test.mjs`.)
- ✅ Subagent activation fails closed on unknown profile, no model
  route, explicit `--model` mismatch, and explicit `--tools`
  mismatch — with no model/tool mutation. (Pinned by activation tests
  and live verified through real `pi --mmr-subagent` invocations.)
- ✅ Profile resolver and CLI-flag helper are pure and have their own
  dedicated tests (`mmr-core-subagent-resolve.test.mjs`,
  `mmr-core-subagent-cli-flags.test.mjs`).
- ✅ Failure marker is a stable shared constant between producer
  (mmr-core) and consumer (runner); drift is impossible. (Pinned by
  `mmr-core-subagent-activation-failure-marker.test.mjs`.)

## Deferred: built-in tool wrappers and on-demand capability discovery

Status: deferred. Recorded here so the rationale survives future planning.

The prompt/tool-assembly work in Milestone 6 added rich per-tool steering,
shared cross-tool guidance, an active-only manifest, planned-tool negative
injection, and the `## Built-in tool guidance` block scoped to whichever Pi
built-ins are actually active. Those layers are entirely prompt-side: Pi's
built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) keep
their own names, schemas, defaults, and runtime behavior. Two further
phases were scoped during that work but intentionally not implemented.

### Phase G — optional adapters/wrappers around Pi built-ins

What it would entail:

- Register pi-mmr-owned tools that shadow or replace Pi built-ins. A wrapper
  is a new tool with its own name, description, parameter schema, and prompt
  steering; it accepts model calls and either delegates to the underlying Pi
  built-in or reimplements the behavior.
- Candidate wrappers identified during planning: a shell wrapper around
  `bash` (richer policy, optional `cwd`, structured output) and any
  future toolbox wrappers around concrete Pi tools. Wrappers register
  under their canonical Pi tool name; modes/profiles reference that
  exact name.
- Each wrapper would carry its own active-manifest entry, its own renderer
  output in the effective-surface fixtures, and its own tests.

Why it is deferred:

- Wrappers replace a stable Pi built-in surface with a pi-mmr-owned surface
  and bring real risk: schema drift, path-handling drift, renderer drift,
  tool-call resolution drift, and session-behavior drift versus what Pi already
  validates.
- The phase's trigger ("metadata + shared guidance + effective-surface
  snapshots prove insufficient") has not fired. The current per-built-in
  guidance block plus richer extension-tool metadata covers the steering
  gaps that originally motivated the wrappers.
- Wrappers should only be introduced when a specific, named behavioral gap
  cannot be closed by prompt-side steering or by `mmr-toolbox` / `mmr-web` /
  future-extension tools that live outside the Pi built-in surface.

Revisit when:

- A concrete behavioral requirement (e.g. structured shell output, atomic
  multi-file edits with a different schema, or a strictly sandboxed shell)
  cannot be satisfied by prompt steering or by an existing pi-mmr tool.
- Or when a wrapper is needed to enforce a safety/privacy policy that Pi's
  built-in surface cannot represent.

### Phase H — optional on-demand capability discovery

What it would entail:

- A deliberate mechanism where planned/deferred tools are announced to the
  model by name and short summary, and loaded on demand when the model asks
  for them, instead of being silently absent.
- This would extend the existing `MMR_PLANNED_TOOL_CATALOG` so planned
  entries can opt into being discoverable, while still keeping unloaded
  tools out of the active manifest until the discovery handshake succeeds.
- Would require a new prompt block, new tool-resolution status, new
  diagnostics, and tests that prove deferred tools remain absent from the
  active surface until the handshake actually completes.

Why it is deferred:

- The current contract is stronger and simpler: planned/inactive tools are
  not model-visible anywhere. Negative-injection invariants are tested
  across every mode and tool-set combination.
- On-demand discovery only makes sense once a planned tool is close to
  shipping and would benefit from being announced before activation, or
  once the planned catalog is large enough that hiding it fully creates a
  worse experience than naming it without activation.
- Neither condition currently holds.

Revisit when:

- A planned tool is near-ready and the rollout would benefit from staged
  visibility before full activation.
- Or when the planned catalog grows enough that selective discoverability
  improves model behavior more than the existing fail-closed silence.

Until then, planned/deferred tools remain absent from every model-visible
surface; the planned-tool negative-injection invariant guards that.
