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
import { extractBlocksMetrics } from "./metrics.js";

export function stripMarkdownForOutline(text) {
  return String(text || "")
    .replace(/\u200B/g, "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<span\b[^>]*>([\s\S]*?)<\/span>/gi, "$1")
    .replace(/\s+\^[A-Za-z0-9-]+$/g, "")
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2")
    .replace(/\[\[([^\]\n]+)\]\]/g, (_, inner) => {
      const clean = inner.split("#")[0].split("/").pop() || inner;
      return clean;
    })
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/==([^=\n]+)==/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts visible outline headings synced with Skillweaver's heading fold hierarchy.
 */
export function extractOutlineEntries(blocks = [], collapsedIds = null) {
  const list = Array.isArray(blocks) ? blocks : [];
  const entries = [];
  const stack = []; // { id, level, collapsed }

  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b || b.type !== "heading") continue;

    const level = Math.min(6, Math.max(1, Number(b.level) || 1));
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const hiddenByParent = stack.some((anc) => anc.collapsed);
    const depth = Math.min(3, stack.length);
    const isCollapsed = Boolean(collapsedIds && collapsedIds.has(b.id));

    let hasChildren = false;
    for (let j = i + 1; j < list.length; j++) {
      const sub = list[j];
      if (!sub) continue;
      if (sub.type === "heading" && (Math.min(6, Math.max(1, Number(sub.level) || 1))) <= level) {
        break;
      }
      hasChildren = true;
      break;
    }

    entries.push({
      idx: i,
      id: b.id,
      level,
      depth,
      text: stripMarkdownForOutline(b.content || "") || "Untitled section",
      collapsed: isCollapsed,
      hasChildren,
      hiddenByParent,
    });

    stack.push({ id: b.id, level, collapsed: isCollapsed });
  }

  return entries;
}

/**
 * Collapsible Google Colab-style left outline drawer synced two-way with editor headings.
 */
export class DocOutline {
  constructor({ toggleBtn, panelEl, scrollEl, blocksContainerEl }, callbacks = {}) {
    this.toggleBtn = toggleBtn;
    this.panelEl = panelEl;
    this.scrollEl = scrollEl;
    this.blocksContainerEl = blocksContainerEl;

    this.getBlocks = callbacks.getBlocks || (() => []);
    this.getCollapsedIds = callbacks.getCollapsedIds || (() => new Set());
    this.onJumpToBlock = callbacks.onJumpToBlock || (() => {});
    this.onToggleHeadingCollapse = callbacks.onToggleHeadingCollapse || (() => {});

    this.visible = false;
    this.isPanelOpen = false;
    this.entries = [];
    this.visibleEntries = [];
    this.activeHeadingId = null;
    this._scrollRaf = null;
    this._refreshTimer = null;

    this.toggleBtn?.addEventListener("click", () => this.toggle());
    this.scrollEl?.addEventListener(
      "scroll",
      () => {
        if (this.visible && this.isPanelOpen) {
          this.scheduleActiveUpdate();
        }
      },
      { passive: true }
    );
  }

  toggle(forceState = null) {
    this.isPanelOpen = forceState === null ? !this.isPanelOpen : Boolean(forceState);
    if (!this.isPanelOpen) {
      clearTimeout(this._refreshTimer);
    }
    this.syncVisibility();
    if (this.visible && this.isPanelOpen) {
      this.refresh();
    }
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (!this.visible) {
      clearTimeout(this._refreshTimer);
    }
    this.syncVisibility();
    if (this.visible && this.isPanelOpen) {
      this.refresh();
    }
  }

  syncVisibility() {
    if (!this.visible) {
      if (this.toggleBtn) this.toggleBtn.hidden = true;
      if (this.panelEl) this.panelEl.hidden = true;
      return;
    }
    if (this.toggleBtn) this.toggleBtn.hidden = this.isPanelOpen;
    if (this.panelEl) this.panelEl.hidden = !this.isPanelOpen;
  }

