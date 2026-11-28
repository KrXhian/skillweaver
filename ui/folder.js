// Copyright 2026 Blue Frog Foundation
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { escapeHtml } from "./inline.js";

function formatRelativeTime(modifiedMs) {
  const ts = Number(modifiedMs);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diffMs = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatExactTime(modifiedMs) {
  const ts = Number(modifiedMs);
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return new Date(ts).toLocaleString();
}

function normalizePropsList(list = []) {
  return (Array.isArray(list) ? list : [])
    .map((p) => ({
      key: String(p?.key ?? "").trim(),
      value: String(p?.value ?? "").trim(),
    }))
    .filter((p) => p.key.length > 0);
}

function serializePropsKey(list = []) {
  return JSON.stringify(normalizePropsList(list));
}

/**
 * Fast native Folder Explorer canvas showing folder properties, templates, and child entries.
 */
export class FolderView {
  constructor(
    { containerEl },
    {
      onOpenNote,
      onOpenFolder,
      onCreateNote,
      onCreateFolder,
      onSaveProperties,
      onSaveTemplate,
      onDeleteTemplate,
      onShowToast,
    }
  ) {
    this.containerEl = containerEl;
    this.onOpenNote = onOpenNote;
    this.onOpenFolder = onOpenFolder;
    this.onCreateNote = onCreateNote;
    this.onCreateFolder = onCreateFolder;
    this.onSaveProperties = onSaveProperties;
    this.onSaveTemplate = onSaveTemplate;
    this.onDeleteTemplate = onDeleteTemplate;
    this.onShowToast = onShowToast;

    this.overview = null;
    this.draftProps = [];
    this.lastSavedPropsKey = "[]";
    this.propsCollapsed = false;
    this.templateFormOpen = false;
    this.editingTemplateFile = null;
    this.templateDraft = { name: "", description: "", body: "" };
    this.sortField = "name"; // "name" | "modified"
    this.sortDir = "asc"; // "asc" | "desc"
    this.filterQuery = "";
    this.newMenuOpen = false;
    this.savingProps = false;

    this._onDocMouseDown = (e) => {
      if (this.newMenuOpen && !e.target.closest?.(".folder-new-wrap")) {
        this.closeNewMenu();
      }
    };
    document.addEventListener("mousedown", this._onDocMouseDown);
  }

  setOverview(overview) {
    const prevFolder = this.overview?.folder_rel ?? null;
    this.overview = overview || null;
    this.newMenuOpen = false;

    if (!this.overview) {
      this.containerEl.innerHTML = "";
      return;
    }

    if (prevFolder !== this.overview.folder_rel) {
      this.templateFormOpen = false;
      this.editingTemplateFile = null;
      this.templateDraft = { name: "", description: "", body: "" };
      this.filterQuery = "";
    }

    const clean = normalizePropsList(this.overview.properties || []);
    this.draftProps = clean.map((p) => ({ ...p }));
    this.lastSavedPropsKey = serializePropsKey(clean);
    this.render();
  }

  closeNewMenu() {
    this.newMenuOpen = false;
    const menu = this.containerEl.querySelector(".folder-new-menu");
    if (menu) menu.hidden = true;
  }

  getSortedFilteredEntries() {
    const rawEntries = Array.isArray(this.overview?.entries) ? this.overview.entries : [];
    const query = this.filterQuery.trim().toLowerCase();
    const filtered = query
      ? rawEntries.filter((entry) => {
          const title = (entry.title || "").toLowerCase();
          const name = (entry.name || "").toLowerCase();
          const fileName = (entry.file_name || "").toLowerCase();
          return title.includes(query) || name.includes(query) || fileName.includes(query);
        })
      : rawEntries.slice();

    const dirMult = this.sortDir === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      if (this.sortField === "modified") {
        const diff = (Number(a.modified_ms) || 0) - (Number(b.modified_ms) || 0);
        if (diff !== 0) return diff * dirMult;
      }
      const aKindRank = a.kind === "dir" ? 0 : 1;
      const bKindRank = b.kind === "dir" ? 0 : 1;
      if (this.sortField === "name" && aKindRank !== bKindRank) {
        return aKindRank - bKindRank;
      }
      const aLabel = (a.title || a.name || a.file_name || "").toLowerCase();
      const bLabel = (b.title || b.name || b.file_name || "").toLowerCase();
      return aLabel.localeCompare(bLabel) * dirMult;
    });

    return filtered;
  }

  async commitDraftProps({ rerender = true } = {}) {
    if (!this.overview || this.savingProps) return;
    const nextList = normalizePropsList(this.draftProps);
    const nextKey = serializePropsKey(nextList);
    if (nextKey === this.lastSavedPropsKey) return;

    this.savingProps = true;
    try {
      const saved = await this.onSaveProperties?.(this.overview.folder_rel, nextList);
      const normalizedSaved = normalizePropsList(saved ?? nextList);
      this.overview.properties = normalizedSaved;
      this.draftProps = normalizedSaved.map((p) => ({ ...p }));
      this.lastSavedPropsKey = serializePropsKey(normalizedSaved);
      if (rerender) {
        this.renderPropsSectionOnly();
      }
    } catch (err) {
      this.onShowToast?.(`Failed to save properties: ${err}`, true);
    } finally {
      this.savingProps = false;
    }
  }

  renderPropsSectionOnly() {
    const card = this.containerEl.querySelector(".folder-props-card");
    if (card) {
      card.outerHTML = this.buildPropsCardHtml();
      this.bindPropsEvents();
    }
  }

  renderEntriesSectionOnly() {
    const tbody = this.containerEl.querySelector(".folder-entries-list");
    if (tbody) {
      tbody.innerHTML = this.buildEntriesRowsHtml(this.getSortedFilteredEntries());
      this.bindEntryRowEvents();
    }
    this.syncSortHeaders();
  }

  syncSortHeaders() {
    const nameBtn = this.containerEl.querySelector('[data-sort="name"]');
    const modBtn = this.containerEl.querySelector('[data-sort="modified"]');
    if (nameBtn) {
      const ind =
        this.sortField === "name" ? (this.sortDir === "asc" ? "↑" : "↓") : "⇅";
      nameBtn.querySelector(".folder-sort-arrow").textContent = ind;
      nameBtn.classList.toggle("active", this.sortField === "name");
    }
    if (modBtn) {
      const ind =
        this.sortField === "modified" ? (this.sortDir === "asc" ? "↑" : "↓") : "⇅";
      modBtn.querySelector(".folder-sort-arrow").textContent = ind;
      modBtn.classList.toggle("active", this.sortField === "modified");
    }
  }

  buildPropsCardHtml() {
    const ov = this.overview;
    const chevCls = `chevron-icon${this.propsCollapsed ? " collapsed" : ""}`;
    const hasRows = this.draftProps.length > 0;
    const rowsHtml = this.draftProps
      .map(
        (prop, idx) => `
          <div class="folder-prop-row" data-prop-idx="${idx}">
            <input
              type="text"
              class="folder-prop-input folder-prop-key"
              value="${escapeHtml(prop.key)}"
              placeholder="key (e.g. status)"
              aria-label="Property key"
              data-prop-idx="${idx}"
            />
            <input
              type="text"
              class="folder-prop-input folder-prop-val"
              value="${escapeHtml(prop.value)}"
              placeholder="value"
              aria-label="Property value"
              data-prop-idx="${idx}"
            />
            <button
              type="button"
              class="folder-prop-del"
              title="Remove property"
              aria-label="Remove property"
              data-prop-idx="${idx}"
            >&times;</button>
          </div>
        `
      )
      .join("");

    return `
      <section class="folder-card folder-props-card">
        <div class="folder-card-header">
          <button type="button" id="folder-props-toggle" class="folder-card-toggle" aria-expanded="${String(!this.propsCollapsed)}">
            <svg class="${chevCls}" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 4.5L6 7.5L9 4.5"/>
            </svg>
            <span class="folder-card-label">Folder Properties</span>
          </button>
          <span class="folder-meta-path" title="Stored automatically inside this folder">${escapeHtml(ov.props_rel_path)}</span>
        </div>
        <div class="folder-card-body"${this.propsCollapsed ? " hidden" : ""}>
          <p class="folder-hint">A title, description, tags — anything that describes this folder.</p>
          ${
            hasRows
              ? `<div class="folder-prop-list">${rowsHtml}</div>`
              : `<div class="folder-empty-text">Nothing set yet.</div>`
          }
          <button type="button" id="folder-add-prop-btn" class="folder-inline-action">+ Add a property</button>
        </div>
      </section>
    `;
  }

  buildTemplatesCardHtml() {
    const tpls = this.overview?.templates || [];
    const formHtml = this.templateFormOpen
      ? `
        <form id="folder-template-form" class="folder-template-form">
          <div class="folder-template-form-grid">
            <input
              type="text"
              id="folder-tpl-name"
              class="folder-input"
              placeholder="Template name (e.g. Pipeline Spec)"
              value="${escapeHtml(this.templateDraft.name)}"
              required
            />
            <input
              type="text"
              id="folder-tpl-desc"
              class="folder-input"
              placeholder="Short description (optional)"
              value="${escapeHtml(this.templateDraft.description)}"
            />
          </div>
          <textarea
            id="folder-tpl-body"
            class="folder-textarea"
            rows="4"
            placeholder="# {{title}}&#10;&#10;Created: {{date}}"
          >${escapeHtml(this.templateDraft.body)}</textarea>
          <div class="folder-template-form-footer">
            <span class="folder-template-hint">Supports <code>{{title}}</code> &amp; <code>{{date}}</code> placeholders</span>
            <div class="folder-template-form-btns">
              <button type="button" id="folder-tpl-cancel" class="secondary-btn">Cancel</button>
              <button type="submit" class="primary-btn">${this.editingTemplateFile ? "Update Template" : "Save Template"}</button>
            </div>
          </div>
        </form>
      `
      : "";

    const listHtml = tpls.length
      ? `
        <div class="folder-template-list">
          ${tpls
            .map(
              (tpl) => `
                <div class="folder-template-item" data-tpl-file="${escapeHtml(tpl.file_name)}">
                  <div class="folder-template-info">
                    <span class="folder-template-name">${escapeHtml(tpl.name)}</span>
                    ${
                      tpl.description
                        ? `<span class="folder-template-desc">${escapeHtml(tpl.description)}</span>`
                        : `<span class="folder-template-desc">${escapeHtml(tpl.file_name)}</span>`
                    }
                  </div>
                  <div class="folder-template-actions">
                    <button type="button" class="folder-tpl-use-btn" data-tpl-file="${escapeHtml(tpl.file_name)}" title="Create note from template">Use</button>
                    <button type="button" class="folder-tpl-edit-btn" data-tpl-file="${escapeHtml(tpl.file_name)}" title="Edit template">Edit</button>
                    <button type="button" class="folder-tpl-del-btn" data-tpl-file="${escapeHtml(tpl.file_name)}" title="Delete template">&times;</button>
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      `
      : !this.templateFormOpen
        ? `<div class="folder-empty-text">No templates yet. Add one to give new docs in this folder a ready-made starting point.</div>`
        : "";

    return `
      <section class="folder-card folder-templates-card">
        <div class="folder-card-header">
          <div class="folder-card-title-group">
            <span class="folder-card-label">Templates Available</span>
            <span class="folder-count-pill">${tpls.length}</span>
          </div>
          <button type="button" id="folder-new-tpl-btn" class="folder-card-action">+ New Template</button>
        </div>
        <div class="folder-card-body">
          ${formHtml}
          ${listHtml}
        </div>
      </section>
    `;
  }

  buildEntriesRowsHtml(entries) {
    if (!entries.length) {
      const msg = this.filterQuery.trim()
        ? "No matching notes or folders."
        : "This folder has no notes or subfolders yet.";
      return `<div class="folder-entries-empty">${escapeHtml(msg)}</div>`;
    }

    return entries
      .map((entry) => {
        const relEsc = escapeHtml(entry.rel_path);
        const modRel = formatRelativeTime(entry.modified_ms);
        const modExact = formatExactTime(entry.modified_ms);

        if (entry.kind === "dir") {
          const itemLabel = entry.child_count === 1 ? "1 item" : `${entry.child_count} items`;
          return `
            <button type="button" class="folder-entry-row" data-kind="dir" data-rel-path="${relEsc}" title="${relEsc}">
              <span class="folder-entry-main">
                <span class="folder-entry-icon is-dir" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                    <path d="M1.5 3.5h4.2l1.3 1.4h7.5v7.6h-13z"/>
                  </svg>
                </span>
                <span class="folder-entry-text">
                  <span class="folder-entry-title">${escapeHtml(entry.name)}</span>
                  <span class="folder-entry-sub">${escapeHtml(itemLabel)}</span>
                </span>
              </span>
              <span class="folder-entry-modified" title="${escapeHtml(modExact)}">${escapeHtml(modRel)}</span>
            </button>
          `;
        }

        const primaryTitle = entry.title || entry.name || entry.file_name;
        return `
          <button type="button" class="folder-entry-row" data-kind="note" data-rel-path="${relEsc}" title="${relEsc}">
            <span class="folder-entry-main">
              <span class="folder-entry-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
                  <path d="M3.5 2h6l3 3v9h-9z"/>
                  <path d="M9.5 2v3h3"/>
                </svg>
              </span>
              <span class="folder-entry-text">
                <span class="folder-entry-title">${escapeHtml(primaryTitle)}</span>
                <span class="folder-entry-sub">${escapeHtml(entry.file_name)}</span>
              </span>
            </span>
            <span class="folder-entry-modified" title="${escapeHtml(modExact)}">${escapeHtml(modRel)}</span>
          </button>
        `;
      })
      .join("");
  }

  render() {
    if (!this.overview) {
      this.containerEl.innerHTML = "";
      return;
    }

    const ov = this.overview;
    const totalRaw = Array.isArray(ov.entries) ? ov.entries.length : 0;
    const sorted = this.getSortedFilteredEntries();
    const templates = ov.templates || [];
    const nameArrow =
      this.sortField === "name" ? (this.sortDir === "asc" ? "↑" : "↓") : "⇅";
    const modArrow =
      this.sortField === "modified" ? (this.sortDir === "asc" ? "↑" : "↓") : "⇅";

    const newMenuHtml = templates.length
      ? `
        <div class="folder-new-menu popover-menu" hidden>
          <button type="button" class="popover-item" data-new-tpl="">Blank Note</button>
          <div class="popover-divider"></div>
          ${templates
            .map(
              (tpl) => `
                <button type="button" class="popover-item" data-new-tpl="${escapeHtml(tpl.file_name)}">
                  <span>${escapeHtml(tpl.name)}</span>
                </button>
              `
            )
            .join("")}
        </div>
      `
      : "";

    const filterHtml =
      totalRaw > 5
        ? `
          <div class="folder-filter-bar">
            <input
              type="search"
              id="folder-filter-input"
              class="folder-filter-input"
              placeholder="Filter items in this folder..."
              value="${escapeHtml(this.filterQuery)}"
              autocomplete="off"
            />
          </div>
        `
        : "";

    this.containerEl.innerHTML = `
      <div class="folder-sheet">
        <header class="folder-header">
          <div class="folder-heading">
            <span class="folder-heading-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
                <path d="M1.5 3.5h4.2l1.3 1.4h7.5v7.6h-13z"/>
              </svg>
            </span>
            <h1 class="folder-title">${escapeHtml(ov.folder_name)}</h1>
          </div>
          <div class="folder-header-actions">
            <button type="button" id="folder-new-subfolder-btn" class="secondary-btn">+ Subfolder</button>
            <div class="folder-new-wrap">
              <button type="button" id="folder-new-note-btn" class="primary-btn folder-new-btn">+ New</button>
              ${newMenuHtml}
            </div>
          </div>
        </header>

        ${this.buildPropsCardHtml()}
        ${this.buildTemplatesCardHtml()}

        <section class="folder-card folder-entries-card">
          ${filterHtml}
          <div class="folder-entries-header">
            <button type="button" class="folder-sort-btn${this.sortField === "name" ? " active" : ""}" data-sort="name">
              <span>NAME</span>
              <span class="folder-sort-arrow">${nameArrow}</span>
            </button>
            <button type="button" class="folder-sort-btn is-right${this.sortField === "modified" ? " active" : ""}" data-sort="modified">
              <span>MODIFIED</span>
              <span class="folder-sort-arrow">${modArrow}</span>
            </button>
          </div>
          <div class="folder-entries-list">
            ${this.buildEntriesRowsHtml(sorted)}
          </div>
        </section>
      </div>
    `;

    this.bindEvents();
  }

  bindPropsEvents() {
    const toggleBtn = this.containerEl.querySelector("#folder-props-toggle");
    toggleBtn?.addEventListener("click", () => {
      this.propsCollapsed = !this.propsCollapsed;
      this.renderPropsSectionOnly();
    });

    const addBtn = this.containerEl.querySelector("#folder-add-prop-btn");
    addBtn?.addEventListener("click", () => {
      this.propsCollapsed = false;
      this.draftProps.push({ key: "", value: "" });
      this.renderPropsSectionOnly();
      const keys = this.containerEl.querySelectorAll(".folder-prop-key");
      const lastKey = keys[keys.length - 1];
      lastKey?.focus();
    });

    this.containerEl.querySelectorAll(".folder-prop-key").forEach((input) => {
      const idx = Number(input.dataset.propIdx);
      input.addEventListener("input", () => {
        if (this.draftProps[idx]) this.draftProps[idx].key = input.value;
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const valInput = this.containerEl.querySelector(
            `.folder-prop-val[data-prop-idx="${idx}"]`
          );
          if (valInput && !valInput.value) {
            valInput.focus();
          } else {
            this.commitDraftProps();
          }
        }
      });
      input.addEventListener("blur", (e) => {
        const related = e.relatedTarget;
        if (related && related.dataset?.propIdx === String(idx)) return;
        this.commitDraftProps({ rerender: false });
      });
    });

    this.containerEl.querySelectorAll(".folder-prop-val").forEach((input) => {
      const idx = Number(input.dataset.propIdx);
      input.addEventListener("input", () => {
        if (this.draftProps[idx]) this.draftProps[idx].value = input.value;
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
          this.commitDraftProps();
        }
      });
      input.addEventListener("blur", (e) => {
        const related = e.relatedTarget;
        if (related && related.dataset?.propIdx === String(idx)) return;
        this.commitDraftProps({ rerender: false });
      });
    });

    this.containerEl.querySelectorAll(".folder-prop-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.propIdx);
        this.draftProps.splice(idx, 1);
        this.renderPropsSectionOnly();
        this.commitDraftProps();
      });
    });
  }

  bindEntryRowEvents() {
    this.containerEl.querySelectorAll(".folder-entry-row").forEach((row) => {
      row.addEventListener("click", () => {
        const kind = row.dataset.kind;
        const relPath = row.dataset.relPath;
        if (!relPath) return;
        if (kind === "dir") {
          this.onOpenFolder?.(relPath);
        } else {
          this.onOpenNote?.(relPath);
        }
      });
    });
  }

  bindEvents() {
    const ov = this.overview;
    if (!ov) return;

    this.containerEl
      .querySelector("#folder-new-subfolder-btn")
      ?.addEventListener("click", () => {
        this.onCreateFolder?.(ov.folder_rel);
      });

    const newNoteBtn = this.containerEl.querySelector("#folder-new-note-btn");
    const newMenu = this.containerEl.querySelector(".folder-new-menu");
    newNoteBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!newMenu) {
        this.onCreateNote?.(ov.folder_rel, null);
        return;
      }
      this.newMenuOpen = !this.newMenuOpen;
      newMenu.hidden = !this.newMenuOpen;
    });

    newMenu?.querySelectorAll("[data-new-tpl]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tplFile = btn.dataset.newTpl || null;
        this.closeNewMenu();
        this.onCreateNote?.(ov.folder_rel, tplFile);
      });
    });

    this.bindPropsEvents();

    this.containerEl
      .querySelector("#folder-new-tpl-btn")
      ?.addEventListener("click", () => {
        this.templateFormOpen = true;
        this.editingTemplateFile = null;
        this.templateDraft = { name: "", description: "", body: "" };
        this.render();
        this.containerEl.querySelector("#folder-tpl-name")?.focus();
      });

    this.containerEl
      .querySelector("#folder-tpl-cancel")
      ?.addEventListener("click", () => {
        this.templateFormOpen = false;
        this.editingTemplateFile = null;
        this.render();
      });

    this.containerEl
      .querySelector("#folder-template-form")
      ?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const nameEl = this.containerEl.querySelector("#folder-tpl-name");
        const descEl = this.containerEl.querySelector("#folder-tpl-desc");
        const bodyEl = this.containerEl.querySelector("#folder-tpl-body");
        const name = (nameEl?.value || "").trim();
        if (!name) {
          this.onShowToast?.("Template name is required", true);
          nameEl?.focus();
          return;
        }
        try {
          await this.onSaveTemplate?.({
            folderRel: ov.folder_rel,
            fileName: this.editingTemplateFile,
            name,
            description: (descEl?.value || "").trim(),
            body: bodyEl?.value || "",
          });
          this.templateFormOpen = false;
          this.editingTemplateFile = null;
          this.render();
        } catch (err) {
          this.onShowToast?.(`Failed to save template: ${err}`, true);
        }
      });

    this.containerEl.querySelectorAll(".folder-tpl-use-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.onCreateNote?.(ov.folder_rel, btn.dataset.tplFile || null);
      });
    });

    this.containerEl.querySelectorAll(".folder-tpl-edit-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = (ov.templates || []).find(
          (t) => t.file_name === btn.dataset.tplFile
        );
        if (!target) return;
        this.templateFormOpen = true;
        this.editingTemplateFile = target.file_name;
        this.templateDraft = {
          name: target.name || "",
          description: target.description || "",
          body: target.body || "",
        };
        this.render();
        this.containerEl.querySelector("#folder-tpl-name")?.focus();
      });
    });

    this.containerEl.querySelectorAll(".folder-tpl-del-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const fileName = btn.dataset.tplFile;
        if (!fileName) return;
        try {
          await this.onDeleteTemplate?.(ov.folder_rel, fileName);
        } catch (err) {
          this.onShowToast?.(`Failed to delete template: ${err}`, true);
        }
      });
    });

    const filterInput = this.containerEl.querySelector("#folder-filter-input");
    filterInput?.addEventListener("input", () => {
      this.filterQuery = filterInput.value || "";
      this.renderEntriesSectionOnly();
    });

    this.containerEl.querySelectorAll(".folder-sort-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const field = btn.dataset.sort;
        if (!field) return;
        if (this.sortField === field) {
          this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
        } else {
          this.sortField = field;
          this.sortDir = field === "modified" ? "desc" : "asc";
        }
        this.renderEntriesSectionOnly();
      });
    });

    this.bindEntryRowEvents();
  }
}
