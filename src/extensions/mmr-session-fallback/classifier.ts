import { isMmrSubscriptionProvider } from "../mmr-core/provider-constants.js";

export type MmrSessionFallbackQuotaKind =
  | "openai-usage-limit"
  | "anthropic-rate-limit"
  | "anthropic-overload"
  | "copilot-quota"
  | "generic-hard-quota"
  | "not-quota";

export interface MmrSessionFallbackErrorInput {
  provider?: string;
  errorMessage?: string;
}

export interface MmrSessionFallbackErrorClassification {
  kind: MmrSessionFallbackQuotaKind;
  shouldPrompt: boolean;
  friendlyMessage: string;
}

function normalize(value: string | undefined): string {
  return value ?? "";
}

function includesHardQuota(message: string): boolean {
  return /usage[_ -]?limit[_ -]?reached|usage[_ -]?not[_ -]?included|insufficient[_ -]?quota|quota exceeded|billing quota|out of quota/i.test(message);
}

function includesRateLimit(message: string): boolean {
  return /rate[_ -]?limit|too many requests|\b429\b/i.test(message);
}

function includesOverloadOnly(message: string): boolean {
  return /overloaded/i.test(message) && !includesRateLimit(message) && !includesHardQuota(message);
}

function includesSilentAnthropicStreamStall(message: string): boolean {
  return /upstream_capacity_signal=silent_200_stream/i.test(message)
    && /retryable=true/i.test(message);
}

export function classifyMmrSessionFallbackError(input: MmrSessionFallbackErrorInput): MmrSessionFallbackErrorClassification {
  const provider = normalize(input.provider);
  const message = normalize(input.errorMessage);
  const lowerProvider = provider.toLowerCase();

  if (!message) {
    return { kind: "not-quota", shouldPrompt: false, friendlyMessage: "No subscription quota condition detected." };
  }

  if (lowerProvider === "openai-codex" || /You have hit your ChatGPT usage limit/i.test(message)) {
    const prompt = /You have hit your ChatGPT usage limit|rate[_ -]?limit[_ -]?exceeded/i.test(message)
      || includesRateLimit(message)
      || includesHardQuota(message);
    return {
      kind: prompt ? "openai-usage-limit" : "not-quota",
      shouldPrompt: prompt,
      friendlyMessage: prompt ? "The active subscription-backed route reported a usage limit." : "No subscription quota condition detected.",
    };
  }

  if (lowerProvider === "github-copilot") {
    const prompt = includesRateLimit(message) || includesHardQuota(message);
    return {
      kind: prompt ? "copilot-quota" : "not-quota",
      shouldPrompt: prompt,
      friendlyMessage: prompt ? "The active subscription-backed route reported a quota or rate limit." : "No subscription quota condition detected.",
    };
  }

  if (lowerProvider === "claude-subscription") {
    if (includesSilentAnthropicStreamStall(message)) {
      return {
        kind: "anthropic-overload",
        shouldPrompt: true,
        friendlyMessage: "The active Claude subscription route reported degraded upstream capacity.",
      };
    }

    // Overload is normally transient and handled by Pi's auto-retry. By the
    // time it reaches message_end the auto-retries are exhausted, so a
    // persistent overload of the active Claude route is worth offering an
    // interactive fallback instead of dead-ending the turn. Rate-limit/hard-
    // quota still classify ahead of overload.
    if (includesOverloadOnly(message)) {
      return {
        kind: "anthropic-overload",
        shouldPrompt: true,
        friendlyMessage: "The active Claude subscription route is overloaded.",
      };
    }
    const prompt = includesRateLimit(message) || includesHardQuota(message);
    return {
      kind: prompt ? "anthropic-rate-limit" : "not-quota",
      shouldPrompt: prompt,
      friendlyMessage: prompt ? "The active subscription-backed route reported a rate limit." : "No subscription quota condition detected.",
    };
  }

  if (includesHardQuota(message)) {
    return {
      kind: "generic-hard-quota",
      shouldPrompt: true,
      friendlyMessage: "The active route reported a hard quota limit.",
    };
  }

  if (isMmrSubscriptionProvider(lowerProvider) && includesRateLimit(message)) {
    return {
      kind: "generic-hard-quota",
      shouldPrompt: true,
      friendlyMessage: "The active subscription-backed route reported a rate limit.",
    };
  }

  return { kind: "not-quota", shouldPrompt: false, friendlyMessage: "No subscription quota condition detected." };
}
