import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isRecord } from "../mmr-core/internal/json.js";
import { rewriteJsonSettingsFile } from "../mmr-core/internal/settings-file.js";
import { isMmrModeKey } from "../mmr-core/modes.js";
import { isThinkingLevel } from "../mmr-core/settings.js";
import type { MmrLockedModeKey } from "../mmr-core/types.js";
import {
  MMR_CUSTOM_SUBAGENT_TOOL_PREFIX,
  toMmrCustomSubagentToolName,
} from "./custom-loader.js";

/**
 * Source root for a configured custom subagent's Markdown file.
 *
 * - `global` — `~/.pi/agent/subagents`
 * - `project` — `<cwd>/.pi/subagents`
 *
 * The root is resolved relative to the active project (cwd) and home
 * directory at load time, never persisted as an absolute path, so a config
 * record stays portable across machines and checkouts.
 */
export type MmrCustomSubagentSourceRoot = "global" | "project";

/** Settings keys that must never be treated as agent ids (prototype-pollution guard). */
const RESERVED_AGENT_IDS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/** Strict `sa__<slug>` tool-name shape: lowercase/digits/underscore, length-capped. */
const CUSTOM_SUBAGENT_TOOL_NAME_PATTERN = /^sa__[a-z0-9_]{1,60}$/;

/** Reject a relative source file with any `..` path segment or an absolute path. */
function isUnsafeRelativeSourceFile(file: string): boolean {
  if (path.isAbsolute(file)) return true;
  return file.split(/[\\/]/).some((segment) => segment === "..");
}

/** Mode-exposure selector: every locked mode, or an explicit locked-mode list. */
export type MmrCustomSubagentModeScope = "allLocked" | readonly MmrLockedModeKey[];

/** Project-exposure selector for global records: every project, or explicit cwd paths. */
export type MmrCustomSubagentProjectScope = "all" | readonly string[];

/**
 * A single enabled/configured custom subagent record, as persisted under
 * `mmrSubagents.custom.agents.<id>` in a Pi settings file. Config is the
 * enablement boundary: a Markdown file on disk is only registered as a
 * model-visible `sa__*` tool when an enabled record references it.
 */
export interface MmrCustomSubagentRecord {
  /** Stable record id (settings key). */
  readonly id: string;
  /** Whether the subagent is registered/model-visible. */
  readonly enabled: boolean;
  /** Pi-owned root + relative Markdown file. */
  readonly source: { readonly root: MmrCustomSubagentSourceRoot; readonly file: string };
  /** Concrete `sa__*` tool name exposed to the parent model. */
  readonly toolName: string;
  /** Locked modes that may call this subagent. */
  readonly modes: MmrCustomSubagentModeScope;
  /** Projects that may call this subagent (global records only; defaults to `all`). */
  readonly projects: MmrCustomSubagentProjectScope;
  /** `inherit`, a `provider/model` route, or a bare model id. Defaults to `inherit`. */
  readonly model: string;
  /** Provider-neutral Pi thinking level, when pinned. */
  readonly thinkingLevel?: ThinkingLevel;
  /**
   * Concrete worker tool allowlist. When omitted the markdown's effective
   * tools apply; an explicitly empty list runs prompt-only. Always present
   * after load when the config declared `tools`.
   */
  readonly tools?: readonly string[];
  /** Settings layer that contributed this record (last writer wins on merge). */
  readonly layer: MmrCustomSubagentSourceRoot;
}

export interface LoadMmrSubagentsConfigArgs {
  cwd: string;
  homeDir?: string;
}

export interface LoadedMmrSubagentsConfig {
  /** Merged records by id (project layer overrides global). */
  records: Map<string, MmrCustomSubagentRecord>;
  filesRead: string[];
  warnings: string[];
}

/** Pi-owned default subagent roots. Runtime discovery + setup write here. */
export function getPiOwnedSubagentRoots(cwd: string, homeDir: string = homedir()): {
  global: string;
  project: string;
} {
  return {
    global: path.join(homeDir, ".pi", "agent", "subagents"),
    project: path.join(cwd, ".pi", "subagents"),
  };
}

