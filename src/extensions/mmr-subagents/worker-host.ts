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

/** Minimal structural view of the Pi host needed to inspect tool state. */
export interface ToolHostLike {
  getActiveTools?: () => readonly string[];
  getAllTools?: () => readonly unknown[];
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
