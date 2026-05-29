// Step 3: subagent activation in a child Pi process.
//
// Pins the `--mmr-subagent <name>` lifecycle invariants. mmr-core's
// `session_start` handler must detect the flag, resolve the named
// profile, and apply ONLY the profile's model/thinking/tools — without
// running locked-mode activation, baseline capture, Free-mode tool
// restoration, mode-state persistence, or `MMR_EVENT_STATE_CHANGED`
// emission. Invalid profile / unresolvable model must fail closed before
// any mutation.

import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, beforeEach, describe, it } from "node:test";
import { cleanupLoadedSource, getPreparedSourceRoot, importSource } from "./helpers/load-src.mjs";
import { createMockExtensionContext, createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

// Pi exposes the worker's CLI flags via `process.argv` in the child Pi
// process; mmr-core reads `--model` and `--tools` from there to decide
// whether the runner supplied them explicitly. Tests must therefore
// scope any argv mutation to the affected test and restore it after.
let __originalArgv = null;
function setMockedArgv(extra) {
  if (__originalArgv === null) __originalArgv = process.argv;
  process.argv = ["node", "pi", ...extra];
}
function restoreArgv() {
  if (__originalArgv !== null) {
    process.argv = __originalArgv;
    __originalArgv = null;
  }
}

const MMR_GITHUB_TOOL_OWNERSHIP_MODULE = "extensions/mmr-github/tool-ownership.ts";
const GITHUB_SOURCE_PATH = "/virtual/pi-mmr/extensions/mmr-github/index.ts";
const GITHUB_TOOLS = [
  "read_github",
  "list_directory_github",
  "glob_github",
  "search_github",
  "commit_search",
  "diff_github",
  "list_repositories",
];

function githubToolInfos(sourcePath = GITHUB_SOURCE_PATH) {
  return GITHUB_TOOLS.map((name) => ({
    name,
    ...(sourcePath === null ? {} : { sourceInfo: { path: sourcePath } }),
  }));
}

async function resetMmrGithubToolSourcePaths() {
  const {
    __resetMmrGithubToolSourcePathsForTests,
    registerMmrGithubToolSourcePath,
  } = await importSource(MMR_GITHUB_TOOL_OWNERSHIP_MODULE);
  __resetMmrGithubToolSourcePathsForTests();
  registerMmrGithubToolSourcePath(GITHUB_SOURCE_PATH);
}

const BASE_PROMPT = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "",
  "Available tools:",
  "- grep: Search files",
  "- find: Locate files",
  "- read: Read files",
  "",
  "Guidelines:",
  "- Be concise.",
  "",
  "Pi documentation (read only when relevant):",
  "- core docs",
  "",
  "Current date: 2026-05-24",
  "",
  "Task: search for X.",
].join("\n");

async function importRuntime() {
  const url = pathToFileURL(path.join(getPreparedSourceRoot(), "extensions/mmr-core/runtime.ts")).href;
  return import(url);
}

function createPi(options = {}) {
  return createMockPi({
    activeTools: options.activeTools ?? ["grep", "find", "read"],
    allTools: options.allTools ?? ["grep", "find", "read"],
    setModelResult: options.setModelResult ?? true,
    flags: options.flags ?? {},
  });
}

function createContext(options = {}) {
  return createMockExtensionContext({
    models: options.models ?? [],
    authenticated: options.authenticated ?? true,
    cwd: options.cwd ?? "/tmp/pi-mmr-worker",
    model: options.model,
  });
}

