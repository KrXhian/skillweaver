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

import { displayNameForLink, escapeHtml } from "../inline.js";
import { filterPages } from "../links.js";
import { PAGE_ICON_SVG, PAGE_LINK_ICON_SVG, SKILL_ICON_SVG } from "./edits.js";

const DEFAULT_VISIBLE_OTHERS = 6;
const DEFAULT_VISIBLE_SKILLS = 8;

export function createAiMentionLinkEl(target, label = "") {
  const span = document.createElement("span");
  span.className = "ai-inline-link";
  span.setAttribute("contenteditable", "false");
  span.dataset.target = target;
  if (label) {
    span.dataset.label = label;
  }
  span.title = target;
  span.innerHTML = `${PAGE_LINK_ICON_SVG}<span class="ai-inline-link-label">${escapeHtml(
    displayNameForLink(target, label)
  )}</span>`;
  return span;
}

export function createAiSkillChipEl(slug, skillId = "", description = "") {
  const span = document.createElement("span");
  span.className = "ai-inline-skill";
  span.setAttribute("contenteditable", "false");
  span.dataset.skillSlug = slug;
  if (skillId) {
    span.dataset.skillId = skillId;
  }
  span.title = description ? `@${slug} — ${description}` : `@${slug}`;
  span.innerHTML = `${SKILL_ICON_SVG}<span class="ai-inline-skill-label">@${escapeHtml(slug)}</span>`;
  return span;
}

export function normalizeEmptyComposer(el) {
  if (!el) return;
  if (!el.querySelector(".ai-inline-link, .ai-inline-skill")) {
    const clean = (el.textContent || "").replace(/\u200B/g, "").trim();
    if (clean === "" && el.innerHTML !== "") {
      el.innerHTML = "";
    }
  }
}

function serializeNodes(parent) {
  let out = "";
  const children = Array.from(parent.childNodes);

  for (let idx = 0; idx < children.length; idx++) {
    const node = children[idx];

    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.nodeValue || "").replace(/\u200B/g, "");
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const tag = node.tagName.toUpperCase();

    if (node.classList.contains("ai-inline-link")) {
      const target = node.dataset.target || "";
      const label = node.dataset.label || "";
      if (target) {
        out += label ? `[[${target}|${label}]]` : `[[${target}]]`;
      }
      continue;
    }

    if (node.classList.contains("ai-inline-skill")) {
      const slug = node.dataset.skillSlug || "";
      if (slug) {
        out += `@${slug}`;
      }
      continue;
    }

    if (tag === "BR") {
      if (idx === children.length - 1) {
        continue;
      }
      out += "\n";
      continue;
    }

    if (tag === "DIV" || tag === "P") {
      const inner = serializeNodes(node);
      if (out.length > 0 && !out.endsWith("\n")) {
        out += "\n";
      }
      out += inner;
      continue;
    }

    out += serializeNodes(node);
  }

  return out;
}

export function serializeComposerToPrompt(el) {
  if (!el) return "";
  return serializeNodes(el).replace(/\u200B/g, "");
}

function appendPlainWithLineBreaks(frag, str) {
  let last = null;
  const lines = str.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      last = document.createTextNode(lines[i]);
      frag.appendChild(last);
    }
    if (i < lines.length - 1) {
      last = document.createElement("br");
      frag.appendChild(last);
    }
  }
  return last;
}

export function insertPlainTextIntoComposer(el, rawText) {
  if (!el || !rawText) return;
  const normalized = String(rawText).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const frag = document.createDocumentFragment();
  const linkRegex = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
  let lastIdx = 0;
  let lastInserted = null;
  let match;

  while ((match = linkRegex.exec(normalized)) !== null) {
    if (match.index > lastIdx) {
      const plainNode = appendPlainWithLineBreaks(frag, normalized.slice(lastIdx, match.index));
      if (plainNode) lastInserted = plainNode;
    }
    const target = match[1].trim();
    const label = (match[2] || "").trim();
    if (target) {
      lastInserted = createAiMentionLinkEl(target, label);
      frag.appendChild(lastInserted);
    } else {
      const plainNode = appendPlainWithLineBreaks(frag, match[0]);
      if (plainNode) lastInserted = plainNode;
    }
    lastIdx = linkRegex.lastIndex;
  }

  if (lastIdx < normalized.length) {
    const plainNode = appendPlainWithLineBreaks(frag, normalized.slice(lastIdx));
    if (plainNode) lastInserted = plainNode;
  }

  if (!lastInserted) return;

  const sel = window.getSelection();
  let range = null;
  if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).startContainer)) {
    range = sel.getRangeAt(0);
    range.deleteContents();
  } else {
    range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
  }

  range.insertNode(frag);

  el.focus();
  const nextRange = document.createRange();
  if (lastInserted.nodeType === Node.TEXT_NODE) {
    nextRange.setStart(lastInserted, lastInserted.nodeValue.length);
  } else {
    nextRange.setStartAfter(lastInserted);
  }
  nextRange.collapse(true);
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(nextRange);
  }
}

