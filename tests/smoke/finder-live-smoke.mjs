#!/usr/bin/env node
// Live smoke test: spawn a real `pi --mode json -p --no-session` worker
// through the finder tool and report the result.
//
// Outside the npm test glob on purpose — this script makes a real
// subprocess call (and, depending on Pi configuration, a real provider
// call). Run it explicitly:
//
//   node tests/smoke/finder-live-smoke.mjs
//
// Optional environment knobs:
//   FINDER_SMOKE_QUERY            — override the search query (default: a
//                                   small one targeting this repo)
//   FINDER_SMOKE_MODEL            — force a specific worker --model
//   FINDER_SMOKE_TIMEOUT_MS       — abort after this many ms (default 120000)
//   FINDER_SMOKE_EXTENSION_PATHS  — opt-in dev-loop isolation: comma-
//                                   separated extension paths. When set, the
//                                   smoke appends `--no-extensions` and `-e
//                                   <path>` for each so the spawned `pi`
//                                   loads ONLY the worktree's mmr-core /
//                                   mmr-subagents instead of whatever
//                                   pi-mmr Pi would auto-discover. Use this
//                                   when running the smoke from a worktree
//                                   that is NOT the pi-mmr install Pi sees.
//                                   Production finder NEVER passes these.
//
// Exits 0 on a non-empty, non-aborted result; 1 otherwise. Always prints
// the worker command, args, exit code, usage, and the final visible
// output (truncated) so the operator can verify Pi actually ran a
// search.

import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { cleanupLoadedSource, importSource } from "../helpers/load-src.mjs";