describe("mmr-core subagent activation", () => {
  beforeEach(async () => {
    const runtime = await importRuntime();
    runtime.setMmrModeState(undefined);
    runtime.setMmrSubagentState(undefined);
    restoreArgv();
  });
  after(() => {
    restoreArgv();
  });

  it("registers subagent worker flags with descriptions", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, flagDefs } = createPi();
    extension(pi);
    assert.ok(flagDefs.has("mmr-subagent"), "must register --mmr-subagent flag");
    const def = flagDefs.get("mmr-subagent");
    assert.equal(def.type, "string");
    assert.match(def.description ?? "", /subagent|profile/i);
    assert.ok(flagDefs.has("mmr-parent-mode"), "must register --mmr-parent-mode flag");
    const parentDef = flagDefs.get("mmr-parent-mode");
    assert.equal(parentDef.type, "string");
    assert.match(parentDef.description ?? "", /parent|mode/i);
  });

  it("activates the 'finder' profile when --mmr-subagent=finder is set at session_start", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls, emits } = createPi({
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    // Profile-resolved model applied via setModel.
    assert.equal(calls.setModel.length, 1, "setModel must be called exactly once");
    assert.equal(calls.setModel[0].provider, "openai-codex");
    assert.equal(calls.setModel[0].id, "gpt-5.4-mini");

    // Profile tool allowlist applied verbatim.
    assert.equal(calls.setActiveTools.length, 1);
    assert.deepEqual(calls.setActiveTools[0], ["grep", "find", "read"]);

    // No locked-mode policy paths fired.
    assert.equal(runtime.getMmrModeState(), undefined, "locked MmrModeState must not be set");
    assert.deepEqual(calls.appendEntry, [], "no mmr-core.mode-state persistence");
    const stateEvents = emits.filter((e) => e.name === "mmr-core:state-changed");
    assert.equal(stateEvents.length, 0, "no locked-mode state-changed event must be emitted");
    // No error notifications.
    assert.equal(notifications.find((n) => n.level === "error"), undefined);
  });

  it("applies the session fallback env override (#9) over profile defaults at child activation", async () => {
    // Issue #9: the parent forwards a user-selected fallback through the
    // env channel for the spawn only. Child activation must read it and
    // resolve the same route the parent passed via --model, taking
    // precedence over the profile's default model preferences (never
    // persisted to settings).
    const { MMR_SUBAGENT_MODEL_PREFERENCES_ENV } = await importSource("extensions/mmr-core/subagent-model-override-env.ts");
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers, calls } = createPi({ flags: { "mmr-subagent": "finder" } });
    const { ctx } = createContext({
      // Both authenticated. Finder's default chain would pick gpt-5.4-mini
      // first; the env override forces claude-haiku-4-5 instead.
      models: [
        { provider: "openai-codex", id: "gpt-5.4-mini" },
        { provider: "anthropic", id: "claude-haiku-4-5" },
      ],
    });
    extension(pi);

    const original = process.env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV];
    process.env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV] = JSON.stringify([
      { model: "claude-haiku-4-5", providers: ["anthropic"] },
    ]);
    try {
      await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    } finally {
      if (original === undefined) delete process.env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV];
      else process.env[MMR_SUBAGENT_MODEL_PREFERENCES_ENV] = original;
    }

    assert.equal(calls.setModel.length, 1, "setModel must be called once");
    assert.equal(calls.setModel[0].provider, "anthropic");
    assert.equal(calls.setModel[0].id, "claude-haiku-4-5");
  });

  it("filters profile.tools through the tool registry before pi.setActiveTools — same path modes use", async () => {
    // Subagent activation must mirror locked-mode activation: a profile
    // is allowed to list its full intended tool surface (including tools
    // owned by sibling extensions that have not yet shipped), and the
    // registry filters that intent down to the subset Pi currently has
    // registered. This is the same contract `applyLockedMode` honors via
    // `resolveMmrTools(...).activeTools`, so deferred/gated/missing
    // tools never reach `pi.setActiveTools`.
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    // Oracle's profile lists 7 tools; only the first three are
    // universally registered in this stub. The remaining four are
    // either deferred (read_session / find_session) or owned by a
    // sibling extension that may not be enabled (web_search /
    // read_web_page). The activation filter must drop the absent
    // names before reaching Pi.
    const { pi, handlers, calls } = createPi({
      activeTools: ["read", "grep", "find"],
      allTools: ["read", "grep", "find"],
      flags: { "mmr-subagent": "oracle" },
    });
    const { ctx } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.5" }],
    });
    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(calls.setActiveTools.length, 1);
    assert.deepEqual(
      calls.setActiveTools[0],
      ["read", "grep", "find"],
      "deferred / gated / missing profile tools must be dropped before reaching Pi",
    );

    const state = runtime.getMmrSubagentState();
    assert.ok(state);
    assert.deepEqual(
      [...state.activeTools],
      ["read", "grep", "find"],
      "MmrSubagentState.activeTools must record the actually-applied subset, not the unfiltered intent list",
    );
  });

  it("honors registry rules: preferExact deferred tools activate when Pi has them concretely registered", async () => {
    // Companion to the filter test. Shipped extension-owned tools that retain
    // deferred core defaults use `preferExact` so cache-isolated loaders can
    // still activate them when Pi exposes same-name concrete tools. This now
    // covers mmr-web and the initial mmr-history read/find compatibility names.
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers, calls } = createPi({
      activeTools: ["read", "grep", "find", "web_search", "read_web_page", "read_session", "find_session"],
      allTools: ["read", "grep", "find", "web_search", "read_web_page", "read_session", "find_session"],
      flags: { "mmr-subagent": "oracle" },
    });
    const { ctx } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.5" }],
    });
    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(calls.setActiveTools.length, 1);
    assert.deepEqual(
      [...calls.setActiveTools[0]].sort(),
      ["find", "find_session", "grep", "read", "read_session", "read_web_page", "web_search"],
      "only registry-active tools must reach Pi; preferExact deferred tools activate through concrete Pi tools",
    );
  });

  it("applies the finder profile's MINIMAL thinking level", async () => {
    // Finder's worker is a search/grep planner; we encode `minimal`
    // explicitly so providers that support a low-effort reasoning lane
    // (Anthropic, OpenAI Responses) use it instead of defaulting to a
    // higher provider default. Providers without such a lane resolve
    // `minimal` via mmr-core's existing thinking-level policy.
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers, calls } = createPi({
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
    });
    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.equal(calls.setThinkingLevel.length, 1, "setThinkingLevel must be called for finder profile");
    assert.equal(calls.setThinkingLevel[0], "minimal");
  });

  it("exposes subagent runtime state via getMmrSubagentState after activation", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers } = createPi({
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
    });
    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const state = runtime.getMmrSubagentState();
    assert.ok(state, "subagent runtime state must be set after activation");
    assert.equal(state.profile, "finder");
    assert.equal(state.provider, "openai-codex");
    assert.equal(state.model, "gpt-5.4-mini");
    assert.equal(state.promptRoute, "standalone");
    assert.deepEqual([...state.activeTools], ["grep", "find", "read"]);
  });

  it("before_agent_start preserves Pi's base prompt byte-for-byte when subagent is active", async () => {
    // Strict pass-through: a subagent worker must receive whatever
    // base prompt Pi already assembled (including any `--append-system-prompt`
    // content) without any mmr-core rewrites. Returning `undefined`
    // from the handler is the canonical no-op shape Pi understands.
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers } = createPi({
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
    });
    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const result = await handlers.get("before_agent_start")({
      systemPrompt: BASE_PROMPT,
      systemPromptOptions: {},
    });

    assert.equal(
      result,
      undefined,
      "subagent activation must not return a systemPrompt override; Pi keeps the base prompt verbatim",
    );
  });

  it("before_provider_request does not apply locked-mode policy when subagent is active", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers } = createPi({
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
    });
    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const payload = { messages: [], maxTokens: 100 };
    const result = await handlers.get("before_provider_request")({ payload });
    assert.equal(result, undefined, "subagent activation must not mutate the provider request");
    assert.deepEqual(payload, { messages: [], maxTokens: 100 });
  });

  it("tool_call does not block tools that are inside the subagent allowlist", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, handlers } = createPi({
      activeTools: ["grep", "find", "read"],
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
    });
    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    const result = await handlers.get("tool_call")({ toolName: "grep" });
    assert.equal(result, undefined, "tool_call must not block tools in the profile allowlist");
  });

  it("falls through to normal locked-mode activation when --mmr-subagent is unset", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers } = createPi();
    const { ctx } = createContext({
      models: [
        { provider: "claude-subscription", id: "claude-opus-4-8" },
      ],
      authenticated: true,
    });
    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);
    assert.equal(runtime.getMmrModeState()?.mode, "smart");
    assert.equal(runtime.getMmrSubagentState(), undefined);
  });

  it("clears any prior subagent runtime state when --mmr-subagent is unset on session_start", async () => {
    // The mmr-core runtime is a process-singleton inside the child Pi
    // process; without an explicit clear, a prior subagent activation
    // could leak its posture into a normal session and silently disable
    // locked-mode policy. session_start MUST reset subagent state when
    // no `--mmr-subagent` flag is present, before applying any other
    // policy.
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    runtime.setMmrSubagentState({
      profile: "finder",
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      thinkingLevel: "minimal",
      promptRoute: "standalone",
      activeTools: ["grep", "find", "read"],
      activatedAt: "2026-05-24T00:00:00.000Z",
    });
    assert.ok(runtime.getMmrSubagentState(), "pre-seeded subagent state must be present");

    const { pi, handlers } = createPi();
    const { ctx } = createContext({
      models: [{ provider: "claude-subscription", id: "claude-opus-4-8" }],
      authenticated: true,
    });
    extension(pi);
    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(
      runtime.getMmrSubagentState(),
      undefined,
      "session_start without --mmr-subagent must clear any prior subagent state",
    );
  });

  it("fails closed before any mutation when --mmr-subagent names an unknown profile", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls, emits } = createPi({
      flags: { "mmr-subagent": "no-such-profile" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
    });
    extension(pi);

    await assert.rejects(
      handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx),
      /no-such-profile|unknown subagent profile/i,
      "session_start must reject to make the failure visible to the runner",
    );

    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.deepEqual(calls.appendEntry, []);
    assert.equal(runtime.getMmrModeState(), undefined);
    assert.equal(runtime.getMmrSubagentState(), undefined);
    const errorNotifications = notifications.filter((n) => n.level === "error");
    assert.equal(errorNotifications.length, 1);
    assert.match(errorNotifications[0].message, /no-such-profile|unknown subagent profile/i);
    const stateEvents = emits.filter((e) => e.name === "mmr-core:state-changed");
    assert.equal(stateEvents.length, 0);
  });

  it("fails closed before any mutation when no model route resolves", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls } = createPi({
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx, notifications } = createContext({
      // No GPT-5.4 Mini or Haiku 4.5 registered.
      models: [{ provider: "openai-codex", id: "gpt-5.5" }],
    });
    extension(pi);

    await assert.rejects(
      handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx),
      /could not resolve any model route/i,
    );

    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.equal(runtime.getMmrSubagentState(), undefined);
    const errorNotifications = notifications.filter((n) => n.level === "error");
    assert.equal(errorNotifications.length, 1);
    assert.match(errorNotifications[0].message, /finder/);
    assert.match(errorNotifications[0].message, /could not resolve any model route/i);
  });

  it("fails closed when an explicit --model on the CLI conflicts with the profile-resolved route", async () => {
    // Pi parses `--model` from argv and applies it before extensions
    // load, so `ctx.model` reflects the explicit value. We additionally
    // require `--model` to actually be on `process.argv`; otherwise
    // `ctx.model` may simply be Pi's default/restored model and must
    // not be treated as an explicit override.
    setMockedArgv(["--mmr-subagent", "finder", "--model", "claude-subscription/claude-opus-4-8"]);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls } = createPi({
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
      model: { provider: "claude-subscription", id: "claude-opus-4-8" },
    });
    extension(pi);

    await assert.rejects(
      handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx),
      /claude-opus-4-8/,
    );

    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setActiveTools, []);
    assert.equal(runtime.getMmrSubagentState(), undefined);
    const errorNotifications = notifications.filter((n) => n.level === "error");
    assert.equal(errorNotifications.length, 1);
    assert.match(errorNotifications[0].message, /claude-opus-4-8/);
    assert.match(errorNotifications[0].message, /gpt-5\.4-mini/);
  });

  it("does NOT fail closed on a non-default ctx.model when --model is absent from the CLI", async () => {
    // Pi may carry a `ctx.model` from session restore, settings, or its
    // own default selection. Treating that as an explicit --model would
    // false-positive a mismatch and block legitimate subagent workers.
    // Activation must only validate ctx.model against the profile when
    // `--model` is actually on argv.
    setMockedArgv(["--mmr-subagent", "finder"]);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls } = createPi({
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
      // ctx.model is Pi's own default/restored model, not from `--model`.
      model: { provider: "claude-subscription", id: "claude-opus-4-8" },
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(calls.setModel.length, 1, "profile-resolved model must still be applied");
    assert.equal(calls.setModel[0].provider, "openai-codex");
    assert.equal(calls.setModel[0].id, "gpt-5.4-mini");
    const state = runtime.getMmrSubagentState();
    assert.ok(state, "subagent state must be set");
    assert.equal(state.profile, "finder");
    assert.equal(notifications.filter((n) => n.level === "error").length, 0);
  });

  it("fails closed when explicit --tools on the CLI differ from the profile tool allowlist", async () => {
    setMockedArgv(["--mmr-subagent", "finder", "--tools", "bash,write"]);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls } = createPi({
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
    });
    extension(pi);

    await assert.rejects(
      handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx),
      /bash.*write|tool allowlist/i,
    );

    assert.deepEqual(calls.setModel, []);
    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.setThinkingLevel, []);
    assert.equal(runtime.getMmrSubagentState(), undefined);
    const errorNotifications = notifications.filter((n) => n.level === "error");
    assert.equal(errorNotifications.length, 1);
    assert.match(errorNotifications[0].message, /bash|write/);
    assert.match(errorNotifications[0].message, /grep|find|read|allowlist/);
  });

  it("accepts explicit --tools on the CLI that match the profile allowlist (order-independent)", async () => {
    setMockedArgv(["--mmr-subagent", "finder", "--tools", "read,find,grep"]);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls } = createPi({
      flags: { "mmr-subagent": "finder" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(calls.setActiveTools.length, 1);
    assert.deepEqual(calls.setActiveTools[0], ["grep", "find", "read"]);
    assert.ok(runtime.getMmrSubagentState());
    assert.equal(notifications.filter((n) => n.level === "error").length, 0);
  });

  it("activates librarian when child GitHub tools are owned by mmr-github", async () => {
    await resetMmrGithubToolSourcePaths();
    setMockedArgv(["--mmr-subagent", "librarian", "--tools", GITHUB_TOOLS.join(",")]);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls } = createPi({
      activeTools: [],
      allTools: githubToolInfos(),
      flags: { "mmr-subagent": "librarian" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "claude-subscription", id: "claude-opus-4-6" }],
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(notifications.filter((n) => n.level === "error").length, 0);
    assert.equal(calls.setActiveTools.length, 1);
    assert.deepEqual(calls.setActiveTools[0], GITHUB_TOOLS);
    assert.equal(runtime.getMmrSubagentState()?.profile, "librarian");
  });

  it("fails closed before mutation when librarian child GitHub tools are not owned by mmr-github", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const cases = [
      { label: "missing sourceInfo", sourcePath: null },
      { label: "third-party source", sourcePath: "/virtual/other-extension/index.ts" },
    ];

    for (const c of cases) {
      restoreArgv();
      runtime.setMmrSubagentState(undefined);
      await resetMmrGithubToolSourcePaths();
      setMockedArgv(["--mmr-subagent", "librarian", "--tools", GITHUB_TOOLS.join(",")]);
      const { pi, handlers, calls } = createPi({
        activeTools: [],
        allTools: githubToolInfos(c.sourcePath),
        flags: { "mmr-subagent": "librarian" },
      });
      const { ctx, notifications } = createContext({
        models: [{ provider: "claude-subscription", id: "claude-opus-4-6" }],
      });
      extension(pi);

      await assert.rejects(
        handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx),
        /mmr-github-owned read-only GitHub tools/,
        c.label,
      );

      assert.deepEqual(calls.setModel, [], `${c.label}: model must not be mutated`);
      assert.deepEqual(calls.setActiveTools, [], `${c.label}: tools must not be mutated`);
      assert.equal(runtime.getMmrSubagentState(), undefined, `${c.label}: subagent state must stay unset`);
      assert.equal(notifications.filter((n) => n.level === "error").length, 1, c.label);
    }
  });

  it("accepts a parent-reduced --tools subset on a from-parent profile (F1: workerTools, not profile.tools)", async () => {
    // When the parent computes a deny-aware, registered-tool intersection
    // smaller than profile.tools (e.g. mmr-web not enabled => no
    // read_web_page or web_search) and passes that subset via --tools to
    // a child Pi process activating the same profile, child activation
    // must validate against the same intersection. Previously the child
    // path validated against raw profile.tools and rejected the subset
    // as tools.mismatch; the invocation-resolver-backed path validates
    // against the resolved workerTools instead.
    setMockedArgv([
      "--mmr-subagent", "task-subagent",
      "--tools", "read,bash,edit,write,finder,skill,task_list",
    ]);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls } = createPi({
      activeTools: ["read","bash","edit","write","finder","skill","task_list"],
      allTools: ["read","bash","edit","write","finder","skill","task_list"],
      flags: { "mmr-subagent": "task-subagent" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "claude-subscription", id: "claude-opus-4-8" }],
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(
      notifications.filter((n) => n.level === "error").length,
      0,
      "child activation must accept a parent-reduced workerTools subset, not fail closed with tools.mismatch",
    );
    assert.equal(calls.setActiveTools.length, 1);
    assert.deepEqual(
      [...calls.setActiveTools[0]].sort(),
      ["bash","edit","finder","read","skill","task_list","write"],
      "active worker tools must equal the deny-aware, registered-tool intersection",
    );
    assert.ok(runtime.getMmrSubagentState());
  });

  it("uses --mmr-parent-mode to distinguish Rush Task thinking from non-Rush explicit worker routes", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const workerTools = ["read","bash","edit","write","finder","skill","task_list"];
    const cases = [
      { label: "smart GPT fallback", parentMode: "smart", provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "medium" },
      { label: "rush GPT primary", parentMode: "rush", provider: "openai-codex", model: "gpt-5.5", thinkingLevel: "off" },
      { label: "smart Haiku fallback", parentMode: "smart", provider: "claude-subscription", model: "claude-haiku-4-5", thinkingLevel: "low" },
      { label: "rush Haiku fallback", parentMode: "rush", provider: "claude-subscription", model: "claude-haiku-4-5", thinkingLevel: "off" },
    ];

    for (const c of cases) {
      restoreArgv();
      runtime.setMmrModeState(undefined);
      runtime.setMmrSubagentState(undefined);
      setMockedArgv([
        "--mmr-subagent", "task-subagent",
        "--mmr-parent-mode", c.parentMode,
        "--model", `${c.provider}/${c.model}`,
        "--tools", workerTools.join(","),
      ]);
      const { pi, handlers, calls } = createPi({
        activeTools: workerTools,
        allTools: workerTools,
        flags: { "mmr-subagent": "task-subagent" },
      });
      const { ctx, notifications } = createContext({
        models: [{ provider: c.provider, id: c.model }],
        model: { provider: c.provider, id: c.model },
      });
      extension(pi);

      await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

      assert.equal(notifications.filter((n) => n.level === "error").length, 0, c.label);
      assert.equal(calls.setModel[0].provider, c.provider, c.label);
      assert.equal(calls.setModel[0].id, c.model, c.label);
      assert.equal(calls.setThinkingLevel[0], c.thinkingLevel, c.label);
      assert.equal(runtime.getMmrSubagentState()?.thinkingLevel, c.thinkingLevel, c.label);
    }
  });

  it("rejects invalid --mmr-parent-mode for mode-derived worker activation", async () => {
    setMockedArgv([
      "--mmr-subagent", "task-subagent",
      "--mmr-parent-mode", "free",
    ]);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const workerTools = ["read","bash","edit","write","finder","skill","task_list"];
    const { pi, handlers, calls } = createPi({
      activeTools: workerTools,
      allTools: workerTools,
      flags: { "mmr-subagent": "task-subagent" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.5" }],
    });
    extension(pi);

    await assert.rejects(
      handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx),
      /invalid --mmr-parent-mode/i,
    );

    assert.equal(calls.setModel.length, 0);
    assert.equal(calls.setActiveTools.length, 0);
    assert.equal(runtime.getMmrSubagentState(), undefined);
    assert.match(notifications.at(-1)?.message ?? "", /invalid --mmr-parent-mode/);
  });

  it("rejects explicit --tools that include a deny-listed entry, even when present in profile.tools (F1 inverse)", async () => {
    // Belt-and-suspenders: if a third party ever invokes the worker with
    // --tools containing a denied/recursive tool name, the child must
    // fail closed because the resolved workerTools excludes the deny set.
    setMockedArgv([
      "--mmr-subagent", "task-subagent",
      "--tools", "read,bash,edit,write,finder,skill,task_list,Task",
    ]);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls } = createPi({
      activeTools: ["read","bash","edit","write","finder","skill","task_list","Task"],
      allTools: ["read","bash","edit","write","finder","skill","task_list","Task"],
      flags: { "mmr-subagent": "task-subagent" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "claude-subscription", id: "claude-opus-4-8" }],
    });
    extension(pi);

    await assert.rejects(
      handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx),
      /tools|allowlist|worker tool set/i,
    );

    assert.deepEqual(calls.setActiveTools, []);
    assert.deepEqual(calls.setModel, []);
    assert.equal(runtime.getMmrSubagentState(), undefined);
    assert.equal(
      notifications.filter((n) => n.level === "error").length,
      1,
      "a denied/recursive tool in --tools must surface a single error notification",
    );
  });

  it("activates oracle without --tools so the child resolves workerTools from registered intersection (mmr-web/mmr-history not loaded)", async () => {
    // Oracle's profile lists optional tools whose owning extensions
    // (mmr-web, mmr-history) may not be loaded in the child Pi process.
    // The oracle parent now omits explicit --tools (see oracle.ts) so
    // the child computes its own workerTools as profile.tools \ deny ∩
    // registered. With only read/grep/find registered, the child still
    // activates cleanly and applies just those three as the active set.
    setMockedArgv(["--mmr-subagent", "oracle"]);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls } = createPi({
      activeTools: ["read", "grep", "find"],
      allTools: ["read", "grep", "find"],
      flags: { "mmr-subagent": "oracle" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.5" }],
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(
      notifications.filter((n) => n.level === "error").length,
      0,
      "oracle activation must not fail tools.mismatch when optional profile tools are unregistered",
    );
    assert.equal(calls.setActiveTools.length, 1);
    assert.deepEqual(
      [...calls.setActiveTools[0]].sort(),
      ["find", "grep", "read"],
      "child must apply the deny-aware, registered intersection of profile.tools as the active set",
    );
    assert.ok(runtime.getMmrSubagentState());
  });

  it("activates history-reader with profile.tools=[] (intentional no-tool subagent)", async () => {
    // history-reader runs a sanitized session-analysis prompt and never
    // calls a local tool; its profile declares tools: []. The resolver
    // must distinguish this intentional empty set from a deny/registered
    // collapse — the latter still fails closed with tools.empty.
    setMockedArgv(["--mmr-subagent", "history-reader"]);
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const runtime = await importRuntime();
    const { pi, handlers, calls } = createPi({
      activeTools: ["read", "grep", "find"],
      allTools: ["read", "grep", "find"],
      flags: { "mmr-subagent": "history-reader" },
    });
    const { ctx, notifications } = createContext({
      models: [{ provider: "openai-codex", id: "gpt-5.4-mini" }],
    });
    extension(pi);

    await handlers.get("session_start")({ type: "session_start", reason: "new" }, ctx);

    assert.equal(
      notifications.filter((n) => n.level === "error").length,
      0,
      "history-reader activation must succeed with profile.tools: []",
    );
    assert.equal(calls.setActiveTools.length, 1);
    assert.deepEqual(
      [...calls.setActiveTools[0]],
      [],
      "history-reader child must apply an empty active tool set",
    );
    assert.ok(runtime.getMmrSubagentState());
  });
});