export function handleComposerChipBackspace(el, e) {
  if (!el || e.key !== "Backspace" || e.ctrlKey || e.metaKey || e.altKey) {
    return false;
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;

  const skipEmptyPrev = (node) => {
    let cur = node;
    while (
      cur &&
      cur.nodeType === Node.TEXT_NODE &&
      (cur.nodeValue || "").replace(/\u200B/g, "") === ""
    ) {
      cur = cur.previousSibling;
    }
    return cur;
  };

  let candidate = null;
  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    const before = (range.startContainer.nodeValue || "")
      .slice(0, range.startOffset)
      .replace(/\u200B/g, "");
    if (before.length === 0) {
      candidate = skipEmptyPrev(range.startContainer.previousSibling);
    }
  } else if (range.startContainer.nodeType === Node.ELEMENT_NODE && range.startOffset > 0) {
    candidate = skipEmptyPrev(range.startContainer.childNodes[range.startOffset - 1]);
  }

  if (
    candidate?.nodeType === Node.ELEMENT_NODE &&
    (candidate.classList.contains("ai-inline-link") ||
      candidate.classList.contains("ai-inline-skill"))
  ) {
    e.preventDefault();
    candidate.remove();
    normalizeEmptyComposer(el);
    return true;
  }
  return false;
}

export function filterSkillsForMention(skills, query, pinnedSet) {
  const list = Array.isArray(skills) ? skills : [];
  const q = String(query || "").trim().toLowerCase();
  const scored = [];

  for (const s of list) {
    const slug = String(s.slug || "").toLowerCase();
    const name = String(s.name || "").toLowerCase();
    const desc = String(s.description || "").toLowerCase();
    let rank = 5;
    if (!q) {
      rank = 0;
    } else if (slug === q) {
      rank = 0;
    } else if (slug.startsWith(q)) {
      rank = 1;
    } else if (name.startsWith(q)) {
      rank = 2;
    } else if (slug.includes(q) || name.includes(q)) {
      rank = 3;
    } else if (desc.includes(q)) {
      rank = 4;
    } else {
      continue;
    }

    scored.push({
      skill: s,
      rank,
      pinned: Boolean(pinnedSet?.has(s.id)),
      scopeRank: s.scope === "vault" ? 0 : 1,
    });
  }

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.scopeRank !== b.scopeRank) return a.scopeRank - b.scopeRank;
    return String(a.skill.slug || "").localeCompare(String(b.skill.slug || ""));
  });

  return scored.map((item) => item.skill);
}

export class AiMentionPopover {
  constructor({
    inputEl,
    mentionPopoverEl,
    getPages,
    getCurrentFile,
    getSkills,
    getPinnedSkillIds,
    onPinSkill,
    onCreateSkill,
  }) {
    this.inputEl = inputEl;
    this.mentionPopoverEl = mentionPopoverEl;
    this.getPages = getPages;
    this.getCurrentFile = getCurrentFile;
    this.getSkills = getSkills;
    this.getPinnedSkillIds = getPinnedSkillIds;
    this.onPinSkill = onPinSkill;
    this.onCreateSkill = onCreateSkill;

    this.state = {
      active: false,
      mode: "page",
      textNode: null,
      matchStart: 0,
      matchEnd: 0,
      query: "",
      currentPage: null,
      otherItems: [],
      allOthers: [],
      hiddenCount: 0,
      expanded: false,
      items: [],
      selectedIndex: 0,
    };

    document.addEventListener("mousedown", (e) => {
      if (
        this.state.active &&
        this.mentionPopoverEl &&
        !this.mentionPopoverEl.contains(e.target) &&
        !this.inputEl.contains(e.target)
      ) {
        this.close();
      }
    });
  }

  isActive() {
    return this.state.active;
  }

