#!/usr/bin/env node
// Live smoke test: spawn a real `pi --mode json -p --no-session` worker
// through the oracle tool and report the result.
//
// Outside the npm test glob on purpose — this script makes a real
// subprocess call (and, depending on Pi configuration, a real provider
// call). Run it explicitly:
//
//   node tests/smoke/oracle-live-smoke.mjs
//
// Optional environment knobs:
//   ORACLE_SMOKE_TASK             — override the consultation task
//                                   (default: a small repo-bounded one)
//   ORACLE_SMOKE_FILES            — comma-separated list of files to
//                                   attach via the oracle `files` arg
//   ORACLE_SMOKE_MODEL            — force a specific worker --model
//                                   (provider/id or bare id)
//   ORACLE_SMOKE_TIMEOUT_MS       — abort after this many ms (default 180000)
//   ORACLE_SMOKE_EXTENSION_PATHS  — opt-in dev-loop isolation: comma-
//                                   separated extension paths. When set,
//                                   the smoke appends `--no-extensions`
//                                   and `-e <path>` for each so the
//                                   spawned `pi` loads ONLY the
//                                   worktree's mmr-core / mmr-subagents.
//
// In addition to the standard finder-style output, this smoke also sets
// `MMR_DEBUG_CAPTURE_SYSTEM_PROMPT_FILE` in the child Pi so mmr-core
// writes the assembled system prompt (Pi base + appended worker prompt)
// to a tmp file. The captured prompt is echoed to stdout after the run
// so the operator can verify it matches the design.
//
// Exits 0 on a non-empty, non-aborted result; 1 otherwise.

import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { mkdtempSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import { cleanupLoadedSource, importSource } from "../helpers/load-src.mjs";

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
    const distDir = path.dirname(real);
    return path.join(distDir, "index.js");
  }
  throw new Error("could not locate the installed Pi CLI; set PI_BUNDLED_CODING_AGENT to its cli.js path");
}
const piBundlePath = resolvePiBundledCodingAgent();
const { AuthStorage, FileAuthStorageBackend, ModelRegistry } = await import(pathToFileURL(piBundlePath).href);

const TASK = process.env.ORACLE_SMOKE_TASK
  ?? "Briefly describe what the oracle subagent does in this repository, in one sentence.";
