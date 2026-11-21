---
name: remem
description: Use ReMem to resume workspace work, retrieve indexed code and dependencies, or record a session checkpoint or post-mortem.
---

Read `.remem_context_feed.md` and `.recall_scratchpad.md` to orient yourself and recover the active plan. Call `remem_get_context` with the relevant workspace-relative file to retrieve the compact map, code excerpts, session state, and past failures. If MCP is unavailable, use the two workspace files and verify details against source.

Use `remem_search` to locate symbols and `remem_blast_radius` before changing a shared interface. Verify affected consumers, follow the workspace security rules, and check the active spec before expanding scope. Keep progress reports concise and include verification results.

Use `remem_save_session_state` at a handoff to record completed work, pending tasks, and the next concrete step. Use `remem_log_postmortem` for a verified failure and the lesson that prevents it recurring. Keep credentials and private data out of both records.
