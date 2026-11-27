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

/**
 * Custom lightweight modal dialog (replaces native prompt/confirm in WebView2).
 */
export class ModalDialog {
  constructor(backdropEl, titleEl, descEl, fieldEl, cancelBtn, confirmBtn) {
    this.backdropEl = backdropEl;
    this.titleEl = titleEl;
    this.descEl = descEl;
    this.fieldEl = fieldEl;
    this.cancelBtn = cancelBtn;
    this.confirmBtn = confirmBtn;
    this.resolver = null;

    this.cancelBtn.addEventListener("click", () => this.finish(null));
    this.confirmBtn.addEventListener("click", () => this.submit());
    this.backdropEl.addEventListener("mousedown", (e) => {
      if (e.target === this.backdropEl) this.finish(null);
    });
    this.fieldEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.finish(null);
      }
    });
    document.addEventListener("keydown", (e) => {
      if (!this.backdropEl.hidden && e.key === "Escape") {
        e.preventDefault();
        this.finish(null);
      }
    });
  }

  submit() {
    if (this.fieldEl.hidden) {
      this.finish(true);
    } else {
      this.finish(this.fieldEl.value);
    }
  }

  finish(value) {
    this.backdropEl.hidden = true;
    const res = this.resolver;
    this.resolver = null;
    if (res) res(value);
  }

  prompt({ title, description = "", defaultValue = "", placeholder = "", confirmLabel = "Confirm" }) {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.titleEl.textContent = title;
      if (description) {
        this.descEl.textContent = description;
        this.descEl.hidden = false;
      } else {
        this.descEl.hidden = true;
      }
      this.fieldEl.hidden = false;
      this.fieldEl.value = defaultValue;
      this.fieldEl.placeholder = placeholder;
      this.confirmBtn.textContent = confirmLabel;
      this.confirmBtn.style.background = "";
      this.backdropEl.hidden = false;
      this.fieldEl.focus();
      this.fieldEl.select();
    });
  }

  confirm({ title, description = "", confirmLabel = "Delete", danger = false }) {
    return new Promise((resolve) => {
      this.resolver = resolve;
      this.titleEl.textContent = title;
      if (description) {
        this.descEl.textContent = description;
        this.descEl.hidden = false;
      } else {
        this.descEl.hidden = true;
      }
      this.fieldEl.hidden = true;
      this.confirmBtn.textContent = confirmLabel;
      this.confirmBtn.style.background = danger ? "var(--danger)" : "";
      this.backdropEl.hidden = false;
      this.confirmBtn.focus();
    });
  }
}

/**
 * Sidebar file tree, context menus, and resizable divider controller.
 */
