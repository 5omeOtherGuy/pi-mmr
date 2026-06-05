import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractMessageSummary, extractSystemPrompt, extractToolNames } from "./capture.js";

/**
 * mmr-debug — opt-in live request/response capture for debugging model behavior.
 *
 * This extension is NOT registered in `package.json` `pi.extensions`, so it is
 * never auto-loaded for users. It is also excluded from the npm package via
 * `.npmignore`. Load it explicitly only when chasing a behavior bug:
 *
 *     pi -e "$PWD/src/extensions/mmr-debug/index.ts" ...
 *
 * It is fully inert unless `MMR_DEBUG_CAPTURE_FILE` is set: with no env var it
 * registers zero hooks and has no runtime cost. When the env var points at a
 * file, it appends one JSON Lines record per event correlating:
 *
 *   - "request"  : the assembled system prompt + advertised tools Pi serialized
 *                  into the provider request (ground truth — `getSystemPrompt()`
 *                  does NOT reflect payload-level rewrites)
 *   - "response" : provider HTTP status + headers (the hook exposes no body)
 *   - "message"  : the finalized assistant output (what the model produced)
 *
 * Records are tagged with `turn`, a monotonic `seq`, an ISO timestamp, and the
 * session id so a multi-turn behavior bug can be diffed turn-by-turn.
 *
 * Set `MMR_DEBUG_CAPTURE_FULL=1`/`true` to also dump the entire raw request
 * payload (all conversation messages) on each "request" record.
 *
 * Privacy: the capture file contains full prompt/session text and provider
 * response headers. It is written with mode 0600 and must never be committed
 * or shared. Point `MMR_DEBUG_CAPTURE_FILE` at a gitignored path.
 */

const CAPTURE_FILE_ENV = "MMR_DEBUG_CAPTURE_FILE";
const CAPTURE_FULL_ENV = "MMR_DEBUG_CAPTURE_FULL";

function isTruthyEnv(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function getSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getSessionId?.();
  } catch {
    return undefined;
  }
}

function getModelInfo(ctx: ExtensionContext): { provider: string; id: string } | undefined {
  const model = ctx.model;
  if (!model) return undefined;
  return { provider: model.provider, id: model.id };
}

export function createMmrDebugExtension() {
  return function mmrDebugExtension(pi: ExtensionAPI): void {
    const capturePath = process.env[CAPTURE_FILE_ENV];
    if (typeof capturePath !== "string" || capturePath.trim().length === 0) {
      // Inert: no capture target, register no hooks, zero runtime cost.
      return;
    }
    const resolvedPath = capturePath.trim();
    const captureFullPayload = isTruthyEnv(process.env[CAPTURE_FULL_ENV]);

    let seq = 0;
    let turn = -1;
    let ensuredDir = false;

    function write(record: Record<string, unknown>): void {
      try {
        if (!ensuredDir) {
          mkdirSync(dirname(resolvedPath), { recursive: true });
          ensuredDir = true;
        }
        appendFileSync(resolvedPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch {
        // Diagnostics must never disturb the session; swallow write failures.
      }
    }

    pi.on("turn_start", (event) => {
      turn = event.turnIndex;
    });

    pi.on("before_provider_request", (event, ctx) => {
      const systemPrompt = extractSystemPrompt(event.payload);
      const record: Record<string, unknown> = {
        kind: "request",
        seq: seq++,
        turn,
        ts: new Date().toISOString(),
        sessionId: getSessionId(ctx),
        model: getModelInfo(ctx),
        systemPromptSource: systemPrompt?.source,
        systemPrompt: systemPrompt?.text,
        tools: extractToolNames(event.payload),
      };
      if (captureFullPayload) record.payload = event.payload;
      write(record);
      // Never modify the payload: this is a read-only capture.
    });

    pi.on("after_provider_response", (event, ctx) => {
      write({
        kind: "response",
        seq: seq++,
        turn,
        ts: new Date().toISOString(),
        sessionId: getSessionId(ctx),
        status: event.status,
        headers: event.headers,
      });
    });

    pi.on("message_end", (event, ctx) => {
      const summary = extractMessageSummary(event.message);
      if (!summary || summary.role !== "assistant") return;
      write({
        kind: "message",
        seq: seq++,
        turn,
        ts: new Date().toISOString(),
        sessionId: getSessionId(ctx),
        role: summary.role,
        stopReason: summary.stopReason,
        text: summary.text,
      });
    });
  };
}

export default createMmrDebugExtension();
