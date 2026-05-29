import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

const BASE_PROMPT = readFileSync(path.join(import.meta.dirname, "fixtures/mmr-core-prompts/base.md"), "utf8");

after(cleanupLoadedSource);

const MODELS = [
  { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000 },
  { provider: "claude-subscription", id: "claude-opus-4-8", contextWindow: 1_000_000, maxTokens: 128_000 },
  { provider: "openai-codex", id: "gpt-5.5", contextWindow: 400_000, maxTokens: 128_000 },
  { provider: "claude-subscription", id: "claude-haiku-4-5" },
];

function createContext() {
  return createMockExtensionContext({ models: MODELS });
}

function createPi() {
  return createMockPi({
    activeTools: ["read", "bash", "grep"],
    allTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  });
}

async function importRuntime() {
  const runtimeUrl = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(runtimeUrl);
}

describe("mmr-core lifecycle smoke", () => {
  it("loads the extension, resolves an initial mode, switches modes, and appends the MMR prompt layer", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);
    const { ctx, notifications, statuses, footers } = createContext();
    const { pi, commands, handlers, calls } = createPi();

    extension(pi);

    assert.equal(commands.has("mode"), true);
    assert.equal(commands.has("mmr-status"), true);
    assert.equal(typeof handlers.get("session_start"), "function");
    assert.equal(typeof handlers.get("before_agent_start"), "function");

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.equal(runtime.getMmrModeState()?.mode, "smart");
    assert.equal(statuses.at(-1)?.value, undefined);
    assert.equal(typeof footers.at(-1), "function");
    const footer = footers.at(-1)({ requestRender: () => {} }, { fg: (_name, value) => value }, { getGitBranch: () => "main", onBranchChange: () => () => {}, getExtensionStatuses: () => new Map(), getAvailableProviderCount: () => 1 });
    const footerLines = footer.render(100);
    assert.equal(footerLines.length, 2);
    assert.match(footerLines[0], /\(main\)$/);
    assert.match(footerLines[1], /\?%\/1\.0M \(auto\)\s+opus-4\.8 • smart$/);

    await commands.get("mode").handler("rush", ctx);
    assert.equal(runtime.getMmrModeState()?.mode, "rush");
    assert.equal(calls.setModel.at(-1)?.id, "gpt-5.5");
    assert.equal(calls.setThinkingLevel.at(-1), "off");
    assert.match(notifications.at(-1)?.message, /MMR mode activated: Rush \(rush\)/);

    const result = await handlers.get("before_agent_start")({ systemPrompt: BASE_PROMPT, systemPromptOptions: {} });
    assert.match(result.systemPrompt, /^You are an expert coding assistant operating inside pi, a coding agent harness\. <mmr_mode name="rush">You and the user share one workspace\./);
    assert.match(result.systemPrompt, /<\/mmr_mode>\n\n## Tool use/);
    assert.match(result.systemPrompt, /## Response style\n\nSpeed and low token use are the priority\./);
    assert.doesNotMatch(result.systemPrompt, /<!-- mmr-core/);
    assert.doesNotMatch(result.systemPrompt, /### Tool policy/);
  });

  it("surfaces the settings files read and load warnings through /mmr-status", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-mmr-lifecycle-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    try {
      const home = path.join(tempRoot, "home");
      const project = path.join(tempRoot, "project");
      mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
      mkdirSync(path.join(project, ".pi"), { recursive: true });

      const homeSettingsPath = path.join(home, ".pi/agent/settings.json");
      const projectSettingsPath = path.join(project, ".pi/settings.json");

      writeFileSync(homeSettingsPath, JSON.stringify({ mmrCore: { defaultMode: "smart" } }));
      writeFileSync(projectSettingsPath, JSON.stringify({ mmrCore: { toolAliases: "oops" } }));

      process.env.HOME = home;
      process.env.USERPROFILE = home;

      const extension = (await importSource("extensions/mmr-core/index.ts")).default;
      const runtime = await importRuntime();
      runtime.setMmrModeState(undefined);
      const { ctx, notifications } = createContext();
      ctx.cwd = project;
      const { pi, commands, handlers } = createPi();

      extension(pi);
      await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

      notifications.length = 0;
      await commands.get("mmr-status").handler("", ctx);
      const status = notifications.at(-1)?.message ?? "";

      assert.match(status, new RegExp(`Settings files read:.*${homeSettingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(status, new RegExp(`Settings files read:.*${projectSettingsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(status, /Settings warnings:/);
      assert.match(status, /toolAliases/);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("renders the /mmr-status debug section only when a debug arg is passed", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);
    const { ctx, notifications } = createContext();
    const { pi, commands, handlers } = createPi();

    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    notifications.length = 0;
    await commands.get("mmr-status").handler("", ctx);
    assert.doesNotMatch(notifications.at(-1)?.message ?? "", /\nDebug:\n/);

    for (const arg of ["debug", "--debug", "  debug  "]) {
      notifications.length = 0;
      await commands.get("mmr-status").handler(arg, ctx);
      const message = notifications.at(-1)?.message ?? "";
      assert.match(message, /\nDebug:\n/, `expected Debug section for arg ${JSON.stringify(arg)}`);
      assert.match(message, /Model candidates:/);
    }
  });
});
