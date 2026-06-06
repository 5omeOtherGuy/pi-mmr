import fs, { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isThinkingLevel } from "../mmr-core/settings.js";
import {
  MMR_SUBAGENT_CUSTOM_DEFAULT_TOOLS,
  MMR_SUBAGENT_READ_ONLY_TOOLS,
  MMR_SUBAGENT_SHARED_DENY_TOOLS,
} from "../mmr-core/subagent-tool-policy.js";

export const MMR_CUSTOM_SUBAGENT_TOOL_PREFIX = "sa__";
export const MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH = 64;
export const DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_SCAN_DEPTH = 5;
// Match Claude Code's intended local-agent scale: user-authored agent
// directories are small curated sets, not package registries. Keep the scan
// bounded even when a workspace accidentally points at a large Markdown tree.
export const DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_FILES = 1000;
export const DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_DEFINITIONS = 100;
// Cap individual Markdown files at 256 KiB. Custom subagent
// definitions are short human-authored prompts; anything larger is
// almost certainly not a real subagent file and should not be parsed
// or held in memory by the loader.
export const MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES = 256 * 1024;

export interface MmrCustomSubagentDefinition {
  name: string;
  toolName: string;
  description: string;
  filePath: string;
  baseDir: string;
  systemPrompt: string;
  model: string;
  /**
   * Whether the frontmatter declared a `model` key at all. When false the
   * runtime falls back to the parent model and surfaces a notice
   * recommending the author pin one. An explicit `model: inherit` counts as
   * declared, so a deliberate inherit choice does not trigger the notice.
   */
  modelDeclared: boolean;
  /**
   * Thinking/effort level parsed from the `thinkingLevel`, `thinking`, or
   * `effort` frontmatter key (provider-neutral canonical Pi levels only).
   * Undefined when omitted or invalid, in which case the worker uses the
   * parent/default level and the runtime surfaces a notice.
   */
  thinkingLevel?: ThinkingLevel;
  toolPatterns: readonly string[];
  /**
   * Whether the Markdown frontmatter declared a tools key at all
   * (`tools`, `allowed-tools`, or `allowedTools`). When no tools key is
   * present the runtime grants the standard default toolset
   * (`MMR_CUSTOM_SUBAGENT_DEFAULT_TOOLS`); an explicitly empty list runs
   * with no tools. This flag lets the runtime tell "no tools field" apart
   * from "explicitly empty tools list" when it surfaces the fallback
   * notice to the user.
   */
  toolsDeclared: boolean;
  skills: readonly string[];
  isolatedContext: boolean;
}

export interface ParseMmrCustomSubagentMarkdownArgs {
  filePath: string;
  markdown: string;
  allowMissingFrontmatter?: boolean;
}

export interface DiscoverMmrCustomSubagentsArgs {
  roots: readonly string[];
  maxDepth?: number;
  maxFiles?: number;
  maxDefinitions?: number;
  allowMissingFrontmatter?: boolean;
}

type FrontmatterValue = string | boolean | string[];

interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  attributes: Record<string, FrontmatterValue>;
  body: string;
}

