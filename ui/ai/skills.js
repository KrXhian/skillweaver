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

import { escapeHtml } from "../inline.js";
import { computeTextMetrics, estimateTokens, formatTokenCompact } from "../metrics.js";
import { SKILL_ICON_SVG, normalizeSkillSlug } from "./edits.js";

function skillTokenCount(skill) {
  const combined = [skill?.name, skill?.description, skill?.body].filter(Boolean).join("\n");
  return estimateTokens(combined);
}

/**
 * Collapsible Skill Bank drawer inside the AI Assistant panel.
 * Supports listing/filtering, pinning skills to a conversation, creating/editing SKILL.md files,
 * inserting `@skill` mentions, and harvesting skills from the current chat.
 */
export class AiSkillsDrawer {
  constructor(
    { skillsBtn, skillsDrawerEl },
    {
      invoke,
      getCurrentContext,
      getSkills,
      setSkills,
      getPinnedSkillIds,
      onTogglePinSkill,
      onInsertSkillMention,
      onHarvestChat,
      onOpenRawFile,
      onVaultChanged,
      onBeforeOpen,
      onOpenStateChange,
      onConfirmDelete,
      onToast,
    }
  ) {
    this.skillsBtn = skillsBtn;
    this.skillsDrawerEl = skillsDrawerEl;

    this.invoke = invoke;
    this.getCurrentContext = getCurrentContext;
    this.getSkills = getSkills;
    this.setSkills = setSkills;
    this.getPinnedSkillIds = getPinnedSkillIds;
    this.onTogglePinSkill = onTogglePinSkill;
    this.onInsertSkillMention = onInsertSkillMention;
    this.onHarvestChat = onHarvestChat;
    this.onOpenRawFile = onOpenRawFile;
    this.onVaultChanged = onVaultChanged;
    this.onBeforeOpen = onBeforeOpen;
    this.onOpenStateChange = onOpenStateChange;
    this.onConfirmDelete = onConfirmDelete;
    this.onToast = onToast;

    this.isOpen = false;
    this.mode = "list";
    this.filter = "";
    this.saving = false;
    this.draft = this.emptyDraft();

    this.skillsBtn?.addEventListener("click", () => this.toggle());
  }

  emptyDraft() {
    const ctx = this.getCurrentContext?.() || {};
    return {
      originalId: null,
      relPath: null,
      name: "",
      slug: "",
      slugManuallyEdited: false,
      description: "",
      scope: ctx.vaultPath ? "vault" : "global",
      body: "",
    };
  }

  isDrawerOpen() {
    return this.isOpen;
  }

  refresh() {
    if (this.isOpen && this.mode === "list") {
      this.render();
    }
  }

  async toggle(forceState = null) {
    if (!this.skillsDrawerEl) return;
    const nextOpen = forceState === null ? !this.isOpen : Boolean(forceState);
    this.isOpen = nextOpen;
    this.skillsDrawerEl.hidden = !nextOpen;
    this.skillsBtn?.classList.toggle("active", nextOpen);

    if (nextOpen) {
      this.onBeforeOpen?.();
      this.mode = "list";
      try {
        const list = await this.invoke("ai_list_skills");
        if (Array.isArray(list)) {
          this.setSkills?.(list);
        }
      } catch {
        // Keep cached list on error
      }
      this.render();
      this.skillsDrawerEl.querySelector("#ai-skills-search")?.focus();
    }
    this.onOpenStateChange?.(this.isOpen);
  }

  openCreateForm({ slug = "", name = "", description = "", scope = null, body = "" } = {}) {
    if (!this.skillsDrawerEl) return;
    const ctx = this.getCurrentContext?.() || {};
    const cleanSlug = normalizeSkillSlug(slug || name);
    const defaultScope = scope === "global" || scope === "vault"
      ? scope === "vault" && !ctx.vaultPath
        ? "global"
        : scope
      : ctx.vaultPath
        ? "vault"
        : "global";

    this.draft = {
      originalId: null,
      relPath: null,
      name: name || (cleanSlug ? cleanSlug.replace(/-/g, " ") : ""),
      slug: cleanSlug,
      slugManuallyEdited: Boolean(slug),
      description: description || "",
      scope: defaultScope,
      body: body || "",
    };

    if (!this.isOpen) {
      this.isOpen = true;
      this.skillsDrawerEl.hidden = false;
      this.skillsBtn?.classList.add("active");
      this.onBeforeOpen?.();
    }
    this.mode = "form";
    this.render();
    this.onOpenStateChange?.(this.isOpen);
    const nameInput = this.skillsDrawerEl.querySelector("#ai-skill-name");
    const bodyInput = this.skillsDrawerEl.querySelector("#ai-skill-body");
    if (this.draft.name && !this.draft.body) {
      bodyInput?.focus();
    } else {
      nameInput?.focus();
    }
  }

