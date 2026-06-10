# Troubleshooting

Audience: pi-mmr users and maintainers diagnosing locked-mode, provider, and tool-call failures.

Scope: symptoms visible in Pi session logs and pi-mmr diagnostics; provider internals and credentials stay out of this repository.

Related: package overview ([`README.md`](../README.md)), core diagnostics ([`src/extensions/mmr-core/README.md`](../src/extensions/mmr-core/README.md#diagnostics--mmr-status)), session fallback ([`src/extensions/mmr-session-fallback/README.md`](../src/extensions/mmr-session-fallback/README.md)), and history tools ([`src/extensions/mmr-history/README.md`](../src/extensions/mmr-history/README.md)).

## At a glance

| Symptom | First check | Likely layer |
| --- | --- | --- |
| `Unable to parse Anthropic tool input JSON after repair attempts` | Raw assistant `message.errorMessage`, `last_event`, `saw_tool_block`, and whether a `toolResult` followed | Claude subscription/native streaming provider; the tool was not dispatched |
| `missing content_block_stop before message_stop` | Same assistant error plus preceding attempted tool-call type | Upstream/native stream lifecycle failure; the tool was not dispatched |
| `saw_message_stop=false; saw_tool_block=true` | Whether the errored assistant message still contains executable-looking tool calls | Stream ended while a tool-use block was open |
| `fetch failed; cause: ECONNRESET` with `saw_tool_block=false` | Whether the previous tool call already has a successful `toolResult` | Transport reset before the next assistant message produced text or a tool call |
| `rate_limit` / `overloaded_error` / `upstream_capacity_signal=silent_200_stream` | `mmr-session-fallback` override entries and model changes after the error | Provider capacity/quota; pi-mmr may apply an interactive fallback only after classification |
| Native `thinking` replay 400s | Latest assistant message blocks around the referenced message/content indices | Replay compatibility between native provider payloads and signed/redacted thinking |

## Session-log procedure for provider/tool-call failures

When a turn fails around a tool call, inspect the raw JSONL session log, not only summarized history output.

1. Locate the failing assistant `message` entry with `stopReason: "error"` or an `errorMessage`.
2. Record only public-safe diagnostics:
   - session id and project, not raw home-directory paths;
   - provider/model and response model;
   - `request_id`, HTTP status, `last_event`, `saw_message_stop`, `saw_tool_block`;
   - attempted tool name and argument length, when present;
   - whether a matching `toolResult` entry exists after the failed assistant message;
   - current context pressure from usage/cache totals when relevant.
3. Attribute the failure by evidence:
   - If no `toolResult` exists after the assistant error, the tool never ran. Do not debug `edit`, `apply_patch`, `bash`, or workspace state as the primary cause.
   - If `saw_tool_block=true` and `saw_message_stop=false`, the provider/native stream ended while a tool-use block was still incomplete.
   - If `last_event=contentBlockStop` and parsing failed, the stream closed the tool block but the accumulated `input_json_delta` did not form valid final tool-argument JSON.
   - If `fetch failed`, `ECONNRESET`, or another transport error appears with `saw_tool_block=false`, no new tool-use block was open; check whether the previous tool already completed, then retry or switch routes.
   - If the error is `rate_limit`, `overloaded_error`, `upstream_capacity_signal=silent_200_stream`, or transport-only, treat it as provider capacity/transport unless a pi-mmr fallback or request-policy rewrite is visible in the same turn.
4. Check pi-mmr state only after the stream facts:
   - `mmr-core.mode-state` shows the active mode, resolved provider/model, thinking level, and fallback status.
   - `mmr-session-fallback.override` shows interactive fallback selections after classified quota/rate-limit failures.
   - `/mmr-status debug` explains model/tool resolution; it does not prove a provider stream was valid.
5. If the same provider repeats stream-shape failures in a large session, compact or start a fresh session and retry with a non-Anthropic provider/model before changing tool implementation.

## Editing-tool false positives

An `edit`-adjacent provider failure can look like an edit bug because the failed stream was trying to emit an `edit` call. Treat it as an editing-tool bug only when the log contains a completed assistant tool call followed by a concrete `toolResult` from `edit`.

- `Found 2 occurrences ... oldText must be unique` is a normal deterministic `edit` validation error. Re-read the file, add context, and retry once with a unique replacement.
- `Unable to parse Anthropic tool input JSON ... saw_tool_block=true` before any `toolResult` means the `edit` tool did not receive arguments. The likely fault is upstream/native tool-argument streaming, not edit matching.
- A malformed provider turn can be recovered by switching models; that recovery does not prove the workspace edit implementation was wrong.

## What to log in future reports

Use this minimal bundle so later investigations can compare sessions without exposing local-only data:

```text
session: <id>
project: <repo or package name>
provider/model: <provider>/<model>
response model: <responseModel if present>
stopReason/error: <redacted errorMessage>
stream diagnostics: status=<n>; request_id=<id>; last_event=<event>; saw_message_stop=<bool>; saw_tool_block=<bool>
attempted tool: <name or none>; argument chars=<n or unknown>
post-error toolResult: yes/no
mode state: mode=<key>; selected=<provider/model>; thinking=<level>; fallback=<yes/no>
context: input=<n>; output=<n>; cacheRead=<n>; cacheWrite=<n>
recovery: compacted / switched model / retried / no retry
```

Do not paste raw provider payloads, OAuth tokens, API keys, exact local paths, full prompt text, private session content, or unreduced tool arguments into public issues or repository docs.
