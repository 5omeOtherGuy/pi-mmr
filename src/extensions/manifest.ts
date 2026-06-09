/**
 * Capability manifest for every `pi-mmr` extension directory.
 *
 * This module is the single declarative source of truth that the architecture
 * guardrail tests (`tests/mmr-architecture-manifest.test.mjs`) cross-check
 * against the real wiring:
 *
 *   - `package.json` `pi.extensions` (which entrypoints auto-load),
 *   - `package.json` `exports` (public subpath surface),
 *   - the on-disk `src/extensions/*` directory set,
 *   - the subagent child keep-set (`MMR_SUBAGENT_CHILD_KEEP_EXTENSIONS`),
 *   - the planned-tool catalog (`MMR_PLANNED_TOOL_CATALOG`),
 *   - the `mmr-core` -> sibling import direction.
 *
 * It is intentionally dependency-free pure data so it can be imported in
 * isolation. As the greenfield extension split proceeds, each chunk updates the
 * manifest in lockstep with the code it moves, and the guardrail tests fail if
 * the manifest and the real wiring drift apart.
 *
 * Scope note: fields here describe statically-knowable ownership (entrypoint,
 * public export, owned tool names, feature gates, risk/child role). Runtime
 * commands, persisted state keys, and env gates are not yet enumerated; they are
 * added per-chunk as the owning code moves, so the manifest never asserts data
 * it cannot back.
 */

/** Coarse risk class, used for review and diagnostics, not enforcement. */
export type MmrExtensionRiskClass =
  | "substrate" // mode/policy/prompt substrate; no external side effects
  | "passive" // hook-only; observes/falls back, registers no model tool
  | "local-mutation" // mutates the local workspace or local session state
  | "network" // performs outbound network requests
  | "remote-repo" // reads remote repository data
  | "session-data" // reads local session/history data
  | "subprocess" // spawns child agent processes
  | "diagnostic"; // debug capture / inspection

/**
 * Role this extension plays in subagent child-process scoping.
 *  - substrate    : always kept (owns the `--mmr-subagent` activation guard).
 *  - worker-owner : registers subagent worker tools/profiles.
 *  - worker-dep   : owns tools a worker keep-set depends on.
 *  - none         : not part of any child keep-set.
 */
export type MmrExtensionChildRole = "substrate" | "worker-owner" | "worker-dep" | "none";

export interface MmrExtensionManifestEntry {
  /** Directory name under `src/extensions`, the canonical extension id. */
  readonly name: string;
  /** Entrypoint path relative to the package root (matches `pi.extensions` when auto-loaded). */
  readonly entrypoint: string;
  /** `package.json` `exports` subpath, or `null` when not publicly exported. */
  readonly exportSubpath: string | null;
  /** Whether the entrypoint is registered in `package.json` `pi.extensions`. */
  readonly autoLoaded: boolean;
  /** Concrete, statically-known Pi tool names this extension owns. */
  readonly tools: readonly string[];
  /** Whether this extension also registers dynamic (runtime-named) tools. */
  readonly dynamicTools: boolean;
  /** Feature-gate ids owned by this extension. */
  readonly featureGates: readonly string[];
  readonly riskClass: MmrExtensionRiskClass;
  readonly childRole: MmrExtensionChildRole;
}

/**
 * Current-state manifest. Reflects the pre-greenfield-split topology:
 * `mmr-toolbox` and `mmr-subagents` are still single aggregate extensions.
 */
