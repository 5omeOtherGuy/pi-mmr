import {
  enforceContentLengthBudget,
  readTextWithByteLimit,
  truncateUtf8,
} from "../http-utils.js";
import type { SearchResponse } from "./types.js";

/**
 * The subset of {@link SearchResponse} fields produced from the upstream
 * response body: the (possibly truncated) `rawText`, the `truncated` flag,
 * and the input/output byte counts. Search backends spread this directly
 * into their `SearchResponse` return value alongside parsed `results`.
 */
export type SearchResponseBody = Pick<
  SearchResponse,
  "rawText" | "truncated" | "bytes" | "totalBytes"
>;

/**
 * Read an upstream search response body under the per-call byte budget.
 * Centralizes the bounded-read contract every JSON/HTML search backend
 * shares:
 *
 *   1. Fast-fail when an advertised `Content-Length` far exceeds the
 *      per-call cap, so an obviously oversized response never reaches the
 *      body-read stage.
 *   2. Stream the body via {@link readTextWithByteLimit}, stopping at
 *      `maxResultBytes` of input and cancelling the underlying stream, so a
 *      chunked / `Content-Length`-less response from an arbitrary origin
 *      cannot buffer unbounded bytes into memory before truncation runs.
 *   3. Cap the surfaced `rawText` and report byte counts via
 *      {@link truncateUtf8}, producing the four `SearchResponseBody`
 *      fields exactly the same way for every backend.
 *
 * Callers receive both the streamed `text` (already bounded by the cap, for
 * parsing/diagnostics) and the truncated `body` to spread into their
 * `SearchResponse`. Backend sniffs (block-page detection, JSON-vs-HTML)
 * operate on the head of the body, which the cap preserves; the cap is far
 * larger than any realistic sniff prefix or result-page head.
 */
export async function readSearchResponseBody(
  response: Response,
  maxResultBytes: number,
  label: string,
): Promise<{ text: string; body: SearchResponseBody }> {
  enforceContentLengthBudget(response, maxResultBytes, label);
  const streamed = await readTextWithByteLimit(response, maxResultBytes, label);
  const truncated = truncateUtf8(streamed.text, maxResultBytes);
  return {
    text: streamed.text,
    body: {
      rawText: truncated.content,
      truncated: streamed.truncated || truncated.truncated,
      bytes: truncated.outputBytes,
      totalBytes: streamed.totalBytes,
    },
  };
}
