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

const FOLDER_PALETTE_DARK = [
  "#34d399", // Emerald
  "#38bdf8", // Sky
  "#fbbf24", // Amber
  "#2dd4bf", // Teal
  "#818cf8", // Indigo
  "#fb923c", // Orange
  "#f472b6", // Pink
];

const FOLDER_PALETTE_LIGHT = [
  "#059669", // Emerald
  "#0284c7", // Sky
  "#d97706", // Amber
  "#0d9488", // Teal
  "#4f46e5", // Indigo
  "#ea580c", // Orange
  "#db2777", // Pink
];

function topLevelFolder(folder) {
  const trimmed = String(folder || "").trim();
  if (!trimmed) return "";
  return trimmed.split("/")[0] || "";
}

function normalizeNodeId(id) {
  return String(id || "")
    .replace(/\\/g, "/")
    .trim()
    .toLowerCase();
}

function orderedPairKey(a, b) {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function rectsOverlap(a, b, padX = 5, padY = 4) {
  return !(
    a.x + a.w + padX < b.x ||
    b.x + b.w + padX < a.x ||
    a.y + a.h + padY < b.y ||
    b.y + b.h + padY < a.y
  );
}

function formatTokens(n) {
  const val = Number(n) || 0;
  if (val >= 1000) return `~${(val / 1000).toFixed(1)}k`;
  return `~${val}`;
}

function parseColorRgb(color) {
  const s = String(color || "").trim();
  if (s.startsWith("#")) {
    let hex = s.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        return { r, g, b };
      }
    }
  }
  const rgbMatch = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    return {
      r: Number(rgbMatch[1]),
      g: Number(rgbMatch[2]),
      b: Number(rgbMatch[3]),
    };
  }
  return { r: 148, g: 163, b: 184 };
}

