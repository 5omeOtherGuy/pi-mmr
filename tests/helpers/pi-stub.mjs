// Shared mock Pi host and ExtensionContext factories used across mmr-core tests.
//
// These stubs deliberately expose the union of Pi-host capabilities the
// extension code reads from, rather than a per-test minimal slice, so adding a
// new capability to the production code does not silently bypass existing
// tests. Tests opt into observed-behavior assertions by reading the returned
// `calls`/`commands`/`shortcuts`/`handlers`/`emits` recorders.

/**
 * Build a mock Pi host with recorders for every observable side effect.
 *
 * Options:
 *  - `activeTools` (default `["read", "bash"]`): initial set returned by `getActiveTools`.
 *  - `allTools` (default = `activeTools`): array of tool names or `{name, sourceInfo}` entries.
 *  - `thinkingLevel` (default `undefined`): initial value for `getThinkingLevel`.
 *  - `flagValue` (default `undefined`): legacy single value returned by `getFlag` for any
 *    name. Used by mmr-core tests that read a single flag (`mmr-mode`). When set, it
 *    takes priority over per-name values and seeded defaults so existing tests behave
 *    identically.
 *  - `flags` (default `{}`): per-flag-name initial values. Use this instead of `flagValue`
 *    when an extension reads more than one flag (e.g. mmr-tasks reads
 *    `task-widget-toggle-key`). Per-name explicit values override seeded defaults from
 *    `registerFlag(name, { default })`.
 *  - `shortcutsThrowOn` (default `[]`): array of shortcut keys for which
 *    `registerShortcut` will throw, simulating Pi's duplicate-binding rejection.
 *    Used to exercise the toolbox's fallback chain (`ctrl+t` -> `ctrl+shift+t` -> `alt+t`).
 *  - `setModelResult` (default `true`): boolean returned by `setModel`.
 *  - `initialModel` (default `undefined`): initial value tracked by `getModel`.
 *  - `onModelSet(model, { handlers, eventContext })` (optional): async hook
 *    invoked after `setModel`, used to simulate Pi emitting downstream events.
 *  - `onThinkingLevelSet(level, { handlers, eventContext })` (optional): hook
 *    invoked after `setThinkingLevel`.
 *
 * Returns `{ pi, calls, commands, shortcuts, handlers, tools, flagDefs, emits,
 * setEventContext }`. `tools`, `commands`, and `flagDefs` are also exposed as
 * `pi.tools` / `pi.commands` / `pi.flagDefs` so tests can drive registered
 * tools (`pi.tools.get(name).execute(...)`) and assert on the declarative
 * surfaces the extension exposes to Pi (e.g. the description+type of a
 * registered CLI flag).
 */