// Frontmatter keys that would either pollute the attributes object's
// prototype chain or shadow built-in `Object` machinery downstream.
// Custom subagents come from user-authored Markdown, so we treat the
// keys as untrusted input and drop these defensively before assignment.
const FORBIDDEN_FRONTMATTER_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function emptyFrontmatterAttributes(): Record<string, FrontmatterValue> {
  return Object.create(null) as Record<string, FrontmatterValue>;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseListValue(raw: string): string[] {
  const inner = raw.trim().startsWith("[") && raw.trim().endsWith("]")
    ? raw.trim().slice(1, -1)
    : raw;
  return inner
    .split(",")
    .map((part) => stripQuotes(part).trim())
    .filter((part) => part.length > 0);
}

function parseFrontmatterScalar(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return parseListValue(trimmed);
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  return stripQuotes(trimmed);
}

function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    return { hasFrontmatter: false, attributes: emptyFrontmatterAttributes(), body: markdown };
  }

  const closeLine = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closeLine === -1) {
    return { hasFrontmatter: false, attributes: emptyFrontmatterAttributes(), body: markdown };
  }

  const rawAttributes = lines.slice(1, closeLine);
  const body = lines.slice(closeLine + 1).join("\n");
  const attributes: Record<string, FrontmatterValue> = emptyFrontmatterAttributes();

  // Block-list state: when a key's inline value is empty (e.g. `tools:`),
  // subsequent indented `- value` lines accumulate into this list until the
  // next key=value line is encountered.
  let blockListKey: string | undefined;
  let blockListItems: string[] | undefined;

  const flushBlockList = (): void => {
    if (blockListKey !== undefined && blockListItems !== undefined) {
      attributes[blockListKey] = blockListItems;
    }
    blockListKey = undefined;
    blockListItems = undefined;
  };

  for (const rawLine of rawAttributes) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    // Block-list continuation: indented `- value` lines extend the current key.
    if (blockListKey !== undefined && /^\s+-/.test(rawLine)) {
      const itemRaw = trimmed.replace(/^-\s*/, "");
      const item = stripQuotes(itemRaw);
      if (item.length > 0) (blockListItems ??= []).push(item);
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    flushBlockList();
    const key = trimmed.slice(0, colon).trim();
    const rawValue = trimmed.slice(colon + 1).trim();
    if (key.length === 0) continue;
    if (FORBIDDEN_FRONTMATTER_KEYS.has(key)) continue;
    if (rawValue.length === 0) {
      // Open a block-list scope for this key. If no `- value` lines follow,
      // the key flushes with an empty array (not undefined) on the next
      // key=value line or at end-of-frontmatter.
      blockListKey = key;
      blockListItems = [];
      continue;
    }
    attributes[key] = parseFrontmatterScalar(rawValue);
  }
  flushBlockList();

  return { hasFrontmatter: true, attributes, body };
}

function readString(attributes: Record<string, FrontmatterValue>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readBoolean(attributes: Record<string, FrontmatterValue>, key: string): boolean {
  return attributes[key] === true;
}

export const MMR_CUSTOM_SUBAGENT_DENIED_TOOLS: ReadonlySet<string> = new Set(MMR_SUBAGENT_SHARED_DENY_TOOLS);

/**
 * Claude Code tool aliases mapped to the matching Pi tool name. Exported so
 * the import planner can report which source tokens were rewritten.
 */
export const MMR_CUSTOM_SUBAGENT_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["Read", "read"],
  ["Grep", "grep"],
  ["Glob", "find"],
  ["Bash", "bash"],
  ["Edit", "edit"],
  ["MultiEdit", "edit"],
  ["Write", "write"],
  ["WebSearch", "web_search"],
  ["WebFetch", "read_web_page"],
]);

export function isUnsafeMmrCustomSubagentToolPattern(tool: string): boolean {
  if (MMR_CUSTOM_SUBAGENT_DENIED_TOOLS.has(tool)) return true;
  if (tool.startsWith(MMR_CUSTOM_SUBAGENT_TOOL_PREFIX)) return true;
  if (tool.startsWith("mcp__")) return true;
  return false;
}

/** Frontmatter keys that declare a custom subagent's allowed tool list. */
export const MMR_CUSTOM_SUBAGENT_TOOL_KEYS: readonly string[] = [
  "tools",
  "allowed-tools",
  "allowedTools",
];

/**
 * Standard toolset granted to a custom subagent that declares no `tools:`
 * key. These are the Pi-native coding tools (`read`, `bash`, `edit`,
 * `write`, `find`, `grep`) plus the pi-mmr web tools (`web_search`,
 * `read_web_page`). A fixed constant is used rather than "all registered
 * tools" so the parent and the spawned child resolve the same set and the
 * worker never fails activation on a tool mismatch; each entry is still
 * intersected with the tools actually registered/active, so a host missing
 * one simply drops it. The list deliberately excludes recursive/advisory
 * subagents, toolbox, and MCP tools.
 */
export const MMR_CUSTOM_SUBAGENT_DEFAULT_TOOLS: readonly string[] = MMR_SUBAGENT_CUSTOM_DEFAULT_TOOLS;

/**
 * Least-privilege read-only toolset recommended by the setup/import flow when
 * a source subagent declares no tools (or declared "all tools"). The importer
 * recommends these rather than the broader standard default so a freshly
 * imported subagent starts with the smallest useful surface.
 */
