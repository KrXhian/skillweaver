# Skillweaver

A lightweight, local-first desktop Markdown editor combining structured block editing with plain-folder management, wikilink knowledge graphs, live external agent hot-reloading, and built-in BYOK AI.

*Skillweaver™ — Created by the Blue Frog Foundation.*

## Features

- **Folder & `.md` Management**: Open any folder to browse a live sidebar tree of folders and `.md` files. Create, rename (automatically updating incoming `[[wikilinks]]` outside code spans/blocks), and delete notes or folders. `hero.md` at the root opens automatically when opening a folder, and your last folder/preferences are remembered in `%USERPROFILE%\.skillweaver\ui.prefs`.
- **Live Vault Hot-Reload & Conflict Diff**: A debounced recursive filesystem watcher (`notify`) automatically syncs external changes (from `--mcp` agents, Git, or external editors) into the sidebar tree, Quick Switcher, backlinks, and Graph View. Clean open notes hot-swap silently while preserving scroll position, collapsed headings, and cursor offset; notes with unsaved edits trigger a non-blocking **View Diff / Keep Mine / Reload** banner backed by a save-time content-hash conflict guard.
- **Single-Page Focus**: Deliberately avoids multi-note tab clutter for distraction-free writing — switch any page instantly via Quick Open (`Ctrl+P` / `Ctrl+K`) or `[[wikilinks]]`.
- **Collapsible Headers & Outdenting**: Every `#`, `##`, and `###` heading has a chevron toggle to collapse/expand all nested blocks beneath it. Drag any block horizontally left (or press `Shift+Tab` / `Tab`) to pull it out of a parent heading's indentation without breaking heading structure.
- **Rich Markdown Blocks & Inline Formatting**: Clean block editor with `**bold**`, `*italic*`, `==highlight==`, `` `inline code` ``, text/background colors (`Ctrl+Shift+H`), bullet lists (`- `), numbered lists (`1. `), interactive checklists (`- [ ] `), quotes (`> `), dividers (`---`), GFM tables (`/table` or `| A | B |` + Enter with resizable columns), floating selection toolbar, syntax-highlighted fenced code blocks (```` ```lang ```` trigger, language selector, Copy button, Tab indentation), `Ctrl+Click` / `Shift+Click` / marquee multi-block selection, drag-and-drop, and block action menu (`Ask AI`, `Color`, `Copy link to block`, `Duplicate`, `Turn into`, `Delete`).
- **Image Pasting**: Paste screenshots or copied images (`Ctrl+V`) or drag image files onto the editor — images save automatically into `<folder>/assets/` as standard Markdown `![alt](assets/...)` embeds.
- **Interactive Knowledge Graph (`Ctrl+G`)**: Open an interactive force-directed graph showing all `.md` files and `[[wikilinks]]` (plus dashed ghost nodes for unresolved links). Filter notes, toggle Local 1-hop or Orphans, zoom/pan/drag nodes, and click any node to open or create it.
- **Integrated Terminal**: Press `Ctrl+~` (or `` Ctrl+` ``) to toggle a bottom PowerShell terminal starting in the opened folder, with Unicode `tree` box-drawing output, ANSI color rendering, and path Tab completion.
- **BYOK AI Assistant & Skill Bank**: Press `Ctrl+J` (or `Ctrl+Shift+A`) to open the right-side AI drawer. Bring your own API key (OpenAI, Google Gemini, Anthropic Claude, OpenRouter, Ollama, or custom OpenAI-compatible) encrypted at rest via Windows DPAPI in `%USERPROFILE%\.skillweaver\ai.prefs`. Searches across your opened folder, knows Skillweaver's full feature/shortcut workflow, reads pinned blocks/highlights, proposes Accept/Reject block edits, and supports reusable `SKILL.md` skills (`<folder>/skills/` and `%USERPROFILE%\.skillweaver\skills/`) — type `@skill` for one turn, pin skills to the conversation bar for every turn, or harvest workflows directly from chat.
- **Built-in MCP Server (`--mcp`)**: Run `skillweaver.exe --mcp "<vault-folder>"` to connect external AI tools (Claude Code, Cursor, Codex, Antigravity) directly to your vault over stdio with zero Node.js dependencies.
- **`@@` Page Links, Block Links & Backlinks**: Type `@@` anywhere to fuzzy-search and link `.md` pages (`[[path]]`), or use `Alt+Shift+L` / `⋮⋮ → Copy link to block` to copy `[[path#^block-id]]` links. Incoming backlinks appear at the bottom of linked pages.

## Shortcuts

