<div align="center">

# ReMem — Local AI Memory & Token Optimization Context Engine

**Local code search, dependency graphs, and session handoff for editor and command-line agents.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension%20v0.2.0-007ACC.svg?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/)
[![SQLite WASM](https://img.shields.io/badge/SQLite-WebAssembly-003B57.svg?style=for-the-badge&logo=sqlite&logoColor=white)](https://sql.js.org/)
[![Orama Vector](https://img.shields.io/badge/Orama-Embedded%20Search-FF6600.svg?style=for-the-badge)](https://oramasearch.com/)
[![Worker Threads](https://img.shields.io/badge/Node.js-Worker%20Threads%20Async-339933.svg?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/api/worker_threads.html)
[![Security](https://img.shields.io/badge/AES--256--GCM-Encrypted%20Vault-green.svg?style=for-the-badge)](https://nodejs.org/api/crypto.html)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

<p align="center">
  <a href="#-key-features">Features</a> •
  <a href="#sidebar-and-cli-integration">Sidebar and CLI</a> •
  <a href="#-how-it-works-architecture">Architecture</a> •
  <a href="#-quick-start--installation">Quick Start</a> •
  <a href="#-token-optimization-benchmark">Benchmarks</a> •
  <a href="#-vs-code--antigravity-commands">Commands</a> •
  <a href="#-faq">FAQ</a>
</p>

</div>

---

## Overview: What is ReMem?

ReMem indexes a workspace locally and shares summaries, exported symbols, module dependencies, task progress, and post-mortem notes with coding agents. The editor extension and standalone MCP server use the same index and session ledger.

## Sidebar and CLI integration

The extension keeps `.remem_context_feed.md` and `.recall_scratchpad.md` at the workspace root. It maintains a marked ReMem block in `AGENTS.md`, `CLAUDE.md`, and `.agents/rules/remem.md`, plus `.antigravity/rules.md` when that legacy file exists. Existing instructions outside the block are preserved. Start a new agent session to pick up workspace instructions. Agents that load these files can follow the pointers even when they bypass the optional `@remem` participant.

The sidebar instructions and assembled context carry ReMem's security and lean rules. Zero-Fluff Mode adds the output-only directive when enabled. These are prompt instructions, and adherence depends on the host and model. The diff auditor independently flags supported security and overbuild patterns and shows current spec checklist progress for verification.

Run **ReMem: Install CLI Skill & MCP Config** in the editor or run the installer from a source checkout.

```bash
npm run build:mcp
node out/remem-mcp.js install --workspace /path/to/project
```

To distribute a local npm package, run `npm pack`. Install from that tarball with `npm exec --package /path/to/remem-context-engine-0.2.0.tgz -- remem-mcp install --workspace /path/to/project`. The installer copies the server and WASM assets into the project and adds workspace-scoped registrations:

| Host | MCP configuration | Skill discovery |
|---|---|---|
| VS Code | `.vscode/mcp.json` | Workspace instructions in `AGENTS.md` |
| Antigravity IDE and CLI | `.agents/mcp_config.json` | `.agents/skills/remem/SKILL.md` |
| Codex CLI | `.codex/config.toml` | `.agents/skills/remem/SKILL.md` |
| Claude Code | `.mcp.json` | `.claude/skills/remem/SKILL.md` |

Reload the host and approve its workspace trust or MCP prompt if requested. The installer registers a local Node process. Its absolute paths refer to the machine where the installer ran. Use `--zero-fluff` to enable Zero-Fluff Mode for the standalone server. You can also launch the server directly with `node out/remem-mcp.js --workspace /path/to/project`.

| MCP tool | Purpose |
|---|---|
| `remem_search` | Search file summaries and symbols. |
| `remem_blast_radius` | Return direct imports, dependents, and exports. |
| `remem_get_context` | Assemble compact code, architecture, task, resume, and error context. |
| `remem_log_postmortem` | Record a failure and the lesson that prevents it recurring. |
| `remem_save_session_state` | Persist a checkpoint in the scratchpad and session ledger. |

The server provides `remem://context-feed`, `remem://scratchpad`, and `remem://error-ledger`. The error resource shows recorded notes for the current branch. Both targets use file locks and atomic snapshot replacement for shared SQLite and search data. ReMem automatically reclaims locks whose owner has exited or whose recorded age exceeds 10 seconds.

---


## The Problems ReMem Solves

| Problem in Modern AI Coding | What Happens Without ReMem | How ReMem Solves It |
|---|---|---|
| **Context Window Exhaustion** | Large codebases exceed LLM context windows (8k/32k/128k), forcing truncation. | **Hierarchical Summarization:** Compresses source files into 15–30 token structural summaries with SHA-256 caching. |
| **Wasteful AI File Scans** | AI coding agents execute slow `find`, `grep`, and `cat` commands across the workspace to orient themselves. | **Pre-Boot Knowledge Graph (`.remem_context_feed.md`):** Topology and exports provide a starting point for focused source inspection. |
| **Cross-Window Context Bleed** | Opening multiple projects in VS Code causes scratchpads and state to contaminate other windows. | **Strict Workspace Isolation:** Scopes SQLite, Orama, and state strictly to `workspaceFolders[0]` via `workspaceState`. |
| **Context Amnesia & Repeated Bugs** | When a developer reverts a broken commit or branch, the AI repeats the exact same mistake. | **Git Error Ledger:** Watches `.git/HEAD` and prompts for post-mortem warnings, prepending them to future AI prompts. |
| **Plaintext Secrets Exposure** | AI prompts ingest `.env`, `*.pem`, and `secrets.json` in plaintext. | **Secure Secrets Vault:** Encrypts sensitive files using AES-256-GCM with 100k-iteration PBKDF2 & 1-hour in-memory cache. |
| **UI Thread Freezes During Parsing** | Parsing large codebases with tree-sitter locks the main IDE event loop. | **Worker Threads Async Engine:** Offloads parsing to background Node.js worker threads. |

---

## Key Features

### 1. Hierarchical Token-Efficient Summarization
- **Global Overview:** Generates a 100-word holistic snapshot of your repository stored in local SQLite.
- **Visual Directory Tree:** Generates a fast, serialized structural hierarchy.
- **1–2 Sentence File Summaries:** On `onDidSaveTextDocument`, parses classes, functions, and exports into condensed summaries (~15–30 tokens instead of 2,000+ raw file tokens).
- **Microsecond SHA-256 Gating:** Bypasses processing if the file content hash has not changed, eliminating redundant computations.

### 2. Git Branch & Rollback "Error Ledger"
- **Zero-Polling Watcher:** Listens to kernel-level OS file events on `.git/HEAD` and `.git/refs/**` (zero CPU/battery waste).
- **Post-Mortem Note Capture:** When switching branches or reverting commits, ReMem prompts: *"Why was this feature reverted?"*
- **Mistake Prevention:** Automatically prepends past error warnings to the AI prompt whenever working on that file or branch again.

### 3. Secure Secrets Vault (AES-256-GCM + PBKDF2)
- **Automatic Detection:** Identifies `.env`, `.env.local`, `*.pem`, `*.key`, and `secrets.json`.
- **Authenticated Encryption:** Encrypts sensitive context at rest in `.antigravityMem/vault.json` using `AES-256-GCM` with 100,000-iteration PBKDF2 key derivation.
- **In-Memory Session Cache:** Master password is cached strictly in RAM and automatically wiped after **1 hour** or upon IDE shutdown.

### 4. AST Blast Radius & Dependency Analyzer
- **Fast AST Parsing:** Uses `web-tree-sitter` to parse import/export declarations without heavy compiler toolchains.
- **Blast Radius Detection:** Editing `auth.ts` instantly reveals dependent modules (`middleware.ts`, `server.ts`) so the AI understands ripple effects without full-codebase grepping.

### 5. Active Scratchpad (`.recall_scratchpad.md`)
- Maintains a workspace scratchpad where AI coding agents track multi-step execution plans, checklists, and working hypotheses across turns.
- Persisted strictly in `workspaceState` (scoped to individual workspace windows) to prevent state contamination across open projects.

### 6. Persistent Knowledge Graph & Pre-Boot Directive
- **Topology Extraction:** Directly extracts all workspace module imports, exports, and dependents from SQLite `remem_ledger.sqlite`.
- **Token-Compressed Architecture Map:** Compresses the graph into `.remem_context_feed.md` in the workspace root, containing node summaries, exported symbols, and a compact dependency adjacency matrix.
- **Silent Background Updates:** Refreshes automatically in the background on document saves without interrupting active coding.
- **Pre-Boot Context:** The optional chat participant assembles context directly. Other agents can follow the workspace instruction pointers or request context through MCP.

### 7. Strict Multi-Window Workspace Isolation & Sandboxing
- **Workspace-Folder Scoping:** Automatically scopes SQLite ledgers, Orama vector indexes, and scratchpads to the active folder (`vscode.workspace.workspaceFolders[0]`).
- **Path Sandboxing:** Strictly verifies file reads and writes with `WorkspaceIsolationManager`, blocking any path traversal or out-of-sandbox access (`WorkspaceIsolationError`).
- **Enforced Execution CWD:** Mandates the active workspace root as the absolute `cwd` for all terminal executions and child process spawns.

### 8. Anti-Loop File Watcher with 1200ms Debounce
- **Self-Trigger Protection:** Strict guard clauses instantly drop change events for internal files (`.antigravityMem`, `.recall_scratchpad.md`, `.remem_context_feed.md`).
- **1200ms Save Debounce:** Throttles save events per file, eliminating CPU spikes and infinite save loops while keeping memory records in continuous sync.

### 9. Async AST Execution via Worker Threads
- **Zero UI Starvation:** Offloads heavy tree-sitter AST queries, import/export parsing, and token chunking into background Node.js `worker_threads`.
- **Non-blocking Slicing Fallback:** Gracefully falls back to macro-task promise slicing (`setImmediate`) to keep VS Code's UI thread completely unblocked.

---

## How It Works: Architecture

```
                                  ┌────────────────────────────────────────────────────────┐
                                  │                  VS Code / Antigravity                 │
                                  │                        IDE UI                          │
                                  └───────────────────────────┬────────────────────────────┘
                                                              │
                     ┌────────────────────────────────────────┼────────────────────────────────────────┐
                     │                                        │                                        │
                     ▼                                        ▼                                        ▼
         [File Save / Edit Event]                 [Git Branch / Revert]                   [AI Context Request]
                     │                                        │                                        │
                     ▼                                        ▼                                        ▼
           SummarizerPipeline                          GitStateWatcher                         assembleContext()
         (SHA-256 Hash Comparison)                 (.git/HEAD File Watcher)                            │
                     │                                        │                                        │
          ┌──────────┴──────────┐                             ▼                                        │
          │                     │                    promptForPostMortem()                             │
     [Unchanged]            [Modified]                        │                                        │
          │                     │                             ▼                                        │
        SKIP             Extract AST &            Store in error_ledger (SQLite)                       │
                       Generate Summary                       │                                        │
                                │                             │                                        │
                                ├─────────────────────────────┼────────────────────────────────────────┤
                                ▼                             ▼                                        ▼
             ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
             │                                   Unified DatabaseManager                                    │
             │                                                                                              │
             │   ┌───────────────────────────────┐              ┌───────────────────────────────────────┐   │
             │   │    SqliteLedger (sql.js)      │              │     VectorSearchEngine (@orama)       │   │
             │   │  - file_summaries table       │              │  - In-memory BM25 / Vector search     │   │
             │   │  - error_ledger table         │              │  - Instant keyword / semantic queries │   │
             │   │  - Fast in-memory queries     │              │  - Excludes encrypted secrets         │   │
             │   └──────────────┬────────────────┘              └───────────────────┬───────────────────┘   │
             └──────────────────┼───────────────────────────────────────────────────┼───────────────────────┘
                                │                                                   │
                                ▼                                                   ▼
            .antigravityMem/remem_ledger.sqlite                     .antigravityMem/orama_index.json
```

---

## Token Optimization Benchmark

### Scenario: Modifying an Authentication Middleware Module in a 50-File Repository

| Strategy | Context Delivered | Raw Code Tokens | Metadata Tokens | Total Prompt Tokens | Token Savings | Cost & Latency Impact |
|---|---|---|---|---|---|---|
| **Raw Full Codebase Scan** | All 50 files sent raw | ~150,000 | 0 | **~150,000** | **0%** (Baseline) | High latency, hits rate limits |
| **Manual Multi-File Open** | 5 related source files | ~12,500 | 0 | **~12,500** | **91.6%** | Moderate latency, manual overhead |
| **ReMem Optimized Injection** | Active file + Blast Radius + Error Ledger + Scratchpad | 0 raw files | ~250 | **~250** | **99.8%** | **Sub-second response, minimal cost** |

---

## Quick Start & Installation

### Prerequisites
- Node.js 18.x or newer
- VS Code 1.85+ or Antigravity IDE

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/RudreshGaonkar/ReMem.git
cd ReMem
npm install
```

### 2. Build & Package the Extension
```bash
# Typecheck TypeScript sources
npm run typecheck

# Bundle both targets and copy their WASM assets
npm run compile

# Run incremental bundler in watch mode
npm run watch

# Package as a .vsix extension file
npm run package

# Package and install with the editor CLI (set REMEM_IDE_COMMAND to override)
npm run install:ide
```

### 3. Run Locally in VS Code / Antigravity
1. Open the project folder in VS Code or Antigravity IDE.
2. Press `F5` (or click **Run > Start Debugging**) to open an **Extension Development Host** window.
3. Open any workspace in the new window. ReMem automatically creates `.antigravityMem/` in the project root.

---

## VS Code / Antigravity Commands

Open the Command Palette (`Ctrl+Shift+P` on Linux/Windows, `Cmd+Shift+P` on macOS) and type `ReMem`:

| Command | Identifier | Description |
|---|---|---|
| **ReMem: Check Context Engine Status** | `remem.status` | Inspects workspace status, indexed summary counts, error notes, and vault lock state. |
| **ReMem: Toggle Engine / Manual Sync** | `remem.toggleSync` | Pauses/resumes file-save auto-summarization or triggers a manual sync sweep for remote Git changes. |
| **ReMem: Generate Token-Optimized AI Context** | `remem.getContext` | Assembles file summary, blast radius, error ledger, and scratchpad into a compact ~250-token payload and copies to clipboard. |
| **ReMem: Open Active Scratchpad** | `remem.showScratchpad` | Opens `.recall_scratchpad.md` in the editor to track multi-step execution plans. |
| **ReMem: Search Context Summaries** | `remem.searchSummaries` | Fast embedded search across all indexed project summaries using `@orama/orama`. |
| **ReMem: Show Workspace Structure Tree** | `remem.showDirectoryTree` | Generates and displays a clean visual tree of your workspace hierarchy. |
| **ReMem: Log Post-Mortem / Error Note** | `remem.addPostMortem` | Manually records a post-mortem note or rollback warning for the active context. |
| **ReMem: Show Active Error Ledger Context** | `remem.showErrorContext` | Displays past rollback warnings and notes tied to the currently open file or branch. |
| **ReMem: Encrypt Active File to Vault** | `remem.encryptActiveFile` | Encrypts the active sensitive file with AES-256-GCM and stores it in `.antigravityMem/vault.enc`. |
| **ReMem: View/Decrypt Vault Secrets** | `remem.viewVaultSecrets` | Prompts for master password and decrypts a chosen secret in an isolated viewer. |
| **ReMem: Lock Secure Secrets Vault** | `remem.lockVault` | Immediately wipes cached master password credentials from memory. |
| **ReMem: Re-index Workspace Files** | `remem.reindexWorkspace` | Manually triggers a background rescan and indexation of workspace files. |
| **ReMem: Purge and Rebuild Local Memory** | `remem.purgeMemory` | Completely clears local memory caches and resets databases (modal confirmation required). |
| **ReMem: Audit Active / Staged Diff** | `remem.reviewDiff` | Audits staged or unstaged diffs for security violations, overbuilding, and spec compliance. |
| **ReMem: Sync Spec & Task Progress** | `remem.syncTaskProgress` | Synchronizes task checklist progress against specification files. |
| **ReMem: Collect Tech Debt Ledger** | `remem.logDebt` | Scans workspace and aggregates TODO/FIXME debt items into the debt ledger. |
| **ReMem: Toggle Zero-Fluff Mode** | `remem.toggleZeroFluffMode` | Toggles Zero-Fluff execution mode (silent 4-point audit, no `<thinking>` tags, outputs only hardened code/diffs). |
| **ReMem: Install CLI Skill & MCP Config** | `remem.installSkill` | Automatically installs ReMem CLI skill and workspace MCP config for VS Code, Antigravity, Codex, or Claude Code. |

---

## Configuration Settings

Configure ReMem to match your development workflow in VS Code `settings.json`:

```json
{
  // Automatically summarize code files upon saving (default: true)
  "remem.enableAutoSummarize": true,

  // Duration in minutes to cache vault master password in memory (default: 60)
  "remem.vaultSessionTimeoutMinutes": 60,

  // Number of conversation turns before untouched files are pruned from context (default: 3)
  "remem.lruContextTurnLimit": 3,

  // Zero-Fluff Mode: silent 4-point audit before modifying code, emits no thinking tags, outputs only code/diffs (default: false)
  "remem.ZeroFluffMode": false
}
```

---

## Security, Privacy & Safety Architecture

### Non-Destructive Workspace & Git Safety Guarantees
- **100% Read-Only on User Source Code:** All AST parsers, file watchers, and token summarizers only read source code. ReMem **never writes, reformats, overwrites, or deletes your project files**.
- **Isolated Storage Boundary:** All internal states, caches, and databases are strictly contained within `.antigravityMem/` (plus `.recall_scratchpad.md` for AI execution plans).
- **Read-Only Git Tracking:** The Git integration inspects commit hashes and diff summaries via read-only queries (`git status`, `git log`, `git diffSummary`). It **never executes automated commits, pushes, checkouts, or resets**.
- **Self-Healing SQLite Recovery:** If the SQLite ledger file is ever damaged (e.g. following an abrupt OS power outage), the engine automatically backs up the file and re-initializes a clean schema without crashing the editor host.
- **Fail-Safe AST Parsing:** If the Web-Tree-Sitter WASM engine encounters an unhandled language grammar, it automatically falls back to regex-based parsing without raising unhandled rejections.

### Cryptographic Security
- **100% Local Processing:** Zero telemetry, zero external cloud database queries. All embeddings and databases live inside `.antigravityMem/` on your machine.
- **AES-256-GCM Authenticated Encryption:** 128-bit authentication tag guarantees that tampered secret files cannot be decrypted.
- **Zero Secrets in Vector Search:** Files marked `isEncrypted: true` are strictly barred from plaintext vector indexing.
- **RAM-Only Key Lifecycle:** Master keys are held strictly in process memory and auto-wiped via a 1-hour timer or when the IDE closes.

---

## FAQ (Frequently Asked Questions)

### How is ReMem different from full-codebase RAG or embeddings?
Full-codebase RAG embeddings can still generate thousands of tokens of noisy source code chunks. ReMem extracts **structural signatures (classes, exports, interfaces)**, maintains an **AST blast radius graph**, and injects **past rollback notes**, giving the AI agent precise contextual awareness in under 300 tokens.

### Why does ReMem use `sql.js` (WebAssembly) instead of `better-sqlite3`?
`better-sqlite3` requires compiling native C++ binaries with `node-gyp`. VS Code extensions run inside Electron, which frequently encounters Node ABI version mismatches across OS platforms. `sql.js` compiles SQLite to pure WebAssembly, making ReMem **100% portable with zero native compilation prerequisites**.

### Does ReMem send my code or secrets to any external server?
**No.** ReMem runs 100% locally on your machine. All SQLite databases, vector indexes, and encrypted vault files are stored inside your local `.antigravityMem/` folder.

---

## Repository Structure

```
ReMem/
├── package.json               # Extension manifest & npm scripts (v0.2.0)
├── tsconfig.json              # TypeScript compilation config
├── esbuild.js                 # Production bundler & WASM asset manager
├── README.md                  # SEO-optimized project overview & guide
├── Explanation.md             # In-depth architectural & interview handbook
├── LICENSE                    # MIT License
├── skills/
│   └── remem/SKILL.md         # ReMem CLI agent skill definition
├── scripts/
│   └── install-ide.cjs        # Script for direct IDE installation
├── tests/                     # Test suite
└── src/
    ├── config.ts              # Constants & file path resolvers
    ├── extension.ts           # Extension entry point & lifecycle coordinator
    ├── mcp/                   # Model Context Protocol (MCP) server & installer
    │   ├── server.ts          # Standalone MCP server (tools & resources)
    │   └── install.ts         # Multi-host MCP and skill configurator
    ├── ide/                   # IDE Chat Participant & Integration
    │   └── chat.ts            # Chat participant handler
    ├── core/                  # Strict Workspace Isolation & Sandboxing
    │   ├── workspace.ts       # WorkspaceIsolationManager & CWD sandbox enforcement
    │   ├── files.ts           # Workspace file utilities
    │   ├── ignore.ts          # .gitignore & rule ignore pattern matching
    │   └── workQueue.ts       # Sequential async work queue
    ├── context/               # High-Performance Watchers, Knowledge Graph & Pre-Boot
    │   ├── watchers.ts        # Anti-Loop file watcher with 1200ms debounce
    │   ├── graph.ts           # Persistent Knowledge Graph engine
    │   ├── preboot.ts         # Shared architecture and resume context
    │   ├── instructions.ts    # Agent rule and instruction block injector
    │   ├── chunker.ts         # Granular AST context chunker for Orama indexing
    │   ├── leanRules.ts       # Decision hierarchy & reuse rules
    │   └── security.ts        # Zero-trust AppSec persona injection
    ├── types/                 # Shared TypeScript domain interfaces
    ├── database/              # SQLite WASM & Orama Vector storage
    │   ├── sqlite.ts          # sql.js in-memory SQLite with corruption recovery
    │   ├── vector.ts          # @orama/orama embedded search
    │   ├── index.ts           # Unified DatabaseManager coordinating dual writes
    │   ├── storageWorker.ts   # Background thread storage worker
    │   └── storageWorkerClient.ts # Storage worker IPC client
    ├── summarizer/            # File watcher & structural summarizer
    │   ├── hasher.ts          # SHA-256 content hashing & token estimation
    │   ├── pipeline.ts        # 1-2 sentence structural summarizer
    │   ├── watcher.ts         # Git sync triggers & backward-compatible exports
    │   ├── workspaceIndex.ts  # Workspace index management
    │   └── indexer.ts         # Background workspace indexer & directory tree
    ├── git/                   # Git rollback watcher & Error Ledger
    │   ├── watcher.ts         # .git/HEAD kernel-level file watcher (read-only)
    │   ├── prompt.ts          # Interactive post-mortem note dialogs
    │   └── ledger.ts          # Error ledger query & prompt formatter
    ├── task/                  # Spec, Task & Traceability Tracking
    │   ├── tracker.ts         # SpecTaskTracker (Zero-Fluff task sync)
    │   ├── debt.ts            # TechDebtLedger (TODO/FIXME debt collector)
    │   └── traceability.ts    # LeanTraceabilityTracker & Ripple Effect warnings
    ├── review/                # Local Diff Auditing & Safety
    │   ├── auditor.ts         # LocalDiffAuditor (Git diff & AST verification)
    │   └── overbuild.ts       # Overbuild detection
    ├── vault/                 # AES-256-GCM Secrets Vault
    │   ├── crypto.ts          # AES-256-GCM + 100k PBKDF2 encryption/decryption
    │   ├── storage.ts         # .antigravityMem/vault.enc manager
    │   ├── session.ts         # 1-hour in-memory cache with auto-expiration
    │   └── ui.ts              # Password prompt & vault decryption workflow
    └── ast/                   # AST Blast Radius, Scratchpad, & Context Injector
        ├── analyzer.ts        # Async dependency graph & blast radius analyzer
        ├── asyncParser.ts     # Worker threads async tree-sitter AST parser
        ├── scratchpad.ts      # .recall_scratchpad.md plan manager
        └── injector.ts        # assembleContext() & Pre-Boot context injection
```

---

## Keywords & Topic Tags
`ai-coding-assistant` • `token-optimization` • `local-rag` • `vs-code-extension` • `antigravity-ide` • `context-window-optimization` • `git-error-ledger` • `ast-blast-radius` • `codebase-summarization` • `embedded-vector-search` • `sqlite-wasm` • `aes-256-gcm-vault` • `developer-tools` • `llm-memory`

---

## License

This project is open-source software licensed under the [MIT License](LICENSE).