export const MMR_CUSTOM_SUBAGENT_RECOMMENDED_READONLY_TOOLS: readonly string[] = ["read", "find", "grep"].filter((tool) => MMR_SUBAGENT_READ_ONLY_TOOLS.includes(tool));

/** Frontmatter keys that declare a custom subagent's thinking/effort level. */
const MMR_CUSTOM_SUBAGENT_THINKING_KEYS = ["thinkingLevel", "thinking", "effort"] as const;

/**
 * Parse a provider-neutral thinking/effort level from frontmatter. Accepts
 * `thinkingLevel`, `thinking`, or `effort` (first match wins), matched
 * case-insensitively against the canonical Pi levels (`off`, `minimal`,
 * `low`, `medium`, `high`, `xhigh`). Vendor-specific aliases are not
 * supported. Returns undefined when absent or invalid.
 */
function readCustomSubagentThinkingLevel(
  attributes: Record<string, FrontmatterValue>,
): ThinkingLevel | undefined {
  for (const key of MMR_CUSTOM_SUBAGENT_THINKING_KEYS) {
    const value = attributes[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (isThinkingLevel(normalized)) return normalized;
  }
  return undefined;
}

function readStringList(attributes: Record<string, FrontmatterValue>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = attributes[key];
    if (Array.isArray(value)) return value.map((item) => item.trim()).filter((item) => item.length > 0);
    if (typeof value === "string" && value.trim().length > 0) return parseListValue(value);
  }
  return [];
}

/**
 * Whether any of the given keys is present in the parsed frontmatter,
 * regardless of value. Used to distinguish a declared-but-empty tools
 * list (e.g. `tools:` or `tools: []`) from a tools key that was never
 * written at all.
 */
function hasAnyKey(attributes: Record<string, FrontmatterValue>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(attributes, key));
}

function deriveName(filePath: string, attributes: Record<string, FrontmatterValue>): string {
  const named = readString(attributes, "name");
  if (named) return named;
  const parsed = path.parse(filePath);
  if (parsed.base.toLowerCase() === "skill.md") return path.basename(parsed.dir) || "subagent";
  return parsed.name || "subagent";
}

export function toMmrCustomSubagentToolName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "subagent";
  const maxSlugLength = MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH - MMR_CUSTOM_SUBAGENT_TOOL_PREFIX.length;
  return `${MMR_CUSTOM_SUBAGENT_TOOL_PREFIX}${slug.slice(0, Math.max(1, maxSlugLength)).replace(/_+$/g, "") || "subagent"}`;
}

/**
 * Normalize a custom-subagent `tools:` list from frontmatter into a deduped
 * array of token strings. Claude Code tool aliases are rewritten to the
 * matching Pi tool names (`Read` → `read`, `Grep` → `grep`, `Glob` → `find`,
 * etc.); other tokens are preserved after trimming so exact Pi tool names
 * such as `read_github` remain usable.
 */
export function normalizeMmrCustomSubagentToolPatterns(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? parseListValue(value)
      : [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const token = MMR_CUSTOM_SUBAGENT_TOOL_ALIASES.get(item.trim()) ?? item.trim();
    if (token.length === 0) continue;
    if (seen.has(token)) continue;
    normalized.push(token);
    seen.add(token);
  }
  return normalized;
}