- `Ctrl+O` — Open folder
- `Ctrl+N` — New note
- `Ctrl+P` / `Ctrl+K` — Quick switcher
- `Ctrl+G` — Toggle Knowledge Graph view
- `Ctrl+S` — Save immediately (auto-saves automatically and on page switch)
- `Ctrl+Z` / `Ctrl+Shift+Z` (`Ctrl+Y`) — Undo / Redo
- `Shift+Tab` / `Tab` — Pull block out of parent heading indentation / re-indent
- `Ctrl+B` — Bold selection
- `Ctrl+I` — Italic selection
- `Ctrl+E` — Inline code
- `Ctrl+Shift+H` — Reapply last text or block color
- `Ctrl+J` / `Ctrl+Shift+A` — Ask AI on selection/block or toggle AI panel
- `Alt+Shift+L` — Copy block link to focused block (`[[page#^id]]`)
- `Ctrl+D` — Duplicate focused or selected blocks
- `Ctrl+Click` / `Shift+Click` — Select and highlight multiple blocks (drag, `Del`, `Ctrl+C`, `Ctrl+D`, `Ctrl+J`, `Shift+Tab`)
- `Ctrl+~` / `` Ctrl+` `` — Toggle integrated terminal
- `Ctrl+\` — Toggle sidebar
- `Ctrl+Shift+M` — Toggle Raw Markdown view
- `Ctrl+Shift+[` / `Ctrl+Shift+]` — Collapse / expand all headers
- `Ctrl+=` / `Ctrl+-` / `Ctrl+0` — Zoom window in / out / reset to 100%

## Architecture

Skillweaver ships as a single Tauri v2 desktop binary (`core-engine/`) with an embedded vanilla ES-module frontend (`ui/`) and zero Node.js runtime or build step:

- `core-engine/src/main.rs` & `lib.rs` — Binary entry point (`--mcp` stdio mode vs. Tauri GUI shell) and command registry.
- `core-engine/src/vault.rs` — Plain-folder `.md` CRUD, traversal-guarded path resolution, `PageIndex` link/backlink/graph indexing, search, and image asset embeds.
- `core-engine/src/watcher.rs` — Debounced recursive `notify` vault watcher (`vault:fs-changed`) with FNV-1a content-hash self-write suppression.
- `core-engine/src/markdown.rs` — Block parser/serializer, `[[wikilink]]` rewriter, and lazy `^block-id` / `<!-- outdent:N -->` / style metadata handling.
- `core-engine/src/mcp.rs` — Zero-dependency JSON-RPC 2.0 stdio MCP server reading/writing directly on disk.
- `core-engine/src/ai/` — Streaming BYOK client (`curl`-backed SSE), live model discovery, chat history store, and DPAPI-encrypted `ai.prefs`.
- `core-engine/src/terminal.rs` — Persistent bottom PowerShell host with UTF-8/CP1252 handling and path completion.
- `ui/` — Vanilla HTML/CSS/ES modules (`app.js`, `editor.js`, `diff.js`, `graph.js`, `terminal.js`, `sidebar.js`, `links.js`, `ai/`).

## Run & Build

### Run

Double-click the portable single executable (no installer or extra runtime files required), or download `skillweaver-windows-x64.exe` from GitHub Releases:

```text
core-engine\target\release\skillweaver.exe
```

### Prerequisites

- Rust toolchain (`rustup` / `cargo`)
- Windows WebView2 Runtime (preinstalled on Windows 10/11)
- No Node.js or npm required

### Rebuild from Source

Whenever you edit files in `ui/` or `core-engine/`:

1. **Close any running `skillweaver.exe` window first** — Windows locks the executable while open, so rebuilding while it is running fails with `Access is denied (os error 5)`.
2. Run from the repository root:

   ```powershell
   cargo build --release --manifest-path core-engine/Cargo.toml
   ```

   *(Or `cd core-engine` and run `cargo build --release`.)*

3. Tauri automatically bundles and embeds every file in `ui/` (including `ui/vendor/prism.min.js`) directly into the single executable at `core-engine\target\release\skillweaver.exe`.

Optional fast compile check (without linking the release binary):

```powershell
cargo check --manifest-path core-engine/Cargo.toml --all-targets
```

Optional clean rebuild if the build cache ever gets stale:

```powershell
cargo clean --manifest-path core-engine/Cargo.toml
cargo build --release --manifest-path core-engine/Cargo.toml
```

## Test

```text
cd core-engine
cargo test
```

GitHub Actions workflows in `.github/workflows/` run `cargo check --all-targets` and `cargo test` on pushes/PRs (`ci.yml`) and build portable Windows executables on `v*` tags or manual dispatch (`release.yml`).

## MCP Server Mode (External AI Agents)

Skillweaver includes a built-in zero-dependency stdio MCP server (`list_notes`, `read_note`, `search_vault`, `resolve_block`, `get_vault_graph`, `create_note`, `append_to_note`). Point any MCP-compatible client (Claude Code, Cursor, Codex, etc.) directly at the portable executable:

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

If you omit the second argument (`"--mcp"` alone), Skillweaver uses the last folder opened in the desktop app.

## Platform & Known Tradeoffs

- **Windows-first desktop target**: Tested and packaged for Windows 10/11 (WebView2, PowerShell terminal, Win32 DPAPI encryption). Basic POSIX `sh` terminal fallbacks exist in Rust, but macOS/Linux builds and packaging are not currently maintained.
- **Block-oriented Markdown scope**: Skillweaver models headings (`#`–`###`), paragraphs, flat lists/checklists, quotes, dividers, GFM tables, images, and fenced code blocks, using HTML comments (`<!-- outdent:N -->`, `<!-- style:... -->`) and trailing `^block-id` anchors for block metadata. Nested sub-lists and YAML frontmatter blocks are not yet represented as dedicated block types.
- **Local-first single-user vaults**: Notes live purely as plain `.md` files on disk with no built-in cloud sync service (pair with Git, Syncthing, OneDrive, or Dropbox if you need multi-device sync).

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution and bundled third-party notices.