export class SidebarController {
  constructor(
    { treeEl, contextMenuEl, sidebarEl, resizerEl, vaultHeaderEl },
    { onOpenFile, onNewNote, onNewFolder, onRename, onDelete, onMoveEntry, onResizeEnd }
  ) {
    this.treeEl = treeEl;
    this.contextMenuEl = contextMenuEl;
    this.sidebarEl = sidebarEl;
    this.resizerEl = resizerEl;
    this.vaultHeaderEl = vaultHeaderEl;

    this.onOpenFile = onOpenFile;
    this.onNewNote = onNewNote;
    this.onNewFolder = onNewFolder;
    this.onRename = onRename;
    this.onDelete = onDelete;
    this.onMoveEntry = onMoveEntry;
    this.onResizeEnd = onResizeEnd;

    this.tree = [];
    this.activeFile = null;
    this.expandedDirs = new Set();
    this.treeDrag = null;
    this.suppressNextClick = false;

    document.addEventListener("mousedown", (e) => {
      if (!this.contextMenuEl.hidden && !this.contextMenuEl.contains(e.target)) {
        this.closeContextMenu();
      }
    });

    window.addEventListener("pointermove", (e) => this.handleTreePointerMove(e));
    window.addEventListener("pointerup", () => this.handleTreePointerUp());
    window.addEventListener("pointercancel", () => this.cleanupTreeDrag());
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.treeDrag?.started) {
        e.preventDefault();
        this.cleanupTreeDrag();
      }
    });

    this.initResizer();
  }

  initResizer() {
    let dragging = false;
    let startX = 0;
    let startWidth = 240;

    this.resizerEl.addEventListener("mousedown", (e) => {
      if (this.sidebarEl.classList.contains("collapsed")) return;
      dragging = true;
      startX = e.clientX;
      startWidth = this.sidebarEl.getBoundingClientRect().width;
      this.resizerEl.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const next = Math.min(480, Math.max(160, Math.round(startWidth + (e.clientX - startX))));
      this.sidebarEl.style.width = `${next}px`;
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      this.resizerEl.classList.remove("dragging");
      document.body.style.cursor = "";
      const width = Math.round(this.sidebarEl.getBoundingClientRect().width);
      this.onResizeEnd(width);
    });
  }

  setWidth(width) {
    const clamped = Math.min(480, Math.max(160, Number(width) || 240));
    this.sidebarEl.style.width = `${clamped}px`;
  }

  setCollapsed(collapsed) {
    this.sidebarEl.classList.toggle("collapsed", Boolean(collapsed));
    this.resizerEl.hidden = Boolean(collapsed);
  }

  setTree(tree, activeFile) {
    this.tree = tree || [];
    this.setActiveFile(activeFile);
  }

  setActiveFile(relPath) {
    this.activeFile = relPath || null;
    if (this.activeFile) {
      const parts = this.activeFile.split("/");
      for (let i = 1; i < parts.length; i++) {
        this.expandedDirs.add(parts.slice(0, i).join("/"));
      }
    }
    this.render();
  }

  closeContextMenu() {
    this.contextMenuEl.hidden = true;
    this.contextMenuEl.innerHTML = "";
  }

  openContextMenu(x, y, node) {
    const items = [];
    if (node.is_dir) {
      items.push({ label: "New Note Here", action: () => this.onNewNote(node.rel_path) });
      items.push({ label: "New Subfolder", action: () => this.onNewFolder(node.rel_path) });
      items.push({ divider: true });
    }
    items.push({ label: "Rename", action: () => this.onRename(node) });
    items.push({ label: "Delete", danger: true, action: () => this.onDelete(node) });

    this.contextMenuEl.innerHTML = items
      .map((item, idx) => {
        if (item.divider) return `<div class="popover-divider"></div>`;
        const cls = item.danger ? "popover-item danger" : "popover-item";
        return `<button class="${cls}" data-idx="${idx}" role="menuitem">${escapeHtml(item.label)}</button>`;
      })
      .join("");

    this.contextMenuEl.hidden = false;
    const rect = this.contextMenuEl.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    this.contextMenuEl.style.left = `${Math.max(8, left)}px`;
    this.contextMenuEl.style.top = `${Math.max(8, top)}px`;

    this.contextMenuEl.querySelectorAll(".popover-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = items[Number(btn.dataset.idx)];
        this.closeContextMenu();
        if (item?.action) item.action();
      });
    });
  }

  render() {
    this.treeEl.innerHTML = "";
    if (!this.tree.length) {
      this.treeEl.innerHTML = `<div class="tree-empty">No markdown files yet.</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    this.renderNodes(this.tree, 0, frag);
    this.treeEl.appendChild(frag);
  }

  renderNodes(nodes, depth, container) {
    for (const node of nodes) {
      const row = document.createElement("div");
      const isActive = !node.is_dir && this.activeFile === node.rel_path;
      const isExpanded = node.is_dir && this.expandedDirs.has(node.rel_path);

      row.className = `tree-row${isActive ? " active" : ""}`;
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.setAttribute("role", "treeitem");
      row.dataset.relPath = node.rel_path;
      row.dataset.isDir = String(Boolean(node.is_dir));
      row.title = node.rel_path;

      if (node.is_dir) {
        const chev = document.createElement("span");
        chev.className = `tree-chevron${isExpanded ? " expanded" : ""}`;
        chev.innerHTML = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 2.5L7.5 6L4 9.5"/></svg>`;
        row.appendChild(chev);

        const icon = document.createElement("span");
        icon.className = "tree-icon";
        icon.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1.5 3.5h4.2l1.3 1.4h7.5v7.6h-13z"/></svg>`;
        row.appendChild(icon);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "tree-spacer";
        row.appendChild(spacer);

        const icon = document.createElement("span");
        icon.className = "tree-icon";
        icon.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3.5 2h6l3 3v9h-9z"/><path d="M9.5 2v3h3"/></svg>`;
        row.appendChild(icon);
      }

      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = node.is_dir ? node.name : node.name.replace(/\.md$/i, "");
      row.appendChild(label);

      const actions = document.createElement("div");
      actions.className = "tree-row-actions";

      if (node.is_dir) {
        const addBtn = document.createElement("button");
        addBtn.className = "tree-mini-btn";
        addBtn.title = "New Note in Folder";
        addBtn.textContent = "+";
        addBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.expandedDirs.add(node.rel_path);
          this.onNewNote(node.rel_path);
        });
        actions.appendChild(addBtn);
      }

      const moreBtn = document.createElement("button");
      moreBtn.className = "tree-mini-btn";
      moreBtn.title = "Actions";
      moreBtn.textContent = "⋯";
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const rect = moreBtn.getBoundingClientRect();
        this.openContextMenu(rect.left, rect.bottom + 4, node);
      });
      actions.appendChild(moreBtn);
      row.appendChild(actions);

      row.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest(".tree-mini-btn")) return;
        this.cleanupTreeDrag();
        this.treeDrag = {
          node,
          sourceRow: row,
          startX: e.clientX,
          startY: e.clientY,
          started: false,
          ghostEl: null,
          targetFolder: null,
          autoExpandTimer: null,
          lastHoverDir: null,
        };
      });

      row.addEventListener("click", () => {
        if (this.suppressNextClick) {
          this.suppressNextClick = false;
          return;
        }
        if (node.is_dir) {
          if (this.expandedDirs.has(node.rel_path)) {
            this.expandedDirs.delete(node.rel_path);
          } else {
            this.expandedDirs.add(node.rel_path);
          }
          this.render();
        } else {
          this.onOpenFile(node.rel_path);
        }
      });

      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openContextMenu(e.clientX, e.clientY, node);
      });

      container.appendChild(row);

      if (node.is_dir && isExpanded && node.children?.length) {
        this.renderNodes(node.children, depth + 1, container);
      }
    }
  }

  parentDir(relPath) {
    const idx = relPath.lastIndexOf("/");
    return idx === -1 ? "" : relPath.slice(0, idx);
  }

  isValidMoveTarget(node, targetFolder) {
    if (targetFolder === null || targetFolder === undefined) return false;
    const currentParent = this.parentDir(node.rel_path);
    if (currentParent === targetFolder) return false;
    if (node.is_dir) {
      if (targetFolder === node.rel_path || targetFolder.startsWith(`${node.rel_path}/`)) {
        return false;
      }
    }
    return true;
  }

  clearDropHighlights() {
    this.treeEl
      .querySelectorAll(".tree-drop-target")
      .forEach((el) => el.classList.remove("tree-drop-target"));
    this.treeEl.classList.remove("tree-drop-root");
  }

  handleTreePointerMove(e) {
    const drag = this.treeDrag;
    if (!drag) return;

    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) {
        return;
      }
      drag.started = true;
      this.suppressNextClick = true;
      this.closeContextMenu();
      drag.sourceRow.classList.add("dragging");
      document.body.classList.add("is-dragging-tree");

      const ghost = document.createElement("div");
      ghost.className = "tree-drag-ghost";
      ghost.textContent = drag.node.is_dir
        ? drag.node.name
        : drag.node.name.replace(/\.md$/i, "");
      document.body.appendChild(ghost);
      drag.ghostEl = ghost;
    }

    if (drag.ghostEl) {
      drag.ghostEl.style.left = `${Math.min(window.innerWidth - 160, e.clientX + 12)}px`;
      drag.ghostEl.style.top = `${Math.max(8, Math.min(window.innerHeight - 36, e.clientY - 12))}px`;
    }

    this.clearDropHighlights();

    const elUnder = document.elementFromPoint(e.clientX, e.clientY);
    const hoverRow = elUnder?.closest?.(".tree-row");
    let targetFolder = null;

    if (hoverRow && this.treeEl.contains(hoverRow)) {
      const rel = hoverRow.dataset.relPath || "";
      const isDir = hoverRow.dataset.isDir === "true";
      targetFolder = isDir ? rel : this.parentDir(rel);

      if (isDir && rel !== drag.lastHoverDir) {
        clearTimeout(drag.autoExpandTimer);
        drag.lastHoverDir = rel;
        if (!this.expandedDirs.has(rel) && this.isValidMoveTarget(drag.node, rel)) {
          drag.autoExpandTimer = setTimeout(() => {
            if (this.treeDrag?.started && this.treeDrag.lastHoverDir === rel) {
              this.expandedDirs.add(rel);
              this.render();
            }
          }, 550);
        }
      }
    } else if (
      (elUnder && this.treeEl.contains(elUnder)) ||
      (this.vaultHeaderEl && elUnder && this.vaultHeaderEl.contains(elUnder))
    ) {
      targetFolder = "";
      clearTimeout(drag.autoExpandTimer);
      drag.lastHoverDir = null;
    } else {
      clearTimeout(drag.autoExpandTimer);
      drag.lastHoverDir = null;
    }

    if (!this.isValidMoveTarget(drag.node, targetFolder)) {
      drag.targetFolder = null;
      return;
    }

    drag.targetFolder = targetFolder;
    if (targetFolder === "") {
      this.treeEl.classList.add("tree-drop-root");
    } else {
      const folderRow = this.treeEl.querySelector(
        `.tree-row[data-rel-path="${CSS.escape(targetFolder)}"]`
      );
      if (folderRow) {
        folderRow.classList.add("tree-drop-target");
      }
    }
  }

  handleTreePointerUp() {
    const drag = this.treeDrag;
    if (!drag) return;

    if (!drag.started) {
      this.cleanupTreeDrag();
      return;
    }

    const { node, targetFolder } = drag;
    this.cleanupTreeDrag();
    setTimeout(() => {
      this.suppressNextClick = false;
    }, 0);

    if (targetFolder !== null && this.isValidMoveTarget(node, targetFolder)) {
      if (targetFolder) {
        this.expandedDirs.add(targetFolder);
      }
      this.onMoveEntry?.(node, targetFolder);
    }
  }

  cleanupTreeDrag() {
    const drag = this.treeDrag;
    if (!drag) return;
    clearTimeout(drag.autoExpandTimer);
    if (drag.ghostEl) drag.ghostEl.remove();
    drag.sourceRow?.classList.remove("dragging");
    document.body.classList.remove("is-dragging-tree");
    this.clearDropHighlights();
    this.treeDrag = null;
  }
}