// The Pi CLI bundles its own copy of @earendil-works/pi-coding-agent (and
// @earendil-works/pi-ai), which is typically newer than the peer copy in
// the pi-mmr workspace's node_modules. Production finder runs inside that
// bundled runtime, so to make this smoke faithfully exercise the
// production model-selection path we load AuthStorage/ModelRegistry from
// the *installed Pi CLI*, not from the workspace.
function resolvePiBundledCodingAgent() {
  const candidates = [
    process.env.PI_BUNDLED_CODING_AGENT,
    (() => {
      try {
        return execSync("command -v pi", { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    // Resolve symlinks with Node's realpathSync rather than shelling out to
    // `readlink -f "${candidate}"`: interpolating an env-derived path into a
    // shell command is an indirect command-line injection. realpathSync uses
    // no shell and falls back to the raw candidate when the path is missing.
    const real = (() => {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    })();
    // .../@earendil-works/pi-coding-agent/dist/cli.js → .../@earendil-works/pi-coding-agent/dist/index.js
    const distDir = path.dirname(real);
    return path.join(distDir, "index.js");
  }
  throw new Error("could not locate the installed Pi CLI; set PI_BUNDLED_CODING_AGENT to its cli.js path");
}
const piBundlePath = resolvePiBundledCodingAgent();
const { AuthStorage, FileAuthStorageBackend, ModelRegistry } = await import(pathToFileURL(piBundlePath).href);

const QUERY = process.env.FINDER_SMOKE_QUERY ?? "Where is the finder tool defined and registered in this repository?";
const FORCED_MODEL = process.env.FINDER_SMOKE_MODEL?.trim();
// finder now resolves its worker route through the shared
// selectMmrModelRoute registry resolver, so an operator override is a
// MmrModelPreference[]. A `provider/id` value pins the provider; a bare id
// matches any registered provider for that model.
const FORCED_MODEL_PREFERENCE = FORCED_MODEL
  ? (FORCED_MODEL.includes("/")
      ? [{ model: FORCED_MODEL.slice(FORCED_MODEL.indexOf("/") + 1), providers: [FORCED_MODEL.slice(0, FORCED_MODEL.indexOf("/"))] }]
      : [{ model: FORCED_MODEL }])
  : undefined;
const TIMEOUT_MS = Number.parseInt(process.env.FINDER_SMOKE_TIMEOUT_MS ?? "120000", 10);

async function main() {
  const finderMod = await importSource("extensions/mmr-subagents/finder.ts");
  const { createFinderTool, FINDER_WORKER_TOOLS } = finderMod;

  const cwd = path.resolve(import.meta.dirname, "..", "..");
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  abortTimer.unref();

  // The runner's default resolver inherits `process.argv[1]` and assumes
  // it points at a Pi entry script. That assumption only holds when finder
  // runs inside a Pi parent process. This smoke script is NOT inside Pi,
  // so we force the resolver to spawn `pi` from PATH instead of
  // re-invoking this script as if it were Pi.
  //
  // By default the smoke is production-faithful: the spawned `pi` discovers
  // pi-mmr through normal Pi extension discovery, exactly as a production
  // finder worker would. Operators running this from a worktree that is
  // NOT the pi-mmr install Pi sees should set FINDER_SMOKE_EXTENSION_PATHS
  // to opt into dev-loop isolation (loads only the specified extensions
  // via `-e <path>` and disables auto-discovery via `--no-extensions`).
  const devExtensionPaths = (process.env.FINDER_SMOKE_EXTENSION_PATHS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const devLoopExtraArgs = devExtensionPaths.length > 0
    ? ["--no-extensions", ...devExtensionPaths.flatMap((p) => ["-e", p])]
    : [];
  if (devLoopExtraArgs.length > 0) {
    console.log(`[finder-smoke] dev-loop isolation: ${devLoopExtraArgs.join(" ")}`);
  } else {
    console.log("[finder-smoke] production invocation (no -e / --no-extensions overrides)");
  }
  const forcedResolve = (args) => ({ command: "pi", args: [...args, ...devLoopExtraArgs] });
  const deps = {
    runnerDeps: { resolveInvocation: forcedResolve },
    ...(FORCED_MODEL_PREFERENCE
      ? { modelPreferences: FORCED_MODEL_PREFERENCE }
      : {}),
  };
  const tool = createFinderTool(deps);

  // Build a real Pi ModelRegistry so the default execute() path exercises
  // ctx.modelRegistry.getAvailable() against the operator's actual Pi
  // configuration. This makes the smoke prove the advertised
  // "GPT-5.4 Mini → Haiku" preference works end-to-end, not just in unit
  // tests with a stub registry.
  const authStorage = new AuthStorage(new FileAuthStorageBackend());
  const modelRegistry = ModelRegistry.create(authStorage);
  const ctx = { cwd, modelRegistry };
  const availableAll = modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  console.log(`[finder-smoke] available models (${availableAll.length}): ${availableAll.join(", ") || "(none)"}`);

  let progressUpdates = 0;
  const onUpdate = () => { progressUpdates += 1; };

  const startedAt = Date.now();
  console.log(`[finder-smoke] cwd=${cwd}`);
  console.log(`[finder-smoke] query=${JSON.stringify(QUERY)}`);
  console.log(`[finder-smoke] worker tools=${FINDER_WORKER_TOOLS.join(",")}`);
  if (FORCED_MODEL) console.log(`[finder-smoke] forced model=${FORCED_MODEL}`);

  let result;
  try {
    result = await tool.execute("smoke-1", { query: QUERY }, controller.signal, onUpdate, ctx);
  } finally {
    clearTimeout(abortTimer);
  }
  const elapsedMs = Date.now() - startedAt;

  const details = result.details;
  console.log("---");
  console.log(`[finder-smoke] command: ${details.command}`);
  console.log(`[finder-smoke] args: ${JSON.stringify(details.args)}`);
  console.log(`[finder-smoke] exitCode=${details.exitCode} signal=${details.signal ?? "null"} aborted=${details.aborted}`);
  console.log(`[finder-smoke] model=${details.model ?? "(pi default)"} reportedModel=${details.reportedModel ?? "(none)"}`);
  console.log(`[finder-smoke] usage=${JSON.stringify(details.usage)}`);
  console.log(`[finder-smoke] ignoredJsonLines=${details.ignoredJsonLines} outputTruncated=${details.outputTruncated}`);
  console.log(`[finder-smoke] progress updates=${progressUpdates}  elapsedMs=${elapsedMs}`);
  if (details.stderr.trim().length > 0) {
    console.log(`[finder-smoke] stderr (tail):\n${details.stderr.split("\n").slice(-10).join("\n")}`);
  }
  console.log("---");
  console.log("[finder-smoke] visible content:");
  console.log(result.content[0]?.text ?? "(no content)");

  // small grace period so the runner can clean up the prompt tmpdir before
  // we tear down the loaded-source cache
  await wait(50);

  const text = (result.content[0]?.text ?? "").trim();
  // Production parity: any subagent activation failure must FAIL the
  // smoke even though Pi itself exits 0 today. The runner detects the
  // marker on stderr and exposes it via details.subagentActivationError.
  if (details.subagentActivationError) {
    console.error(`[finder-smoke] FAIL: subagent activation failed: ${details.subagentActivationError}`);
    process.exitCode = 1;
  } else if (details.aborted || details.exitCode !== 0 || text.length === 0) {
    console.error("[finder-smoke] FAIL");
    process.exitCode = 1;
  } else {
    console.log("[finder-smoke] OK");
  }
}

try {
  await main();
} catch (error) {
  console.error("[finder-smoke] exception:", error?.stack ?? error);
  process.exitCode = 1;
} finally {
  cleanupLoadedSource();
}
