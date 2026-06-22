import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { renderFooter, statusLineMatcher } from "./helpers/footer.mjs";

after(cleanupLoadedSource);

async function buildState(overrides = {}) {
  const { createMmrModeState } = await importSource("extensions/mmr-core/state.ts");
  const { getMmrMode } = await importSource("extensions/mmr-core/modes.ts");

  const modeKey = overrides.modeKey ?? "smart";
  const mode = { ...getMmrMode(modeKey), ...(overrides.modeOverrides ?? {}) };
  const baseModelResolution = modeKey === "free" || modeKey === "open"
    ? {
      targetModel: "",
      requestedModels: [],
      modelFound: false,
      modelApplied: false,
      fallbackApplied: false,
      candidates: [],
    }
    : {
      targetModel: "claude-opus-4-8",
      requestedModels: ["claude-opus-4-8", "gpt-5.5"],
      selectedProvider: "claude-subscription",
      selectedModel: "claude-opus-4-8",
      selectedThinkingLevel: "medium",
      modelFound: true,
      modelApplied: true,
      fallbackApplied: false,
      candidates: [],
    };
  const baseTools = modeKey === "free"
    ? { requestedTools: [], activeTools: ["read", "bash"], missingTools: [], deferredTools: [], gatedTools: [], disabledTools: [], decisions: [] }
    : {
      requestedTools: ["Read", "oracle", "chart"],
      activeTools: ["read"],
      missingTools: [],
      deferredTools: ["chart"],
      gatedTools: [],
      disabledTools: [],
      decisions: [
        { requested: "Read", chosen: "read", chosenTools: ["read"], candidates: ["read"], status: "active", owner: "mmr-core", diagnostic: "Read → read" },
        { requested: "chart", candidates: [], chosenTools: [], status: "deferred", owner: "mmr-tasks", diagnostic: "chart: deferred until mmr-tasks ships" },
      ],
    };

  return createMmrModeState({
    mode,
    source: overrides.source ?? "command",
    rejectedSources: overrides.rejectedSources,
    modelResolution: { ...baseModelResolution, ...(overrides.modelResolution ?? {}) },
    tools: { ...baseTools, ...(overrides.tools ?? {}) },
    effectiveMaxInputTokens: overrides.effectiveMaxInputTokens,
    effectiveContextWindow: overrides.effectiveContextWindow,
    effectiveMaxOutputTokens: overrides.effectiveMaxOutputTokens,
    baselineCaptured: overrides.baselineCaptured,
    baselineModel: overrides.baselineModel,
    appliedAt: "2026-05-08T00:00:00.000Z",
    settingsFilesRead: overrides.settingsFilesRead,
    settingsWarnings: overrides.settingsWarnings,
    featureGateDecisions: overrides.featureGateDecisions,
  });
}