const FILES = (process.env.ORACLE_SMOKE_FILES ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const FORCED_MODEL = process.env.ORACLE_SMOKE_MODEL?.trim();
// oracle now resolves its worker route through the shared
// selectMmrModelRoute registry resolver, so an operator override is a
// MmrModelPreference[]. A `provider/id` value pins the provider; a bare id
// matches any registered provider for that model.
const FORCED_MODEL_PREFERENCE = FORCED_MODEL
  ? (FORCED_MODEL.includes("/")
      ? [{ model: FORCED_MODEL.slice(FORCED_MODEL.indexOf("/") + 1), providers: [FORCED_MODEL.slice(0, FORCED_MODEL.indexOf("/"))] }]
      : [{ model: FORCED_MODEL }])
  : undefined;
const TIMEOUT_MS = Number.parseInt(process.env.ORACLE_SMOKE_TIMEOUT_MS ?? "180000", 10);

async function main() {
  const oracleMod = await importSource("extensions/mmr-subagents/oracle.ts");
  const { createOracleTool, ORACLE_WORKER_TOOLS } = oracleMod;

  const cwd = path.resolve(import.meta.dirname, "..", "..");
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  abortTimer.unref();

  // Capture the assembled system prompt the child Pi sends to the
  // provider. mmr-core's `before_provider_request` writes it to this
  // path when MMR_DEBUG_CAPTURE_SYSTEM_PROMPT_FILE is set in the child
  // environment. We seed the env var into the spawned pi via the
  // runner's invocation hook.
  const captureDir = mkdtempSync(path.join(tmpdir(), "oracle-smoke-"));
  const capturePath = path.join(captureDir, "system-prompt.txt");
  process.env.MMR_DEBUG_CAPTURE_SYSTEM_PROMPT_FILE = capturePath;

  const devExtensionPaths = (process.env.ORACLE_SMOKE_EXTENSION_PATHS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const devLoopExtraArgs = devExtensionPaths.length > 0
    ? ["--no-extensions", ...devExtensionPaths.flatMap((p) => ["-e", p])]
    : [];
  if (devLoopExtraArgs.length > 0) {
    console.log(`[oracle-smoke] dev-loop isolation: ${devLoopExtraArgs.join(" ")}`);
  } else {
    console.log("[oracle-smoke] production invocation (no -e / --no-extensions overrides)");
  }
  const forcedResolve = (args) => ({ command: "pi", args: [...args, ...devLoopExtraArgs] });
  const deps = {
    runnerDeps: { resolveInvocation: forcedResolve },
    ...(FORCED_MODEL_PREFERENCE
      ? { modelPreferences: FORCED_MODEL_PREFERENCE }
      : {}),
  };
  const tool = createOracleTool(deps);

  const authStorage = new AuthStorage(new FileAuthStorageBackend());
  const modelRegistry = ModelRegistry.create(authStorage);
  const ctx = { cwd, modelRegistry };
  const availableAll = modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  console.log(`[oracle-smoke] available models (${availableAll.length}): ${availableAll.join(", ") || "(none)"}`);

  let progressUpdates = 0;
  const onUpdate = () => { progressUpdates += 1; };

  const startedAt = Date.now();
  console.log(`[oracle-smoke] cwd=${cwd}`);
  console.log(`[oracle-smoke] task=${JSON.stringify(TASK)}`);
  console.log(`[oracle-smoke] files=${JSON.stringify(FILES)}`);
  console.log(`[oracle-smoke] worker tools=${ORACLE_WORKER_TOOLS.join(",")}`);
  console.log(`[oracle-smoke] capture path=${capturePath}`);
  if (FORCED_MODEL) console.log(`[oracle-smoke] forced model=${FORCED_MODEL}`);

  const params = { task: TASK, ...(FILES.length > 0 ? { files: FILES } : {}) };

  let result;
  try {
    result = await tool.execute("smoke-1", params, controller.signal, onUpdate, ctx);
  } finally {
    clearTimeout(abortTimer);
  }
  const elapsedMs = Date.now() - startedAt;

  const details = result.details;
  console.log("---");
  console.log(`[oracle-smoke] command: ${details.command}`);
  console.log(`[oracle-smoke] args: ${JSON.stringify(details.args)}`);
  console.log(`[oracle-smoke] exitCode=${details.exitCode} signal=${details.signal ?? "null"} aborted=${details.aborted}`);
  console.log(`[oracle-smoke] model=${details.model ?? "(pi default)"} reportedModel=${details.reportedModel ?? "(none)"}`);
  console.log(`[oracle-smoke] usage=${JSON.stringify(details.usage)}`);
  console.log(`[oracle-smoke] ignoredJsonLines=${details.ignoredJsonLines} outputTruncated=${details.outputTruncated}`);
  console.log(`[oracle-smoke] progress updates=${progressUpdates}  elapsedMs=${elapsedMs}`);
  if (details.stderr.trim().length > 0) {
    console.log(`[oracle-smoke] stderr (tail):\n${details.stderr.split("\n").slice(-10).join("\n")}`);
  }
  console.log("---");
  console.log("[oracle-smoke] visible content:");
  console.log(result.content[0]?.text ?? "(no content)");

  await wait(50);

  console.log("--- CAPTURED CHILD SYSTEM PROMPT (verbatim) ---");
  if (existsSync(capturePath)) {
    const captured = readFileSync(capturePath, "utf8");
    process.stdout.write(captured);
    if (!captured.endsWith("\n")) process.stdout.write("\n");
    console.log(`--- END (${captured.length} bytes) ---`);
  } else {
    console.log("(no capture file produced — the child Pi may not have hit before_provider_request)");
    console.log("--- END ---");
  }

  const text = (result.content[0]?.text ?? "").trim();
  if (details.subagentActivationError) {
    console.error(`[oracle-smoke] FAIL: subagent activation failed: ${details.subagentActivationError}`);
    process.exitCode = 1;
  } else if (details.aborted || details.exitCode !== 0 || text.length === 0) {
    console.error("[oracle-smoke] FAIL");
    process.exitCode = 1;
  } else {
    console.log("[oracle-smoke] OK");
  }
}

try {
  await main();
} catch (error) {
  console.error("[oracle-smoke] exception:", error?.stack ?? error);
  process.exitCode = 1;
} finally {
  cleanupLoadedSource();
}
