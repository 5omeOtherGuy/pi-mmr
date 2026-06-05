import { existsSync } from "node:fs";
import path from "node:path";

export interface MmrWorkerArgsOptions {
  prompt: string;
  model?: string;
  tools?: readonly string[];
  profileName?: string;
  parentMode?: string;
  systemPromptDelivery?: "append" | "replace";
}

export interface MmrWorkerInvocation {
  command: string;
  args: string[];
}


export function buildMmrWorkerArgs(
  options: MmrWorkerArgsOptions,
  promptFilePath?: string,
  userPromptFilePath?: string,
): string[] {
  const args = ["--mode", "json", "-p", "--no-session"];
  const profile = options.profileName?.trim();
  if (profile) args.push("--mmr-subagent", profile);
  const parentMode = options.parentMode?.trim();
  if (parentMode) args.push("--mmr-parent-mode", parentMode);
  const model = options.model?.trim();
  if (model) args.push("--model", model);
  // Emit `--tools` whenever the caller supplied a tools array, including an
  // empty one: `--tools ""` is the documented contract (see
  // worker-cli-flags.ts) for "the runner explicitly asked for no tools", so
  // the child applies an empty ceiling instead of falling back to its own
  // profile-resolved set. Callers that want the child to self-resolve (e.g.
  // finder/oracle) omit `tools` entirely (undefined) rather than passing [].
  if (options.tools !== undefined) {
    const tools = options.tools.map((tool) => tool.trim()).filter(Boolean);
    args.push("--tools", tools.join(","));
  }
  if (promptFilePath) {
    if (options.systemPromptDelivery === "replace") {
      // Exact replacement: Pi loads the file as `customPrompt`, so its
      // default coding-assistant head is skipped. `--no-context-files`
      // and `--no-skills` suppress AGENTS.md/CLAUDE.md and skills
      // discovery so the worker sees only the assembled subagent prompt.
      args.push("--system-prompt", promptFilePath);
      args.push("--no-context-files");
      args.push("--no-skills");
    } else {
      args.push("--append-system-prompt", promptFilePath);
    }
  }
  if (userPromptFilePath) {
    // Spill path: Pi's documented `@<path>` syntax includes the file's
    // contents as the user message, sidestepping Linux's per-argv
    // `MAX_ARG_STRLEN` cap that fails the spawn with `E2BIG` when the
    // inline `Task: ...` string would be too large.
    args.push(`@${userPromptFilePath}`);
  } else {
    args.push(`Task: ${options.prompt}`);
  }
  return args;
}

/**
 * Environment inputs for {@link resolveMmrWorkerPiInvocationFromEnv}. Split out
 * so tests can drive every branch (current-script re-invocation, packaged Pi
 * binary, generic-runtime fallback, bun virtual script) without monkey-patching
 * `process` or the filesystem.
 */
export interface MmrWorkerPiInvocationEnv {
  /** Typically `process.argv[1]`. */
  argv1: string | undefined;
  /** Typically `process.execPath`. */
  execPath: string;
  /** Existence probe for `argv1`; typically a thin wrapper around `fs.existsSync`. */
  scriptExists: (filePath: string) => boolean;
}

/**
 * Pure invocation resolver. Mirrors Pi's bundled subagent example so the
 * spawned worker uses the same Pi/runtime the parent is running under, instead
 * of whichever `pi` happens to be on PATH.
 *
 * Precedence (matches the Pi reference):
 *
 * 1. Re-invoke the current Pi script via `argv0 execPath argv1 ...args` when
 *    `argv1` is set, is not a Bun virtual script, and exists on disk.
 * 2. Use `execPath` directly when the runtime executable is a packaged Pi
 *    binary (anything other than `node`/`bun`).
 * 3. Fall back to `pi` on `PATH` for generic `node`/`bun` runtimes.
 */
export function resolveMmrWorkerPiInvocationFromEnv(args: string[], env: MmrWorkerPiInvocationEnv): MmrWorkerInvocation {
  const currentScript = env.argv1;
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
  if (currentScript && !isBunVirtualScript && env.scriptExists(currentScript)) {
    return { command: env.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(env.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: env.execPath, args };

  return { command: "pi", args };
}

export function resolveMmrWorkerPiInvocation(args: string[]): MmrWorkerInvocation {
  return resolveMmrWorkerPiInvocationFromEnv(args, {
    argv1: process.argv[1],
    execPath: process.execPath,
    scriptExists: existsSync,
  });
}
