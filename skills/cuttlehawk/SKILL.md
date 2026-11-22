---
name: cuttlehawk-context-engine
description: Use Cuttlehawk to resume workspace work, retrieve indexed code and dependencies, or record a session checkpoint or post-mortem.
---

**Quick Setup**
Run this command from the workspace root to install the runtime from GitHub and register the skill and MCP server:
`npm install -g git+https://github.com/RudreshGaonkar/Cuttlehawk.git && cuttlehawk-mcp install`

Read `.cuttlehawk_context_feed.md` and `.recall_scratchpad.md` to orient yourself and recover the active plan. Call `cuttlehawk_get_context` with the relevant workspace-relative file to retrieve the compact map, code excerpts, session state, and past failures. If MCP is unavailable, use the two workspace files and verify details against source.

Use `cuttlehawk_search` to locate symbols and `cuttlehawk_blast_radius` before changing a shared interface. Verify affected consumers, follow the workspace security rules, and check the active spec before expanding scope. Keep progress reports concise and include verification results.

## Mandatory execution rules

- **No speculative features.** If project requirements or intent are unclear, ask the user for confirmation before introducing features, files, or design assumptions.
- **Git branch check before edits.** Run `git branch --show-current` before modifying files. On `main` or `master`, ask the user whether to work directly on the current branch or create a new branch, and wait for their choice before editing. If the current branch already contains commits for the same task and is a feature or working branch, continue there without asking.
- **Code Reuse & Duplicate-Prevention.** Before creating a helper, function, component, or module, use `cuttlehawk_search` and `cuttlehawk_get_context` to check for matching or related logic. If you find any, stop before writing or modifying anything. Report the exact `file:line` and symbol name to the user, then ask whether to reuse or extend the existing implementation, modify it, or keep it untouched. Wait for their decision. Never create duplicate implementations or parallel utilities without user confirmation.

Use `cuttlehawk_save_session_state` at a handoff. Pass a JSON object with these parameters.

- `lastPlanSnapshot` (required string, up to 4,000 characters) records the current plan.
- `completedTasks` (string array, defaults to `[]`) lists finished tasks.
- `pendingTasks` (string array, defaults to `[]`) lists remaining tasks.
- `activeTask` (optional string) names the next concrete step.
- `file` (optional string, 1–1,024 characters) identifies the active file relative to the workspace.

Each task array accepts up to 50 entries. Each task string must be 1–500 characters.

Use `cuttlehawk_log_postmortem` for a verified failure and the lesson that prevents it recurring. Keep credentials and private data out of both records.

