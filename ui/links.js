import { createPageLinkElement, escapeHtml } from "./inline.js";

/**
 * Ranks vault pages by relevance to `query` (exact/prefix title > substring title > path).
 */
export function filterPages(pages, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    return pages.slice(0, 20);
  }

  const scored = [];
  for (const page of pages) {
    const title = page.title.toLowerCase();
    const rel = page.rel_path.toLowerCase();
    let score = -1;

    if (title === q) score = 100;
    else if (title.startsWith(q)) score = 80;
    else if (title.includes(q)) score = 60;
    else if (rel.includes(q)) score = 40;
    else if (fuzzyMatch(q, rel)) score = 20;

    if (score >= 0) {
      scored.push({ page, score });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.page.rel_path.localeCompare(b.page.rel_path);
  });

  return scored.slice(0, 20).map((s) => s.page);
}

function fuzzyMatch(needle, haystack) {
  let ni = 0;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    if (haystack[hi] === needle[ni]) ni += 1;
  }
  return ni === needle.length;
}

function clampPopoverPosition(popoverEl, rect) {
  const pad = 8;
  const popRect = popoverEl.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 6;

  if (left + popRect.width > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - popRect.width - pad);
  }
  if (top + popRect.height > window.innerHeight - pad) {
    top = Math.max(pad, rect.top - popRect.height - 6);
  }
  popoverEl.style.left = `${Math.max(pad, left)}px`;
  popoverEl.style.top = `${Math.max(pad, top)}px`;
}

/**
 * Caret-anchored `@@` page link autocomplete controller.
 */
export class LinkAutocomplete {
  constructor(popoverEl, { getPages, onCreatePage, onInserted }) {
    this.popoverEl = popoverEl;
    this.getPages = getPages;
    this.onCreatePage = onCreatePage;
    this.onInserted = onInserted;

    this.active = false;
    this.selectedIndex = 0;
    this.items = [];
    this.context = null; // { editableEl, textNode, matchStart, matchEnd, query }

    document.addEventListener("mousedown", (e) => {
      if (this.active && !this.popoverEl.contains(e.target)) {
        this.close();
      }
    });
  }

  isOpen() {
    return this.active;
  }

  close() {
    this.active = false;
    this.context = null;
    this.items = [];
    this.popoverEl.hidden = true;
    this.popoverEl.innerHTML = "";
  }

  inspectCaret(editableEl) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
      this.close();
      return;
    }

    const range = sel.getRangeAt(0);
    if (!editableEl.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) {
      this.close();
      return;
    }
    if (range.startContainer.parentElement?.closest("code, .page-link")) {
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
    const pages = this.getPages();
    const matches = filterPages(pages, query);

    const items = matches.map((p) => ({
      kind: "page",
      page: p,
    }));

    const trimmedQuery = query.trim();
    if (trimmedQuery.length > 0) {
      const exactExists = pages.some(
        (p) =>
          p.title.toLowerCase() === trimmedQuery.toLowerCase() ||
          p.link_target.toLowerCase() === trimmedQuery.toLowerCase()
      );
      if (!exactExists) {
        items.push({
          kind: "create",
          query: trimmedQuery,
        });
      }
    }

    this.context = {
      editableEl,
      textNode,
      matchStart,
      matchEnd: offset,
      query,
    };
    this.items = items;
    this.selectedIndex = 0;
    this.active = true;

    this.render(range);
  }

  render(caretRange) {
    if (!this.items.length) {
      this.popoverEl.innerHTML = `<div class="popover-section-label">No matching .md pages</div>`;
    } else {
      this.popoverEl.innerHTML = this.items
        .map((item, idx) => {
          const selClass = idx === this.selectedIndex ? " selected" : "";
          if (item.kind === "create") {
            return `
              <button class="popover-item${selClass}" data-idx="${idx}" role="option">
                <span class="popover-item-main">
                  <span class="popover-item-title">+ Create "${escapeHtml(item.query)}.md"</span>
                </span>
                <span class="popover-item-sub">New page</span>
              </button>
            `;
          }
          const sub = item.page.folder || "root";
          return `
            <button class="popover-item${selClass}" data-idx="${idx}" role="option">
              <span class="popover-item-main">
                <span class="popover-item-title">${escapeHtml(item.page.title)}</span>
              </span>
              <span class="popover-item-sub">${escapeHtml(sub)}</span>
            </button>
          `;
        })
        .join("");
    }

    this.popoverEl.hidden = false;

    if (caretRange) {
      const rect = caretRange.getBoundingClientRect();
      const fallbackRect =
        rect.width === 0 && rect.height === 0
          ? this.context.editableEl.getBoundingClientRect()
          : rect;
      clampPopoverPosition(this.popoverEl, fallbackRect);
    }

    this.popoverEl.querySelectorAll(".popover-item").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const idx = Number(btn.dataset.idx);
        this.commitItem(idx);
      });
    });
  }

  handleKeyDown(e) {
    if (!this.active) return false;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (this.items.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.items.length;
        this.render(null);
      }
      return true;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (this.items.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + this.items.length) % this.items.length;
        this.render(null);
      }
      return true;
    }

    if (e.key === "Enter" || e.key === "Tab") {
      if (this.items.length > 0) {
        e.preventDefault();
        this.commitItem(this.selectedIndex);
        return true;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return true;
    }

    return false;
  }

  async commitItem(idx) {
    const item = this.items[idx];
    const ctx = this.context;
    if (!item || !ctx) {
      this.close();
      return;
    }

    this.close();

    let target = "";
    if (item.kind === "create") {
      const createdRel = await this.onCreatePage(item.query);
      if (!createdRel) return;
      target = createdRel.replace(/\.md$/i, "");
    } else {
      target = item.page.link_target;
    }

    this.insertLinkPill(ctx, target);
  }

  insertLinkPill(ctx, target) {
    const { editableEl, textNode, matchStart, matchEnd } = ctx;
    if (!textNode.isConnected) return;

    const full = textNode.nodeValue || "";
    const prefix = full.slice(0, matchStart);
    const suffix = full.slice(matchEnd);

    const pill = createPageLinkElement(target, "", true);
    const parent = textNode.parentNode;

    if (prefix) {
      parent.insertBefore(document.createTextNode(prefix), textNode);
    }
    parent.insertBefore(pill, textNode);

    const trailingText = suffix.startsWith(" ") ? suffix : ` ${suffix}`;
    const afterNode = document.createTextNode(trailingText);
    parent.insertBefore(afterNode, textNode);
    parent.removeChild(textNode);

    editableEl.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(afterNode, 1);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);

    this.onInserted(editableEl);
  }
}