/** Absolute Markdown path for a record's source, resolved against cwd/home. */
export function resolveMmrCustomSubagentSourcePath(
  source: { root: MmrCustomSubagentSourceRoot; file: string },
  cwd: string,
  homeDir: string = homedir(),
): string {
  const roots = getPiOwnedSubagentRoots(cwd, homeDir);
  const root = source.root === "global" ? roots.global : roots.project;
  return path.join(root, source.file);
}

function settingsFilePaths(cwd: string, homeDir: string): { path: string; layer: MmrCustomSubagentSourceRoot }[] {
  return [
    { path: path.join(homeDir, ".pi", "agent", "settings.json"), layer: "global" },
    { path: path.join(cwd, ".pi", "settings.json"), layer: "project" },
  ];
}

function readAgentsBlock(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const flat = isRecord(value.mmrSubagents) ? value.mmrSubagents : undefined;
  const nested = isRecord(value.mmr) && isRecord((value.mmr as Record<string, unknown>).subagents)
    ? ((value.mmr as Record<string, unknown>).subagents as Record<string, unknown>)
    : undefined;
  const subagents = flat ?? nested;
  if (!subagents) return undefined;
  const custom = isRecord(subagents.custom) ? subagents.custom : undefined;
  if (!custom) return undefined;
  const agents = isRecord(custom.agents) ? custom.agents : undefined;
  return agents;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function normalizeModeScope(
  value: unknown,
  ctx: { id: string; filePath: string; warnings: string[] },
): MmrCustomSubagentModeScope | undefined {
  if (value === "allLocked") return "allLocked";
  if (!Array.isArray(value)) {
    ctx.warnings.push(
      `Ignoring mmrSubagents.custom.agents.${ctx.id}.modes in ${ctx.filePath}: expected "allLocked" or an array of locked mode keys.`,
    );
    return undefined;
  }
  const modes: MmrLockedModeKey[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !isMmrModeKey(entry) || entry === "open" || entry === "free") {
      ctx.warnings.push(
        `Ignoring invalid mode "${String(entry)}" for mmrSubagents.custom.agents.${ctx.id} in ${ctx.filePath}: expected a locked mode key (smart, smartGPT, rush, test, large, deep).`,
      );
      continue;
    }
    if (!modes.includes(entry)) modes.push(entry);
  }
  return modes;
}

function normalizeProjectScope(
  value: unknown,
  ctx: { id: string; filePath: string; warnings: string[] },
): MmrCustomSubagentProjectScope {
  if (value === "all" || value === undefined) return "all";
  const list: string[] = [];
  const seen = new Set<string>();
  for (const entry of normalizeStringList(value)) {
    if (!path.isAbsolute(entry)) {
      ctx.warnings.push(
        `Ignoring relative project path "${entry}" for mmrSubagents.custom.agents.${ctx.id} in ${ctx.filePath}: global "projects" entries must be absolute cwd paths.`,
      );
      continue;
    }
    const resolved = path.resolve(entry);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      list.push(resolved);
    }
  }
  return list;
}