function colorWithAlpha(color, alpha) {
  const { r, g, b } = parseColorRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function blendColors(baseColor, tintColor, weight) {
  const t = Math.min(1, Math.max(0, Number(weight) || 0));
  const a = parseColorRgb(baseColor);
  const b = parseColorRgb(tintColor);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

/**
 * Interactive force-directed knowledge graph supporting both side-docked live exploration
 * and fullscreen mode with folder clusters, active note highlighting, and AI integration.
 */
export class GraphView {
  constructor(elements, callbacks) {
    this.viewEl = elements.viewEl;
    this.canvasWrapEl = elements.canvasWrapEl || elements.viewEl;
    this.canvasEl = elements.canvasEl;
    this.filterInputEl = elements.filterInputEl;
    this.localToggleBtn = elements.localToggleBtn;
    this.orphansToggleBtn = elements.orphansToggleBtn;
    this.arrowsToggleBtn = elements.arrowsToggleBtn;
    this.skillsToggleBtn = elements.skillsToggleBtn;
    this.refreshBtn = elements.refreshBtn;
    this.statsEl = elements.statsEl;
    this.sideStatsEl = elements.sideStatsEl;
    this.sideLocalToggleBtn = elements.sideLocalToggleBtn;
    this.sideFilterToggleBtn = elements.sideFilterToggleBtn;
    this.sideRefreshBtn = elements.sideRefreshBtn;
    this.expandBtn = elements.expandBtn;
    this.dockBtn = elements.dockBtn;
    this.closeBtn = elements.closeBtn;
    this.sideCloseBtn = elements.sideCloseBtn;
    this.legendEl = elements.legendEl;
    this.inspectorEl = elements.inspectorEl;
    this.sideFooterEl = elements.sideFooterEl;
    this.zoomLocateBtn = elements.zoomLocateBtn;
    this.zoomInBtn = elements.zoomInBtn;
    this.zoomOutBtn = elements.zoomOutBtn;
    this.zoomFitBtn = elements.zoomFitBtn;

    this.invoke = callbacks.invoke;
    this.getCurrentFile = callbacks.getCurrentFile || (() => null);
    this.onOpenNode = callbacks.onOpenNode || (() => {});
    this.onAskAiNode = callbacks.onAskAiNode || (() => {});
    this.onAskAiCluster = callbacks.onAskAiCluster || (() => {});
    this.onExpand = callbacks.onExpand || (() => {});
    this.onDock = callbacks.onDock || (() => {});
    this.onClose = callbacks.onClose || (() => {});
    this.onToast = callbacks.onToast || (() => {});

    this.isOpen = false;
    this.displayMode = "side";
    this.sideFiltersOpen = false;
    this.activePulseUntil = 0;

    this.localMode = false;
    this.localCenterId = null;
    this.showOrphans = true;
    this.showArrows = true;
    this.showSkills = true;
    this.filterText = "";
    this.activeFolderGroup = null;
    this.hoveredFolderGroup = null;

    this.rawNodes = [];
    this.rawEdges = [];
    this.nodes = [];
    this.edges = [];
    this.displayEdges = [];
    this.nodeMap = new Map();
    this.outAdjMap = new Map();
    this.inAdjMap = new Map();
    this.adjMap = new Map();
    this.directedWeightMap = new Map();
    this.pairEdgeMap = new Map();
    this.folderIndexMap = new Map();
    this.relevanceMap = null;

    this.camera = { x: 0, y: 0, zoom: 1 };
    this.cameraAnim = null;
    this.energy = 0;
    this.rafId = null;

    this.selectedNodeId = null;
    this.hoveredNodeId = null;
    this.draggedNode = null;
    this.isPanning = false;
    this.pointerStart = { x: 0, y: 0 };
    this.panOrigin = { x: 0, y: 0 };
    this.pointerMoved = false;
    this.lastClickNodeId = null;
    this.lastClickTime = 0;

    this.ctx = this.canvasEl.getContext("2d");
    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    if (this.viewEl) {
      this.viewEl.dataset.mode = this.displayMode;
    }
    this.bindEvents();
  }

  bindEvents() {
    this.resizeObserver = new ResizeObserver(() => {
      if (this.isOpen) {
        this.resizeCanvas();
        this.draw();
      }
    });
    this.resizeObserver.observe(this.canvasWrapEl);

    this.filterInputEl?.addEventListener("input", () => {
      this.filterText = this.filterInputEl.value.trim().toLowerCase();
      this.rebuildActiveGraph(false);
    });

    this.localToggleBtn?.addEventListener("click", () => {
      this.toggleLocalMode();
    });

    this.sideLocalToggleBtn?.addEventListener("click", () => {
      this.toggleLocalMode();
    });

    this.sideFilterToggleBtn?.addEventListener("click", () => {
      this.setSideFiltersOpen(!this.sideFiltersOpen, { focusInput: !this.sideFiltersOpen });
    });

    this.orphansToggleBtn?.addEventListener("click", () => {
      this.showOrphans = !this.showOrphans;
      this.syncControlStates();
      this.rebuildActiveGraph(false);
    });

    this.arrowsToggleBtn?.addEventListener("click", () => {
      this.showArrows = !this.showArrows;
      this.syncControlStates();
      this.draw();
    });

    this.skillsToggleBtn?.addEventListener("click", () => {
      this.showSkills = !this.showSkills;
      this.syncControlStates();
      this.rebuildActiveGraph(false);
    });

    this.refreshBtn?.addEventListener("click", () => {
      this.resetToDefault({ reload: true, notify: true });
    });

    this.sideRefreshBtn?.addEventListener("click", () => {
      this.resetToDefault({ reload: true, notify: true });
    });

    this.expandBtn?.addEventListener("click", () => this.onExpand());
    this.dockBtn?.addEventListener("click", () => this.onDock());
    this.closeBtn?.addEventListener("click", () => this.onClose());
    this.sideCloseBtn?.addEventListener("click", () => this.onClose());

    this.zoomLocateBtn?.addEventListener("click", () => this.locateCurrentNode(true));
    this.zoomInBtn?.addEventListener("click", () => this.zoomBy(1.25));
    this.zoomOutBtn?.addEventListener("click", () => this.zoomBy(0.8));
    this.zoomFitBtn?.addEventListener("click", () => this.fitToView(true));

    this.canvasEl.addEventListener("wheel", (e) => this.handleWheel(e), { passive: false });
    this.canvasEl.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
    window.addEventListener("pointermove", (e) => this.handlePointerMove(e));
    window.addEventListener("pointerup", (e) => this.handlePointerUp(e));
    this.canvasEl.addEventListener("pointerleave", () => {
      if (!this.draggedNode && !this.isPanning && this.hoveredNodeId !== null) {
        this.hoveredNodeId = null;
        this.canvasEl.style.cursor = "grab";
        this.renderSideFooter();
        this.draw();
      }
    });

    window.addEventListener("keydown", (e) => this.handleKeydown(e));
  }

  syncControlStates() {
    this.localToggleBtn?.classList.toggle("active", this.localMode);
    this.sideLocalToggleBtn?.classList.toggle("active", this.localMode);
    this.orphansToggleBtn?.classList.toggle("active", this.showOrphans);
    this.arrowsToggleBtn?.classList.toggle("active", this.showArrows);
    this.skillsToggleBtn?.classList.toggle("active", this.showSkills);
    this.sideFilterToggleBtn?.classList.toggle("active", this.sideFiltersOpen);
  }

  setSideFiltersOpen(open, { focusInput = false } = {}) {
    this.sideFiltersOpen = Boolean(open);
    this.viewEl?.classList.toggle("side-filters-open", this.sideFiltersOpen);
    this.syncControlStates();
    if (this.sideFiltersOpen && focusInput) {
      this.filterInputEl?.focus();
      this.filterInputEl?.select();
    }
    this.resizeCanvas();
    this.draw();
    if (this.isOpen) {
      requestAnimationFrame(() => {
        if (this.isOpen) {
          this.resizeCanvas();
          this.draw();
        }
      });
    }
  }

  resetToDefault({ reload = false, relayout = false, notify = false } = {}) {
    this.cameraAnim = null;
    this.localMode = false;
    this.localCenterId = null;
    this.showOrphans = true;
    this.showArrows = true;
    this.showSkills = true;
    this.filterText = "";
    if (this.filterInputEl) {
      this.filterInputEl.value = "";
    }
    this.activeFolderGroup = null;
    this.hoveredFolderGroup = null;
    this.selectedNodeId = null;
    this.hoveredNodeId = null;
    this.draggedNode = null;
    this.isPanning = false;
    this.lastClickNodeId = null;
    this.lastClickTime = 0;
    this.activePulseUntil = 0;
    this.sideFiltersOpen = false;
    this.viewEl?.classList.remove("side-filters-open");
    this.camera = { x: 0, y: 0, zoom: 1 };
    if (this.canvasEl) {
      this.canvasEl.style.cursor = "grab";
    }
    this.syncControlStates();

    if (!reload && !relayout) {
      this.stopSimulation();
      this.nodes = [];
      this.edges = [];
      this.displayEdges = [];
      this.nodeMap.clear();
      this.outAdjMap.clear();
      this.inAdjMap.clear();
      this.adjMap.clear();
      this.directedWeightMap.clear();
      this.pairEdgeMap.clear();
      this.relevanceMap = null;
      if (this.legendEl) this.legendEl.innerHTML = "";
      this.renderInspector();
      this.renderSideFooter();
      return;
    }

    if (reload && this.isOpen) {
      this.loadAndRender(true);
    } else if (relayout && this.isOpen) {
      if (this.rawNodes.length > 0) {
        this.rebuildActiveGraph(true);
      } else {
        this.loadAndRender(true);
      }
    }

    if (notify) {
      this.onToast("Graph reset to default", false);
    }
  }

  setDisplayMode(mode) {
    const nextMode = mode === "fullscreen" ? "fullscreen" : "side";
    const changed = this.displayMode !== nextMode;
    const exitingFullscreen = this.displayMode === "fullscreen" && nextMode === "side";
    this.displayMode = nextMode;
    if (this.viewEl) {
      this.viewEl.dataset.mode = nextMode;
    }
    this.renderInspector();
    this.renderSideFooter();

    if (this.isOpen) {
      requestAnimationFrame(() => {
        if (!this.isOpen) return;
        this.resizeCanvas();
        if (exitingFullscreen) {
          this.resetToDefault({ reload: false, relayout: true });
        } else if (changed && this.nodes.length > 0) {
          this.fitToView(false);
        } else {
          this.draw();
        }
      });
    }
  }

  clearData() {
    this.resetToDefault({ reload: false, relayout: false });
    this.rawNodes = [];
    this.rawEdges = [];
    this.folderIndexMap.clear();
    if (this.statsEl) this.statsEl.textContent = "0 nodes · 0 links";
    if (this.sideStatsEl) this.sideStatsEl.textContent = "0 nodes · 0 links";
  }

  findNodeById(id) {
    if (!id) return null;
    const direct = this.nodeMap.get(id);
    if (direct) return direct;
    const targetNorm = normalizeNodeId(id);
    for (const node of this.nodes) {
      if (normalizeNodeId(node.id) === targetNorm) return node;
    }
    return null;
  }

  isCurrentNode(node, currentFile) {
    if (!node || !currentFile) return false;
    return normalizeNodeId(node.id) === normalizeNodeId(currentFile);
  }

  handleEscape() {
    if (!this.isOpen) return false;
    const active = document.activeElement;
    if (active === this.filterInputEl) {
      if (this.filterInputEl.value) {
        this.filterInputEl.value = "";
        this.filterText = "";
        this.rebuildActiveGraph(false);
      } else {
        this.filterInputEl.blur();
        if (this.displayMode === "side" && this.sideFiltersOpen) {
          this.setSideFiltersOpen(false);
        }
      }
      return true;
    }
    if (this.displayMode === "fullscreen" && this.selectedNodeId) {
      this.selectNode(null);
      return true;
    }
    if (this.activeFolderGroup) {
      this.activeFolderGroup = null;
      this.rebuildActiveGraph(false);
      return true;
    }
    if (this.displayMode === "side" && this.sideFiltersOpen) {
      this.setSideFiltersOpen(false);
      return true;
    }
    return false;
  }

  handleKeydown(e) {
    if (!this.isOpen) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const active = document.activeElement;
    if (this.displayMode === "side") {
      if (!active || !this.viewEl?.contains(active)) return;
    } else if (active?.closest?.(".ai-panel")) {
      return;
    }

    const isTyping =
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.isContentEditable);

    if (e.key === "Escape") {
      if (this.displayMode === "side" && this.handleEscape()) {
        e.preventDefault();
      }
      return;
    }

    if (isTyping) return;

    if (e.key === "/") {
      e.preventDefault();
      if (this.displayMode === "side") {
        this.setSideFiltersOpen(true, { focusInput: true });
      } else {
        this.filterInputEl?.focus();
        this.filterInputEl?.select();
      }
    } else if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      this.fitToView(true);
    } else if (e.key === "l" || e.key === "L") {
      e.preventDefault();
      this.toggleLocalMode();
    } else if (e.key === "c" || e.key === "C") {
      e.preventDefault();
      this.locateCurrentNode(true);
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      this.resetToDefault({ reload: true, notify: true });
    } else if (e.key === "Enter" && this.selectedNodeId) {
      if (active && active.closest?.(".graph-controls, .graph-inspector, .graph-legend")) {
        return;
      }
      const selected = this.findNodeById(this.selectedNodeId);
      if (selected) {
        e.preventDefault();
        this.onOpenNode(selected);
      }
    }
  }

  toggleLocalMode(explicitCenterId = null) {
    if (explicitCenterId) {
      if (this.localMode && this.localCenterId === explicitCenterId) {
        this.localMode = false;
        this.localCenterId = null;
      } else {
        this.localMode = true;
        this.localCenterId = explicitCenterId;
      }
      this.syncControlStates();
      this.rebuildActiveGraph(true);
      return;
    }

    const center = this.selectedNodeId || this.getCurrentFile();
    if (!this.localMode && !center) {
      this.onToast("Select a node or open a note first to inspect its 1-hop subgraph", false);
      return;
    }
    this.localMode = !this.localMode;
    this.localCenterId = this.localMode ? center : null;
    this.syncControlStates();
    this.rebuildActiveGraph(true);
  }

  setVisible(open) {
    const wasOpen = this.isOpen;
    this.isOpen = Boolean(open);
    if (!this.isOpen) {
      this.resetToDefault({ reload: false, relayout: false });
      return;
    }
    this.resizeCanvas();
    if (!wasOpen) {
      this.loadAndRender(true);
    }
  }

  async loadAndRender(resetPositions = false) {
    if (!this.isOpen) return;
    try {
      const data = await this.invoke("get_vault_graph");
      this.rawNodes = data?.nodes || [];
      this.rawEdges = data?.edges || [];

      const uniqueTopFolders = Array.from(
        new Set(
          this.rawNodes
            .filter((n) => n.exists && n.kind !== "skill" && topLevelFolder(n.folder))
            .map((n) => topLevelFolder(n.folder))
        )
      ).sort((a, b) => a.localeCompare(b));
      this.folderIndexMap = new Map(uniqueTopFolders.map((f, idx) => [f, idx]));

      if (this.localMode && !this.localCenterId) {
        const cur = this.getCurrentFile();
        if (cur) {
          this.localCenterId = cur;
        } else {
          this.localMode = false;
        }
      }

      this.syncControlStates();
      this.rebuildActiveGraph(resetPositions);
    } catch (err) {
      this.onToast(`Failed to load graph: ${err}`, true);
    }
  }

  handleActiveFileChanged(relPath) {
    if (this.localMode && relPath) {
      this.localCenterId = relPath;
      this.rebuildActiveGraph(false);
      return;
    }
    if (this.displayMode === "fullscreen" && relPath) {
      this.selectedNodeId = relPath;
    }
    this.computeCurrentRelevance();
    this.renderInspector();
    this.renderSideFooter();
    if (!this.isOpen) return;

    const activeNode = relPath ? this.findNodeById(relPath) : null;
    if (activeNode && this.width > 0 && this.height > 0) {
      const screen = this.worldToScreen(activeNode.x, activeNode.y);
      const outOfComfortableView =
        screen.x < this.width * 0.15 ||
        screen.x > this.width * 0.85 ||
        screen.y < this.height * 0.15 ||
        screen.y > this.height * 0.85;
      if (outOfComfortableView) {
        this.animateCameraTo(
          {
            x: -activeNode.x,
            y: -activeNode.y,
            zoom: Math.max(this.camera.zoom, 0.55),
          },
          240
        );
        return;
      }
    }
    this.draw();
  }

  computeCurrentRelevance() {
    const currentNode = this.findNodeById(this.getCurrentFile());
    if (!currentNode) {
      this.relevanceMap = null;
      return;
    }

    const curOut = this.outAdjMap.get(currentNode.id);
    const curIn = this.inAdjMap.get(currentNode.id);
    const curAdj = this.adjMap.get(currentNode.id) || new Set();

    const hopMap = new Map([[currentNode.id, 0]]);
    const queue = [currentNode.id];
    for (let qIdx = 0; qIdx < queue.length; qIdx++) {
      const id = queue[qIdx];
      const hop = hopMap.get(id);
      if (hop >= 2) continue;
      const neighbors = this.adjMap.get(id);
      if (!neighbors) continue;
      for (const nxt of neighbors) {
        if (!hopMap.has(nxt)) {
          hopMap.set(nxt, hop + 1);
          queue.push(nxt);
        }
      }
    }

    const map = new Map();
    for (const node of this.nodes) {
      if (node.id === currentNode.id) {
        map.set(node.id, { hop: 0, score: 1.0, mutual: true, shared: 0 });
        continue;
      }
      const hop = hopMap.get(node.id);
      if (hop === 1) {
        const mutual = Boolean(curOut?.has(node.id) && curIn?.has(node.id));
        const neighbors = this.adjMap.get(node.id);
        let shared = 0;
        if (neighbors) {
          for (const nId of neighbors) {
            if (nId !== currentNode.id && curAdj.has(nId)) shared++;
          }
        }
        const pair = this.pairEdgeMap.get(orderedPairKey(currentNode.id, node.id));
        const totalWeight = pair?.totalWeight || 1;
        const citeBoost = Math.min(0.22, Math.log2(Math.max(1, totalWeight)) * 0.11);
        const score = mutual
          ? Math.min(0.92, 0.72 + citeBoost + shared * 0.025)
          : Math.min(0.84, 0.48 + citeBoost + shared * 0.03);
        map.set(node.id, {
          hop: 1,
          score,
          mutual,
          shared,
          totalWeight,
          strength: pair?.strength || "weak",
        });
      } else if (hop === 2) {
        const neighbors = this.adjMap.get(node.id);
        let shared = 0;
        if (neighbors) {
          for (const nId of neighbors) {
            if (curAdj.has(nId)) shared++;
          }
        }
        const score = Math.min(0.38, 0.22 + shared * 0.05);
        map.set(node.id, { hop: 2, score, mutual: false, shared });
      } else {
        map.set(node.id, { hop: 3, score: 0.12, mutual: false, shared: 0 });
      }
    }

    this.relevanceMap = map;
  }

  locateCurrentNode(animate = true) {
    const curFile = this.getCurrentFile();
    const targetNode = curFile
      ? this.findNodeById(curFile)
      : this.selectedNodeId
        ? this.findNodeById(this.selectedNodeId)
        : null;
    if (!targetNode) {
      this.onToast("Open a note first to center on its node", false);
      return;
    }
    const targetCam = {
      x: -targetNode.x,
      y: -targetNode.y,
      zoom: Math.max(this.camera.zoom, this.displayMode === "side" ? 0.85 : 1.0),
    };
    this.activePulseUntil = performance.now() + 900;
    if (animate) {
      this.animateCameraTo(targetCam, 240);
    } else {
      this.cameraAnim = null;
      this.camera = targetCam;
      this.draw();
    }
  }

  nodeGroupKey(node) {
    if (!node.exists || node.kind === "ghost") return "__ghost__";
    if (node.kind === "skill") return "__skill__";
    const top = topLevelFolder(node.folder);
    return top ? `folder:${top}` : "__root__";
  }

  nodeGroupLabel(groupKey) {
    if (groupKey === "__ghost__") return "Unresolved";
    if (groupKey === "__skill__") return "@skills";
    if (groupKey === "__root__") return "Root Vault";
    return groupKey.slice(7);
  }

  rebuildActiveGraph(resetPositions = false) {
    const prevPositions = new Map();
    if (!resetPositions) {
      for (const n of this.nodes) {
        prevPositions.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy });
      }
    }

    const currentFile = this.getCurrentFile();
    const localFocus = this.localMode ? this.localCenterId || currentFile : null;
    const localFocusNorm = normalizeNodeId(localFocus);
    let allowedIds = null;

    if (localFocusNorm) {
      allowedIds = new Set();
      for (const n of this.rawNodes) {
        if (normalizeNodeId(n.id) === localFocusNorm) {
          allowedIds.add(n.id);
        }
      }
      for (const edge of this.rawEdges) {
        if (normalizeNodeId(edge.source) === localFocusNorm) {
          allowedIds.add(edge.source);
          allowedIds.add(edge.target);
        }
        if (normalizeNodeId(edge.target) === localFocusNorm) {
          allowedIds.add(edge.source);
          allowedIds.add(edge.target);
        }
      }
    }

    const q = this.filterText;
    const candidateNodes = this.rawNodes.filter((n) => {
      const isFocus = localFocusNorm && normalizeNodeId(n.id) === localFocusNorm;
      const isCurrent = this.isCurrentNode(n, currentFile);
      if (!this.showSkills && n.kind === "skill" && !isFocus) return false;
      if (allowedIds && !allowedIds.has(n.id)) return false;
      if (!this.showOrphans && n.degree === 0 && !isCurrent && !isFocus) {
        return false;
      }
      if (this.activeFolderGroup && this.nodeGroupKey(n) !== this.activeFolderGroup) {
        if (!isFocus) return false;
      }
      if (q) {
        const hay = `${n.label} ${n.rel_path || ""} ${n.folder || ""} ${n.skill_slug || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const activeIdSet = new Set(candidateNodes.map((n) => n.id));
    this.edges = this.rawEdges.filter(
      (e) => activeIdSet.has(e.source) && activeIdSet.has(e.target)
    );

    this.directedWeightMap = new Map();
    for (const e of this.edges) {
      this.directedWeightMap.set(
        `${e.source}\0${e.target}`,
        Math.max(1, Number(e.weight) || 1)
      );
    }

    const visibleDegree = new Map();
    for (const e of this.edges) {
      visibleDegree.set(e.source, (visibleDegree.get(e.source) || 0) + 1);
      visibleDegree.set(e.target, (visibleDegree.get(e.target) || 0) + 1);
    }

    const count = candidateNodes.length;
    const spread = Math.max(210, Math.sqrt(Math.max(1, count)) * 105);

    this.nodes = candidateNodes.map((n, idx) => {
      const prev = prevPositions.get(n.id);
      if (prev) {
        return {
          ...n,
          groupKey: this.nodeGroupKey(n),
          visDegree: visibleDegree.get(n.id) || 0,
          x: prev.x,
          y: prev.y,
          vx: prev.vx,
          vy: prev.vy,
        };
      }
      if (localFocusNorm && normalizeNodeId(n.id) === localFocusNorm) {
        return {
          ...n,
          groupKey: this.nodeGroupKey(n),
          visDegree: visibleDegree.get(n.id) || 0,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
        };
      }
      const angle = idx * 2.399963229728653;
      const r = spread * Math.sqrt((idx + 0.5) / Math.max(1, count));
      return {
        ...n,
        groupKey: this.nodeGroupKey(n),
        visDegree: visibleDegree.get(n.id) || 0,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        vx: 0,
        vy: 0,
      };
    });

    this.nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
    this.outAdjMap = new Map(this.nodes.map((n) => [n.id, new Set()]));
    this.inAdjMap = new Map(this.nodes.map((n) => [n.id, new Set()]));
    this.adjMap = new Map(this.nodes.map((n) => [n.id, new Set()]));

    for (const edge of this.edges) {
      this.outAdjMap.get(edge.source)?.add(edge.target);
      this.inAdjMap.get(edge.target)?.add(edge.source);
      this.adjMap.get(edge.source)?.add(edge.target);
      this.adjMap.get(edge.target)?.add(edge.source);
    }

    this.displayEdges = [];
    this.pairEdgeMap = new Map();
    for (const e of this.edges) {
      const pairKey = orderedPairKey(e.source, e.target);
      if (this.pairEdgeMap.has(pairKey)) continue;

      const fwdWeight = this.directedWeightMap.get(`${e.source}\0${e.target}`) || 1;
      const revWeight = this.directedWeightMap.get(`${e.target}\0${e.source}`) || 0;
      const bidirectional = revWeight > 0;

      const srcAdj = this.adjMap.get(e.source);
      const dstAdj = this.adjMap.get(e.target);
      let shared = 0;
      if (srcAdj && dstAdj) {
        for (const nId of srcAdj) {
          if (nId !== e.source && nId !== e.target && dstAdj.has(nId)) {
            shared++;
          }
        }
      }

      const totalWeight = fwdWeight + revWeight;
      const tieScore = totalWeight + (bidirectional ? 1.5 : 0) + Math.min(2, shared * 0.45);
      const strength = tieScore >= 4.0 ? "strong" : tieScore >= 2.5 ? "medium" : "weak";

      const dEdge = {
        pairKey,
        source: e.source,
        target: e.target,
        bidirectional,
        forwardWeight: fwdWeight,
        backwardWeight: revWeight,
        totalWeight,
        shared,
        tieScore,
        strength,
      };
      this.pairEdgeMap.set(pairKey, dEdge);
      this.displayEdges.push(dEdge);
    }

    if (this.selectedNodeId && !this.findNodeById(this.selectedNodeId)) {
      this.selectedNodeId = null;
    }

    this.computeCurrentRelevance();

    const statsText = `${this.nodes.length} ${this.nodes.length === 1 ? "node" : "nodes"} · ${this.displayEdges.length} ${this.displayEdges.length === 1 ? "link" : "links"}`;
    if (this.statsEl) this.statsEl.textContent = statsText;
    if (this.sideStatsEl) this.sideStatsEl.textContent = statsText;
    this.renderLegend();
    this.renderInspector();
    this.renderSideFooter();

    // Synchronous warm-start only on reset or initial graph layout; incremental updates keep camera steady
    const needsWarmup = resetPositions || prevPositions.size === 0;
    if (needsWarmup && this.nodes.length > 0) {
      this.energy = 1.0;
      for (let step = 0; step < 130; step++) {
        this.stepPhysics(Math.max(0.18, 1 - step / 150));
      }
      this.energy = 0.16;
      this.fitToView(false);
    }

    this.wakeSimulation(needsWarmup ? 0.16 : 0.32);
  }

  resizeCanvas() {
    const target = this.canvasWrapEl || this.viewEl;
    const rect = target?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvasEl.width = Math.round(this.width * this.dpr);
    this.canvasEl.height = Math.round(this.height * this.dpr);
  }

  wakeSimulation(energy = 0.6) {
    this.energy = Math.max(this.energy, energy);
    if (!this.rafId && this.isOpen) {
      this.tick();
    }
  }

  stopSimulation() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  stepCameraAnim(now) {
    if (!this.cameraAnim) return false;
    const tRaw = (now - this.cameraAnim.startTime) / this.cameraAnim.duration;
    const t = Math.min(1, Math.max(0, tRaw));
    const ease = 1 - Math.pow(1 - t, 3);
    const { from, to } = this.cameraAnim;
    this.camera = {
      x: from.x + (to.x - from.x) * ease,
      y: from.y + (to.y - from.y) * ease,
      zoom: from.zoom + (to.zoom - from.zoom) * ease,
    };
    if (t >= 1) {
      this.cameraAnim = null;
    }
    return true;
  }

  animateCameraTo(target, duration = 220) {
    this.cameraAnim = {
      startTime: performance.now(),
      duration,
      from: { ...this.camera },
      to: { ...target },
    };
    if (!this.rafId && this.isOpen) {
      this.tick();
    }
  }

  tick() {
    if (!this.isOpen) {
      this.rafId = null;
      return;
    }

    const now = performance.now();
    const animatingCam = this.stepCameraAnim(now);
    const pulsing = this.activePulseUntil > now;
    const runningPhysics = this.energy > 0.025 || Boolean(this.draggedNode);
    if (runningPhysics) {
      this.stepPhysics();
    }
    this.draw();

    if (runningPhysics || animatingCam || pulsing) {
      this.rafId = requestAnimationFrame(() => this.tick());
    } else {
      this.rafId = null;
    }
  }

  stepPhysics(alphaOverride = null) {
    const nodes = this.nodes;
    const nLen = nodes.length;
    if (nLen === 0) {
      this.energy = 0;
      return;
    }

    const alpha =
      alphaOverride !== null
        ? alphaOverride
        : Math.min(1, Math.max(0.05, this.energy));
    const repulsionStrength = Math.max(20000, 14500 + nLen * 240);
    const gravityX = 0.0055;
    const gravityY = 0.010;
    const springStrength = 0.042;
    const clusterPull = 0.0022;
    const damping = 0.80;
    const minDist = 96;

    for (let i = 0; i < nLen; i++) {
      const node = nodes[i];
      if (node === this.draggedNode) continue;
      node.vx -= node.x * gravityX * alpha;
      node.vy -= node.y * gravityY * alpha;
    }

    for (let i = 0; i < nLen; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nLen; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) {
          dx = 0.6;
          dy = 0.6;
          distSq = 0.72;
        }
        if (distSq > 1400000) continue;

        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const ny = dy / dist;

        let force = (repulsionStrength / distSq) * alpha;
        if (dist < minDist) {
          force += (minDist - dist) * 0.22 * alpha;
        }

        if (a.groupKey === b.groupKey && a.groupKey !== "__ghost__" && dist > 140) {
          force -= (dist - 140) * clusterPull * alpha;
        }

        const fx = nx * force;
        const fy = ny * force;
        if (a !== this.draggedNode) {
          a.vx -= fx;
          a.vy -= fy;
        }
        if (b !== this.draggedNode) {
          b.vx += fx;
          b.vy += fy;
        }
      }
    }

    for (let i = 0; i < this.displayEdges.length; i++) {
      const dEdge = this.displayEdges[i];
      const src = this.nodeMap.get(dEdge.source);
      const dst = this.nodeMap.get(dEdge.target);
      if (!src || !dst) continue;

      const dx = dst.x - src.x;
      const dy = dst.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const weightPull = Math.min(
        48,
        Math.log2(Math.max(1, dEdge.totalWeight)) * 22 + (dEdge.bidirectional ? 12 : 0)
      );
      const targetLen = Math.max(
        118,
        175 + Math.min(80, ((src.visDegree || 0) + (dst.visDegree || 0)) * 4.2) - weightPull
      );
      const edgeSpring =
        springStrength * (1 + Math.min(0.55, (dEdge.totalWeight - 1) * 0.14));
      const diff = dist - targetLen;
      const force = diff * edgeSpring * alpha;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      if (src !== this.draggedNode) {
        src.vx += fx;
        src.vy += fy;
      }
      if (dst !== this.draggedNode) {
        dst.vx -= fx;
        dst.vy -= fy;
      }
    }

    let totalMove = 0;
    for (let i = 0; i < nLen; i++) {
      const node = nodes[i];
      if (node === this.draggedNode) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= damping;
      node.vy *= damping;

      const speed = Math.hypot(node.vx, node.vy);
      if (speed > 24) {
        node.vx = (node.vx / speed) * 24;
        node.vy = (node.vy / speed) * 24;
      }
      node.x += node.vx;
      node.y += node.vy;
      totalMove += Math.abs(node.vx) + Math.abs(node.vy);
    }

    if (alphaOverride === null) {
      this.energy = Math.max(this.energy * 0.955, Math.min(1, totalMove / (nLen * 3.8)));
    }
  }

  getThemeColors() {
    const cs = getComputedStyle(document.documentElement);
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    return {
      isLight,
      accent: cs.getPropertyValue("--accent").trim() || "#5b8def",
      incomingEdge: isLight ? "#059669" : "#34d399",
      strongEdge: isLight ? "#059669" : "#34d399",
      mediumEdge: cs.getPropertyValue("--accent").trim() || "#5b8def",
      weakEdge: isLight ? "#64748b" : "#94a3b8",
      skillColor: isLight ? "#7c3aed" : "#a78bfa",
      ghostColor: isLight ? "#e11d48" : "#f87171",
      rootColor: isLight ? "#475569" : "#94a3b8",
      neutralNode: isLight ? "#94a3b8" : "#64748b",
      mutedIncoming: isLight ? "#475569" : "#94a3b8",
      textPrimary: cs.getPropertyValue("--text-primary").trim() || "#e7e8ec",
      textSecondary: cs.getPropertyValue("--text-secondary").trim() || "#a0a6b5",
      textMuted: cs.getPropertyValue("--text-muted").trim() || "#6c7282",
      bgCanvas: cs.getPropertyValue("--bg-canvas").trim() || "#191919",
      edgeBase: isLight ? "rgba(15, 23, 42, 0.22)" : "rgba(255, 255, 255, 0.20)",
      pillBg: isLight ? "rgba(255, 255, 255, 0.88)" : "rgba(24, 25, 28, 0.80)",
      pillBorder: isLight ? "rgba(15, 23, 42, 0.14)" : "rgba(255, 255, 255, 0.12)",
      folderPalette: isLight ? FOLDER_PALETTE_LIGHT : FOLDER_PALETTE_DARK,
    };
  }

  groupColor(groupKey, colors) {
    if (groupKey === "__ghost__") return colors.ghostColor;
    if (groupKey === "__skill__") return colors.skillColor;
    if (groupKey === "__root__") return colors.rootColor;
    const folderName = groupKey.slice(7);
    const idx = this.folderIndexMap.get(folderName) ?? 0;
    return colors.folderPalette[idx % colors.folderPalette.length];
  }

  nodeColor(node, colors) {
    return this.groupColor(node.groupKey || this.nodeGroupKey(node), colors);
  }

  nodeRadius(node, currentFile = null) {
    let base;
    if (!node.exists || node.kind === "ghost") {
      base = 6;
    } else if (node.kind === "skill") {
      base = Math.min(13, 6.5 + Math.sqrt(node.visDegree || 0) * 1.4);
    } else {
      base = Math.min(16, 6.5 + Math.sqrt(node.visDegree || 0) * 2.1);
    }
    if (this.isCurrentNode(node, currentFile)) {
      return Math.max(10.5, base + 3.0);
    }
    return base;
  }

  screenToWorld(clientX, clientY) {
    const rect = this.canvasEl.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
      x: (sx - this.width / 2) / this.camera.zoom - this.camera.x,
      y: (sy - this.height / 2) / this.camera.zoom - this.camera.y,
    };
  }

  worldToScreen(wx, wy) {
    return {
      x: (wx + this.camera.x) * this.camera.zoom + this.width / 2,
      y: (wy + this.camera.y) * this.camera.zoom + this.height / 2,
    };
  }

  findNodeAt(worldX, worldY) {
    const currentFile = this.getCurrentFile();
    const pad = 7 / this.camera.zoom;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      const r = this.nodeRadius(node, currentFile) + pad;
      const dx = worldX - node.x;
      const dy = worldY - node.y;
      if (dx * dx + dy * dy <= r * r) {
        return node;
      }
    }
    return null;
  }

  selectNode(nodeId, { panIntoView = false } = {}) {
    this.selectedNodeId = nodeId || null;
    if (panIntoView && this.selectedNodeId) {
      const node = this.findNodeById(this.selectedNodeId);
      if (node) {
        this.animateCameraTo(
          {
            x: -node.x,
            y: -node.y,
            zoom: Math.max(this.camera.zoom, 0.9),
          },
          220
        );
      }
    }
    this.renderInspector();
    this.renderSideFooter();
    this.draw();
  }

  renderLegend() {
    if (!this.legendEl) return;
    const colors = this.getThemeColors();
    const currentFile = this.getCurrentFile();
    const counts = new Map();
    for (const n of this.rawNodes) {
      if (!this.showSkills && n.kind === "skill") continue;
      if (!this.showOrphans && n.degree === 0 && !this.isCurrentNode(n, currentFile)) continue;
      const key = this.nodeGroupKey(n);
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const keys = Array.from(counts.keys()).sort((a, b) => {
      const rank = (k) =>
        k === "__root__" ? 0 : k.startsWith("folder:") ? 1 : k === "__skill__" ? 2 : 3;
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : a.localeCompare(b);
    });

    if (keys.length <= 1) {
      this.legendEl.innerHTML = "";
      return;
    }

    this.legendEl.innerHTML = keys
      .map((k) => {
        const dotColor = this.groupColor(k, colors);
        const label = this.nodeGroupLabel(k);
        const count = counts.get(k) || 0;
        const isActive = this.activeFolderGroup === k;
        return `
          <button
            type="button"
            class="graph-legend-item${isActive ? " active" : ""}"
            data-group-key="${escapeHtml(k)}"
            title="${isActive ? "Click to show all groups" : `Filter graph to ${label}`}"
          >
            <span class="graph-legend-dot" style="background:${dotColor}"></span>
            <span>${escapeHtml(label)}</span>
            <span class="graph-legend-count">${count}</span>
          </button>
        `;
      })
      .join("");

    this.legendEl.querySelectorAll("[data-group-key]").forEach((btn) => {
      const k = btn.dataset.groupKey;
      btn.addEventListener("mouseenter", () => {
        this.hoveredFolderGroup = k;
        this.draw();
      });
      btn.addEventListener("mouseleave", () => {
        this.hoveredFolderGroup = null;
        this.draw();
      });
      btn.addEventListener("click", () => {
        this.activeFolderGroup = this.activeFolderGroup === k ? null : k;
        this.hoveredFolderGroup = null;
        this.rebuildActiveGraph(false);
      });
    });
  }

  renderSideFooter() {
    if (!this.sideFooterEl) return;
    if (this.displayMode !== "side") {
      this.sideFooterEl.innerHTML = "";
      return;
    }

    const currentFile = this.getCurrentFile();
    const hovered = this.hoveredNodeId ? this.findNodeById(this.hoveredNodeId) : null;
    const currentNode = currentFile ? this.findNodeById(currentFile) : null;
    const node = hovered || currentNode;

    if (!node) {
      this.sideFooterEl.innerHTML =
        '<span class="graph-side-footer-hint">Click a node to open &middot; Drag to arrange</span>';
      return;
    }

    const colors = this.getThemeColors();
    const isCurrent = this.isCurrentNode(node, currentFile);
    const dotColor = isCurrent ? colors.accent : this.nodeColor(node, colors);
    const inCount = node.in_degree ?? (this.inAdjMap.get(node.id)?.size || 0);
    const outCount = node.out_degree ?? (this.outAdjMap.get(node.id)?.size || 0);
    const metaText = node.exists
      ? `&larr;${inCount} &rarr;${outCount} &middot; ${formatTokens(node.est_tokens)}`
      : `&larr;${inCount} unresolved`;

    this.sideFooterEl.innerHTML = `
      <button type="button" class="graph-side-footer-node" data-side-locate="1" title="Center camera on ${escapeHtml(
        node.label
      )}">
        <span class="graph-side-footer-dot${isCurrent ? " is-current" : ""}" style="background:${dotColor}"></span>
        <span class="graph-side-footer-title">${escapeHtml(node.label)}</span>
      </button>
      <div class="graph-side-footer-right">
        <span class="graph-side-footer-meta">${metaText}</span>
        ${
          node.exists
            ? '<button type="button" class="graph-side-footer-ai" data-side-ai="1" title="Ask AI about this node (replaces Side Graph with AI Chat)">&#10022; AI</button>'
            : ""
        }
      </div>
    `;

    this.sideFooterEl.querySelector("[data-side-locate]")?.addEventListener("click", () => {
      this.activePulseUntil = performance.now() + 900;
      this.animateCameraTo(
        {
          x: -node.x,
          y: -node.y,
          zoom: Math.max(this.camera.zoom, 0.85),
        },
        240
      );
    });
    this.sideFooterEl.querySelector("[data-side-ai]")?.addEventListener("click", () => {
      this.onAskAiNode(node);
    });
  }

  renderInspector() {
    if (!this.inspectorEl) return;
    if (this.displayMode !== "fullscreen") {
      this.inspectorEl.hidden = true;
      this.inspectorEl.innerHTML = "";
      return;
    }

    const node = this.selectedNodeId ? this.findNodeById(this.selectedNodeId) : null;
    if (!node) {
      this.inspectorEl.hidden = true;
      this.inspectorEl.innerHTML = "";
      return;
    }

    const outIds = Array.from(this.outAdjMap.get(node.id) || []);
    const inIds = Array.from(this.inAdjMap.get(node.id) || []);
    const outNodes = outIds
      .map((id) => this.nodeMap.get(id))
      .filter(Boolean)
      .sort((a, b) => {
        const wa = this.directedWeightMap.get(`${node.id}\0${a.id}`) || 1;
        const wb = this.directedWeightMap.get(`${node.id}\0${b.id}`) || 1;
        return wb - wa || (b.degree || 0) - (a.degree || 0);
      });
    const inNodes = inIds
      .map((id) => this.nodeMap.get(id))
      .filter(Boolean)
      .sort((a, b) => {
        const wa = this.directedWeightMap.get(`${a.id}\0${node.id}`) || 1;
        const wb = this.directedWeightMap.get(`${b.id}\0${node.id}`) || 1;
        return wb - wa || (b.degree || 0) - (a.degree || 0);
      });

    const neighborMap = new Map();
    for (const item of [...outNodes, ...inNodes]) {
      if (item.exists && item.id !== node.id) neighborMap.set(item.id, item);
    }
    const existingNeighbors = Array.from(neighborMap.values());
    const clusterTokens =
      (node.est_tokens || 0) +
      existingNeighbors.reduce((acc, n) => acc + (n.est_tokens || 0), 0);

    let badgeLabel = "Markdown Note";
    let badgeClass = "";
    if (!node.exists || node.kind === "ghost") {
      badgeLabel = "Unresolved Link";
      badgeClass = " is-ghost";
    } else if (node.kind === "skill") {
      badgeLabel = "Skill Bank";
      badgeClass = " is-skill";
    }

    const subPath = node.rel_path || "Click Create Note to initialize this page";
    const isLocalCentered = this.localMode && normalizeNodeId(this.localCenterId) === normalizeNodeId(node.id);

    const renderChips = (list, direction) =>
      list
        .map((item) => {
          const w =
            direction === "out"
              ? this.directedWeightMap.get(`${node.id}\0${item.id}`) || 1
              : this.directedWeightMap.get(`${item.id}\0${node.id}`) || 1;
          const weightSuffix = w >= 2 ? ` ×${w}` : "";
          const cls =
            item.kind === "skill"
              ? " is-skill"
              : !item.exists || item.kind === "ghost"
                ? " is-ghost"
                : "";
          return `<button type="button" class="graph-inspector-chip${cls}" data-hop-id="${escapeHtml(
            item.id
          )}" title="${escapeHtml(item.rel_path || item.label)}${
            w >= 2 ? ` (${w} citations)` : ""
          }">${escapeHtml(item.label + weightSuffix)}</button>`;
        })
        .join("");

    const metricsHtml = node.exists
      ? `
        <span>&larr; ${node.in_degree ?? inNodes.length} in</span>
        <span>&middot;</span>
        <span>&rarr; ${node.out_degree ?? outNodes.length} out</span>
        <span>&middot;</span>
        <span>${formatTokens(node.est_tokens)} tok</span>
        ${
          existingNeighbors.length > 0
            ? `<span>&middot; 1-hop ${formatTokens(clusterTokens)}</span>`
            : ""
        }
      `
      : `<span>&larr; ${inNodes.length} incoming link${inNodes.length === 1 ? "" : "s"}</span>`;

    const aiActionsHtml = node.exists
      ? `
        <button type="button" class="graph-inspector-btn is-ai" data-act="ai-node" title="Attach this node to AI composer">&#10022; Ask AI (Node)</button>
        ${
          existingNeighbors.length > 0
            ? `<button type="button" class="graph-inspector-btn is-ai" data-act="ai-cluster" title="Attach this node + ${existingNeighbors.length} linked neighbors to AI">&#10022; Ask AI (${existingNeighbors.length + 1})</button>`
            : ""
        }
      `
      : "";

    this.inspectorEl.hidden = false;
    this.inspectorEl.innerHTML = `
      <div class="graph-inspector-header">
        <span class="graph-inspector-badge${badgeClass}">${escapeHtml(badgeLabel)}</span>
        <button type="button" class="graph-inspector-close" data-act="close" title="Close Inspector (Esc)" aria-label="Close">&times;</button>
      </div>
      <div>
        <h3 class="graph-inspector-title">${escapeHtml(node.label)}</h3>
        <div class="graph-inspector-path">${escapeHtml(subPath)}</div>
      </div>
      <div class="graph-inspector-metrics">${metricsHtml}</div>
      <div class="graph-inspector-actions">
        <button type="button" class="graph-inspector-btn is-primary" data-act="open">${
          node.exists ? "Open Note" : "Create Note"
        }</button>
        <button type="button" class="graph-inspector-btn" data-act="focus">${
          isLocalCentered ? "Show Full Graph" : "Focus 1-Hop"
        }</button>
        ${aiActionsHtml}
      </div>
      ${
        outNodes.length > 0
          ? `
            <div class="graph-inspector-section">
              <span class="graph-inspector-label">Outgoing &rarr; (${outNodes.length})</span>
              <div class="graph-inspector-links">${renderChips(outNodes, "out")}</div>
            </div>
          `
          : ""
      }
      ${
        inNodes.length > 0
          ? `
            <div class="graph-inspector-section">
              <span class="graph-inspector-label">Incoming &larr; (${inNodes.length})</span>
              <div class="graph-inspector-links">${renderChips(inNodes, "in")}</div>
            </div>
          `
          : ""
      }
    `;

    this.inspectorEl.querySelector('[data-act="close"]')?.addEventListener("click", () => {
      this.selectNode(null);
    });
    this.inspectorEl.querySelector('[data-act="open"]')?.addEventListener("click", () => {
      this.onOpenNode(node);
    });
    this.inspectorEl.querySelector('[data-act="focus"]')?.addEventListener("click", () => {
      this.toggleLocalMode(node.id);
    });
    this.inspectorEl.querySelector('[data-act="ai-node"]')?.addEventListener("click", () => {
      this.onAskAiNode(node);
    });
    this.inspectorEl.querySelector('[data-act="ai-cluster"]')?.addEventListener("click", () => {
      this.onAskAiCluster(node, existingNeighbors);
    });
    this.inspectorEl.querySelectorAll("[data-hop-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const hopId = btn.dataset.hopId;
        if (hopId) this.selectNode(hopId, { panIntoView: true });
      });
    });
  }

  drawArrowhead(ctx, tipX, tipY, angle, size) {
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - size * Math.cos(angle - Math.PI / 7),
      tipY - size * Math.sin(angle - Math.PI / 7)
    );
    ctx.lineTo(
      tipX - size * Math.cos(angle + Math.PI / 7),
      tipY - size * Math.sin(angle + Math.PI / 7)
    );
    ctx.closePath();
    ctx.fill();
  }

  draw() {
    if (!this.width || !this.height) return;
    const ctx = this.ctx;
    const colors = this.getThemeColors();
    const currentFile = this.getCurrentFile();
    const currentNode = currentFile ? this.findNodeById(currentFile) : null;
    const activeCurrentId = currentNode ? currentNode.id : null;
    const focusId = this.hoveredNodeId || (this.displayMode === "fullscreen" ? this.selectedNodeId : null);
    const focusNeighbors = focusId ? this.adjMap.get(focusId) : null;
    const folderHover = !focusId ? this.hoveredFolderGroup : null;
    const hasActiveRest = Boolean(activeCurrentId && !focusId && !folderHover);
    const now = performance.now();
    const pulseBoost =
      this.activePulseUntil > now
        ? Math.sin(((this.activePulseUntil - now) / 900) * Math.PI * 3) * 0.5 + 0.5
        : 0;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    // Subtle radial depth glow in center
    const glow = ctx.createRadialGradient(
      this.width / 2,
      this.height / 2,
      10,
      this.width / 2,
      this.height / 2,
      Math.max(this.width, this.height) * 0.58
    );
    glow.addColorStop(0, colors.isLight ? "rgba(46, 107, 230, 0.035)" : "rgba(91, 141, 239, 0.05)");
    glow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.width, this.height);

    // Dot grid
    const gridSpacing = 38 * this.camera.zoom;
    if (gridSpacing >= 12) {
      const ox =
        ((this.width / 2 + this.camera.x * this.camera.zoom) % gridSpacing + gridSpacing) %
        gridSpacing;
      const oy =
        ((this.height / 2 + this.camera.y * this.camera.zoom) % gridSpacing + gridSpacing) %
        gridSpacing;
      ctx.fillStyle = colors.isLight ? "rgba(0, 0, 0, 0.05)" : "rgba(255, 255, 255, 0.045)";
      for (let x = ox; x < this.width; x += gridSpacing) {
        for (let y = oy; y < this.height; y += gridSpacing) {
          ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
        }
      }
    }

    if (this.nodes.length === 0) {
      ctx.fillStyle = colors.textMuted;
      ctx.font = "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(
        this.rawNodes.length === 0
          ? "Open a folder with Markdown notes to view the graph."
          : "No nodes match the current graph filter.",
        this.width / 2,
        this.height / 2
      );
      ctx.restore();
      return;
    }

    // World space transform for edges & nodes
    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.camera.zoom, this.camera.zoom);
    ctx.translate(this.camera.x, this.camera.y);

    // 1. Draw single weighted edges with bidirectional (<--->) or one-way (--->) arrows
    const baseLineWidth = 1.05 / Math.max(0.55, this.camera.zoom);
    const arrowSize = Math.min(8.2, Math.max(5.0, 6.4 / Math.pow(this.camera.zoom, 0.45)));
    const weightBadges = [];

    for (let i = 0; i < this.displayEdges.length; i++) {
      const dEdge = this.displayEdges[i];
      const src = this.nodeMap.get(dEdge.source);
      const dst = this.nodeMap.get(dEdge.target);
      if (!src || !dst) continue;

      const dx = dst.x - src.x;
      const dy = dst.y - src.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;

      const srcIsCurrent = Boolean(activeCurrentId && src.id === activeCurrentId);
      const dstIsCurrent = Boolean(activeCurrentId && dst.id === activeCurrentId);
      const srcTrim =
        this.nodeRadius(src, currentFile) + (srcIsCurrent ? 5.5 : src.kind === "skill" ? 4.5 : 2.5);
      const dstTrim =
        this.nodeRadius(dst, currentFile) + (dstIsCurrent ? 5.5 : dst.kind === "skill" ? 4.5 : 2.5);
      if (dist <= srcTrim + dstTrim + 4) continue;

      const ux = dx / dist;
      const uy = dy / dist;
      const angle = Math.atan2(dy, dx);
      const startTipX = src.x + ux * srcTrim;
      const startTipY = src.y + uy * srcTrim;
      const endTipX = dst.x - ux * dstTrim;
      const endTipY = dst.y - uy * dstTrim;

      const strengthColor =
        dEdge.strength === "strong"
          ? colors.strongEdge
          : dEdge.strength === "medium"
            ? colors.mediumEdge
            : colors.weakEdge;
      const weightWidthMult =
        1 +
        Math.min(
          1.05,
          Math.log2(Math.max(1, dEdge.totalWeight)) * 0.42 + (dEdge.bidirectional ? 0.14 : 0)
        );

      const touchesFocus = Boolean(
        focusId && (dEdge.source === focusId || dEdge.target === focusId)
      );
      const touchesCurrent = Boolean(
        activeCurrentId && (dEdge.source === activeCurrentId || dEdge.target === activeCurrentId)
      );
      const isFolderEdge =
        folderHover && (src.groupKey === folderHover || dst.groupKey === folderHover);

      let strokeColor = colors.edgeBase;
      let alpha = 0.38;
      let lineWidth = baseLineWidth * weightWidthMult;

      if (focusId) {
        if (touchesFocus) {
          strokeColor = strengthColor;
          alpha = 0.94;
          lineWidth = baseLineWidth * 1.42 * weightWidthMult;
        } else {
          strokeColor = colors.edgeBase;
          alpha = 0.07;
          lineWidth = baseLineWidth;
        }
      } else if (folderHover) {
        if (isFolderEdge) {
          strokeColor = this.groupColor(folderHover, colors);
          alpha = 0.72;
          lineWidth = baseLineWidth * 1.35 * weightWidthMult;
        } else {
          strokeColor = colors.edgeBase;
          alpha = 0.12;
          lineWidth = baseLineWidth;
        }
      } else if (hasActiveRest) {
        if (touchesCurrent) {
          strokeColor = strengthColor;
          alpha =
            dEdge.strength === "strong" ? 0.72 : dEdge.strength === "medium" ? 0.50 : 0.30;
          lineWidth = baseLineWidth * 1.12 * weightWidthMult;
        } else {
          const srcHop = this.relevanceMap?.get(src.id)?.hop ?? 3;
          const dstHop = this.relevanceMap?.get(dst.id)?.hop ?? 3;
          if (srcHop === 1 && dstHop === 1) {
            strokeColor = colors.edgeBase;
            alpha = 0.13;
            lineWidth = baseLineWidth * 0.95;
          } else {
            strokeColor = colors.edgeBase;
            alpha = 0.05;
            lineWidth = baseLineWidth * 0.85;
          }
        }
      } else {
        strokeColor =
          dEdge.strength === "strong" || dEdge.strength === "medium"
            ? strengthColor
            : colors.edgeBase;
        alpha =
          dEdge.strength === "strong" ? 0.58 : dEdge.strength === "medium" ? 0.44 : 0.38;
      }

      const drawArrow = this.showArrows && (alpha >= 0.20 || touchesFocus);
      const arrowInset = drawArrow ? arrowSize * 0.65 : 0;
      const lineStartX = dEdge.bidirectional ? startTipX + ux * arrowInset : startTipX;
      const lineStartY = dEdge.bidirectional ? startTipY + uy * arrowInset : startTipY;
      const lineEndX = endTipX - ux * arrowInset;
      const lineEndY = endTipY - uy * arrowInset;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(lineStartX, lineStartY);
      ctx.lineTo(lineEndX, lineEndY);
      ctx.stroke();

      if (drawArrow) {
        ctx.fillStyle = strokeColor;
        this.drawArrowhead(ctx, endTipX, endTipY, angle, arrowSize);
        if (dEdge.bidirectional) {
          this.drawArrowhead(ctx, startTipX, startTipY, angle + Math.PI, arrowSize);
        }
      }
      ctx.restore();

      if (focusId && touchesFocus && dEdge.totalWeight >= 2) {
        weightBadges.push({
          x: (src.x + dst.x) * 0.5,
          y: (src.y + dst.y) * 0.5,
          text: `×${dEdge.totalWeight}`,
          color: strengthColor,
        });
      }
    }

    // 2. Draw nodes (sorted so hovered / selected / current open note paint cleanly on top)
    const drawOrder = this.nodes.slice().sort((a, b) => {
      const rank = (n) =>
        n.id === this.hoveredNodeId
          ? 5
          : n.id === activeCurrentId
            ? 4
            : this.displayMode === "fullscreen" && n.id === this.selectedNodeId
              ? 3
              : n.kind === "skill"
                ? 1
                : 0;
      return rank(a) - rank(b);
    });

    const zoomScale = Math.max(0.75, this.camera.zoom);

    for (let i = 0; i < drawOrder.length; i++) {
      const node = drawOrder[i];
      const isHovered = node.id === this.hoveredNodeId;
      const isSelected = this.displayMode === "fullscreen" && node.id === this.selectedNodeId;
      const isCurrent = Boolean(activeCurrentId && node.id === activeCurrentId);
      const isNeighbor = Boolean(focusNeighbors && focusNeighbors.has(node.id));
      const matchesFolderHover = folderHover && node.groupKey === folderHover;
      const isDimmed = Boolean(
        (focusId && !isHovered && !isSelected && !isNeighbor) ||
          (folderHover && !matchesFolderHover)
      );
      const baseGroupCol = this.nodeColor(node, colors);
      const r = this.nodeRadius(node, currentFile);
      const rel = this.relevanceMap?.get(node.id);

      let nodeAlpha;
      let nodeCol;
      if (isCurrent) {
        nodeAlpha = isDimmed ? 0.60 : 1;
        nodeCol =
          node.kind === "skill"
            ? colors.skillColor
            : !node.exists || node.kind === "ghost"
              ? colors.ghostColor
              : colors.accent;
      } else if (hasActiveRest) {
        const hop = rel?.hop ?? 3;
        const score = rel?.score ?? 0.12;
        if (hop === 1) {
          const colorMix =
            rel.strength === "strong" ? 0.50 : rel.strength === "medium" ? 0.36 : 0.22;
          nodeAlpha = Math.min(0.84, 0.44 + (score - 0.48) * 0.9);
          nodeCol = blendColors(colors.neutralNode, baseGroupCol, colorMix);
        } else if (hop === 2) {
          nodeAlpha =
            this.displayMode === "side"
              ? Math.min(0.30, 0.18 + (score - 0.22) * 0.65)
              : Math.min(0.38, 0.24 + (score - 0.22) * 0.75);
          nodeCol = blendColors(colors.neutralNode, baseGroupCol, 0.10);
        } else {
          nodeAlpha = this.displayMode === "side" ? 0.13 : 0.18;
          nodeCol = colors.neutralNode;
        }
      } else {
        nodeAlpha = isDimmed ? 0.16 : node.exists ? 1 : 0.78;
        nodeCol = baseGroupCol;
      }

      ctx.save();
      ctx.globalAlpha = nodeAlpha;

      // Luminous radial aura reserved strictly for Current Open Note
      if (isCurrent) {
        const auraR = r + (14 + pulseBoost * 6) / zoomScale;
        const aura = ctx.createRadialGradient(node.x, node.y, r * 0.4, node.x, node.y, auraR);
        aura.addColorStop(0, colorWithAlpha(colors.accent, 0.34));
        aura.addColorStop(0.55, colorWithAlpha(colors.accent, 0.14));
        aura.addColorStop(1, colorWithAlpha(colors.accent, 0));
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(node.x, node.y, auraR, 0, Math.PI * 2);
        ctx.fill();
      } else if (!hasActiveRest && (isHovered || isSelected)) {
        const haloR = r + 7 / zoomScale;
        ctx.beginPath();
        ctx.arc(node.x, node.y, haloR, 0, Math.PI * 2);
        ctx.fillStyle = nodeCol;
        ctx.globalAlpha = isDimmed ? 0.08 : 0.22;
        ctx.fill();
        ctx.globalAlpha = nodeAlpha;
      }

      if (!node.exists || node.kind === "ghost") {
        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = colorWithAlpha(
          nodeCol,
          hasActiveRest ? 0.12 : colors.isLight ? 0.10 : 0.14
        );
        ctx.fill();
        ctx.setLineDash([2.8, 2.8]);
        ctx.lineWidth = 1.5 / Math.max(0.7, this.camera.zoom);
        ctx.strokeStyle = nodeCol;
        ctx.stroke();
      } else {
        // Skill orbit ring appears only on current note, hover/selection, or when no note is open
        if (node.kind === "skill" && (isCurrent || !hasActiveRest)) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, r + 3.2 / zoomScale, 0, Math.PI * 2);
          ctx.lineWidth = 1.2 / zoomScale;
          ctx.strokeStyle = colors.skillColor;
          ctx.globalAlpha = isDimmed && !isCurrent ? 0.1 : 0.55;
          ctx.stroke();
          ctx.globalAlpha = nodeAlpha;
        }

        ctx.beginPath();
        ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx.fillStyle = nodeCol;
        ctx.fill();

        if (isCurrent) {
          ctx.lineWidth = 2.0 / zoomScale;
          ctx.strokeStyle = colors.bgCanvas;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(node.x, node.y, r + (node.kind === "skill" ? 5.2 : 4.2) / zoomScale, 0, Math.PI * 2);
          ctx.lineWidth = 2.1 / zoomScale;
          ctx.strokeStyle = colors.accent;
          ctx.stroke();
        } else if (!hasActiveRest && (isHovered || isSelected || isNeighbor)) {
          ctx.lineWidth = (isHovered || isSelected ? 2.4 : 1.6) / zoomScale;
          ctx.strokeStyle = colors.bgCanvas;
          ctx.stroke();
        }

        if (node.kind === "skill" && (isCurrent || !hasActiveRest || (rel?.hop ?? 3) <= 1)) {
          const d = r * 0.46;
          ctx.fillStyle = colors.isLight ? "#ffffff" : "#18181b";
          ctx.beginPath();
          ctx.moveTo(node.x, node.y - d);
          ctx.lineTo(node.x + d, node.y);
          ctx.lineTo(node.x, node.y + d);
          ctx.lineTo(node.x - d, node.y);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }

    ctx.restore(); // End world space transform

    // 2.5 Focused midpoint citation count badges (e.g. ×3)
    if (weightBadges.length > 0) {
      ctx.save();
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const b of weightBadges) {
        const s = this.worldToScreen(b.x, b.y);
        const w = ctx.measureText(b.text).width + 10;
        const h = 16;
        roundRectPath(ctx, s.x - w / 2, s.y - h / 2, w, h, 8);
        ctx.fillStyle = colors.pillBg;
        ctx.fill();
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = b.color;
        ctx.stroke();
        ctx.fillStyle = b.color;
        ctx.fillText(b.text, s.x, s.y);
      }
      ctx.restore();
    }

    // 3. Screen-space collision-free frosted label pills
    const fontSize = Math.max(10.5, Math.min(12.5, 11.5 * Math.pow(this.camera.zoom, 0.12)));
    const placedRects = [];
    const pillHeight = fontSize + 8;

    const labelCandidates = this.nodes.slice().sort((a, b) => {
      const score = (n) => {
        if (n.id === this.hoveredNodeId) return 10000;
        if (n.id === activeCurrentId) return 9500;
        if (this.displayMode === "fullscreen" && n.id === this.selectedNodeId) return 9000;
        if (focusNeighbors && focusNeighbors.has(n.id)) return 6000 + (n.visDegree || 0);
        if (folderHover && n.groupKey === folderHover) return 4000 + (n.visDegree || 0);
        if (hasActiveRest) {
          const relItem = this.relevanceMap?.get(n.id);
          if (relItem?.hop === 1) return 3000 + Math.round(relItem.score * 1000);
          if (relItem?.hop === 2) return 1200 + Math.round(relItem.score * 500);
        }
        if (n.kind === "skill") return 1500 + (n.visDegree || 0);
        return (n.visDegree || 0) * 10 + (n.exists ? 1 : 0);
      };
      return score(b) - score(a);
    });

    for (let i = 0; i < labelCandidates.length; i++) {
      const node = labelCandidates[i];
      const isHovered = node.id === this.hoveredNodeId;
      const isSelected = this.displayMode === "fullscreen" && node.id === this.selectedNodeId;
      const isCurrent = Boolean(activeCurrentId && node.id === activeCurrentId);
      const isNeighbor = Boolean(focusNeighbors && focusNeighbors.has(node.id));
      const isPriority = isHovered || isSelected || isCurrent;
      const rel = this.relevanceMap?.get(node.id);

      if (
        hasActiveRest &&
        this.displayMode === "side" &&
        !isCurrent &&
        (rel?.hop ?? 3) >= 2 &&
        this.camera.zoom < 0.95
      ) {
        continue;
      }

      const zoomVisible =
        isPriority ||
        isNeighbor ||
        this.camera.zoom >= 0.45 ||
        (this.nodes.length <= 28 && this.camera.zoom >= 0.28);
      if (!zoomVisible) continue;

      const screen = this.worldToScreen(node.x, node.y);
      const rScreen = this.nodeRadius(node, currentFile) * this.camera.zoom;
      const maxLen = this.displayMode === "side" && !isPriority ? 22 : 34;
      const rawLabel =
        node.label.length > maxLen ? `${node.label.slice(0, maxLen - 1)}…` : node.label;

      ctx.font = `${isCurrent ? 600 : 500} ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      const textWidth = ctx.measureText(rawLabel).width;
      const leadDotSpace = isCurrent ? 10 : 0;
      const pillWidth = textWidth + 12 + leadDotSpace;
      const px = screen.x - pillWidth / 2;
      const py = screen.y + rScreen + (isCurrent ? 9 : 6);

      if (
        px + pillWidth < 0 ||
        px > this.width ||
        py + pillHeight < 0 ||
        py > this.height
      ) {
        continue;
      }

      const candidateRect = { x: px, y: py, w: pillWidth, h: pillHeight };
      if (!isHovered && !isSelected && !isCurrent) {
        let collides = false;
        for (let rIdx = 0; rIdx < placedRects.length; rIdx++) {
          if (rectsOverlap(candidateRect, placedRects[rIdx])) {
            collides = true;
            break;
          }
        }
        if (collides) continue;
      }

      placedRects.push(candidateRect);

      const matchesFolder = folderHover && node.groupKey === folderHover;
      const isDimmed = Boolean(
        (focusId && !isHovered && !isSelected && !isNeighbor) ||
          (folderHover && !matchesFolder)
      );

      let pillAlpha;
      if (isCurrent) {
        pillAlpha = isDimmed ? 0.65 : 1;
      } else if (hasActiveRest) {
        const hop = rel?.hop ?? 3;
        pillAlpha = hop === 1 ? (rel.mutual ? 0.80 : 0.62) : hop === 2 ? 0.34 : 0.22;
      } else {
        pillAlpha = isDimmed ? 0.16 : 1;
      }

      ctx.save();
      ctx.globalAlpha = pillAlpha;
      roundRectPath(ctx, px, py, pillWidth, pillHeight, 6);
      ctx.fillStyle = isCurrent
        ? colorWithAlpha(colors.accent, colors.isLight ? 0.14 : 0.24)
        : colors.pillBg;
      ctx.fill();
      if (isCurrent) {
        ctx.fillStyle = colors.isLight ? "rgba(255, 255, 255, 0.72)" : "rgba(20, 24, 34, 0.55)";
        ctx.fill();
      }
      ctx.lineWidth = isCurrent ? 1.4 : !hasActiveRest && (isHovered || isSelected) ? 1.25 : 0.85;
      ctx.strokeStyle = isCurrent
        ? colors.accent
        : !hasActiveRest && (isHovered || isSelected)
          ? this.nodeColor(node, colors)
          : colors.pillBorder;
      ctx.stroke();

      if (isCurrent) {
        ctx.beginPath();
        ctx.arc(px + 9, py + pillHeight / 2, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = colors.accent;
        ctx.fill();
      }

      ctx.fillStyle = isPriority
        ? colors.textPrimary
        : hasActiveRest
          ? rel?.hop === 1
            ? colors.textSecondary
            : colors.textMuted
          : node.kind === "skill"
            ? colors.skillColor
            : !node.exists || node.kind === "ghost"
              ? colors.ghostColor
              : colors.textSecondary;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(rawLabel, screen.x + leadDotSpace / 2, py + pillHeight / 2);
      ctx.restore();
    }

    ctx.restore();
  }

  zoomBy(factor, clientX = null, clientY = null) {
    this.cameraAnim = null;
    const nextZoom = Math.min(4.2, Math.max(0.18, this.camera.zoom * factor));
    if (nextZoom === this.camera.zoom) return;

    if (clientX !== null && clientY !== null) {
      const rect = this.canvasEl.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const wx = (sx - this.width / 2) / this.camera.zoom - this.camera.x;
      const wy = (sy - this.height / 2) / this.camera.zoom - this.camera.y;
      this.camera.zoom = nextZoom;
      this.camera.x = (sx - this.width / 2) / nextZoom - wx;
      this.camera.y = (sy - this.height / 2) / nextZoom - wy;
    } else {
      this.camera.zoom = nextZoom;
    }
    this.draw();
  }

  fitToView(animate = true) {
    if (this.nodes.length === 0) {
      const target = { x: 0, y: 0, zoom: 1 };
      if (animate) this.animateCameraTo(target);
      else {
        this.camera = target;
        this.draw();
      }
      return;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of this.nodes) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y);
    }

    const isSide = this.displayMode === "side";
    const w = this.width || (isSide ? 340 : 900);
    const h = this.height || 600;
    const padX = isSide ? 120 : 180;
    const padY = isSide ? 140 : 180;
    const spanX = Math.max(200, maxX - minX + padX);
    const spanY = Math.max(180, maxY - minY + padY);
    const fillX = isSide ? 0.86 : 0.82;
    const fillY = isSide ? 0.80 : 0.78;
    const zoom = Math.min(
      1.35,
      Math.max(0.22, Math.min((w * fillX) / spanX, (h * fillY) / spanY))
    );
    const target = {
      x: -(minX + maxX) / 2,
      y: -(minY + maxY) / 2,
      zoom,
    };

    if (animate) {
      this.animateCameraTo(target, 240);
    } else {
      this.cameraAnim = null;
      this.camera = target;
      this.draw();
    }
  }

  handleWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    this.zoomBy(factor, e.clientX, e.clientY);
  }

  handlePointerDown(e) {
    if (e.button !== 0 || !this.isOpen) return;
    this.canvasEl.focus({ preventScroll: true });
    this.cameraAnim = null;
    const world = this.screenToWorld(e.clientX, e.clientY);
    const hit = this.findNodeAt(world.x, world.y);

    this.pointerStart = { x: e.clientX, y: e.clientY };
    this.pointerMoved = false;

    if (hit) {
      this.draggedNode = hit;
      this.canvasEl.style.cursor = "grabbing";
      this.wakeSimulation(0.28);
    } else {
      this.isPanning = true;
      this.panOrigin = { x: this.camera.x, y: this.camera.y };
      this.canvasEl.style.cursor = "grabbing";
    }
  }

  handlePointerMove(e) {
    if (!this.isOpen) return;

    if (this.draggedNode) {
      const dist = Math.hypot(e.clientX - this.pointerStart.x, e.clientY - this.pointerStart.y);
      if (dist > 4) this.pointerMoved = true;
      const world = this.screenToWorld(e.clientX, e.clientY);
      this.draggedNode.x = world.x;
      this.draggedNode.y = world.y;
      this.draggedNode.vx = 0;
      this.draggedNode.vy = 0;
      this.wakeSimulation(0.25);
      return;
    }

    if (this.isPanning) {
      const dx = (e.clientX - this.pointerStart.x) / this.camera.zoom;
      const dy = (e.clientY - this.pointerStart.y) / this.camera.zoom;
      if (Math.hypot(e.clientX - this.pointerStart.x, e.clientY - this.pointerStart.y) > 4) {
        this.pointerMoved = true;
      }
      this.camera.x = this.panOrigin.x + dx;
      this.camera.y = this.panOrigin.y + dy;
      this.draw();
      return;
    }

    if (e.target !== this.canvasEl) return;
    const world = this.screenToWorld(e.clientX, e.clientY);
    const hit = this.findNodeAt(world.x, world.y);
    const nextHoverId = hit ? hit.id : null;
    this.canvasEl.style.cursor = hit ? "pointer" : "grab";
    if (nextHoverId !== this.hoveredNodeId) {
      this.hoveredNodeId = nextHoverId;
      this.renderSideFooter();
      this.draw();
    }
  }

  handlePointerUp(e) {
    if (!this.isOpen) return;

    if (this.draggedNode) {
      const clickedNode = !this.pointerMoved ? this.draggedNode : null;
      this.draggedNode = null;
      this.canvasEl.style.cursor = clickedNode ? "pointer" : "grab";
      if (clickedNode) {
        if (this.displayMode === "side") {
          this.onOpenNode(clickedNode);
        } else {
          const now = performance.now();
          const isDblClick =
            this.lastClickNodeId === clickedNode.id && now - this.lastClickTime < 360;
          this.lastClickNodeId = clickedNode.id;
          this.lastClickTime = now;
          if (isDblClick) {
            this.lastClickNodeId = null;
            this.onOpenNode(clickedNode);
          } else {
            this.selectNode(clickedNode.id);
          }
        }
      } else {
        this.wakeSimulation(0.22);
      }
      return;
    }

    if (this.isPanning) {
      const wasClick = !this.pointerMoved;
      this.isPanning = false;
      if (wasClick && this.displayMode === "fullscreen" && this.selectedNodeId) {
        this.selectNode(null);
      }
      const world = this.screenToWorld(e.clientX, e.clientY);
      const hit = this.findNodeAt(world.x, world.y);
      this.canvasEl.style.cursor = hit ? "pointer" : "grab";
    }
  }
}
