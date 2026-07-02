import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getProjectMmrSettingsPath } from "../mmr-core/config-writer.js";
import { isMmrModeKey } from "../mmr-core/modes.js";
import { isThinkingLevel } from "../mmr-core/settings.js";
import type { MmrLockedModeKey } from "../mmr-core/types.js";
import {
  MMR_CUSTOM_SUBAGENT_DEFAULT_TOOLS,
  toMmrCustomSubagentToolName,
} from "./custom-loader.js";
import {
  type MmrCustomSubagentConfigInput,
  type MmrCustomSubagentModeScope,
  type MmrCustomSubagentSourceRoot,
  getPiOwnedSubagentRoots,
  writeMmrSubagentsConfigRecord,
} from "./custom-config.js";
import {
  type MmrCustomSubagentImportPlan,
  mapImportTools,
  planMmrCustomSubagentImport,
} from "./custom-import.js";
import {
  type MmrCustomSubagentCandidate,
  discoverMmrCustomSubagentCandidates,
} from "./custom-runtime.js";

const CANCEL = "— cancel —";

/** Derive a stable record id / filename slug from a subagent display name. */
export function importIdForName(name: string): string {
  const tool = toMmrCustomSubagentToolName(name);
  return tool.replace(/^sa__/, "");
}

export interface ImportDestination {
  root: MmrCustomSubagentSourceRoot;
  /** Relative file under the Pi-owned root. */
  file: string;
  /** Absolute destination path. */
  absPath: string;
  /** Whether the source already lives at the destination (enable-in-place). */
  alreadyAtDest: boolean;
}

/**
 * Resolve where an imported subagent's Markdown will live and whether a copy is
 * needed. A source already inside the chosen Pi-owned root is enabled in place;
 * any other source (legacy Claude dir, manual path) is copied in.
 */
export function resolveImportDestination(args: {
  plan: Pick<MmrCustomSubagentImportPlan, "name" | "sourcePath">;
  destination: MmrCustomSubagentSourceRoot;
  cwd: string;
  homeDir?: string;
}): ImportDestination {
  const homeDir = args.homeDir ?? homedir();
  const roots = getPiOwnedSubagentRoots(args.cwd, homeDir);
  const rootDir = args.destination === "global" ? roots.global : roots.project;
  const source = path.resolve(args.plan.sourcePath);
  // A source already inside the chosen Pi-owned root (at any depth) is enabled
  // in place. Containment holds when the relative path is non-empty, has no
  // leading ".." escape segment, and is not absolute; the relative path itself
  // becomes source.file so a nested candidate keeps its on-disk location.
  const relativeToRoot = path.relative(rootDir, source);
  const alreadyAtDest =
    relativeToRoot.length > 0 && !relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot);
  const file = alreadyAtDest ? relativeToRoot : `${importIdForName(args.plan.name)}.md`;
  return {
    root: args.destination,
    file,
    absPath: path.join(rootDir, file),
    alreadyAtDest,
  };
}

export interface ImportChoices {
  toolName: string;
  model: string;
  thinkingLevel?: string;
  tools: readonly string[];
  modes: MmrCustomSubagentModeScope;
  projects?: "all" | readonly string[];
  destination: ImportDestination;
}

/**
 * Build the persisted config record from a plan and the user's choices. Pure so
 * the wizard's decisions can be unit-tested without driving the interactive UI.
 */
export function buildImportConfigInput(
  plan: MmrCustomSubagentImportPlan,
  choices: ImportChoices,
): { id: string; input: MmrCustomSubagentConfigInput } {
  const id = importIdForName(plan.name);
  const thinking = choices.thinkingLevel && isThinkingLevel(choices.thinkingLevel) ? choices.thinkingLevel : undefined;
  return {
    id,
    input: {
      enabled: true,
      source: { root: choices.destination.root, file: choices.destination.file },
      toolName: choices.toolName,
      modes: choices.modes,
      ...(choices.destination.root === "global" ? { projects: choices.projects ?? "all" } : {}),
      model: choices.model,
      ...(thinking ? { thinkingLevel: thinking } : {}),
      tools: [...choices.tools],
    },
  };
}

