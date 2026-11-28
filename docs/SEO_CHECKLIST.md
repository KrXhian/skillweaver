# Skillweaver Google & GitHub SEO Checklist (`KrXhian/skillweaver`)

Shipping strong copy, structured data, and sitemaps in Git gives Google everything it needs to index Skillweaver cleanly. Complete the one-time 3-minute GitHub + Search Console steps below so Google indexes `https://krxhian.github.io/skillweaver/` right after pushing.

---

## 1. GitHub Repository "About" Metadata (Right Sidebar)

Open `https://github.com/KrXhian/skillweaver` -> click the gear icon next to **About** and paste:

- **Description**:
  `Local-first desktop Markdown editor, citation-weighted knowledge graph & multi-key BYOK AI workspace over plain .md folders (Rust + Tauri v2, zero Node.js, built-in MCP server).`
- **Website**:
  `https://krxhian.github.io/skillweaver/`
- **Topics** (GitHub allows up to 20):
  `skillweaver`, `markdown-editor`, `local-first`, `knowledge-graph`, `weighted-graph`, `obsidian-alternative`, `notion-alternative`, `pkm`, `notes-app`, `tauri`, `rust`, `byok`, `ai-assistant`, `mcp-server`, `model-context-protocol`, `wikilinks`, `block-editor`, `desktop-app`, `windows`, `second-brain`

---

## 2. Turn On GitHub Pages (`/docs`)

1. Push your commits including the `docs/` folder to `main` (or `master`).
2. In your GitHub repo: **Settings** -> **Pages**.
3. Under **Build and deployment**:
   - **Source**: `Deploy from a branch`
   - **Branch**: your default branch (`main` / `master`), folder: `/docs`
4. Wait ~60 seconds and verify `https://krxhian.github.io/skillweaver/` loads cleanly (plus `/sitemap.xml` and `/robots.txt`).

---

## 3. Submit to Google Search Console (Fastest Indexing)

Instead of waiting weeks for Google to stumble onto the new GitHub Pages URL:

1. Go to [Google Search Console](https://search.google.com/search-console) and add a **URL prefix** property:
   `https://krxhian.github.io/skillweaver/`
2. Choose **HTML tag** verification (or upload the tiny verification HTML file into `docs/` and push).
3. Once verified:
   - Open **Sitemaps** -> submit `sitemap.xml`
   - Open **URL Inspection** -> enter `https://krxhian.github.io/skillweaver/` -> click **Request Indexing**

*(Google also crawls `https://github.com/KrXhian/skillweaver`, so once both the GitHub repo and GitHub Pages site link to each other with `SoftwareApplication` + `FAQPage` schema, searches for `"skillweaver markdown"` or `"skillweaver desktop"` differentiate clearly from `OSU-NLP-Group/SkillWeaver`.)*

---

## 4. High-Signal External Backlinks (How You Climb to Page 1 for `"skillweaver"`)

Search engines rank pages based on authority/backlinks in addition to page metadata:

1. Publish a tagged GitHub Release (`v0.1.0`+) attaching `skillweaver-windows-x64.exe` from `.github/workflows/release.yml`.
2. Submit Skillweaver to **AlternativeTo** (linking both GitHub + `https://krxhian.github.io/skillweaver/`).
3. Submit a concise PR to **awesome-tauri** and **awesome-mcp-servers** / MCP directories.
4. Post a showcase thread on **r/ObsidianMD**, **r/PKMS**, **r/LocalLLaMA**, or **Show HN** with a screenshot showing the Side/Fullscreen Citation-Weighted Knowledge Graph (`<--->` / `--->` strength colors, double-ring active page, 1-click AI cluster) + `--mcp` workflow.
