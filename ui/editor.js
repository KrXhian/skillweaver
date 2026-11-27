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

import { highlightCode } from "./highlight.js";
import {
  buildPageLookup,
  domToInlineMarkdown,
  escapeHtml,
  inlineMarkdownToHtml,
  isValidColorName,
  tryAutoFormatInline,
} from "./inline.js";
import { LinkAutocomplete } from "./links.js";

const COLOR_OPTIONS = [
  { id: "default", label: "Default" },
  { id: "gray", label: "Gray" },
  { id: "brown", label: "Brown" },
  { id: "orange", label: "Orange" },
  { id: "yellow", label: "Yellow" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "pink", label: "Pink" },
  { id: "red", label: "Red" },
];

const LAST_COLOR_STORAGE_KEY = "skillweaver.lastColor";

function loadLastUsedColor() {
  try {
    const raw = localStorage.getItem(LAST_COLOR_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        (parsed.kind === "text" || parsed.kind === "bg") &&
        isValidColorName(parsed.value)
      ) {
        return parsed;
      }
    }
  } catch {
    // Ignore storage error
  }
  return { kind: "bg", value: "yellow" };
}

function getColorDisplayLabel(kind, value) {
  const opt = COLOR_OPTIONS.find((o) => o.id === value);
  const name = opt ? opt.label : "Default";
  return kind === "text" ? `${name} text` : `${name} background`;
}

function createInlineColorSpan(color, bg) {
  const span = document.createElement("span");
  updateInlineColorSpanAttrs(span, color, bg);
  return span;
}

function updateInlineColorSpanAttrs(span, color, bg) {
  const c = isValidColorName(color) ? color : "";
  const b = isValidColorName(bg) ? bg : "";
  span.className = `sw-inline-color${c ? ` sw-color-${c}` : ""}${b ? ` sw-bg-${b}` : ""}`;
  if (c) span.dataset.color = c;
  else delete span.dataset.color;
  if (b) span.dataset.bg = b;
  else delete span.dataset.bg;
}

const CODE_LANGUAGES = [
  "text",
  "javascript",
  "typescript",
  "python",
  "rust",
  "html",
  "css",
  "json",
  "yaml",
  "toml",
  "bash",
  "powershell",
  "sql",
  "go",
  "c",
  "cpp",
  "java",
  "csharp",
  "docker",
  "diff",
  "markdown",
];

const SLASH_ITEMS = [
  { id: "paragraph", label: "Text", hint: "Plain text block" },
  { id: "h1", label: "Heading 1", hint: "# Collapsible header" },
  { id: "h2", label: "Heading 2", hint: "## Collapsible header" },
  { id: "h3", label: "Heading 3", hint: "### Collapsible header" },
  { id: "bullet_list", label: "Bullet List", hint: "- List item" },
  { id: "numbered_list", label: "Numbered List", hint: "1. List item" },
  { id: "todo", label: "To-do Checklist", hint: "- [ ] Task checkbox" },
  { id: "quote", label: "Quote", hint: "> Blockquote" },
  { id: "divider", label: "Divider", hint: "--- Horizontal rule" },
  { id: "code", label: "Code Block", hint: "``` Fenced code" },
  { id: "table", label: "Table", hint: "/table or | A | B |" },
];

const INDENT_STEP_PX = 26;
const TABLE_COL_DRAG_STEP_PX = 80;
const TABLE_ROW_DRAG_STEP_PX = 34;
const TABLE_MIN_COL_WIDTH = 64;
const TABLE_MAX_COL_WIDTH = 900;
const TABLE_DEFAULT_COL_WIDTH = 160;

let localIdSeq = 1;
function genBlockId() {
  localIdSeq += 1;
  return `blk-${Date.now().toString(36)}-${localIdSeq}`;
}

function cloneBlock(b) {
  if (!b) return b;
  if (b.type === "table") {
    return {
      ...b,
      alignments: Array.isArray(b.alignments) ? b.alignments.slice() : [],
      col_widths: Array.isArray(b.col_widths) ? b.col_widths.slice() : [],
      rows: Array.isArray(b.rows) ? b.rows.map((r) => (Array.isArray(r) ? r.slice() : [])) : [],
    };
  }
  return { ...b };
}

function cloneBlocks(blocks) {
  return blocks.map(cloneBlock);
}

function createEmptyTableBlock(id, cols = 3, rows = 2) {
  const c = Math.min(12, Math.max(1, Number(cols) || 3));
  const r = Math.min(30, Math.max(1, Number(rows) || 2));
  return {
    id,
    type: "table",
    alignments: Array(c).fill(""),
    col_widths: [],
    rows: Array.from({ length: r }, () => Array(c).fill("")),
  };
}

function normalizeTableData(rawRows, rawAlignments = [], rawColWidths = []) {
  const safeRows = Array.isArray(rawRows) && rawRows.length ? rawRows : [["", "", ""], ["", "", ""]];
  const colCount = Math.max(
    1,
    Array.isArray(rawAlignments) ? rawAlignments.length : 0,
    ...safeRows.map((r) => (Array.isArray(r) ? r.length : 0))
  );
  const alignments = Array.from({ length: colCount }, (_, c) => {
    const a = rawAlignments?.[c];
    return a === "left" || a === "center" || a === "right" ? a : "";
  });
  const col_widths =
    Array.isArray(rawColWidths) && rawColWidths.length > 0
      ? Array.from({ length: colCount }, (_, c) => {
          const n = Number(rawColWidths[c]);
          if (!Number.isFinite(n) || n <= 0) return TABLE_DEFAULT_COL_WIDTH;
          return Math.min(TABLE_MAX_COL_WIDTH, Math.max(TABLE_MIN_COL_WIDTH, Math.round(n)));
        })
      : [];
  const rows = safeRows.map((r) =>
    Array.from({ length: colCount }, (_, c) => String(r?.[c] ?? ""))
  );
  return { alignments, col_widths, rows };
}

function findClosingBackticks(str, start, tickLen) {
  let search = start;
  while (search < str.length) {
    if (str[search] === "`") {
      const cStart = search;
      while (search < str.length && str[search] === "`") search += 1;
      if (search - cStart === tickLen) return search;
    } else {
      search += 1;
    }
  }
  return -1;
}

function containsUnescapedPipe(s) {
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length) {
      i += 2;
      continue;
    }
    if (s[i] === "`") {
      const tStart = i;
      while (i < s.length && s[i] === "`") i += 1;
      const closeEnd = findClosingBackticks(s, i, i - tStart);
      if (closeEnd !== -1) i = closeEnd;
      continue;
    }
    if (s[i] === "[" && s[i + 1] === "[") {
      const closeRel = s.indexOf("]]", i + 2);
      if (closeRel !== -1) {
        i = closeRel + 2;
        continue;
      }
    }
    if (s[i] === "|") return true;
    i += 1;
  }
  return false;
}

function replaceBrOutsideCode(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "`") {
      const tStart = i;
      while (i < s.length && s[i] === "`") i += 1;
      const closeEnd = findClosingBackticks(s, i, i - tStart);
      if (closeEnd !== -1) {
        out += s.slice(tStart, closeEnd);
        i = closeEnd;
      } else {
        out += s.slice(tStart, i);
      }
      continue;
    }
    if (s[i] === "<") {
      const sub6 = s.slice(i, i + 6).toLowerCase();
      if (sub6.startsWith("<br/>")) {
        out += "\n";
        i += 5;
        continue;
      }
      if (sub6 === "<br />") {
        out += "\n";
        i += 6;
        continue;
      }
      if (s.slice(i, i + 4).toLowerCase() === "<br>") {
        out += "\n";
        i += 4;
        continue;
      }
    }
    out += s[i];
    i += 1;
  }
  return out;
}

function unescapeTableCell(raw) {
  const unescaped = String(raw || "").trim().replace(/\\\|/g, "|");
  return replaceBrOutsideCode(unescaped);
}

function splitPipeRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || !containsUnescapedPipe(trimmed)) return null;

  let inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  if (inner.endsWith("|")) {
    let backslashes = 0;
    for (let k = inner.length - 2; k >= 0 && inner[k] === "\\"; k--) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) {
      inner = inner.slice(0, -1);
    }
  }

  const cells = [];
  let start = 0;
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "\\" && i + 1 < inner.length) {
      i += 2;
      continue;
    }
    if (inner[i] === "`") {
      const tStart = i;
      while (i < inner.length && inner[i] === "`") i += 1;
      const closeEnd = findClosingBackticks(inner, i, i - tStart);
      if (closeEnd !== -1) i = closeEnd;
      continue;
    }
    if (inner[i] === "[" && inner[i + 1] === "[") {
      const closeRel = inner.indexOf("]]", i + 2);
      if (closeRel !== -1) {
        i = closeRel + 2;
        continue;
      }
    }
    if (inner[i] === "|") {
      cells.push(unescapeTableCell(inner.slice(start, i)));
      start = i + 1;
    }
    i += 1;
  }
  cells.push(unescapeTableCell(inner.slice(start)));
  return cells.length ? cells : null;
}

function parseDelimiterRow(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || !trimmed.includes("|")) return null;
  let inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  if (!inner.trim()) return null;

  const alignments = [];
  for (const part of inner.split("|")) {
    const cell = part.trim();
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    alignments.push(left && right ? "center" : left ? "left" : right ? "right" : "");
  }
  return alignments.length ? alignments : null;
}

function tryParseMarkdownTable(text) {
  const lines = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;

  const headers = splitPipeRow(lines[0]);
  const alignments = parseDelimiterRow(lines[1]);
  if (!headers || !alignments || headers.length !== alignments.length) return null;

  const colCount = headers.length;
  const rows = [headers];
  for (let i = 2; i < lines.length; i++) {
    const row = splitPipeRow(lines[i]);
    if (!row) return null;
    const normRow = Array.from({ length: colCount }, (_, c) => row[c] ?? "");
    rows.push(normRow);
  }
  return { alignments, rows };
}

function tryParseSinglePipeHeaderTrigger(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("|")) return null;
  if (parseDelimiterRow(trimmed)) return null;
  const cells = splitPipeRow(trimmed);
  if (!cells || cells.length < 2) return null;
  return cells;
}

function serializeTableFallbackText(block) {
  const rows = Array.isArray(block?.rows) ? block.rows : [];
  return rows.map((r) => (Array.isArray(r) ? r.join(" | ") : "")).join("\n");
}

function genAnchorBlockId(existingBlocks) {
  const used = new Set(existingBlocks.map((b) => b.block_id).filter(Boolean));
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 32; attempt++) {
    let id = "";
    for (let i = 0; i < 6; i++) {
      id += chars[Math.floor(Math.random() * chars.length)];
    }
    if (!used.has(id)) return id;
  }
  return Date.now().toString(36).slice(-6);
}

function extractClipboardImage(dataTransfer) {
  if (!dataTransfer) return null;
  if (dataTransfer.items) {
    for (const item of dataTransfer.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) return file;
      }
    }
  }
  if (dataTransfer.files) {
    for (const file of dataTransfer.files) {
      if (file.type?.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name || "")) {
        return file;
      }
    }
  }
  return null;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
    reader.readAsDataURL(file);
  });
}

function getCaretOffsetInText(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return 0;
  const pre = range.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString().replace(/\u200B/g, "").length;
}

function getTotalTextLength(root) {
  return (root.textContent || "").replace(/\u200B/g, "").length;
}

