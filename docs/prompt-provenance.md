# Prompt provenance

**Audience.** Anyone reviewing `mmr-core` mode prompts, subagent prompts, or tool descriptions. Confirms what is `pi-mmr`-authored and what is preserved from Pi or other sources.

**Related.** Prompt assembly contract: [`mmr-core-api.md`](./mmr-core-api.md). Documentation conventions: [`documentation-style-guide.md`](./documentation-style-guide.md).

`mmr-core` per-mode prompt text in this package is `pi-mmr`-authored. No raw third-party prompt material is copied into the repository; prompt content is restated as `pi-mmr`-owned guidance.

## What `mmr-core` writes to the system prompt

- `smart`, `smartGPT`, `smartSonnet`, `rush`, `test`, `large`, and `deep` each use a pi-mmr-authored mode template (intro, posture sections, closing line) in `src/extensions/mmr-core/prompt-content.ts` (re-exported by the `prompt-templates.ts` compatibility shim).
- `large` has explicit broad-context discipline rather than being identical to `smart`.
- `rush` uses low-latency, targeted-work guidance.
- `deep` uses deliberate-investigation guidance with an explicit `## Diagnostic gate` Markdown section.
- Mode/tool/policy state (active/missing/deferred tools, configured fallback details, feature gates, availability notes) is **not** written into the model-visible prompt. It is exposed through `MmrModeState`, `/mmr-status`, activation warnings, and the status bar.

## How the rewrite is scoped

- For each prompted locked-mode turn, `mmr-core` surgically replaces only Pi's auto-rendered head (identity line through the `Pi documentation` block) with the active mode prompt.
- The only pi-mmr-owned XML-style marker is the initial one-line role marker (`<mmr_mode name="smart">...</mmr_mode>`); mode sections use Markdown headings.
- Pi's auto-rendered `Available tools:` block is embedded verbatim under `## Tool use`.
- Pi's auto-rendered `Guidelines:` block is embedded under `## Tool use` with the two unconditional Pi bullets (`Be concise in your responses`, `Show file paths clearly when working with files`) stripped because the mode prompt covers them.
- Everything outside the auto-rendered head is preserved byte-for-byte: content prepended by earlier `before_agent_start` handlers, Pi's `appendSystemPrompt` (`--append-system-prompt` / `APPEND_SYSTEM.md`), `# Project Context` / AGENTS.md, `<available_skills>`, the future subagents block, `Current date:`, `Current working directory:`, and any extension content appended after the tail.
- When the auto head cannot be located (user-supplied `--system-prompt` / `SYSTEM.md`, or unexpected layout), `mmr-core` passes Pi's prompt through unchanged. The same applies in `open` and `free` modes.

## Non-goals

- Copying or restating third-party system-prompt text inside this repository.
- Provider-specific request shaping (handled separately by the `before_provider_request` policy hook).
- Dynamic context assembly for tools, skills, settings, AGENTS files, or server/runtime data outside Pi's existing prompt pipeline.

Snapshot tests anchor the rendered prompt for every locked mode under `tests/fixtures/mmr-core-prompts/`; behavioral tests verify that out-of-head Pi/extension content is preserved.
