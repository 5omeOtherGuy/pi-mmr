import { MMR_ADDITIONAL_TOOLS_LINE, assembleActiveSurface } from "./prompt-assembly.js";
import type { MmrSubagentProfile } from "./subagent-profiles.js";
import type {
  MmrActiveToolManifestEntry,
  MmrModeKey,
  MmrModeState,
  MmrPromptBlock,
} from "./types.js";

/**
 * Logical kind of a prompt block emitted by the subagent prompt-assembly
 * surface. Kept narrow on purpose: the standalone route owns the entire
 * system prompt as a single block, while the mode-derived route reuses
 * `assembleActiveSurface(baseMode)` and appends one worker-role block.
 */
export type MmrSubagentPromptBlockKind = "standalone-prompt" | "subagent-worker-role";

/**
 * A prompt block in a subagent's effective surface. Mirrors
 * `MmrPromptBlock` but uses the narrower
 * `MmrSubagentPromptBlockKind` set; the underlying type carries one of
 * the user-facing block kinds for mode-derived blocks that came from
 * `assembleActiveSurface`.
 */
export interface MmrSubagentSurfaceBlock {
  id: string;
  kind: MmrSubagentPromptBlockKind | MmrPromptBlock["kind"];
  text: string;
  source: "mmr-core" | "mmr-subagents" | "pi" | "extension";
}

/**
 * Output of the subagent prompt-assembly surface. Mirrors
 * `MmrPromptAssemblyResult` for the user-facing modes but is keyed on
 * subagent profile rather than mode key.
 */
export interface MmrSubagentPromptAssemblyResult {
  /** Subagent profile name (== profile.name). */
  subagent: string;
  /** Profile that produced the surface. */
  profile: MmrSubagentProfile;
  /** Ordered block sequence; flattening `text` reproduces `systemPrompt`. */
  blocks: MmrSubagentSurfaceBlock[];
  /** Concatenated block text; what the subagent worker would receive as system prompt. */
  systemPrompt: string;
  /** Active tool manifest filtered to the profile's tool allowlist. */
  activeToolManifest: MmrActiveToolManifestEntry[];
}

/**
 * Input to a registered subagent prompt builder. Builders are pure
 * functions; mmr-core never injects side-effecting dependencies into them.
 */
export interface MmrSubagentPromptBuilderInput {
  /** Profile that owns the builder. */
  profile: MmrSubagentProfile;
  /** Worker working directory. Builders should treat empty cwd as unknown. */
  cwd: string;
  /**
   * Read-only base prompt the parent Pi process supplied. Standalone
   * builders may ignore this; mode-derived builders typically do too,
   * because the base-mode assembly has already consumed Pi's auto head.
   */
  baseSystemPrompt: string;
  /**
   * Optional locked-mode state available to a mode-derived builder
   * (e.g. for surfacing the parent mode's display name). Standalone
   * builders should not depend on it.
   */
  modeState?: MmrModeState;
}

/** A registered prompt builder. Must be pure and synchronous. */
export type MmrSubagentPromptBuilder = (input: MmrSubagentPromptBuilderInput) => string;

const MMR_SUBAGENT_PROMPT_BUILDERS_GLOBAL_KEY = "__pi_mmr_subagent_prompt_builders_v1__";

const globalBuilderStore = globalThis as typeof globalThis & {
  [MMR_SUBAGENT_PROMPT_BUILDERS_GLOBAL_KEY]?: Map<string, MmrSubagentPromptBuilder>;
};

/**
 * Process-global builder registry.
 *
 * Pi may load extension entrypoints with isolated module caches, so a
 * module-local Map would give `mmr-core` (where the registry type lives)
 * and `mmr-subagents` (where the concrete builders are registered)
 * different registries even though they run in the same Pi process. The
 * singleton is keyed on `globalThis` for the same reason `mmr-core/runtime.ts`
 * keeps its registry there.
 */
