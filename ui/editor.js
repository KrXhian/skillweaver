import {
  buildPageLookup,
  domToInlineMarkdown,
  escapeHtml,
  inlineMarkdownToHtml,
  tryAutoFormatInline,
} from "./inline.js";
import { LinkAutocomplete } from "./links.js";

const CODE_LANGUAGES = [
  "text",
  "javascript",
  "typescript",
  "python",
  "rust",
  "html",
  "css",
  "json",
  "bash",
  "sql",
  "markdown",
];

const SLASH_ITEMS = [
  { id: "paragraph", label: "Text", hint: "Plain text block" },
  { id: "h1", label: "Heading 1", hint: "# Collapsible header" },
  { id: "h2", label: "Heading 2", hint: "## Collapsible header" },
  { id: "h3", label: "Heading 3", hint: "### Collapsible header" },
  { id: "code", label: "Code Block", hint: "``` Fenced code" },
];

const INDENT_STEP_PX = 26;

let localIdSeq = 1;
function genBlockId() {
  localIdSeq += 1;
  return `blk-${Date.now().toString(36)}-${localIdSeq}`;
}

function cloneBlocks(blocks) {
  return blocks.map((b) => ({ ...b }));
}

function genObsidianBlockId(existingBlocks) {
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

function setCaretAtEdge(el, atEnd) {
  el.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(!atEnd);
  sel.removeAllRanges();
  sel.addRange(range);
}

function setCaretAtCharOffset(root, targetOffset) {
  root.focus();
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
 * Notion-style block editor with collapsible headings, bold/inline-code, code blocks, and @@ links.
 */
export class BlockEditor {
  constructor(
    {
      containerEl,
      selectionToolbarEl,
      boldBtn,
      inlineCodeBtn,
      highlightBtn,
      askAiSelBtn,
      linkPopoverEl,
      slashPopoverEl,
      blockMenuEl,
      blockSelectionBarEl,
      blockSelectionCountEl,
      blocksAskAiBtn,
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
    this.slashPopoverEl = slashPopoverEl;
    this.blockMenuEl = blockMenuEl;
    this.blockSelectionBarEl = blockSelectionBarEl;
    this.blockSelectionCountEl = blockSelectionCountEl;
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
    this.marquee = null;
    this.suppressNextBottomClick = false;
    this._lastSelectionSig = "";

    this.dropIndicatorEl = document.createElement("div");
    this.dropIndicatorEl.className = "drop-indicator";
    this.dropIndicatorEl.hidden = true;
    document.body.appendChild(this.dropIndicatorEl);

    window.addEventListener("pointermove", (e) => {
      this.handleMarqueeMove(e);
      this.handlePointerMove(e);
    });
    window.addEventListener("pointerup", (e) => {
      this.handleMarqueeUp(e);
      this.handlePointerUp(e);
    });
    window.addEventListener("pointercancel", () => {
      this.cleanupMarquee();
      this.cleanupPointerDrag();
    });
    window.addEventListener("resize", () => this.updateBlockSelectionBar());
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.pointerDrag?.started) {
        e.preventDefault();
        this.cleanupPointerDrag();
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
          this.blocks[idx].content = domToInlineMarkdown(editableEl);
          this.onDirty();
        }
      },
    });

    boldBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.toggleInlineTag("STRONG");
    });

    inlineCodeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.toggleInlineTag("CODE");
    });

    highlightBtn?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.toggleInlineTag("MARK");
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
      if (!this.blockMenuEl.hidden && !this.blockMenuEl.contains(e.target)) {
        this.closeBlockMenu();
      }
    });

    document.addEventListener("paste", (e) => {
      const scrollEl = this.containerEl.closest(".editor-scroll");
      if (!scrollEl || scrollEl.hidden) return;
      const target = e.target;
      if (
        target?.closest(".block-editable") ||
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
            ".gutter-btn, .heading-toggle, .collapsed-badge, .code-copy-btn, .code-lang-select"
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

    // Notion-style Ctrl+Click / Shift+Click multi-block selection
    this.containerEl.addEventListener(
      "mousedown",
      (e) => {
        if (e.button !== 0) return;
        const row = e.target.closest(".block-row");
        if (!row) return;

        const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
        const shiftRange = e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && this.selectedBlockIds.size > 0;

        if (mod || shiftRange) {
          if (e.target.closest(".heading-toggle, .collapsed-badge, .code-copy-btn, .code-lang-select, .gutter-btn")) {
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
    this.closeSlashMenu();
    this.closeBlockMenu();
    this.linkAutocomplete.close();
    this.hideSelectionToolbar();
    this.render();
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

  syncAllEditableFromDom() {
    this.containerEl.querySelectorAll(".block-editable").forEach((el) => {
      const row = el.closest(".block-row");
      const id = row?.dataset.id;
      const b = this.blocks.find((item) => item.id === id);
      if (b) {
        b.content = domToInlineMarkdown(el);
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
    const lookup = buildPageLookup(this.getPages());
    const { visible, hiddenCounts, depths } = this.computeVisibility();

    this.containerEl.innerHTML = "";
    const frag = document.createDocumentFragment();

    for (let i = 0; i < this.blocks.length; i++) {
      if (!visible[i]) continue;
      const block = this.blocks[i];
      const row = this.createBlockRow(block, i, hiddenCounts[i], depths[i], lookup);
      frag.appendChild(row);
    }

    this.containerEl.appendChild(frag);

    if (focusBlockId) {
      this.focusBlock(focusBlockId, caretMode, charOffset);
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
    if (last.type !== "paragraph" || last.content.trim() !== "") {
      const nb = { id: genBlockId(), type: "paragraph", content: "" };
      this.pushUndoSnapshot();
      this.blocks.push(nb);
      this.render(nb.id, "start");
      this.onDirty();
    } else {
      this.focusBlock(last.id, "end");
    }
  }

  createBlockRow(block, idx, hiddenCount, depth, pageLookup) {
    const row = document.createElement("div");
    row.className = "block-row";
    row.dataset.id = block.id;
    row.dataset.idx = String(idx);
    row.dataset.depth = String(depth);
    row.style.setProperty("--block-depth", String(depth));

    if (block.type === "heading") {
      row.classList.add("block-heading", `block-heading-${Math.min(3, Math.max(1, block.level))}`);
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
      }

      const editable = document.createElement("div");
      editable.className = "block-editable";
      editable.contentEditable = "true";
      editable.spellcheck = true;
      editable.dataset.placeholder =
        block.type === "heading"
          ? `Heading ${block.level}`
          : "Type text, # for header, ``` for code, @@ to link...";
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

    const ta = document.createElement("textarea");
    ta.className = "code-textarea";
    ta.spellcheck = false;
    ta.placeholder = "Write code...";
    ta.value = block.content || "";

    const autoResize = () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.max(48, ta.scrollHeight)}px`;
    };
    requestAnimationFrame(autoResize);

    let typedSinceSnap = false;
    ta.addEventListener("input", () => {
      if (!typedSinceSnap) {
        this.pushUndoSnapshot();
        typedSinceSnap = true;
      }
      const b = this.blocks.find((x) => x.id === block.id);
      if (b) b.content = ta.value;
      autoResize();
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
        autoResize();
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

    card.appendChild(ta);
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

        // ``` or ```lang + Enter -> Code block
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
        }

        // Expand collapsed heading before inserting paragraph beneath it
        if (block.type === "heading" && this.collapsedIds.has(block.id)) {
          this.collapsedIds.delete(block.id);
          this.onCollapseChange(this.getCollapsedIndices());
        }

        const { before, after } = extractInlineMdBeforeAndAfterCaret(editable);
        this.pushUndoSnapshot();
        this.blocks[idx].content = before;
        const newPara = { id: genBlockId(), type: "paragraph", content: after };
        this.blocks.splice(idx + 1, 0, newPara);
        this.render(newPara.id, "start");
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
          if (block.type === "heading") {
            e.preventDefault();
            this.pushUndoSnapshot();
            this.collapsedIds.delete(block.id);
            this.blocks[idx] = {
              id: block.id,
              type: "paragraph",
              content: domToInlineMarkdown(editable),
            };
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
            if (prev.type === "code") {
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
      )?.closest(".block-editable");
    if (!editable || !editable.contains(range.endContainer)) return;
    if (range.collapsed) return;

    const idx = this.findBlockIndexByEl(editable);
    if (idx === -1) return;

    this.pushUndoSnapshot();

    const startAncestor = (
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement
    )?.closest(tagName);
    const endAncestor = (
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? range.endContainer
        : range.endContainer.parentElement
    )?.closest(tagName);

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

    this.blocks[idx].content = domToInlineMarkdown(editable);
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
    )?.closest(".block-editable");
    if (!editable || !editable.contains(range.endContainer) || !range.toString().trim()) {
      this.hideSelectionToolbar();
      return;
    }

    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      this.hideSelectionToolbar();
      return;
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
  }

  /* Minimal 5-item Slash Menu */
  openSlashMenu(blockId, editableEl, query) {
    const q = query.trim().toLowerCase();
    const filtered = SLASH_ITEMS.filter(
      (item) => item.label.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q)
    );
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
    } else if (item.id === "code") {
      this.blocks[blockIdx] = { id: blockId, type: "code", language: "", content: "" };
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
        out.push({ idx: i, block: { ...b } });
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
        out.push({ ...b });
      }
      if (b.type === "heading" && this.collapsedIds.has(b.id)) {
        const hc = hiddenCounts[i] || 0;
        for (let k = 1; k <= hc && i + k < this.blocks.length; k++) {
          const child = this.blocks[i + k];
          if (child && !seen.has(child.id)) {
            seen.add(child.id);
            out.push({ ...child });
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
      const copy = { ...block, id: genBlockId() };
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
          const cls = a.danger ? "popover-item danger" : "popover-item";
          const sc = a.shortcut ? `<span class="popover-shortcut">${escapeHtml(a.shortcut)}</span>` : "";
          return `<button class="${cls}" data-idx="${i}" role="menuitem"><span>${escapeHtml(a.label)}</span>${sc}</button>`;
        })
        .join("");

      this.blockMenuEl.hidden = false;
      const rect = this.blockMenuEl.getBoundingClientRect();
      this.blockMenuEl.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
      this.blockMenuEl.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

      this.blockMenuEl.querySelectorAll(".popover-item").forEach((btn) => {
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
        run: () => this.onAskAiBlock?.({ ...this.blocks[idx] }),
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
        { label: "Code Block", run: () => this.turnBlockInto(idx, "code") },
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
        const cls = a.danger ? "popover-item danger" : "popover-item";
        const sc = a.shortcut ? `<span class="popover-shortcut">${escapeHtml(a.shortcut)}</span>` : "";
        return `<button class="${cls}" data-idx="${i}" ${a.disabled ? "disabled" : ""} role="menuitem"><span>${escapeHtml(a.label)}</span>${sc}</button>`;
      })
      .join("");

    this.blockMenuEl.hidden = false;
    const rect = this.blockMenuEl.getBoundingClientRect();
    this.blockMenuEl.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
    this.blockMenuEl.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

    this.blockMenuEl.querySelectorAll(".popover-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = actions[Number(btn.dataset.idx)];
        this.closeBlockMenu();
        if (item?.run && !item.disabled) item.run();
      });
    });
  }

  closeBlockMenu() {
    this.blockMenuEl.hidden = true;
    this.blockMenuEl.innerHTML = "";
    this.menuTargetBlockId = null;
    this.syncSelectedClasses();
  }

  ensureBlockId(idx) {
    const block = this.blocks[idx];
    if (!block) return null;
    if (block.block_id) return block.block_id;
    const bid = genObsidianBlockId(this.blocks);
    block.block_id = bid;
    this.onDirty();
    return bid;
  }

  duplicateBlock(idx) {
    this.syncAllEditableFromDom();
    const src = this.blocks[idx];
    if (!src) return;
    this.pushUndoSnapshot();
    const copy = { ...src, id: genBlockId() };
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
    return { idx, block: { ...this.blocks[idx] } };
  }

  getSelectedTextContext() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const editable = (
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement
    )?.closest(".block-editable");
    if (!editable || !this.containerEl.contains(editable)) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    this.syncAllEditableFromDom();
    const idx = this.findBlockIndexByEl(editable);
    const block = idx !== -1 ? { ...this.blocks[idx] } : null;
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

  findBlockIndexByAnyId(idOrObsidianId) {
    if (!idOrObsidianId) return -1;
    const clean = String(idOrObsidianId).trim();
    const stripped = clean.startsWith("^") ? clean.slice(1) : clean;
    return this.blocks.findIndex((b) => b.id === clean || b.block_id === stripped);
  }

  normalizeAiBlockPayload(raw, preserveId = null, preserveObsidianId = null) {
    const id = preserveId || genBlockId();
    const base = preserveObsidianId ? { block_id: preserveObsidianId } : {};
    const type = raw?.type || "paragraph";
    if (type === "heading") {
      return {
        id,
        ...base,
        type: "heading",
        level: Math.min(3, Math.max(1, Number(raw.level) || 1)),
        content: String(raw.content || ""),
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
    return {
      id,
      ...base,
      type: "paragraph",
      content: String(raw?.content || ""),
    };
  }

  applyAiEdits(ops) {
    if (!Array.isArray(ops) || !ops.length) return false;
    this.syncAllEditableFromDom();
    this.pushUndoSnapshot();

    const touchedIds = [];
    for (const op of ops) {
      if (op.op === "replace" && op.block) {
        const idx = this.findBlockIndexByAnyId(op.block_id);
        if (idx !== -1) {
          const prev = this.blocks[idx];
          this.blocks[idx] = this.normalizeAiBlockPayload(op.block, prev.id, prev.block_id);
          touchedIds.push(prev.id);
        }
      } else if (op.op === "insert_after" && Array.isArray(op.blocks)) {
        const idx = this.findBlockIndexByAnyId(op.block_id);
        const insertAt = idx !== -1 ? idx + 1 : this.blocks.length;
        const created = op.blocks.map((b) => this.normalizeAiBlockPayload(b));
        this.blocks.splice(insertAt, 0, ...created);
        created.forEach((b) => touchedIds.push(b.id));
      } else if (op.op === "append" && Array.isArray(op.blocks)) {
        const created = op.blocks.map((b) => this.normalizeAiBlockPayload(b));
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
    return true;
  }

  appendBlocks(newBlocks) {
    if (!Array.isArray(newBlocks) || !newBlocks.length) return;
    this.syncAllEditableFromDom();
    this.pushUndoSnapshot();
    const mapped = newBlocks.map((b) => ({ ...b, id: genBlockId() }));
    if (
      this.blocks.length === 1 &&
      this.blocks[0].type === "paragraph" &&
      this.blocks[0].content.trim() === ""
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
    if (type === "paragraph") {
      this.blocks[idx] = { id: old.id, type: "paragraph", content: old.content || "" };
    } else if (type === "heading") {
      this.blocks[idx] = { id: old.id, type: "heading", level, content: old.content || "" };
    } else if (type === "code") {
      this.blocks[idx] = {
        id: old.id,
        type: "code",
        language: old.language || "",
        content: old.content || "",
      };
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
