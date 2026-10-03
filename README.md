<div align="center">

# 🧠 ReMem — Local AI Memory & Token Optimization Context Engine

**Supercharge AI coding assistants with local RAG, AST blast radius tracking, Git rollback memory, and 95%+ prompt token reduction.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6.svg?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-007ACC.svg?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/)
[![SQLite WASM](https://img.shields.io/badge/SQLite-WebAssembly-003B57.svg?style=for-the-badge&logo=sqlite&logoColor=white)](https://sql.js.org/)
[![Orama Vector](https://img.shields.io/badge/Orama-Embedded%20Search-FF6600.svg?style=for-the-badge)](https://oramasearch.com/)
[![Security](https://img.shields.io/badge/AES--256--GCM-Encrypted%20Vault-green.svg?style=for-the-badge)](https://nodejs.org/api/crypto.html)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

<p align="center">
  <a href="#-key-features">Features</a> •
  <a href="#-how-it-works-architecture">Architecture</a> •
  <a href="#-quick-start--installation">Quick Start</a> •
  <a href="#-token-optimization-benchmark">Benchmarks</a> •
  <a href="#-vs-code--antigravity-commands">Commands</a> •
  <a href="#-faq">FAQ</a>
</p>

</div>

---

## 📌 Overview: What is ReMem?

**ReMem (Recall & Memory)** is a developer-first, zero-cloud context engine and state manager built for **VS Code** and **Antigravity IDE**. It acts as an intelligent local **Retrieval-Augmented Generation (RAG) middleman** between your codebase and AI coding agents (such as Antigravity, GitHub Copilot, Cursor, and Claude Code).

By mapping the codebase incrementally, generating 1–2 sentence structural summaries, tracking Git rollbacks with post-mortem notes, and encrypting environment secrets with AES-256-GCM, ReMem **reduces prompt token consumption by up to 99%** and permanently eliminates AI context amnesia.

```
+-----------------------------------------------------------------------------------+
|  Without ReMem: Raw 500-line files dumped into prompt  --> 15,000+ tokens / turn  |
|  With ReMem:    AST Blast Radius + Error Ledger + RAG  --> ~250 tokens / turn     |
|                                                            (98.3% Token Savings)  |
+-----------------------------------------------------------------------------------+
```

---

## ⚡ The Problems ReMem Solves

| Problem in Modern AI Coding | What Happens Without ReMem | How ReMem Solves It |
|---|---|---|
| **🚨 Context Window Exhaustion** | Large codebases exceed LLM context windows (8k/32k/128k), forcing truncation. | **Hierarchical Summarization:** Compresses source files into 15–30 token structural summaries with SHA-256 caching. |
| **🔁 Context Amnesia & Repeated Bugs** | When a developer reverts a broken commit or branch, the AI repeats the exact same mistake. | **Git Error Ledger:** Watches `.git/HEAD` and prompts for post-mortem warnings, prepending them to future AI prompts. |
| **🔓 Plaintext Secrets Exposure** | AI prompts ingest `.env`, `*.pem`, and `secrets.json` in plaintext. | **Secure Secrets Vault:** Encrypts sensitive files using AES-256-GCM with 100k-iteration PBKDF2 & 1-hour in-memory cache. |
| **💥 Blind Multi-File Edits** | AI refactors a function without knowing which other files break. | **AST Blast Radius:** Uses `web-tree-sitter` to compute cross-file import/export dependencies instantly without compilation. |

---

## ✨ Key Features

### 1. 📉 Hierarchical Token-Efficient Summarization
- **Global Overview:** Generates a 100-word holistic snapshot of your repository stored in local SQLite.
- **Visual Directory Tree:** Generates a fast, serialized structural hierarchy.
- **1–2 Sentence File Summaries:** On `onDidSaveTextDocument`, parses classes, functions, and exports into condensed summaries (~15–30 tokens instead of 2,000+ raw file tokens).
- **Microsecond SHA-256 Gating:** Bypasses processing if the file content hash has not changed, eliminating redundant computations.

### 2. 🛡️ Git Branch & Rollback "Error Ledger"
- **Zero-Polling Watcher:** Listens to kernel-level OS file events on `.git/HEAD` and `.git/refs/**` (zero CPU/battery waste).
- **Post-Mortem Note Capture:** When switching branches or reverting commits, ReMem prompts: *"Why was this feature reverted?"*
- **Mistake Prevention:** Automatically prepends past error warnings to the AI prompt whenever working on that file or branch again.

### 3. 🔐 Secure Secrets Vault (AES-256-GCM + PBKDF2)
- **Automatic Detection:** Identifies `.env`, `.env.local`, `*.pem`, `*.key`, and `secrets.json`.
- **Authenticated Encryption:** Encrypts sensitive context at rest in `.antigravityMem/vault.json` using `AES-256-GCM` with 100,000-iteration PBKDF2 key derivation.
- **In-Memory Session Cache:** Master password is cached strictly in RAM and automatically wiped after **1 hour** or upon IDE shutdown.

### 4. 💥 AST Blast Radius & Dependency Analyzer
- **Fast AST Parsing:** Uses `web-tree-sitter` to parse import/export declarations without heavy compiler toolchains.
- **Blast Radius Detection:** Editing `auth.ts` instantly reveals dependent modules (`middleware.ts`, `server.ts`) so the AI understands ripple effects without full-codebase grepping.

### 5. 📝 Active Scratchpad (`.recall_scratchpad.md`)
- Maintains a workspace scratchpad where AI coding agents track multi-step execution plans, checklists, and working hypotheses across turns.

---

## 🏗️ How It Works: Architecture

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

## 📊 Token Optimization Benchmark

### Scenario: Modifying an Authentication Middleware Module in a 50-File Repository

| Strategy | Context Delivered | Raw Code Tokens | Metadata Tokens | Total Prompt Tokens | Token Savings | Cost & Latency Impact |
|---|---|---|---|---|---|---|
| **Raw Full Codebase Scan** | All 50 files sent raw | ~150,000 | 0 | **~150,000** | **0%** (Baseline) | High latency, hits rate limits |
| **Manual Multi-File Open** | 5 related source files | ~12,500 | 0 | **~12,500** | **91.6%** | Moderate latency, manual overhead |
| **ReMem Optimized Injection** | Active file + Blast Radius + Error Ledger + Scratchpad | 0 raw files | ~250 | **~250** | **99.8%** | **Sub-second response, minimal cost** |

---

## 🚀 Quick Start & Installation

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

# Bundle extension into out/extension.js and copy WASM assets via esbuild
npm run compile

# Run incremental bundler in watch mode
npm run watch

# Package as a .vsix extension file
npm run package

# (Antigravity IDE only) Package and force-install directly into Antigravity IDE
npm run install:ide
```

### 3. Run Locally in VS Code / Antigravity
1. Open the project folder in VS Code or Antigravity IDE.
2. Press `F5` (or click **Run > Start Debugging**) to open an **Extension Development Host** window.
3. Open any workspace in the new window. ReMem automatically creates `.antigravityMem/` in the project root.

---

## 💻 VS Code / Antigravity Commands

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

---

## ⚙️ Configuration Settings

Configure ReMem to match your development workflow in VS Code `settings.json`:

```json
{
  // Automatically summarize code files upon saving (default: true)
  "remem.enableAutoSummarize": true,

  // Duration in minutes to cache vault master password in memory (default: 60)
  "remem.vaultSessionTimeoutMinutes": 60,

  // Number of conversation turns before untouched files are pruned from context (default: 3)
  "remem.lruContextTurnLimit": 3
}
```

---

## 🔒 Security, Privacy & Safety Architecture

### 🛡️ Non-Destructive Workspace & Git Safety Guarantees
- **100% Read-Only on User Source Code:** All AST parsers, file watchers, and token summarizers only read source code. ReMem **never writes, reformats, overwrites, or deletes your project files**.
- **Isolated Storage Boundary:** All internal states, caches, and databases are strictly contained within `.antigravityMem/` (plus `.recall_scratchpad.md` for AI execution plans).
- **Read-Only Git Tracking:** The Git integration inspects commit hashes and diff summaries via read-only queries (`git status`, `git log`, `git diffSummary`). It **never executes automated commits, pushes, checkouts, or resets**.
- **Self-Healing SQLite Recovery:** If the SQLite ledger file is ever damaged (e.g. following an abrupt OS power outage), the engine automatically backs up the file and re-initializes a clean schema without crashing the editor host.
- **Fail-Safe AST Parsing:** If the Web-Tree-Sitter WASM engine encounters an unhandled language grammar, it automatically falls back to regex-based parsing without raising unhandled rejections.

### 🔐 Cryptographic Security
- **100% Local Processing:** Zero telemetry, zero external cloud database queries. All embeddings and databases live inside `.antigravityMem/` on your machine.
- **AES-256-GCM Authenticated Encryption:** 128-bit authentication tag guarantees that tampered secret files cannot be decrypted.
- **Zero Secrets in Vector Search:** Files marked `isEncrypted: true` are strictly barred from plaintext vector indexing.
- **RAM-Only Key Lifecycle:** Master keys are held strictly in process memory and auto-wiped via a 1-hour timer or when the IDE closes.

---

## ❓ FAQ (Frequently Asked Questions)

### How is ReMem different from full-codebase RAG or embeddings?
Full-codebase RAG embeddings can still generate thousands of tokens of noisy source code chunks. ReMem extracts **structural signatures (classes, exports, interfaces)**, maintains an **AST blast radius graph**, and injects **past rollback notes**, giving the AI agent precise contextual awareness in under 300 tokens.

### Why does ReMem use `sql.js` (WebAssembly) instead of `better-sqlite3`?
`better-sqlite3` requires compiling native C++ binaries with `node-gyp`. VS Code extensions run inside Electron, which frequently encounters Node ABI version mismatches across OS platforms. `sql.js` compiles SQLite to pure WebAssembly, making ReMem **100% portable with zero native compilation prerequisites**.

### Does ReMem send my code or secrets to any external server?
**No.** ReMem runs 100% locally on your machine. All SQLite databases, vector indexes, and encrypted vault files are stored inside your local `.antigravityMem/` folder.

---

## 📁 Repository Structure

```
ReMem/
├── package.json               # Extension manifest & npm scripts
├── tsconfig.json              # TypeScript compilation config
├── esbuild.js                 # Production bundler & WASM asset manager
├── README.md                  # SEO-optimized project overview & guide
├── Explanation.md             # In-depth architectural & interview handbook
├── LICENSE                    # MIT License
└── src/
    ├── config.ts              # Constants & file path resolvers
    ├── extension.ts           # Extension entry point (activate/deactivate)
    ├── types/                 # Shared TypeScript domain interfaces
    ├── database/              # SQLite WASM & Orama Vector storage
    │   ├── sqlite.ts          # sql.js in-memory SQLite with corruption recovery
    │   ├── vector.ts          # @orama/orama embedded search
    │   └── index.ts           # Unified DatabaseManager coordinating dual writes
    ├── summarizer/            # File watcher & structural summarizer
    │   ├── hasher.ts          # SHA-256 content hashing & token estimation
    │   ├── pipeline.ts        # 1-2 sentence structural summarizer
    │   ├── watcher.ts         # onDidSaveTextDocument file listeners
    │   └── indexer.ts         # Background workspace indexer & directory tree
    ├── git/                   # Git rollback watcher & Error Ledger
    │   ├── watcher.ts         # .git/HEAD kernel-level file watcher (read-only)
    │   ├── prompt.ts          # Interactive post-mortem note dialogs
    │   └── ledger.ts          # Error ledger query & prompt formatter
    ├── vault/                 # AES-256-GCM Secrets Vault
    │   ├── crypto.ts          # AES-256-GCM + 100k PBKDF2 encryption/decryption
    │   ├── storage.ts         # .antigravityMem/vault.enc manager
    │   ├── session.ts         # 1-hour in-memory cache with auto-expiration
    │   └── ui.ts              # Password prompt & vault decryption workflow
    └── ast/                   # AST Blast Radius, Scratchpad, & Context Injector
        ├── analyzer.ts        # Dependency graph & blast radius analyzer
        ├── scratchpad.ts      # .recall_scratchpad.md plan manager
        └── injector.ts        # assembleContext() & LRU context manager
```

---

## 🏷️ Keywords & Topic Tags
`ai-coding-assistant` • `token-optimization` • `local-rag` • `vs-code-extension` • `antigravity-ide` • `context-window-optimization` • `git-error-ledger` • `ast-blast-radius` • `codebase-summarization` • `embedded-vector-search` • `sqlite-wasm` • `aes-256-gcm-vault` • `developer-tools` • `llm-memory`

---

## 📄 License

This project is open-source software licensed under the [MIT License](LICENSE).
