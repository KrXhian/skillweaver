# Skillweaver

A lightweight, local-first desktop Markdown editor combining structured block editing with plain-folder management, wikilink knowledge graphs, and built-in BYOK AI.

*Skillweaver™ — Created by the Blue Frog Foundation.*

## Features

- **Folder & `.md` Management**: Open any folder to browse a live sidebar tree of folders and `.md` files. Create, rename (automatically updating incoming `[[wikilinks]]`), and delete notes or folders. `hero.md` at the root opens automatically when opening a folder, and your last folder/preferences are remembered in `%USERPROFILE%\.skillweaver\ui.prefs`.
- **Single-Page Focus**: Deliberately avoids multi-note tab clutter for distraction-free writing — switch any page instantly via Quick Open (`Ctrl+P` / `Ctrl+K`) or `[[wikilinks]]`.
- **Collapsible Headers & Outdenting**: Every `#`, `##`, and `###` heading has a chevron toggle to collapse/expand all nested blocks beneath it. Drag any block horizontally left (or press `Shift+Tab` / `Tab`) to pull it out of a parent heading's indentation without breaking heading structure.
- **Rich Markdown Blocks & Inline Formatting**: Clean block editor with `**bold**`, `*italic*`, `==highlight==`, `` `inline code` ``, bullet lists (`- `), numbered lists (`1. `), interactive checklists (`- [ ] `), quotes (`> `), dividers (`---`), floating selection toolbar, syntax-highlighted fenced code blocks (```` ```lang ```` trigger, language selector, Copy button, Tab indentation), `Ctrl+Click` / `Shift+Click` multi-block selection, drag-and-drop, and block action menu (`Ask AI`, `Copy link to block`, `Duplicate`, `Turn into`, `Delete`).
- **Image Pasting**: Paste screenshots or copied images (`Ctrl+V`) or drag image files onto the editor — images save automatically into `<folder>/assets/` as standard Markdown `![alt](assets/...)` embeds.
- **Interactive Knowledge Graph (`Ctrl+G`)**: Open an interactive force-directed graph showing all `.md` files and `[[wikilinks]]` (plus dashed ghost nodes for unresolved links). Filter notes, toggle Local 1-hop or Orphans, zoom/pan/drag nodes, and click any node to open or create it.
- **Integrated Terminal**: Press `Ctrl+~` (or `` Ctrl+` ``) to toggle a bottom PowerShell terminal starting in the opened folder.
- **BYOK AI Assistant**: Press `Ctrl+J` (or `Ctrl+Shift+A`) to open the right-side AI drawer. Bring your own API key (OpenAI, Google Gemini, Anthropic Claude, OpenRouter, Ollama, or custom OpenAI-compatible) stored in `%USERPROFILE%\.skillweaver\ai.prefs`. Searches across your opened folder, knows Skillweaver's full feature/shortcut workflow, reads pinned blocks/highlights, and proposes Accept/Reject block edits.
- **Built-in MCP Server (`--mcp`)**: Run `skillweaver.exe --mcp "<vault-folder>"` to connect external AI tools (Claude Code, Cursor, Codex, Antigravity) directly to your vault over stdio with zero Node.js dependencies.
- **`@@` Page Links, Block Links & Backlinks**: Type `@@` anywhere to fuzzy-search and link `.md` pages (`[[path]]`), or use `Alt+Shift+L` / `⋮⋮ → Copy link to block` to copy `[[path#^block-id]]` links. Incoming backlinks appear at the bottom of linked pages.

## Shortcuts

- `Ctrl+O` — Open folder
- `Ctrl+N` — New note
- `Ctrl+P` / `Ctrl+K` — Quick switcher
- `Ctrl+G` — Toggle Knowledge Graph view
- `Ctrl+S` — Save immediately (auto-saves automatically and on page switch)
- `Shift+Tab` / `Tab` — Pull block out of parent heading indentation / re-indent
- `Ctrl+B` — Bold selection
- `Ctrl+I` — Italic selection
- `Ctrl+E` — Inline code
- `Ctrl+J` / `Ctrl+Shift+A` — Ask AI on selection/block or toggle AI panel
- `Alt+Shift+L` — Copy block link to focused block (`[[page#^id]]`)
- `Ctrl+D` — Duplicate focused or selected blocks
- `Ctrl+Click` / `Shift+Click` — Select and highlight multiple blocks (drag, `Del`, `Ctrl+C`, `Ctrl+D`, `Ctrl+J`, `Shift+Tab`)
- `Ctrl+~` / `` Ctrl+` `` — Toggle integrated terminal
- `Ctrl+\` — Toggle sidebar
- `Ctrl+Shift+M` — Toggle Raw Markdown view
- `Ctrl+Shift+[` / `Ctrl+Shift+]` — Collapse / expand all headers
- `Ctrl+=` / `Ctrl+-` / `Ctrl+0` — Zoom window in / out / reset to 100%

## Run & Build

### Run

Double-click the portable single executable (no installer or extra runtime files required):

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

## License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution and bundled third-party notices.
