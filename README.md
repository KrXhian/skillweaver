# Skillweaver — Local-First Desktop Markdown Editor, Knowledge Graph & BYOK AI Workspace

[![Release](https://img.shields.io/github/v/release/KrXhian/skillweaver?style=flat-square&color=5b8def)](https://github.com/KrXhian/skillweaver/releases)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg?style=flat-square)](LICENSE)
[![Built with Rust & Tauri v2](https://img.shields.io/badge/Built%20with-Rust%20%2B%20Tauri%20v2-orange?style=flat-square)](core-engine/Cargo.toml)
[![Platform: Windows x64](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078d4?style=flat-square)](https://github.com/KrXhian/skillweaver/releases)
[![MCP Server Included](https://img.shields.io/badge/MCP-Stdio%20Server%20Built--In-7c3aed?style=flat-square)](#mcp-server-mode-external-ai-agents)
[![Website](https://img.shields.io/badge/Docs-krxhian.github.io%2Fskillweaver-10b981?style=flat-square)](https://krxhian.github.io/skillweaver/)

> **A fast, local-first Notion & Obsidian alternative built over plain `.md` folders — combining structured block editing, side-by-side & fullscreen citation-weighted knowledge graphs (`<--->` / `--->` strength colors), multi-key BYOK AI, reusable `SKILL.md` agent workflows, and a zero-dependency MCP server in a single Rust + Tauri desktop binary.**

*Skillweaver — An open-source project by Blue Frog Foundation (created & maintained by [@KrXhian](https://github.com/KrXhian)). Releases, docs, changelog & security: [github.com/KrXhian/skillweaver](https://github.com/KrXhian/skillweaver) · [krxhian.github.io/skillweaver](https://krxhian.github.io/skillweaver/) · [CHANGELOG](CHANGELOG.md) · [SECURITY](SECURITY.md)*

---

## What Is Skillweaver?

**Skillweaver** is a native Windows desktop Markdown knowledge base and AI-ready editor built around **plain-file portability** and an **integrated core workflow**. Every note is stored directly on disk as standard human- and LLM-readable Markdown (`.md`), while giving you structured Notion-like blocks, Obsidian-style `[[wikilinks]]` and knowledge graphs, collapsible outlines, an integrated terminal, and multi-provider BYOK AI in a self-contained Rust + Tauri v2 desktop binary.

*(Note: This is the **Skillweaver desktop Markdown editor & knowledge workspace** by Blue Frog Foundation, maintained by `@KrXhian` — distinct from the OSU-NLP-Group SkillWeaver web-agent research repository.)*

---

## Skillweaver vs. Obsidian vs. Notion vs. Logseq

| Capability | Skillweaver | Obsidian | Notion | Logseq |
| :--- | :--- | :--- | :--- | :--- |
| **Plain `.md` Files on Disk** | Yes (100% local folders) | Yes (local Markdown) | No (proprietary cloud DB) | Partial (outliner `.md`/EDN) |
| **Built-In Core Capabilities** | Blocks, graph, BYOK AI, terminal & MCP included | Available via community plugins | Integrated cloud workspace | Core outliner + plugin ecosystem |
| **Citation-Weighted Knowledge Graph** | Side (`Ctrl+G`) & fullscreen (`Ctrl+Shift+G`), `[[wikilink]]` citation weights (`×N`), `<--->` / `--->` strength-colored arrows, calm hop muting, 1-click AI cluster loading | Unweighted global/local graph | None | Unweighted graph |
| **Structured Block Editing + Outdent** | `#`–`###` folding, `Shift+Tab` outdent, resizable tables, block colors | Plain text / Live Preview | Cloud blocks | Bullet outliner |
| **Multi-Key, Multi-Provider BYOK AI** | Unlimited named API key profiles (DPAPI-encrypted) + 1-click switcher | Community plugins / third-party | Subscription add-on | Third-party plugins |
| **Portable `@skill` Workflows** | Standard `skills/*/SKILL.md` instructions | Not native | Not native | Not native |
| **Live External Agent Co-Editing** | Built-in `--mcp` stdio server + conflict diff resolver | Third-party REST/MCP bridges | API rate-limited | Not native |
| **Runtime Footprint** | Single Rust + WebView2 `.exe` (no bundled Node.js) | Electron desktop app | Web / Electron desktop app | Electron desktop app |

---

## Core Features

### 1. Structured Block Editor & Plain Markdown Round-Tripping
- **Structured Blocks & Raw Mode (`Ctrl+Shift+M`)**: Edit headings (`#`, `##`, `###`), paragraphs, bullet/numbered lists, interactive checklists (`- [ ]`), quotes, dividers, embedded images (`assets/`), Prism-highlighted fenced code blocks, and resizable GFM tables (`/table` or `| A | B |` + Enter) — or flip instantaneously to Raw Markdown.
- **Collapsible Sections & Block Outdenting (`Shift+Tab`)**: Fold any `#`, `##`, or `###` section (`ui.prefs` persists collapsed headings per note) and outdent callouts cleanly without breaking heading nesting (`<!-- outdent:N -->`).
- **9 Semantic Text & Block Colors (`Ctrl+Shift+H`)**: Style inline spans or whole blocks using `<!-- style:color=...;bg=... -->` tokens tuned for Dark and Light themes.
- **Image Pasting & Drag-Drop**: Paste screenshots (`Ctrl+V`) or drop image files to save automatically into `<vault>/assets/` as portable `![alt](assets/...)` Markdown.

### 2. Fast Folder Explorer, Properties & Templates
- **Interactive Folder Hubs**: Click any folder name in the sidebar or breadcrumbs to inspect clean note cards, subfolders, folder-level metadata (`.skillweaver/frontmatter.yml`), and reusable page templates (`.skillweaver/templates/*.md` with `{{title}}`, `{{date}}`, `{{folder}}` placeholders).
- **`hero.md` Landing & Single-Page Focus**: Opening a vault automatically opens `hero.md` when present, keeping writing focused and fast via Quick Open (`Ctrl+P` / `Ctrl+K`) and `[[wikilinks]]`.

### 3. Left Collapsible Outline (`Ctrl+Shift+O`)
- Toggle the clean left Outline drawer from the top-left editor icon (or `Ctrl+Shift+O`) to view your indented heading hierarchy, highlight the active section while scrolling, fold/expand nested headings two-way with the editor, and see live word/token/read-time stats.

### 4. Side-Docked (`Ctrl+G`) & Fullscreen (`Ctrl+Shift+G`) Citation-Weighted Knowledge Graph
- **Side Drawer by Default (`Ctrl+G`)**: Opens docked on the right alongside your active note (mutually exclusive with the AI drawer) while keeping editing live; single-click any node to open it in the editor.
- **True Fullscreen Explorer (`Ctrl+Shift+G` or `⤢`)**: Expands edge-to-edge across the entire window (`100vw × 100vh`) with folder-color legend filtering, Local 1-hop Subgraph (`L`), `@skill` violet diamond badges, unresolved coral ghost links, and a floating **Node Inspector Card** (`Open/Create Note`, `Focus 1-Hop`, `Ask AI (Node / Cluster)`).
- **Citation-Frequency Edge Weights (`×N`)**: Repeated `[[wikilink]]` citations between two notes increment directed edge `weight` (`×2`, `×3`, ...) in Rust, pulling strongly tied pages closer in the force simulation, boosting 1-hop relevance, ranking Inspector neighbor chips by citation strength, and rendering midpoint `×N` citation pills on focus/hover.
- **Single Clean `<--->` & `--->` Arrows + Strength Color Coding**: Consolidates reciprocal links into a single bidirectional arrow (`<--->`) and one-way references into a single directional arrow (`--->`). Relationships are color-coded by composite tie strength (`tieScore` combining citations, mutual links, and shared neighbors) — **Emerald Green** (strong citation/mutual tie), **Accent Blue** (mutual/medium tie), and **Calm Slate** (single passing mention) — with line thickness scaling smoothly by `log2(weight)`.
- **Unmistakable Active-Page Focus & Calm Muting**: Highlights your currently open page with a crisp double blue ring while proportionally fading and muting distant or unrelated nodes by hop distance and tie strength so the active neighborhood stands out cleanly instead of getting lost in a crowded full-vault graph.
- **Auto-Reset & Manual Reset (`R`)**: Closing the graph or exiting Fullscreen back to Side resets filters, selection, Local mode, and dragged positions to default automatically — or press `R` / click **Reset** anytime.

### 5. Multi-Key BYOK AI Assistant & Portable `SKILL.md` Bank
- **Unlimited Named Key Profiles**: Save multiple keys side-by-side across **OpenAI, Google Gemini, Anthropic Claude, OpenRouter, Ollama (local), and custom OpenAI-compatible endpoints** inside `%USERPROFILE%\.skillweaver\ai.prefs` (each key encrypted individually at rest using Windows DPAPI). Switch keys and fetched models in one click from the header badge.
- **Surgical Block Edits & Prompt Caching**: Ask AI on selected blocks (`Ctrl+J`), inline highlights, or graph clusters (`✦ AI`) with Accept / Reject structured edit diffs, `@skill` one-turn workflows, pinned conversation skills, and multi-session chat history.

### 6. Live Vault Hot-Reload, Conflict Diff & MCP Server
- **Debounced Recursive Watcher (`notify`)**: Detects changes made by AI agents, scripts, or Git on disk, updating the file tree, backlinks, and graph live. Clean open notes hot-reload seamlessly preserving cursor and fold state; dirty notes show a **View Diff / Keep Mine / Reload** banner.
- **Built-In Stdio MCP Server (`--mcp`)**: Run `skillweaver.exe --mcp "<vault>"` to give Claude Code, Cursor, Codex, or Antigravity 7 fast disk/index tools (`list_notes`, `read_note`, `search_vault`, `resolve_block`, `get_vault_graph` with `kind`, `skill_slug`, `folder`, `in_degree`, `out_degree`, `est_tokens`, and edge citation `weight`, `create_note`, `append_to_note`).

### 7. Integrated PowerShell Terminal & Token Telemetry
- Press `` Ctrl+` `` / `Ctrl+~` for an integrated PowerShell terminal anchored in your vault folder with Unicode box-drawing (`tree`), ANSI colors, and path Tab completion.
- Live status bar tracks Git branch, words, characters, estimated LLM tokens (`~tokens`), selection slices, and reading time.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+O` | Open any local folder as a Markdown vault |
| `Ctrl+N` | Create a new `.md` note |
| `Ctrl+P` / `Ctrl+K` | Quick Switcher (fuzzy search notes) |
| `Ctrl+Shift+O` | Toggle Left Document Outline |
| `Ctrl+G` | Toggle Side-Docked Knowledge Graph |
| `Ctrl+Shift+G` | Toggle Fullscreen Knowledge Graph |
| `Ctrl+J` / `Ctrl+Shift+A` | Ask AI on block/selection or toggle AI drawer |
| `Ctrl+Shift+M` | Toggle Structured Block vs. Raw Markdown view |
| `Ctrl+Shift+[` / `]` | Collapse / expand all headings in note |
| `Shift+Tab` / `Tab` | Outdent block out of parent heading / re-indent |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+E` | Bold / Italic / Inline code |
| `Ctrl+Shift+H` | Reapply last text or block color |
| `Alt+Shift+L` | Copy block wikilink (`[[page#^block-id]]`) |
| `Ctrl+D` | Duplicate focused or selected blocks |
| `Ctrl+\` | Toggle left File Explorer sidebar |
| `` Ctrl+~ `` / `` Ctrl+` `` | Toggle integrated PowerShell terminal |
| `Ctrl+S` | Save immediately (auto-saves on edit & switch) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom window in / out / reset to 100% |

**Graph View Shortcuts** *(when Graph View is open)*: `/` focus search filter · `L` toggle Local 1-hop subgraph · `F` fit graph to viewport · `C` center on active note · `R` reset filters, focus & layout to default · `Enter` open selected node · `Esc` clear focus or return to Side view.

---

## Architecture

Skillweaver ships as a single **Tauri v2 desktop binary (`core-engine/`)** with an embedded **vanilla ES-module frontend (`ui/`)** — zero bundler, zero Node.js runtime:

- `core-engine/src/main.rs` & `lib.rs` — Binary entrypoint (`--mcp` headless stdio server vs. Tauri GUI shell) and command handlers.
- `core-engine/src/vault.rs` — Traversal-guarded `.md` CRUD, `PageIndex`, link/backlink indexing, search, token/degree/citation-weighted graph builder, and asset embeds.
- `core-engine/src/folder.rs` — Folder Explorer overviews, `.skillweaver/frontmatter.yml` metadata, and template substitution.
- `core-engine/src/markdown.rs` — Structured block parser/serializer, `[[wikilink]]` rewriter, lazy `^block-id` anchors, outdent, and style metadata.
- `core-engine/src/watcher.rs` — Debounced recursive `notify` watcher with FNV-1a content-hash self-write suppression.
- `core-engine/src/mcp.rs` — Zero-dependency JSON-RPC 2.0 MCP server.
- `core-engine/src/ai/` — In-process streaming BYOK client (native Rust `reqwest` + OS TLS/Schannel), live model cache, multi-profile Windows DPAPI prefs, `SKILL.md` skills, and chat history store.
- `core-engine/src/terminal.rs` — Integrated PowerShell host with UTF-8/CP1252 handling and path completion.
- `ui/` — Vanilla HTML/CSS/ES modules (`app.js`, `editor.js`, `outline.js`, `graph.js`, `folder.js`, `diff.js`, `sidebar.js`, `links.js`, `metrics.js`, `terminal.js`, `ai/`).

---

## Run & Build from Source

### Run Portable Executable

Download `skillweaver-windows-x64.exe` from [GitHub Releases](https://github.com/KrXhian/skillweaver/releases), or build locally and run `core-engine\target\release\skillweaver.exe` — no installer required.

### Prerequisites

- Rust toolchain (`rustup` / `cargo`)
- Microsoft Edge WebView2 Runtime (preinstalled on Windows 10/11)
- No Node.js or npm required

### Rebuild Release Binary

> **Windows tip**: Close any running `skillweaver.exe` window before rebuilding so Windows does not lock the binary (`os error 5`).

```powershell
cargo build --release --manifest-path core-engine/Cargo.toml
```

Fast compile & test verification:

```powershell
cargo test --manifest-path core-engine/Cargo.toml
cargo clippy --manifest-path core-engine/Cargo.toml --all-targets -- -D warnings
```

GitHub Actions in [`.github/workflows/`](.github/workflows) enforces `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo check --all-targets`, and `cargo test` on pushes/PRs (`ci.yml`), and builds portable Windows binaries with `SHA256SUMS.txt` and GitHub build provenance attestations on releases (`release.yml`).

---

## MCP Server Mode (External AI Agents)

Connect Claude Code, Cursor, Codex, OpenCode, or Antigravity directly to any Skillweaver Markdown vault:

```json
{
  "mcpServers": {
    "skillweaver": {
      "command": "C:\\path\\to\\skillweaver.exe",
      "args": ["--mcp", "C:\\path\\to\\your-markdown-folder"]
    }
  }
}
```

Pass `--read-only` to disable `create_note` and `append_to_note` while keeping read, search, block-resolve, and graph inspection active:

```json
"args": ["--mcp", "--read-only", "C:\\path\\to\\your-markdown-folder"]
```

Omit the folder path (`["--mcp"]` or `["--mcp", "--read-only"]`) to automatically attach external agents to whichever vault folder was last opened in the desktop app. The MCP server blocks path traversal, dotfiles (`.git`, `.env`, `.skillweaver`), `node_modules`/`target`, and non-`.md` files, refuses overwrites, and exposes no delete tools — back up your vault with Git when granting write access. See [`SECURITY.md`](SECURITY.md) for the full threat model.

---

## Platform & Known Tradeoffs

- **Windows-first desktop release**: Built and packaged for Windows 10/11 (WebView2, PowerShell terminal, Win32 DPAPI encryption). Basic POSIX `sh` terminal fallbacks exist in Rust, while macOS/Linux binaries are not currently packaged.
- **Block-oriented Markdown scope**: Supports headings (`#`–`###`), paragraphs, lists, checklists, quotes, dividers, GFM tables, images, and fenced code blocks, persisting optional block metadata via HTML comments (`<!-- outdent:N -->`, `<!-- style:... -->`) and lazy `^block-id` anchors.
- **Local-first vaults**: All data stays plain `.md` on your filesystem; pair with Git, Syncthing, or cloud drive sync if you need multi-device syncing.

---

## FAQ

**How is Skillweaver different from Obsidian?**
Obsidian excels at deep customization through a broad third-party plugin ecosystem. Skillweaver takes an opinionated, batteries-included approach — shipping structured block editing, citation-weighted graphs, multi-key BYOK AI, `SKILL.md` workflows, a terminal, and `--mcp` support natively in a single Rust + Tauri binary over plain `.md` files with minimal setup.

**Can AI tools like Claude Code or Cursor read and edit my Skillweaver vault directly?**
Yes. Launch `skillweaver.exe --mcp "<vault>"` (or `--mcp --read-only "<vault>"` for read-only exploration) in your MCP client config. External edits are detected automatically by Skillweaver's file watcher and hot-reloaded safely without overwriting unsaved typing.

**How is Skillweaver's knowledge graph different from an unweighted global graph?**
In unweighted full-vault graphs, a single passing mention looks identical to a core dependency. Skillweaver models your vault as a **citation-weighted local relationship network**: repeated `[[wikilinks]]` increase edge weight (`×N`) to pull tightly coupled pages closer, mutual links collapse into single bidirectional `<--->` or one-way `--->` arrows color-coded by relationship strength (emerald green, blue, slate), the active note stands out inside a double blue ring while distant hops calmly mute, and `Ask AI (Cluster)` loads a note's 1-hop neighborhood straight into BYOK AI.

**Does Skillweaver lock my notes into a proprietary database?**
No. Every note is a plain `.md` file inside normal OS folders, and pasted images sit in a standard `<vault>/assets/` subfolder. You can open the same folder in VS Code, Obsidian, or Git at any time.

See [`CHANGELOG.md`](CHANGELOG.md) for the latest additions and fixes.

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution and third-party notices.
