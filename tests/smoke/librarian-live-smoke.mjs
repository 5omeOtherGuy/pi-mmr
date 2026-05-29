#!/usr/bin/env node
// Live smoke test: spawn a real `pi --mode json -p --no-session` worker
// through the librarian tool and report the result.
//
// Outside the npm test glob on purpose — this script makes a real
// subprocess call and may make live provider/web requests. Run it explicitly:
//
//   node tests/smoke/librarian-live-smoke.mjs
//
// Optional environment knobs:
//   LIBRARIAN_SMOKE_QUERY            — override the research query
//   LIBRARIAN_SMOKE_CONTEXT          — optional context passed to librarian
//   LIBRARIAN_SMOKE_TIMEOUT_MS       — abort after this many ms (default 180000)
//   LIBRARIAN_SMOKE_EXTENSION_PATHS  — opt-in dev-loop isolation: comma-
//                                      separated extension paths. When set,
//                                      the smoke appends `--no-extensions`
//                                      and `-e <path>` for each so the
//                                      spawned `pi` loads only those paths.
//
// Exits 0 on a non-empty successful result; 1 otherwise. Always prints the
// worker command, args, status, usage, and visible output so the operator can
// verify Pi actually ran repository research.

import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";
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

const QUERY = process.env.LIBRARIAN_SMOKE_QUERY
  ?? "In 5omeOtherGuy/pi-mmr, where is the mmr-subagents README documented?";
const CONTEXT = process.env.LIBRARIAN_SMOKE_CONTEXT?.trim();
const TIMEOUT_MS = Number.parseInt(process.env.LIBRARIAN_SMOKE_TIMEOUT_MS ?? "180000", 10);
const WEB_SOURCE_PATH = "/virtual/pi-mmr/extensions/mmr-web/index.ts";

function webHost() {
  const tools = [
    {
      name: "web_search",
      description: "Search public repository pages and related documentation.",
      promptSnippet: "Search the public web for repository evidence.",
      promptGuidelines: ["Use for public repository search before reading specific pages."],
      parameters: { type: "object", properties: { objective: { type: "string" } }, required: ["objective"], additionalProperties: false },
      sourceInfo: { path: WEB_SOURCE_PATH },
    },
    {
      name: "read_web_page",
      description: "Read a public repository URL as Markdown.",
      promptSnippet: "Read a public repository page.",
      promptGuidelines: ["Use after search to verify specific repository pages."],
      parameters: { type: "object", properties: { url: { type: "string" }, objective: { type: "string" } }, required: ["url"], additionalProperties: false },
      sourceInfo: { path: WEB_SOURCE_PATH },
    },
  ];
  return {
    getActiveTools: () => tools.map((tool) => tool.name),
    getAllTools: () => tools,
  };
}

async function main() {
  const promptsMod = await importSource("extensions/mmr-subagents/prompts.ts");
  promptsMod.registerMmrSubagentsPromptBuilders();
  const ownershipMod = await importSource("extensions/mmr-web/tool-ownership.ts");
  ownershipMod.registerMmrWebToolSourcePath(WEB_SOURCE_PATH);
  const librarianMod = await importSource("extensions/mmr-subagents/librarian.ts");
  const { createLibrarianTool, LIBRARIAN_WORKER_TOOLS } = librarianMod;

  const cwd = path.resolve(import.meta.dirname, "..", "..");
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  abortTimer.unref();

  const devExtensionPaths = (process.env.LIBRARIAN_SMOKE_EXTENSION_PATHS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const devLoopExtraArgs = devExtensionPaths.length > 0
    ? ["--no-extensions", ...devExtensionPaths.flatMap((p) => ["-e", p])]
    : [];
  if (devLoopExtraArgs.length > 0) {
    console.log(`[librarian-smoke] dev-loop isolation: ${devLoopExtraArgs.join(" ")}`);
  } else {
    console.log("[librarian-smoke] production invocation (no -e / --no-extensions overrides)");
  }
  const forcedResolve = (args) => ({ command: "pi", args: [...args, ...devLoopExtraArgs] });
  const tool = createLibrarianTool({ pi: webHost(), runnerDeps: { resolveInvocation: forcedResolve } });

  const authStorage = new AuthStorage(new FileAuthStorageBackend());
  const modelRegistry = ModelRegistry.create(authStorage);
  const ctx = { cwd, modelRegistry };
  const availableAll = modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  console.log(`[librarian-smoke] available models (${availableAll.length}): ${availableAll.join(", ") || "(none)"}`);

  let progressUpdates = 0;
  const onUpdate = () => { progressUpdates += 1; };

  const params = CONTEXT ? { query: QUERY, context: CONTEXT } : { query: QUERY };
  const startedAt = Date.now();
  console.log(`[librarian-smoke] cwd=${cwd}`);
  console.log(`[librarian-smoke] query=${JSON.stringify(QUERY)}`);
  if (CONTEXT) console.log(`[librarian-smoke] context=${JSON.stringify(CONTEXT)}`);
  console.log(`[librarian-smoke] worker tools=${LIBRARIAN_WORKER_TOOLS.join(",")}`);

  let result;
  try {
    result = await tool.execute("smoke-1", params, controller.signal, onUpdate, ctx);
  } finally {
    clearTimeout(abortTimer);
  }
  const elapsedMs = Date.now() - startedAt;

  const details = result.details;
  console.log("---");
  console.log(`[librarian-smoke] status=${details.status}`);
  console.log(`[librarian-smoke] command: ${details.command}`);
  console.log(`[librarian-smoke] args: ${JSON.stringify(details.args)}`);
  console.log(`[librarian-smoke] exitCode=${details.exitCode} signal=${details.signal ?? "null"} aborted=${details.aborted}`);
  console.log(`[librarian-smoke] model=${details.model ?? "(pi default)"} reportedModel=${details.reportedModel ?? "(none)"}`);
  console.log(`[librarian-smoke] usage=${JSON.stringify(details.usage)}`);
  console.log(`[librarian-smoke] ignoredJsonLines=${details.ignoredJsonLines} outputTruncated=${details.outputTruncated}`);
  console.log(`[librarian-smoke] progress updates=${progressUpdates}  elapsedMs=${elapsedMs}`);
  if ((details.stderr ?? "").trim().length > 0) {
    console.log(`[librarian-smoke] stderr (tail):\n${details.stderr.split("\n").slice(-10).join("\n")}`);
  }
  console.log("---");
  console.log("[librarian-smoke] visible content:");
  console.log(result.content[0]?.text ?? "(no content)");

  await wait(50);

  const text = (result.content[0]?.text ?? "").trim();
  const accessFailure = /couldn['’]t retrieve|cannot retrieve|unable to (?:retrieve|inspect|read)|access failed|can't verify|cannot access/i.test(text);
  if (details.subagentActivationError) {
    console.error(`[librarian-smoke] FAIL: subagent activation failed: ${details.subagentActivationError}`);
    process.exitCode = 1;
  } else if (accessFailure) {
    console.error("[librarian-smoke] FAIL: worker reported repository access failure");
    process.exitCode = 1;
  } else if (details.status !== "success" || details.aborted || details.exitCode !== 0 || text.length === 0) {
    console.error("[librarian-smoke] FAIL");
    process.exitCode = 1;
  } else {
    console.log("[librarian-smoke] OK");
  }
}

try {
  await main();
} catch (error) {
  console.error("[librarian-smoke] exception:", error?.stack ?? error);
  process.exitCode = 1;
} finally {
  cleanupLoadedSource();
}