function resolveBuilderRegistry(): Map<string, MmrSubagentPromptBuilder> {
  const existing = globalBuilderStore[MMR_SUBAGENT_PROMPT_BUILDERS_GLOBAL_KEY];
  if (existing instanceof Map) return existing;
  const fresh = new Map<string, MmrSubagentPromptBuilder>();
  globalBuilderStore[MMR_SUBAGENT_PROMPT_BUILDERS_GLOBAL_KEY] = fresh;
  return fresh;
}

/**
 * Register a prompt builder under a stable identifier. The identifier
 * must match a `MmrSubagentProfile.promptBuilder` value to be reachable
 * from `assembleMmrSubagentSurface`. Calling with an existing identifier
 * replaces the previous builder; the framework does not collide-protect
 * because concrete prompt-owner extensions (mmr-subagents) are
 * authoritative.
 */
export function registerMmrSubagentPromptBuilder(
  name: string,
  builder: MmrSubagentPromptBuilder,
): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("registerMmrSubagentPromptBuilder requires a non-empty name");
  }
  if (typeof builder !== "function") {
    throw new Error(`registerMmrSubagentPromptBuilder("${name}") requires a function builder`);
  }
  resolveBuilderRegistry().set(name, builder);
}

/**
 * Look up a registered builder by name. Returns `undefined` when no
 * builder is registered; callers fail closed at the surface boundary.
 */
export function getMmrSubagentPromptBuilder(name: string): MmrSubagentPromptBuilder | undefined {
  return resolveBuilderRegistry().get(name);
}

/** Remove a registered prompt builder. Used by temporary test seams. */
export function unregisterMmrSubagentPromptBuilder(name: string): void {
  resolveBuilderRegistry().delete(name);
}

/**
 * Test seam: clear the registry. Production callers do not need this;
 * tests use it in `beforeEach` to keep registrations hermetic.
 */
export function clearMmrSubagentPromptBuilders(): void {
  resolveBuilderRegistry().clear();
}

export interface AssembleMmrSubagentSurfaceInput {
  profile: MmrSubagentProfile;
  /** Pi's current chained system prompt for this turn. Read-only input. */
  baseSystemPrompt: string;
  /**
   * Caller-resolved active tool manifest. Will be filtered down to the
   * effective worker tool set (see {@link workerTools}) before being
   * surfaced; the caller is still responsible for excluding gated /
   * deferred / disabled tools that happen to share a name with a
   * profile-listed tool.
   */
  activeToolManifest: MmrActiveToolManifestEntry[];
  /** Worker working directory. */
  cwd: string;
  /**
   * Invocation parent mode for profiles whose `baseMode` is
   * `"from-parent"`. Required for those profiles and ignored for
   * standalone profiles and pinned-base mode-derived profiles.
   */
  parentMode?: MmrModeKey;
  /**
   * Optional locked-mode state forwarded to the registered builder.
   * Standalone builders typically ignore it; mode-derived builders
   * receive it via the prompt-builder input.
   */
  modeState?: MmrModeState;
  /**
   * Optional effective worker tool set computed by the invocation
   * resolver. Filters `activeToolManifest` to exactly the tools the
   * worker will have at the child Pi process (deny-aware,
   * registered-tool intersection). When omitted, the manifest is
   * filtered by `profile.tools` for backwards compatibility, but every
   * caller spawning a worker SHOULD forward `invocation.workerTools`
   * so the worker prompt's `Available tools:` block describes the
   * exact tools the worker can call.
   */
  workerTools?: readonly string[];
}

function filterManifestToProfile(
  manifest: readonly MmrActiveToolManifestEntry[],
  profile: MmrSubagentProfile,
  workerTools: readonly string[] | undefined,
): MmrActiveToolManifestEntry[] {
  // Prefer the invocation resolver's effective worker tool set when
  // present so the assembled prompt describes the exact tools the
  // worker will have (deny-aware, registered-tool intersection). Fall
  // back to `profile.tools` only when the caller did not forward a
  // workerTools list, which preserves the previous behavior for callers
  // that do not yet route through `resolveMmrSubagentInvocation`.
  const allowed = new Set(workerTools ?? profile.tools);
  return manifest.filter((entry) => allowed.has(entry.name));
}