function setCaretAtEdge(el, atEnd, preventScroll = false) {
  el.focus(preventScroll ? { preventScroll: true } : undefined);
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(!atEnd);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setCaretAtCharOffset(root, targetOffset, preventScroll = false) {
  root.focus(preventScroll ? { preventScroll: true } : undefined);
  const sel = window.getSelection();
  const range = document.createRange();
  let remaining = Math.max(0, targetOffset);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let lastText = null;
  let node = walker.nextNode();

  while (node) {
    const cleanLen = (node.nodeValue || "").replace(/\u200B/g, "").length;
    lastText = node;
    if (remaining <= cleanLen) {
      range.setStart(node, Math.min(remaining, node.nodeValue.length));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= cleanLen;
    node = walker.nextNode();
  }

  if (lastText) {
    range.setStart(lastText, lastText.nodeValue.length);
  } else {
    range.selectNodeContents(root);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function extractInlineMdBeforeAndAfterCaret(editableEl) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !editableEl.contains(sel.getRangeAt(0).startContainer)) {
    return { before: domToInlineMarkdown(editableEl), after: "" };
  }
  const range = sel.getRangeAt(0);

  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(editableEl);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const beforeWrap = document.createElement("div");
  beforeWrap.appendChild(beforeRange.cloneContents());

  const afterRange = document.createRange();
  afterRange.selectNodeContents(editableEl);
  afterRange.setStart(range.endContainer, range.endOffset);
  const afterWrap = document.createElement("div");
  afterWrap.appendChild(afterRange.cloneContents());

  return {
    before: domToInlineMarkdown(beforeWrap),
    after: domToInlineMarkdown(afterWrap),
  };
}

/**
 * Block-based editor with collapsible headings, bold/inline-code, code blocks, and @@ links.
 */
export class BlockEditor {
  constructor(
    {
      containerEl,
      selectionToolbarEl,
      boldBtn,
      italicBtn,
      inlineCodeBtn,
      highlightBtn,
      colorSelBtn,
      askAiSelBtn,
      linkPopoverEl,
      slashPopoverEl,
      blockMenuEl,
      blockSelectionBarEl,
      blockSelectionCountEl,
      blocksAskAiBtn,
      blocksColorBtn,
      blocksOutdentBtn,
      blocksDupBtn,
      blocksDelBtn,
      blocksClearBtn,
      blockMarqueeEl,
    },
    {
      getPages,
      onDirty,
      onOpenLink,
      onCreatePage,
      onCollapseChange,
      onSavePastedImage,
      onResolveImageUrl,
      getCachedImageUrl,
      onAskAiBlock,
      onAskAiBlocks,
      onAskAiSelection,
      onCopyBlockLink,
      onBlockSelectionChange,
    }
  ) {
    this.containerEl = containerEl;
    this.selectionToolbarEl = selectionToolbarEl;
    this.colorSelBtn = colorSelBtn;
    this.slashPopoverEl = slashPopoverEl;
    this.blockMenuEl = blockMenuEl;
    this.blockSelectionBarEl = blockSelectionBarEl;
    this.blockSelectionCountEl = blockSelectionCountEl;
    this.blocksColorBtn = blocksColorBtn;
    this.blocksOutdentBtn = blocksOutdentBtn;
    this.blockMarqueeEl = blockMarqueeEl;

    this.getPages = getPages;
    this.onDirty = onDirty;
    this.onOpenLink = onOpenLink;
    this.onCreatePage = onCreatePage;
    this.onCollapseChange = onCollapseChange;
    this.onSavePastedImage = onSavePastedImage;
    this.onResolveImageUrl = onResolveImageUrl;
    this.getCachedImageUrl = getCachedImageUrl;
    this.onAskAiBlock = onAskAiBlock;
    this.onAskAiBlocks = onAskAiBlocks;
    this.onAskAiSelection = onAskAiSelection;
    this.onCopyBlockLink = onCopyBlockLink;
    this.onBlockSelectionChange = onBlockSelectionChange;

    this.blocks = [];
    this.collapsedIds = new Set();
    this.selectedBlockIds = new Set();
    this.lastSelectedBlockId = null;
    this.menuTargetBlockId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.pointerDrag = null;
    this.tableResizeDrag = null;
    this.tableColResize = null;
    this.marquee = null;
    this.suppressNextBottomClick = false;
    this._lastSelectionSig = "";
    this.lastUsedColor = loadLastUsedColor();
    this._colorFlyoutTimer = null;

    this.colorPopoverEl = document.createElement("div");
    this.colorPopoverEl.className = "popover color-popover";
    this.colorPopoverEl.hidden = true;
    this.colorPopoverEl.setAttribute("role", "menu");
    this.colorPopoverEl.addEventListener("mouseenter", () => {
      clearTimeout(this._colorFlyoutTimer);
    });
    document.body.appendChild(this.colorPopoverEl);

    this.tableMenuEl = document.createElement("div");
    this.tableMenuEl.className = "popover table-menu";
    this.tableMenuEl.hidden = true;
    this.tableMenuEl.setAttribute("role", "menu");
    document.body.appendChild(this.tableMenuEl);

    this.dropIndicatorEl = document.createElement("div");
    this.dropIndicatorEl.className = "drop-indicator";
    this.dropIndicatorEl.hidden = true;
    document.body.appendChild(this.dropIndicatorEl);

    window.addEventListener("pointermove", (e) => {
      this.handleMarqueeMove(e);
      this.handlePointerMove(e);
      this.handleTableResizeMove(e);
      this.handleTableColResizeMove(e);
    });
    window.addEventListener("pointerup", (e) => {
      this.handleMarqueeUp(e);
      this.handlePointerUp(e);
      this.handleTableResizeUp(e);
      this.handleTableColResizeUp(e);
    });
    window.addEventListener("pointercancel", () => {
      this.cleanupMarquee();
      this.cleanupPointerDrag();
      this.cleanupTableResizeDrag();
      this.cleanupTableColResize(true);
    });
    window.addEventListener("resize", () => this.updateBlockSelectionBar());
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (this.pointerDrag?.started) {
          e.preventDefault();
          this.cleanupPointerDrag();
        }
        if (this.tableResizeDrag) {
          e.preventDefault();
          this.cleanupTableResizeDrag();
        }
        if (this.tableColResize) {
          e.preventDefault();
          this.cleanupTableColResize(true);
        }
        if (!this.tableMenuEl.hidden) {
          e.preventDefault();
          this.closeTableMenu();
        }
        if (!this.colorPopoverEl.hidden) {
          e.preventDefault();
          this.closeColorPopover();
        }
      }
    });

    const wireSelBarBtn = (btn, fn) => {
      if (!btn) return;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!btn.disabled) fn();
      });
    };
    wireSelBarBtn(blocksAskAiBtn, () => this.onAskAiBlocks?.(this.getSelectedBlocksForAi()));
    wireSelBarBtn(blocksColorBtn, () => {
      if (!this.selectedBlockIds.size || !blocksColorBtn) return;
      const firstId = Array.from(this.selectedBlockIds)[0];
      const firstBlock = this.blocks.find((b) => b.id === firstId);
      this.openColorPopover({
        mode: "blocks",
        anchorRect: blocksColorBtn.getBoundingClientRect(),
        sideFlyout: false,
        activeColor: this.selectedBlockIds.size === 1 ? firstBlock?.color || "" : "",
        activeBg: this.selectedBlockIds.size === 1 ? firstBlock?.bg || "" : "",
        onPick: (kind, value) => {
          this.closeColorPopover();
          this.applyColorToBlocks(Array.from(this.selectedBlockIds), kind, value);
        },
      });
    });
    wireSelBarBtn(blocksOutdentBtn, () => this.outdentSelectedBlocks(1));
    wireSelBarBtn(blocksDupBtn, () => this.duplicateSelectedBlocks());
    wireSelBarBtn(blocksDelBtn, () => this.deleteSelectedBlocks());
    wireSelBarBtn(blocksClearBtn, () => this.clearBlockSelection());

    this.slashState = {
      active: false,
      blockId: null,
      selectedIndex: 0,
      filtered: [],
    };

    this.linkAutocomplete = new LinkAutocomplete(linkPopoverEl, {
      getPages: this.getPages,
      onCreatePage: this.onCreatePage,
      onInserted: (editableEl) => {
        const idx = this.findBlockIndexByEl(editableEl);
        if (idx !== -1) {
          this.pushUndoSnapshot();
          this.syncEditableElToBlock(editableEl, idx);
          this.onDirty();
        }
      },
    });

    boldBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.toggleInlineTag("STRONG");
    });

    italicBtn?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.toggleInlineTag("EM");
    });

    inlineCodeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.toggleInlineTag("CODE");
    });

    highlightBtn?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.toggleInlineTag("MARK");
    });

    colorSelBtn?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!this.colorPopoverEl.hidden && this.colorPopoverEl.dataset.mode === "inline") {
        this.closeColorPopover();
        return;
      }
      const { color, bg } = this.getActiveInlineColorState();
      this.openColorPopover({
        mode: "inline",
        anchorRect: colorSelBtn.getBoundingClientRect(),
        sideFlyout: false,
        activeColor: color,
        activeBg: bg,
        onPick: (kind, value) => {
          this.closeColorPopover();
          this.applyInlineColor(kind, value);
        },
      });
    });

    askAiSelBtn?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const selCtx = this.getSelectedTextContext();
      if (selCtx) {
        this.hideSelectionToolbar();
        this.onAskAiSelection?.(selCtx);
      }
    });

    document.addEventListener("selectionchange", () => {
      this.updateSelectionToolbar();
    });

    document.addEventListener("mousedown", (e) => {
      if (!this.slashPopoverEl.hidden && !this.slashPopoverEl.contains(e.target)) {
        this.closeSlashMenu();
      }
      if (
        !this.blockMenuEl.hidden &&
        !this.blockMenuEl.contains(e.target) &&
        !this.colorPopoverEl.contains(e.target)
      ) {
        this.closeBlockMenu();
      }
      if (!this.tableMenuEl.hidden && !this.tableMenuEl.contains(e.target)) {
        this.closeTableMenu();
      }
      if (
        !this.colorPopoverEl.hidden &&
        !this.colorPopoverEl.contains(e.target) &&
        !this.blockMenuEl.contains(e.target) &&
        (!this.colorSelBtn || !this.colorSelBtn.contains(e.target)) &&
        (!this.blocksColorBtn || !this.blocksColorBtn.contains(e.target))
      ) {
        this.closeColorPopover();
      }
    });

    document.addEventListener("paste", (e) => {
      const scrollEl = this.containerEl.closest(".editor-scroll");
      if (!scrollEl || scrollEl.hidden) return;
      const target = e.target;
      if (
        target?.closest(".block-editable, .table-cell-editable, .ai-input") ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA"
      ) {
        return;
      }
      const imgFile = extractClipboardImage(e.clipboardData);
      if (!imgFile) return;
      e.preventDefault();
      const activeImageRow = document.activeElement?.closest?.(".block-row");
      this.insertImageFromFile(imgFile, activeImageRow?.dataset?.id || null);
    });

    const scrollEl = this.containerEl.closest(".editor-scroll");
    if (scrollEl) {
      scrollEl.addEventListener("dragover", (e) => {
        if (this.pointerDrag || !e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
      });
      scrollEl.addEventListener("drop", (e) => {
        if (this.pointerDrag) return;
        const imgFile = extractClipboardImage(e.dataTransfer);
        if (!imgFile) return;
        e.preventDefault();
        const row = e.target?.closest?.(".block-row");
        this.insertImageFromFile(imgFile, row?.dataset?.id || null);
      });
      scrollEl.addEventListener("scroll", () => this.updateBlockSelectionBar(), { passive: true });
      scrollEl.addEventListener("pointerdown", (e) => {
        if (
          e.button !== 0 ||
          e.target.closest(".block-row, .doc-header, .backlinks-section, .popover, .block-selection-bar")
        ) {
          return;
        }
        this.cleanupMarquee();
        this.marquee = {
          startX: e.clientX,
          startY: e.clientY,
          additive: e.ctrlKey || e.metaKey || e.shiftKey,
          active: false,
          baseSelection: new Set(this.selectedBlockIds),
        };
      });
      scrollEl.addEventListener("mousedown", (e) => {
        if (
          e.button === 0 &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.shiftKey &&
          !e.target.closest(".block-row") &&
          this.selectedBlockIds.size > 0
        ) {
          this.clearBlockSelection();
        }
      });
    }

    // Direct drag from highlighted block body (when already selected via Ctrl/Shift+Click)
    this.containerEl.addEventListener(
      "pointerdown",
      (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        if (this.selectedBlockIds.size === 0) return;
        const row = e.target.closest(".block-row");
        if (!row || !this.selectedBlockIds.has(row.dataset.id)) return;
        if (
          e.target.closest(
            ".gutter-btn, .heading-toggle, .collapsed-badge, .code-copy-btn, .code-lang-select, .table-expand-btn, .table-col-handle, .table-row-handle, .table-col-resizer"
          )
        ) {
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        const blockId = row.dataset.id;
        const idx = Number(row.dataset.idx);
        const mainEl = row.querySelector(".block-main");
        const mainRect = mainEl ? mainEl.getBoundingClientRect() : row.getBoundingClientRect();
        this.cleanupPointerDrag();
        this.pointerDrag = {
          sourceKind: "body",
          blockId,
          sourceIdx: idx,
          dragCount: 1,
          pointerId: e.pointerId,
          captureEl: null,
          startX: e.clientX,
          startY: e.clientY,
          grabOffsetX: Math.max(0, Math.min(180, e.clientX - mainRect.left)),
          grabOffsetY: Math.max(0, Math.min(32, e.clientY - mainRect.top)),
          lastClientX: e.clientX,
          lastClientY: e.clientY,
          started: false,
          btnRect: mainRect,
          ghostEl: null,
          insertIndex: null,
          scrollRaf: null,
        };
      },
      true
    );

    // Ctrl+Click / Shift+Click multi-block selection
    this.containerEl.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 0) return;
        const row = e.target.closest(".block-row");
        if (!row) return;

        const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
        const shiftRange = e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && this.selectedBlockIds.size > 0;

        if (mod || shiftRange) {
          if (
            e.target.closest(
              ".heading-toggle, .collapsed-badge, .code-copy-btn, .code-lang-select, .gutter-btn, .table-expand-btn, .table-col-handle, .table-row-handle, .table-col-resizer"
            )
          ) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          if (document.activeElement && this.containerEl.contains(document.activeElement)) {
            document.activeElement.blur();
          }
          window.getSelection()?.removeAllRanges();
          this.closeBlockMenu();
          this.closeSlashMenu();
          this.hideSelectionToolbar();
          this.toggleBlockSelection(row.dataset.id, e.shiftKey);
          return;
        }

        if (this.selectedBlockIds.size > 0) {
          if (this.selectedBlockIds.has(row.dataset.id)) {
            return;
          }
          this.clearBlockSelection();
        }
      },
      true
    );
  }

  loadDocument(blocks, collapsedIndices = []) {
    this.blocks = blocks?.length
      ? cloneBlocks(blocks)
      : [{ id: genBlockId(), type: "paragraph", content: "" }];
    this.collapsedIds = new Set();
    this.selectedBlockIds.clear();
    this.lastSelectedBlockId = null;
    this.menuTargetBlockId = null;
    this.containerEl.classList.remove("has-block-selection");
    this.cleanupMarquee();
    this.suppressNextBottomClick = false;
    this.notifyBlockSelectionChange();
    this.updateBlockSelectionBar();
    for (const idx of collapsedIndices || []) {
      const b = this.blocks[idx];
      if (b && b.type === "heading") {
        this.collapsedIds.add(b.id);
      }
    }
    this.undoStack = [];
    this.redoStack = [];
    this.cleanupPointerDrag();
    this.cleanupTableResizeDrag();
    this.cleanupTableColResize(false);
    this.closeSlashMenu();
    this.closeBlockMenu();
    this.closeTableMenu();
    this.closeColorPopover();
    this.linkAutocomplete.close();
    this.hideSelectionToolbar();
    this.render();
  }

  isInteracting() {
    return Boolean(
      this.pointerDrag?.started ||
        this.marquee?.active ||
        this.tableResizeDrag ||
        this.tableColResize
    );
  }

  captureViewState() {
    this.syncAllEditableFromDom();
    const scrollEl = this.containerEl.closest(".editor-scroll");
    const scrollTop = scrollEl ? scrollEl.scrollTop : 0;

    const occByKey = new Map();
    const collapsedHeadings = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (b.type !== "heading") continue;
      const key = `${b.level}::${(b.content || "").trim()}`;
      const occ = occByKey.get(key) || 0;
      occByKey.set(key, occ + 1);
      if (this.collapsedIds.has(b.id)) {
        collapsedHeadings.push({ key, occ, idx: i, level: b.level });
      }
    }

    let focus = null;
    const active = document.activeElement;
    const row = active?.closest?.(".block-row");
    if (row && this.containerEl.contains(row)) {
      const blockIdx = this.blocks.findIndex((b) => b.id === row.dataset.id);
      if (blockIdx !== -1) {
        const block = this.blocks[blockIdx];
        const base = {
          blockIdx,
          anchorId: block.block_id || null,
          type: block.type,
          content: block.content || "",
        };
        if (active.classList.contains("block-editable")) {
          focus = { ...base, kind: "editable", charOffset: getCaretOffsetInText(active) };
        } else if (active.classList.contains("code-textarea")) {
          focus = {
            ...base,
            kind: "code",
            selectionStart: active.selectionStart ?? 0,
            selectionEnd: active.selectionEnd ?? 0,
          };
        } else if (active.classList.contains("table-cell-editable")) {
          focus = {
            ...base,
            kind: "table",
            row: Number(active.dataset.row) || 0,
            col: Number(active.dataset.col) || 0,
            charOffset: getCaretOffsetInText(active),
          };
        } else {
          focus = { ...base, kind: "card" };
        }
      }
    }

    return { scrollTop, collapsedHeadings, focus };
  }

  hotReloadDocument(blocks, viewState = null) {
    this.syncAllEditableFromDom();
    this.pushUndoSnapshot();

    this.blocks = blocks?.length
      ? cloneBlocks(blocks)
      : [{ id: genBlockId(), type: "paragraph", content: "" }];

    this.collapsedIds = new Set();
    this.selectedBlockIds.clear();
    this.lastSelectedBlockId = null;
    this.menuTargetBlockId = null;
    this.containerEl.classList.remove("has-block-selection");
    this.cleanupMarquee();
    this.suppressNextBottomClick = false;
    this.notifyBlockSelectionChange();
    this.updateBlockSelectionBar();

    if (viewState?.collapsedHeadings?.length) {
      const headingsByKeyOcc = new Map();
      const occByKey = new Map();
      for (let i = 0; i < this.blocks.length; i++) {
        const b = this.blocks[i];
        if (b.type !== "heading") continue;
        const key = `${b.level}::${(b.content || "").trim()}`;
        const occ = occByKey.get(key) || 0;
        occByKey.set(key, occ + 1);
        headingsByKeyOcc.set(`${key}#${occ}`, b.id);
      }

      for (const ch of viewState.collapsedHeadings) {
        const byKey = headingsByKeyOcc.get(`${ch.key}#${ch.occ}`);
        if (byKey) {
          this.collapsedIds.add(byKey);
          continue;
        }
        const byIdx = this.blocks[ch.idx];
        if (byIdx && byIdx.type === "heading" && byIdx.level === ch.level) {
          this.collapsedIds.add(byIdx.id);
        }
      }
    }

    this.cleanupPointerDrag();
    this.cleanupTableResizeDrag();
    this.cleanupTableColResize(false);
    this.closeSlashMenu();
    this.closeBlockMenu();
    this.closeTableMenu();
    this.closeColorPopover();
    this.linkAutocomplete.close();
    this.hideSelectionToolbar();
    this.render();

    const scrollEl = this.containerEl.closest(".editor-scroll");
    const targetScrollTop = typeof viewState?.scrollTop === "number" ? viewState.scrollTop : null;

    if (viewState?.focus && this.blocks.length) {
      const f = viewState.focus;
      let target = null;

      if (f.anchorId) {
        target = this.blocks.find((b) => b.block_id === f.anchorId) || null;
      }
      if (!target && f.blockIdx >= 0 && f.blockIdx < this.blocks.length) {
        const cand = this.blocks[f.blockIdx];
        if (cand.type === f.type) {
          target = cand;
        }
      }
      if (!target) {
        let bestDist = Infinity;
        for (let i = 0; i < this.blocks.length; i++) {
          const b = this.blocks[i];
          if (b.type === f.type && (b.content || "") === f.content) {
            const dist = Math.abs(i - f.blockIdx);
            if (dist < bestDist) {
              bestDist = dist;
              target = b;
            }
          }
        }
      }
      if (!target) {
        const clampedIdx = Math.min(this.blocks.length - 1, Math.max(0, f.blockIdx));
        target = this.blocks[clampedIdx];
      }

      if (target) {
        const row = this.containerEl.querySelector(`.block-row[data-id="${CSS.escape(target.id)}"]`);
        if (row) {
          if (f.kind === "editable") {
            const ed = row.querySelector(".block-editable");
            if (ed) {
              setCaretAtCharOffset(ed, f.charOffset || 0, true);
            }
          } else if (f.kind === "code") {
            const ta = row.querySelector(".code-textarea");
            if (ta) {
              ta.focus({ preventScroll: true });
              const start = Math.min(f.selectionStart || 0, ta.value.length);
              const end = Math.min(f.selectionEnd || 0, ta.value.length);
              ta.setSelectionRange(start, end);
            }
          } else if (f.kind === "table") {
            const cell =
              row.querySelector(
                `.table-cell-editable[data-row="${f.row}"][data-col="${f.col}"]`
              ) || row.querySelector(".table-cell-editable");
            if (cell) {
              setCaretAtCharOffset(cell, f.charOffset || 0, true);
            }
          } else {
            const card = row.querySelector(".block-image-card, .block-divider-card");
            if (card) card.focus({ preventScroll: true });
          }
        }
      }
    }

    if (scrollEl && targetScrollTop !== null) {
      scrollEl.scrollTop = targetScrollTop;
      requestAnimationFrame(() => {
        if (scrollEl.isConnected) {
          scrollEl.scrollTop = targetScrollTop;
        }
      });
    }
  }

  getBlocks() {
    this.syncAllEditableFromDom();
    return cloneBlocks(this.blocks);
  }

  getCollapsedIndices() {
    const indices = [];
    this.blocks.forEach((b, idx) => {
      if (b.type === "heading" && this.collapsedIds.has(b.id)) {
        indices.push(idx);
      }
    });
    return indices;
  }

  refreshLinkStyles() {
    const lookup = buildPageLookup(this.getPages());
    this.containerEl.querySelectorAll(".page-link").forEach((span) => {
      const target = span.dataset.target || "";
      span.classList.toggle("page-link-missing", !lookup.has(target));
    });
  }

  areVisibleHeadingsCollapsed() {
    const { visible } = this.computeVisibility();
    let hasVisibleHeading = false;
    for (let i = 0; i < this.blocks.length; i++) {
      if (!visible[i]) continue;
      const b = this.blocks[i];
      if (b.type === "heading") {
        hasVisibleHeading = true;
        if (!this.collapsedIds.has(b.id)) {
          return false;
        }
      }
    }
    return hasVisibleHeading;
  }

  toggleCollapseAll() {
    if (this.areVisibleHeadingsCollapsed()) {
      this.expandAll();
    } else {
      this.collapseAll();
    }
  }

  collapseAll() {
    for (const b of this.blocks) {
      if (b.type === "heading") this.collapsedIds.add(b.id);
    }
    this.render();
    this.onCollapseChange(this.getCollapsedIndices());
  }

  expandAll() {
    this.collapsedIds.clear();
    this.render();
    this.onCollapseChange(this.getCollapsedIndices());
  }

  pushUndoSnapshot() {
    const snapshot = {
      blocks: cloneBlocks(this.blocks),
      collapsed: Array.from(this.collapsedIds),
    };
    const last = this.undoStack[this.undoStack.length - 1];
    if (last && JSON.stringify(last.blocks) === JSON.stringify(snapshot.blocks)) {
      return;
    }
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 100) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.syncAllEditableFromDom();
    this.redoStack.push({
      blocks: cloneBlocks(this.blocks),
      collapsed: Array.from(this.collapsedIds),
    });
    const prev = this.undoStack.pop();
    this.blocks = cloneBlocks(prev.blocks);
    this.collapsedIds = new Set(prev.collapsed);
    this.render();
    this.onDirty();
    this.onCollapseChange(this.getCollapsedIndices());
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.syncAllEditableFromDom();
    this.undoStack.push({
      blocks: cloneBlocks(this.blocks),
      collapsed: Array.from(this.collapsedIds),
    });
    const next = this.redoStack.pop();
    this.blocks = cloneBlocks(next.blocks);
    this.collapsedIds = new Set(next.collapsed);
    this.render();
    this.onDirty();
    this.onCollapseChange(this.getCollapsedIndices());
    return true;
  }

  syncEditableElToBlock(editableEl, idx) {
    const b = this.blocks[idx];
    if (!b || !editableEl) return;
    if (editableEl.classList.contains("table-cell-editable")) {
      const r = Number(editableEl.dataset.row);
      const c = Number(editableEl.dataset.col);
      if (b.type === "table" && Array.isArray(b.rows?.[r]) && c >= 0 && c < b.rows[r].length) {
        b.rows[r][c] = domToInlineMarkdown(editableEl);
      }
      return;
    }
    b.content = domToInlineMarkdown(editableEl);
  }

  syncAllEditableFromDom() {
    this.containerEl.querySelectorAll(".block-editable").forEach((el) => {
      const row = el.closest(".block-row");
      const id = row?.dataset.id;
      const b = this.blocks.find((item) => item.id === id);
      if (b) {
        b.content = domToInlineMarkdown(el);
      }
    });
    this.containerEl.querySelectorAll(".table-cell-editable").forEach((el) => {
      const row = el.closest(".block-row");
      const id = row?.dataset.id;
      const b = this.blocks.find((item) => item.id === id);
      const r = Number(el.dataset.row);
      const c = Number(el.dataset.col);
      if (b && b.type === "table" && Array.isArray(b.rows?.[r]) && c >= 0 && c < b.rows[r].length) {
        b.rows[r][c] = domToInlineMarkdown(el);
      }
    });
  }

  findBlockIndexByEl(el) {
    const row = el?.closest(".block-row");
    if (!row) return -1;
    const id = row.dataset.id;
    return this.blocks.findIndex((b) => b.id === id);
  }

  /**
   * Computes visibility, collapsed descendant counts, and visual nesting depths.
   */
  computeVisibility() {
    const visible = new Array(this.blocks.length).fill(true);
    const hiddenCounts = new Array(this.blocks.length).fill(0);
    const depths = new Array(this.blocks.length).fill(0);

    const headingStack = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (block.type === "heading") {
        while (headingStack.length > 0 && headingStack[headingStack.length - 1] >= block.level) {
          headingStack.pop();
        }
        depths[i] = Math.min(4, headingStack.length);
        headingStack.push(block.level);
      } else {
        const outdent = Math.max(0, Number(block.outdent) || 0);
        if (outdent > 0) {
          const popCount = Math.min(headingStack.length, outdent);
          for (let p = 0; p < popCount; p++) {
            headingStack.pop();
          }
        }
        depths[i] = Math.min(4, headingStack.length);
      }
    }

    let hiddenByDepth = null;
    let ownerIdx = -1;

    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];

      if (hiddenByDepth !== null) {
        if (depths[i] <= hiddenByDepth) {
          hiddenByDepth = null;
          ownerIdx = -1;
        } else {
          visible[i] = false;
          if (ownerIdx !== -1) {
            hiddenCounts[ownerIdx] += 1;
          }
          continue;
        }
      }

      if (block.type === "heading" && this.collapsedIds.has(block.id)) {
        hiddenByDepth = depths[i];
        ownerIdx = i;
      }
    }

    return { visible, hiddenCounts, depths };
  }

  render(focusBlockId = null, caretMode = "end", charOffset = null) {
    this.closeTableMenu();
    const lookup = buildPageLookup(this.getPages());
    const { visible, hiddenCounts, depths } = this.computeVisibility();

    this.containerEl.innerHTML = "";
    const frag = document.createDocumentFragment();
    let numberedSeq = 0;

    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i];
      if (block.type === "numbered_list") {
        numberedSeq += 1;
      } else {
        numberedSeq = 0;
      }
      if (!visible[i]) continue;
      const row = this.createBlockRow(block, i, hiddenCounts[i], depths[i], lookup, numberedSeq);
      frag.appendChild(row);
    }

    this.containerEl.appendChild(frag);

    if (focusBlockId) {
      this.focusBlock(focusBlockId, caretMode, charOffset);
    }
  }

  focusTableCell(blockId, rowIdx, colIdx, atEnd = false) {
    const row = this.containerEl.querySelector(`.block-row[data-id="${CSS.escape(blockId)}"]`);
    if (!row) return;
    const cellEl = row.querySelector(
      `.table-cell-editable[data-row="${rowIdx}"][data-col="${colIdx}"]`
    );
    if (cellEl) {
      setCaretAtEdge(cellEl, atEnd);
    }
  }

  focusBlock(blockId, caretMode = "end", charOffset = null) {
    const row = this.containerEl.querySelector(`.block-row[data-id="${CSS.escape(blockId)}"]`);
    if (!row) return;
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block) return;

    if (block.type === "code") {
      const ta = row.querySelector(".code-textarea");
      if (ta) {
        ta.focus();
        const pos = caretMode === "start" ? 0 : ta.value.length;
        ta.setSelectionRange(pos, pos);
      }
    } else if (block.type === "image") {
      const card = row.querySelector(".block-image-card");
      if (card) card.focus();
    } else if (block.type === "divider") {
      const card = row.querySelector(".block-divider-card");
      if (card) card.focus();
    } else if (block.type === "table") {
      const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
      const lastR = Math.max(0, norm.rows.length - 1);
      const lastC = Math.max(0, (norm.rows[lastR]?.length || 1) - 1);
      if (caretMode && typeof caretMode === "object") {
        const r = Math.min(lastR, Math.max(0, Number(caretMode.row) || 0));
        const c = Math.min(lastC, Math.max(0, Number(caretMode.col) || 0));
        this.focusTableCell(blockId, r, c, Boolean(caretMode.atEnd));
      } else if (caretMode === "start") {
        this.focusTableCell(blockId, 0, 0, false);
      } else {
        this.focusTableCell(blockId, lastR, lastC, true);
      }
    } else {
      const ed = row.querySelector(".block-editable");
      if (ed) {
        if (typeof charOffset === "number") {
          setCaretAtCharOffset(ed, charOffset);
        } else {
          setCaretAtEdge(ed, caretMode !== "start");
        }
      }
    }
  }

  focusBottomOrCreate() {
    if (!this.blocks.length) {
      this.blocks.push({ id: genBlockId(), type: "paragraph", content: "" });
      this.render(this.blocks[0].id, "end");
      return;
    }
    const last = this.blocks[this.blocks.length - 1];
    if (last.type !== "paragraph" || (last.content || "").trim() !== "") {
      const nb = { id: genBlockId(), type: "paragraph", content: "" };
      this.pushUndoSnapshot();
      this.blocks.push(nb);
      this.render(nb.id, "start");
      this.onDirty();
    } else {
      this.focusBlock(last.id, "end");
    }
  }

  createBlockRow(block, idx, hiddenCount, depth, pageLookup, numberedIndex = 1) {
    const row = document.createElement("div");
    row.className = "block-row";
    row.dataset.id = block.id;
    row.dataset.idx = String(idx);
    row.dataset.depth = String(depth);
    row.style.setProperty("--block-depth", String(depth));

    if (block.type === "heading") {
      row.classList.add("block-heading", `block-heading-${Math.min(3, Math.max(1, block.level))}`);
    } else if (block.type === "bullet_list") {
      row.classList.add("block-bullet-list");
    } else if (block.type === "numbered_list") {
      row.classList.add("block-numbered-list");
    } else if (block.type === "todo") {
      row.classList.add("block-todo");
      if (block.checked) row.classList.add("block-todo-checked");
    } else if (block.type === "quote") {
      row.classList.add("block-quote");
    } else if (block.type === "divider") {
      row.classList.add("block-divider");
    }
    if (isValidColorName(block.color)) {
      row.dataset.color = block.color;
    }
    if (isValidColorName(block.bg)) {
      row.dataset.bg = block.bg;
    }
    if (this.selectedBlockIds.has(block.id) || this.menuTargetBlockId === block.id) {
      row.classList.add("block-selected");
    }

    // Gutter (+ and ⋮⋮)
    const gutter = document.createElement("div");
    gutter.className = "block-gutter";

    const addBtn = document.createElement("button");
    addBtn.className = "gutter-btn";
    addBtn.title = "Add block below";
    addBtn.textContent = "+";
    addBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.insertParagraphAfter(idx);
    });

    const dragBtn = document.createElement("button");
    dragBtn.className = "gutter-btn gutter-drag";
    dragBtn.title = "Drag to reorder, or click for block menu";
    dragBtn.innerHTML = `<svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="3.5" r="1.2"/><circle cx="8.5" cy="3.5" r="1.2"/><circle cx="3.5" cy="8" r="1.2"/><circle cx="8.5" cy="8" r="1.2"/><circle cx="3.5" cy="12.5" r="1.2"/><circle cx="8.5" cy="12.5" r="1.2"/></svg>`;

    dragBtn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (document.activeElement && this.containerEl.contains(document.activeElement)) {
          document.activeElement.blur();
        }
        window.getSelection()?.removeAllRanges();
        this.closeBlockMenu();
        this.toggleBlockSelection(block.id, e.shiftKey);
        return;
      }
      if (e.shiftKey && !e.altKey && this.selectedBlockIds.size > 0) {
        if (document.activeElement && this.containerEl.contains(document.activeElement)) {
          document.activeElement.blur();
        }
        window.getSelection()?.removeAllRanges();
        this.closeBlockMenu();
        this.toggleBlockSelection(block.id, true);
        return;
      }
      this.cleanupPointerDrag();
      try {
        dragBtn.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture is unavailable
      }
      const mainEl = row.querySelector(".block-main");
      const mainRect = mainEl ? mainEl.getBoundingClientRect() : row.getBoundingClientRect();
      this.pointerDrag = {
        sourceKind: "handle",
        blockId: block.id,
        sourceIdx: idx,
        dragCount: 1,
        pointerId: e.pointerId,
        captureEl: dragBtn,
        startX: e.clientX,
        startY: e.clientY,
        grabOffsetX: Math.max(0, e.clientX - mainRect.left),
        grabOffsetY: Math.max(0, Math.min(32, e.clientY - mainRect.top)),
        lastClientX: e.clientX,
        lastClientY: e.clientY,
        started: false,
        btnRect: dragBtn.getBoundingClientRect(),
        ghostEl: null,
        insertIndex: null,
        scrollRaf: null,
      };
    });

    gutter.appendChild(addBtn);
    gutter.appendChild(dragBtn);
    row.appendChild(gutter);

    const main = document.createElement("div");
    main.className = "block-main";

    if (block.type === "code") {
      main.appendChild(this.createCodeCard(block, idx));
    } else if (block.type === "image") {
      main.appendChild(this.createImageCard(block, idx));
    } else if (block.type === "table") {
      main.appendChild(this.createTableCard(block, idx, pageLookup));
    } else if (block.type === "divider") {
      const card = document.createElement("div");
      card.className = "block-divider-card";
      card.tabIndex = 0;
      const hr = document.createElement("hr");
      hr.className = "block-divider-line";
      card.appendChild(hr);
      card.addEventListener("keydown", (e) => {
        const curIdx = this.blocks.findIndex((b) => b.id === block.id);
        if (curIdx === -1) return;
        if (e.key === "Backspace" || e.key === "Delete") {
          e.preventDefault();
          this.deleteBlock(curIdx);
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          this.insertParagraphAfter(curIdx);
        } else if (e.key === "ArrowUp") {
          const prev = this.findPreviousVisibleBlock(curIdx);
          if (prev) {
            e.preventDefault();
            this.focusBlock(prev.id, "end");
          }
        } else if (e.key === "ArrowDown") {
          const next = this.findNextVisibleBlock(curIdx);
          if (next) {
            e.preventDefault();
            this.focusBlock(next.id, "start");
          }
        }
      });
      main.appendChild(card);
    } else {
      if (block.type === "heading") {
        const isCollapsed = this.collapsedIds.has(block.id);
        const toggleBtn = document.createElement("button");
        toggleBtn.className = `heading-toggle${isCollapsed ? " collapsed" : ""}`;
        toggleBtn.title = isCollapsed ? "Expand section" : "Collapse section";
        toggleBtn.innerHTML = `<svg viewBox="0 0 12 12" fill="currentColor"><path d="M2.5 4L6 8L9.5 4z"/></svg>`;
        toggleBtn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.toggleHeadingCollapse(block.id);
        });
        main.appendChild(toggleBtn);
      } else if (block.type === "bullet_list") {
        const marker = document.createElement("span");
        marker.className = "block-list-marker block-bullet-marker";
        marker.setAttribute("aria-hidden", "true");
        marker.textContent = "•";
        main.appendChild(marker);
      } else if (block.type === "numbered_list") {
        const marker = document.createElement("span");
        marker.className = "block-list-marker block-number-marker";
        marker.setAttribute("aria-hidden", "true");
        marker.textContent = `${numberedIndex}.`;
        main.appendChild(marker);
      } else if (block.type === "todo") {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "block-todo-checkbox";
        checkbox.checked = Boolean(block.checked);
        checkbox.setAttribute("aria-label", "Toggle to-do");
        checkbox.addEventListener("change", () => {
          const curIdx = this.blocks.findIndex((b) => b.id === block.id);
          if (curIdx === -1) return;
          this.pushUndoSnapshot();
          this.blocks[curIdx].checked = checkbox.checked;
          row.classList.toggle("block-todo-checked", checkbox.checked);
          this.onDirty();
        });
        main.appendChild(checkbox);
      }

      const editable = document.createElement("div");
      editable.className = "block-editable";
      editable.contentEditable = "true";
      editable.spellcheck = true;
      editable.dataset.placeholder =
        block.type === "heading"
          ? `Heading ${block.level}`
          : block.type === "bullet_list" || block.type === "numbered_list"
            ? "List item"
            : block.type === "todo"
              ? "To-do"
              : block.type === "quote"
                ? "Quote"
                : "Type text, # for header, - for list, / for blocks, @@ to link...";
      editable.innerHTML = inlineMarkdownToHtml(block.content, pageLookup);

      this.attachEditableHandlers(editable, block.id);
      main.appendChild(editable);

      if (block.type === "heading" && this.collapsedIds.has(block.id) && hiddenCount > 0) {
        const badge = document.createElement("button");
        badge.className = "collapsed-badge";
        badge.textContent = `${hiddenCount} block${hiddenCount === 1 ? "" : "s"}`;
        badge.title = "Click to expand";
        badge.addEventListener("mousedown", (e) => {
          e.preventDefault();
          this.toggleHeadingCollapse(block.id);
        });
        main.appendChild(badge);
      }
    }

    row.appendChild(main);
    return row;
  }

  createCodeCard(block, idx) {
    const card = document.createElement("div");
    card.className = "block-code-card";

    const header = document.createElement("div");
    header.className = "code-header";

    const select = document.createElement("select");
    select.className = "code-lang-select";
    const currentLang = (block.language || "text").trim() || "text";
    const langs = CODE_LANGUAGES.includes(currentLang)
      ? CODE_LANGUAGES
      : [currentLang, ...CODE_LANGUAGES];
    for (const lang of langs) {
      const opt = document.createElement("option");
      opt.value = lang;
      opt.textContent = lang;
      if (lang === currentLang) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => {
      const b = this.blocks.find((x) => x.id === block.id);
      if (!b) return;
      this.pushUndoSnapshot();
      b.language = select.value === "text" ? "" : select.value;
      syncHighlight();
      this.onDirty();
    });

    const copyBtn = document.createElement("button");
    copyBtn.className = "code-copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      const b = this.blocks.find((x) => x.id === block.id);
      try {
        await navigator.clipboard.writeText(b ? b.content : "");
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 1200);
      } catch {
        copyBtn.textContent = "Copy";
      }
    });

    header.appendChild(select);
    header.appendChild(copyBtn);
    card.appendChild(header);

    const wrap = document.createElement("div");
    wrap.className = "code-editor-wrap";

    const pre = document.createElement("pre");
    pre.className = "code-highlight";
    pre.setAttribute("aria-hidden", "true");
    const codeEl = document.createElement("code");
    pre.appendChild(codeEl);

    const ta = document.createElement("textarea");
    ta.className = "code-textarea";
    ta.spellcheck = false;
    ta.placeholder = "Write code...";
    ta.value = block.content || "";

    const syncHighlight = () => {
      const lang = select.value === "text" ? "" : select.value;
      const raw = ta.value;
      const html = highlightCode(raw, lang);
      codeEl.innerHTML = raw.endsWith("\n") ? `${html} ` : (html || " ");
    };
    syncHighlight();

    let typedSinceSnap = false;
    ta.addEventListener("input", () => {
      if (!typedSinceSnap) {
        this.pushUndoSnapshot();
        typedSinceSnap = true;
      }
      const b = this.blocks.find((x) => x.id === block.id);
      if (b) b.content = ta.value;
      syncHighlight();
      this.onDirty();
    });

    ta.addEventListener("blur", () => {
      typedSinceSnap = false;
    });

    ta.addEventListener("keydown", (e) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        ta.value = ta.value.slice(0, start) + "  " + ta.value.slice(end);
        ta.setSelectionRange(start + 2, start + 2);
        const b = this.blocks.find((x) => x.id === block.id);
        if (b) b.content = ta.value;
        syncHighlight();
        this.onDirty();
        return;
      }

      if ((e.ctrlKey || e.shiftKey) && e.key === "Enter") {
        e.preventDefault();
        const curIdx = this.blocks.findIndex((x) => x.id === block.id);
        if (curIdx !== -1) this.insertParagraphAfter(curIdx);
        return;
      }

      if (e.key === "Backspace" && ta.value === "" && ta.selectionStart === 0) {
        e.preventDefault();
        const curIdx = this.blocks.findIndex((x) => x.id === block.id);
        if (curIdx !== -1) {
          this.pushUndoSnapshot();
          this.blocks[curIdx] = { id: block.id, type: "paragraph", content: "" };
          this.render(block.id, "start");
          this.onDirty();
        }
        return;
      }

      if (e.key === "ArrowUp" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
        const curIdx = this.blocks.findIndex((x) => x.id === block.id);
        const prev = this.findPreviousVisibleBlock(curIdx);
        if (prev) {
          e.preventDefault();
          this.focusBlock(prev.id, "end");
        }
        return;
      }

      if (
        e.key === "ArrowDown" &&
        ta.selectionStart === ta.value.length &&
        ta.selectionEnd === ta.value.length
      ) {
        const curIdx = this.blocks.findIndex((x) => x.id === block.id);
        const next = this.findNextVisibleBlock(curIdx);
        if (next) {
          e.preventDefault();
          this.focusBlock(next.id, "start");
        }
      }
    });

    wrap.appendChild(pre);
    wrap.appendChild(ta);
    card.appendChild(wrap);
    return card;
  }

  createImageCard(block, idx) {
    const card = document.createElement("div");
    card.className = "block-image-card";
    card.tabIndex = 0;

    const frame = document.createElement("div");
    frame.className = "block-image-frame";

    const img = document.createElement("img");
    img.className = "block-image-el";
    img.alt = block.alt || "";
    img.draggable = false;

    const delBtn = document.createElement("button");
    delBtn.className = "image-delete-btn";
    delBtn.title = "Delete image";
    delBtn.textContent = "×";
    delBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const curIdx = this.blocks.findIndex((b) => b.id === block.id);
      if (curIdx !== -1) this.deleteBlock(curIdx);
    });

    const errBox = document.createElement("div");
    errBox.className = "block-image-error";
    errBox.hidden = true;
    errBox.textContent = `Image not found: ${block.src}`;

    const cached = this.getCachedImageUrl?.(block.src);
    if (cached) {
      img.src = cached;
    } else if (this.onResolveImageUrl) {
      this.onResolveImageUrl(block.src)
        .then((url) => {
          if (url && img.isConnected) {
            img.src = url;
          } else if (!url && errBox.isConnected) {
            img.hidden = true;
            errBox.hidden = false;
          }
        })
        .catch(() => {
          if (errBox.isConnected) {
            img.hidden = true;
            errBox.hidden = false;
          }
        });
    }

    img.addEventListener("error", () => {
      img.hidden = true;
      errBox.hidden = false;
    });

    frame.appendChild(img);
    frame.appendChild(delBtn);
    frame.appendChild(errBox);
    card.appendChild(frame);

    const caption = document.createElement("input");
    caption.type = "text";
    caption.className = "block-image-caption";
    caption.placeholder = "Add a caption...";
    caption.value = block.alt || "";
    if (block.alt) caption.classList.add("has-caption");

    let captionUndoArmed = true;
    caption.addEventListener("input", () => {
      const b = this.blocks.find((x) => x.id === block.id);
      if (!b) return;
      if (captionUndoArmed) {
        this.pushUndoSnapshot();
        captionUndoArmed = false;
      }
      b.alt = caption.value;
      img.alt = caption.value;
      caption.classList.toggle("has-caption", Boolean(caption.value));
      this.onDirty();
    });
    caption.addEventListener("blur", () => {
      captionUndoArmed = true;
    });
    caption.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const curIdx = this.blocks.findIndex((x) => x.id === block.id);
        if (curIdx !== -1) this.insertParagraphAfter(curIdx);
      }
    });

    card.appendChild(caption);

    card.addEventListener("keydown", (e) => {
      if (document.activeElement === caption) return;
      const curIdx = this.blocks.findIndex((x) => x.id === block.id);
      if (curIdx === -1) return;

      if (e.key === "Enter") {
        e.preventDefault();
        this.insertParagraphAfter(curIdx);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        this.deleteBlock(curIdx);
      } else if (e.key === "ArrowUp") {
        const prev = this.findPreviousVisibleBlock(curIdx);
        if (prev) {
          e.preventDefault();
          this.focusBlock(prev.id, "end");
        }
      } else if (e.key === "ArrowDown") {
        const next = this.findNextVisibleBlock(curIdx);
        if (next) {
          e.preventDefault();
          this.focusBlock(next.id, "start");
        }
      }
    });

    return card;
  }

  createTableCard(block, idx, pageLookup) {
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;

    const rows = block.rows;
    const colCount = rows[0].length;
    const hasCustomWidths = block.col_widths.length === colCount;

    const wrap = document.createElement("div");
    wrap.className = "block-table-wrap";
    if (hasCustomWidths) {
      wrap.classList.add("has-col-widths");
    }

    const scroll = document.createElement("div");
    scroll.className = "block-table-scroll";

    const inner = document.createElement("div");
    inner.className = "block-table-inner";

    const table = document.createElement("table");
    table.className = "block-table";
    if (rows.length <= 1) {
      table.classList.add("has-no-body");
    }
    if (hasCustomWidths) {
      table.classList.add("has-col-widths");
      const totalWidth = block.col_widths.reduce((sum, w) => sum + w, 0);
      table.style.width = `${totalWidth + 2}px`;
    }

    const colgroup = document.createElement("colgroup");
    const colEls = [];
    for (let c = 0; c < colCount; c++) {
      const colEl = document.createElement("col");
      if (hasCustomWidths) {
        colEl.style.width = `${block.col_widths[c]}px`;
      }
      colgroup.appendChild(colEl);
      colEls.push(colEl);
    }
    table.appendChild(colgroup);

    const guideEl = document.createElement("div");
    guideEl.className = "table-col-guide";
    guideEl.setAttribute("aria-hidden", "true");

    const thead = document.createElement("thead");
    const tbody = document.createElement("tbody");

    for (let r = 0; r < rows.length; r++) {
      const tr = document.createElement("tr");
      tr.className = r === 0 ? "table-row-header" : "table-row-body";

      for (let c = 0; c < colCount; c++) {
        const cellTag = r === 0 ? "th" : "td";
        const cell = document.createElement(cellTag);
        cell.className = r === 0 ? "table-cell table-cell-th" : "table-cell table-cell-td";
        cell.dataset.col = String(c);
        const align = block.alignments[c] || "";
        if (align) {
          cell.style.textAlign = align;
        }

        if (r === 0) {
          const colHandle = document.createElement("button");
          colHandle.type = "button";
          colHandle.className = "table-col-handle";
          colHandle.title = "Column options";
          colHandle.setAttribute("aria-label", `Column ${c + 1} options`);
          colHandle.textContent = "⋯";
          colHandle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
          colHandle.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openTableColumnMenu(block.id, c, colHandle);
          });
          cell.appendChild(colHandle);
        }

        if (c === 0) {
          const rowHandle = document.createElement("button");
          rowHandle.type = "button";
          rowHandle.className = "table-row-handle";
          rowHandle.title = "Row options";
          rowHandle.setAttribute("aria-label", `Row ${r + 1} options`);
          rowHandle.textContent = "⋮";
          rowHandle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
          });
          rowHandle.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openTableRowMenu(block.id, r, rowHandle);
          });
          cell.appendChild(rowHandle);
        }

        const cellEditable = document.createElement("div");
        cellEditable.className = "table-cell-editable";
        cellEditable.contentEditable = "true";
        cellEditable.spellcheck = true;
        cellEditable.dataset.row = String(r);
        cellEditable.dataset.col = String(c);
        cellEditable.dataset.placeholder = r === 0 ? `Col ${c + 1}` : "";
        cellEditable.innerHTML = inlineMarkdownToHtml(rows[r][c] || "", pageLookup);

        this.attachTableCellHandlers(cellEditable, block.id, r, c);
        cell.appendChild(cellEditable);

        const colResizer = document.createElement("div");
        colResizer.className = "table-col-resizer";
        colResizer.dataset.col = String(c);
        colResizer.title = "Drag to resize column · Double-click to auto-fit";
        this.attachTableColResizerHandlers(
          colResizer,
          block.id,
          c,
          wrap,
          inner,
          table,
          colEls,
          guideEl
        );
        cell.appendChild(colResizer);

        tr.appendChild(cell);
      }

      if (r === 0) {
        thead.appendChild(tr);
      } else {
        tbody.appendChild(tr);
      }
    }

    table.appendChild(thead);
    if (rows.length > 1) {
      table.appendChild(tbody);
    }
    inner.appendChild(table);
    inner.appendChild(guideEl);
    scroll.appendChild(inner);

    const addColBtn = document.createElement("button");
    addColBtn.type = "button";
    addColBtn.className = "table-expand-btn table-add-col-btn";
    addColBtn.title = "Click to add column · Drag to resize";
    addColBtn.setAttribute("aria-label", "Add column");
    addColBtn.textContent = "+";
    this.attachTableExpandButtonHandlers(addColBtn, block.id, "col");

    const addRowBtn = document.createElement("button");
    addRowBtn.type = "button";
    addRowBtn.className = "table-expand-btn table-add-row-btn";
    addRowBtn.title = "Click to add row · Drag to resize";
    addRowBtn.setAttribute("aria-label", "Add row");
    addRowBtn.textContent = "+";
    this.attachTableExpandButtonHandlers(addRowBtn, block.id, "row");

    const addBothBtn = document.createElement("button");
    addBothBtn.type = "button";
    addBothBtn.className = "table-expand-btn table-add-both-btn";
    addBothBtn.title = "Click to add row & column · Drag to resize";
    addBothBtn.setAttribute("aria-label", "Add row and column");
    addBothBtn.textContent = "+";
    this.attachTableExpandButtonHandlers(addBothBtn, block.id, "both");

    wrap.appendChild(scroll);
    wrap.appendChild(addColBtn);
    wrap.appendChild(addRowBtn);
    wrap.appendChild(addBothBtn);
    return wrap;
  }

  positionTableColGuide(innerEl, guideEl, colIdx) {
    const th = innerEl?.querySelector(`thead th[data-col="${colIdx}"]`);
    if (!th || !guideEl) return;
    const left = Math.round(th.getBoundingClientRect().right - innerEl.getBoundingClientRect().left) - 1;
    guideEl.style.left = `${left}px`;
  }

  attachTableColResizerHandlers(
    resizerEl,
    blockId,
    colIdx,
    wrapEl,
    innerEl,
    tableEl,
    colEls,
    guideEl
  ) {
    resizerEl.addEventListener("mouseenter", () => {
      if (!this.tableColResize?.started) {
        this.positionTableColGuide(innerEl, guideEl, colIdx);
        guideEl.classList.add("visible");
      }
    });
    resizerEl.addEventListener("mouseleave", () => {
      if (!this.tableColResize?.started) {
        guideEl.classList.remove("visible");
      }
    });
    resizerEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    resizerEl.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.closeTableMenu();
      this.closeBlockMenu();
      this.closeSlashMenu();
      this.linkAutocomplete.close();
      this.hideSelectionToolbar();
      this.cleanupTableColResize(false);

      this.syncAllEditableFromDom();
      const block = this.blocks.find((b) => b.id === blockId);
      if (!block || block.type !== "table") return;

      const ths = Array.from(tableEl.querySelectorAll("thead th"));
      const startWidths =
        ths.length === colEls.length
          ? ths.map((th) =>
              Math.max(TABLE_MIN_COL_WIDTH, Math.round(th.getBoundingClientRect().width))
            )
          : colEls.map((_, i) => block.col_widths?.[i] || TABLE_DEFAULT_COL_WIDTH);

      const origColWidths = Array.isArray(block.col_widths) ? block.col_widths.slice() : [];

      try {
        resizerEl.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture is unavailable
      }

      this.tableColResize = {
        blockId,
        colIdx,
        startX: e.clientX,
        started: false,
        snapshotTaken: false,
        startWidths,
        currentWidths: startWidths.slice(),
        origColWidths,
        wrapEl,
        innerEl,
        tableEl,
        colEls,
        guideEl,
        captureEl: resizerEl,
        pointerId: e.pointerId,
      };
    });
    resizerEl.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cleanupTableColResize(false);
      this.autoFitTableColumn(blockId, colIdx);
    });
  }

  handleTableColResizeMove(e) {
    const drag = this.tableColResize;
    if (!drag) return;

    const dx = e.clientX - drag.startX;
    if (!drag.started) {
      if (Math.abs(dx) < 3) return;
      const block = this.blocks.find((b) => b.id === drag.blockId);
      if (!block || block.type !== "table") {
        this.cleanupTableColResize(false);
        return;
      }
      this.pushUndoSnapshot();
      drag.snapshotTaken = true;
      drag.started = true;
      drag.wrapEl.classList.add("has-col-widths");
      drag.tableEl.classList.add("has-col-widths");
      drag.startWidths.forEach((w, i) => {
        if (drag.colEls[i]) drag.colEls[i].style.width = `${w}px`;
      });
      const initTotal = drag.startWidths.reduce((s, w) => s + w, 0);
      drag.tableEl.style.width = `${initTotal + 2}px`;
      document.body.classList.add("is-resizing-table-col");
      drag.guideEl.classList.add("visible", "dragging");
    }

    const nextW = Math.max(
      TABLE_MIN_COL_WIDTH,
      Math.min(TABLE_MAX_COL_WIDTH, Math.round(drag.startWidths[drag.colIdx] + dx))
    );
    drag.currentWidths[drag.colIdx] = nextW;
    if (drag.colEls[drag.colIdx]) {
      drag.colEls[drag.colIdx].style.width = `${nextW}px`;
    }
    const total = drag.currentWidths.reduce((s, w) => s + w, 0);
    drag.tableEl.style.width = `${total + 2}px`;

    const block = this.blocks.find((b) => b.id === drag.blockId);
    if (block && block.type === "table") {
      block.col_widths = drag.currentWidths.slice();
    }
    this.positionTableColGuide(drag.innerEl, drag.guideEl, drag.colIdx);
  }

  handleTableColResizeUp() {
    const drag = this.tableColResize;
    if (!drag) return;
    if (drag.started) {
      const block = this.blocks.find((b) => b.id === drag.blockId);
      if (block && block.type === "table") {
        block.col_widths = drag.currentWidths.slice();
      }
      this.cleanupTableColResize(false);
      this.onDirty();
    } else {
      this.cleanupTableColResize(false);
    }
  }

  cleanupTableColResize(revert = false) {
    const drag = this.tableColResize;
    if (!drag) return;
    if (drag.captureEl && drag.pointerId !== undefined) {
      try {
        if (drag.captureEl.hasPointerCapture?.(drag.pointerId)) {
          drag.captureEl.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // Ignore capture release error
      }
    }
    if (drag.guideEl) {
      drag.guideEl.classList.remove("visible", "dragging");
    }
    document.body.classList.remove("is-resizing-table-col");

    const shouldRevert = revert && drag.started;
    const { blockId, origColWidths, snapshotTaken } = drag;
    this.tableColResize = null;

    if (shouldRevert) {
      const block = this.blocks.find((b) => b.id === blockId);
      if (block && block.type === "table") {
        block.col_widths = origColWidths.slice();
      }
      if (snapshotTaken && this.undoStack.length > 0) {
        this.undoStack.pop();
      }
      this.render();
    }
  }

  autoFitTableColumn(blockId, colIdx) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;

    const rowEl = this.containerEl.querySelector(`.block-row[data-id="${CSS.escape(blockId)}"]`);
    const tableEl = rowEl?.querySelector(".block-table");
    if (!tableEl) return;

    const ths = Array.from(tableEl.querySelectorAll("thead th"));
    if (colIdx < 0 || colIdx >= ths.length) return;

    const widths =
      block.col_widths.length === ths.length
        ? block.col_widths.slice()
        : ths.map((th) =>
            Math.max(TABLE_MIN_COL_WIDTH, Math.round(th.getBoundingClientRect().width))
          );

    const measurer = document.createElement("div");
    measurer.style.position = "fixed";
    measurer.style.left = "-9999px";
    measurer.style.top = "-9999px";
    measurer.style.visibility = "hidden";
    measurer.style.whiteSpace = "nowrap";
    measurer.style.fontSize = "13.5px";
    measurer.style.lineHeight = "1.5";
    measurer.style.fontFamily = "var(--font-sans)";
    measurer.style.padding = "6px 10px";
    measurer.style.boxSizing = "border-box";
    document.body.appendChild(measurer);

    let maxWidth = 84;
    tableEl.querySelectorAll(`.table-cell-editable[data-col="${colIdx}"]`).forEach((cellEl) => {
      measurer.style.fontWeight = cellEl.closest("th") ? "600" : "400";
      const html = cellEl.innerHTML.trim();
      if (html) {
        measurer.innerHTML = html;
      } else {
        measurer.textContent = cellEl.dataset.placeholder || "";
      }
      const w = measurer.getBoundingClientRect().width;
      if (w > maxWidth) maxWidth = w;
    });
    measurer.remove();

    const idealWidth = Math.max(84, Math.min(480, Math.ceil(maxWidth) + 6));
    this.pushUndoSnapshot();
    widths[colIdx] = idealWidth;
    block.col_widths = widths;
    this.render(blockId, { row: 0, col: colIdx, atEnd: true });
    this.onDirty();
  }

  resetTableColumnWidths(blockId) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table" || !block.col_widths?.length) return;
    this.pushUndoSnapshot();
    block.col_widths = [];
    this.render(blockId, { row: 0, col: 0, atEnd: false });
    this.onDirty();
  }

  attachTableExpandButtonHandlers(btn, blockId, mode) {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.closeTableMenu();
      this.closeBlockMenu();
      this.closeSlashMenu();
      this.linkAutocomplete.close();
      this.hideSelectionToolbar();
      this.cleanupTableResizeDrag();

      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture is unavailable
      }

      this.tableResizeDrag = {
        blockId,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        snapshotTaken: false,
        initialRows: 0,
        initialCols: 0,
        minRows: 1,
        minCols: 1,
        captureEl: btn,
        pointerId: e.pointerId,
      };
    });
  }

  getMinNonEmptyRowCount(block) {
    const rows = Array.isArray(block?.rows) ? block.rows : [];
    for (let r = rows.length - 1; r >= 1; r--) {
      if (Array.isArray(rows[r]) && rows[r].some((cell) => String(cell || "").trim() !== "")) {
        return r + 1;
      }
    }
    return 1;
  }

  getMinNonEmptyColCount(block) {
    const rows = Array.isArray(block?.rows) ? block.rows : [];
    const colCount = rows[0]?.length || 1;
    for (let c = colCount - 1; c >= 1; c--) {
      if (rows.some((row) => String(row?.[c] || "").trim() !== "")) {
        return c + 1;
      }
    }
    return 1;
  }

  handleTableResizeMove(e) {
    const drag = this.tableResizeDrag;
    if (!drag) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;

    if (!drag.started) {
      if (Math.hypot(dx, dy) < 6) return;
      this.syncAllEditableFromDom();
      const block = this.blocks.find((b) => b.id === drag.blockId);
      if (!block || block.type !== "table") {
        this.cleanupTableResizeDrag();
        return;
      }
      const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
      block.rows = norm.rows;
      block.alignments = norm.alignments;
      block.col_widths = norm.col_widths;

      drag.started = true;
      drag.initialRows = block.rows.length;
      drag.initialCols = block.rows[0].length;
      drag.minRows = Math.max(1, this.getMinNonEmptyRowCount(block));
      drag.minCols = Math.max(1, this.getMinNonEmptyColCount(block));
      document.body.classList.add("is-resizing-table");
    }

    const block = this.blocks.find((b) => b.id === drag.blockId);
    if (!block || block.type !== "table") {
      this.cleanupTableResizeDrag();
      return;
    }

    const curRows = block.rows.length;
    const curCols = block.rows[0]?.length || 1;
    const colDelta = Math.round(dx / TABLE_COL_DRAG_STEP_PX);
    const rowDelta = Math.round(dy / TABLE_ROW_DRAG_STEP_PX);

    const desiredCols =
      drag.mode === "row"
        ? curCols
        : Math.max(drag.minCols, Math.min(20, drag.initialCols + colDelta));
    const desiredRows =
      drag.mode === "col"
        ? curRows
        : Math.max(drag.minRows, Math.min(60, drag.initialRows + rowDelta));

    if (desiredCols === curCols && desiredRows === curRows) return;

    if (!drag.snapshotTaken) {
      this.pushUndoSnapshot();
      drag.snapshotTaken = true;
    }

    while (block.alignments.length < desiredCols) block.alignments.push("");
    if (block.alignments.length > desiredCols) block.alignments.length = desiredCols;

    if (Array.isArray(block.col_widths) && block.col_widths.length > 0) {
      while (block.col_widths.length < desiredCols) block.col_widths.push(TABLE_DEFAULT_COL_WIDTH);
      if (block.col_widths.length > desiredCols) block.col_widths.length = desiredCols;
    }

    for (const row of block.rows) {
      while (row.length < desiredCols) row.push("");
      if (row.length > desiredCols) row.length = desiredCols;
    }
    while (block.rows.length < desiredRows) {
      block.rows.push(Array(desiredCols).fill(""));
    }
    if (block.rows.length > desiredRows) {
      block.rows.length = desiredRows;
    }

    this.render();
    this.onDirty();
  }

  handleTableResizeUp() {
    const drag = this.tableResizeDrag;
    if (!drag) return;
    const { started, blockId, mode } = drag;
    this.cleanupTableResizeDrag();

    if (!started) {
      if (mode === "col") this.addTableColumn(blockId);
      else if (mode === "row") this.addTableRow(blockId);
      else if (mode === "both") this.addTableRowAndColumn(blockId);
    }
  }

  cleanupTableResizeDrag() {
    const drag = this.tableResizeDrag;
    if (!drag) return;
    if (drag.captureEl && drag.pointerId !== undefined) {
      try {
        if (drag.captureEl.hasPointerCapture?.(drag.pointerId)) {
          drag.captureEl.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // Ignore capture release error
      }
    }
    document.body.classList.remove("is-resizing-table");
    this.tableResizeDrag = null;
  }

  addTableColumn(blockId, insertColIdx = null) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;

    const colCount = block.rows[0].length;
    if (colCount >= 20) return;
    const at =
      insertColIdx === null
        ? colCount
        : Math.max(0, Math.min(colCount, Number(insertColIdx)));

    this.pushUndoSnapshot();
    block.alignments.splice(at, 0, "");
    if (block.col_widths.length > 0) {
      block.col_widths.splice(at, 0, TABLE_DEFAULT_COL_WIDTH);
    }
    for (const row of block.rows) {
      row.splice(at, 0, "");
    }
    this.render(blockId, { row: 0, col: at, atEnd: false });
    this.onDirty();
  }

  addTableRow(blockId, insertRowIdx = null) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;

    const colCount = block.rows[0].length;
    if (block.rows.length >= 60) return;
    const at =
      insertRowIdx === null
        ? block.rows.length
        : Math.max(1, Math.min(block.rows.length, Number(insertRowIdx)));

    this.pushUndoSnapshot();
    block.rows.splice(at, 0, Array(colCount).fill(""));
    this.render(blockId, { row: at, col: 0, atEnd: false });
    this.onDirty();
  }

  addTableRowAndColumn(blockId) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;

    if (block.rows[0].length >= 20 && block.rows.length >= 60) return;

    this.pushUndoSnapshot();
    if (block.rows[0].length < 20) {
      block.alignments.push("");
      if (block.col_widths.length > 0) {
        block.col_widths.push(TABLE_DEFAULT_COL_WIDTH);
      }
      for (const row of block.rows) {
        row.push("");
      }
    }
    if (block.rows.length < 60) {
      block.rows.push(Array(block.rows[0].length).fill(""));
    }
    const newRow = block.rows.length - 1;
    const newCol = block.rows[0].length - 1;
    this.render(blockId, { row: newRow, col: newCol, atEnd: false });
    this.onDirty();
  }

  duplicateTableColumn(blockId, colIdx) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;
    if (block.rows[0].length >= 20 || colIdx < 0 || colIdx >= block.rows[0].length) return;

    this.pushUndoSnapshot();
    block.alignments.splice(colIdx + 1, 0, block.alignments[colIdx] || "");
    if (block.col_widths.length > 0) {
      block.col_widths.splice(colIdx + 1, 0, block.col_widths[colIdx] || TABLE_DEFAULT_COL_WIDTH);
    }
    for (const row of block.rows) {
      row.splice(colIdx + 1, 0, row[colIdx] || "");
    }
    this.render(blockId, { row: 0, col: colIdx + 1, atEnd: false });
    this.onDirty();
  }

  deleteTableColumn(blockId, colIdx) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;
    if (block.rows[0].length <= 1 || colIdx < 0 || colIdx >= block.rows[0].length) return;

    this.pushUndoSnapshot();
    block.alignments.splice(colIdx, 1);
    if (block.col_widths.length > 0) {
      block.col_widths.splice(colIdx, 1);
    }
    for (const row of block.rows) {
      row.splice(colIdx, 1);
    }
    const nextCol = Math.max(0, Math.min(colIdx, block.rows[0].length - 1));
    this.render(blockId, { row: 0, col: nextCol, atEnd: false });
    this.onDirty();
  }

  setTableColumnAlignment(blockId, colIdx, align) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;
    if (colIdx < 0 || colIdx >= block.alignments.length) return;

    this.pushUndoSnapshot();
    block.alignments[colIdx] = align;
    this.render(blockId, { row: 0, col: colIdx, atEnd: true });
    this.onDirty();
  }

  duplicateTableRow(blockId, rowIdx) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;
    if (block.rows.length >= 60 || rowIdx < 0 || rowIdx >= block.rows.length) return;

    this.pushUndoSnapshot();
    const copy = block.rows[rowIdx].slice();
    block.rows.splice(rowIdx + 1, 0, copy);
    this.render(blockId, { row: rowIdx + 1, col: 0, atEnd: false });
    this.onDirty();
  }

  moveTableRow(blockId, rowIdx, delta) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;
    const nextIdx = rowIdx + delta;
    if (rowIdx < 1 || nextIdx < 1 || nextIdx >= block.rows.length) return;

    this.pushUndoSnapshot();
    const [moved] = block.rows.splice(rowIdx, 1);
    block.rows.splice(nextIdx, 0, moved);
    this.render(blockId, { row: nextIdx, col: 0, atEnd: false });
    this.onDirty();
  }

  deleteTableRow(blockId, rowIdx) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const norm = normalizeTableData(block.rows, block.alignments, block.col_widths);
    block.rows = norm.rows;
    block.alignments = norm.alignments;
    block.col_widths = norm.col_widths;
    if (rowIdx < 0 || rowIdx >= block.rows.length) return;

    this.pushUndoSnapshot();
    if (rowIdx === 0) {
      block.rows[0] = block.rows[0].map(() => "");
      this.render(blockId, { row: 0, col: 0, atEnd: false });
    } else {
      block.rows.splice(rowIdx, 1);
      const nextRow = Math.max(0, Math.min(rowIdx, block.rows.length - 1));
      this.render(blockId, { row: nextRow, col: 0, atEnd: false });
    }
    this.onDirty();
  }

  openTableColumnMenu(blockId, colIdx, anchorEl) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const colCount = block.rows[0]?.length || 1;
    const curAlign = block.alignments?.[colIdx] || "";
    const hasCustomWidths = Array.isArray(block.col_widths) && block.col_widths.length > 0;

    const actions = [
      { label: "Insert column left", run: () => this.addTableColumn(blockId, colIdx), disabled: colCount >= 20 },
      { label: "Insert column right", run: () => this.addTableColumn(blockId, colIdx + 1), disabled: colCount >= 20 },
      { label: "Duplicate column", run: () => this.duplicateTableColumn(blockId, colIdx), disabled: colCount >= 20 },
      { divider: true },
      { label: "Auto-fit column", run: () => this.autoFitTableColumn(blockId, colIdx) },
      ...(hasCustomWidths
        ? [{ label: "Reset column widths", run: () => this.resetTableColumnWidths(blockId) }]
        : []),
      { divider: true },
      { section: "Alignment" },
      { label: `${curAlign === "left" ? "✓ " : ""}Align left`, run: () => this.setTableColumnAlignment(blockId, colIdx, "left") },
      { label: `${curAlign === "center" ? "✓ " : ""}Align center`, run: () => this.setTableColumnAlignment(blockId, colIdx, "center") },
      { label: `${curAlign === "right" ? "✓ " : ""}Align right`, run: () => this.setTableColumnAlignment(blockId, colIdx, "right") },
      { label: `${curAlign === "" ? "✓ " : ""}Default alignment`, run: () => this.setTableColumnAlignment(blockId, colIdx, "") },
      { divider: true },
      { label: "Delete column", danger: true, disabled: colCount <= 1, run: () => this.deleteTableColumn(blockId, colIdx) },
    ];

    this.showTableMenu(actions, anchorEl);
  }

  openTableRowMenu(blockId, rowIdx, anchorEl) {
    this.syncAllEditableFromDom();
    const block = this.blocks.find((b) => b.id === blockId);
    if (!block || block.type !== "table") return;
    const rowCount = block.rows.length;

    const actions = [];
    if (rowIdx >= 1) {
      actions.push({
        label: "Insert row above",
        run: () => this.addTableRow(blockId, rowIdx),
        disabled: rowCount >= 60,
      });
    }
    actions.push(
      {
        label: "Insert row below",
        run: () => this.addTableRow(blockId, rowIdx + 1),
        disabled: rowCount >= 60,
      },
      {
        label: "Duplicate row",
        run: () => this.duplicateTableRow(blockId, rowIdx),
        disabled: rowCount >= 60,
      }
    );
    if (rowIdx >= 1) {
      actions.push(
        { divider: true },
        { label: "Move row up", run: () => this.moveTableRow(blockId, rowIdx, -1), disabled: rowIdx <= 1 },
        { label: "Move row down", run: () => this.moveTableRow(blockId, rowIdx, 1), disabled: rowIdx >= rowCount - 1 }
      );
    }
    actions.push(
      { divider: true },
      {
        label: rowIdx === 0 ? "Clear header row" : "Delete row",
        danger: true,
        run: () => this.deleteTableRow(blockId, rowIdx),
      }
    );

    this.showTableMenu(actions, anchorEl);
  }

  showTableMenu(actions, anchorEl) {
    this.closeBlockMenu();
    this.closeSlashMenu();
    this.tableMenuEl.innerHTML = actions
      .map((a, i) => {
        if (a.section) return `<div class="popover-section-label">${escapeHtml(a.section)}</div>`;
        if (a.divider) return `<div class="popover-divider"></div>`;
        const cls = a.danger ? "popover-item danger" : "popover-item";
        return `<button class="${cls}" data-idx="${i}" ${a.disabled ? "disabled" : ""} type="button" role="menuitem"><span>${escapeHtml(a.label)}</span></button>`;
      })
      .join("");

    this.tableMenuEl.hidden = false;
    const anchorRect = anchorEl.getBoundingClientRect();
    const popRect = this.tableMenuEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, anchorRect.left));
    const top = Math.max(
      8,
      Math.min(window.innerHeight - popRect.height - 8, anchorRect.bottom + 4)
    );
    this.tableMenuEl.style.left = `${left}px`;
    this.tableMenuEl.style.top = `${top}px`;

    this.tableMenuEl.querySelectorAll(".popover-item").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const item = actions[Number(btn.dataset.idx)];
        this.closeTableMenu();
        if (item?.run && !item.disabled) item.run();
      });
    });
  }

  closeTableMenu() {
    if (!this.tableMenuEl) return;
    this.tableMenuEl.hidden = true;
    this.tableMenuEl.innerHTML = "";
  }

  attachTableCellHandlers(cellEl, blockId, rowIdx, colIdx) {
    let undoArmed = true;

    cellEl.addEventListener("click", (e) => {
      const linkSpan = e.target.closest(".page-link");
      if (linkSpan) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) return;
        const target = linkSpan.dataset.target;
        if (target) this.onOpenLink(target);
      }
    });

    cellEl.addEventListener("paste", (e) => {
      const imgFile = extractClipboardImage(e.clipboardData);
      if (imgFile) {
        e.preventDefault();
        this.insertImageFromFile(imgFile, blockId);
        return;
      }
      e.preventDefault();
      const plain = e.clipboardData?.getData("text/plain") || "";
      if (!plain) return;

      const b = this.blocks.find((x) => x.id === blockId);
      const isTableEmpty =
        b &&
        b.type === "table" &&
        b.rows.every((r) => r.every((c) => String(c || "").trim() === ""));
      const parsedTable = isTableEmpty ? tryParseMarkdownTable(plain.trim()) : null;
      if (parsedTable) {
        this.pushUndoSnapshot();
        const norm = normalizeTableData(parsedTable.rows, parsedTable.alignments);
        b.rows = norm.rows;
        b.alignments = norm.alignments;
        this.render(blockId, { row: 0, col: 0, atEnd: false });
        this.onDirty();
        return;
      }

      this.pushUndoSnapshot();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const lines = plain.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      const frag = document.createDocumentFragment();
      let lastNode = null;
      lines.forEach((line, i) => {
        if (i > 0) {
          const br = document.createElement("br");
          frag.appendChild(br);
          lastNode = br;
        }
        const tn = document.createTextNode(line);
        frag.appendChild(tn);
        lastNode = tn;
      });
      range.insertNode(frag);
      if (lastNode) {
        range.setStartAfter(lastNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      cellEl.dispatchEvent(new Event("input", { bubbles: true }));
    });

    cellEl.addEventListener("input", () => {
      const idx = this.blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      if (undoArmed) {
        this.pushUndoSnapshot();
        undoArmed = false;
      }

      tryAutoFormatInline(cellEl);
      this.syncEditableElToBlock(cellEl, idx);
      this.linkAutocomplete.inspectCaret(cellEl);
      this.onDirty();
    });

    cellEl.addEventListener("blur", () => {
      undoArmed = true;
    });

    cellEl.addEventListener("keydown", (e) => {
      if (this.linkAutocomplete.handleKeyDown(e)) return;

      const idx = this.blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;
      const block = this.blocks[idx];
      if (!block || block.type !== "table") return;

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        this.toggleInlineTag("STRONG");
        return;
      }

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        this.toggleInlineTag("CODE");
        return;
      }

      const rowCount = block.rows.length;
      const colCount = block.rows[0]?.length || 1;

      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        this.syncAllEditableFromDom();
        if (e.shiftKey) {
          if (colIdx > 0) {
            this.focusTableCell(blockId, rowIdx, colIdx - 1, true);
          } else if (rowIdx > 0) {
            this.focusTableCell(blockId, rowIdx - 1, colCount - 1, true);
          }
          return;
        }
        if (colIdx + 1 < colCount) {
          this.focusTableCell(blockId, rowIdx, colIdx + 1, false);
        } else if (rowIdx + 1 < rowCount) {
          this.focusTableCell(blockId, rowIdx + 1, 0, false);
        } else {
          this.addTableRow(blockId);
        }
        return;
      }

      if (e.key === "Enter") {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.insertParagraphAfter(idx);
          return;
        }
        if (e.shiftKey) {
          return;
        }
        e.preventDefault();
        this.syncAllEditableFromDom();
        if (rowIdx + 1 < rowCount) {
          this.focusTableCell(blockId, rowIdx + 1, colIdx, false);
          return;
        }
        const curRowHasText = block.rows[rowIdx]?.some((c) => String(c || "").trim() !== "");
        if (rowCount === 1 || curRowHasText) {
          this.addTableRow(blockId);
        } else {
          const next = this.findNextVisibleBlock(idx);
          if (next) {
            this.focusBlock(next.id, "start");
          } else {
            this.insertParagraphAfter(idx);
          }
        }
        return;
      }

      if (e.key === "Backspace") {
        const sel = window.getSelection();
        if (sel && sel.isCollapsed && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          if (
            range.startContainer.nodeType === Node.TEXT_NODE &&
            range.startOffset === 0 &&
            range.startContainer.previousSibling?.classList?.contains("page-link")
          ) {
            e.preventDefault();
            this.pushUndoSnapshot();
            range.startContainer.previousSibling.remove();
            this.syncEditableElToBlock(cellEl, idx);
            this.onDirty();
            return;
          }
          if (range.startContainer === cellEl && range.startOffset > 0) {
            const prevChild = cellEl.childNodes[range.startOffset - 1];
            if (prevChild?.classList?.contains("page-link")) {
              e.preventDefault();
              this.pushUndoSnapshot();
              prevChild.remove();
              this.syncEditableElToBlock(cellEl, idx);
              this.onDirty();
              return;
            }
          }
        }

        const offset = getCaretOffsetInText(cellEl);
        if (offset === 0 && sel?.isCollapsed && rowIdx === 0 && colIdx === 0) {
          this.syncAllEditableFromDom();
          const allEmpty = block.rows.every((r) =>
            r.every((c) => String(c || "").trim() === "")
          );
          if (allEmpty) {
            e.preventDefault();
            this.pushUndoSnapshot();
            this.blocks[idx] = { id: block.id, type: "paragraph", content: "" };
            this.render(block.id, "start");
            this.onDirty();
            return;
          }
        }
      }

      const isMultiLine =
        (cellEl.textContent || "").includes("\n") || Boolean(cellEl.querySelector("br"));

      if (e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!isMultiLine || getCaretOffsetInText(cellEl) === 0) {
          e.preventDefault();
          if (rowIdx > 0) {
            this.focusTableCell(blockId, rowIdx - 1, colIdx, false);
          } else {
            const prev = this.findPreviousVisibleBlock(idx);
            if (prev) this.focusBlock(prev.id, "end");
          }
        }
      } else if (e.key === "ArrowDown" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (!isMultiLine || getCaretOffsetInText(cellEl) >= getTotalTextLength(cellEl)) {
          e.preventDefault();
          if (rowIdx + 1 < rowCount) {
            this.focusTableCell(blockId, rowIdx + 1, colIdx, false);
          } else {
            const next = this.findNextVisibleBlock(idx);
            if (next) this.focusBlock(next.id, "start");
          }
        }
      }
    });
  }

  async insertImageFromFile(file, anchorBlockId = null) {
    if (!file || !this.onSavePastedImage) return;
    let dataUrl;
    try {
      dataUrl = await readFileAsDataUrl(file);
    } catch {
      return;
    }
    const src = await this.onSavePastedImage(dataUrl);
    if (!src) return;

    this.syncAllEditableFromDom();
    this.pushUndoSnapshot();

    let insertBlockId;
    const anchorIdx = anchorBlockId
      ? this.blocks.findIndex((b) => b.id === anchorBlockId)
      : this.blocks.length - 1;

    if (anchorIdx !== -1) {
      const anchor = this.blocks[anchorIdx];
      if (anchor.type === "heading" && this.collapsedIds.has(anchor.id)) {
        this.collapsedIds.delete(anchor.id);
        this.onCollapseChange(this.getCollapsedIndices());
      }
      if (anchor.type === "paragraph" && anchor.content.trim() === "") {
        this.blocks[anchorIdx] = { id: anchor.id, type: "image", src, alt: "" };
        insertBlockId = anchor.id;
        if (anchorIdx === this.blocks.length - 1) {
          this.blocks.push({ id: genBlockId(), type: "paragraph", content: "" });
        }
      } else {
        insertBlockId = genBlockId();
        this.blocks.splice(anchorIdx + 1, 0, { id: insertBlockId, type: "image", src, alt: "" });
        if (anchorIdx + 1 === this.blocks.length - 1) {
          this.blocks.push({ id: genBlockId(), type: "paragraph", content: "" });
        }
      }
    } else {
      insertBlockId = genBlockId();
      this.blocks.push({ id: insertBlockId, type: "image", src, alt: "" });
      this.blocks.push({ id: genBlockId(), type: "paragraph", content: "" });
    }

    this.render(insertBlockId, "start");
    this.onDirty();
  }

  attachEditableHandlers(editable, blockId) {
    let undoArmed = true;

    editable.addEventListener("click", (e) => {
      const linkSpan = e.target.closest(".page-link");
      if (linkSpan) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) return;
        const target = linkSpan.dataset.target;
        if (target) this.onOpenLink(target);
      }
    });

    editable.addEventListener("paste", (e) => {
      const imgFile = extractClipboardImage(e.clipboardData);
      if (imgFile) {
        e.preventDefault();
        this.insertImageFromFile(imgFile, blockId);
        return;
      }
      e.preventDefault();
      const plain = e.clipboardData?.getData("text/plain") || "";
      if (!plain) return;

      const parsedTable = tryParseMarkdownTable(plain.trim());
      if (parsedTable) {
        this.syncAllEditableFromDom();
        const curIdx = this.blocks.findIndex((b) => b.id === blockId);
        if (curIdx !== -1) {
          this.pushUndoSnapshot();
          const norm = normalizeTableData(parsedTable.rows, parsedTable.alignments);
          const curBlock = this.blocks[curIdx];
          if (curBlock.type === "paragraph" && domToInlineMarkdown(editable).trim() === "") {
            this.blocks[curIdx] = { id: curBlock.id, type: "table", ...norm };
            this.render(curBlock.id, { row: 0, col: 0, atEnd: false });
          } else {
            const nb = { id: genBlockId(), type: "table", ...norm };
            this.blocks.splice(curIdx + 1, 0, nb);
            this.render(nb.id, { row: 0, col: 0, atEnd: false });
          }
          this.onDirty();
          return;
        }
      }

      this.pushUndoSnapshot();
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = document.createTextNode(plain);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      editable.dispatchEvent(new Event("input", { bubbles: true }));
    });

    editable.addEventListener("input", () => {
      const idx = this.blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;

      if (undoArmed) {
        this.pushUndoSnapshot();
        undoArmed = false;
      }

      // Check block-start markdown shortcuts on paragraph
      const block = this.blocks[idx];
      const rawMd = domToInlineMarkdown(editable);

      if (block.type === "paragraph") {
        // Heading trigger: # , ## , ### (with trailing space or nbsp)
        const hMatch = rawMd.match(/^(#{1,3})[\u00A0 ]([\s\S]*)$/);
        if (hMatch) {
          const level = hMatch[1].length;
          const rest = hMatch[2];
          this.blocks[idx] = { id: block.id, type: "heading", level, content: rest };
          this.render(block.id, "start");
          this.onDirty();
          return;
        }

        // Code block trigger: ``` or ```lang + space
        const codeMatch = rawMd.match(/^```([a-zA-Z0-9_+-]*)[\u00A0 ]$/);
        if (codeMatch) {
          this.blocks[idx] = {
            id: block.id,
            type: "code",
            language: codeMatch[1] || "",
            content: "",
          };
          this.render(block.id, "start");
          this.onDirty();
          return;
        }

        // Divider trigger: --- / *** / ___ + space
        if (/^(?:---|[*]{3}|___)[\u00A0 ]$/.test(rawMd)) {
          this.blocks[idx] = { id: block.id, type: "divider" };
          let focusId = block.id;
          if (idx === this.blocks.length - 1) {
            const np = { id: genBlockId(), type: "paragraph", content: "" };
            this.blocks.push(np);
            focusId = np.id;
          } else {
            focusId = this.blocks[idx + 1].id;
          }
          this.render(focusId, "start");
          this.onDirty();
          return;
        }

        // To-do checklist trigger: - [ ] , - [x] , [] + space
        const todoMatch = rawMd.match(/^(?:[-*+][\u00A0 ]*\[([ xX])\]|\[\])[\u00A0 ]([\s\S]*)$/);
        if (todoMatch) {
          this.blocks[idx] = {
            id: block.id,
            type: "todo",
            checked: /[xX]/.test(todoMatch[1] || ""),
            content: todoMatch[2] || "",
          };
          this.render(block.id, "start");
          this.onDirty();
          return;
        }

        // Bullet list trigger: - , * , + + space
        const bulletMatch = rawMd.match(/^([-*+])[\u00A0 ]([\s\S]*)$/);
        if (bulletMatch) {
          this.blocks[idx] = {
            id: block.id,
            type: "bullet_list",
            content: bulletMatch[2] || "",
          };
          this.render(block.id, "start");
          this.onDirty();
          return;
        }

        // Numbered list trigger: 1. + space
        const numMatch = rawMd.match(/^(\d+)\.[\u00A0 ]([\s\S]*)$/);
        if (numMatch) {
          this.blocks[idx] = {
            id: block.id,
            type: "numbered_list",
            content: numMatch[2] || "",
          };
          this.render(block.id, "start");
          this.onDirty();
          return;
        }

        // Quote trigger: > + space
        const quoteMatch = rawMd.match(/^>[\u00A0 ]([\s\S]*)$/);
        if (quoteMatch) {
          this.blocks[idx] = {
            id: block.id,
            type: "quote",
            content: quoteMatch[1] || "",
          };
          this.render(block.id, "start");
          this.onDirty();
          return;
        }

        // Slash menu trigger: /...
        const slashMatch = rawMd.match(/^\/([^\n]*)$/);
        if (slashMatch) {
          this.openSlashMenu(block.id, editable, slashMatch[1]);
        } else if (this.slashState.active && this.slashState.blockId === blockId) {
          this.closeSlashMenu();
        }
      }

      tryAutoFormatInline(editable);
      this.blocks[idx].content = domToInlineMarkdown(editable);
      this.linkAutocomplete.inspectCaret(editable);
      this.onDirty();
    });

    editable.addEventListener("blur", () => {
      undoArmed = true;
    });

    editable.addEventListener("keydown", (e) => {
      if (this.linkAutocomplete.handleKeyDown(e)) return;
      if (this.handleSlashKeyDown(e)) return;

      const idx = this.blocks.findIndex((b) => b.id === blockId);
      if (idx === -1) return;
      const block = this.blocks[idx];

      // Ctrl+B -> Bold
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        this.toggleInlineTag("STRONG");
        return;
      }

      // Ctrl+I -> Italic
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        this.toggleInlineTag("EM");
        return;
      }

      // Ctrl+E -> Inline Code (Ctrl+` / Ctrl+~ is reserved for integrated terminal)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        this.toggleInlineTag("CODE");
        return;
      }

      // Shift+Tab -> Outdent block out of parent heading; Tab -> Re-indent previously outdented block
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (block.type !== "heading") {
          if (e.shiftKey) {
            const { depths } = this.computeVisibility();
            if (depths[idx] > 0) {
              e.preventDefault();
              const caretOffset = getCaretOffsetInText(editable);
              this.pushUndoSnapshot();
              block.outdent = (block.outdent || 0) + 1;
              this.render(block.id, "offset", caretOffset);
              this.onDirty();
              this.onCollapseChange(this.getCollapsedIndices());
              return;
            }
          } else if ((block.outdent || 0) > 0) {
            e.preventDefault();
            const caretOffset = getCaretOffsetInText(editable);
            this.pushUndoSnapshot();
            if (block.outdent > 1) {
              block.outdent -= 1;
            } else {
              delete block.outdent;
            }
            this.render(block.id, "offset", caretOffset);
            this.onDirty();
            this.onCollapseChange(this.getCollapsedIndices());
            return;
          }
        }
      }

      // Enter key
      if (e.key === "Enter") {
        if (e.shiftKey) {
          // Soft newline within block
          return;
        }
        e.preventDefault();
        const currentMd = domToInlineMarkdown(editable);

        // ``` or ```lang + Enter -> Code block, --- -> Divider, or Markdown table autogeneration
        if (block.type === "paragraph") {
          const codeEnter = currentMd.match(/^```([a-zA-Z0-9_+-]*)$/);
          if (codeEnter) {
            this.pushUndoSnapshot();
            this.blocks[idx] = {
              id: block.id,
              type: "code",
              language: codeEnter[1] || "",
              content: "",
            };
            this.render(block.id, "start");
            this.onDirty();
            return;
          }

          if (/^(?:---|[*]{3}|___)$/.test(currentMd.trim())) {
            this.pushUndoSnapshot();
            this.blocks[idx] = { id: block.id, type: "divider" };
            const np = { id: genBlockId(), type: "paragraph", content: "" };
            this.blocks.splice(idx + 1, 0, np);
            this.render(np.id, "start");
            this.onDirty();
            return;
          }

          const fullTable = tryParseMarkdownTable(currentMd);
          if (fullTable) {
            this.pushUndoSnapshot();
            const norm = normalizeTableData(fullTable.rows, fullTable.alignments);
            if (norm.rows.length === 1) {
              norm.rows.push(Array(norm.alignments.length).fill(""));
            }
            this.blocks[idx] = { id: block.id, type: "table", ...norm };
            this.render(block.id, { row: 1, col: 0, atEnd: false });
            this.onDirty();
            return;
          }

          if (idx > 0 && this.blocks[idx - 1]?.type === "paragraph") {
            const prevHeaders = splitPipeRow(this.blocks[idx - 1].content || "");
            const delimAligns = parseDelimiterRow(currentMd);
            if (prevHeaders && delimAligns && prevHeaders.length === delimAligns.length) {
              this.pushUndoSnapshot();
              const norm = normalizeTableData(
                [prevHeaders, Array(prevHeaders.length).fill("")],
                delimAligns
              );
              const prevBlock = this.blocks[idx - 1];
              this.blocks[idx - 1] = { id: prevBlock.id, type: "table", ...norm };
              this.blocks.splice(idx, 1);
              this.render(prevBlock.id, { row: 1, col: 0, atEnd: false });
              this.onDirty();
              return;
            }
          }
        }

        // Expand collapsed heading before inserting paragraph beneath it
        if (block.type === "heading" && this.collapsedIds.has(block.id)) {
          this.collapsedIds.delete(block.id);
          this.onCollapseChange(this.getCollapsedIndices());
        }

        const { before, after } = extractInlineMdBeforeAndAfterCaret(editable);
        if (block.type === "paragraph" && after.trim() === "") {
          const pipeHeaders = tryParseSinglePipeHeaderTrigger(currentMd);
          if (pipeHeaders) {
            this.pushUndoSnapshot();
            const norm = normalizeTableData([pipeHeaders, pipeHeaders.map(() => "")], []);
            this.blocks[idx] = { id: block.id, type: "table", ...norm };
            const allEmpty = pipeHeaders.every((h) => !h.trim());
            this.render(block.id, { row: allEmpty ? 0 : 1, col: 0, atEnd: false });
            this.onDirty();
            return;
          }
        }
        this.pushUndoSnapshot();
        if (
          (block.type === "bullet_list" ||
            block.type === "numbered_list" ||
            block.type === "todo" ||
            block.type === "quote") &&
          before.trim() === "" &&
          after.trim() === ""
        ) {
          const styleBase = {};
          if (isValidColorName(block.color)) styleBase.color = block.color;
          if (isValidColorName(block.bg)) styleBase.bg = block.bg;
          if (block.outdent > 0) styleBase.outdent = block.outdent;
          this.blocks[idx] = { id: block.id, ...styleBase, type: "paragraph", content: "" };
          this.render(block.id, "start");
          this.onDirty();
          return;
        }
        this.blocks[idx].content = before;
        let nextBlock;
        if (block.type === "bullet_list" || block.type === "numbered_list" || block.type === "todo") {
          nextBlock = {
            id: genBlockId(),
            type: block.type,
            ...(block.type === "todo" ? { checked: false } : {}),
            ...(block.outdent > 0 ? { outdent: block.outdent } : {}),
            content: after,
          };
        } else {
          nextBlock = {
            id: genBlockId(),
            type: "paragraph",
            ...(block.outdent > 0 ? { outdent: block.outdent } : {}),
            content: after,
          };
        }
        this.blocks.splice(idx + 1, 0, nextBlock);
        this.render(nextBlock.id, "start");
        this.onDirty();
        return;
      }

      // Backspace at start or right after a .page-link pill
      if (e.key === "Backspace") {
        const sel = window.getSelection();
        if (sel && sel.isCollapsed && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          // Delete preceding .page-link pill cleanly
          if (
            range.startContainer.nodeType === Node.TEXT_NODE &&
            range.startOffset === 0 &&
            range.startContainer.previousSibling?.classList?.contains("page-link")
          ) {
            e.preventDefault();
            this.pushUndoSnapshot();
            range.startContainer.previousSibling.remove();
            this.blocks[idx].content = domToInlineMarkdown(editable);
            this.onDirty();
            return;
          }
          if (range.startContainer === editable && range.startOffset > 0) {
            const prevChild = editable.childNodes[range.startOffset - 1];
            if (prevChild?.classList?.contains("page-link")) {
              e.preventDefault();
              this.pushUndoSnapshot();
              prevChild.remove();
              this.blocks[idx].content = domToInlineMarkdown(editable);
              this.onDirty();
              return;
            }
          }
        }

        const offset = getCaretOffsetInText(editable);
        if (offset === 0 && sel?.isCollapsed) {
          if (
            block.type === "heading" ||
            block.type === "bullet_list" ||
            block.type === "numbered_list" ||
            block.type === "todo" ||
            block.type === "quote"
          ) {
            e.preventDefault();
            this.pushUndoSnapshot();
            this.collapsedIds.delete(block.id);
            const nextPara = {
              id: block.id,
              type: "paragraph",
              content: domToInlineMarkdown(editable),
            };
            if (isValidColorName(block.color)) nextPara.color = block.color;
            if (isValidColorName(block.bg)) nextPara.bg = block.bg;
            if (block.type !== "heading" && block.outdent > 0) nextPara.outdent = block.outdent;
            this.blocks[idx] = nextPara;
            this.render(block.id, "start");
            this.onDirty();
            this.onCollapseChange(this.getCollapsedIndices());
            return;
          }

          if (block.type === "paragraph" && domToInlineMarkdown(editable) === "") {
            const { depths } = this.computeVisibility();
            if (depths[idx] > 0) {
              e.preventDefault();
              this.pushUndoSnapshot();
              block.outdent = (block.outdent || 0) + 1;
              this.render(block.id, "start");
              this.onDirty();
              this.onCollapseChange(this.getCollapsedIndices());
              return;
            }
          }

          const prev = this.findPreviousVisibleBlock(idx);
          if (prev) {
            e.preventDefault();
            if (
              prev.type === "code" ||
              prev.type === "image" ||
              prev.type === "table" ||
              prev.type === "divider"
            ) {
              if (domToInlineMarkdown(editable) === "" && this.blocks.length > 1) {
                this.pushUndoSnapshot();
                this.blocks.splice(idx, 1);
                this.render(prev.id, "end");
                this.onDirty();
              } else {
                this.focusBlock(prev.id, "end");
              }
              return;
            }

            const prevRow = this.containerEl.querySelector(`.block-row[data-id="${CSS.escape(prev.id)}"]`);
            const prevEditable = prevRow?.querySelector(".block-editable");
            const joinCharOffset = prevEditable ? getTotalTextLength(prevEditable) : prev.content.length;

            this.pushUndoSnapshot();
            const currentMd = domToInlineMarkdown(editable);
            prev.content = prev.content + currentMd;
            this.blocks.splice(idx, 1);
            this.render(prev.id, "offset", joinCharOffset);
            this.onDirty();
            return;
          }
        }
      }

      // ArrowUp / ArrowDown across visible blocks
      if (e.key === "ArrowUp" && !e.shiftKey) {
        const offset = getCaretOffsetInText(editable);
        if (offset === 0) {
          const prev = this.findPreviousVisibleBlock(idx);
          if (prev) {
            e.preventDefault();
            this.focusBlock(prev.id, "end");
          }
        }
      } else if (e.key === "ArrowDown" && !e.shiftKey) {
        const offset = getCaretOffsetInText(editable);
        const total = getTotalTextLength(editable);
        if (offset >= total) {
          const next = this.findNextVisibleBlock(idx);
          if (next) {
            e.preventDefault();
            this.focusBlock(next.id, "start");
          }
        }
      }
    });
  }

  findPreviousVisibleBlock(fromIdx) {
    const { visible } = this.computeVisibility();
    for (let i = fromIdx - 1; i >= 0; i--) {
      if (visible[i]) return this.blocks[i];
    }
    return null;
  }

  findNextVisibleBlock(fromIdx) {
    const { visible } = this.computeVisibility();
    for (let i = fromIdx + 1; i < this.blocks.length; i++) {
      if (visible[i]) return this.blocks[i];
    }
    return null;
  }

  toggleHeadingCollapse(blockId) {
    if (this.collapsedIds.has(blockId)) {
      this.collapsedIds.delete(blockId);
    } else {
      this.collapsedIds.add(blockId);
    }
    this.syncAllEditableFromDom();
    this.render();
    this.onCollapseChange(this.getCollapsedIndices());
  }

  insertParagraphAfter(idx) {
    this.syncAllEditableFromDom();
    const block = this.blocks[idx];
    if (block?.type === "heading" && this.collapsedIds.has(block.id)) {
      this.collapsedIds.delete(block.id);
      this.onCollapseChange(this.getCollapsedIndices());
    }
    this.pushUndoSnapshot();
    const np = { id: genBlockId(), type: "paragraph", content: "" };
    this.blocks.splice(idx + 1, 0, np);
    this.render(np.id, "start");
    this.onDirty();
  }

  toggleInlineTag(tagName) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const editable =
      (range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement
      )?.closest(".block-editable, .table-cell-editable");
    if (!editable || !editable.contains(range.endContainer)) return;
    if (range.collapsed) return;

    const idx = this.findBlockIndexByEl(editable);
    if (idx === -1) return;

    this.pushUndoSnapshot();

    const matchSelector =
      tagName === "EM" ? "em, i" : tagName === "STRONG" ? "strong, b" : tagName;
    const startAncestor = (
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement
    )?.closest(matchSelector);
    const endAncestor = (
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? range.endContainer
        : range.endContainer.parentElement
    )?.closest(matchSelector);

    if (startAncestor && startAncestor === endAncestor && editable.contains(startAncestor)) {
      // Unwrap formatting tag
      const parent = startAncestor.parentNode;
      const text = document.createTextNode(startAncestor.textContent || "");
      parent.replaceChild(text, startAncestor);
      const nextRange = document.createRange();
      nextRange.selectNodeContents(text);
      sel.removeAllRanges();
      sel.addRange(nextRange);
    } else {
      // Wrap selected plain text cleanly
      const selectedText = range.toString();
      if (!selectedText) return;
      const wrapper = document.createElement(tagName.toLowerCase());
      if (tagName === "CODE") {
        wrapper.className = "inline-code";
      } else if (tagName === "MARK") {
        wrapper.className = "inline-highlight";
      }
      wrapper.textContent = selectedText;
      range.deleteContents();
      range.insertNode(wrapper);
      const nextRange = document.createRange();
      nextRange.selectNodeContents(wrapper);
      sel.removeAllRanges();
      sel.addRange(nextRange);
    }

    this.syncEditableElToBlock(editable, idx);
    this.onDirty();
    this.updateSelectionToolbar();
  }

  updateSelectionToolbar() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      this.hideSelectionToolbar();
      return;
    }
    const range = sel.getRangeAt(0);
    const editable = (
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement
    )?.closest(".block-editable, .table-cell-editable");
    if (!editable || !editable.contains(range.endContainer) || !range.toString().trim()) {
      this.hideSelectionToolbar();
      return;
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hideSelectionToolbar();
      return;
    }

    if (this.colorSelBtn) {
      const { color, bg } = this.getActiveInlineColorState();
      if (isValidColorName(color)) this.colorSelBtn.dataset.color = color;
      else delete this.colorSelBtn.dataset.color;
      if (isValidColorName(bg)) this.colorSelBtn.dataset.bg = bg;
      else delete this.colorSelBtn.dataset.bg;
    }

    this.selectionToolbarEl.hidden = false;
    const tbRect = this.selectionToolbarEl.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - tbRect.width - 8,
      Math.max(8, rect.left + rect.width / 2 - tbRect.width / 2)
    );
    const top = Math.max(8, rect.top - tbRect.height - 8);
    this.selectionToolbarEl.style.left = `${left}px`;
    this.selectionToolbarEl.style.top = `${top}px`;
  }

  hideSelectionToolbar() {
    this.selectionToolbarEl.hidden = true;
    if (this.colorPopoverEl && !this.colorPopoverEl.hidden && this.colorPopoverEl.dataset.mode === "inline") {
      this.closeColorPopover();
    }
  }

  /* Block Color System (Blocks & Inline Text) */
  recordLastUsedColor(kind, value) {
    if (!isValidColorName(value)) return;
    this.lastUsedColor = { kind, value };
    try {
      localStorage.setItem(LAST_COLOR_STORAGE_KEY, JSON.stringify(this.lastUsedColor));
    } catch {
      // Ignore storage error
    }
  }

  openColorPopover({
    mode,
    anchorRect,
    sideFlyout = false,
    activeColor = "",
    activeBg = "",
    onPick,
  }) {
    clearTimeout(this._colorFlyoutTimer);
    if (!this.colorPopoverEl) return;

    const last = this.lastUsedColor || { kind: "bg", value: "yellow" };
    const lastLabel = getColorDisplayLabel(last.kind, last.value);
    const lastSwatch =
      last.kind === "text"
        ? `<span class="color-swatch-text" data-swatch="${escapeHtml(last.value)}">A</span>`
        : `<span class="color-swatch-bg" data-swatch="${escapeHtml(last.value)}"></span>`;

    const textItemsHtml = COLOR_OPTIONS.map((opt) => {
      const isActive = opt.id === "default" ? !activeColor : activeColor === opt.id;
      return `
        <button class="popover-item color-option-btn${isActive ? " selected" : ""}" data-kind="text" data-value="${opt.id}" type="button" role="menuitem">
          <span class="popover-item-main">
            <span class="color-swatch-text" data-swatch="${opt.id}">A</span>
            <span class="popover-item-title">${escapeHtml(opt.label)} text</span>
          </span>
          ${isActive ? '<span class="color-check" aria-hidden="true">✓</span>' : ""}
        </button>
      `;
    }).join("");

    const bgItemsHtml = COLOR_OPTIONS.map((opt) => {
      const isActive = opt.id === "default" ? !activeBg : activeBg === opt.id;
      return `
        <button class="popover-item color-option-btn${isActive ? " selected" : ""}" data-kind="bg" data-value="${opt.id}" type="button" role="menuitem">
          <span class="popover-item-main">
            <span class="color-swatch-bg" data-swatch="${opt.id}"></span>
            <span class="popover-item-title">${escapeHtml(opt.label)} background</span>
          </span>
          ${isActive ? '<span class="color-check" aria-hidden="true">✓</span>' : ""}
        </button>
      `;
    }).join("");

    this.colorPopoverEl.dataset.mode = mode || "block";
    this.colorPopoverEl.innerHTML = `
      <div class="popover-section-label">Last used</div>
      <button class="popover-item color-option-btn" data-kind="${escapeHtml(last.kind)}" data-value="${escapeHtml(last.value)}" type="button" role="menuitem">
        <span class="popover-item-main">
          ${lastSwatch}
          <span class="popover-item-title">${escapeHtml(lastLabel)}</span>
        </span>
        <span class="popover-shortcut">Ctrl+Shift+H</span>
      </button>
      <div class="popover-divider"></div>
      <div class="popover-section-label">Text color</div>
      ${textItemsHtml}
      <div class="popover-divider"></div>
      <div class="popover-section-label">Background color</div>
      ${bgItemsHtml}
    `;

    this.colorPopoverEl.hidden = false;
    this.colorPopoverEl.scrollTop = 0;

    const popRect = this.colorPopoverEl.getBoundingClientRect();
    let left;
    let top;
    if (sideFlyout && anchorRect) {
      left = anchorRect.right + 4;
      if (left + popRect.width > window.innerWidth - 8) {
        left = Math.max(8, anchorRect.left - popRect.width - 4);
      }
      top = Math.max(
        8,
        Math.min(window.innerHeight - popRect.height - 8, anchorRect.top)
      );
    } else if (anchorRect) {
      left = Math.max(8, Math.min(window.innerWidth - popRect.width - 8, anchorRect.left));
      top = anchorRect.bottom + 6;
      if (top + popRect.height > window.innerHeight - 8) {
        top = Math.max(8, anchorRect.top - popRect.height - 6);
      }
    } else {
      left = 12;
      top = 12;
    }

    this.colorPopoverEl.style.left = `${left}px`;
    this.colorPopoverEl.style.top = `${top}px`;

    this.colorPopoverEl.querySelectorAll(".color-option-btn").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const kind = btn.dataset.kind;
        const value = btn.dataset.value;
        onPick?.(kind, value);
      });
    });
  }

  closeColorPopover() {
    clearTimeout(this._colorFlyoutTimer);
    if (!this.colorPopoverEl) return;
    this.colorPopoverEl.hidden = true;
    this.colorPopoverEl.innerHTML = "";
    delete this.colorPopoverEl.dataset.mode;
  }

  applyColorToBlocks(blockIds, kind, value) {
    if (!Array.isArray(blockIds) || !blockIds.length) return;
    this.syncAllEditableFromDom();
    const idSet = new Set(blockIds);
    const targets = this.blocks.filter((b) => idSet.has(b.id));
    if (!targets.length) return;

    this.pushUndoSnapshot();
    const field = kind === "text" ? "color" : "bg";
    for (const b of targets) {
      if (value === "default" || !isValidColorName(value)) {
        delete b[field];
      } else {
        b[field] = value;
      }
    }
    if (value !== "default") {
      this.recordLastUsedColor(kind, value);
    }
    const hadMulti = this.selectedBlockIds.size > 0;
    this.render();
    if (hadMulti) {
      this.syncSelectedClasses();
    }
    this.onDirty();
  }

  getActiveInlineColorState() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { color: "", bg: "" };
    const range = sel.getRangeAt(0);
    const startEl =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
    const span = startEl?.closest?.(".sw-inline-color");
    if (!span || !this.containerEl.contains(span)) return { color: "", bg: "" };
    return {
      color: isValidColorName(span.dataset.color) ? span.dataset.color : "",
      bg: isValidColorName(span.dataset.bg) ? span.dataset.bg : "",
    };
  }

  applyInlineColor(kind, value) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const editable = (
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement
    )?.closest(".block-editable, .table-cell-editable");
    if (!editable || !this.containerEl.contains(editable) || !editable.contains(range.endContainer)) {
      return false;
    }

    const idx = this.findBlockIndexByEl(editable);
    if (idx === -1) return false;

    const cleanVal = value === "default" ? "" : isValidColorName(value) ? value : "";
    if (value !== "default" && !cleanVal) return false;

    this.pushUndoSnapshot();

    const startSpan = (
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement
    )?.closest(".sw-inline-color");
    const endSpan = (
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? range.endContainer
        : range.endContainer.parentElement
    )?.closest(".sw-inline-color");

    if (startSpan && startSpan === endSpan && editable.contains(startSpan)) {
      const origColor = isValidColorName(startSpan.dataset.color) ? startSpan.dataset.color : "";
      const origBg = isValidColorName(startSpan.dataset.bg) ? startSpan.dataset.bg : "";
      const nextColor = kind === "text" ? cleanVal : origColor;
      const nextBg = kind === "bg" ? cleanVal : origBg;

      const afterRange = document.createRange();
      afterRange.setStart(range.endContainer, range.endOffset);
      afterRange.setEnd(startSpan, startSpan.childNodes.length);
      const afterFrag = afterRange.extractContents();
      const midFrag = range.extractContents();

      const hasBefore =
        (startSpan.textContent || "").length > 0 || Boolean(startSpan.querySelector(".page-link"));
      const hasAfter =
        (afterFrag.textContent || "").length > 0 || Boolean(afterFrag.querySelector?.(".page-link"));

      let selectTargetStart = null;
      let selectTargetEnd = null;
      const parent = startSpan.parentNode;
      let insertRef = startSpan.nextSibling;

      if (hasAfter) {
        const afterSpan = createInlineColorSpan(origColor, origBg);
        afterSpan.appendChild(afterFrag);
        parent.insertBefore(afterSpan, insertRef);
        insertRef = afterSpan;
      }

      if (nextColor || nextBg) {
        const midSpan = createInlineColorSpan(nextColor, nextBg);
        midSpan.appendChild(midFrag);
        parent.insertBefore(midSpan, insertRef);
        const nextRange = document.createRange();
        nextRange.selectNodeContents(midSpan);
        sel.removeAllRanges();
        sel.addRange(nextRange);
      } else {
        selectTargetStart = midFrag.firstChild;
        selectTargetEnd = midFrag.lastChild;
        parent.insertBefore(midFrag, insertRef);
        if (selectTargetStart && selectTargetEnd) {
          const nextRange = document.createRange();
          nextRange.setStartBefore(selectTargetStart);
          nextRange.setEndAfter(selectTargetEnd);
          sel.removeAllRanges();
          sel.addRange(nextRange);
        }
      }

      if (!hasBefore) {
        startSpan.remove();
      }
    } else {
      const frag = range.extractContents();
      frag.querySelectorAll(".sw-inline-color").forEach((sp) => {
        const curC = kind === "text" ? "" : sp.dataset.color || "";
        const curB = kind === "bg" ? "" : sp.dataset.bg || "";
        if (!curC && !curB) {
          sp.replaceWith(...Array.from(sp.childNodes));
        } else {
          updateInlineColorSpanAttrs(sp, curC, curB);
        }
      });

      if (cleanVal) {
        const wrapper = createInlineColorSpan(
          kind === "text" ? cleanVal : "",
          kind === "bg" ? cleanVal : ""
        );
        wrapper.appendChild(frag);
        range.insertNode(wrapper);
        const nextRange = document.createRange();
        nextRange.selectNodeContents(wrapper);
        sel.removeAllRanges();
        sel.addRange(nextRange);
      } else {
        const first = frag.firstChild;
        const last = frag.lastChild;
        range.insertNode(frag);
        if (first && last) {
          const nextRange = document.createRange();
          nextRange.setStartBefore(first);
          nextRange.setEndAfter(last);
          sel.removeAllRanges();
          sel.addRange(nextRange);
        }
      }
    }

    if (cleanVal) {
      this.recordLastUsedColor(kind, cleanVal);
    }
    this.syncEditableElToBlock(editable, idx);
    this.onDirty();
    this.updateSelectionToolbar();
    return true;
  }

  applyLastUsedColor() {
    const last = this.lastUsedColor || { kind: "bg", value: "yellow" };
    if (this.applyInlineColor(last.kind, last.value)) {
      return true;
    }
    if (this.selectedBlockIds.size > 0) {
      this.applyColorToBlocks(Array.from(this.selectedBlockIds), last.kind, last.value);
      return true;
    }
    const focused = this.getFocusedBlock();
    if (focused) {
      this.applyColorToBlocks([focused.block.id], last.kind, last.value);
      return true;
    }
    return false;
  }

  /* Slash Block Menu */
  openSlashMenu(blockId, editableEl, query) {
    const q = query.trim().toLowerCase();
    let filtered = SLASH_ITEMS.filter(
      (item) => item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q)
    );
    const dimMatch = q.match(/^table\s+(\d+)\s*[x×]\s*(\d+)$/i);
    if (dimMatch) {
      const cols = Math.min(12, Math.max(1, Number(dimMatch[1]) || 3));
      const rows = Math.min(30, Math.max(2, Number(dimMatch[2]) || 2));
      filtered = [
        {
          id: "table",
          label: `Table (${cols}×${rows})`,
          hint: `${cols} columns × ${rows} rows`,
          cols,
          rows,
        },
      ];
    }
    if (!filtered.length) {
      this.closeSlashMenu();
      return;
    }

    this.slashState = {
      active: true,
      blockId,
      selectedIndex: 0,
      filtered,
    };

    this.renderSlashMenu(editableEl.getBoundingClientRect());
  }

  renderSlashMenu(anchorRect = null) {
    this.slashPopoverEl.innerHTML = this.slashState.filtered
      .map((item, idx) => {
        const cls = idx === this.slashState.selectedIndex ? " selected" : "";
        return `
          <button class="popover-item${cls}" data-idx="${idx}" role="option">
            <span class="popover-item-main">
              <span class="popover-item-title">${escapeHtml(item.label)}</span>
            </span>
            <span class="popover-item-sub">${escapeHtml(item.hint)}</span>
          </button>
        `;
      })
      .join("");

    this.slashPopoverEl.hidden = false;
    if (anchorRect) {
      const popRect = this.slashPopoverEl.getBoundingClientRect();
      const left = Math.min(window.innerWidth - popRect.width - 8, Math.max(8, anchorRect.left));
      const top = Math.min(window.innerHeight - popRect.height - 8, anchorRect.bottom + 4);
      this.slashPopoverEl.style.left = `${left}px`;
      this.slashPopoverEl.style.top = `${top}px`;
    }

    this.slashPopoverEl.querySelectorAll(".popover-item").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.commitSlashItem(Number(btn.dataset.idx));
      });
    });
  }

  handleSlashKeyDown(e) {
    if (!this.slashState.active) return false;
    const len = this.slashState.filtered.length;
    if (!len) return false;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.slashState.selectedIndex = (this.slashState.selectedIndex + 1) % len;
      this.renderSlashMenu(null);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.slashState.selectedIndex = (this.slashState.selectedIndex - 1 + len) % len;
      this.renderSlashMenu(null);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      this.commitSlashItem(this.slashState.selectedIndex);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      this.closeSlashMenu();
      return true;
    }
    return false;
  }

  commitSlashItem(idx) {
    const item = this.slashState.filtered[idx];
    const blockId = this.slashState.blockId;
    this.closeSlashMenu();
    if (!item || !blockId) return;

    const blockIdx = this.blocks.findIndex((b) => b.id === blockId);
    if (blockIdx === -1) return;

    this.pushUndoSnapshot();
    if (item.id === "paragraph") {
      this.blocks[blockIdx] = { id: blockId, type: "paragraph", content: "" };
    } else if (item.id === "h1" || item.id === "h2" || item.id === "h3") {
      this.blocks[blockIdx] = {
        id: blockId,
        type: "heading",
        level: Number(item.id.slice(1)),
        content: "",
      };
    } else if (item.id === "bullet_list" || item.id === "numbered_list" || item.id === "quote") {
      this.blocks[blockIdx] = { id: blockId, type: item.id, content: "" };
    } else if (item.id === "todo") {
      this.blocks[blockIdx] = { id: blockId, type: "todo", checked: false, content: "" };
    } else if (item.id === "divider") {
      this.blocks[blockIdx] = { id: blockId, type: "divider" };
      let focusId = blockId;
      if (blockIdx === this.blocks.length - 1) {
        const np = { id: genBlockId(), type: "paragraph", content: "" };
        this.blocks.push(np);
        focusId = np.id;
      } else {
        focusId = this.blocks[blockIdx + 1].id;
      }
      this.render(focusId, "start");
      this.onDirty();
      return;
    } else if (item.id === "code") {
      this.blocks[blockIdx] = { id: blockId, type: "code", language: "", content: "" };
    } else if (item.id === "table") {
      this.blocks[blockIdx] = createEmptyTableBlock(blockId, item.cols || 3, item.rows || 2);
      this.render(blockId, { row: 0, col: 0, atEnd: false });
      this.onDirty();
      return;
    }
    this.render(blockId, "start");
    this.onDirty();
  }

  closeSlashMenu() {
    this.slashState.active = false;
    this.slashState.blockId = null;
    this.slashPopoverEl.hidden = true;
    this.slashPopoverEl.innerHTML = "";
  }

  /* Multi-Block Selection Helpers */
  consumeSuppressedBottomClick() {
    if (!this.suppressNextBottomClick) return false;
    this.suppressNextBottomClick = false;
    return true;
  }

  hasBlockSelection() {
    return this.selectedBlockIds.size > 0;
  }

  getSelectedBlocks() {
    this.syncAllEditableFromDom();
    const out = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (this.selectedBlockIds.has(b.id)) {
        out.push({ idx: i, block: cloneBlock(b) });
      }
    }
    return out;
  }

  getSelectedBlocksForAi() {
    this.syncAllEditableFromDom();
    if (this.selectedBlockIds.size === 0) return [];
    const { hiddenCounts } = this.computeVisibility();
    const seen = new Set();
    const out = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (!this.selectedBlockIds.has(b.id)) continue;
      if (!seen.has(b.id)) {
        seen.add(b.id);
        out.push(cloneBlock(b));
      }
      if (b.type === "heading" && this.collapsedIds.has(b.id)) {
        const hc = hiddenCounts[i] || 0;
        for (let k = 1; k <= hc && i + k < this.blocks.length; k++) {
          const child = this.blocks[i + k];
          if (child && !seen.has(child.id)) {
            seen.add(child.id);
            out.push(cloneBlock(child));
          }
        }
      }
    }
    return out;
  }

  notifyBlockSelectionChange() {
    const blocks = this.getSelectedBlocksForAi();
    const sig = blocks.map((b) => b.id).join(",");
    if (sig === this._lastSelectionSig) return;
    this._lastSelectionSig = sig;
    this.onBlockSelectionChange?.(blocks);
  }

  syncSelectedClasses() {
    this.containerEl.classList.toggle("has-block-selection", this.selectedBlockIds.size > 0);
    this.containerEl.querySelectorAll(".block-row").forEach((row) => {
      const id = row.dataset.id;
      const isSelected = this.selectedBlockIds.has(id) || this.menuTargetBlockId === id;
      row.classList.toggle("block-selected", isSelected);
    });
    this.notifyBlockSelectionChange();
    this.updateBlockSelectionBar();
  }

  updateBlockSelectionBar() {
    const bar = this.blockSelectionBarEl;
    if (!bar) return;

    if (
      this.selectedBlockIds.size === 0 ||
      this.pointerDrag?.started ||
      this.marquee?.active
    ) {
      bar.hidden = true;
      return;
    }

    const firstRow = Array.from(this.containerEl.querySelectorAll(".block-row")).find((r) =>
      this.selectedBlockIds.has(r.dataset.id)
    );
    if (!firstRow) {
      bar.hidden = true;
      return;
    }

    const count = this.selectedBlockIds.size;
    if (this.blockSelectionCountEl) {
      this.blockSelectionCountEl.textContent = `${count} ${count === 1 ? "block" : "blocks"}`;
    }

    if (this.blocksOutdentBtn) {
      const { depths } = this.computeVisibility();
      const canOutdent = this.blocks.some(
        (b, i) => this.selectedBlockIds.has(b.id) && b.type !== "heading" && (depths[i] || 0) > 0
      );
      this.blocksOutdentBtn.disabled = !canOutdent;
    }

    const mainEl = firstRow.querySelector(".block-main") || firstRow;
    const targetRect = mainEl.getBoundingClientRect();
    const scrollEl = this.containerEl.closest(".editor-scroll");
    const scrollRect = scrollEl
      ? scrollEl.getBoundingClientRect()
      : { top: 44, bottom: window.innerHeight };

    bar.hidden = false;
    const barRect = bar.getBoundingClientRect();
    const idealTop = targetRect.top - barRect.height - 8;
    const minTop = Math.max(8, scrollRect.top + 8);
    const maxTop = Math.min(window.innerHeight - barRect.height - 8, scrollRect.bottom - barRect.height - 8);
    const top = Math.max(minTop, Math.min(maxTop, idealTop < minTop ? targetRect.bottom + 6 : idealTop));
    const left = Math.max(
      12,
      Math.min(window.innerWidth - barRect.width - 12, targetRect.left)
    );

    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  }

  handleMarqueeMove(e) {
    const m = this.marquee;
    if (!m) return;

    if (!m.active) {
      if (Math.hypot(e.clientX - m.startX, e.clientY - m.startY) < 6) return;
      m.active = true;
      if (document.activeElement && this.containerEl.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      window.getSelection()?.removeAllRanges();
      this.closeBlockMenu();
      this.closeSlashMenu();
      this.hideSelectionToolbar();
    }

    const x1 = Math.min(m.startX, e.clientX);
    const y1 = Math.min(m.startY, e.clientY);
    const x2 = Math.max(m.startX, e.clientX);
    const y2 = Math.max(m.startY, e.clientY);

    if (this.blockMarqueeEl) {
      this.blockMarqueeEl.hidden = false;
      this.blockMarqueeEl.style.left = `${x1}px`;
      this.blockMarqueeEl.style.top = `${y1}px`;
      this.blockMarqueeEl.style.width = `${Math.max(1, x2 - x1)}px`;
      this.blockMarqueeEl.style.height = `${Math.max(1, y2 - y1)}px`;
    }

    const nextIds = m.additive ? new Set(m.baseSelection) : new Set();
    this.containerEl.querySelectorAll(".block-row").forEach((row) => {
      const rect = row.getBoundingClientRect();
      const overlaps = rect.right >= x1 && rect.left <= x2 && rect.bottom >= y1 && rect.top <= y2;
      if (overlaps && row.dataset.id) {
        nextIds.add(row.dataset.id);
      }
    });

    this.selectedBlockIds = nextIds;
    if (nextIds.size > 0 && !this.lastSelectedBlockId) {
      this.lastSelectedBlockId = Array.from(nextIds)[0];
    }
    this.syncSelectedClasses();
  }

  handleMarqueeUp() {
    const m = this.marquee;
    if (!m) return;
    const wasActive = m.active;
    this.cleanupMarquee();
    if (wasActive) {
      this.suppressNextBottomClick = true;
      setTimeout(() => {
        this.suppressNextBottomClick = false;
      }, 120);
      this.updateBlockSelectionBar();
    }
  }

  cleanupMarquee() {
    if (!this.marquee) return;
    this.marquee = null;
    if (this.blockMarqueeEl) {
      this.blockMarqueeEl.hidden = true;
    }
  }

  clearBlockSelection() {
    if (this.selectedBlockIds.size === 0 && !this.lastSelectedBlockId) return;
    this.selectedBlockIds.clear();
    this.lastSelectedBlockId = null;
    this.syncSelectedClasses();
  }

  toggleBlockSelection(blockId, extendRange = false) {
    if (!blockId) return;
    const { visible } = this.computeVisibility();

    if (extendRange && this.lastSelectedBlockId) {
      const anchorIdx = this.blocks.findIndex((b) => b.id === this.lastSelectedBlockId);
      const targetIdx = this.blocks.findIndex((b) => b.id === blockId);
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        for (let i = start; i <= end; i++) {
          if (visible[i]) {
            this.selectedBlockIds.add(this.blocks[i].id);
          }
        }
        this.lastSelectedBlockId = blockId;
        this.syncSelectedClasses();
        return;
      }
    }

    if (this.selectedBlockIds.has(blockId)) {
      this.selectedBlockIds.delete(blockId);
    } else {
      this.selectedBlockIds.add(blockId);
    }
    this.lastSelectedBlockId = blockId;
    this.syncSelectedClasses();
  }

  deleteSelectedBlocks() {
    if (this.selectedBlockIds.size === 0) return;
    this.syncAllEditableFromDom();
    const { hiddenCounts } = this.computeVisibility();
    const removeIdxSet = new Set();

    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (!this.selectedBlockIds.has(b.id)) continue;
      removeIdxSet.add(i);
      if (b.type === "heading" && this.collapsedIds.has(b.id)) {
        const hc = hiddenCounts[i] || 0;
        for (let k = 1; k <= hc && i + k < this.blocks.length; k++) {
          removeIdxSet.add(i + k);
        }
      }
    }

    if (removeIdxSet.size === 0) return;
    this.pushUndoSnapshot();

    const sortedRemove = Array.from(removeIdxSet).sort((a, b) => a - b);
    const firstRemoved = sortedRemove[0];

    for (const idx of sortedRemove) {
      this.collapsedIds.delete(this.blocks[idx].id);
    }

    this.blocks = this.blocks.filter((_, idx) => !removeIdxSet.has(idx));
    this.selectedBlockIds.clear();
    this.lastSelectedBlockId = null;

    if (this.blocks.length === 0) {
      this.blocks.push({ id: genBlockId(), type: "paragraph", content: "" });
      this.render(this.blocks[0].id, "start");
    } else {
      const focusIdx = Math.min(this.blocks.length - 1, Math.max(0, firstRemoved - 1));
      this.render(this.blocks[focusIdx].id, "end");
    }
    this.notifyBlockSelectionChange();
    this.updateBlockSelectionBar();
    this.onDirty();
    this.onCollapseChange(this.getCollapsedIndices());
  }

  duplicateSelectedBlocks() {
    const selected = this.getSelectedBlocks();
    if (!selected.length) return;
    this.pushUndoSnapshot();

    const copies = selected.map(({ block }) => {
      const copy = { ...cloneBlock(block), id: genBlockId() };
      delete copy.block_id;
      return copy;
    });

    const insertAt = selected[selected.length - 1].idx + 1;
    this.blocks.splice(insertAt, 0, ...copies);

    this.selectedBlockIds = new Set(copies.map((c) => c.id));
    this.lastSelectedBlockId = copies[copies.length - 1].id;
    this.render();
    this.syncSelectedClasses();
    this.onDirty();
    this.onCollapseChange(this.getCollapsedIndices());
  }

  outdentSelectedBlocks(delta) {
    const selected = this.getSelectedBlocks();
    if (!selected.length) return;
    const { depths } = this.computeVisibility();

    let changed = false;
    const targets = selected.filter(({ block }) => block.type !== "heading");
    if (!targets.length) return;

    this.pushUndoSnapshot();
    for (const { idx } of targets) {
      const blk = this.blocks[idx];
      if (!blk) continue;
      if (delta > 0) {
        if ((depths[idx] || 0) > 0) {
          blk.outdent = (blk.outdent || 0) + 1;
          changed = true;
        }
      } else if (delta < 0) {
        if ((blk.outdent || 0) > 1) {
          blk.outdent -= 1;
          changed = true;
        } else if (blk.outdent === 1) {
          delete blk.outdent;
          changed = true;
        }
      }
    }

    if (!changed) {
      this.undoStack.pop();
      return;
    }

    this.render();
    this.syncSelectedClasses();
    this.onDirty();
    this.onCollapseChange(this.getCollapsedIndices());
  }

  /* Gutter Block Menu */
  openBlockMenu(blockId, x, y) {
    this.syncAllEditableFromDom();
    const idx = this.blocks.findIndex((b) => b.id === blockId);
    if (idx === -1) return;

    this.menuTargetBlockId = blockId;
    this.syncSelectedClasses();

    if (this.selectedBlockIds.size > 1 && this.selectedBlockIds.has(blockId)) {
      const count = this.selectedBlockIds.size;
      const multiActions = [
        {
          label: `Ask AI (${count} blocks)`,
          shortcut: "Ctrl+J",
          run: () => this.onAskAiBlocks?.(this.getSelectedBlocksForAi()),
        },
        {
          label: "Color",
          submenu: "color",
        },
        {
          label: `Duplicate (${count} blocks)`,
          shortcut: "Ctrl+D",
          run: () => this.duplicateSelectedBlocks(),
        },
        { divider: true },
        {
          label: "Clear selection",
          shortcut: "Esc",
          run: () => this.clearBlockSelection(),
        },
        {
          label: `Delete (${count} blocks)`,
          shortcut: "Del",
          danger: true,
          run: () => this.deleteSelectedBlocks(),
        },
      ];

      this.blockMenuEl.innerHTML = multiActions
        .map((a, i) => {
          if (a.divider) return `<div class="popover-divider"></div>`;
          if (a.submenu === "color") {
            return `<button class="popover-item" data-idx="${i}" data-submenu="color" type="button" role="menuitem"><span>${escapeHtml(a.label)}</span><span class="popover-item-chevron">›</span></button>`;
          }
          const cls = a.danger ? "popover-item danger" : "popover-item";
          const sc = a.shortcut ? `<span class="popover-shortcut">${escapeHtml(a.shortcut)}</span>` : "";
          return `<button class="${cls}" data-idx="${i}" role="menuitem"><span>${escapeHtml(a.label)}</span>${sc}</button>`;
        })
        .join("");

      this.blockMenuEl.hidden = false;
      const rect = this.blockMenuEl.getBoundingClientRect();
      this.blockMenuEl.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
      this.blockMenuEl.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

      const openMultiColorFlyout = (triggerBtn) => {
        const menuRect = this.blockMenuEl.getBoundingClientRect();
        const btnRect = triggerBtn.getBoundingClientRect();
        this.openColorPopover({
          mode: "blocks",
          anchorRect: {
            left: menuRect.left,
            right: menuRect.right,
            top: btnRect.top,
            bottom: btnRect.bottom,
          },
          sideFlyout: true,
          activeColor: "",
          activeBg: "",
          onPick: (kind, value) => {
            this.closeBlockMenu();
            this.applyColorToBlocks(Array.from(this.selectedBlockIds), kind, value);
          },
        });
      };

      this.blockMenuEl.querySelectorAll(".popover-item").forEach((btn) => {
        if (btn.dataset.submenu === "color") {
          btn.addEventListener("mouseenter", () => {
            clearTimeout(this._colorFlyoutTimer);
            openMultiColorFlyout(btn);
          });
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            openMultiColorFlyout(btn);
          });
          return;
        }
        btn.addEventListener("mouseenter", () => {
          if (!this.colorPopoverEl.hidden) {
            this._colorFlyoutTimer = setTimeout(() => this.closeColorPopover(), 110);
          }
        });
        btn.addEventListener("click", () => {
          const item = multiActions[Number(btn.dataset.idx)];
          this.closeBlockMenu();
          if (item?.run) item.run();
        });
      });
      return;
    }

    const block = this.blocks[idx];
    const actions = [
      {
        label: "Ask AI",
        shortcut: "Ctrl+J",
        run: () => this.onAskAiBlock?.(cloneBlock(this.blocks[idx])),
      },
      {
        label: "Color",
        submenu: "color",
      },
      {
        label: "Copy link to block",
        shortcut: "Alt+Shift+L",
        run: () => {
          const bid = this.ensureBlockId(idx);
          if (bid) this.onCopyBlockLink?.(bid);
        },
      },
      {
        label: "Duplicate",
        shortcut: "Ctrl+D",
        run: () => this.duplicateBlock(idx),
      },
      { divider: true },
    ];
    if (block.type !== "image") {
      actions.push(
        { section: "Turn into" },
        { label: "Text", run: () => this.turnBlockInto(idx, "paragraph") },
        { label: "Heading 1", run: () => this.turnBlockInto(idx, "heading", 1) },
        { label: "Heading 2", run: () => this.turnBlockInto(idx, "heading", 2) },
        { label: "Heading 3", run: () => this.turnBlockInto(idx, "heading", 3) },
        { label: "Bullet List", run: () => this.turnBlockInto(idx, "bullet_list") },
        { label: "Numbered List", run: () => this.turnBlockInto(idx, "numbered_list") },
        { label: "To-do List", run: () => this.turnBlockInto(idx, "todo") },
        { label: "Quote", run: () => this.turnBlockInto(idx, "quote") },
        { label: "Divider", run: () => this.turnBlockInto(idx, "divider") },
        { label: "Code Block", run: () => this.turnBlockInto(idx, "code") },
        { label: "Table", run: () => this.turnBlockInto(idx, "table") },
        { divider: true }
      );
    }
    actions.push(
      { label: "Move Up", run: () => this.moveBlock(idx, -1), disabled: idx === 0 },
      {
        label: "Move Down",
        run: () => this.moveBlock(idx, 1),
        disabled: idx === this.blocks.length - 1,
      },
      { label: "Delete", shortcut: "Del", danger: true, run: () => this.deleteBlock(idx) }
    );

    this.blockMenuEl.innerHTML = actions
      .map((a, i) => {
        if (a.section) return `<div class="popover-section-label">${escapeHtml(a.section)}</div>`;
        if (a.divider) return `<div class="popover-divider"></div>`;
        if (a.submenu === "color") {
          return `<button class="popover-item" data-idx="${i}" data-submenu="color" type="button" role="menuitem"><span>${escapeHtml(a.label)}</span><span class="popover-item-chevron">›</span></button>`;
        }
        const cls = a.danger ? "popover-item danger" : "popover-item";
        const sc = a.shortcut ? `<span class="popover-shortcut">${escapeHtml(a.shortcut)}</span>` : "";
        return `<button class="${cls}" data-idx="${i}" ${a.disabled ? "disabled" : ""} role="menuitem"><span>${escapeHtml(a.label)}</span>${sc}</button>`;
      })
      .join("");

    this.blockMenuEl.hidden = false;
    const rect = this.blockMenuEl.getBoundingClientRect();
    this.blockMenuEl.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    this.blockMenuEl.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

    const openSingleColorFlyout = (triggerBtn) => {
      const menuRect = this.blockMenuEl.getBoundingClientRect();
      const btnRect = triggerBtn.getBoundingClientRect();
      const curBlock = this.blocks.find((b) => b.id === blockId);
      this.openColorPopover({
        mode: "block",
        anchorRect: {
          left: menuRect.left,
          right: menuRect.right,
          top: btnRect.top,
          bottom: btnRect.bottom,
        },
        sideFlyout: true,
        activeColor: curBlock?.color || "",
        activeBg: curBlock?.bg || "",
        onPick: (kind, value) => {
          this.closeBlockMenu();
          this.applyColorToBlocks([blockId], kind, value);
        },
      });
    };

    this.blockMenuEl.querySelectorAll(".popover-item").forEach((btn) => {
      if (btn.dataset.submenu === "color") {
        btn.addEventListener("mouseenter", () => {
          clearTimeout(this._colorFlyoutTimer);
          openSingleColorFlyout(btn);
        });
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          openSingleColorFlyout(btn);
        });
        return;
      }
      btn.addEventListener("mouseenter", () => {
        if (!this.colorPopoverEl.hidden) {
          this._colorFlyoutTimer = setTimeout(() => this.closeColorPopover(), 110);
        }
      });
      btn.addEventListener("click", () => {
        const item = actions[Number(btn.dataset.idx)];
        this.closeBlockMenu();
        if (item?.run && !item.disabled) item.run();
      });
    });
  }

  closeBlockMenu() {
    this.closeColorPopover();
    this.blockMenuEl.hidden = true;
    this.blockMenuEl.innerHTML = "";
    this.menuTargetBlockId = null;
    this.syncSelectedClasses();
  }

  ensureBlockId(idx) {
    const block = this.blocks[idx];
    if (!block) return null;
    if (block.block_id) return block.block_id;
    const bid = genAnchorBlockId(this.blocks);
    block.block_id = bid;
    this.onDirty();
    return bid;
  }

  duplicateBlock(idx) {
    this.syncAllEditableFromDom();
    const src = this.blocks[idx];
    if (!src) return;
    this.pushUndoSnapshot();
    const copy = { ...cloneBlock(src), id: genBlockId() };
    delete copy.block_id;
    this.blocks.splice(idx + 1, 0, copy);
    this.render(copy.id, "end");
    this.onDirty();
  }

  getFocusedBlock() {
    const active = document.activeElement;
    const row = active?.closest?.(".block-row");
    if (!row || !this.containerEl.contains(row)) return null;
    this.syncAllEditableFromDom();
    const idx = this.blocks.findIndex((b) => b.id === row.dataset.id);
    if (idx === -1) return null;
    return { idx, block: cloneBlock(this.blocks[idx]) };
  }

  getSelectedTextContext() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const editable = (
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement
    )?.closest(".block-editable, .table-cell-editable");
    if (!editable || !this.containerEl.contains(editable)) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    this.syncAllEditableFromDom();
    const idx = this.findBlockIndexByEl(editable);
    const block = idx !== -1 ? cloneBlock(this.blocks[idx]) : null;
    return { blockId: block?.id || "", block, text };
  }

  scrollToAnchor(anchor) {
    if (!anchor) return false;
    const clean = String(anchor).trim();
    let targetIdx = -1;

    if (clean.startsWith("^")) {
      const bid = clean.slice(1).toLowerCase();
      targetIdx = this.blocks.findIndex((b) => (b.block_id || "").toLowerCase() === bid);
    } else {
      const headingLower = clean.toLowerCase();
      targetIdx = this.blocks.findIndex(
        (b) => b.type === "heading" && (b.content || "").trim().toLowerCase() === headingLower
      );
    }

    if (targetIdx === -1) return false;

    // Expand any collapsed ancestor headings containing targetIdx
    let changedCollapse = false;
    let stack = [];
    for (let i = 0; i < targetIdx; i++) {
      const b = this.blocks[i];
      if (b.type === "heading") {
        while (stack.length && stack[stack.length - 1].level >= b.level) {
          stack.pop();
        }
        stack.push({ id: b.id, level: b.level });
      }
    }
    for (const ancestor of stack) {
      if (this.collapsedIds.has(ancestor.id)) {
        this.collapsedIds.delete(ancestor.id);
        changedCollapse = true;
      }
    }

    if (changedCollapse) {
      this.render();
      this.onCollapseChange(this.getCollapsedIndices());
    }

    const targetId = this.blocks[targetIdx].id;
    const row = this.containerEl.querySelector(`.block-row[data-id="${CSS.escape(targetId)}"]`);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.remove("block-highlight-flash");
      void row.offsetWidth;
      row.classList.add("block-highlight-flash");
      setTimeout(() => row.classList.remove("block-highlight-flash"), 2000);
      return true;
    }
    return false;
  }

  findBlockIndexByAnyId(idOrAnchorId) {
    if (!idOrAnchorId) return -1;
    const clean = String(idOrAnchorId).trim();
    const stripped = clean.startsWith("^") ? clean.slice(1) : clean;
    return this.blocks.findIndex((b) => b.id === clean || b.block_id === stripped);
  }

  normalizeAiBlockPayload(raw, preserveId = null, preserveAnchorId = null, preserveStyle = null) {
    const id = preserveId || genBlockId();
    const base = preserveAnchorId ? { block_id: preserveAnchorId } : {};
    const color = isValidColorName(raw?.color)
      ? raw.color
      : isValidColorName(preserveStyle?.color)
        ? preserveStyle.color
        : null;
    const bg = isValidColorName(raw?.bg)
      ? raw.bg
      : isValidColorName(preserveStyle?.bg)
        ? preserveStyle.bg
        : null;
    if (color) base.color = color;
    if (bg) base.bg = bg;
    const type = raw?.type || "paragraph";
    const rawOutdent = Number(raw?.outdent);
    const fallbackOutdent = Number(preserveStyle?.outdent);
    const outdent =
      type !== "heading"
        ? Number.isInteger(rawOutdent) && rawOutdent > 0
          ? rawOutdent
          : Number.isInteger(fallbackOutdent) && fallbackOutdent > 0
            ? fallbackOutdent
            : null
        : null;
    if (outdent) base.outdent = outdent;
    if (type === "heading") {
      return {
        id,
        ...base,
        type: "heading",
        level: Math.min(3, Math.max(1, Number(raw.level) || 1)),
        content: replaceBrOutsideCode(String(raw.content || ""))
          .replace(/\s*\n\s*/g, " ")
          .trim(),
      };
    }
    if (type === "bullet_list" || type === "numbered_list") {
      return {
        id,
        ...base,
        type,
        content: replaceBrOutsideCode(String(raw.content || ""))
          .replace(/\s*\n\s*/g, " ")
          .trim(),
      };
    }
    if (type === "todo") {
      return {
        id,
        ...base,
        type: "todo",
        checked: Boolean(raw.checked),
        content: replaceBrOutsideCode(String(raw.content || ""))
          .replace(/\s*\n\s*/g, " ")
          .trim(),
      };
    }
    if (type === "quote") {
      return {
        id,
        ...base,
        type: "quote",
        content: replaceBrOutsideCode(String(raw.content || "")),
      };
    }
    if (type === "divider") {
      return {
        id,
        ...base,
        type: "divider",
      };
    }
    if (type === "code") {
      return {
        id,
        ...base,
        type: "code",
        language: String(raw.language || ""),
        content: String(raw.content || ""),
      };
    }
    if (type === "table") {
      let rawRows = Array.isArray(raw.rows) ? raw.rows : [];
      if (Array.isArray(raw.headers) && raw.headers.length) {
        rawRows = [raw.headers, ...rawRows];
      }
      rawRows = rawRows.map((row) =>
        Array.isArray(row) ? row.map((cell) => replaceBrOutsideCode(String(cell ?? ""))) : []
      );
      const norm = normalizeTableData(rawRows, raw.alignments, raw.col_widths);
      return {
        id,
        ...base,
        type: "table",
        alignments: norm.alignments,
        col_widths: norm.col_widths,
        rows: norm.rows,
      };
    }
    return {
      id,
      ...base,
      type: "paragraph",
      content: replaceBrOutsideCode(String(raw?.content || "")),
    };
  }

  applyAiEdits(ops) {
    if (!Array.isArray(ops) || !ops.length) {
      return { ok: false, appliedCount: 0, missingIds: [], error: "No edit operations provided." };
    }
    this.syncAllEditableFromDom();

    const sim = this.blocks.map((b) => ({ id: b.id, block_id: b.block_id || null }));
    const findSimIdx = (idOrAnchorId) => {
      if (!idOrAnchorId) return -1;
      const clean = String(idOrAnchorId).trim();
      const stripped = clean.startsWith("^") ? clean.slice(1) : clean;
      return sim.findIndex((b) => b.id === clean || b.block_id === stripped);
    };

    const missingIds = [];
    let validOpCount = 0;

    for (const op of ops) {
      if (!op || typeof op.op !== "string") continue;
      if (op.op === "replace" && op.block && typeof op.block === "object") {
        const idx = findSimIdx(op.block_id);
        if (idx === -1) {
          missingIds.push(String(op.block_id || "(missing id)"));
        } else {
          validOpCount += 1;
        }
      } else if (op.op === "insert_after") {
        const list = Array.isArray(op.blocks) ? op.blocks : op.block ? [op.block] : [];
        if (!list.length) continue;
        const idx = findSimIdx(op.block_id);
        if (idx === -1) {
          missingIds.push(String(op.block_id || "(missing id)"));
        } else {
          const placeholders = list.map(() => ({ id: null, block_id: null }));
          sim.splice(idx + 1, 0, ...placeholders);
          validOpCount += 1;
        }
      } else if (op.op === "append") {
        const list = Array.isArray(op.blocks) ? op.blocks : op.block ? [op.block] : [];
        if (!list.length) continue;
        for (let i = 0; i < list.length; i++) {
          sim.push({ id: null, block_id: null });
        }
        validOpCount += 1;
      } else if (op.op === "delete") {
        const idx = findSimIdx(op.block_id);
        if (idx === -1) {
          missingIds.push(String(op.block_id || "(missing id)"));
        } else {
          sim.splice(idx, 1);
          validOpCount += 1;
        }
      }
    }

    if (missingIds.length > 0) {
      return {
        ok: false,
        appliedCount: 0,
        missingIds,
        error: `Could not apply edits: target block(s) ${missingIds.join(", ")} were not found in this note.`,
      };
    }
    if (validOpCount === 0) {
      return {
        ok: false,
        appliedCount: 0,
        missingIds: [],
        error: "No valid edit operations found.",
      };
    }

    this.pushUndoSnapshot();

    const touchedIds = [];
    for (const op of ops) {
      if (!op || typeof op.op !== "string") continue;
      if (op.op === "replace" && op.block && typeof op.block === "object") {
        const idx = this.findBlockIndexByAnyId(op.block_id);
        if (idx !== -1) {
          const prev = this.blocks[idx];
          this.blocks[idx] = this.normalizeAiBlockPayload(op.block, prev.id, prev.block_id, {
            color: prev.color,
            bg: prev.bg,
            outdent: prev.outdent,
          });
          touchedIds.push(prev.id);
        }
      } else if (op.op === "insert_after") {
        const list = Array.isArray(op.blocks) ? op.blocks : op.block ? [op.block] : [];
        if (!list.length) continue;
        const idx = this.findBlockIndexByAnyId(op.block_id);
        if (idx !== -1) {
          const created = list.map((b) => this.normalizeAiBlockPayload(b));
          this.blocks.splice(idx + 1, 0, ...created);
          created.forEach((b) => touchedIds.push(b.id));
        }
      } else if (op.op === "append") {
        const list = Array.isArray(op.blocks) ? op.blocks : op.block ? [op.block] : [];
        if (!list.length) continue;
        const created = list.map((b) => this.normalizeAiBlockPayload(b));
        this.blocks.push(...created);
        created.forEach((b) => touchedIds.push(b.id));
      } else if (op.op === "delete") {
        const idx = this.findBlockIndexByAnyId(op.block_id);
        if (idx !== -1) {
          this.collapsedIds.delete(this.blocks[idx].id);
          this.blocks.splice(idx, 1);
        }
      }
    }

    if (!this.blocks.length) {
      this.blocks.push({ id: genBlockId(), type: "paragraph", content: "" });
    }

    this.render();
    this.onDirty();

    for (const tid of touchedIds) {
      const row = this.containerEl.querySelector(`.block-row[data-id="${CSS.escape(tid)}"]`);
      if (row) {
        row.classList.add("block-highlight-flash");
        setTimeout(() => row.classList.remove("block-highlight-flash"), 2000);
      }
    }
    return { ok: true, appliedCount: validOpCount, missingIds: [] };
  }

  appendBlocks(newBlocks) {
    if (!Array.isArray(newBlocks) || !newBlocks.length) return;
    this.syncAllEditableFromDom();
    this.pushUndoSnapshot();
    const mapped = newBlocks.map((b) => ({ ...cloneBlock(b), id: genBlockId() }));
    if (
      this.blocks.length === 1 &&
      this.blocks[0].type === "paragraph" &&
      (this.blocks[0].content || "").trim() === ""
    ) {
      this.blocks = mapped;
    } else {
      this.blocks.push(...mapped);
    }
    this.render(mapped[mapped.length - 1].id, "end");
    this.onDirty();
  }

  turnBlockInto(idx, type, level = 1) {
    const old = this.blocks[idx];
    if (!old) return;
    this.pushUndoSnapshot();
    this.collapsedIds.delete(old.id);
    const styleBase = {};
    if (isValidColorName(old.color)) styleBase.color = old.color;
    if (isValidColorName(old.bg)) styleBase.bg = old.bg;
    const fallbackText =
      old.type === "table" ? serializeTableFallbackText(old) : old.content || "";
    if (type === "paragraph") {
      this.blocks[idx] = { id: old.id, ...styleBase, type: "paragraph", content: fallbackText };
    } else if (type === "heading") {
      this.blocks[idx] = { id: old.id, ...styleBase, type: "heading", level, content: fallbackText };
    } else if (type === "bullet_list" || type === "numbered_list" || type === "quote") {
      this.blocks[idx] = { id: old.id, ...styleBase, type, content: fallbackText };
    } else if (type === "todo") {
      this.blocks[idx] = {
        id: old.id,
        ...styleBase,
        type: "todo",
        checked: Boolean(old.checked),
        content: fallbackText,
      };
    } else if (type === "divider") {
      this.blocks[idx] = { id: old.id, ...styleBase, type: "divider" };
    } else if (type === "code") {
      this.blocks[idx] = {
        id: old.id,
        ...styleBase,
        type: "code",
        language: old.language || "",
        content: fallbackText,
      };
    } else if (type === "table") {
      if (old.type === "table") {
        this.undoStack.pop();
        return;
      }
      const parsed = tryParseMarkdownTable(fallbackText.trim());
      if (parsed) {
        const norm = normalizeTableData(parsed.rows, parsed.alignments);
        this.blocks[idx] = { id: old.id, ...styleBase, type: "table", ...norm };
      } else {
        const tbl = createEmptyTableBlock(old.id, 3, 2);
        if (fallbackText.trim()) {
          tbl.rows[0][0] = fallbackText.trim();
        }
        this.blocks[idx] = { ...tbl, ...styleBase };
      }
      this.render(old.id, { row: 0, col: 0, atEnd: false });
      this.onDirty();
      return;
    }
    this.render(old.id, "end");
    this.onDirty();
  }

  moveBlock(idx, delta) {
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= this.blocks.length) return;
    this.pushUndoSnapshot();
    const [item] = this.blocks.splice(idx, 1);
    this.blocks.splice(nextIdx, 0, item);
    this.render(item.id, "end");
    this.onDirty();
  }

  deleteBlock(idx) {
    this.pushUndoSnapshot();
    const removed = this.blocks[idx];
    if (removed) this.collapsedIds.delete(removed.id);
    if (this.blocks.length === 1) {
      this.blocks[0] = { id: genBlockId(), type: "paragraph", content: "" };
      this.render(this.blocks[0].id, "start");
    } else {
      this.blocks.splice(idx, 1);
      const focusIdx = Math.max(0, idx - 1);
      this.render(this.blocks[focusIdx].id, "end");
    }
    this.onDirty();
  }

  /* Pointer-Event Block Drag-and-Drop */
  createDragGhost(sourceRow, block, dragCount) {
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    if (block.type === "heading") {
      ghost.classList.add("block-heading", `block-heading-${Math.min(3, Math.max(1, block.level))}`);
    }
    if (isValidColorName(block.color)) {
      ghost.dataset.color = block.color;
    }
    if (isValidColorName(block.bg)) {
      ghost.dataset.bg = block.bg;
    }

    const mainEl = sourceRow?.querySelector(".block-main");
    if (mainEl) {
      const mainRect = mainEl.getBoundingClientRect();
      ghost.style.width = `${Math.min(694, Math.max(180, Math.round(mainRect.width)))}px`;
      const clone = mainEl.cloneNode(true);
      clone.querySelectorAll("[contenteditable]").forEach((el) => {
        el.removeAttribute("contenteditable");
      });
      clone.querySelectorAll("button, select, textarea, input").forEach((el) => {
        el.disabled = true;
      });
      // Sync textarea value text if cloning a code block
      const origTa = mainEl.querySelector("textarea");
      const cloneTa = clone.querySelector("textarea");
      if (origTa && cloneTa) {
        cloneTa.value = origTa.value;
        cloneTa.style.height = origTa.style.height;
      }
      // Limit cloned image height inside ghost preview
      clone.querySelectorAll(".block-image-el").forEach((img) => {
        img.style.maxHeight = "120px";
      });
      // Hide interactive table buttons/handles and cap table preview height inside ghost
      clone
        .querySelectorAll(
          ".table-expand-btn, .table-col-handle, .table-row-handle, .table-col-resizer, .table-col-guide"
        )
        .forEach((el) => {
          el.remove();
        });
      clone.querySelectorAll(".block-table-scroll").forEach((el) => {
        el.style.maxHeight = "160px";
        el.style.overflow = "hidden";
      });
      ghost.appendChild(clone);
    } else {
      const fallback = document.createElement("span");
      fallback.textContent = block.content?.trim() || "Block";
      ghost.appendChild(fallback);
    }

    if (dragCount > 1) {
      const badge = document.createElement("span");
      badge.className = "drag-ghost-badge";
      badge.textContent = `+${dragCount - 1}`;
      ghost.appendChild(badge);
    }

    document.body.appendChild(ghost);
    return ghost;
  }

  handlePointerMove(e) {
    const drag = this.pointerDrag;
    if (!drag) return;

    drag.lastClientX = e.clientX;
    drag.lastClientY = e.clientY;

    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) {
        return;
      }
      this.syncAllEditableFromDom();
      this.closeBlockMenu();
      this.closeSlashMenu();
      this.linkAutocomplete.close();
      this.hideSelectionToolbar();

      const sourceIdx = this.blocks.findIndex((b) => b.id === drag.blockId);
      if (sourceIdx === -1) {
        this.cleanupPointerDrag();
        return;
      }

      const { hiddenCounts, depths } = this.computeVisibility();
      const isMultiGroup = this.selectedBlockIds.has(drag.blockId);
      const dragIdxSet = new Set();

      if (isMultiGroup) {
        for (let i = 0; i < this.blocks.length; i++) {
          const b = this.blocks[i];
          if (!this.selectedBlockIds.has(b.id)) continue;
          dragIdxSet.add(i);
          if (b.type === "heading" && this.collapsedIds.has(b.id)) {
            const hc = hiddenCounts[i] || 0;
            for (let k = 1; k <= hc && i + k < this.blocks.length; k++) {
              dragIdxSet.add(i + k);
            }
          }
        }
      } else {
        const singleCount =
          this.blocks[sourceIdx].type === "heading" && this.collapsedIds.has(drag.blockId)
            ? 1 + hiddenCounts[sourceIdx]
            : 1;
        for (let k = 0; k < singleCount; k++) {
          dragIdxSet.add(sourceIdx + k);
        }
      }

      drag.sourceIdx = sourceIdx;
      drag.isMultiGroup = isMultiGroup;
      drag.dragIdxSet = dragIdxSet;
      drag.dragIndices = Array.from(dragIdxSet).sort((a, b) => a - b);
      drag.startDepth = depths[sourceIdx] || 0;
      drag.desiredOutdent = null;
      drag.dragCount = drag.dragIndices.length;
      drag.started = true;
      this.updateBlockSelectionBar();

      const sourceRow = this.containerEl.querySelector(
        `.block-row[data-id="${CSS.escape(drag.blockId)}"]`
      );
      drag.ghostEl = this.createDragGhost(sourceRow, this.blocks[sourceIdx], drag.dragCount);

      document.body.classList.add("is-dragging-block");
      for (const draggedIdx of drag.dragIndices) {
        const bId = this.blocks[draggedIdx]?.id;
        if (!bId) continue;
        const r = this.containerEl.querySelector(`.block-row[data-id="${CSS.escape(bId)}"]`);
        if (r) r.classList.add("dragging");
      }
      this.scheduleEdgeScroll();
    }

    if (drag.ghostEl) {
      const left = Math.max(8, Math.min(window.innerWidth - 180, e.clientX - drag.grabOffsetX + 24));
      const top = Math.max(8, Math.min(window.innerHeight - 48, e.clientY - drag.grabOffsetY));
      drag.ghostEl.style.left = `${left}px`;
      drag.ghostEl.style.top = `${top}px`;
    }

    this.updateDropSlot(e.clientX, e.clientY);
  }

  isDropNoOp(insertIdx, drag) {
    if (!drag.isMultiGroup) {
      return insertIdx >= drag.sourceIdx && insertIdx <= drag.sourceIdx + drag.dragCount;
    }
    const remaining = [];
    for (let i = 0; i < this.blocks.length; i++) {
      if (!drag.dragIdxSet.has(i)) remaining.push(i);
    }
    const removedBefore = drag.dragIndices.filter((i) => i < insertIdx).length;
    const insertAt = Math.max(0, Math.min(remaining.length, insertIdx - removedBefore));
    remaining.splice(insertAt, 0, ...drag.dragIndices);
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i] !== i) return false;
    }
    return true;
  }

  updateDropSlot(clientX, clientY) {
    const drag = this.pointerDrag;
    if (!drag || !drag.started) return;

    this.containerEl
      .querySelectorAll(".block-row.drop-inside")
      .forEach((row) => row.classList.remove("drop-inside"));

    const rows = Array.from(this.containerEl.querySelectorAll(".block-row"));
    if (!rows.length) {
      this.dropIndicatorEl.hidden = true;
      drag.insertIndex = null;
      drag.desiredOutdent = null;
      return;
    }

    const { hiddenCounts } = this.computeVisibility();
    const rowInfos = rows.map((row) => ({
      row,
      idx: Number(row.dataset.idx),
      id: row.dataset.id,
      rect: row.getBoundingClientRect(),
    }));

    // Check if hovering inside the middle 50% of a different collapsed heading row
    for (const info of rowInfos) {
      const block = this.blocks[info.idx];
      if (
        block &&
        block.type === "heading" &&
        this.collapsedIds.has(block.id) &&
        !drag.dragIdxSet.has(info.idx)
      ) {
        const topZone = info.rect.top + info.rect.height * 0.25;
        const bottomZone = info.rect.bottom - info.rect.height * 0.25;
        if (clientY >= topZone && clientY <= bottomZone) {
          info.row.classList.add("drop-inside");
          this.dropIndicatorEl.hidden = true;
          drag.insertIndex = info.idx + 1;
          drag.desiredOutdent = 0;
          return;
        }
      }
    }

    const slots = [];
    slots.push({ insertIdx: rowInfos[0].idx, y: rowInfos[0].rect.top - 1 });
    for (let i = 1; i < rowInfos.length; i++) {
      slots.push({
        insertIdx: rowInfos[i].idx,
        y: (rowInfos[i - 1].rect.bottom + rowInfos[i].rect.top) / 2,
      });
    }
    const last = rowInfos[rowInfos.length - 1];
    slots.push({
      insertIdx: last.idx + 1 + (hiddenCounts[last.idx] || 0),
      y: last.rect.bottom + 2,
    });

    let best = slots[0];
    let bestDist = Math.abs(clientY - best.y);
    for (let i = 1; i < slots.length; i++) {
      const dist = Math.abs(clientY - slots[i].y);
      if (dist < bestDist) {
        best = slots[i];
        bestDist = dist;
      }
    }

    const containerRect = this.containerEl.getBoundingClientRect();
    const draggedBlock = this.blocks[drag.sourceIdx];
    const anchorNonHeadingIdx =
      draggedBlock && draggedBlock.type !== "heading"
        ? drag.sourceIdx
        : drag.dragIndices.find(
            (i) =>
              this.blocks[i]?.type !== "heading" &&
              (!drag.isMultiGroup || this.selectedBlockIds.has(this.blocks[i].id))
          );
    const hasNonHeading = anchorNonHeadingIdx !== undefined;
    const isSameSpot = this.isDropNoOp(best.insertIdx, drag);
    const dx = clientX - drag.startX;
    const baseHandleX = drag.startX - (drag.startDepth || 0) * INDENT_STEP_PX;

    if (isSameSpot) {
      if (!hasNonHeading || Math.abs(dx) < 14) {
        this.dropIndicatorEl.hidden = true;
        drag.insertIndex = null;
        drag.desiredOutdent = null;
        return;
      }

      const anchorBlock = this.blocks[anchorNonHeadingIdx];
      const naturalDepth = this.computeDropDepth(
        drag.dragIndices[0],
        anchorBlock,
        drag.dragIdxSet
      );
      const currentDepth = Math.max(0, naturalDepth - (anchorBlock.outdent || 0));
      const candidateDepth = Math.max(
        0,
        Math.min(naturalDepth, Math.round(currentDepth + dx / INDENT_STEP_PX))
      );

      if (candidateDepth === currentDepth) {
        this.dropIndicatorEl.hidden = true;
        drag.insertIndex = null;
        drag.desiredOutdent = null;
        return;
      }

      const visibleDraggedRows = rowInfos.filter((info) => drag.dragIdxSet.has(info.idx));
      const lastDraggedInfo = visibleDraggedRows[visibleDraggedRows.length - 1];
      const indicatorY = lastDraggedInfo ? lastDraggedInfo.rect.bottom + 1 : best.y;
      const indentPx = candidateDepth * INDENT_STEP_PX;
      this.dropIndicatorEl.style.left = `${containerRect.left + 46 + indentPx}px`;
      this.dropIndicatorEl.style.width = `${Math.max(120, containerRect.width - 46 - indentPx)}px`;
      this.dropIndicatorEl.style.top = `${indicatorY - 1.5}px`;
      this.dropIndicatorEl.hidden = false;
      drag.insertIndex = drag.dragIndices[0];
      drag.desiredOutdent = Math.max(0, naturalDepth - candidateDepth);
      return;
    }

    const firstDraggedBlock = this.blocks[drag.dragIndices[0]] || draggedBlock;
    const naturalDepth = this.computeDropDepth(
      best.insertIdx,
      firstDraggedBlock,
      drag.dragIdxSet
    );
    let targetDepth = naturalDepth;
    if (hasNonHeading && dx <= -14) {
      targetDepth = Math.max(
        0,
        Math.min(naturalDepth, Math.round((clientX - baseHandleX) / INDENT_STEP_PX))
      );
    }

    const indentPx = targetDepth * INDENT_STEP_PX;
    this.dropIndicatorEl.style.left = `${containerRect.left + 46 + indentPx}px`;
    this.dropIndicatorEl.style.width = `${Math.max(120, containerRect.width - 46 - indentPx)}px`;
    this.dropIndicatorEl.style.top = `${best.y - 1.5}px`;
    this.dropIndicatorEl.hidden = false;
    drag.insertIndex = best.insertIdx;
    drag.desiredOutdent = hasNonHeading ? Math.max(0, naturalDepth - targetDepth) : null;
  }

  computeDropDepth(insertIdx, draggedBlock, dragIdxSet) {
    const headingStack = [];
    for (let i = 0; i < insertIdx && i < this.blocks.length; i++) {
      if (dragIdxSet?.has(i)) continue;
      const b = this.blocks[i];
      if (b.type === "heading") {
        while (headingStack.length > 0 && headingStack[headingStack.length - 1] >= b.level) {
          headingStack.pop();
        }
        headingStack.push(b.level);
      } else if ((b.outdent || 0) > 0) {
        const popCount = Math.min(headingStack.length, b.outdent);
        for (let p = 0; p < popCount; p++) {
          headingStack.pop();
        }
      }
    }
    if (draggedBlock?.type === "heading") {
      while (headingStack.length > 0 && headingStack[headingStack.length - 1] >= draggedBlock.level) {
        headingStack.pop();
      }
    }
    return Math.min(4, headingStack.length);
  }

  scheduleEdgeScroll() {
    const step = () => {
      const drag = this.pointerDrag;
      if (!drag || !drag.started) return;

      const scrollEl = this.containerEl.closest(".editor-scroll");
      if (scrollEl) {
        const rect = scrollEl.getBoundingClientRect();
        const edge = 56;
        let delta = 0;
        if (drag.lastClientY < rect.top + edge) {
          delta = -Math.ceil(((rect.top + edge - drag.lastClientY) / edge) * 12);
        } else if (drag.lastClientY > rect.bottom - edge) {
          delta = Math.ceil(((drag.lastClientY - (rect.bottom - edge)) / edge) * 12);
        }
        if (delta !== 0) {
          scrollEl.scrollTop += delta;
          this.updateDropSlot(drag.lastClientX, drag.lastClientY);
        }
      }
      drag.scrollRaf = requestAnimationFrame(step);
    };
    this.pointerDrag.scrollRaf = requestAnimationFrame(step);
  }

  handlePointerUp() {
    const drag = this.pointerDrag;
    if (!drag) return;

    if (!drag.started) {
      const { sourceKind, blockId, btnRect } = drag;
      this.cleanupPointerDrag();
      if (sourceKind === "body") {
        this.clearBlockSelection();
        this.focusBlock(blockId, "end");
      } else {
        this.openBlockMenu(blockId, btnRect.left, btnRect.bottom + 4);
      }
      return;
    }

    const { sourceIdx, isMultiGroup, dragIdxSet, dragIndices, insertIndex, desiredOutdent } = drag;
    this.cleanupPointerDrag();

    if (insertIndex === null) {
      this.updateBlockSelectionBar();
      return;
    }
    const draggedBlock = this.blocks[sourceIdx];
    if (!draggedBlock) {
      this.updateBlockSelectionBar();
      return;
    }

    const outdentTargets = dragIndices.filter(
      (i) =>
        this.blocks[i] &&
        this.blocks[i].type !== "heading" &&
        (!isMultiGroup || this.selectedBlockIds.has(this.blocks[i].id))
    );
    const isReorder = !this.isDropNoOp(insertIndex, {
      sourceIdx,
      dragCount: dragIndices.length,
      isMultiGroup,
      dragIdxSet,
      dragIndices,
    });
    const isOutdentChange =
      desiredOutdent !== null &&
      desiredOutdent !== undefined &&
      outdentTargets.some((i) => (this.blocks[i].outdent || 0) !== desiredOutdent);

    if (isReorder || isOutdentChange) {
      this.pushUndoSnapshot();
      if (isOutdentChange) {
        for (const idx of outdentTargets) {
          if (desiredOutdent > 0) {
            this.blocks[idx].outdent = desiredOutdent;
          } else {
            delete this.blocks[idx].outdent;
          }
        }
      }
      if (isReorder) {
        const remaining = [];
        const moved = [];
        for (let i = 0; i < this.blocks.length; i++) {
          if (dragIdxSet.has(i)) moved.push(this.blocks[i]);
          else remaining.push(this.blocks[i]);
        }
        const removedBefore = dragIndices.filter((i) => i < insertIndex).length;
        const insertAt = Math.max(0, Math.min(remaining.length, insertIndex - removedBefore));
        remaining.splice(insertAt, 0, ...moved);
        this.blocks = remaining;
        if (isMultiGroup) {
          this.render();
          this.syncSelectedClasses();
        } else {
          this.render(moved[0].id, "end");
        }
      } else if (isMultiGroup) {
        this.render();
        this.syncSelectedClasses();
      } else {
        this.render(draggedBlock.id, "end");
      }
      this.onDirty();
      this.onCollapseChange(this.getCollapsedIndices());
    } else {
      this.updateBlockSelectionBar();
    }
  }

  cleanupPointerDrag() {
    const drag = this.pointerDrag;
    if (!drag) return;
    if (drag.captureEl && drag.pointerId !== undefined) {
      try {
        if (drag.captureEl.hasPointerCapture?.(drag.pointerId)) {
          drag.captureEl.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // Ignore capture release error
      }
    }
    if (drag.scrollRaf !== null) {
      cancelAnimationFrame(drag.scrollRaf);
    }
    if (drag.ghostEl) {
      drag.ghostEl.remove();
    }
    document.body.classList.remove("is-dragging-block");
    this.dropIndicatorEl.hidden = true;
    this.containerEl
      .querySelectorAll(".block-row.dragging, .block-row.drop-inside")
      .forEach((row) => row.classList.remove("dragging", "drop-inside"));
    this.pointerDrag = null;
  }
}