  scheduleRefresh(delayMs = 180) {
    if (!this.visible || !this.isPanelOpen) return;
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this.refresh();
    }, delayMs);
  }

  refresh() {
    if (!this.visible || !this.isPanelOpen || !this.panelEl) return;

    const blocks = this.getBlocks();
    const collapsedIds = this.getCollapsedIds();
    this.entries = extractOutlineEntries(blocks, collapsedIds);
    this.visibleEntries = this.entries.filter((e) => !e.hiddenByParent);

    const metrics = extractBlocksMetrics(blocks);
    const metaText =
      metrics.tokens > 0
        ? `${metrics.words.toLocaleString()} words · ~${metrics.tokens.toLocaleString()} tok · ${metrics.readMins} min`
        : `${metrics.words.toLocaleString()} words`;

    const listHtml = this.visibleEntries.length
      ? this.visibleEntries
          .map((h) => {
            const isActive = h.id === this.activeHeadingId;
            const chevHtml = h.hasChildren
              ? `<button type="button" class="doc-outline-chev${h.collapsed ? " collapsed" : ""}" data-outline-fold="${escapeHtml(
                  h.id
                )}" title="${h.collapsed ? "Expand section" : "Collapse section"}" aria-label="${
                  h.collapsed ? "Expand section" : "Collapse section"
                }"><svg viewBox="0 0 12 12" fill="currentColor"><path d="M2.5 4L6 8L9.5 4z"/></svg></button>`
              : '<span class="doc-outline-chev-spacer" aria-hidden="true"></span>';

            return `
              <div class="doc-outline-row${isActive ? " active" : ""}" data-outline-id="${escapeHtml(
                h.id
              )}" style="padding-left: ${6 + h.depth * 14}px">
                ${chevHtml}
                <button type="button" class="doc-outline-item" data-outline-jump="${h.idx}" title="${escapeHtml(
                  h.text
                )}">
                  <span class="doc-outline-item-dot" aria-hidden="true"></span>
                  <span class="doc-outline-item-text">${escapeHtml(h.text)}</span>
                </button>
              </div>
            `;
          })
          .join("")
      : '<div class="doc-outline-empty">No headings yet &mdash; type <code># Title</code> to add sections.</div>';

    this.panelEl.innerHTML = `
      <div class="doc-outline-header">
        <div class="doc-outline-header-left">
          <button type="button" class="doc-outline-collapse-btn" data-outline-close="1" title="Hide Document Outline (Ctrl+Shift+O)" aria-label="Hide Document Outline">
            <svg class="icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <circle cx="3.5" cy="5" r="1" fill="currentColor" stroke="none"/>
              <path d="M7 5h8"/>
              <path d="M7 9h7"/>
              <path d="M7 13h5.5"/>
            </svg>
          </button>
          <span class="doc-outline-label">OUTLINE</span>
          <span class="doc-outline-count">${this.entries.length}</span>
        </div>
      </div>
      <div class="doc-outline-list">${listHtml}</div>
      <div class="doc-outline-footer">${escapeHtml(metaText)}</div>
    `;

    this.panelEl.querySelector("[data-outline-close]")?.addEventListener("click", () => {
      this.toggle(false);
    });

    this.panelEl.querySelectorAll("[data-outline-fold]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const blockId = btn.dataset.outlineFold;
        if (blockId) this.onToggleHeadingCollapse(blockId);
      });
    });

    this.panelEl.querySelectorAll("[data-outline-jump]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.outlineJump);
        const row = btn.closest("[data-outline-id]");
        if (row?.dataset.outlineId) {
          this.activeHeadingId = row.dataset.outlineId;
          this.syncActiveClasses();
        }
        if (Number.isFinite(idx)) {
          this.onJumpToBlock(idx);
        }
      });
    });

    this.updateActiveSection();
  }

  scheduleActiveUpdate() {
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = null;
      this.updateActiveSection();
    });
  }

  updateActiveSection() {
    if (!this.visible || !this.isPanelOpen || !this.visibleEntries.length) return;
    if (!this.scrollEl || !this.blocksContainerEl) return;

    const scrollTopLine = this.scrollEl.getBoundingClientRect().top + 96;
    let bestId = this.visibleEntries[0]?.id || null;

    for (let i = 0; i < this.visibleEntries.length; i++) {
      const entry = this.visibleEntries[i];
      const row = this.blocksContainerEl.querySelector(`.block-row[data-id="${CSS.escape(entry.id)}"]`);
      if (!row) continue;
      if (row.getBoundingClientRect().top <= scrollTopLine) {
        bestId = entry.id;
      } else {
        break;
      }
    }

    if (bestId !== this.activeHeadingId) {
      this.activeHeadingId = bestId;
      this.syncActiveClasses();
    }
  }

  syncActiveClasses() {
    this.panelEl?.querySelectorAll("[data-outline-id]").forEach((row) => {
      row.classList.toggle("active", row.dataset.outlineId === this.activeHeadingId);
    });
  }
}