/**
 * VS Code / Obsidian-style Ctrl+P quick switcher modal.
 */
export class QuickSwitcher {
  constructor(backdropEl, inputEl, listEl, { getPages, onSelect }) {
    this.backdropEl = backdropEl;
    this.inputEl = inputEl;
    this.listEl = listEl;
    this.getPages = getPages;
    this.onSelect = onSelect;
    this.selectedIndex = 0;
    this.filtered = [];

    this.backdropEl.addEventListener("mousedown", (e) => {
      if (e.target === this.backdropEl) this.close();
    });

    this.inputEl.addEventListener("input", () => {
      this.selectedIndex = 0;
      this.updateList();
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (this.filtered.length) {
          this.selectedIndex = (this.selectedIndex + 1) % this.filtered.length;
          this.renderList();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (this.filtered.length) {
          this.selectedIndex = (this.selectedIndex - 1 + this.filtered.length) % this.filtered.length;
          this.renderList();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const chosen = this.filtered[this.selectedIndex];
        if (chosen) {
          this.close();
          this.onSelect(chosen.rel_path);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
  }

  open() {
    this.inputEl.value = "";
    this.selectedIndex = 0;
    this.backdropEl.hidden = false;
    this.updateList();
    this.inputEl.focus();
  }

  close() {
    this.backdropEl.hidden = true;
  }

  isOpen() {
    return !this.backdropEl.hidden;
  }

  updateList() {
    this.filtered = filterPages(this.getPages(), this.inputEl.value);
    this.renderList();
  }

  renderList() {
    if (!this.filtered.length) {
      this.listEl.innerHTML = `<div class="popover-section-label">No matching notes</div>`;
      return;
    }

    this.listEl.innerHTML = this.filtered
      .map((page, idx) => {
        const cls = idx === this.selectedIndex ? " selected" : "";
        const sub = page.folder || "root";
        return `
          <button class="popover-item${cls}" data-idx="${idx}" role="option">
            <span class="popover-item-main">
              <span class="popover-item-title">${escapeHtml(page.title)}</span>
            </span>
            <span class="popover-item-sub">${escapeHtml(sub)}</span>
          </button>
        `;
      })
      .join("");

    this.listEl.querySelectorAll(".popover-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        const chosen = this.filtered[idx];
        if (chosen) {
          this.close();
          this.onSelect(chosen.rel_path);
        }
      });
    });
  }
}