  openEditForm(skill) {
    if (!skill || !this.skillsDrawerEl) return;
    this.draft = {
      originalId: skill.id,
      relPath: skill.rel_path || null,
      name: skill.name || skill.slug || "",
      slug: skill.slug || "",
      slugManuallyEdited: true,
      description: skill.description || "",
      scope: skill.scope === "global" ? "global" : "vault",
      body: skill.body || "",
    };

    if (!this.isOpen) {
      this.isOpen = true;
      this.skillsDrawerEl.hidden = false;
      this.skillsBtn?.classList.add("active");
      this.onBeforeOpen?.();
    }
    this.mode = "form";
    this.render();
    this.onOpenStateChange?.(this.isOpen);
    this.skillsDrawerEl.querySelector("#ai-skill-body")?.focus();
  }

  render() {
    if (!this.skillsDrawerEl) return;
    if (this.mode === "form") {
      this.renderForm();
    } else {
      this.renderList();
    }
  }

  renderList() {
    const skills = this.getSkills?.() || [];
    const pinnedIds = this.getPinnedSkillIds?.() || [];
    const pinnedSet = new Set(pinnedIds);
    const q = this.filter.trim().toLowerCase();

    const filtered = q
      ? skills.filter(
          (s) =>
            (s.slug || "").toLowerCase().includes(q) ||
            (s.name || "").toLowerCase().includes(q) ||
            (s.description || "").toLowerCase().includes(q)
        )
      : skills;

    const pinnedList = filtered.filter((s) => pinnedSet.has(s.id));
    const vaultList = filtered.filter((s) => !pinnedSet.has(s.id) && s.scope === "vault");
    const globalList = filtered.filter((s) => !pinnedSet.has(s.id) && s.scope === "global");

    const renderGroup = (heading, items) => {
      if (!items.length) return "";
      const rows = items
        .map((s) => {
          const isPinned = pinnedSet.has(s.id);
          const scopeLabel = s.scope === "global" ? "Global" : "Vault";
          const tok = skillTokenCount(s);
          const tokLabel = formatTokenCompact(tok);
          const tokTitle = `Estimated prompt budget: ~${tok.toLocaleString()} tokens`;
          const descText = s.description ? escapeHtml(s.description) : "No description";
          const idAttr = escapeHtml(s.id);
          return `
            <div class="ai-skill-row${isPinned ? " is-pinned" : ""}" data-skill-id="${idAttr}">
              <div class="ai-skill-row-main">
                <div class="ai-skill-row-head">
                  ${SKILL_ICON_SVG}
                  <span class="ai-skill-slug">@${escapeHtml(s.slug)}</span>
                  <span class="ai-skill-scope">${scopeLabel}</span>
                  <span class="ai-skill-tokens${tok >= 1000 ? " is-heavy" : ""}" title="${escapeHtml(tokTitle)}">${escapeHtml(tokLabel)}</span>
                </div>
                <div class="ai-skill-desc">${descText}</div>
              </div>
              <div class="ai-skill-actions">
                <button class="ai-chat-act-btn${isPinned ? " pinned" : ""}" data-skill-pin="${idAttr}" type="button" title="${isPinned ? "Unpin from chat" : "Pin to conversation bar"}">📌</button>
                <button class="ai-chat-act-btn" data-skill-use="${idAttr}" type="button" title="Insert @${escapeHtml(s.slug)} in prompt">@</button>
                <button class="ai-chat-act-btn" data-skill-edit="${idAttr}" type="button" title="Edit skill">✎</button>
                <button class="ai-chat-act-btn danger" data-skill-del="${idAttr}" type="button" title="Delete skill">×</button>
              </div>
            </div>
          `;
        })
        .join("");
      return `<div class="ai-history-section">${escapeHtml(heading)}</div>${rows}`;
    };

    const totalPinnedTokens = pinnedList.reduce((acc, s) => acc + skillTokenCount(s), 0);
    const pinnedHeading = pinnedList.length
      ? `Pinned in Chat · ${formatTokenCompact(totalPinnedTokens)}`
      : "Pinned in Chat";

    let bodyHtml = "";
    if (!skills.length) {
      bodyHtml = `
        <div class="ai-skills-empty">
          <p><strong>No skills yet.</strong> Skills are reusable <code>SKILL.md</code> prompts stored in your folder or global bank.</p>
          <p class="ai-empty-hint">Type <code>@skill</code> for a single turn, or pin skills to apply on every message.</p>
          <button id="ai-btn-first-skill" class="primary-btn ai-first-skill-btn" type="button">+ Create Your First Skill</button>
        </div>
      `;
    } else if (!filtered.length) {
      bodyHtml = `<div class="popover-section-label">No matching skills</div>`;
    } else {
      bodyHtml = [
        renderGroup(pinnedHeading, pinnedList),
        renderGroup("Vault Skills (skills/)", vaultList),
        renderGroup("Global Skill Bank", globalList),
      ].join("");
    }

    this.skillsDrawerEl.innerHTML = `
      <div class="ai-skills-top">
        <div class="ai-skills-top-btns">
          <button id="ai-btn-new-skill" class="ai-new-chat-btn ai-new-skill-btn" type="button">+ New Skill</button>
          <button id="ai-btn-harvest-skill" class="secondary-btn ai-harvest-btn" type="button" title="Ask AI to extract a reusable skill from this conversation">✦ Harvest</button>
        </div>
        <input id="ai-skills-search" class="ai-history-search" type="search" placeholder="Search skills..." value="${escapeHtml(this.filter)}" autocomplete="off" />
      </div>
      <div id="ai-skills-list" class="ai-skills-list">${bodyHtml}</div>
    `;

    this.skillsDrawerEl.querySelector("#ai-btn-new-skill")?.addEventListener("click", () => {
      this.openCreateForm({});
    });
    this.skillsDrawerEl.querySelector("#ai-btn-first-skill")?.addEventListener("click", () => {
      this.openCreateForm({});
    });
    this.skillsDrawerEl.querySelector("#ai-btn-harvest-skill")?.addEventListener("click", () => {
      this.onHarvestChat?.();
    });

    const searchInput = this.skillsDrawerEl.querySelector("#ai-skills-search");
    searchInput?.addEventListener("input", () => {
      this.filter = searchInput.value;
      const listEl = this.skillsDrawerEl.querySelector("#ai-skills-list");
      const cursor = searchInput.selectionStart;
      this.renderList();
      const nextSearch = this.skillsDrawerEl.querySelector("#ai-skills-search");
      if (nextSearch) {
        nextSearch.focus();
        if (typeof cursor === "number") {
          nextSearch.setSelectionRange(cursor, cursor);
        }
      } else if (listEl) {
        listEl.focus();
      }
    });

    this.skillsDrawerEl.querySelectorAll(".ai-skill-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".ai-skill-actions")) return;
        const skill = (this.getSkills?.() || []).find((s) => s.id === row.dataset.skillId);
        if (skill) this.openEditForm(skill);
      });
    });

    this.skillsDrawerEl.querySelectorAll("[data-skill-pin]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const skill = (this.getSkills?.() || []).find((s) => s.id === btn.dataset.skillPin);
        if (skill) {
          this.onTogglePinSkill?.(skill);
          this.renderList();
        }
      });
    });

    this.skillsDrawerEl.querySelectorAll("[data-skill-use]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const skill = (this.getSkills?.() || []).find((s) => s.id === btn.dataset.skillUse);
        if (skill) {
          this.onInsertSkillMention?.(skill);
        }
      });
    });

    this.skillsDrawerEl.querySelectorAll("[data-skill-edit]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const skill = (this.getSkills?.() || []).find((s) => s.id === btn.dataset.skillEdit);
        if (skill) this.openEditForm(skill);
      });
    });

    this.skillsDrawerEl.querySelectorAll("[data-skill-del]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const skill = (this.getSkills?.() || []).find((s) => s.id === btn.dataset.skillDel);
        if (!skill) return;
        if (this.onConfirmDelete) {
          const ok = await this.onConfirmDelete(skill);
          if (!ok) return;
        }
        try {
          const updated = await this.invoke("ai_delete_skill", { skillId: skill.id });
          if (Array.isArray(updated)) {
            this.setSkills?.(updated);
          }
          if (skill.scope === "vault") {
            this.onVaultChanged?.();
          }
          this.onToast?.(`Deleted skill @${skill.slug}`);
          this.renderList();
        } catch (err) {
          this.onToast?.(`Failed to delete skill: ${err}`, true);
        }
      });
    });
  }

  renderForm() {
    const ctx = this.getCurrentContext?.() || {};
    const hasVault = Boolean(ctx.vaultPath);
    const isEditing = Boolean(this.draft.originalId);
    const previewSlug = normalizeSkillSlug(this.draft.slug || this.draft.name) || "my-skill";
    const showRawBtn = isEditing && this.draft.scope === "vault" && this.draft.relPath;

    this.skillsDrawerEl.innerHTML = `
      <form id="ai-skill-form" class="ai-skill-form">
        <div class="ai-skill-form-header">
          <span class="ai-skill-form-title">${isEditing ? "Edit Skill" : "New Skill"}</span>
          <span id="ai-skill-slug-preview" class="ai-skill-slug-preview">@${escapeHtml(previewSlug)}</span>
        </div>

        <div class="ai-skill-form-row">
          <label class="ai-field ai-skill-field-grow">
            <span>Name</span>
            <input id="ai-skill-name" type="text" placeholder="e.g. Character Voice" value="${escapeHtml(this.draft.name)}" autocomplete="off" />
          </label>
          <label class="ai-field ai-skill-field-scope">
            <span>Scope</span>
            <select id="ai-skill-scope">
              <option value="vault"${this.draft.scope === "vault" ? " selected" : ""}${!hasVault ? " disabled" : ""}>Vault${!hasVault ? " (no folder)" : ""}</option>
              <option value="global"${this.draft.scope === "global" ? " selected" : ""}>Global</option>
            </select>
          </label>
        </div>

        <label class="ai-field">
          <span>Slug <small>(invoke via @${escapeHtml(previewSlug)})</small></span>
          <input id="ai-skill-slug" type="text" placeholder="character-voice" value="${escapeHtml(this.draft.slug)}" autocomplete="off" />
        </label>

        <label class="ai-field">
          <span>Description</span>
          <input id="ai-skill-desc" type="text" placeholder="When and how the AI should apply this skill..." value="${escapeHtml(this.draft.description)}" autocomplete="off" />
        </label>

        <label class="ai-field">
          <div class="ai-skill-body-label-row">
            <span>Instructions (Markdown · supports <code>[[wikilinks]]</code>)</span>
            <span id="ai-skill-live-tokens" class="ai-skill-live-tokens"></span>
          </div>
          <textarea id="ai-skill-body" class="ai-skill-textarea" rows="7" placeholder="# Purpose&#10;Write clear instructions, checklists, or tone rules...">${escapeHtml(this.draft.body)}</textarea>
        </label>

        <div class="ai-skill-form-actions">
          <div class="ai-skill-form-actions-left">
            <button id="ai-skill-cancel" class="secondary-btn" type="button">Cancel</button>
            ${showRawBtn ? `<button id="ai-skill-open-raw" class="top-text-btn" type="button" title="Open SKILL.md in editor">Open File</button>` : ""}
          </div>
          <div class="ai-skill-form-actions-right">
            ${!isEditing ? `<button id="ai-skill-save-pin" class="secondary-btn" type="button">Save &amp; Pin</button>` : ""}
            <button id="ai-skill-save" class="primary-btn" type="submit">${isEditing ? "Update" : "Save"}</button>
          </div>
        </div>
      </form>
    `;

    const formEl = this.skillsDrawerEl.querySelector("#ai-skill-form");
    const nameInput = this.skillsDrawerEl.querySelector("#ai-skill-name");
    const slugInput = this.skillsDrawerEl.querySelector("#ai-skill-slug");
    const scopeSelect = this.skillsDrawerEl.querySelector("#ai-skill-scope");
    const descInput = this.skillsDrawerEl.querySelector("#ai-skill-desc");
    const bodyInput = this.skillsDrawerEl.querySelector("#ai-skill-body");
    const slugPreview = this.skillsDrawerEl.querySelector("#ai-skill-slug-preview");
    const liveTokensEl = this.skillsDrawerEl.querySelector("#ai-skill-live-tokens");

    const updateLiveTokens = () => {
      if (!liveTokensEl) return;
      const bodyText = bodyInput?.value || "";
      const fullPromptText = [nameInput?.value, descInput?.value, bodyText]
        .filter((v) => String(v || "").trim().length > 0)
        .join("\n");
      const m = computeTextMetrics(bodyText, fullPromptText);
      liveTokensEl.textContent = `${formatTokenCompact(m.tokens)} · ${m.words.toLocaleString()} words`;
      liveTokensEl.title = `Estimated skill prompt budget: ~${m.tokens.toLocaleString()} tokens`;
    };
    updateLiveTokens();

    const updateSlugPreview = () => {
      const next = normalizeSkillSlug(slugInput.value || nameInput.value) || "my-skill";
      if (slugPreview) slugPreview.textContent = `@${next}`;
    };

    nameInput?.addEventListener("input", () => {
      this.draft.name = nameInput.value;
      if (!this.draft.slugManuallyEdited) {
        this.draft.slug = normalizeSkillSlug(nameInput.value);
        slugInput.value = this.draft.slug;
      }
      updateSlugPreview();
      updateLiveTokens();
    });

    slugInput?.addEventListener("input", () => {
      this.draft.slugManuallyEdited = slugInput.value.trim().length > 0;
      this.draft.slug = slugInput.value;
      updateSlugPreview();
    });

    scopeSelect?.addEventListener("change", () => {
      this.draft.scope = scopeSelect.value;
    });

    descInput?.addEventListener("input", () => {
      this.draft.description = descInput.value;
      updateLiveTokens();
    });

    bodyInput?.addEventListener("input", () => {
      this.draft.body = bodyInput.value;
      updateLiveTokens();
    });

    this.skillsDrawerEl.querySelector("#ai-skill-cancel")?.addEventListener("click", () => {
      this.mode = "list";
      this.render();
    });

    this.skillsDrawerEl.querySelector("#ai-skill-open-raw")?.addEventListener("click", () => {
      if (this.draft.relPath) {
        this.onOpenRawFile?.(this.draft.relPath);
      }
    });

    const submitSave = async (pinAfter = false) => {
      if (this.saving) return;
      const name = nameInput.value.trim();
      const slug = normalizeSkillSlug(slugInput.value.trim() || name);
      const description = descInput.value.trim();
      const scope = scopeSelect.value === "global" ? "global" : "vault";
      const body = bodyInput.value.trim();

      if (!slug) {
        nameInput.focus();
        this.onToast?.("Enter a skill name or slug first", true);
        return;
      }
      if (!body) {
        bodyInput.focus();
        this.onToast?.("Enter skill instructions first", true);
        return;
      }

      this.saving = true;
      try {
        const saved = await this.invoke("ai_save_skill", {
          request: {
            slug,
            name: name || slug,
            description,
            scope,
            body,
            original_id: this.draft.originalId || null,
          },
        });
        const list = await this.invoke("ai_list_skills");
        if (Array.isArray(list)) {
          this.setSkills?.(list, {
            renamedFrom: this.draft.originalId && this.draft.originalId !== saved.id
              ? this.draft.originalId
              : null,
            renamedTo: saved.id,
          });
        }
        if (pinAfter) {
          this.onTogglePinSkill?.(saved, true);
        }
        if (saved.scope === "vault" || this.draft.originalId?.startsWith("vault:")) {
          this.onVaultChanged?.();
        }
        this.mode = "list";
        this.render();
        this.onToast?.(
          pinAfter ? `Saved & pinned @${saved.slug}` : `Saved skill @${saved.slug}`
        );
      } catch (err) {
        this.onToast?.(`Failed to save skill: ${err}`, true);
      } finally {
        this.saving = false;
      }
    };

    formEl?.addEventListener("submit", (e) => {
      e.preventDefault();
      submitSave(false);
    });
    this.skillsDrawerEl.querySelector("#ai-skill-save-pin")?.addEventListener("click", () => {
      submitSave(true);
    });
  }
}