  close() {
    this.state = {
      active: false,
      mode: "page",
      textNode: null,
      matchStart: 0,
      matchEnd: 0,
      query: "",
      currentPage: null,
      otherItems: [],
      allOthers: [],
      hiddenCount: 0,
      expanded: false,
      items: [],
      selectedIndex: 0,
    };
    if (this.mentionPopoverEl) {
      this.mentionPopoverEl.hidden = true;
      this.mentionPopoverEl.innerHTML = "";
    }
  }

  inspectCaret() {
    if (!this.mentionPopoverEl || !this.inputEl) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
      this.close();
      return;
    }

    const range = sel.getRangeAt(0);
    if (
      !this.inputEl.contains(range.startContainer) ||
      range.startContainer.nodeType !== Node.TEXT_NODE
    ) {
      this.close();
      return;
    }
    if (range.startContainer.parentElement?.closest(".ai-inline-link, .ai-inline-skill")) {
      this.close();
      return;
    }

    const textNode = range.startContainer;
    const offset = range.startOffset;
    const before = (textNode.nodeValue || "").slice(0, offset);

    // 1. Check @@ page mention first
    const pageMatch = before.match(/(@@([^\n@]*))$/);
    if (pageMatch) {
      const query = pageMatch[2];
      const matchStart = before.length - pageMatch[1].length;
      const pages = this.getPages?.() || [];
      const currentFile = String(this.getCurrentFile?.() || "");
      const curLower = currentFile.toLowerCase();
      const curPage = curLower
        ? pages.find((p) => (p.rel_path || "").toLowerCase() === curLower) || null
        : null;

      const allMatches = filterPages(pages, query, Infinity);
      const showCurrent = Boolean(
        curPage && (!query.trim() || allMatches.some((p) => p.rel_path === curPage.rel_path))
      );
      const allOthers = curPage
        ? allMatches.filter((p) => p.rel_path !== curPage.rel_path)
        : allMatches;

      const sameQuery =
        this.state.active && this.state.mode === "page" && this.state.query === query;
      const expanded = sameQuery ? this.state.expanded : false;
      const visibleOthers = expanded ? allOthers : allOthers.slice(0, DEFAULT_VISIBLE_OTHERS);
      const hiddenCount = Math.max(0, allOthers.length - visibleOthers.length);
      const items = [...(showCurrent ? [curPage] : []), ...visibleOthers];
      const selectedIndex = sameQuery
        ? Math.min(this.state.selectedIndex, Math.max(0, items.length - 1))
        : 0;

      this.state = {
        active: true,
        mode: "page",
        textNode,
        matchStart,
        matchEnd: offset,
        query,
        currentPage: showCurrent ? curPage : null,
        otherItems: visibleOthers,
        allOthers,
        hiddenCount,
        expanded,
        items,
        selectedIndex,
      };
      this.render();
      return;
    }

