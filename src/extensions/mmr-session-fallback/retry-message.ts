import type { PersistedMmrSessionFallbackOverride } from "./state.js";

export interface MmrSessionFallbackAssistantMessage {
  role: "assistant";
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

export function createMmrSessionFallbackRetryMessage(
  message: MmrSessionFallbackAssistantMessage,
  override: PersistedMmrSessionFallbackOverride,
  originalError: string | undefined,
): MmrSessionFallbackAssistantMessage {
  const reason = override.reasonKind === "anthropic-overload"
    ? "upstream capacity"
    : "rate limit";
  return {
    ...message,
    stopReason: "error",
    errorMessage: `${reason}: pi-mmr applied a session fallback to ${override.selectedProvider}/${override.selectedModel} with thinking:${override.thinkingLevel}. Retrying this turn with the selected model. Original error: ${originalError ?? "provider quota error"}`,
  };
}
