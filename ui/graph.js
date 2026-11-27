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

/**
 * Interactive force-directed knowledge graph rendered on HTML5 Canvas.
 */
export class GraphView {
  constructor(elements, callbacks) {
    this.viewEl = elements.viewEl;
    this.canvasEl = elements.canvasEl;
    this.filterInputEl = elements.filterInputEl;
    this.localToggleBtn = elements.localToggleBtn;
    this.orphansToggleBtn = elements.orphansToggleBtn;
    this.refreshBtn = elements.refreshBtn;
    this.statsEl = elements.statsEl;
    this.zoomInBtn = elements.zoomInBtn;
    this.zoomOutBtn = elements.zoomOutBtn;
    this.zoomFitBtn = elements.zoomFitBtn;

    this.invoke = callbacks.invoke;
    this.getCurrentFile = callbacks.getCurrentFile || (() => null);
    this.onOpenNode = callbacks.onOpenNode || (() => {});
    this.onToast = callbacks.onToast || (() => {});

    this.isOpen = false;
    this.localMode = false;
    this.showOrphans = true;
    this.filterText = "";

    this.rawNodes = [];
    this.rawEdges = [];
    this.nodes = [];
    this.edges = [];
    this.nodeMap = new Map();
    this.adjMap = new Map();

    this.camera = { x: 0, y: 0, zoom: 1 };
    this.energy = 0;
    this.rafId = null;

    this.hoveredNodeId = null;
    this.draggedNode = null;
    this.isPanning = false;
    this.pointerStart = { x: 0, y: 0 };
    this.panOrigin = { x: 0, y: 0 };
    this.pointerMoved = false;

    this.ctx = this.canvasEl.getContext("2d");
    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);

