import type {
  MmrToolDecision,
  MmrToolProvider,
  MmrToolResolution,
  MmrToolRule,
} from "./types.js";

export const CORE_OWNER = "mmr-core";

/**
 * Exact-name status catalog for tools owned by mmr extensions that may not
 * be loaded/enabled in the current Pi process. Entries are keyed by the
 * canonical Pi tool name and name the owning extension.
 *
 * The catalog has two roles in the resolver, both keyed by exact name:
 *
 * 1. When no provider claims a name and Pi's live inventory exposes a tool
 *    with that exact name, the active decision is credited to the catalog
 *    owner (e.g. mmr-web for `web_search`). This keeps /mmr-status
 *    ownership stable even when an extension entrypoint loaded with an
 *    isolated module cache and its `registerMmrToolProvider` call did not
 *    reach mmr-core's registry.
 * 2. When no provider claims a name and Pi has not registered a tool with
 *    that name, the decision is reported as `deferred` against the
 *    catalog owner so users see which extension still needs to ship or
 *    be enabled.
 *
 * This catalog never participates in name translation. There are no
 * aliases: a mode/profile/allowlist must use the exact tool name it wants
 * activated.
 */
const DEFAULT_TOOL_CATALOG: Record<string, { owner: string }> = {
  // mmr-toolbox
  apply_patch: { owner: "mmr-toolbox" },
  task_list: { owner: "mmr-toolbox" },
  chart: { owner: "mmr-toolbox" },
  // mmr-toolbox-mcp
  read_mcp_resource: { owner: "mmr-toolbox-mcp" },
  // mmr-web
  web_search: { owner: "mmr-web" },
  read_web_page: { owner: "mmr-web" },
  // mmr-subagents
  Task: { owner: "mmr-subagents" },
  finder: { owner: "mmr-subagents" },
  oracle: { owner: "mmr-subagents" },
  cthulu: { owner: "mmr-subagents" },
  librarian: { owner: "mmr-subagents" },
  // mmr-history
  find_session: { owner: "mmr-history" },
  read_session: { owner: "mmr-history" },
  handoff: { owner: "mmr-history" },
  // mmr-skills
  skill: { owner: "mmr-skills" },
};

export interface MmrToolRegistry {
  /** Register an extension-owned status provider. Later registrations take precedence. */
  registerProvider(provider: MmrToolProvider): void;
  resolve(requestedTools: readonly string[], availableTools: readonly string[]): MmrToolResolution;
  isToolAllowed(toolName: string, resolution: Pick<MmrToolResolution, "activeTools">): boolean;
  getProviders(): MmrToolProvider[];
}