describe("mmr-core footer status", () => {
  it("owns the locked-mode footer with native Pi stats plus model and MMR mode", async () => {
    const { updateMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildState({
      effectiveContextWindow: 1000000,
      effectiveMaxInputTokens: 968000,
      modelResolution: {
        selectedProvider: "claude-subscription",
        selectedModel: "claude-opus-4-8",
      },
    });
    const footers = [];
    const statuses = [];
    const previousHome = process.env.HOME;
    process.env.HOME = "/test/home/user";
    let lines;
    try {
      updateMmrStatus({
        cwd: "/test/home/user/projects/pi-mmr",
        sessionManager: {
          getCwd: () => "/test/home/user/projects/pi-mmr",
          getSessionName: () => undefined,
          getEntries: () => [
            {
              type: "message",
              message: {
                role: "assistant",
                usage: { input: 558000, output: 68000, cacheRead: 22000000, cacheWrite: 167000, cost: { total: 12.981 } },
              },
            },
          ],
        },
        modelRegistry: {
          find: () => ({ provider: "claude-subscription", id: "claude-opus-4-8" }),
          isUsingOAuth: () => true,
        },
        model: { provider: "claude-subscription", id: "claude-opus-4-8" },
        getContextUsage: () => ({ tokens: 58500, contextWindow: 1000000, percent: 19.5 }),
        ui: {
          setStatus: (key, value) => statuses.push({ key, value }),
          setFooter: (factory) => footers.push(factory),
          theme: { fg: (_name, value) => value },
        },
      }, state);
      // Render the footer while the test HOME override is still active so the
      // tilde compression in status.ts sees the test HOME, not the dev's real one.
      lines = renderFooter(footers.at(-1), { branch: "main", width: 120 });
    } finally {
      process.env.HOME = previousHome;
    }

    assert.equal(statuses.at(-1)?.value, undefined);
    assert.equal(typeof footers.at(-1), "function");
    assert.equal(lines[0], "~/projects/pi-mmr (main)");
    assert.match(lines[1], /^↑558k ↓68k R22M W167k \$12\.981 \(sub\) 19\.5%\/1.0M \(auto\)\s+opus-4\.8 • smart$/);
  });


  it("uses per-mode context windows for footer denominators", async () => {
    const { updateMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const cases = [
      { modeKey: "smart", effectiveContextWindow: 1000000, effectiveMaxInputTokens: 968000, tokens: 60000, usageContextWindow: 1000000, usagePercent: 20, percent: "20.0", contextWindow: "1.0M", model: "opus-4.8", mode: "smart" },
      // rush/deep carry no pi-mmr profile, so the footer denominator is Pi's
      // own registered window reported through getContextUsage (here 272k).
      { modeKey: "rush", effectiveContextWindow: undefined, effectiveMaxInputTokens: undefined, tokens: 78000, usageContextWindow: 272000, usagePercent: 28.7, percent: 28.7, contextWindow: "272k", model: "gpt-5.5", mode: "rush" },
      { modeKey: "large", effectiveContextWindow: 1000000, effectiveMaxInputTokens: 968000, tokens: 195000, usageContextWindow: 1000000, usagePercent: 19.5, percent: 19.5, contextWindow: "1.0M", model: "opus-4.6", mode: "large" },
      { modeKey: "deep", effectiveContextWindow: undefined, effectiveMaxInputTokens: undefined, tokens: 78000, usageContextWindow: 272000, usagePercent: 28.7, percent: 28.7, contextWindow: "272k", model: "gpt-5.5", mode: "deep" },
    ];

    for (const testCase of cases) {
      const state = await buildState({
        modeKey: testCase.modeKey,
        effectiveContextWindow: testCase.effectiveContextWindow,
        effectiveMaxInputTokens: testCase.effectiveMaxInputTokens,
        modelResolution: {
          selectedProvider: testCase.modeKey === "deep" || testCase.modeKey === "rush" ? "openai-codex" : "claude-subscription",
          selectedModel: testCase.modeKey === "smart" ? "claude-opus-4-8" : testCase.modeKey === "rush" ? "gpt-5.5" : testCase.modeKey === "deep" ? "gpt-5.5" : testCase.modeKey === "large" ? "claude-opus-4-6" : "claude-opus-4-8",
        },
      });
      const footers = [];
      updateMmrStatus({
        cwd: process.cwd(),
        sessionManager: { getEntries: () => [] },
        modelRegistry: { find: () => undefined, isUsingOAuth: () => false },
        model: undefined,
        getContextUsage: () => ({ tokens: testCase.tokens, contextWindow: testCase.usageContextWindow, percent: testCase.usagePercent }),
        ui: {
          setStatus: () => {},
          setFooter: (factory) => footers.push(factory),
          theme: { fg: (_name, value) => value },
        },
      }, state);

      const lines = renderFooter(footers.at(-1));
      const expected = statusLineMatcher({
        percent: testCase.percent,
        contextWindow: testCase.contextWindow,
        model: testCase.model,
        mode: testCase.mode,
      });
      assert.match(lines[1], expected, `${testCase.modeKey}: ${lines[1]} ~= ${expected}`);
    }
  });

  it("restores Pi's native footer in free mode", async () => {
    const { updateMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildState({ modeKey: "free" });
    const footers = [];
    const statuses = [];

    updateMmrStatus({
      cwd: process.cwd(),
      sessionManager: { getEntries: () => [] },
      modelRegistry: { find: () => undefined, isUsingOAuth: () => false },
      model: undefined,
      getContextUsage: () => undefined,
      ui: {
        setStatus: (key, value) => statuses.push({ key, value }),
        setFooter: (factory) => footers.push(factory),
        theme: { fg: (_name, value) => value },
      },
    }, state);

    assert.equal(statuses.at(-1)?.value, undefined);
    assert.equal(footers.at(-1), undefined);
  });
});

describe("mmr-core /mmr-status", () => {
  it("explains source, configured fallback, tool resolution, gates, and state version", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildState({
      source: "flag",
      rejectedSources: [{ source: "settings", value: "fast", reason: "invalid mode" }],
      modelResolution: {
        targetModel: "gpt-5.5",
        requestedModels: ["claude-opus-4-8", "gpt-5.5"],
        selectedProvider: "openai",
        selectedModel: "gpt-5.5",
        fallbackApplied: true,
        fallbackReason: "claude-opus-4-8 not registered",
      },
      tools: {
        requestedTools: ["Read", "oracle"],
        activeTools: ["read"],
        missingTools: ["oracle"],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [
          { requested: "Read", chosen: "read", chosenTools: ["read"], candidates: ["read"], status: "active", owner: "mmr-core", diagnostic: "Read → read" },
          { requested: "oracle", chosenTools: [], candidates: ["oracle"], status: "missing", owner: "mmr-core", diagnostic: "oracle: no available Pi tool among oracle" },
        ],
      },
    });

    const output = formatMmrStatus(state);

    assert.match(output, /Mode: Smart \(smart\)/);
    assert.match(output, /Selected source: flag/);
    assert.match(output, /Rejected sources:/);
    assert.match(output, /settings="fast"/);
    assert.match(output, /Configured fallback: yes/);
    assert.match(output, /claude-opus-4-8 not registered/);
    assert.match(output, /Tool resolution:/);
    assert.match(output, /Read -> read/);
    assert.match(output, /oracle -> missing/);
    assert.match(output, /Feature gates:/);
    assert.match(output, /mmr-subagents: missing/);
    assert.match(output, /Policy warnings:/);
    assert.match(output, /Thinking: medium \(request policy: Anthropic adaptive\/high\)/);
    assert.match(output, /Context: 300k total \/ 64k max out \/ 236k max in/);
    assert.match(output, /Context cap: model default/);
    assert.doesNotMatch(output, /Native compaction note:/);
    assert.match(output, /Baseline captured: no/);
    assert.match(output, /State version: 1/);
  });

  it("reports baseline capture diagnostics", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");

    const state = await buildState({ baselineCaptured: true, baselineModel: "openai/gpt-5.4" });

    assert.match(formatMmrStatus(state), /Baseline captured: yes \(openai\/gpt-5\.4\)/);
  });

  it("reports librarian active and gated tool resolution", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const active = await buildState({
      modeOverrides: { availabilityNotes: [] },
      tools: {
        requestedTools: ["librarian"],
        activeTools: ["librarian"],
        missingTools: [],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [
          { requested: "librarian", chosen: "librarian", chosenTools: ["librarian"], candidates: ["librarian"], status: "active", owner: "mmr-subagents", diagnostic: "librarian → librarian" },
        ],
      },
      featureGateDecisions: [
        { gate: "mmr-subagents", status: "enabled", source: "mmr-subagents", reason: "mmr-subagents worker tools available: finder, oracle, Task, librarian." },
      ],
    });
    const activeStatus = formatMmrStatus(active);
    assert.match(activeStatus, /Active tools: librarian/);
    assert.match(activeStatus, /librarian -> librarian \(active\) via mmr-subagents/);
    assert.match(activeStatus, /mmr-subagents: enabled via mmr-subagents/);

    const gated = await buildState({
      modeOverrides: { availabilityNotes: [] },
      tools: {
        requestedTools: ["librarian"],
        activeTools: [],
        missingTools: [],
        deferredTools: [],
        gatedTools: ["librarian"],
        disabledTools: [],
        decisions: [
          {
            requested: "librarian",
            chosenTools: [],
            candidates: [],
            status: "gated",
            owner: "mmr-subagents",
            diagnostic: "librarian: gated behind mmr-subagents (librarian: requires mmr-web with web_search and read_web_page active.)",
          },
        ],
      },
      featureGateDecisions: [
        { gate: "mmr-subagents", status: "enabled", source: "mmr-subagents", reason: "mmr-subagents worker tools available: finder, oracle, Task." },
      ],
    });
    const gatedStatus = formatMmrStatus(gated);
    assert.match(gatedStatus, /Gated tools: librarian/);
    assert.match(gatedStatus, /librarian -> gated \(gated\) via mmr-subagents/);
    assert.match(gatedStatus, /requires mmr-web with web_search and read_web_page active/);
  });

  it("reports the active mode input profile and no cap in free mode", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");

    const smart = await buildState({ effectiveMaxInputTokens: 968000 });
    const free = await buildState({ modeKey: "free" });

    assert.match(formatMmrStatus(smart), /Context cap: 968000 input tokens \(mode profile\)/);
    assert.doesNotMatch(formatMmrStatus(smart), /Native compaction note:/);
    assert.match(formatMmrStatus(free), /Context cap: none/);
    assert.doesNotMatch(formatMmrStatus(free), /Native compaction note:/);
  });

  it("omits 'max out' and 'max in' from /mmr-status Context when the resolved provider does not accept max_output_tokens (openai-codex)", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");

    const deepCodex = await buildState({
      modeKey: "deep",
      modelResolution: {
        targetModel: "gpt-5.5",
        requestedModels: ["gpt-5.5", "gpt-5.4"],
        selectedProvider: "openai-codex",
        selectedModel: "gpt-5.5",
        modelFound: true,
        modelApplied: true,
        fallbackApplied: false,
      },
      effectiveContextWindow: undefined,
      effectiveMaxOutputTokens: 128000,
      effectiveMaxInputTokens: undefined,
    });

    const status = formatMmrStatus(deepCodex);
    // deep carries no pi-mmr context profile and Codex streams output in-window,
    // so there is no total/max-out/max-in to show — Pi's native window applies.
    assert.match(status, /Context: provider default/);
    assert.doesNotMatch(status, /max out/);
    assert.doesNotMatch(status, /max in/);
  });

  it("uses clamped active context metadata when a selected provider route is smaller", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");

    const smart = await buildState({
      effectiveContextWindow: 200000,
      effectiveMaxOutputTokens: 64000,
      effectiveMaxInputTokens: 136000,
    });

    assert.match(formatMmrStatus(smart), /Context: 200k total \/ 64k max out \/ 136k max in/);
    assert.match(formatMmrStatus(smart), /Context cap: 136000 input tokens \(mode profile\)/);
  });

  it("includes policy warnings alongside mode and tool state", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildState({
      modeOverrides: { availabilityNotes: ["Runtime subagent behavior is not implemented in mmr-core."] },
      modelResolution: {
        fallbackApplied: true,
        fallbackReason: "Selected fallback after skipping openai-codex/gpt-5.5: not registered.",
      },
      tools: {
        missingTools: ["oracle"],
        deferredTools: ["chart"],
        decisions: [
          { requested: "Read", chosen: "read", chosenTools: ["read"], candidates: ["read"], status: "active", owner: "mmr-core", diagnostic: "Read → read" },
          { requested: "oracle", chosenTools: [], candidates: ["oracle"], status: "missing", owner: "mmr-core", diagnostic: "oracle: no available Pi tool among oracle" },
        ],
      },
    });

    const status = formatMmrStatus(state);

    assert.match(status, /Selected source: command/);
    assert.match(status, /Resolved model available: yes/);
    assert.match(status, /Model applied: yes/);
    assert.match(status, /Active tools: read/);
    assert.match(status, /Missing tools: oracle/);
    assert.match(status, /Deferred tools: chart/);
    assert.match(status, /Tool resolution:/);
    assert.match(status, /Feature gates:/);
    assert.match(status, /Policy warnings: model fallback applied: Selected fallback after skipping openai-codex\/gpt-5\.5: not registered\. Using only one provider is not recommended because MMR modes are optimized around model-specific strengths and weaknesses\.; missing tools: oracle; Runtime subagent behavior is not implemented in mmr-core\./);
  });

  it("reports no policy warnings for a clean locked-mode state", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");

    const status = formatMmrStatus(await buildState({ modeOverrides: { availabilityNotes: [] } }));

    assert.match(status, /Policy warnings: none/);
  });

  it("reports open mode as native Pi controls with Smart-derived tools and no model policy", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");

    const status = formatMmrStatus(await buildState({
      modeKey: "open",
      tools: {
        requestedTools: ["read", "web_search", "Task"],
        activeTools: ["read", "web_search", "Task"],
        missingTools: [],
        deferredTools: [],
        gatedTools: [],
        disabledTools: [],
        decisions: [
          { requested: "read", chosen: "read", chosenTools: ["read"], candidates: ["read"], status: "active", owner: "mmr-core", diagnostic: "read → read" },
          { requested: "web_search", chosen: "web_search", chosenTools: ["web_search"], candidates: ["web_search"], status: "active", owner: "mmr-web", diagnostic: "web_search → web_search" },
          { requested: "Task", chosen: "Task", chosenTools: ["Task"], candidates: ["Task"], status: "active", owner: "mmr-subagents", diagnostic: "Task → Task" },
        ],
      },
    }));

    assert.match(status, /Mode: Open \(open\)/);
    assert.match(status, /Mode control: native Pi model\/thinking\/prompt/);
    assert.match(status, /Tool surface: Smart tools/);
    assert.match(status, /Resolved model: none/);
    assert.match(status, /Thinking: Pi native \(request policy: native Pi controls\)/);
    assert.match(status, /Context cap: none/);
    assert.match(status, /Prompt surface: Pi standard prompt \(passthrough\)/);
    assert.match(status, /Active tools: read, web_search, Task/);
    assert.match(status, /web_search -> web_search \(active\) via mmr-web/);
    assert.match(status, /Task -> Task \(active\) via mmr-subagents/);
    assert.match(status, /Policy warnings: none/);
  });

  it("does not warn about missing model resolution while free mode delegates to native Pi controls", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");

    const status = formatMmrStatus(await buildState({ modeKey: "free" }));

    assert.match(status, /Mode control: native Pi controls/);
    assert.match(status, /Policy warnings: none/);
    assert.match(status, /State version: 1/);
  });

  it("returns the unresolved message when state is missing", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    assert.match(formatMmrStatus(undefined), /not been resolved/i);
  });

  it("lists the settings files that were loaded for the current resolution", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildState({
      settingsFilesRead: ["/home/user/.pi/agent/settings.json", "/proj/.pi/settings.json"],
    });

    const status = formatMmrStatus(state);

    assert.match(status, /Settings files read: \/home\/user\/\.pi\/agent\/settings\.json, \/proj\/\.pi\/settings\.json/);
  });

  it("reports 'Settings files read: none' when no settings files were loaded", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildState({ settingsFilesRead: [] });

    const status = formatMmrStatus(state);

    assert.match(status, /Settings files read: none/);
  });

  it("surfaces settings load warnings under their own diagnostics group", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildState({
      settingsWarnings: [
        "Could not read MMR settings from /proj/.pi/settings.json: Unexpected token } in JSON at position 12",
      ],
    });

    const status = formatMmrStatus(state);

    assert.match(status, /Settings warnings:/);
    assert.match(status, /Could not read MMR settings from \/proj\/\.pi\/settings\.json/);
  });

  it("groups policy diagnostics by severity in /mmr-status", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildState({
      modelResolution: {
        fallbackApplied: true,
        fallbackReason: "claude-opus-4-8 not registered",
      },
      tools: {
        missingTools: ["oracle"],
        decisions: [
          { requested: "Read", chosen: "read", chosenTools: ["read"], candidates: ["read"], status: "active", owner: "mmr-core", diagnostic: "Read → read" },
          { requested: "oracle", chosenTools: [], candidates: ["oracle"], status: "missing", owner: "mmr-core", diagnostic: "oracle: no concrete tool available" },
        ],
      },
    });

    const status = formatMmrStatus(state);

    assert.match(status, /Diagnostics by severity:/);
    assert.match(status, /warning:[\s\S]*?- model fallback applied: claude-opus-4-8 not registered/);
    assert.match(status, /warning:[\s\S]*?- missing tools: oracle/);
  });

  it("omits the debug section unless debug output is requested", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildState({
      modelResolution: {
        candidates: [
          {
            requestedModel: "claude-opus-4-8",
            provider: "claude-subscription",
            model: "claude-opus-4-8",
            registered: false,
            authenticated: false,
            subscription: false,
            attempted: false,
            applied: false,
            reason: "provider not registered",
          },
          {
            requestedModel: "gpt-5.5",
            provider: "openai",
            model: "gpt-5.5",
            registered: true,
            authenticated: true,
            subscription: false,
            attempted: true,
            applied: true,
          },
        ],
      },
    });

    const normal = formatMmrStatus(state);
    assert.doesNotMatch(normal, /Debug:/);
  });

  it("renders model/tool resolution debug detail when debug is requested", async () => {
    const { formatMmrStatus } = await importSource("extensions/mmr-core/status.ts");
    const state = await buildState({
      source: "flag",
      rejectedSources: [{ source: "settings", value: "fast", reason: "invalid mode" }],
      modelResolution: {
        candidates: [
          {
            requestedModel: "claude-opus-4-8",
            provider: "claude-subscription",
            model: "claude-opus-4-8",
            registered: false,
            authenticated: false,
            subscription: false,
            attempted: false,
            applied: false,
            reason: "provider not registered",
          },
          {
            requestedModel: "gpt-5.5",
            provider: "openai",
            model: "gpt-5.5",
            registered: true,
            authenticated: true,
            subscription: false,
            attempted: true,
            applied: true,
          },
        ],
      },
    });

    const debug = formatMmrStatus(state, { debug: true });

    assert.match(debug, /Debug:/);
    assert.match(debug, /Model preference candidates:/);
    assert.match(debug, /claude-subscription\/claude-opus-4-8[\s\S]*?provider not registered/);
    assert.match(debug, /openai\/gpt-5\.5[\s\S]*?applied/);
    assert.match(debug, /Rejected sources:[\s\S]*?settings="fast"/);
  });

  // Boundary-value parity pins for the footer compact token formatter. The
  // first four tiers (count < 10_000_000) share mmr-core's compact formatter;
  // the >=10M tier (Math.round + "M") is unique to the footer. Output is
  // frozen byte-for-byte so the Item 5b shared-helper refactor cannot change
  // any rendered footer number.
  it("formats footer token counts byte-for-byte across boundary values", async () => {
    const { formatFooterTokens } = await importSource("extensions/mmr-core/status.ts");
    const cases = [
      [999, "999"],
      [1000, "1.0k"],
      [1500, "1.5k"],
      [12345, "12k"],
      [999999, "1000k"],
      [1000000, "1.0M"],
      [1500000, "1.5M"],
      [9999999, "10.0M"],
      [10000000, "10M"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(formatFooterTokens(input), expected, `formatFooterTokens(${input})`);
    }
  });

  // Edge inputs: the lower tiers delegate to mmr-core's compact formatter, so
  // zero/negatives/non-integers match it byte-for-byte; NaN falls through to
  // the footer's own >=10M `Math.round(... )M` tail ("NaNM"). Pinned so the
  // shared-helper refactor cannot drift on non-boundary inputs.
  it("formats footer edge inputs (zero, negatives, non-integers, NaN) byte-for-byte", async () => {
    const { formatFooterTokens } = await importSource("extensions/mmr-core/status.ts");
    const cases = [
      [0, "0"],
      [-1, "-1"],
      [-1500, "-1500"],
      [1234.5, "1.2k"],
      [Number.NaN, "NaNM"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(formatFooterTokens(input), expected, `formatFooterTokens(${input})`);
    }
  });
});