export function parseMmrCustomSubagentMarkdown(
  args: ParseMmrCustomSubagentMarkdownArgs,
): MmrCustomSubagentDefinition | undefined {
  const parsed = parseFrontmatter(args.markdown);
  const isolatedContext = readBoolean(parsed.attributes, "isolatedContext")
    || readBoolean(parsed.attributes, "isolated-context");
  const type = readString(parsed.attributes, "type")?.toLowerCase();
  // `allowMissingFrontmatter` only opens the gate for Markdown files
  // with no frontmatter; files that have frontmatter must still mark
  // themselves as a subagent (or set `isolatedContext: true`) before
  // the loader will surface them.
  const claudeCodeDefinition = Boolean(
    readString(parsed.attributes, "name")
    && readString(parsed.attributes, "description")
    && parsed.body.trim().length > 0,
  );
  const shouldInclude = parsed.hasFrontmatter
    ? type === "subagent" || isolatedContext || claudeCodeDefinition
    : Boolean(args.allowMissingFrontmatter);
  if (!shouldInclude) return undefined;

  const absoluteFilePath = path.resolve(args.filePath);
  const baseDir = path.dirname(absoluteFilePath);
  const name = deriveName(absoluteFilePath, parsed.attributes);
  const description = readString(parsed.attributes, "description") ?? `Custom subagent ${name}.`;
  const model = readString(parsed.attributes, "model") ?? "inherit";
  const modelDeclared = hasAnyKey(parsed.attributes, ["model"]);
  const thinkingLevel = readCustomSubagentThinkingLevel(parsed.attributes);
  const toolsDeclared = hasAnyKey(parsed.attributes, MMR_CUSTOM_SUBAGENT_TOOL_KEYS);
  const toolPatterns = normalizeMmrCustomSubagentToolPatterns(
    readStringList(parsed.attributes, MMR_CUSTOM_SUBAGENT_TOOL_KEYS),
  );
  if (toolPatterns.some(isUnsafeMmrCustomSubagentToolPattern)) return undefined;
  const skills = readStringList(parsed.attributes, ["skills"]);
  const systemPrompt = parsed.body.replaceAll("{baseDir}", baseDir).trimEnd();

  return {
    name,
    toolName: toMmrCustomSubagentToolName(name),
    description,
    filePath: absoluteFilePath,
    baseDir,
    systemPrompt,
    model,
    modelDeclared,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    toolPatterns,
    toolsDeclared,
    skills,
    isolatedContext,
  };
}

function normalizeDiscoveryLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function walkMarkdownFiles(root: string, maxDepth: number, maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  const visitedDirs = new Set<string>();

  // Refuse a symlinked or non-directory root. The walker already
  // skips symlink entries it discovers below the root, but the root
  // itself would otherwise be followed by `realpath`. Refusing here
  // means a misconfigured root cannot make the loader follow an
  // attacker-controlled symlink chain on the first hop.
  let rootStat: Awaited<ReturnType<typeof lstat>>;
  try {
    rootStat = await lstat(root);
  } catch {
    return files;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return files;
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return files;
  }

  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length >= maxFiles) return;
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(dir);
    } catch {
      return;
    }
    if (!isPathInsideRoot(canonicalDir, canonicalRoot)) return;
    if (visitedDirs.has(canonicalDir)) return;
    visitedDirs.add(canonicalDir);

    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (depth >= maxDepth) continue;
        await walk(fullPath, depth + 1);
        continue;
      }
      if (stat.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        let canonicalFile: string;
        try {
          canonicalFile = await realpath(fullPath);
        } catch {
          continue;
        }
        if (!isPathInsideRoot(canonicalFile, canonicalRoot)) continue;
        files.push(fullPath);
      }
    }
  }

  await walk(root, 0);
  return files;
}

function addMmrCustomSubagentDefinition(
  definitions: MmrCustomSubagentDefinition[],
  seenToolNames: Set<string>,
  filePath: string,
  markdown: string,
  allowMissingFrontmatter: boolean | undefined,
): void {
  let definition: MmrCustomSubagentDefinition | undefined;
  try {
    definition = parseMmrCustomSubagentMarkdown({
      filePath,
      markdown,
      allowMissingFrontmatter,
    });
  } catch {
    return;
  }
  if (!definition) return;
  if (seenToolNames.has(definition.toolName)) return;
  seenToolNames.add(definition.toolName);
  definitions.push(definition);
}

