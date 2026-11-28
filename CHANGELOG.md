# Changelog

All notable changes to **Skillweaver** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), focusing on shipped capabilities across the Rust + Tauri v2 core engine, Knowledge Graph, Block Editor, BYOK AI assistant, and stdio MCP server.

---

## [Unreleased]

### Added
- **Citation-Weighted Local Knowledge Graph (`core-engine/src/vault.rs`, `ui/graph.js`)**:
  - Tracks how many times note A cites note B via `[[wikilinks]]` (`GraphEdge.weight`, surfaced as `×N` weights in physics, midpoint edge pills on hover/selection, and weighted `Outgoing →` / `Incoming ←` chips in the Inspector).
  - Pulls heavily cited pairs tighter in the force-directed layout (`springStrength` boosted per citation) and elevates strongly linked neighbors in 1-hop relevance scoring.
- **Side-Docked (`Ctrl+G`) & True Fullscreen (`Ctrl+Shift+G`) Graph Modes (`ui/graph.js`, `ui/index.html`, `ui/app.js`)**:
  - Opening the graph defaults to a side-docked live drawer replacing the AI panel so you can navigate notes directly alongside your document.
  - Clicking **Expand (`⤢`)** or pressing `Ctrl+Shift+G` opens a `100vw × 100vh` fullscreen graph explorer with folder legend filtering, **Local (`L`)** 1-hop focus, `@skill` filtering, and a floating **Node Inspector Card** (`Open/Create Note`, `Focus 1-Hop`, `Ask AI (Node)` / `Ask AI (Cluster)`).
- **Auto-Reset & Manual Reset to Default (`R`) (`ui/graph.js`)**:
  - Closing the graph or exiting Fullscreen back to Side mode automatically resets filters, active folder focus, selected node, Local 1-hop mode, and manually dragged node coordinates back to default.
  - Added a dedicated **Reset (`R`)** button in both the fullscreen toolbar and side header (`ui/graph.js`, `ui/index.html`).
- **Left Collapsible Document Outline (`Ctrl+Shift+O`, `ui/outline.js`)**:
  - Replaced the hover right-edge rail with a stationary top-left `#btn-toggle-outline` button and collapsible left outline drawer synced two-way with `#`–`###` heading folds and live scroll position (zero startup overhead while closed).
- **GitHub Pages Landing Site & Structured SEO (`docs/`)**:
  - Added [`docs/index.html`](docs/index.html), [`docs/og-card.svg`](docs/og-card.svg), [`docs/robots.txt`](docs/robots.txt), [`docs/sitemap.xml`](docs/sitemap.xml), and [`docs/SEO_CHECKLIST.md`](docs/SEO_CHECKLIST.md) with `SoftwareApplication` and `FAQPage` JSON-LD metadata.
- **MCP Graph Enrichment (`core-engine/src/mcp.rs`, `core-engine/src/vault.rs`)**:
  - Extended `get_vault_graph` output with node `kind` (`note` / `skill` / `ghost`), `skill_slug`, `folder`, `in_degree`, `out_degree`, `est_tokens`, and directed edge citation `weight`.

### Changed
- **Single Clean `<--->` & `--->` Arrows + Strength Color Coding (`ui/graph.js`)**:
  - Replaced duplicate curved incoming/outgoing wires between two connected notes with a single consolidated **bidirectional (`<--->`)** or **one-way (`--->`)** arrow.
  - Color-coded edges semantically by composite tie strength (`tieScore` combining citation counts, mutual links, and shared neighbors): **Emerald Green** (`tieScore >= 4.0`, strong tie), **Accent Blue** (`tieScore >= 2.5`, mutual/medium tie), and **Calm Slate** (`tieScore < 2.5`, passing mention), with line thickness scaling smoothly by `log2(totalWeight)`.
- **Active-Page Double-Ring Highlight & Hop Relevance Muting (`ui/graph.js`)**:
  - Highlights the currently open note with an unmistakable double blue ring and proportionally fades/mutes 2-hop and unconnected nodes so the active note's neighborhood stands out immediately.

### Fixed
- **Cross-Note Block Content Contamination (`ui/editor.js`)**:
  - Guarded `syncAllEditableFromDom()` with a document-generation (`docGen`) check and moved selection notifications after `render()` inside `loadDocument()` and `hotReloadDocument()`, preventing stale DOM text from overwriting newly opened notes that share block indices.
