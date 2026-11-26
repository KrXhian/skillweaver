import { displayNameForLink, escapeHtml } from "../inline.js";
import { filterPages } from "../links.js";
import { PAGE_ICON_SVG, PAGE_LINK_ICON_SVG } from "./edits.js";

const DEFAULT_VISIBLE_OTHERS = 6;

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

export function normalizeEmptyComposer(el) {
  if (!el) return;
  if (!el.querySelector(".ai-inline-link")) {
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

  if (candidate?.nodeType === Node.ELEMENT_NODE && candidate.classList.contains("ai-inline-link")) {
    e.preventDefault();
    candidate.remove();
    normalizeEmptyComposer(el);
    return true;
  }
  return false;
}

export class AiMentionPopover {
  constructor({ inputEl, mentionPopoverEl, getPages, getCurrentFile }) {
    this.inputEl = inputEl;
    this.mentionPopoverEl = mentionPopoverEl;
    this.getPages = getPages;
    this.getCurrentFile = getCurrentFile;

    this.state = {
      active: false,
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
    this.state.active = false;
    this.state.textNode = null;
    this.state.currentPage = null;
    this.state.otherItems = [];
    this.state.allOthers = [];
    this.state.hiddenCount = 0;
    this.state.expanded = false;
    this.state.items = [];
    this.state.selectedIndex = 0;
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
    if (range.startContainer.parentElement?.closest(".ai-inline-link")) {
      this.close();
      return;
    }

    const textNode = range.startContainer;
    const offset = range.startOffset;
    const before = (textNode.nodeValue || "").slice(0, offset);
    const match = before.match(/(@@([^\n@]*))$/);
    if (!match) {
      this.close();
      return;
    }

    const query = match[2];
    const matchStart = before.length - match[1].length;
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

    const sameQuery = this.state.active && this.state.query === query;
    const expanded = sameQuery ? this.state.expanded : false;
    const visibleOthers = expanded ? allOthers : allOthers.slice(0, DEFAULT_VISIBLE_OTHERS);
    const hiddenCount = Math.max(0, allOthers.length - visibleOthers.length);
    const items = [...(showCurrent ? [curPage] : []), ...visibleOthers];
    const selectedIndex = sameQuery
      ? Math.min(this.state.selectedIndex, Math.max(0, items.length - 1))
      : 0;

    this.state = {
      active: true,
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

  commit(page) {
    const { textNode, matchStart, matchEnd } = this.state;
    if (!page || !textNode || !textNode.isConnected) {
      this.close();
      return;
    }

    const full = textNode.nodeValue || "";
    const prefix = full.slice(0, matchStart);
    const suffix = full.slice(matchEnd);

    const chip = createAiMentionLinkEl(page.link_target, "");
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
