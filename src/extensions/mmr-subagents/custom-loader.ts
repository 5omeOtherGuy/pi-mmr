import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const MMR_CUSTOM_SUBAGENT_TOOL_PREFIX = "sa__";
export const MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH = 120;
export const DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_SCAN_DEPTH = 5;
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
  toolPatterns: readonly string[];
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

function readStringList(attributes: Record<string, FrontmatterValue>, keys: readonly string[]): string[] {
  for (const key of keys) {
    const value = attributes[key];
    if (Array.isArray(value)) return value.map((item) => item.trim()).filter((item) => item.length > 0);
    if (typeof value === "string" && value.trim().length > 0) return parseListValue(value);
  }
  return [];
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
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "subagent";
  const maxSlugLength = MMR_CUSTOM_SUBAGENT_MAX_TOOL_NAME_LENGTH - MMR_CUSTOM_SUBAGENT_TOOL_PREFIX.length;
  return `${MMR_CUSTOM_SUBAGENT_TOOL_PREFIX}${slug.slice(0, Math.max(1, maxSlugLength)).replace(/-+$/g, "") || "subagent"}`;
}

/**
 * Normalize a custom-subagent `tools:` list from frontmatter into a deduped
 * array of token strings. Tokens are preserved exactly as written (after
 * trimming) — there is no alias rewriting. Subagent definitions must name
 * the exact Pi tool they want activated (for example `read`, `bash`,
 * `edit`, `write`, `grep`, `find`, `web_search`, `read_web_page`, `Task`).
 * Unknown or non-canonical names will simply fail to activate at runtime
 * because no Pi tool with that name is registered.
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
    const token = item.trim();
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
  const shouldInclude = parsed.hasFrontmatter
    ? type === "subagent" || isolatedContext
    : Boolean(args.allowMissingFrontmatter);
  if (!shouldInclude) return undefined;

  const absoluteFilePath = path.resolve(args.filePath);
  const baseDir = path.dirname(absoluteFilePath);
  const name = deriveName(absoluteFilePath, parsed.attributes);
  const description = readString(parsed.attributes, "description") ?? `Custom subagent ${name}.`;
  const model = readString(parsed.attributes, "model") ?? "inherit";
  const toolPatterns = normalizeMmrCustomSubagentToolPatterns(
    readStringList(parsed.attributes, ["tools", "allowed-tools", "allowedTools"]),
  );
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
    toolPatterns,
    skills,
    isolatedContext,
  };
}

async function walkMarkdownFiles(root: string, maxDepth: number): Promise<string[]> {
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

  async function walk(dir: string, depth: number): Promise<void> {
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(dir);
    } catch {
      return;
    }
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
      if (stat.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(fullPath);
    }
  }

  await walk(root, 0);
  return files;
}

export async function discoverMmrCustomSubagents(
  args: DiscoverMmrCustomSubagentsArgs,
): Promise<MmrCustomSubagentDefinition[]> {
  const maxDepth = Math.max(0, Math.floor(args.maxDepth ?? DEFAULT_MMR_CUSTOM_SUBAGENT_MAX_SCAN_DEPTH));
  const definitions: MmrCustomSubagentDefinition[] = [];
  const seenToolNames = new Set<string>();

  for (const root of args.roots) {
    if (typeof root !== "string" || root.trim().length === 0) continue;
    const rootPath = path.resolve(root);
    const files = await walkMarkdownFiles(rootPath, maxDepth);
    for (const filePath of files) {
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
      let definition: MmrCustomSubagentDefinition | undefined;
      try {
        definition = parseMmrCustomSubagentMarkdown({
          filePath,
          markdown,
          allowMissingFrontmatter: args.allowMissingFrontmatter,
        });
      } catch {
        continue;
      }
      if (!definition) continue;
      if (seenToolNames.has(definition.toolName)) continue;
      seenToolNames.add(definition.toolName);
      definitions.push(definition);
    }
  }

  return definitions;
}