/**
 * Collapse a tool snippet/description to the single line Pi uses for its
 * `Available tools:` entries. Mirrors Pi's own snippet normalization
 * (`[\r\n]+` and runs of whitespace collapse to a single space, trimmed)
 * so the worker block lists one `- name: text` line per tool instead of
 * splicing a multi-paragraph tool description into the prompt head.
 */
function toToolSummaryLine(entry: MmrActiveToolManifestEntry): string | undefined {
  // Prefer the registered one-line `promptSnippet` (the exact text Pi shows
  // in its own `Available tools:` block) and fall back to the full
  // description so a granted, callable worker tool is never hidden from the
  // worker model. The worker prompt is delivered with replacement semantics,
  // so this block is the only place the worker learns what it can call. An
  // empty/whitespace-only snippet is treated as absent so it cannot hide the
  // tool.
  for (const raw of [entry.promptSnippet, entry.description]) {
    if (typeof raw !== "string") continue;
    const oneLine = raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    if (oneLine.length > 0) return oneLine;
  }
  return undefined;
}

/**
 * Pi-owned constant `Guidelines:` bullet emitted only when the worker has
 * `bash` but none of `grep`/`find`/`ls` (see Pi's `buildSystemPrompt`).
 */
export const PI_BASH_ONLY_EXPLORATION_GUIDELINE = "Use bash for file operations like ls, rg, find";

/** Pi-owned trailing `Guidelines:` bullets Pi always appends, in order. */
export const PI_ALWAYS_ON_GUIDELINES = [
  "Be concise in your responses",
  "Show file paths clearly when working with files",
] as const;

/**
 * Full set of literal `addGuideline("…")` strings Pi emits as constants in
 * `buildSystemPrompt` (the conditional bash-exploration bullet plus the two
 * always-on bullets). Per-tool guideline bullets are not constants — Pi reads
 * them from each tool's `promptGuidelines`, so they flow through the worker
 * manifest, not this list. Shared with the drift-guard test as the single
 * source of truth (see `tests/mmr-core-pi-guidelines-drift.test.mjs`).
 */
export const PI_CONSTANT_GUIDELINES: readonly string[] = [
  PI_BASH_ONLY_EXPLORATION_GUIDELINE,
  ...PI_ALWAYS_ON_GUIDELINES,
];

/**
 * Rebuild Pi's `Guidelines:` block from the worker's own profile-filtered
 * manifest, reproducing Pi's `buildSystemPrompt` composition exactly:
 *   1. the conditional bash-exploration bullet (bash present, no grep/find/ls),
 *   2. each tool's `promptGuidelines` in manifest order (trimmed, non-empty),
 *   3. the two always-on bullets,
 * with global first-occurrence-wins dedup. Returns the full block including the
 * `Guidelines:` header (mirrors how `assembleActiveSurface` slices
 * `guidelinesContent` to include the header). The worker prompt is
 * replacement-delivered and MMR-owned, so there is no upstream byte-ground-truth
 * to match; per-tool bullet order is the deterministic manifest order.
 */
function buildWorkerGuidelinesBlock(
  manifest: readonly MmrActiveToolManifestEntry[],
): string {
  const names = new Set(manifest.map((entry) => entry.name));
  const list: string[] = [];
  const seen = new Set<string>();
  const add = (guideline: string): void => {
    if (seen.has(guideline)) return;
    seen.add(guideline);
    list.push(guideline);
  };

  if (names.has("bash") && !names.has("grep") && !names.has("find") && !names.has("ls")) {
    add(PI_BASH_ONLY_EXPLORATION_GUIDELINE);
  }
  for (const entry of manifest) {
    for (const guideline of entry.promptGuidelines ?? []) {
      const normalized = guideline.trim();
      if (normalized.length > 0) add(normalized);
    }
  }
  for (const guideline of PI_ALWAYS_ON_GUIDELINES) add(guideline);

  return `Guidelines:\n${list.map((guideline) => `- ${guideline}`).join("\n")}`;
}