interface MatchedRule {
  rule: MmrToolRule;
  owner: string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function applyRule(toolName: string, owner: string, rule: MmrToolRule, available: ReadonlySet<string>): MmrToolDecision {
  switch (rule.kind) {
    case "active":
      if (available.has(toolName)) {
        return {
          requested: toolName,
          chosen: toolName,
          chosenTools: [toolName],
          candidates: [toolName],
          status: "active",
          owner,
          diagnostic: `${toolName} → ${toolName}`,
        };
      }
      return {
        requested: toolName,
        chosenTools: [],
        candidates: [toolName],
        status: "missing",
        owner,
        diagnostic: `${toolName}: claimed by ${owner} but no Pi tool with this name is registered`,
      };
    case "deferred":
      return {
        requested: toolName,
        chosenTools: [],
        candidates: [],
        status: "deferred",
        owner,
        diagnostic: `${toolName}: deferred until ${rule.reason} ships`,
      };
    case "gated":
      return {
        requested: toolName,
        chosenTools: [],
        candidates: [],
        status: "gated",
        owner,
        diagnostic: rule.gate
          ? `${toolName}: gated behind ${rule.gate} (${rule.reason})`
          : `${toolName}: gated (${rule.reason})`,
      };
    case "disabled":
      return {
        requested: toolName,
        chosenTools: [],
        candidates: [],
        status: "disabled",
        owner,
        diagnostic: `${toolName}: disabled (${rule.reason})`,
      };
  }
}

function activeDecision(toolName: string, owner: string): MmrToolDecision {
  return {
    requested: toolName,
    chosen: toolName,
    chosenTools: [toolName],
    candidates: [toolName],
    status: "active",
    owner,
    diagnostic: `${toolName} → ${toolName}`,
  };
}

function missingDecision(toolName: string): MmrToolDecision {
  return {
    requested: toolName,
    chosenTools: [],
    candidates: [],
    status: "missing",
    owner: CORE_OWNER,
    diagnostic: `${toolName}: no Pi tool with this name is registered`,
  };
}

export function createMmrToolRegistry(): MmrToolRegistry {
  // Provider stack with latest-registered last; latest wins.
  const providers: MmrToolProvider[] = [];

  function lookupProviderRule(rawToolName: string): MatchedRule | undefined {
    // Trim once at the entry point so a name like `"  apply_patch  "`
    // (e.g. surfaced from a config file or mode definition) does not
    // silently miss a provider that compares against the trimmed key.
    const toolName = rawToolName.trim();
    if (toolName === "") return undefined;
    for (let i = providers.length - 1; i >= 0; i -= 1) {
      const provider = providers[i];
      const rule = provider.resolve(toolName);
      if (rule) return { rule, owner: provider.name };
    }
    return undefined;
  }

  return {
    registerProvider(provider) {
      providers.push(provider);
    },

    resolve(requestedTools, availableTools) {
      const available = new Set(availableTools);
      const decisions: MmrToolDecision[] = [];
      const activeTools: string[] = [];
      const missingTools: string[] = [];
      const deferredTools: string[] = [];
      const gatedTools: string[] = [];
      const disabledTools: string[] = [];

      for (const requested of requestedTools) {
        const trimmed = requested.trim();
        if (trimmed === "") continue;
        const matched = lookupProviderRule(trimmed);
        let decision: MmrToolDecision;
        if (matched) {
          // Provider claims this tool. The rule decides status; for `active`
          // the registry confirms by identity match.
          decision = applyRule(trimmed, matched.owner, matched.rule, available);
        } else if (available.has(trimmed)) {
          // Identity match against Pi's live tool inventory. The owner is
          // the catalog owner when one exists (so /mmr-status credits the
          // shipping extension), else mmr-core.
          const catalogEntry = Object.hasOwn(DEFAULT_TOOL_CATALOG, trimmed)
            ? DEFAULT_TOOL_CATALOG[trimmed]
            : undefined;
          decision = activeDecision(trimmed, catalogEntry?.owner ?? CORE_OWNER);
        } else if (Object.hasOwn(DEFAULT_TOOL_CATALOG, trimmed)) {
          // Known extension-owned tool whose owning extension has not
          // shipped or registered it yet.
          const owner = DEFAULT_TOOL_CATALOG[trimmed].owner;
          decision = {
            requested: trimmed,
            chosenTools: [],
            candidates: [],
            status: "deferred",
            owner,
            diagnostic: `${trimmed}: deferred until ${owner} ships`,
          };
        } else {
          decision = missingDecision(trimmed);
        }
        decisions.push(decision);

        switch (decision.status) {
          case "active":
            activeTools.push(...decision.chosenTools);
            break;
          case "missing":
            missingTools.push(trimmed);
            break;
          case "deferred":
            deferredTools.push(trimmed);
            break;
          case "gated":
            gatedTools.push(trimmed);
            break;
          case "disabled":
            disabledTools.push(trimmed);
            break;
        }
      }

      return {
        requestedTools: [...requestedTools],
        activeTools: unique(activeTools),
        missingTools: unique(missingTools),
        deferredTools: unique(deferredTools),
        gatedTools: unique(gatedTools),
        disabledTools: unique(disabledTools),
        decisions,
      };
    },

    isToolAllowed(toolName, resolution) {
      return resolution.activeTools.includes(toolName);
    },

    getProviders() {
      return [...providers];
    },
  };
}

export function isMmrToolAllowed(toolName: string, resolution: Pick<MmrToolResolution, "activeTools">): boolean {
  return resolution.activeTools.includes(toolName);
}

/**
 * Module-level resolver. Builds a fresh registry on each call so module-level
 * registrations never leak into runtime callers and vice versa.
 */
export function resolveMmrTools(
  requestedTools: readonly string[],
  availableTools: readonly string[],
): MmrToolResolution {
  const registry = createMmrToolRegistry();
  return registry.resolve(requestedTools, availableTools);
}
