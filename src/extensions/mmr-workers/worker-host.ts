/**
 * Shared helpers for deriving a subagent worker's runtime context from the Pi
 * host: the working directory and the worker tool manifest.
 *
 * Both helpers were previously duplicated verbatim across subagent tool
 * modules and are consolidated here as a single source of truth so their
 * behavior cannot drift between tools:
 *   - `resolveWorkerCwd` was copied across `task`, `finder`, `librarian`,
 *     `oracle`, and `async-task-tools`.
 *   - `buildWorkerToolManifest` (and the `ToolHostLike` type) was copied
 *     across `task` and `librarian`.
 * This module imports nothing from the tool modules (avoid import cycles);
 * tool modules import from here.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../mmr-core/internal/json.js";
import { getMmrSessionIdentitySnapshot } from "../mmr-core/runtime.js";
import type { MmrActiveToolManifestEntry } from "../mmr-core/types.js";

/**
 * Resolve the working directory for a worker invocation from the extension
 * context, falling back to `process.cwd()` when the host does not supply one.
 */
export function resolveWorkerCwd(ctx: ExtensionContext | undefined): string {
  const candidate = (ctx as { cwd?: unknown } | undefined)?.cwd;
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  return process.cwd();
}

/**
 * Resolve the async-task registry partition key for a worker run. ONE
 * resolution shared by the blocking worker tools (the factory's
 * register-and-await path) and the background task tools, so a blocking run
 * and a background run started from the same session always land in the same
 * registry partition.
 *
 * Precedence: explicit override (deterministic tests) → the session id from
 * THIS call's context (so concurrent sessions in one process never share a
 * partition) → the global identity snapshot → cwd partitioning.
 */
export function resolveMmrWorkerSessionKey(
  ctx: ExtensionContext | undefined,
  override?: string,
): string {
  if (override) return override;
  try {
    const ctxId = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)
      ?.sessionManager?.getSessionId?.();
    if (typeof ctxId === "string" && ctxId.length > 0) return `sid:${ctxId}`;
  } catch {
    // best-effort
  }
  try {
    const id = getMmrSessionIdentitySnapshot()?.sessionId;
    if (id) return `sid:${id}`;
  } catch {
    // identity is best-effort; fall back to cwd partitioning
  }
  return `cwd:${resolveWorkerCwd(ctx)}`;
}

/** Minimal structural view of the Pi host needed to inspect tool state. */
export interface ToolHostLike {
  getActiveTools?: () => readonly string[];
  getAllTools?: () => readonly unknown[];
  /**
   * Registered slash commands with `sourceInfo` metadata. Used by
   * `computeMmrChildExtensionScope` to enumerate loaded extensions that
   * register a command (e.g. external model-provider packages) but no tool.
   */
  getCommands?: () => readonly unknown[];
}

/**
 * Build the worker's tool manifest from the resolved `workerTools` set
 * (deny-aware, registered-tool intersection from
 * `resolveMmrSubagentInvocation`) rather than from `pi.getActiveTools()`.
 *
 * `pi.getActiveTools()` reflects the parent mode's current active set,
 * which is generally a subset of the registered-tool inventory. When
 * the parent mode does not currently expose a tool that is nevertheless
 * registered in the host, the previous parent-active-filtered manifest
 * would omit it even though the child's `workerTools` includes it — the
 * worker could call the tool at runtime but its system prompt never
 * described it, producing silent under-advertising. Filtering by
 * `workerTools` yields a manifest that exactly matches the worker's
 * runtime tool surface.
 *
 * Tools listed in `workerTools` but absent from `pi.getAllTools()` are
 * dropped from the manifest (no metadata available). This matches the
 * graceful handling for profile-listed but unregistered tools elsewhere
 * in the resolver path.
 */
export function buildWorkerToolManifest(
  pi: ToolHostLike | undefined,
  workerTools: readonly string[],
): MmrActiveToolManifestEntry[] {
  if (!pi || workerTools.length === 0) return [];
  const wanted = new Set(workerTools);
  let allTools: readonly unknown[] = [];
  try {
    const tools = pi.getAllTools?.();
    if (Array.isArray(tools)) allTools = tools;
  } catch {
    allTools = [];
  }
  return allTools.flatMap((tool): MmrActiveToolManifestEntry[] => {
    if (!isRecord(tool) || typeof tool.name !== "string" || !wanted.has(tool.name)) return [];
    const promptGuidelines = Array.isArray(tool.promptGuidelines)
      ? tool.promptGuidelines.filter((entry): entry is string => typeof entry === "string")
      : [];
    const description = typeof tool.description === "string"
      ? tool.description
      : typeof tool.promptSnippet === "string"
        ? tool.promptSnippet
        : "";
    const promptSnippet = typeof tool.promptSnippet === "string" ? tool.promptSnippet : undefined;
    return [{
      name: tool.name,
      owner: "runtime",
      ...(promptSnippet !== undefined ? { promptSnippet } : {}),
      promptGuidelines,
      description,
      schema: tool.parameters ?? {},
    }];
  });
}
