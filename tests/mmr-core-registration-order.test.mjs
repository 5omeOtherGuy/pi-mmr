import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";
import { createMockPi } from "./helpers/pi-stub.mjs";

after(cleanupLoadedSource);

// Characterization guard for the load-bearing registration ORDER of the
// mmr-core entrypoint. Pi resolves duplicate shortcut keys last-registered-wins
// and hook dispatch can depend on registration sequence, so the slim wiring
// shell must reproduce the exact insertion order asserted here. The mock pi
// records commands/shortcuts/handlers as insertion-ordered Maps.
describe("mmr-core registration order", () => {
  it("registers flags, commands, shortcuts, and hooks in a stable order", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi, commands, shortcuts, handlers, flagDefs } = createMockPi();

    extension(pi);

    assert.deepEqual([...flagDefs.keys()], ["mmr-mode", "mmr-subagent", "mmr-parent-mode"]);

    assert.deepEqual([...commands.keys()], ["mode", "mmr-status", "mmr-changelog", "mmr-config"]);

    assert.deepEqual([...shortcuts.keys()], ["ctrl+shift+s", "alt+m", "ctrl+space", "alt+r"]);

    assert.deepEqual(
      [...handlers.keys()],
      [
        "session_start",
        "before_provider_request",
        "before_agent_start",
        "tool_call",
        "model_select",
        "input",
        "thinking_level_select",
      ],
    );
  });

  // Per-category Maps above cannot catch CROSS-category reordering (e.g. a hook
  // registered before a command) or a duplicate same-name registration masked
  // by Map#set. Record one chronological log of every registration call via a
  // proxy and pin the exact global sequence the slim wiring shell must emit:
  // flags -> commands -> shortcuts -> hooks, in order.
  it("registers everything in one stable chronological sequence", async () => {
    const extension = (await importSource("extensions/mmr-core/index.ts")).default;
    const { pi } = createMockPi();

    const sequence = [];
    const recordingPi = new Proxy(pi, {
      get(target, prop, receiver) {
        if (prop === "registerFlag") {
          return (name, opts) => {
            sequence.push(`flag:${name}`);
            return target.registerFlag(name, opts);
          };
        }
        if (prop === "registerCommand") {
          return (name, command) => {
            sequence.push(`command:${name}`);
            return target.registerCommand(name, command);
          };
        }
        if (prop === "registerShortcut") {
          return (key, definition) => {
            sequence.push(`shortcut:${key}`);
            return target.registerShortcut(key, definition);
          };
        }
        if (prop === "on") {
          return (name, handler) => {
            sequence.push(`hook:${name}`);
            return target.on(name, handler);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    extension(recordingPi);

    assert.deepEqual(sequence, [
      "flag:mmr-mode",
      "flag:mmr-subagent",
      "flag:mmr-parent-mode",
      "command:mode",
      "command:mmr-status",
      "command:mmr-changelog",
      "command:mmr-config",
      "shortcut:ctrl+shift+s",
      "shortcut:alt+m",
      "shortcut:ctrl+space",
      "shortcut:alt+r",
      "hook:session_start",
      "hook:before_provider_request",
      "hook:before_agent_start",
      "hook:tool_call",
      "hook:model_select",
      "hook:input",
      "hook:thinking_level_select",
    ]);
  });
});