function parseRecord(
  id: string,
  raw: unknown,
  layer: MmrCustomSubagentSourceRoot,
  ctx: { filePath: string; warnings: string[] },
): MmrCustomSubagentRecord | undefined {
  if (!isRecord(raw)) {
    ctx.warnings.push(
      `Ignoring mmrSubagents.custom.agents.${id} in ${ctx.filePath}: expected an object.`,
    );
    return undefined;
  }
  const sourceRaw = isRecord(raw.source) ? raw.source : undefined;
  const rootRaw = sourceRaw?.root;
  const fileRaw = typeof sourceRaw?.file === "string" ? sourceRaw.file.trim() : "";
  const root: MmrCustomSubagentSourceRoot = rootRaw === "global" ? "global" : rootRaw === "project" ? "project" : layer;
  if (fileRaw.length === 0) {
    ctx.warnings.push(
      `Ignoring mmrSubagents.custom.agents.${id} in ${ctx.filePath}: missing source.file.`,
    );
    return undefined;
  }
  if (isUnsafeRelativeSourceFile(fileRaw)) {
    ctx.warnings.push(
      `Ignoring mmrSubagents.custom.agents.${id} in ${ctx.filePath}: source.file must be a relative path inside the Pi-owned subagent root (no ".." segments, no absolute paths).`,
    );
    return undefined;
  }

  const modes = normalizeModeScope(raw.modes, { id, filePath: ctx.filePath, warnings: ctx.warnings });
  if (!modes) return undefined;

  const toolNameRaw = typeof raw.toolName === "string" ? raw.toolName.trim() : "";
  const toolName = toolNameRaw.length > 0 ? toolNameRaw : toMmrCustomSubagentToolName(id);
  if (!CUSTOM_SUBAGENT_TOOL_NAME_PATTERN.test(toolName)) {
    ctx.warnings.push(
      `Ignoring mmrSubagents.custom.agents.${id} in ${ctx.filePath}: toolName must match "${MMR_CUSTOM_SUBAGENT_TOOL_PREFIX}<slug>" (lowercase letters, digits, underscores; up to 60 slug chars).`,
    );
    return undefined;
  }

  const model = typeof raw.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : "inherit";
  const thinkingLevel: ThinkingLevel | undefined = isThinkingLevel(raw.thinkingLevel) ? raw.thinkingLevel : undefined;
  const tools = Array.isArray(raw.tools) ? normalizeStringList(raw.tools) : undefined;
  const projects = normalizeProjectScope(raw.projects, { id, filePath: ctx.filePath, warnings: ctx.warnings });

  return {
    id,
    enabled: raw.enabled === true,
    source: { root, file: fileRaw },
    toolName,
    modes,
    projects,
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(tools ? { tools } : {}),
    layer,
  };
}

/**
 * Load and merge `mmrSubagents.custom.agents` records from the global and
 * project Pi settings files. Project-layer records override global-layer
 * records that share an id. Records are normalized but not scope-filtered;
 * callers apply enablement and project-scope filtering separately.
 */
export function loadMmrSubagentsConfig(args: LoadMmrSubagentsConfigArgs): LoadedMmrSubagentsConfig {
  const homeDir = args.homeDir ?? homedir();
  const records = new Map<string, MmrCustomSubagentRecord>();
  const filesRead: string[] = [];
  const warnings: string[] = [];

  for (const { path: filePath, layer } of settingsFilePaths(args.cwd, homeDir)) {
    let raw: string | undefined;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warnings.push(`Could not read MMR settings from ${filePath}: ${(error as Error).message}`);
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      warnings.push(`Could not parse MMR settings from ${filePath}: ${(error as Error).message}`);
      continue;
    }
    const agents = readAgentsBlock(parsed);
    if (!agents) continue;
    filesRead.push(filePath);
    for (const [id, value] of Object.entries(agents)) {
      if (typeof id !== "string" || id.length === 0 || RESERVED_AGENT_IDS.has(id)) continue;
      const record = parseRecord(id, value, layer, { filePath, warnings });
      if (record) records.set(id, record);
    }
  }

  return { records, filesRead, warnings };
}

/**
 * Whether a global-layer record is in scope for the given project cwd. Project
 * records are always in scope (they are only loaded for their own project).
 */
export function isMmrCustomSubagentInScope(record: MmrCustomSubagentRecord, cwd: string): boolean {
  if (record.layer === "project") return true;
  if (record.projects === "all") return true;
  const target = path.resolve(cwd);
  return record.projects.some((entry) => path.resolve(entry) === target);
}

export interface ResolvedMmrCustomSubagentRecord {
  record: MmrCustomSubagentRecord;
  /** Absolute Markdown source path, resolved against cwd/home. */
  filePath: string;
  /** Absolute Pi-owned root directory the source must remain inside. */
  rootDir: string;
}

/**
 * Enabled, in-scope records for the active project, each with its resolved
 * absolute Markdown source path. Disabled or out-of-scope records are dropped.
 */