export function createMockPi(options = {}) {
  const initialActiveTools = options.activeTools ?? ["read", "bash"];
  const rawAllTools = options.allTools ?? [...initialActiveTools];
  const allTools = rawAllTools.map((entry) =>
    typeof entry === "string" ? { name: entry } : { ...entry },
  );

  const tools = new Map();
  const commands = new Map();
  const shortcuts = new Map();
  const handlers = new Map();
  // Records the raw `opts` passed to `registerFlag(name, opts)` so tests
  // can assert on declared metadata (description, type, default) without
  // round-tripping through the resolved `getFlag` value.
  const flagDefs = new Map();
  const emits = [];
  const calls = {
    setActiveTools: [],
    setModel: [],
    setThinkingLevel: [],
    appendEntry: [],
    sendUserMessage: [],
  };

  // Per-name flag values. Seeded from `options.flags` (explicit per-test
  // overrides) and from `registerFlag(name, { default })` declarations. The
  // legacy `options.flagValue` is consulted first in `getFlag` so mmr-core
  // tests that pass a single value for the mmr-mode flag keep working.
  const flagValues = new Map(Object.entries(options.flags ?? {}));
  const shortcutsThrowOn = new Set(options.shortcutsThrowOn ?? []);

  let activeTools = [...initialActiveTools];
  let thinkingLevel = options.thinkingLevel;
  let currentModel = options.initialModel;
  let eventContext;

  const pi = {
    registerFlag: (name, opts) => {
      flagDefs.set(name, opts);
      // Pi's real CLI parser exposes the declared default via `getFlag` when
      // the user did not pass the flag. Mirror that here so extensions that
      // do `registerFlag(...); getFlag(...)` at load time get the default.
      // `options.flags` takes priority over the seeded default.
      if (opts && opts.default !== undefined && !flagValues.has(name)) {
        flagValues.set(name, opts.default);
      }
    },
    getFlag: (name) => {
      // Legacy single-value compatibility: when callers pass `flagValue`,
      // every `getFlag(...)` returns it. mmr-core tests rely on this.
      if (options.flagValue !== undefined) return options.flagValue;
      return flagValues.get(name);
    },
    registerTool: (def) => tools.set(def.name, def),
    tools,
    commands,
    flagDefs,
    shortcuts,
    handlers,
    getActiveTools: () => [...activeTools],
    getAllTools: () => allTools.map((tool) => ({ ...tool })),
    setActiveTools: (toolList) => {
      calls.setActiveTools.push([...toolList]);
      activeTools = [...toolList];
    },
    setModel: async (model) => {
      currentModel = model;
      calls.setModel.push(model);
      if (options.onModelSet) await options.onModelSet(model, { handlers, eventContext });
      return options.setModelResult ?? true;
    },
    getModel: () => currentModel,
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level) => {
      thinkingLevel = level;
      calls.setThinkingLevel.push(level);
      if (options.onThinkingLevelSet) {
        options.onThinkingLevelSet(level, { handlers, eventContext });
      }
    },
    appendEntry: (...entry) => calls.appendEntry.push(entry),
    sendUserMessage: (content, opts) => {
      calls.sendUserMessage.push({ content, options: opts });
    },
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut: (key, definition) => {
      if (shortcutsThrowOn.has(key)) {
        throw new Error(`mock pi: shortcut already bound: ${key}`);
      }
      shortcuts.set(key, definition);
    },
    on: (name, handler) => handlers.set(name, handler),
    events: {
      emit: (name, data) => emits.push({ name, data }),
      on: () => () => {},
      off: () => {},
    },
  };

  return {
    pi,
    calls,
    commands,
    shortcuts,
    handlers,
    tools,
    flagDefs,
    emits,
    setEventContext: (ctx) => {
      eventContext = ctx;
    },
  };
}

/**
 * Build a mock ExtensionContext for shortcut/command/lifecycle handlers.
 *
 * Options:
 *  - `models` (default `[]`): provider/model registrations seen by modelRegistry.
 *  - `authenticated` (default `true`): drives `hasConfiguredAuth`.
 *  - `hasUI` (default `true`): controls `ctx.hasUI` for code that gates on it.
 *  - `sessionId`, `sessionName`, `cwd`: identity-shaped fields.
 *  - `model`: the `ctx.model` currently selected by Pi.
 *  - `getContextUsage` (default returns `undefined`): hook for token-usage info.
 *  - `entries` (default `[]`): mutable list returned by `sessionManager.getEntries`.
 *
 * Returns the ctx and the recorders it populates:
 *   `{ ctx, notifications, statuses, footers, selectCalls, entries }`.
 *
 * `ctx.ui.select` returns `undefined` by default; assign a custom impl on
 * `ctx.ui.select` if a test needs to drive the picker.
 */
export function createMockExtensionContext(options = {}) {
  const models = options.models ?? [];
  const authenticated = options.authenticated ?? true;
  const hasUI = options.hasUI ?? true;
  const entries = options.entries ?? [];
  const cwd = options.cwd ?? process.cwd();
  const getContextUsage = options.getContextUsage ?? (() => undefined);

  const notifications = [];
  const statuses = [];
  const footers = [];
  const selectCalls = [];
  const compactCalls = [];

  const ctx = {
    cwd,
    hasUI,
    sessionId: options.sessionId,
    sessionName: options.sessionName,
    model: options.model,
    sessionManager: {
      getEntries: () => entries,
      getCwd: () => cwd,
      getSessionId: () => options.sessionId,
      getSessionName: () => options.sessionName,
    },
    modelRegistry: {
      getAll: () => models,
      find: (provider, modelId) =>
        models.find((model) => model.provider === provider && model.id === modelId),
      hasConfiguredAuth: () => authenticated,
      isUsingOAuth: (model) =>
        model.provider.endsWith("subscription") || model.provider.endsWith("codex"),
    },
    getContextUsage,
    isIdle: () => true,
    compact: (opts) => {
      compactCalls.push(opts);
    },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (key, value) => statuses.push({ key, value }),
      setFooter: (factory) => footers.push(factory),
      select: async (title, choices) => {
        selectCalls.push({ title, options: choices });
        return undefined;
      },
      theme: { fg: (_name, value) => value },
    },
  };

  return { ctx, notifications, statuses, footers, selectCalls, entries, compactCalls };
}