function renderWorkerActiveToolsBlock(manifest: readonly MmrActiveToolManifestEntry[]): string {
  const lines: string[] = [];
  for (const entry of manifest) {
    const summary = toToolSummaryLine(entry);
    if (summary !== undefined) lines.push(`- ${entry.name}: ${summary}`);
  }
  // Match Pi's `(none)` placeholder when no worker tool produced a line.
  const body = lines.length > 0 ? lines : ["(none)"];
  return [
    "Available tools:",
    ...body,
    "",
    MMR_ADDITIONAL_TOOLS_LINE,
    "",
  ].join("\n");
}

function resolveModeDerivedBaseMode(profile: MmrSubagentProfile, parentMode: MmrModeKey | undefined): MmrModeKey {
  if (profile.baseMode === "from-parent") {
    if (parentMode === undefined) {
      throw new Error(
        `mmr-core: subagent profile "${profile.name}" declares baseMode "from-parent" but assembleMmrSubagentSurface was called without parentMode`,
      );
    }
    return parentMode;
  }
  if (profile.baseMode === undefined) {
    throw new Error(`mmr-core: mode-derived subagent profile "${profile.name}" does not declare baseMode`);
  }
  return profile.baseMode;
}

/**
 * Pick the separator that the appended worker-role block must own so
 * the assembled prompt always has a clean blank-line boundary between
 * the base mode surface and the worker-role block, regardless of how
 * Pi's preserved tail terminates.
 */
function computeWorkerRoleSeparator(baseText: string): string {
  if (baseText.length === 0) return "";
  if (baseText.endsWith("\n\n")) return "";
  if (baseText.endsWith("\n")) return "\n";
  return "\n\n";
}

function buildMinimalBaseModeState(baseMode: MmrModeKey): MmrModeState {
  // Minimal locked-mode state stamped with the parent's key so
  // `assembleActiveSurface` produces the parent's prompt template.
  // mmr-core does not consult routing/tool fields here; this state is
  // only used to drive the splice path.
  return {
    version: 1,
    mode: baseMode,
    displayName: baseMode,
    source: "settings",
    targetModel: "",
    requestedModels: [],
    provider: "",
    model: "",
    modelFound: true,
    modelApplied: true,
    modelFallbackApplied: false,
    modelCandidates: [],
    promptRoute: baseMode === "rush" ? "rush" : baseMode === "deep" ? "deep" : "default",
    requestedTools: [],
    activeTools: [],
    missingTools: [],
    deferredTools: [],
    gatedTools: [],
    disabledTools: [],
    featureGates: [],
    availabilityNotes: [],
    resolution: {
      selectedSource: "settings",
      rejectedSources: [],
      modelDecision: { fallbackApplied: false },
      toolDecisions: [],
      featureGateDecisions: [],
    },
    appliedAt: "1970-01-01T00:00:00.000Z",
  };
}

/**
 * Assemble the effective surface for a subagent profile.
 *
 * Standalone profiles:
 *   - resolve `profile.promptBuilder` through the registered builders;
 *   - call it with `{ profile, cwd, baseSystemPrompt, modeState }`;
 *   - return the builder output as `systemPrompt`,
 *     wrapped in a single `standalone-prompt` block;
 *   - filter `activeToolManifest` to `profile.tools`.
 *
 * Mode-derived profiles:
 *   - call `assembleActiveSurface` with a minimal state stamped for
 *     `profile.baseMode`;
 *   - resolve `profile.promptBuilder` and append its output as a
 *     `subagent-worker-role` block;
 *   - filter `activeToolManifest` to `profile.tools`.
 *
 * Fails closed when the named builder is not registered (no silent
 * fallback to an empty prompt).
 */