    this.bindEvents();
  }

  bindEvents() {
    this.resizeObserver = new ResizeObserver(() => {
      if (this.isOpen) {
        this.resizeCanvas();
        this.draw();
      }
    });
    this.resizeObserver.observe(this.viewEl);

    this.filterInputEl.addEventListener("input", () => {
      this.filterText = this.filterInputEl.value.trim().toLowerCase();
      this.rebuildActiveGraph(false);
    });

    this.localToggleBtn.addEventListener("click", () => {
      if (!this.localMode && !this.getCurrentFile()) {
        this.onToast("Open a note first to inspect its local graph", false);
        return;
      }
      this.localMode = !this.localMode;
      this.localToggleBtn.classList.toggle("active", this.localMode);
      this.rebuildActiveGraph(true);
    });

    this.orphansToggleBtn.addEventListener("click", () => {
      this.showOrphans = !this.showOrphans;
      this.orphansToggleBtn.classList.toggle("active", this.showOrphans);
      this.rebuildActiveGraph(false);
    });

    this.refreshBtn.addEventListener("click", () => {
      this.loadAndRender(true);
    });

    this.zoomInBtn.addEventListener("click", () => this.zoomBy(1.25));
    this.zoomOutBtn.addEventListener("click", () => this.zoomBy(0.8));
    this.zoomFitBtn.addEventListener("click", () => this.fitToView());

    this.canvasEl.addEventListener("wheel", (e) => this.handleWheel(e), { passive: false });
    this.canvasEl.addEventListener("pointerdown", (e) => this.handlePointerDown(e));
    window.addEventListener("pointermove", (e) => this.handlePointerMove(e));
    window.addEventListener("pointerup", (e) => this.handlePointerUp(e));
    this.canvasEl.addEventListener("pointerleave", () => {
      if (!this.draggedNode && !this.isPanning && this.hoveredNodeId !== null) {
        this.hoveredNodeId = null;
        this.canvasEl.style.cursor = "grab";
        this.draw();
      }
    });
  }

  setVisible(open) {
    this.isOpen = Boolean(open);
    if (!this.isOpen) {
      this.stopSimulation();
      return;
    }
    this.resizeCanvas();
    this.loadAndRender(false);
  }

  async loadAndRender(resetPositions = false) {
    if (!this.isOpen) return;
    try {
      const data = await this.invoke("get_vault_graph");
      this.rawNodes = data?.nodes || [];
      this.rawEdges = data?.edges || [];
      if (this.localMode && !this.getCurrentFile()) {
        this.localMode = false;
        this.localToggleBtn.classList.remove("active");
      }
      this.localToggleBtn.classList.toggle("active", this.localMode);
      this.orphansToggleBtn.classList.toggle("active", this.showOrphans);
      this.rebuildActiveGraph(resetPositions);
    } catch (err) {
      this.onToast(`Failed to load graph: ${err}`, true);
    }
  }

  rebuildActiveGraph(resetPositions = false) {
    const prevPositions = new Map();
    if (!resetPositions) {
      for (const n of this.nodes) {
        prevPositions.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy });
      }
    }

    const currentFile = this.getCurrentFile();
    let allowedIds = null;

    if (this.localMode && currentFile) {
      allowedIds = new Set([currentFile]);
      for (const edge of this.rawEdges) {
        if (edge.source === currentFile) allowedIds.add(edge.target);
        if (edge.target === currentFile) allowedIds.add(edge.source);
      }
    }

    const q = this.filterText;
    const candidateNodes = this.rawNodes.filter((n) => {
      if (allowedIds && !allowedIds.has(n.id)) return false;
      if (!this.showOrphans && n.degree === 0 && n.id !== currentFile) return false;
      if (q) {
        const hay = `${n.label} ${n.rel_path || ""} ${n.folder || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const activeIdSet = new Set(candidateNodes.map((n) => n.id));
    this.edges = this.rawEdges.filter(
      (e) => activeIdSet.has(e.source) && activeIdSet.has(e.target)
    );

    // Recompute degrees within the visible subset for visual sizing
    const visibleDegree = new Map();
    for (const e of this.edges) {
      visibleDegree.set(e.source, (visibleDegree.get(e.source) || 0) + 1);
      visibleDegree.set(e.target, (visibleDegree.get(e.target) || 0) + 1);
    }

    const count = candidateNodes.length;
    const spread = Math.max(110, Math.sqrt(Math.max(1, count)) * 58);

    this.nodes = candidateNodes.map((n, idx) => {
      const prev = prevPositions.get(n.id);
      if (prev) {
        return {
          ...n,
          visDegree: visibleDegree.get(n.id) || 0,
          x: prev.x,
          y: prev.y,
          vx: prev.vx,
          vy: prev.vy,
        };
      }
      if (this.localMode && currentFile && n.id === currentFile) {
        return { ...n, visDegree: visibleDegree.get(n.id) || 0, x: 0, y: 0, vx: 0, vy: 0 };
      }
      const angle = idx * 2.399963229728653; // Golden angle
      const r = spread * Math.sqrt((idx + 0.5) / Math.max(1, count));
      return {
        ...n,
        visDegree: visibleDegree.get(n.id) || 0,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        vx: 0,
        vy: 0,
      };
    });

    this.nodeMap = new Map(this.nodes.map((n) => [n.id, n]));
    this.adjMap = new Map(this.nodes.map((n) => [n.id, new Set()]));
    for (const edge of this.edges) {
      this.adjMap.get(edge.source)?.add(edge.target);
      this.adjMap.get(edge.target)?.add(edge.source);
    }

    if (resetPositions || prevPositions.size === 0) {
      this.camera = { x: 0, y: 0, zoom: count > 45 ? 0.75 : 1 };
    }

    this.statsEl.textContent = `${this.nodes.length} ${this.nodes.length === 1 ? "note" : "notes"} · ${this.edges.length} ${this.edges.length === 1 ? "link" : "links"}`;
    this.wakeSimulation(1.0);
  }

  resizeCanvas() {
    const rect = this.viewEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvasEl.width = Math.round(this.width * this.dpr);
    this.canvasEl.height = Math.round(this.height * this.dpr);
  }

  wakeSimulation(energy = 0.85) {
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

  tick() {
    if (!this.isOpen) {
      this.rafId = null;
      return;
    }

    this.stepPhysics();
    this.draw();

    if (this.energy > 0.035 || this.draggedNode) {
      this.rafId = requestAnimationFrame(() => this.tick());
    } else {
      this.rafId = null;
    }
  }

  stepPhysics() {
    const nodes = this.nodes;
    const nLen = nodes.length;
    if (nLen === 0) {
      this.energy = 0;
      return;
    }

    const alpha = Math.min(1, Math.max(0.06, this.energy));
    const repulsionStrength = 4400;
    const gravityStrength = 0.022;
    const springLength = 108;
    const springStrength = 0.048;
    const damping = 0.82;

    // 1. Center gravity
    for (let i = 0; i < nLen; i++) {
      const node = nodes[i];
      if (node === this.draggedNode) continue;
      node.vx -= node.x * gravityStrength * alpha;
      node.vy -= node.y * gravityStrength * alpha;
    }

    // 2. Pairwise repulsion
    for (let i = 0; i < nLen; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nLen; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) {
          dx = 0.5;
          dy = 0.5;
          distSq = 0.5;
        }
        if (distSq > 260000) continue; // Cutoff far nodes
        const dist = Math.sqrt(distSq);
        const force = (repulsionStrength / distSq) * alpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
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

    // 3. Spring attraction along edges
    for (let i = 0; i < this.edges.length; i++) {
      const edge = this.edges[i];
      const src = this.nodeMap.get(edge.source);
      const dst = this.nodeMap.get(edge.target);
      if (!src || !dst) continue;

      const dx = dst.x - src.x;
      const dy = dst.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const diff = dist - springLength;
      const force = diff * springStrength * alpha;
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

    // 4. Integrate velocities
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
      if (speed > 22) {
        node.vx = (node.vx / speed) * 22;
        node.vy = (node.vy / speed) * 22;
      }
      node.x += node.vx;
      node.y += node.vy;
      totalMove += Math.abs(node.vx) + Math.abs(node.vy);
    }

    this.energy = Math.max(this.energy * 0.965, Math.min(1, totalMove / (nLen * 3.5)));
  }

  getThemeColors() {
    const cs = getComputedStyle(document.documentElement);
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    return {
      isLight,
      accent: cs.getPropertyValue("--accent").trim() || "#5b8def",
      textPrimary: cs.getPropertyValue("--text-primary").trim() || "#e7e8ec",
      textSecondary: cs.getPropertyValue("--text-secondary").trim() || "#a0a6b5",
      textMuted: cs.getPropertyValue("--text-muted").trim() || "#6c7282",
      bgCanvas: cs.getPropertyValue("--bg-canvas").trim() || "#191a1e",
      borderStrong: cs.getPropertyValue("--border-strong").trim() || "rgba(255,255,255,0.14)",
    };
  }

  nodeRadius(node) {
    const base = node.exists ? 5 : 4.2;
    return Math.min(13.5, base + Math.sqrt(node.visDegree || 0) * 1.9);
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

  findNodeAt(worldX, worldY) {
    const pad = 6 / this.camera.zoom;
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const node = this.nodes[i];
      const r = this.nodeRadius(node) + pad;
      const dx = worldX - node.x;
      const dy = worldY - node.y;
      if (dx * dx + dy * dy <= r * r) {
        return node;
      }
    }
    return null;
  }

  draw() {
    if (!this.width || !this.height) return;
    const ctx = this.ctx;
    const colors = this.getThemeColors();
    const currentFile = this.getCurrentFile();
    const hoveredId = this.hoveredNodeId;
    const hoverNeighbors = hoveredId ? this.adjMap.get(hoveredId) : null;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    // Subtle dot grid
    const gridSpacing = 36 * this.camera.zoom;
    if (gridSpacing >= 12) {
      const offsetX = ((this.width / 2 + this.camera.x * this.camera.zoom) % gridSpacing + gridSpacing) % gridSpacing;
      const offsetY = ((this.height / 2 + this.camera.y * this.camera.zoom) % gridSpacing + gridSpacing) % gridSpacing;
      ctx.fillStyle = colors.isLight ? "rgba(0, 0, 0, 0.06)" : "rgba(255, 255, 255, 0.05)";
      for (let x = offsetX; x < this.width; x += gridSpacing) {
        for (let y = offsetY; y < this.height; y += gridSpacing) {
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
          : "No notes match the current graph filter.",
        this.width / 2,
        this.height / 2
      );
      ctx.restore();
      return;
    }

    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(this.camera.zoom, this.camera.zoom);
    ctx.translate(this.camera.x, this.camera.y);

    // Draw edges
    const baseLineWidth = 1.1 / Math.max(0.55, this.camera.zoom);
    for (let i = 0; i < this.edges.length; i++) {
      const edge = this.edges[i];
      const src = this.nodeMap.get(edge.source);
      const dst = this.nodeMap.get(edge.target);
      if (!src || !dst) continue;

      const isHoverEdge =
        hoveredId && (edge.source === hoveredId || edge.target === hoveredId);

      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(dst.x, dst.y);

      if (hoveredId) {
        ctx.strokeStyle = isHoverEdge ? colors.accent : colors.borderStrong;
        ctx.globalAlpha = isHoverEdge ? 0.92 : 0.14;
        ctx.lineWidth = isHoverEdge ? baseLineWidth * 1.8 : baseLineWidth;
      } else {
        ctx.strokeStyle = colors.borderStrong;
        ctx.globalAlpha = colors.isLight ? 0.75 : 0.65;
        ctx.lineWidth = baseLineWidth;
      }
      ctx.stroke();
    }

    // Draw nodes
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const r = this.nodeRadius(node);
      const isHovered = node.id === hoveredId;
      const isNeighbor = Boolean(hoverNeighbors && hoverNeighbors.has(node.id));
      const isCurrent = Boolean(currentFile && node.id === currentFile);
      const dimmed = Boolean(hoveredId && !isHovered && !isNeighbor);

      ctx.save();
      ctx.globalAlpha = dimmed ? 0.2 : node.exists ? 1 : 0.65;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);

      if (!node.exists) {
        ctx.fillStyle = colors.bgCanvas;
        ctx.fill();
        ctx.setLineDash([2.5, 2.5]);
        ctx.lineWidth = 1.4 / Math.max(0.7, this.camera.zoom);
        ctx.strokeStyle = isHovered ? colors.accent : colors.textMuted;
        ctx.stroke();
      } else {
        if (isHovered || isCurrent) {
          ctx.fillStyle = colors.accent;
        } else if (isNeighbor) {
          ctx.fillStyle = colors.textPrimary;
        } else {
          ctx.fillStyle = colors.textSecondary;
        }
        ctx.fill();

        if (isHovered || isCurrent) {
          ctx.lineWidth = (isHovered ? 2.5 : 1.8) / Math.max(0.75, this.camera.zoom);
          ctx.strokeStyle = colors.bgCanvas;
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // Draw labels on top
    const fontSize = Math.max(9, Math.min(13, 11.5 / Math.pow(this.camera.zoom, 0.35)));
    ctx.font = `500 ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const isHovered = node.id === hoveredId;
      const isNeighbor = Boolean(hoverNeighbors && hoverNeighbors.has(node.id));
      const isCurrent = Boolean(currentFile && node.id === currentFile);

      const showLabel =
        isHovered ||
        isNeighbor ||
        isCurrent ||
        this.camera.zoom >= 0.72 ||
        (this.nodes.length <= 24 && this.camera.zoom >= 0.45);

      if (!showLabel) continue;

      const dimmed = Boolean(hoveredId && !isHovered && !isNeighbor);
      const r = this.nodeRadius(node);
      const label = node.label.length > 34 ? `${node.label.slice(0, 33)}…` : node.label;

      ctx.save();
      ctx.globalAlpha = dimmed ? 0.18 : isHovered || isCurrent ? 1 : 0.85;
      ctx.fillStyle = isHovered || isCurrent ? colors.textPrimary : colors.textSecondary;
      ctx.fillText(label, node.x, node.y + r + 4 / Math.max(0.75, this.camera.zoom));
      ctx.restore();
    }

    ctx.restore();
  }

  zoomBy(factor, clientX = null, clientY = null) {
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

  fitToView() {
    if (this.nodes.length === 0) {
      this.camera = { x: 0, y: 0, zoom: 1 };
      this.draw();
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
    const spanX = Math.max(120, maxX - minX + 120);
    const spanY = Math.max(120, maxY - minY + 120);
    const zoom = Math.min(
      1.6,
      Math.max(0.22, Math.min((this.width * 0.84) / spanX, (this.height * 0.84) / spanY))
    );
    this.camera = {
      x: -(minX + maxX) / 2,
      y: -(minY + maxY) / 2,
      zoom,
    };
    this.draw();
  }

  handleWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    this.zoomBy(factor, e.clientX, e.clientY);
  }

  handlePointerDown(e) {
    if (e.button !== 0 || !this.isOpen) return;
    const world = this.screenToWorld(e.clientX, e.clientY);
    const hit = this.findNodeAt(world.x, world.y);

    this.pointerStart = { x: e.clientX, y: e.clientY };
    this.pointerMoved = false;

    if (hit) {
      this.draggedNode = hit;
      this.canvasEl.style.cursor = "grabbing";
      this.wakeSimulation(0.35);
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
      this.wakeSimulation(0.35);
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
        this.onOpenNode(clickedNode);
      } else {
        this.wakeSimulation(0.25);
      }
      return;
    }

    if (this.isPanning) {
      this.isPanning = false;
      const world = this.screenToWorld(e.clientX, e.clientY);
      const hit = this.findNodeAt(world.x, world.y);
      this.canvasEl.style.cursor = hit ? "pointer" : "grab";
    }
  }
}
