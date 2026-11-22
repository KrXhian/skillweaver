# Skillweaver

A lightweight desktop markdown editor combining Notion-style blocks with Obsidian-style folder management and page linking.

## Features

- **Folder & `.md` Management**: Open any folder to browse a live sidebar tree of folders and `.md` files. Create, rename (automatically updating incoming `[[wikilinks]]`), and delete notes or folders. `hero.md` at the root opens automatically when opening a folder, and your last folder/preferences are remembered in `%USERPROFILE%\.skillweaver\ui.prefs`.
- **Collapsible Headers & Outdenting**: Every `#`, `##`, and `###` heading has a chevron toggle to collapse/expand all nested blocks beneath it. Drag any block horizontally left (or press `Shift+Tab` / `Tab`) to pull it out of a parent heading's indentation without breaking heading structure.
- **Text Blocks & Code Blocks**: Clean block editor with `Ctrl+B` / `**bold**`, `==highlight==`, `` `inline code` ``, floating selection toolbar, fenced code blocks (```` ```lang ```` trigger, language selector, Copy button, Tab indentation), `Ctrl+Click` / `Shift+Click` multi-block selection (drag, duplicate, delete, outdent, copy, or Ask AI together), drag-and-drop, and Notion-style block menu (`Ask AI`, `Copy link to block`, `Duplicate`, `Turn into`, `Delete`).
- **Image Pasting**: Paste screenshots or copied images (`Ctrl+V`) or drag image files onto the editor — images save automatically into `<folder>/assets/` as standard Markdown `![alt](assets/...)` embeds.
- **Interactive Knowledge Graph (`Ctrl+G`)**: Open an Obsidian-style force-directed graph showing all `.md` files and `[[wikilinks]]` (plus dashed ghost nodes for unresolved links). Filter notes, toggle Local 1-hop or Orphans, zoom/pan/drag nodes, and click any node to open or create it.
- **Integrated Terminal**: Press `Ctrl+~` (or `` Ctrl+` ``) to toggle a bottom PowerShell terminal starting in the opened folder.
- **BYOK AI Assistant**: Press `Ctrl+J` (or `Ctrl+Shift+A`) to open the right-side AI drawer. Bring your own API key (OpenAI, Google Gemini, Anthropic Claude, OpenRouter, Ollama, or custom OpenAI-compatible) stored in `%USERPROFILE%\.skillweaver\ai.prefs`. Searches across your opened folder, reads pinned blocks/highlights, and proposes Accept/Reject block edits.
- **`@@` Page Links, Block Links & Backlinks**: Type `@@` anywhere to fuzzy-search and link `.md` pages (`[[path]]`), or use `Alt+Shift+L` / `⋮⋮ → Copy link to block` to copy `[[path#^block-id]]` links. Incoming backlinks appear at the bottom of linked pages.

## Shortcuts

- `Ctrl+O` — Open folder
- `Ctrl+N` — New note
- `Ctrl+P` / `Ctrl+K` — Quick switcher
- `Ctrl+G` — Toggle Knowledge Graph view
- `Ctrl+S` — Save immediately (auto-saves automatically and on page switch)
- `Shift+Tab` / `Tab` — Pull block out of parent heading indentation / re-indent
- `Ctrl+B` — Bold selection
- `Ctrl+E` — Inline code
- `Ctrl+J` / `Ctrl+Shift+A` — Ask AI on selection/block or toggle AI panel
- `Alt+Shift+L` — Copy Obsidian link to focused block (`[[page#^id]]`)
- `Ctrl+D` — Duplicate focused or selected blocks
- `Ctrl+Click` / `Shift+Click` — Select and highlight multiple blocks (drag, `Del`, `Ctrl+C`, `Ctrl+D`, `Ctrl+J`, `Shift+Tab`)
- `Ctrl+~` / `` Ctrl+` `` — Toggle integrated terminal
- `Ctrl+\` — Toggle sidebar
- `Ctrl+Shift+M` — Toggle Raw Markdown view
- `Ctrl+Shift+[` / `Ctrl+Shift+]` — Collapse / expand all headers

## Run & Build

Double-click the built executable:

```text
src-tauri\target\release\skillweaver.exe
```

To build from source (requires Rust toolchain):

```text
cd src-tauri
cargo build --release
```

## Test

```text
cd src-tauri
cargo test
```
