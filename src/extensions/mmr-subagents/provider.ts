import type { MmrFeatureGateProvider, MmrToolProvider, MmrToolRule } from "../mmr-core/types.js";
import { LIBRARIAN_GATING_REASON } from "./librarian.js";
import { MMR_CUSTOM_SUBAGENT_TOOL_PREFIX } from "./custom-loader.js";

export const MMR_SUBAGENTS_PROVIDER_NAME = "mmr-subagents";
export const MMR_SUBAGENTS_FEATURE_GATE = "mmr-subagents";

/**
 * Logical tool names owned by `mmr-subagents`. Mirrors the deferred entries
 * in `mmr-core`'s default tool rules so the runtime override stays narrow:
 * the provider returns `undefined` for any other logical name and never
 * shadows unrelated providers.
 */
export const MMR_SUBAGENTS_OWNED_TOOLS: ReadonlyArray<
  | "Task"
  | "finder"
  | "oracle"
  | "librarian"
> = [
  "Task",
  "finder",
  "oracle",
  "librarian",
];

const OWNED_TOOLS_SET: ReadonlySet<string> = new Set<string>(MMR_SUBAGENTS_OWNED_TOOLS);

/**
 * Per-tool ship state. Each entry is `true` when the matching concrete Pi
 * tool is registered by this extension; the provider then claims the
 * name with `{ kind: "active" }` so the registry credits mmr-subagents
 * as owner and confirms by identity match against the live Pi inventory.
 * The default value of every flag is `false`, which preserves the
 * shell-slice behavior for callers that build the providers without
 * arguments (every owned tool reports `gated`).
 */
type MmrSubagentsCapability = boolean | (() => boolean);

export interface MmrSubagentsCapabilities {
  finder?: MmrSubagentsCapability;
  oracle?: MmrSubagentsCapability;
  Task?: MmrSubagentsCapability;
  librarian?: MmrSubagentsCapability;
  /** Runtime-discovered custom Markdown subagent tool names (`sa__*`). */
  customTools?: readonly string[] | (() => readonly string[]);
}

function readCapability(value: MmrSubagentsCapability | undefined): boolean {
  if (typeof value === "function") {
    try {
      return Boolean(value());
    } catch {
      return false;
    }
  }
  return Boolean(value);
}

function readCustomTools(capabilities: MmrSubagentsCapabilities): readonly string[] {
  const tools = capabilities.customTools;
  if (typeof tools === "function") {
    try {
      return tools();
    } catch {
      return [];
    }
  }
  return tools ?? [];
}

function isCapabilityActive(capabilities: MmrSubagentsCapabilities, name: string): boolean {
  switch (name) {
    case "finder":
      return readCapability(capabilities.finder);
    case "oracle":
      return readCapability(capabilities.oracle);
    case "Task":
      return readCapability(capabilities.Task);
    case "librarian":
      return readCapability(capabilities.librarian);
    default:
      return false;
  }
}

function formatActiveCapabilities(capabilities: MmrSubagentsCapabilities): string {
  const active: string[] = MMR_SUBAGENTS_OWNED_TOOLS.filter((name) => isCapabilityActive(capabilities, name));
  const custom = readCustomTools(capabilities);
  if (custom.length > 0) active.push(`${custom.length} custom Markdown subagent${custom.length === 1 ? "" : "s"}`);
  return active.length === 0 ? "" : active.join(", ");
}

/**
 * Feature-gate provider for `mmr-subagents`.
 *
 * Returns `enabled` when at least one owned worker tool has shipped (per
 * the `capabilities` argument); otherwise reports `disabled` with the
 * shell-slice reason. Default-args callers get the shell behavior so the
 * provider works the same way for tests that exercise an empty extension.
 */
export function createMmrSubagentsFeatureGateProvider(
  capabilities: MmrSubagentsCapabilities = {},
): MmrFeatureGateProvider {
  return {
    name: MMR_SUBAGENTS_PROVIDER_NAME,
    evaluate(gate) {
      if (gate !== MMR_SUBAGENTS_FEATURE_GATE) return undefined;
      const active = formatActiveCapabilities(capabilities);
      if (active.length === 0) {
        return {
          gate,
          status: "disabled",
          reason: "mmr-subagents is loaded; worker tools are not yet implemented.",
        };
      }
      return {
        gate,
        status: "enabled",
        reason: `mmr-subagents worker tools available: ${active}.`,
      };
    },
  };
}

/**
 * Tool provider for `mmr-subagents`.
 *
 * For every owned tool, the rule returned depends on whether the matching
 * capability is active. Active capabilities defer to identity-match
 * resolution against Pi's live tool inventory (the mmr-core status
 * catalog credits mmr-subagents as the owner); inactive capabilities
 * return `gated` against `mmr-subagents` with a per-tool reason.
 * `librarian` is active only while its required mmr-web-owned tools are
 * registered; execute-time checks still fail closed if those tools are not
 * currently active in the parent process. Future repository-provider variants
 * can add their own provider rules.
 */
export function createMmrSubagentsToolProvider(
  capabilities: MmrSubagentsCapabilities = {},
): MmrToolProvider {
  return {
    name: MMR_SUBAGENTS_PROVIDER_NAME,
    resolve(toolName): MmrToolRule | undefined {
      if (toolName.startsWith(MMR_CUSTOM_SUBAGENT_TOOL_PREFIX)) {
        return readCustomTools(capabilities).includes(toolName) ? { kind: "active" } : undefined;
      }
      if (!OWNED_TOOLS_SET.has(toolName)) return undefined;
      if (isCapabilityActive(capabilities, toolName)) {
        return { kind: "active" };
      }
      return {
        kind: "gated",
        gate: MMR_SUBAGENTS_FEATURE_GATE,
        reason: toolName === "librarian"
          ? LIBRARIAN_GATING_REASON
          : `${toolName}: implementation pending in mmr-subagents.`,
      };
    },
  };
}
