import type { MmrCustomSubagentDefinition } from "./custom-loader.js";
import {
  MMR_CUSTOM_SUBAGENT_RECOMMENDED_READONLY_TOOLS,
  MMR_CUSTOM_SUBAGENT_TOOL_ALIASES,
  isUnsafeMmrCustomSubagentToolPattern,
} from "./custom-loader.js";

/** Per-token classification produced while mapping a source `tools:` list. */
export type MmrImportToolStatus = "mapped" | "kept" | "blocked" | "unknown";

export interface MmrImportToolResult {
  /** The original source token. */
  readonly source: string;
  /** The resolved Pi tool name (absent when blocked or unknown). */
  readonly tool?: string;
  readonly status: MmrImportToolStatus;
  /** Human-readable explanation for non-`kept`/`mapped` statuses. */
  readonly note?: string;
}

export type MmrImportDiagnosticSeverity = "error" | "warning" | "info";

export interface MmrImportDiagnostic {
  readonly severity: MmrImportDiagnosticSeverity;
  readonly message: string;
}

export interface MapImportToolsArgs {
  readonly tokens: readonly string[];
  /**
   * Concrete Pi tool names registered/active in the parent. When provided, a
   * token that is neither an alias nor a known tool is reported `unknown` so
   * the wizard can ask the user to map, drop, or cancel. When omitted, unknown
   * detection is skipped and non-blocked tokens are `kept` as-is.
   */
  readonly availableTools?: readonly string[];
}

export interface MapImportToolsResult {
  /** Safe, deduped Pi tool names to grant (excludes blocked/unknown). */
  readonly tools: string[];
  readonly results: MmrImportToolResult[];
  readonly diagnostics: MmrImportDiagnostic[];
}

/**
 * Map a source subagent `tools:` list onto safe Pi tool names. Claude aliases
 * are rewritten (`Read`→`read`, …); recursive/advisory/MCP/mutation tools are
 * blocked; tokens unknown to the parent inventory are surfaced for user
 * resolution. The returned `tools` contains only safe, resolvable names.
 */
export function mapImportTools(args: MapImportToolsArgs): MapImportToolsResult {
  const known = args.availableTools ? new Set(args.availableTools) : undefined;
  const results: MmrImportToolResult[] = [];
  const diagnostics: MmrImportDiagnostic[] = [];
  const tools: string[] = [];
  const seen = new Set<string>();

  for (const rawToken of args.tokens) {
    const token = typeof rawToken === "string" ? rawToken.trim() : "";
    if (token.length === 0) continue;

    if (isUnsafeMmrCustomSubagentToolPattern(token)) {
      results.push({ source: token, status: "blocked", note: "recursive, advisory, MCP, or mutation tool is not allowed for custom subagents" });
      diagnostics.push({ severity: "error", message: `Tool "${token}" is blocked for custom subagents and was dropped.` });
      continue;
    }

    const alias = MMR_CUSTOM_SUBAGENT_TOOL_ALIASES.get(token);
    const mapped = alias ?? token;

    if (alias && isUnsafeMmrCustomSubagentToolPattern(mapped)) {
      results.push({ source: token, status: "blocked", note: `maps to blocked tool "${mapped}"` });
      diagnostics.push({ severity: "error", message: `Tool "${token}" maps to blocked tool "${mapped}" and was dropped.` });
      continue;
    }

    if (known && !known.has(mapped)) {
      results.push({ source: token, status: "unknown", note: "no matching Pi tool in the active inventory" });
      diagnostics.push({ severity: "warning", message: `Tool "${token}" has no matching Pi tool; map it, drop it, or cancel the import.` });
      continue;
    }

    if (seen.has(mapped)) continue;
    seen.add(mapped);
    tools.push(mapped);
    results.push(alias ? { source: token, tool: mapped, status: "mapped" } : { source: token, tool: mapped, status: "kept" });
  }

  return { tools, results, diagnostics };
}

export interface MmrCustomSubagentImportPlan {
  /** Display name from the source definition. */
  readonly name: string;
  /** Description used as tool guidance. */
  readonly description: string;
  /** Recommended `sa__*` tool name. */
  readonly toolName: string;
  /** Recommended model string (`inherit` or `provider/model`). */
  readonly model: string;
  /** Whether the source declared a model (vs. defaulted to inherit). */
  readonly modelDeclared: boolean;
  /** Recommended thinking level, when the source declared a valid one. */
  readonly thinkingLevel?: MmrCustomSubagentDefinition["thinkingLevel"];
  /** Recommended worker tools after mapping. */
  readonly tools: string[];
  readonly toolResults: MmrImportToolResult[];
  readonly diagnostics: MmrImportDiagnostic[];
  /** Absolute source Markdown path (external or Pi-owned). */
  readonly sourcePath: string;
}

export interface PlanImportArgs {
  readonly definition: MmrCustomSubagentDefinition;
  readonly availableTools?: readonly string[];
  /** Available model routes (`provider/model`), used to flag an unavailable declared model. */
  readonly availableModels?: readonly string[];
}

/**
 * Build a recommended import plan from a parsed source subagent definition.
 * The plan recommends; the wizard lets the user override every field before a
 * config record is written. Diagnostics surface blocked tools, unknown tools,
 * an unavailable declared model, and a missing/empty toolset.
 */
export function planMmrCustomSubagentImport(args: PlanImportArgs): MmrCustomSubagentImportPlan {
  const { definition } = args;
  const diagnostics: MmrImportDiagnostic[] = [];

  let tools: string[];
  let toolResults: MmrImportToolResult[];
  if (definition.toolsDeclared) {
    const mapping = mapImportTools({ tokens: definition.toolPatterns, ...(args.availableTools ? { availableTools: args.availableTools } : {}) });
    tools = mapping.tools;
    toolResults = mapping.results;
    diagnostics.push(...mapping.diagnostics);
    if (tools.length === 0 && definition.toolPatterns.length > 0) {
      diagnostics.push({ severity: "warning", message: "All declared tools were blocked or unknown; recommending a read-only toolset instead." });
      tools = [...MMR_CUSTOM_SUBAGENT_RECOMMENDED_READONLY_TOOLS];
    }
  } else {
    // Source declared no tools. Do NOT grant all tools; recommend read-only.
    diagnostics.push({ severity: "info", message: "Source declared no tools; recommending a least-privilege read-only toolset (read, find, grep)." });
    tools = [...MMR_CUSTOM_SUBAGENT_RECOMMENDED_READONLY_TOOLS];
    toolResults = [];
  }

  if (definition.modelDeclared && definition.model !== "inherit" && args.availableModels) {
    const available = args.availableModels;
    const target = definition.model;
    const tail = target.split("/").pop() ?? target;
    const found = available.some((entry) => entry === target || entry.endsWith(`/${tail}`) || entry === tail);
    if (!found) {
      diagnostics.push({ severity: "warning", message: `Declared model "${definition.model}" is not available; recommend inherit or pick an available route.` });
    }
  }

  return {
    name: definition.name,
    description: definition.description,
    toolName: definition.toolName,
    model: definition.model,
    modelDeclared: definition.modelDeclared,
    ...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {}),
    tools,
    toolResults,
    diagnostics,
    sourcePath: definition.filePath,
  };
}
