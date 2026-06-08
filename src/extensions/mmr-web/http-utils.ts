/**
 * Shared HTTP helpers used by every `mmr-web` search/reader backend.
 *
 * These primitives bound memory and runtime per call so a hostile origin
 * cannot blow up the process with chunked responses, missing
 * `Content-Length`, redirect chains, or huge error bodies. They are pure
 * (no global state) so each backend can compose them differently.
 */

const ERROR_BODY_PREVIEW_BYTES = 500;
const CONTENT_LENGTH_OVERAGE_FACTOR = 10;

/** Hard cap on bytes read from a non-2xx error body for diagnostic preview. */
export const MAX_ERROR_BODY_BYTES = ERROR_BODY_PREVIEW_BYTES;

export interface TruncatedText {
  content: string;
  truncated: boolean;
  totalBytes: number;
  outputBytes: number;
}

/**
 * Strip any verbatim occurrence of an API key from a text string before
 * embedding upstream response bodies into thrown errors.
 */
export function redactApiKey(text: string, apiKey: string | undefined): string {
  if (!text || !apiKey || apiKey.length < 8) return text;
  return text.split(apiKey).join("[redacted]");
}

/**
 * Combine an optional caller-supplied AbortSignal with an optional
 * per-call timeout. Returns `undefined` when neither is provided so
 * `fetch` is invoked without an aborting signal at all.
 */
export function combineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const timeoutSignal = typeof timeoutMs === "number" && timeoutMs > 0
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  if (signal && timeoutSignal) return AbortSignal.any([signal, timeoutSignal]);
  return signal ?? timeoutSignal;
}

/**
 * Truncate a UTF-8 string to at most `maxBytes`, appending a marker that
 * notes the original byte count. Slices on a byte boundary then strips a
 * trailing partial replacement character so the result is always valid
 * UTF-8.
 */
export function truncateUtf8(text: string, maxBytes: number): TruncatedText {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes) {
    return { content: text, truncated: false, totalBytes, outputBytes: totalBytes };
  }
  const buffer = Buffer.from(text, "utf8");
  const sliced = buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
  const marker = `\n\n[truncated to ~${maxBytes} bytes; original ${totalBytes} bytes]`;
  const content = `${sliced}${marker}`;
  const outputBytes = Buffer.byteLength(content, "utf8");
  return { content, truncated: true, totalBytes, outputBytes };
}

/**
 * Throw when an upstream `Content-Length` exceeds `maxResultBytes` by more
 * than `CONTENT_LENGTH_OVERAGE_FACTOR` so an obviously oversized response
 * never reaches the body-read stage. Streamed body reads cap memory too;
 * this is a fast-fail before allocating any read state.
 */
export function enforceContentLengthBudget(
  response: Response,
  maxResultBytes: number,
  label: string,
): void {
  const header = response.headers.get("content-length");
  if (!header) return;
  const advertised = Number.parseInt(header, 10);
  if (!Number.isFinite(advertised) || advertised <= 0) return;
  const cap = maxResultBytes * CONTENT_LENGTH_OVERAGE_FACTOR;
  if (advertised > cap) {
    throw new Error(
      `${label}: upstream Content-Length ${advertised} exceeds the ${cap}-byte cap (${CONTENT_LENGTH_OVERAGE_FACTOR}\u00d7 maxResultBytes=${maxResultBytes}); refusing to read body.`,
    );
  }
}

/**
 * Bounded read of an error response body. Streams at most `maxBytes` and
 * cancels the underlying body, so a malicious origin returning a huge body
 * with a 5xx (and no `Content-Length`) cannot blow memory by way of
 * `response.text()`.
 *
 * Returned text is decoded as UTF-8 with replacement-character fallback;
 * it is only used for diagnostic preview, never for the model output.
 */
export async function readErrorPreview(
  response: Response,
  maxBytes: number = MAX_ERROR_BODY_BYTES,
): Promise<string> {
  const stream = response.body;
  if (!stream) {
    try { return (await response.text()).slice(0, maxBytes); } catch { return ""; }
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      if (value.byteLength <= remaining) {
        chunks.push(value);
        total += value.byteLength;
      } else {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        break;
      }
    }
  } catch {
    /* swallow: this is best-effort preview */
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
  return buf.toString("utf8").replace(/\uFFFD+$/u, "");
}

/**
 * Stream the response body, decoding UTF-8 incrementally and stopping as
 * soon as `maxBytes` of input have been consumed. Returns the decoded text
 * plus the raw input byte count and a `truncated` flag.
 *
 * Use this instead of `response.text()` for reader backends: chunked or
 * `Content-Length`-less responses from arbitrary origins can otherwise
 * stream unbounded data into memory before any downstream truncation runs.
 */
export async function readTextWithByteLimit(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<{ text: string; truncated: boolean; totalBytes: number }> {
  const stream = response.body;
  if (!stream) {
    // No streaming body (e.g. some polyfills): fall back to text() but cap
    // the resulting string up-front so we still bound memory.
    const text = await response.text();
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= maxBytes) {
      return { text, truncated: false, totalBytes: bytes };
    }
    const sliced = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
    return { text: sliced, truncated: true, totalBytes: bytes };
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let total = 0;
  let text = "";
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - total;
      if (value.byteLength <= remaining) {
        text += decoder.decode(value, { stream: true });
        total += value.byteLength;
      } else {
        if (remaining > 0) {
          text += decoder.decode(value.subarray(0, remaining), { stream: true });
          total += remaining;
        }
        truncated = true;
        break;
      }
    }
    // Flush any pending multi-byte sequence in the decoder.
    if (!truncated) text += decoder.decode();
  } catch (error) {
    try { await reader.cancel(); } catch { /* ignore */ }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: error while streaming response body: ${message}`);
  } finally {
    if (truncated) {
      try { await reader.cancel(); } catch { /* ignore */ }
    }
  }
  // Strip a partial trailing replacement char that may appear if we cut
  // mid-multibyte.
  text = text.replace(/\uFFFD+$/u, "");
  return { text, truncated, totalBytes: total };
}

/**
 * Parse the bare media type from a `Content-Type` header value, dropping
 * any parameters (`; charset=...`). Returns `""` when the header is missing
 * or unparseable.
 */
export function parseMediaType(headerValue: string | null): string {
  if (!headerValue) return "";
  const semi = headerValue.indexOf(";");
  const raw = semi >= 0 ? headerValue.slice(0, semi) : headerValue;
  return raw.trim().toLowerCase();
}

/**
 * Discard a response body without buffering it. `body.cancel()` tells the
 * runtime to stop streaming so a malicious upstream cannot blow memory by
 * attaching a large body to a 3xx redirect or other response the caller
 * does not need.
 */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* ignore */
  }
}

/**
 * Race a promise against an AbortSignal. If the signal fires first, the
 * returned promise rejects with the signal's reason (or a generic abort
 * error). Once the underlying promise settles, the abort listener is
 * detached so a later abort cannot leak a rejection.
 *
 * Useful for piping a per-call AbortSignal into APIs that do not accept
 * one directly (such as `dns.promises.lookup`).
 */
export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