export function assembleMmrSubagentSurface(
  input: AssembleMmrSubagentSurfaceInput,
): MmrSubagentPromptAssemblyResult {
  const { profile, baseSystemPrompt, activeToolManifest, cwd, modeState, parentMode, workerTools } = input;
  const builder = resolveBuilderRegistry().get(profile.promptBuilder);
  if (!builder) {
    throw new Error(
      `mmr-core: no subagent prompt builder registered for "${profile.promptBuilder}" (profile "${profile.name}")`,
    );
  }
  const filteredManifest = filterManifestToProfile(activeToolManifest, profile, workerTools);

  if (profile.promptRoute === "standalone") {
    const builderInput: MmrSubagentPromptBuilderInput = {
      profile,
      cwd,
      baseSystemPrompt,
      ...(modeState !== undefined ? { modeState } : {}),
    };
    const text = builder(builderInput);
    const block: MmrSubagentSurfaceBlock = {
      id: `standalone-prompt:${profile.name}`,
      kind: "standalone-prompt",
      text,
      source: "mmr-subagents",
    };
    return {
      subagent: profile.name,
      profile,
      blocks: [block],
      systemPrompt: text,
      activeToolManifest: filteredManifest,
    };
  }

  // mode-derived
  const resolvedBaseMode = resolveModeDerivedBaseMode(profile, parentMode);
  // Fail closed when a caller-provided `modeState` disagrees with the
  // resolved base mode. Otherwise the splice path could quietly use the
  // wrong prompt template (e.g. pinned `baseMode: "rush"` while the
  // caller passes a `deep` modeState).
  if (modeState !== undefined && modeState.mode !== resolvedBaseMode) {
    throw new Error(
      `mmr-core: subagent profile "${profile.name}" resolved baseMode "${resolvedBaseMode}" but modeState.mode is "${modeState.mode}"`,
    );
  }
  const baseState = modeState ?? buildMinimalBaseModeState(resolvedBaseMode);
  const baseSurface = assembleActiveSurface({
    state: baseState,
    baseSystemPrompt,
    activeToolManifest: filteredManifest,
    // Built-in tool guidance for a worker must follow the worker's own
    // (profile-filtered) tool set, not the parent's rendered `Available
    // tools:` block. Otherwise parent-only built-ins (e.g. grep/find) leak
    // guidance into a worker that cannot call them.
    activeToolNames: filteredManifest.map((entry) => entry.name),
  });

  const workerRoleText = builder({
    profile,
    cwd,
    baseSystemPrompt,
    modeState: baseState,
  });

  // Own the boundary between the base surface and the appended
  // worker-role block so callers cannot produce a glued prompt like
  // `.../cwd## Worker Role` when Pi's preserved tail does not end with
  // its own blank line.
  const workerRoleSeparator = computeWorkerRoleSeparator(baseSurface.systemPrompt);

  // Append worker-role block; concatenation must reproduce systemPrompt.
  const workerBlock: MmrSubagentSurfaceBlock = {
    id: `subagent-worker-role:${profile.name}`,
    kind: "subagent-worker-role",
    text: `${workerRoleSeparator}${workerRoleText}`,
    source: "mmr-subagents",
  };

  const blocks: MmrSubagentSurfaceBlock[] = baseSurface.blocks.map((b) => ({ ...b }));
  const activeToolsBlock = blocks.find((block) => block.kind === "active-tools");
  if (activeToolsBlock) {
    activeToolsBlock.text = renderWorkerActiveToolsBlock(filteredManifest);
    // The block is no longer the literal Pi-authored `Available tools:` text:
    // mmr-core rebuilt it from the subagent-filtered worker manifest so
    // parent-only tools cannot leak into mode-derived worker prompts.
    activeToolsBlock.source = "mmr-core";
  }
  const activeGuidelinesBlock = blocks.find((block) => block.kind === "active-guidelines");
  if (activeGuidelinesBlock) {
    // Guidelines must follow the worker's own (profile-filtered) tool set,
    // not the parent's inherited block; otherwise parent-only tool guidance
    // leaks in and worker-only tool guidance is missing. Rebuilt from the
    // worker manifest's `promptGuidelines`, reproducing Pi's composition.
    activeGuidelinesBlock.text = `${buildWorkerGuidelinesBlock(filteredManifest)}\n\n`;
    activeGuidelinesBlock.source = "mmr-core";
  }
  blocks.push(workerBlock);
  const systemPrompt = blocks.map((b) => b.text).join("");

  return {
    subagent: profile.name,
    profile,
    blocks,
    systemPrompt,
    activeToolManifest: filteredManifest,
  };
}