export const MMR_EXTENSION_MANIFEST: readonly MmrExtensionManifestEntry[] = Object.freeze([
  {
    name: "mmr-core",
    entrypoint: "./src/extensions/mmr-core/index.ts",
    exportSubpath: "./extensions/mmr-core",
    autoLoaded: true,
    tools: [],
    dynamicTools: false,
    featureGates: [],
    riskClass: "substrate",
    childRole: "substrate",
  },
  {
    name: "mmr-session-fallback",
    entrypoint: "./src/extensions/mmr-session-fallback/index.ts",
    exportSubpath: "./extensions/mmr-session-fallback",
    autoLoaded: true,
    tools: [],
    dynamicTools: false,
    featureGates: [],
    riskClass: "passive",
    childRole: "none",
  },
  {
    name: "mmr-patch",
    entrypoint: "./src/extensions/mmr-patch/index.ts",
    exportSubpath: "./extensions/mmr-patch",
    autoLoaded: true,
    tools: ["apply_patch"],
    dynamicTools: false,
    featureGates: [],
    riskClass: "local-mutation",
    childRole: "none",
  },
  {
    name: "mmr-tasks",
    entrypoint: "./src/extensions/mmr-tasks/index.ts",
    exportSubpath: "./extensions/mmr-tasks",
    autoLoaded: true,
    tools: ["task_list"],
    dynamicTools: false,
    featureGates: [],
    riskClass: "local-mutation",
    childRole: "worker-dep",
  },
  {
    // Deprecated compatibility shim: split into mmr-patch + mmr-tasks. Not
    // auto-loaded; re-exports the former `./extensions/mmr-toolbox` surface.
    name: "mmr-toolbox",
    entrypoint: "./src/extensions/mmr-toolbox/index.ts",
    exportSubpath: "./extensions/mmr-toolbox",
    autoLoaded: false,
    tools: [],
    dynamicTools: false,
    featureGates: [],
    riskClass: "local-mutation",
    childRole: "none",
  },
  {
    name: "mmr-web",
    entrypoint: "./src/extensions/mmr-web/index.ts",
    exportSubpath: "./extensions/mmr-web",
    autoLoaded: true,
    tools: ["web_search", "read_web_page"],
    dynamicTools: false,
    featureGates: ["mmr-web"],
    riskClass: "network",
    childRole: "worker-dep",
  },
  {
    name: "mmr-github",
    entrypoint: "./src/extensions/mmr-github/index.ts",
    exportSubpath: "./extensions/mmr-github",
    autoLoaded: true,
    tools: [
      "read_github",
      "list_directory_github",
      "glob_github",
      "search_github",
      "commit_search",
      "diff_github",
      "list_repositories",
    ],
    dynamicTools: false,
    featureGates: ["mmr-github"],
    riskClass: "remote-repo",
    childRole: "worker-dep",
  },
  {
    name: "mmr-subagents",
    entrypoint: "./src/extensions/mmr-subagents/index.ts",
    exportSubpath: "./extensions/mmr-subagents",
    autoLoaded: true,
    tools: [
      "finder",
      "oracle",
      "librarian",
      "Task",
      "start_task",
      "task_poll",
      "task_wait",
      "task_cancel",
    ],
    dynamicTools: true, // custom Markdown `sa__*` subagents
    featureGates: ["mmr-subagents", "mmr-subagents.async-tasks"],
    riskClass: "subprocess",
    childRole: "worker-owner",
  },
  {
    name: "mmr-history",
    entrypoint: "./src/extensions/mmr-history/index.ts",
    exportSubpath: "./extensions/mmr-history",
    autoLoaded: true,
    tools: ["read_session", "find_session"],
    dynamicTools: false,
    featureGates: ["mmr-history"],
    riskClass: "session-data",
    childRole: "worker-dep",
  },
  {
    name: "mmr-debug",
    entrypoint: "./src/extensions/mmr-debug/index.ts",
    exportSubpath: null,
    autoLoaded: false,
    tools: [],
    dynamicTools: false,
    featureGates: [],
    riskClass: "diagnostic",
    childRole: "none",
  },
]);

/**
 * Known `mmr-core` -> sibling-extension imports that currently violate the
 * "core depends on no sibling" invariant. The dependency-direction guardrail
 * asserts core imports no sibling OUTSIDE this set, so new couplings fail while
 * these documented ones are driven to zero by later chunks:
 *
 *  - `mmr-web`       : `config-flow.ts` dispatches into the web config flow.
 *  - `mmr-subagents` : `config-flow.ts` dispatches into the subagents config flow.
 *  - `mmr-github`    : `subagent-activation.ts` validates librarian-owned tools.
 *
 * Target: invert these so siblings register into core, leaving the set empty.
 */
export const MMR_CORE_SIBLING_IMPORT_EXCEPTIONS: readonly string[] = Object.freeze([
  "mmr-web",
  "mmr-subagents",
  "mmr-github",
]);

/** Convenience: the set of canonical extension directory names. */
export function getMmrExtensionNames(): readonly string[] {
  return MMR_EXTENSION_MANIFEST.map((entry) => entry.name);
}

/** Lookup a manifest entry by canonical extension name. */
export function getMmrExtensionManifestEntry(name: string): MmrExtensionManifestEntry | undefined {
  return MMR_EXTENSION_MANIFEST.find((entry) => entry.name === name);
}