function listAvailableModelRoutes(ctx: ExtensionContext): string[] {
  try {
    const models = ctx.modelRegistry.getAvailable() as { provider?: string; id?: string }[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const model of models) {
      if (!model || typeof model.provider !== "string" || typeof model.id !== "string") continue;
      const label = `${model.provider}/${model.id}`;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  } catch {
    return [];
  }
}

function parseModeList(raw: string): MmrLockedModeKey[] | undefined {
  const tokens = raw.split(",").map((token) => token.trim()).filter(Boolean);
  const modes: MmrLockedModeKey[] = [];
  for (const token of tokens) {
    if (!isMmrModeKey(token) || token === "open" || token === "free") return undefined;
    if (!modes.includes(token as MmrLockedModeKey)) modes.push(token as MmrLockedModeKey);
  }
  return modes.length > 0 ? modes : undefined;
}

async function pickTools(
  ctx: ExtensionContext,
  plan: MmrCustomSubagentImportPlan,
  availableTools: readonly string[] | undefined,
): Promise<readonly string[] | undefined> {
  const recommended = plan.tools.join(", ") || "none";
  const choice = await ctx.ui.select(`Worker tools (recommended: ${recommended})`, [
    `recommended (${recommended})`,
    "read-only (read, find, grep)",
    "read + web (read, find, grep, web_search, read_web_page)",
    "standard (read, bash, edit, write, find, grep, web)",
    "custom (enter a comma-separated list)",
    "none (prompt-only)",
    CANCEL,
  ]);
  if (!choice || choice === CANCEL) return undefined;
  if (choice.startsWith("recommended")) return plan.tools;
  if (choice.startsWith("read-only")) return ["read", "find", "grep"];
  if (choice.startsWith("read + web")) return ["read", "find", "grep", "web_search", "read_web_page"];
  if (choice.startsWith("standard")) return [...MMR_CUSTOM_SUBAGENT_DEFAULT_TOOLS];
  if (choice.startsWith("none")) return [];
  const raw = await ctx.ui.input("Tools (comma-separated Pi tool names)", "read, find, grep");
  if (raw === undefined) return undefined;
  const mapped = mapImportTools({ tokens: raw.split(","), ...(availableTools ? { availableTools } : {}) });
  for (const diag of mapped.diagnostics) ctx.ui.notify(diag.message, diag.severity === "error" ? "error" : "warning");
  return mapped.tools;
}

/** Whether a settings file already contains a custom subagent record with `id`. */
function recordIdExists(settingsPath: string, id: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const flat = parsed.mmrSubagents as { custom?: { agents?: Record<string, unknown> } } | undefined;
    const nested = (parsed.mmr as { subagents?: { custom?: { agents?: Record<string, unknown> } } } | undefined)?.subagents;
    const agents = flat?.custom?.agents ?? nested?.custom?.agents;
    return Boolean(agents && Object.prototype.hasOwnProperty.call(agents, id));
  } catch {
    return false;
  }
}

async function pickModes(ctx: ExtensionContext): Promise<MmrCustomSubagentModeScope | undefined> {
  const choice = await ctx.ui.select("Modes that may call this subagent", [
    "allLocked (every locked mode)",
    "deep",
    "smart",
    "custom (enter a comma-separated list)",
    CANCEL,
  ]);
  if (!choice || choice === CANCEL) return undefined;
  if (choice.startsWith("allLocked")) return "allLocked";
  if (choice === "deep") return ["deep"];
  if (choice === "smart") return ["smart"];
  const raw = await ctx.ui.input("Modes (comma-separated: smart, smartGPT, smartSonnet, smartFable, rush, test, large, deep)", "deep");
  if (raw === undefined) return undefined;
  const modes = parseModeList(raw);
  if (!modes) {
    ctx.ui.notify("No valid locked modes entered; expected smart, smartGPT, smartSonnet, smartFable, rush, test, large, or deep.", "error");
    return undefined;
  }
  return modes;
}

function describeCandidate(candidate: MmrCustomSubagentCandidate): string {
  const where = candidate.sourceKind === "claude" ? "Claude" : candidate.sourceKind === "pi-global" ? "Pi global" : "Pi project";
  return `${candidate.definition.name} — ${where} — ${path.basename(candidate.definition.filePath)}`;
}

/**
 * Interactive setup/import flow for custom Markdown subagents. Surfaced through
 * `/mmr-config`'s "subagent (setup/import)" branch. Scans Pi-owned and legacy
 * Claude roots for candidates, lets the user select one, recommends
 * model/thinking/tools, asks for modes/project scope, copies the Markdown into
 * a Pi-owned root when needed, and writes an enabled config record. Discovery
 * never registers anything by itself; only the written record enables a
 * subagent on the next session.
 */
export interface MmrSubagentsConfigFlowOptions {
  /** Registered Pi tool names, used to flag unknown imported tools. */
  getAvailableTools?: () => readonly string[];
}