export async function discoverMmrCustomSubagents(
  args: DiscoverMmrCustomSubagentsArgs,
): Promise<MmrCustomSubagentDefinition[]> {
  const maxDepth = normalizeDiscoveryLimit(args.maxDepth, DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_SCAN_DEPTH);
  const maxFiles = normalizeDiscoveryLimit(args.maxFiles, DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_FILES);
  const maxDefinitions = normalizeDiscoveryLimit(args.maxDefinitions, DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_DEFINITIONS);
  const definitions: MmrCustomSubagentDefinition[] = [];
  const seenToolNames = new Set<string>();
  let scannedFiles = 0;

  for (const root of args.roots) {
    if (definitions.length >= maxDefinitions || scannedFiles >= maxFiles) break;
    if (typeof root !== "string" || root.trim().length === 0) continue;
    const rootPath = path.resolve(root);
    const files = await walkMarkdownFiles(rootPath, maxDepth, Math.max(0, maxFiles - scannedFiles));
    scannedFiles += files.length;
    for (const filePath of files) {
      if (definitions.length >= maxDefinitions) break;
      // Re-check the entry right before reading: bound the file size
      // (avoid loading a multi-megabyte Markdown blob), confirm it is
      // still a regular file, and contain any per-file read or parse
      // failure so one bad file does not reject the entire discovery.
      //
      // Open one descriptor with O_NOFOLLOW, then fstat and read from that
      // same handle. This removes the lstat()-then-readFile() file-system
      // race (the bytes we size-check are the bytes we parse) and refuses a
      // final-component symlink swapped in after the walk, instead of
      // following it. O_NOFOLLOW is POSIX-only; on platforms that lack it
      // the flag is 0 and the walk-time symlink skip remains the guard.
      let markdown: string | undefined;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const stat = await handle.stat();
        if (stat.isFile() && stat.size <= MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES) {
          markdown = await handle.readFile("utf8");
        }
      } catch {
        // Missing file, swapped-in symlink (ELOOP via O_NOFOLLOW), or read
        // error: leave markdown undefined and skip this entry below.
      } finally {
        await handle?.close();
      }
      if (markdown === undefined) continue;
      addMmrCustomSubagentDefinition(definitions, seenToolNames, filePath, markdown, args.allowMissingFrontmatter);
    }
  }

  return definitions;
}

function walkMarkdownFilesSync(root: string, maxDepth: number, maxFiles: number): string[] {
  const files: string[] = [];
  const visitedDirs = new Set<string>();
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    return files;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return files;
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(root);
  } catch {
    return files;
  }

  function walk(dir: string, depth: number): void {
    if (files.length >= maxFiles) return;
    let canonicalDir: string;
    try {
      canonicalDir = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (!isPathInsideRoot(canonicalDir, canonicalRoot)) return;
    if (visitedDirs.has(canonicalDir)) return;
    visitedDirs.add(canonicalDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (depth >= maxDepth) continue;
        walk(fullPath, depth + 1);
        continue;
      }
      if (stat.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        let canonicalFile: string;
        try {
          canonicalFile = fs.realpathSync(fullPath);
        } catch {
          continue;
        }
        if (!isPathInsideRoot(canonicalFile, canonicalRoot)) continue;
        files.push(fullPath);
      }
    }
  }

  walk(root, 0);
  return files;
}

export function discoverMmrCustomSubagentsSync(
  args: DiscoverMmrCustomSubagentsArgs,
): MmrCustomSubagentDefinition[] {
  const maxDepth = normalizeDiscoveryLimit(args.maxDepth, DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_SCAN_DEPTH);
  const maxFiles = normalizeDiscoveryLimit(args.maxFiles, DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_FILES);
  const maxDefinitions = normalizeDiscoveryLimit(args.maxDefinitions, DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_DEFINITIONS);
  const definitions: MmrCustomSubagentDefinition[] = [];
  const seenToolNames = new Set<string>();
  let scannedFiles = 0;

  for (const root of args.roots) {
    if (definitions.length >= maxDefinitions || scannedFiles >= maxFiles) break;
    if (typeof root !== "string" || root.trim().length === 0) continue;
    const rootPath = path.resolve(root);
    const files = walkMarkdownFilesSync(rootPath, maxDepth, Math.max(0, maxFiles - scannedFiles));
    scannedFiles += files.length;
    for (const filePath of files) {
      if (definitions.length >= maxDefinitions) break;
      let fd: number | undefined;
      try {
        fd = fs.openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MMR_CUSTOM_SUBAGENT_MAX_FILE_BYTES) continue;
        const markdown = fs.readFileSync(fd, "utf8");
        addMmrCustomSubagentDefinition(definitions, seenToolNames, filePath, markdown, args.allowMissingFrontmatter);
      } catch {
        continue;
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            // best-effort descriptor cleanup
          }
        }
      }
    }
  }

  return definitions;
}