    // 2. Otherwise check single @ skill mention (preceded by start, whitespace, '(', or '[')
    const skillMatch = before.match(/(?:^|[\s(\[])(@([a-zA-Z0-9_-]*))$/);
    if (skillMatch) {
      const query = skillMatch[2];
      const matchStart = before.length - skillMatch[1].length;
      const skills = this.getSkills?.() || [];
      const pinnedSet = new Set(this.getPinnedSkillIds?.() || []);
      const allMatched = filterSkillsForMention(skills, query, pinnedSet);

      const sameQuery =
        this.state.active && this.state.mode === "skill" && this.state.query === query;
      const expanded = sameQuery ? this.state.expanded : false;
      const items = expanded ? allMatched : allMatched.slice(0, DEFAULT_VISIBLE_SKILLS);
      const hiddenCount = Math.max(0, allMatched.length - items.length);
      const selectedIndex = sameQuery
        ? Math.min(this.state.selectedIndex, Math.max(0, items.length - 1))
        : 0;

      this.state = {
        active: true,
        mode: "skill",
        textNode,
        matchStart,
        matchEnd: offset,
        query,
        currentPage: null,
        otherItems: items,
        allOthers: allMatched,
        hiddenCount,
        expanded,
        items,
        selectedIndex,
      };
      this.render();
      return;
    }

    this.close();
  }

  handleKeydown(e) {
    if (!this.state.active) return false;

    if (e.key === "ArrowDown") {
      if (this.state.items.length > 0) {
        e.preventDefault();
        this.state.selectedIndex = (this.state.selectedIndex + 1) % this.state.items.length;
        this.render();
      }
      return true;
    }
    if (e.key === "ArrowUp") {
      if (this.state.items.length > 0) {
        e.preventDefault();
        this.state.selectedIndex =
          (this.state.selectedIndex - 1 + this.state.items.length) % this.state.items.length;
        this.render();
      }
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (this.state.items.length > 0) {
        e.preventDefault();
        this.commit(this.state.items[this.state.selectedIndex]);
        return true;
      }
      return false;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return true;
    }
    return false;
  }

  render() {
    if (!this.mentionPopoverEl) return;
    if (this.state.mode === "skill") {
      this.renderSkillPopover();
    } else {
      this.renderPagePopover();
    }
  }

  renderPagePopover() {
    const { currentPage, otherItems, hiddenCount, items, selectedIndex } = this.state;

    if (!items.length) {
      this.mentionPopoverEl.innerHTML = `<div class="popover-section-label">No matching notes</div>`;
      this.mentionPopoverEl.hidden = false;
      return;
    }

    const renderRow = (page, flatIdx, showFolder = true) => {
      const selClass = flatIdx === selectedIndex ? " selected" : "";
      const folderHtml =
        showFolder && page.folder
          ? `<span class="ai-mention-folder">${escapeHtml(page.folder)}</span>`
          : "";
      return `
        <button class="popover-item ai-mention-row${selClass}" data-idx="${flatIdx}" type="button" role="option">
          ${PAGE_ICON_SVG}
          <span class="ai-mention-text">
            <span class="ai-mention-title">${escapeHtml(page.title)}</span>
            ${folderHtml}
          </span>
        </button>
      `;
    };

    const htmlParts = [];
    if (currentPage) {
      htmlParts.push(`<div class="ai-mention-section">Current page</div>`);
      htmlParts.push(renderRow(currentPage, 0, Boolean(currentPage.folder)));
    }
    if (currentPage && otherItems.length > 0) {
      htmlParts.push(`<div class="popover-divider"></div>`);
    }
    if (otherItems.length > 0) {
      htmlParts.push(`<div class="ai-mention-section">Link to page</div>`);
      const baseOffset = currentPage ? 1 : 0;
      otherItems.forEach((page, i) => {
        htmlParts.push(renderRow(page, baseOffset + i, true));
      });
    }
    if (hiddenCount > 0) {
      htmlParts.push(
        `<button class="ai-mention-more" data-expand-more="1" type="button"><span class="ai-mention-more-dots">···</span><span>${hiddenCount} more result${hiddenCount === 1 ? "" : "s"}</span></button>`
      );
    }

    this.mentionPopoverEl.innerHTML = htmlParts.join("");
    this.mentionPopoverEl.hidden = false;

    const selEl = this.mentionPopoverEl.querySelector(".ai-mention-row.selected");
    selEl?.scrollIntoView({ block: "nearest" });

    this.mentionPopoverEl.querySelectorAll(".ai-mention-row").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const item = this.state.items[Number(btn.dataset.idx)];
        if (item) this.commit(item);
      });
    });

    this.mentionPopoverEl.querySelector("[data-expand-more]")?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.state.expanded = true;
      this.state.otherItems = this.state.allOthers;
      this.state.hiddenCount = 0;
      this.state.items = [
        ...(this.state.currentPage ? [this.state.currentPage] : []),
        ...this.state.otherItems,
      ];
      this.render();
    });
  }

  renderSkillPopover() {
    const { items, hiddenCount, selectedIndex, query } = this.state;
    const pinnedSet = new Set(this.getPinnedSkillIds?.() || []);
    const htmlParts = [];

    if (items.length > 0) {
      htmlParts.push(`<div class="ai-mention-section">${query ? "Matching skills" : "Skills"}</div>`);
      items.forEach((skill, idx) => {
        const selClass = idx === selectedIndex ? " selected" : "";
        const isPinned = pinnedSet.has(skill.id);
        const scopeLabel = skill.scope === "global" ? "Global" : "Vault";
        const descHtml = skill.description
          ? `<span class="ai-mention-folder">${escapeHtml(skill.description)}</span>`
          : "";
        htmlParts.push(`
          <div class="ai-mention-skill-wrap${selClass}">
            <button class="popover-item ai-mention-row ai-mention-skill-row" data-idx="${idx}" type="button" role="option">
              ${SKILL_ICON_SVG}
              <span class="ai-mention-text">
                <span class="ai-mention-title-row">
                  <span class="ai-mention-title">@${escapeHtml(skill.slug)}</span>
                  <span class="ai-skill-scope">${scopeLabel}</span>
                </span>
                ${descHtml}
              </span>
            </button>
            <button class="ai-mention-pin-btn${isPinned ? " pinned" : ""}" data-pin-idx="${idx}" type="button" title="${isPinned ? "Unpin skill from chat" : "Pin skill to conversation bar"}">📌</button>
          </div>
        `);
      });

      if (hiddenCount > 0) {
        htmlParts.push(
          `<button class="ai-mention-more" data-expand-more="1" type="button"><span class="ai-mention-more-dots">···</span><span>${hiddenCount} more skill${hiddenCount === 1 ? "" : "s"}</span></button>`
        );
      }
      htmlParts.push(`<div class="popover-divider"></div>`);
    } else {
      htmlParts.push(`<div class="popover-section-label">${query ? `No skill matching "@${escapeHtml(query)}"` : "No skills saved yet"}</div>`);
    }

    const createLabel = query.trim() ? `+ Create skill "@${escapeHtml(query.trim())}"` : "+ Create new skill…";
    htmlParts.push(
      `<button class="ai-mention-create-row" data-create-skill="1" type="button">${createLabel}</button>`
    );
    htmlParts.push(
      `<div class="ai-mention-footer">Enter to inject · 📌 pin for whole chat · Type <code>@@</code> for pages</div>`
    );

    this.mentionPopoverEl.innerHTML = htmlParts.join("");
    this.mentionPopoverEl.hidden = false;

    const selEl = this.mentionPopoverEl.querySelector(".ai-mention-skill-wrap.selected");
    selEl?.scrollIntoView({ block: "nearest" });

    this.mentionPopoverEl.querySelectorAll(".ai-mention-skill-row").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const item = this.state.items[Number(btn.dataset.idx)];
        if (item) this.commit(item);
      });
    });

    this.mentionPopoverEl.querySelectorAll("[data-pin-idx]").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const item = this.state.items[Number(btn.dataset.pinIdx)];
        if (item) {
          this.removeActiveTriggerText();
          this.onPinSkill?.(item);
        }
      });
    });

    this.mentionPopoverEl.querySelector("[data-expand-more]")?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.state.expanded = true;
      this.state.items = this.state.allOthers;
      this.state.hiddenCount = 0;
      this.render();
    });

    this.mentionPopoverEl.querySelector("[data-create-skill]")?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const draftQuery = this.state.query || "";
      this.removeActiveTriggerText();
      this.onCreateSkill?.(draftQuery);
    });
  }

  removeActiveTriggerText() {
    const { textNode, matchStart, matchEnd } = this.state;
    if (!textNode || !textNode.isConnected) {
      this.close();
      return;
    }

    const full = textNode.nodeValue || "";
    const prefix = full.slice(0, matchStart);
    const suffix = full.slice(matchEnd);
    const nextText = prefix + suffix;
    const parent = textNode.parentNode;

    if (nextText) {
      textNode.nodeValue = nextText;
      this.inputEl.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.setStart(textNode, prefix.length);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else {
      const sibling = textNode.previousSibling;
      parent.removeChild(textNode);
      normalizeEmptyComposer(this.inputEl);
      this.inputEl.focus();
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        if (sibling) {
          range.setStartAfter(sibling);
        } else {
          range.selectNodeContents(this.inputEl);
          range.collapse(false);
        }
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    this.close();
  }

  commit(item) {
    if (!item) {
      this.close();
      return;
    }
    const { textNode, matchStart, matchEnd, mode } = this.state;
    if (!textNode || !textNode.isConnected) {
      this.close();
      return;
    }

    const full = textNode.nodeValue || "";
    const prefix = full.slice(0, matchStart);
    const suffix = full.slice(matchEnd);

    const chip =
      mode === "skill"
        ? createAiSkillChipEl(item.slug, item.id, item.description || "")
        : createAiMentionLinkEl(item.link_target, "");
    const parent = textNode.parentNode;

    if (prefix) {
      parent.insertBefore(document.createTextNode(prefix), textNode);
    }
    parent.insertBefore(chip, textNode);

    const trailingText = suffix.startsWith(" ") ? suffix : ` ${suffix}`;
    const afterNode = document.createTextNode(trailingText);
    parent.insertBefore(afterNode, textNode);
    parent.removeChild(textNode);

    this.inputEl.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.setStart(afterNode, 1);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    this.close();
  }
}