export async function runMmrCustomSubagentsConfigFlow(
  ctx: ExtensionContext,
  options: MmrSubagentsConfigFlowOptions = {},
): Promise<void> {
  if (ctx.hasUI === false) {
    ctx.ui.notify("Custom subagent setup/import requires an interactive UI.", "warning");
    return;
  }

  let availableTools: readonly string[] | undefined;
  try {
    availableTools = options.getAvailableTools?.();
  } catch {
    availableTools = undefined;
  }

  const candidates = discoverMmrCustomSubagentCandidates(ctx.cwd);
  if (candidates.length === 0) {
    ctx.ui.notify(
      `No custom subagent candidates found. Drop a Markdown subagent into ${getPiOwnedSubagentRoots(ctx.cwd).project} or ${getPiOwnedSubagentRoots(ctx.cwd).global}, or a Claude .claude/agents directory, then re-run setup.`,
      "info",
    );
    return;
  }

  const labels = candidates.map(describeCandidate);
  const selection = await ctx.ui.select("Import / enable a custom subagent", [...labels, CANCEL]);
  if (!selection || selection === CANCEL) return;
  const candidate = candidates[labels.indexOf(selection)];
  if (!candidate) return;

  const plan = planMmrCustomSubagentImport({
    definition: candidate.definition,
    availableModels: listAvailableModelRoutes(ctx),
    ...(availableTools ? { availableTools } : {}),
  });
  for (const diag of plan.diagnostics) {
    ctx.ui.notify(diag.message, diag.severity === "error" ? "error" : diag.severity === "warning" ? "warning" : "info");
  }

  const destChoice = await ctx.ui.select("Where should this subagent live?", [
    "project (.pi/subagents — this project only)",
    "global (~/.pi/agent/subagents — available to configured projects)",
    CANCEL,
  ]);
  if (!destChoice || destChoice === CANCEL) return;
  const destination: MmrCustomSubagentSourceRoot = destChoice.startsWith("global") ? "global" : "project";

  const modelRoutes = listAvailableModelRoutes(ctx);
  const modelChoice = await ctx.ui.select(`Model (recommended: ${plan.model})`, ["inherit (use the parent model)", ...modelRoutes, CANCEL]);
  if (!modelChoice || modelChoice === CANCEL) return;
  const model = modelChoice.startsWith("inherit") ? "inherit" : modelChoice;

  const thinkingChoice = await ctx.ui.select(`Thinking level (recommended: ${plan.thinkingLevel ?? "(none)"})`, [
    "(none — inherit parent/default)",
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    CANCEL,
  ]);
  if (!thinkingChoice || thinkingChoice === CANCEL) return;
  const thinkingLevel = isThinkingLevel(thinkingChoice) ? thinkingChoice : undefined;

  const tools = await pickTools(ctx, plan, availableTools);
  if (tools === undefined) return;

  const modes = await pickModes(ctx);
  if (!modes) return;

  let projects: "all" | readonly string[] | undefined;
  if (destination === "global") {
    const projChoice = await ctx.ui.select("Which projects may use this subagent?", [
      "this project only",
      "all projects",
      CANCEL,
    ]);
    if (!projChoice || projChoice === CANCEL) return;
    projects = projChoice.startsWith("all") ? "all" : [path.resolve(ctx.cwd)];
  }

  const dest = resolveImportDestination({ plan, destination, cwd: ctx.cwd });
  const { id, input } = buildImportConfigInput(plan, {
    toolName: plan.toolName,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    tools,
    modes,
    ...(projects ? { projects } : {}),
    destination: dest,
  });

  // Confirm before overwriting an existing Markdown file at the destination.
  if (!dest.alreadyAtDest && existsSync(dest.absPath)) {
    const overwrite = await ctx.ui.confirm(
      "Overwrite existing subagent file?",
      `${dest.absPath} already exists. Overwrite it with ${path.basename(plan.sourcePath)}?`,
    );
    if (!overwrite) return;
  }

  // Copy the Markdown into the Pi-owned root when it is not already there.
  if (!dest.alreadyAtDest) {
    try {
      mkdirSync(path.dirname(dest.absPath), { recursive: true });
      copyFileSync(plan.sourcePath, dest.absPath);
    } catch (error) {
      ctx.ui.notify(`Failed to copy subagent Markdown to ${dest.absPath}: ${(error as Error).message}`, "error");
      return;
    }
  }

  const settingsPath = destination === "global"
    ? path.join(homedir(), ".pi", "agent", "settings.json")
    : getProjectMmrSettingsPath(ctx.cwd);

  // Confirm before replacing an existing config record with the same id.
  if (existsSync(settingsPath) && recordIdExists(settingsPath, id)) {
    const replace = await ctx.ui.confirm(
      "Replace existing subagent config?",
      `A custom subagent record "${id}" already exists in ${settingsPath}. Replace it?`,
    );
    if (!replace) return;
  }

  try {
    writeMmrSubagentsConfigRecord(settingsPath, id, input);
  } catch (error) {
    ctx.ui.notify(`Failed to write subagent config to ${settingsPath}: ${(error as Error).message}`, "error");
    return;
  }

  const modeSummary = input.modes === "allLocked" ? "all locked modes" : input.modes.join(", ");
  ctx.ui.notify(
    [
      `Enabled custom subagent "${plan.name}" as ${input.toolName}.`,
      `  Markdown: ${dest.absPath}`,
      `  Config:   ${settingsPath}`,
      `  Modes:    ${modeSummary}`,
      `  Model:    ${input.model}${input.thinkingLevel ? ` (thinking: ${input.thinkingLevel})` : ""}`,
      `  Tools:    ${input.tools && input.tools.length > 0 ? input.tools.join(", ") : "none (prompt-only)"}`,
      "Restart Pi for the new subagent to register (custom subagents are loaded once at extension activation).",
    ].join("\n"),
    "info",
  );
}
