import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMmrModeController } from "./mode-controller.js";
import { registerMmrCommands } from "./command-registration.js";
import { registerMmrLifecycleHooks } from "./lifecycle-hooks.js";

export default function mmrCoreExtension(pi: ExtensionAPI): void {
  pi.registerFlag("mmr-mode", {
    description: "Start with an MMR mode: smart, smartGPT, smartSonnet, rush, test, large, deep, open, or free",
    type: "string",
  });

  pi.registerFlag("mmr-subagent", {
    description: "Run as an MMR subagent worker with a named profile (e.g. finder). Bypasses user-facing MMR locked modes.",
    type: "string",
  });

  pi.registerFlag("mmr-parent-mode", {
    description: "Parent MMR mode metadata for mode-derived subagent workers.",
    type: "string",
  });

  // Registration order is observable and load-bearing (pinned by
  // tests/mmr-core-registration-order.test.mjs): flags, then the commands and
  // shortcuts, then the lifecycle hooks. The controller owns all shared mutable
  // mode state; the registration modules talk to it through accessors only.
  const controller = createMmrModeController(pi);
  registerMmrCommands(pi, controller);
  registerMmrLifecycleHooks(pi, controller);
}