export function resolveEnabledMmrCustomSubagents(
  args: LoadMmrSubagentsConfigArgs,
): { resolved: ResolvedMmrCustomSubagentRecord[]; warnings: string[]; filesRead: string[] } {
  const homeDir = args.homeDir ?? homedir();
  const loaded = loadMmrSubagentsConfig({ cwd: args.cwd, homeDir });
  const resolved: ResolvedMmrCustomSubagentRecord[] = [];
  const seenToolNames = new Set<string>();
  for (const record of loaded.records.values()) {
    if (!record.enabled) continue;
    if (!isMmrCustomSubagentInScope(record, args.cwd)) continue;
    const modesEmpty = record.modes !== "allLocked" && record.modes.length === 0;
    if (modesEmpty) {
      loaded.warnings.push(
        `Custom subagent "${record.id}" is enabled but exposes no valid modes; it will not be registered.`,
      );
      continue;
    }
    if (seenToolNames.has(record.toolName)) {
      loaded.warnings.push(
        `Custom subagent "${record.id}" duplicates tool name "${record.toolName}"; skipping the later record.`,
      );
      continue;
    }
    seenToolNames.add(record.toolName);
    const roots = getPiOwnedSubagentRoots(args.cwd, homeDir);
    resolved.push({
      record,
      filePath: resolveMmrCustomSubagentSourcePath(record.source, args.cwd, homeDir),
      rootDir: record.source.root === "global" ? roots.global : roots.project,
    });
  }
  return { resolved, warnings: loaded.warnings, filesRead: loaded.filesRead };
}

/** Serializable shape of a record for persistence (drops derived `id`/`layer`). */
export interface MmrCustomSubagentConfigInput {
  enabled: boolean;
  source: { root: MmrCustomSubagentSourceRoot; file: string };
  toolName: string;
  modes: MmrCustomSubagentModeScope;
  projects?: MmrCustomSubagentProjectScope;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: readonly string[];
}

function recordToJson(input: MmrCustomSubagentConfigInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    enabled: input.enabled,
    source: { root: input.source.root, file: input.source.file },
    toolName: input.toolName,
    modes: input.modes === "allLocked" ? "allLocked" : [...input.modes],
  };
  if (input.projects && input.projects !== "all") out.projects = [...input.projects];
  else if (input.projects === "all") out.projects = "all";
  if (input.model && input.model !== "inherit") out.model = input.model;
  if (input.thinkingLevel) out.thinkingLevel = input.thinkingLevel;
  if (input.tools) out.tools = [...input.tools];
  return out;
}

/**
 * Insert or replace a single `mmrSubagents.custom.agents.<id>` record in a Pi
 * settings file. Preserves the existing flat (`mmrSubagents`) or nested
 * (`mmr.subagents`) layout, all unrelated keys, and other agent records. When
 * `record` is `undefined` the agent id is removed. Returns the file path.
 */
export function writeMmrSubagentsConfigRecord(
  filePath: string,
  id: string,
  record: MmrCustomSubagentConfigInput | undefined,
): string {
  if (RESERVED_AGENT_IDS.has(id)) {
    throw new Error(`Refusing to write reserved agent id "${id}".`);
  }
  return rewriteJsonSettingsFile(filePath, (existing) => {
    const root: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
    const flat = isRecord(root.mmrSubagents) ? { ...root.mmrSubagents } : undefined;
    const mmrBlock = isRecord(root.mmr) ? { ...root.mmr } : undefined;
    const nested = mmrBlock && isRecord(mmrBlock.subagents) ? { ...mmrBlock.subagents } : undefined;
    const useNested = !flat && Boolean(nested);

    const subagents: Record<string, unknown> = useNested ? nested ?? {} : flat ?? {};
    const custom: Record<string, unknown> = isRecord(subagents.custom) ? { ...subagents.custom } : {};
    const agents: Record<string, unknown> = isRecord(custom.agents) ? { ...custom.agents } : {};

    if (record === undefined) delete agents[id];
    else agents[id] = recordToJson(record);

    custom.agents = agents;
    subagents.custom = custom;

    if (useNested) {
      const nextMmr = { ...(mmrBlock ?? {}) };
      nextMmr.subagents = subagents;
      root.mmr = nextMmr;
    } else {
      root.mmrSubagents = subagents;
    }

    return root;
  });
}
