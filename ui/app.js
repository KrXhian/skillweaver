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

import { AiPanel } from "./ai.js";
import { DiffModal } from "./diff.js";
import { BlockEditor } from "./editor.js";
import { FolderView } from "./folder.js";
import { GraphView } from "./graph.js";
import { escapeHtml } from "./inline.js";
import { QuickSwitcher } from "./links.js";
import {
  computeTextMetrics,
  extractBlocksMetrics,
  extractRawMarkdownMetrics,
} from "./metrics.js";
import { DocOutline } from "./outline.js";
import { ModalDialog, SidebarController } from "./sidebar.js";
import { TerminalPanel } from "./terminal.js";

function invoke(cmd, args = {}) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  if (!tauriInvoke) {
    return Promise.reject(new Error("Tauri runtime API is unavailable"));
  }
  return tauriInvoke(cmd, args);
}

function tauriListen(eventName, handler) {
  const listenFn = window.__TAURI__?.event?.listen;
  if (!listenFn) return Promise.resolve(() => {});
  return listenFn(eventName, handler);
}

const el = {
  appEl: document.getElementById("app"),
  vaultName: document.getElementById("vault-name"),
  btnVaultName: document.getElementById("btn-vault-name"),
  btnOpenFolder: document.getElementById("btn-open-folder"),
  btnNewNote: document.getElementById("btn-new-note"),
  btnNewFolder: document.getElementById("btn-new-folder"),
  btnRefreshVault: document.getElementById("btn-refresh-vault"),
  btnQuickOpen: document.getElementById("btn-quick-open"),
  btnToggleSidebar: document.getElementById("btn-toggle-sidebar"),
  btnToggleFold: document.getElementById("btn-toggle-fold"),
  btnToggleRaw: document.getElementById("btn-toggle-raw"),
  btnToggleGraph: document.getElementById("btn-toggle-graph"),
  btnToggleTerminal: document.getElementById("btn-toggle-terminal"),
  btnToggleAi: document.getElementById("btn-toggle-ai"),
  btnToggleTheme: document.getElementById("btn-toggle-theme"),
  btnWelcomeOpen: document.getElementById("btn-welcome-open"),
  btnWelcomeNew: document.getElementById("btn-welcome-new"),
  welcomeSubtitle: document.getElementById("welcome-subtitle"),
  welcomeView: document.getElementById("welcome-view"),
  folderView: document.getElementById("folder-view"),
  editorStage: document.getElementById("editor-stage"),
  editorScroll: document.getElementById("editor-scroll"),
  rawEditorView: document.getElementById("raw-editor-view"),
  workspaceBody: document.querySelector(".workspace-body"),
  graphResizer: document.getElementById("graph-resizer"),
  graphSideHost: document.getElementById("graph-side-host"),
  graphView: document.getElementById("graph-view"),
  rawTextarea: document.getElementById("raw-textarea"),
  breadcrumb: document.getElementById("breadcrumb"),
  saveStatus: document.getElementById("save-status"),
  docTitle: document.getElementById("doc-title"),
  docPathHint: document.getElementById("doc-path-hint"),
  blocksContainer: document.getElementById("blocks-container"),
  bottomClickZone: document.getElementById("bottom-click-zone"),
  backlinksSection: document.getElementById("backlinks-section"),
  backlinksToggle: document.getElementById("backlinks-toggle"),
  backlinksCount: document.getElementById("backlinks-count"),
  backlinksList: document.getElementById("backlinks-list"),
  conflictBanner: document.getElementById("external-conflict-banner"),
  conflictBannerText: document.getElementById("conflict-banner-text"),
  btnConflictDiff: document.getElementById("btn-conflict-diff"),
  btnConflictKeep: document.getElementById("btn-conflict-keep"),
  btnConflictReload: document.getElementById("btn-conflict-reload"),
  statusGitBranch: document.getElementById("status-git-branch"),
  statusGitBranchName: document.getElementById("status-git-branch-name"),
  statusModeBtn: document.getElementById("status-mode-btn"),
  statusSelectionBadge: document.getElementById("status-selection-badge"),
  statusWords: document.getElementById("status-words"),
  statusChars: document.getElementById("status-chars"),
  statusTokens: document.getElementById("status-tokens"),
  statusReadtime: document.getElementById("status-readtime"),
  toast: document.getElementById("toast"),
};

const ZOOM_MIN_PERCENT = 50;
const ZOOM_MAX_PERCENT = 200;
const ZOOM_STEP_PERCENT = 10;
const ZOOM_DEFAULT_PERCENT = 100;

const state = {
  prefs: {
    last_folder: null,
    last_file: null,
    theme: "dark",
    sidebar_width: 240,
    sidebar_collapsed: false,
    terminal_height: 240,
    ai_panel_width: 340,
    zoom_percent: ZOOM_DEFAULT_PERCENT,
    collapsed_headings: {},
  },
  vault: null,
  currentFile: null,
  currentFolderView: null,
  rawMode: false,
  graphDisplayMode: "closed", // "closed" | "side" | "fullscreen"
  isDirty: false,
  statusMetricsTimer: null,
  statusSelectionTimer: null,
  lastKnownDiskHash: null,
  lastKnownMtimeMs: null,
  lastKnownDiskMd: null,
  externalConflict: null,
  saveTimer: null,
  syncStatusTimer: null,
  zoomSaveTimer: null,
  toastTimer: null,
  fsEventQueueRunning: false,
  pendingFsEvent: null,
  deferredHotReloadTimer: null,
  deferredAiRefreshTimer: null,
  backlinksRequestSeq: 0,
};

const imageCache = new Map();

function imageCacheKey(src) {
  return `${state.currentFile || ""}::${src}`;
}

function isGraphOpen() {
  return state.graphDisplayMode === "side" || state.graphDisplayMode === "fullscreen";
}

function isGraphSide() {
  return state.graphDisplayMode === "side";
}

function isGraphFullscreen() {
  return state.graphDisplayMode === "fullscreen";
}

function setRightDrawerWidth(width) {
  const clamped = Math.min(560, Math.max(260, Number(width) || 340));
  if (el.graphSideHost) {
    el.graphSideHost.style.width = `${clamped}px`;
  }
  aiPanel.setWidth(clamped);
}

function showToast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle("error", isError);
  el.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2600);
}

function setSaveStatus(mode) {
  clearTimeout(state.syncStatusTimer);
  state.syncStatusTimer = null;
  el.saveStatus.classList.remove("unsaved", "synced", "conflict");

  if (!state.currentFile) {
    el.saveStatus.textContent = "";
    return;
  }
  if (mode === "unsaved") {
    el.saveStatus.textContent = "• Unsaved";
    el.saveStatus.classList.add("unsaved");
  } else if (mode === "saving") {
    el.saveStatus.textContent = "Saving...";
  } else if (mode === "conflict") {
    el.saveStatus.textContent = "• Conflict";
    el.saveStatus.classList.add("conflict");
  } else if (mode === "synced") {
    el.saveStatus.textContent = "Synced from disk";
    el.saveStatus.classList.add("synced");
    state.syncStatusTimer = setTimeout(() => {
      state.syncStatusTimer = null;
      if (state.currentFile && !state.isDirty && !state.externalConflict) {
        setSaveStatus("saved");
      }
    }, 2400);
  } else {
    el.saveStatus.textContent = "Saved";
  }
}

function foldKey(relPath) {
  const root = state.vault?.root_path || "";
  return `${root}::${relPath}`;
}

async function persistPrefs() {
  try {
    await invoke("save_ui_prefs", { prefs: state.prefs });
  } catch (err) {
    console.error("Failed to save prefs:", err);
  }
}

function applyTheme(theme) {
  const normalized = theme === "light" ? "light" : "dark";
  state.prefs.theme = normalized;
  document.documentElement.setAttribute("data-theme", normalized);
  if (isGraphOpen() && typeof graphView !== "undefined") {
    graphView.renderLegend();
    graphView.renderSideFooter();
    graphView.draw();
  }
}

function clampZoomPercent(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return ZOOM_DEFAULT_PERCENT;
  return Math.min(ZOOM_MAX_PERCENT, Math.max(ZOOM_MIN_PERCENT, n));
}

function schedulePersistZoom() {
  clearTimeout(state.zoomSaveTimer);
  state.zoomSaveTimer = setTimeout(() => {
    state.zoomSaveTimer = null;
    persistPrefs();
  }, 200);
}

async function applyZoom(percent, { persist = true, toast = true, toastLabel = null } = {}) {
  const next = clampZoomPercent(percent);
  state.prefs.zoom_percent = next;
  try {
    await invoke("set_window_zoom", { zoomPercent: next });
    if (toast) {
      showToast(toastLabel || `Zoom: ${next}%`);
    }
    if (persist) {
      schedulePersistZoom();
    }
  } catch (err) {
    if (toast) showToast(`Zoom failed: ${err}`, true);
  }
}

function stepZoom(delta) {
  const current = clampZoomPercent(state.prefs.zoom_percent);
  const next = clampZoomPercent(current + delta);
  if (next === current) {
    const edge = next <= ZOOM_MIN_PERCENT ? "Min" : "Max";
    showToast(`Zoom: ${next}% (${edge})`);
    return;
  }
  applyZoom(next, { persist: true, toast: true });
}

function resetZoom() {
  applyZoom(ZOOM_DEFAULT_PERCENT, {
    persist: true,
    toast: true,
    toastLabel: `Zoom: ${ZOOM_DEFAULT_PERCENT}% (Reset)`,
  });
}

const modal = new ModalDialog(
  document.getElementById("input-modal"),
  document.getElementById("input-modal-title"),
  document.getElementById("input-modal-desc"),
  document.getElementById("input-modal-field"),
  document.getElementById("input-modal-cancel"),
  document.getElementById("input-modal-confirm")
);

const sidebar = new SidebarController(
  {
    treeEl: document.getElementById("file-tree"),
    contextMenuEl: document.getElementById("context-menu"),
    sidebarEl: document.getElementById("sidebar"),
    resizerEl: document.getElementById("sidebar-resizer"),
    vaultHeaderEl: document.querySelector(".sidebar-header"),
  },
  {
    onOpenFile: (relPath) => openNote(relPath),
    onOpenFolder: (relDir) => openFolderView(relDir),
    onNewNote: (folderRel) => promptCreateNote(folderRel),
    onNewFolder: (folderRel) => promptCreateFolder(folderRel),
    onRename: (node) => promptRenameEntry(node),
    onDelete: (node) => promptDeleteEntry(node),
    onMoveEntry: (node, targetFolder) => handleMoveEntry(node, targetFolder),
    onResizeEnd: (width) => {
      state.prefs.sidebar_width = width;
      persistPrefs();
    },
  }
);

const folderView = new FolderView(
  {
    containerEl: el.folderView,
  },
  {
    onOpenNote: (relPath) => openNote(relPath),
    onOpenFolder: (relDir) => openFolderView(relDir),
    onCreateNote: (folderRel, templateFile) => promptCreateNote(folderRel, templateFile),
    onCreateFolder: (folderRel) => promptCreateFolder(folderRel),
    onSaveProperties: (folderRel, properties) =>
      invoke("save_folder_properties", { folderRel, properties }),
    onSaveTemplate: async ({ folderRel, fileName, name, description, body }) => {
      await invoke("save_folder_template", {
        folderRel,
        fileName,
        name,
        description,
        body,
      });
      await refreshCurrentFolderView();
      showToast(`Saved template "${name}"`);
    },
    onDeleteTemplate: async (folderRel, fileName) => {
      await invoke("delete_folder_template", { folderRel, fileName });
      await refreshCurrentFolderView();
      showToast("Deleted template");
    },
    onShowToast: (msg, isError) => showToast(msg, isError),
  }
);

const editor = new BlockEditor(
  {
    containerEl: el.blocksContainer,
    selectionToolbarEl: document.getElementById("selection-toolbar"),
    boldBtn: document.getElementById("btn-sel-bold"),
    italicBtn: document.getElementById("btn-sel-italic"),
    inlineCodeBtn: document.getElementById("btn-sel-code"),
    highlightBtn: document.getElementById("btn-sel-highlight"),
    colorSelBtn: document.getElementById("btn-sel-color"),
    askAiSelBtn: document.getElementById("btn-sel-ai"),
    linkPopoverEl: document.getElementById("link-popover"),
    slashPopoverEl: document.getElementById("slash-popover"),
    blockMenuEl: document.getElementById("block-menu"),
    blockSelectionBarEl: document.getElementById("block-selection-bar"),
    blockSelectionCountEl: document.getElementById("block-sel-count"),
    blocksAskAiBtn: document.getElementById("btn-blocks-ask-ai"),
    blocksColorBtn: document.getElementById("btn-blocks-color"),
    blocksOutdentBtn: document.getElementById("btn-blocks-outdent"),
    blocksDupBtn: document.getElementById("btn-blocks-dup"),
    blocksDelBtn: document.getElementById("btn-blocks-del"),
    blocksClearBtn: document.getElementById("btn-blocks-clear"),
    blockMarqueeEl: document.getElementById("block-marquee"),
  },
  {
    getPages: () => state.vault?.pages || [],
    onDirty: () => {
      scheduleAutoSave();
      scheduleStatusMetricsUpdate();
      docOutline.scheduleRefresh(180);
    },
    onOpenLink: (target) => handleOpenLink(target),
    onCreatePage: (name) => createPageFromAutocomplete(name),
    onCollapseChange: (indices) => {
      if (!state.currentFile) return;
      const key = foldKey(state.currentFile);
      if (indices.length) {
        state.prefs.collapsed_headings[key] = indices;
      } else {
        delete state.prefs.collapsed_headings[key];
      }
      syncFoldButton();
      docOutline.refresh();
      persistPrefs();
    },
    onSavePastedImage: async (dataUrl) => {
      try {
        const res = await invoke("save_pasted_image", {
          currentRel: state.currentFile,
          dataUrl,
        });
        imageCache.set(imageCacheKey(res.src), res.data_url);
        return res.src;
      } catch (err) {
        showToast(`Failed to paste image: ${err}`, true);
        return null;
      }
    },
    onResolveImageUrl: async (src) => {
      if (!src) return "";
      const lower = src.toLowerCase();
      if (
        lower.startsWith("https://") ||
        lower.startsWith("http://") ||
        lower.startsWith("data:")
      ) {
        return src;
      }
      const key = imageCacheKey(src);
      if (imageCache.has(key)) {
        return imageCache.get(key);
      }
      const dataUrl = await invoke("read_image_data_url", {
        currentRel: state.currentFile,
        src,
      });
      imageCache.set(key, dataUrl);
      return dataUrl;
    },
    getCachedImageUrl: (src) => {
      if (!src) return "";
      const lower = src.toLowerCase();
      if (
        lower.startsWith("https://") ||
        lower.startsWith("http://") ||
        lower.startsWith("data:")
      ) {
        return src;
      }
      return imageCache.get(imageCacheKey(src)) || "";
    },
    onAskAiBlock: (block) => aiPanel.attachBlock(block),
    onAskAiBlocks: (blocks) => aiPanel.focusOnHighlightedBlocks(blocks),
    onAskAiSelection: (selCtx) => aiPanel.attachSelection(selCtx),
    onCopyBlockLink: (bid) => copyBlockLink(bid),
    onBlockSelectionChange: (blocks) => {
      aiPanel.syncLiveSelection(blocks);
      updateStatusBarMetrics();
    },
  }
);

const docOutline = new DocOutline(
  {
    toggleBtn: document.getElementById("btn-toggle-outline"),
    panelEl: document.getElementById("doc-outline-panel"),
    scrollEl: el.editorScroll,
    blocksContainerEl: el.blocksContainer,
  },
  {
    getBlocks: () => editor.getBlocks(),
    getCollapsedIds: () => editor.collapsedIds,
    onJumpToBlock: (idx) => editor.scrollToBlockIndex(idx),
    onToggleHeadingCollapse: (blockId) => editor.toggleHeadingCollapse(blockId),
  }
);

const aiPanel = new AiPanel(
  {
    panelEl: document.getElementById("ai-panel"),
    resizerEl: document.getElementById("ai-resizer"),
    toggleBtn: el.btnToggleAi,
    historyBtn: document.getElementById("ai-btn-history"),
    historyDrawerEl: document.getElementById("ai-history-drawer"),
    newChatBtn: document.getElementById("ai-btn-new-chat"),
    historySearchEl: document.getElementById("ai-history-search"),
    historyListEl: document.getElementById("ai-history-list"),
    skillsBtn: document.getElementById("ai-btn-skills"),
    skillsDrawerEl: document.getElementById("ai-skills-drawer"),
    modelBadgeEl: document.getElementById("ai-model-badge"),
    modelPopoverEl: document.getElementById("ai-model-popover"),
    settingsBtn: document.getElementById("ai-btn-settings"),
    clearBtn: document.getElementById("ai-btn-clear"),
    closeBtn: document.getElementById("ai-btn-close"),
    settingsDrawerEl: document.getElementById("ai-settings-drawer"),
    profilesListEl: document.getElementById("ai-profiles-list"),
    addProfileBtn: document.getElementById("ai-btn-add-profile"),
    profileFormEl: document.getElementById("ai-profile-form"),
    profileNameInput: document.getElementById("ai-profile-name"),
    providerSelect: document.getElementById("ai-provider"),
    apiKeyInput: document.getElementById("ai-api-key"),
    toggleKeyVisBtn: document.getElementById("ai-toggle-key"),
    baseUrlInput: document.getElementById("ai-base-url"),
    modelInput: document.getElementById("ai-model"),
    pickModelBtn: document.getElementById("ai-btn-pick-model"),
    fetchModelsBtn: document.getElementById("ai-btn-fetch-models"),
    cancelProfileBtn: document.getElementById("ai-cancel-profile"),
    saveSettingsBtn: document.getElementById("ai-save-settings"),
    turnRailEl: document.getElementById("ai-turn-rail"),
    turnPreviewEl: document.getElementById("ai-turn-preview"),
    messagesEl: document.getElementById("ai-messages"),
    chipsEl: document.getElementById("ai-context-chips"),
    mentionPopoverEl: document.getElementById("ai-mention-popover"),
    inputEl: document.getElementById("ai-input"),
    sendBtn: document.getElementById("ai-send-btn"),
    stopBtn: document.getElementById("ai-stop-btn"),
  },
  {
    invoke,
    getCurrentContext: () => ({
      vaultPath: state.vault?.root_path || "",
      vaultName: state.vault?.root_name || "",
      pages: state.vault?.pages || [],
      currentFile: state.currentFile,
      blocks: state.currentFile ? editor.getBlocks() : [],
      selectedBlocks: state.currentFile ? editor.getSelectedBlocksForAi() : [],
    }),
    onResizeEnd: (width) => {
      state.prefs.ai_panel_width = width;
      if (el.graphSideHost) {
        el.graphSideHost.style.width = `${width}px`;
      }
      persistPrefs();
    },
    onApplyEdits: async (ops, sourceFile = null) => {
      if (sourceFile && state.currentFile !== sourceFile) {
        const targetLower = sourceFile.toLowerCase();
        const matchedPage = (state.vault?.pages || []).find(
          (p) => (p.rel_path || "").toLowerCase() === targetLower
        );
        if (!matchedPage) {
          showToast(`Target note "${sourceFile}" no longer exists`, true);
          return { ok: false };
        }
        const confirmed = await modal.confirm({
          title: "Switch Note to Apply Edits?",
          description: `These edits were generated for "${matchedPage.rel_path}", while "${state.currentFile || "no note"}" is currently open. Switch to "${matchedPage.rel_path}" and apply them?`,
          confirmLabel: "Switch & Apply",
          danger: false,
        });
        if (!confirmed) {
          return { ok: false, cancelled: true };
        }
        await openNote(matchedPage.rel_path);
        if (state.currentFile !== matchedPage.rel_path) {
          return { ok: false };
        }
        if (state.rawMode) {
          state.rawMode = false;
          updateViewVisibility();
        }
      }
      if (!state.currentFile || state.rawMode || isGraphFullscreen()) {
        showToast("Switch to a note in block view to apply edits", true);
        return { ok: false };
      }
      const res = editor.applyAiEdits(ops);
      if (!res?.ok && res?.error) {
        showToast(res.error, true);
      }
      return res;
    },
    onInsertMarkdown: async (md) => {
      if (!state.currentFile || state.rawMode) {
        showToast("Open a note in block view first", true);
        return;
      }
      try {
        const blocks = await invoke("parse_raw_markdown", { rawMd: md });
        editor.appendBlocks(blocks);
      } catch (err) {
        showToast(`Failed to insert response: ${err}`, true);
      }
    },
    onOpenLink: (target) => handleOpenLink(target),
    onOpenRawFile: async (relPath) => {
      await openNote(relPath);
      if (state.currentFile === relPath && !state.rawMode) {
        await toggleRawMode();
      }
    },
    onVaultChanged: () => handleRefreshVault(),
    onConfirmDeleteSkill: (skill) =>
      modal.confirm({
        title: `Delete Skill @${skill.slug}?`,
        description:
          skill.scope === "vault"
            ? `Delete "${skill.rel_path || `skills/${skill.slug}/SKILL.md`}" from this folder?`
            : `Delete global skill "@${skill.slug}" from ~/.skillweaver/skills/?`,
        confirmLabel: "Delete",
        danger: true,
      }),
    onToast: (msg, isErr) => showToast(msg, isErr),
    onClearEditorSelection: () => editor.clearBlockSelection(),
    onPromptRenameChat: (chat) =>
      modal.prompt({
        title: "Rename Conversation",
        description: "Set a title for this AI conversation:",
        defaultValue: chat.title || "",
        placeholder: "Conversation title...",
        confirmLabel: "Save",
      }),
    onBeforeOpen: () => {
      if (isGraphSide()) {
        state.graphDisplayMode = "closed";
        updateViewVisibility();
      }
    },
  }
);

const quickSwitcher = new QuickSwitcher(
  document.getElementById("quick-switcher"),
  document.getElementById("quick-switcher-input"),
  document.getElementById("quick-switcher-list"),
  {
    getPages: () => state.vault?.pages || [],
    onSelect: (relPath) => openNote(relPath),
  }
);

const terminal = new TerminalPanel(
  {
    panelEl: document.getElementById("terminal-panel"),
    resizerEl: document.getElementById("terminal-resizer"),
    cwdBadgeEl: document.getElementById("terminal-cwd-badge"),
    outputEl: document.getElementById("terminal-output"),
    scrollEl: document.getElementById("terminal-scroll"),
    promptPrefixEl: document.getElementById("terminal-prompt-prefix"),
    inputEl: document.getElementById("terminal-input"),
    clearBtn: document.getElementById("btn-term-clear"),
    restartBtn: document.getElementById("btn-term-restart"),
    closeBtn: document.getElementById("btn-term-close"),
    toggleBtn: el.btnToggleTerminal,
  },
  {
    invoke,
    onResizeEnd: (height) => {
      state.prefs.terminal_height = height;
      persistPrefs();
    },
    onCommandFinished: () => {
      if (state.vault) {
        handleRefreshVault();
        refreshGitBranch();
      }
    },
  }
);

const graphView = new GraphView(
  {
    viewEl: document.getElementById("graph-view"),
    canvasWrapEl: document.querySelector("#graph-view .graph-canvas-wrap"),
    canvasEl: document.getElementById("graph-canvas"),
    filterInputEl: document.getElementById("graph-filter"),
    localToggleBtn: document.getElementById("graph-local-toggle"),
    orphansToggleBtn: document.getElementById("graph-orphans-toggle"),
    arrowsToggleBtn: document.getElementById("graph-arrows-toggle"),
    skillsToggleBtn: document.getElementById("graph-skills-toggle"),
    refreshBtn: document.getElementById("graph-refresh"),
    statsEl: document.getElementById("graph-stats"),
    sideStatsEl: document.getElementById("graph-side-stats"),
    sideLocalToggleBtn: document.getElementById("graph-side-local-toggle"),
    sideFilterToggleBtn: document.getElementById("graph-side-filter-toggle"),
    sideRefreshBtn: document.getElementById("graph-side-refresh"),
    expandBtn: document.getElementById("graph-expand-btn"),
    dockBtn: document.getElementById("graph-dock-btn"),
    closeBtn: document.getElementById("graph-close-btn"),
    sideCloseBtn: document.getElementById("graph-side-close-btn"),
    legendEl: document.getElementById("graph-legend"),
    inspectorEl: document.getElementById("graph-inspector"),
    sideFooterEl: document.getElementById("graph-side-footer"),
    zoomLocateBtn: document.getElementById("graph-zoom-locate"),
    zoomInBtn: document.getElementById("graph-zoom-in"),
    zoomOutBtn: document.getElementById("graph-zoom-out"),
    zoomFitBtn: document.getElementById("graph-zoom-fit"),
  },
  {
    invoke,
    getCurrentFile: () => state.currentFile,
    onOpenNode: async (node) => {
      if (node.exists && node.rel_path) {
        await openNote(node.rel_path);
      } else {
        await handleOpenLink(node.label);
      }
    },
    onAskAiNode: async (node) => {
      if (isGraphFullscreen()) {
        await setGraphDisplayMode("closed");
      }
      await aiPanel.askAboutGraphNodes({ primaryNode: node, neighborNodes: [] });
    },
    onAskAiCluster: async (node, neighbors) => {
      if (isGraphFullscreen()) {
        await setGraphDisplayMode("closed");
      }
      await aiPanel.askAboutGraphNodes({ primaryNode: node, neighborNodes: neighbors });
    },
    onExpand: () => setGraphDisplayMode("fullscreen"),
    onDock: () => setGraphDisplayMode("side"),
    onClose: () => setGraphDisplayMode("closed"),
    onToast: (msg, isErr) => showToast(msg, isErr),
  }
);

const diffModal = new DiffModal(
  {
    backdropEl: document.getElementById("diff-modal"),
    subtitleEl: document.getElementById("diff-modal-subtitle"),
    statsEl: document.getElementById("diff-modal-stats"),
    bodyEl: document.getElementById("diff-modal-body"),
    closeBtn: document.getElementById("diff-modal-close"),
    cancelBtn: document.getElementById("diff-btn-cancel"),
    keepBtn: document.getElementById("diff-btn-keep"),
    reloadBtn: document.getElementById("diff-btn-reload"),
  },
  {
    onKeepMine: () => resolveConflictKeepMine(),
    onReload: () => resolveConflictReload(),
  }
);

async function getCurrentMineMarkdown() {
  if (state.rawMode) {
    return el.rawTextarea.value;
  }
  return invoke("serialize_blocks_to_md", { blocks: editor.getBlocks() });
}

function showConflictBanner(conflict) {
  state.externalConflict = conflict;
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  setSaveStatus("conflict");

  if (conflict.kind === "deleted") {
    el.conflictBannerText.textContent =
      "This note was deleted on disk, but you have unsaved edits.";
    el.btnConflictDiff.hidden = true;
    el.btnConflictKeep.textContent = "Recreate & Save";
    el.btnConflictKeep.className = "conflict-btn conflict-btn-primary";
    el.btnConflictReload.textContent = "Close Note";
    el.btnConflictReload.className = "conflict-btn conflict-btn-danger";
    if (diffModal.isOpen()) {
      diffModal.close();
    }
  } else {
    el.conflictBannerText.textContent =
      "Modified on disk by another program — your unsaved edits are preserved.";
    el.btnConflictDiff.hidden = false;
    el.btnConflictKeep.textContent = "Keep Mine";
    el.btnConflictKeep.className = "conflict-btn";
    el.btnConflictReload.textContent = "Reload";
    el.btnConflictReload.className = "conflict-btn conflict-btn-primary";
    if (diffModal.isOpen()) {
      getCurrentMineMarkdown()
        .then((mineText) => {
          if (
            diffModal.isOpen() &&
            state.externalConflict?.kind === "modified" &&
            state.currentFile === conflict.relPath
          ) {
            diffModal.update({
              relPath: conflict.relPath,
              mineText,
              diskText: conflict.diskMd || "",
            });
          }
        })
        .catch(() => {});
    }
  }

  el.conflictBanner.hidden = !state.currentFile || isGraphFullscreen();
}

function clearConflictBanner() {
  state.externalConflict = null;
  el.conflictBanner.hidden = true;
  if (diffModal.isOpen()) {
    diffModal.close();
  }
}

function applyHotReloadFromDisk(disk) {
  state.lastKnownDiskHash = disk.disk_hash || null;
  state.lastKnownMtimeMs = disk.mtime_ms ?? null;
  state.lastKnownDiskMd = disk.raw_md ?? "";

  if (state.rawMode) {
    const ta = el.rawTextarea;
    const wasFocused = document.activeElement === ta;
    const scrollTop = ta.scrollTop;
    const selStart = ta.selectionStart ?? 0;
    const selEnd = ta.selectionEnd ?? 0;
    ta.value = disk.raw_md ?? "";
    if (wasFocused) {
      const len = ta.value.length;
      ta.setSelectionRange(Math.min(selStart, len), Math.min(selEnd, len));
    }
    ta.scrollTop = scrollTop;
  } else {
    const viewState = editor.captureViewState();
    el.rawTextarea.value = disk.raw_md ?? "";
    editor.hotReloadDocument(disk.blocks || [], viewState);
    if (state.currentFile) {
      const collapsed = editor.getCollapsedIndices();
      const key = foldKey(state.currentFile);
      if (collapsed.length) {
        state.prefs.collapsed_headings[key] = collapsed;
      } else {
        delete state.prefs.collapsed_headings[key];
      }
      syncFoldButton();
    }
    docOutline.refresh();
  }

  renderBacklinks(disk.backlinks || []);
  updateStatusBarMetrics();
}

async function resolveConflictReload() {
  const conflict = state.externalConflict;
  if (!conflict || !state.currentFile) return;

  if (conflict.kind === "deleted") {
    clearConflictBanner();
    state.currentFile = null;
    state.isDirty = false;
    state.lastKnownDiskHash = null;
    state.lastKnownMtimeMs = null;
    state.lastKnownDiskMd = null;
    await handleRefreshVault();
    updateViewVisibility();
    showToast("Closed deleted note");
    return;
  }

  try {
    const disk = await invoke("check_note_on_disk", { relPath: state.currentFile });
    if (!disk.exists) {
      showConflictBanner({
        kind: "deleted",
        relPath: state.currentFile,
        diskMd: null,
        diskBlocks: null,
        diskBacklinks: [],
        diskHash: "",
        mtimeMs: null,
      });
      return;
    }
    applyHotReloadFromDisk(disk);
    clearConflictBanner();
    state.isDirty = false;
    setSaveStatus("saved");
    showToast("Reloaded latest version from disk");
  } catch (err) {
    showToast(`Reload failed: ${err}`, true);
  }
}

async function resolveConflictKeepMine() {
  const conflict = state.externalConflict;
  if (!conflict || !state.currentFile) return;
  const wasDeleted = conflict.kind === "deleted";
  state.isDirty = true;
  const ok = await flushSave({ force: true });
  if (!ok) return;
  clearConflictBanner();
  if (wasDeleted) {
    await handleRefreshVault();
  }
  showToast(wasDeleted ? "Recreated note on disk" : "Kept your version and saved to disk");
}

async function openConflictDiff() {
  if (state.externalConflict?.kind !== "modified" || !state.currentFile) return;
  try {
    const mineText = await getCurrentMineMarkdown();
    diffModal.open({
      relPath: state.currentFile,
      mineText,
      diskText: state.externalConflict.diskMd || "",
    });
  } catch (err) {
    showToast(`Failed to compute diff: ${err}`, true);
  }
}

async function checkActiveNoteExternalChange() {
  if (!state.vault || !state.currentFile) return;
  const targetRel = state.currentFile;

  let disk;
  try {
    disk = await invoke("check_note_on_disk", { relPath: targetRel });
  } catch {
    return;
  }
  if (state.currentFile !== targetRel) return;

  if (!disk.exists) {
    if (state.isDirty) {
      showConflictBanner({
        kind: "deleted",
        relPath: targetRel,
        diskMd: null,
        diskBlocks: null,
        diskBacklinks: [],
        diskHash: "",
        mtimeMs: null,
      });
    } else {
      clearConflictBanner();
      state.currentFile = null;
      state.lastKnownDiskHash = null;
      state.lastKnownMtimeMs = null;
      state.lastKnownDiskMd = null;
      updateViewVisibility();
      showToast("Active note was deleted on disk");
    }
    return;
  }

  if (state.lastKnownDiskHash && disk.disk_hash === state.lastKnownDiskHash) {
    renderBacklinks(disk.backlinks || []);
    if (state.externalConflict) {
      clearConflictBanner();
      setSaveStatus(state.isDirty ? "unsaved" : "saved");
    }
    return;
  }

  if (state.isDirty) {
    showConflictBanner({
      kind: "modified",
      relPath: targetRel,
      diskMd: disk.raw_md || "",
      diskBlocks: disk.blocks || [],
      diskBacklinks: disk.backlinks || [],
      diskHash: disk.disk_hash,
      mtimeMs: disk.mtime_ms ?? null,
    });
    return;
  }

  if (!state.rawMode && editor.isInteracting()) {
    clearTimeout(state.deferredHotReloadTimer);
    state.deferredHotReloadTimer = setTimeout(() => {
      state.deferredHotReloadTimer = null;
      checkActiveNoteExternalChange();
    }, 250);
    return;
  }

  clearConflictBanner();
  applyHotReloadFromDisk(disk);
  setSaveStatus("synced");
}

function enqueueFsChangedEvent(ev) {
  if (!state.vault || !ev) return;
  if (!state.pendingFsEvent) {
    state.pendingFsEvent = {
      tree_changed: Boolean(ev.tree_changed),
      changes: Array.isArray(ev.changes) ? ev.changes.slice() : [],
    };
  } else {
    state.pendingFsEvent.tree_changed =
      state.pendingFsEvent.tree_changed || Boolean(ev.tree_changed);
    if (Array.isArray(ev.changes)) {
      state.pendingFsEvent.changes.push(...ev.changes);
    }
  }
  if (!state.fsEventQueueRunning) {
    drainFsChangedEvents();
  }
}

async function drainFsChangedEvents() {
  if (state.fsEventQueueRunning) return;
  state.fsEventQueueRunning = true;
  try {
    while (state.pendingFsEvent) {
      const batch = state.pendingFsEvent;
      state.pendingFsEvent = null;
      if (!state.vault) continue;

      const hasStructuralChange =
        batch.tree_changed ||
        batch.changes.some((c) => c.kind === "create" || c.kind === "remove");

      if (hasStructuralChange) {
        try {
          const snapshot = await invoke("refresh_vault");
          await applyVaultSnapshot(snapshot, false);
        } catch (err) {
          console.error("Failed to refresh vault after fs change:", err);
        }
      }

      const touchedSkills = batch.changes.some((c) =>
        /^skills(?:\/|$)/i.test(String(c.rel_path || ""))
      );
      if (touchedSkills) {
        aiPanel.refreshSkills();
      }

      if (isGraphOpen()) {
        graphView.loadAndRender(false);
      }

      if (state.currentFolderView !== null && (hasStructuralChange || batch.changes.length > 0)) {
        await refreshCurrentFolderView();
      }

      if (state.currentFile) {
        await checkActiveNoteExternalChange();
      }
    }
  } finally {
    state.fsEventQueueRunning = false;
  }
}

function scheduleAutoSave() {
  if (!state.currentFile) return;
  state.isDirty = true;
  if (state.externalConflict) {
    setSaveStatus("conflict");
    return;
  }
  setSaveStatus("unsaved");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    flushSave();
  }, 900);
}

async function flushSave({ force = false } = {}) {
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (!state.currentFile || !state.isDirty) return true;
  if (!force && state.externalConflict) return false;

  const fileToSave = state.currentFile;
  const expectedHash = force ? null : state.lastKnownDiskHash;
  setSaveStatus("saving");

  try {
    let res;
    if (state.rawMode) {
      res = await invoke("save_note_raw", {
        relPath: fileToSave,
        rawMd: el.rawTextarea.value,
        expectedHash,
        force,
      });
    } else {
      const blocks = editor.getBlocks();
      res = await invoke("save_note_blocks", {
        relPath: fileToSave,
        blocks,
        expectedHash,
        force,
      });
    }

    if (res?.conflict) {
      if (state.currentFile === fileToSave) {
        if (res.disk_deleted) {
          showConflictBanner({
            kind: "deleted",
            relPath: fileToSave,
            diskMd: null,
            diskBlocks: null,
            diskBacklinks: [],
            diskHash: "",
            mtimeMs: null,
          });
        } else {
          let disk = null;
          try {
            disk = await invoke("check_note_on_disk", { relPath: fileToSave });
          } catch {
            // Fall back to raw disk payload returned by save command
          }
          showConflictBanner({
            kind: "modified",
            relPath: fileToSave,
            diskMd: disk?.raw_md ?? res.disk_md ?? "",
            diskBlocks: disk?.blocks ?? [],
            diskBacklinks: disk?.backlinks ?? [],
            diskHash: disk?.disk_hash || res.disk_hash || "",
            mtimeMs: disk?.mtime_ms ?? res.mtime_ms ?? null,
          });
        }
      }
      return false;
    }

    if (state.currentFile === fileToSave) {
      state.lastKnownDiskHash = res.disk_hash || state.lastKnownDiskHash;
      state.lastKnownMtimeMs = res.mtime_ms ?? state.lastKnownMtimeMs;
      state.lastKnownDiskMd = res.raw_md ?? state.lastKnownDiskMd;
      if (state.rawMode && Array.isArray(res.backlinks)) {
        renderBacklinks(res.backlinks);
      }
      state.isDirty = false;
      setSaveStatus(force ? "saved" : "saved");
      if (isGraphOpen()) {
        graphView.loadAndRender(false);
      }
    }
    return true;
  } catch (err) {
    showToast(`Save failed: ${err}`, true);
    if (state.currentFile === fileToSave) {
      setSaveStatus(state.externalConflict ? "conflict" : "unsaved");
    }
    return false;
  }
}

function syncFoldButton() {
  if (!el.btnToggleFold) return;
  const allCollapsed = editor.areVisibleHeadingsCollapsed();
  el.btnToggleFold.textContent = allCollapsed ? "Expand" : "Collapse";
  el.btnToggleFold.title = allCollapsed
    ? "Expand All Headers (Ctrl+Shift+])"
    : "Collapse All Headers (Ctrl+Shift+[)";
  el.btnToggleFold.classList.toggle("active", allCollapsed);
}

function updateGitBranchUi(branch) {
  if (!el.statusGitBranch || !el.statusGitBranchName) return;
  const clean = typeof branch === "string" ? branch.trim() : "";
  if (!clean) {
    el.statusGitBranch.hidden = true;
    el.statusGitBranchName.textContent = "";
    return;
  }
  el.statusGitBranchName.textContent = clean;
  el.statusGitBranch.title = `Git branch: ${clean} · Click to toggle terminal`;
  el.statusGitBranch.hidden = false;
}

async function refreshGitBranch() {
  if (!state.vault) {
    updateGitBranchUi(null);
    return;
  }
  try {
    const branch = await invoke("get_git_branch");
    if (state.vault) {
      state.vault.git_branch = branch || null;
    }
    updateGitBranchUi(branch);
  } catch {
    // Keep existing branch display on transient error
  }
}

function getActiveSelectionMetrics() {
  if (!state.currentFile || isGraphFullscreen()) return null;

  if (state.rawMode) {
    const ta = el.rawTextarea;
    if (!ta) return null;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    if (end <= start) return null;
    const slice = ta.value.slice(start, end);
    if (!slice.replace(/\u200B/g, "")) return null;
    return {
      label: "Selection",
      ...computeTextMetrics(slice),
    };
  }

  const selectedBlocks = editor.getSelectedBlocks();
  if (selectedBlocks.length > 0) {
    const m = extractBlocksMetrics(selectedBlocks);
    return {
      label: `${selectedBlocks.length} block${selectedBlocks.length === 1 ? "" : "s"}`,
      ...m,
    };
  }

  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !el.blocksContainer) {
    return null;
  }
  const range = sel.getRangeAt(0);
  if (!el.blocksContainer.contains(range.commonAncestorContainer)) {
    return null;
  }
  const selText = sel.toString().replace(/\u200B/g, "");
  if (!selText) return null;
  return {
    label: "Selection",
    ...computeTextMetrics(selText),
  };
}

function updateStatusBarMetrics() {
  if (!el.statusWords || !el.statusChars || !el.statusTokens) return;

  const hasVault = Boolean(state.vault);
  const showFolder = state.currentFolderView !== null && hasVault && !isGraphFullscreen();

  if (el.statusModeBtn) {
    if (isGraphFullscreen() && hasVault) {
      el.statusModeBtn.textContent = "Graph";
      el.statusModeBtn.title = "Dock Graph to Side Panel";
      el.statusModeBtn.hidden = false;
    } else if (showFolder) {
      el.statusModeBtn.textContent = "Folder";
      el.statusModeBtn.title = state.currentFolderView
        ? `Folder Explorer: ${state.currentFolderView}`
        : "Folder Explorer: Vault Root";
      el.statusModeBtn.hidden = false;
    } else if (state.currentFile) {
      el.statusModeBtn.textContent = state.rawMode ? "Raw Markdown" : "Block Editor";
      el.statusModeBtn.title = "Toggle Block / Raw Markdown (Ctrl+Shift+M)";
      el.statusModeBtn.hidden = false;
    } else {
      el.statusModeBtn.hidden = true;
    }
  }

  if (showFolder) {
    if (el.statusSelectionBadge) el.statusSelectionBadge.hidden = true;
    const entries = folderView.overview?.entries || [];
    let noteCount = 0;
    let dirCount = 0;
    for (const item of entries) {
      if (item.kind === "dir") dirCount++;
      else if (item.kind === "note") noteCount++;
    }
    el.statusWords.textContent = `${noteCount} ${noteCount === 1 ? "note" : "notes"} · ${dirCount} ${dirCount === 1 ? "folder" : "folders"}`;
    el.statusWords.hidden = false;
    el.statusChars.hidden = true;
    el.statusTokens.hidden = true;
    if (el.statusReadtime) el.statusReadtime.hidden = true;
    return;
  }

  if (!state.currentFile || isGraphFullscreen()) {
    if (el.statusSelectionBadge) el.statusSelectionBadge.hidden = true;
    el.statusWords.hidden = true;
    el.statusChars.hidden = true;
    el.statusTokens.hidden = true;
    if (el.statusReadtime) el.statusReadtime.hidden = true;
    return;
  }

  const tot = state.rawMode
    ? extractRawMarkdownMetrics(el.rawTextarea?.value || "")
    : extractBlocksMetrics(editor.getBlocks());
  const sel = getActiveSelectionMetrics();

  el.statusWords.hidden = false;
  el.statusChars.hidden = false;
  el.statusTokens.hidden = false;

  if (sel) {
    if (el.statusSelectionBadge) {
      el.statusSelectionBadge.textContent = sel.label;
      el.statusSelectionBadge.hidden = false;
    }
    el.statusWords.textContent = `${sel.words.toLocaleString()} / ${tot.words.toLocaleString()} words`;
    el.statusChars.textContent = `${sel.chars.toLocaleString()} / ${tot.chars.toLocaleString()} chars`;
    el.statusTokens.textContent = `~${sel.tokens.toLocaleString()} / ~${tot.tokens.toLocaleString()} tokens`;
    el.statusTokens.title = `Selected ~${sel.tokens.toLocaleString()} tokens · Full note ~${tot.tokens.toLocaleString()} tokens`;
  } else {
    if (el.statusSelectionBadge) el.statusSelectionBadge.hidden = true;
    el.statusWords.textContent = `${tot.words.toLocaleString()} words`;
    el.statusChars.textContent = `${tot.chars.toLocaleString()} chars`;
    el.statusTokens.textContent = `~${tot.tokens.toLocaleString()} tokens`;
    const blockNote = typeof tot.blockCount === "number" ? ` across ${tot.blockCount} blocks` : "";
    el.statusTokens.title = `Estimated LLM input tokens (~${tot.tokens.toLocaleString()}${blockNote})`;
  }

  if (el.statusReadtime) {
    if (tot.words > 0) {
      el.statusReadtime.textContent = `${tot.readMins} min read`;
      el.statusReadtime.hidden = false;
    } else {
      el.statusReadtime.hidden = true;
    }
  }
}

function scheduleStatusMetricsUpdate(delayMs = 120) {
  clearTimeout(state.statusMetricsTimer);
  state.statusMetricsTimer = setTimeout(() => {
    state.statusMetricsTimer = null;
    updateStatusBarMetrics();
  }, delayMs);
}

function scheduleStatusSelectionUpdate(delayMs = 60) {
  clearTimeout(state.statusSelectionTimer);
  state.statusSelectionTimer = setTimeout(() => {
    state.statusSelectionTimer = null;
    updateStatusBarMetrics();
  }, delayMs);
}

function renderBreadcrumb(folderRel = "", fileRel = null) {
  if (!el.breadcrumb) return;
  if (!state.vault) {
    el.breadcrumb.textContent = "Skillweaver";
    return;
  }

  const rootName = state.vault.root_name || "Vault";
  const parts = folderRel ? folderRel.split("/").filter(Boolean) : [];
  const frag = document.createDocumentFragment();

  const addSep = () => {
    const sep = document.createElement("span");
    sep.className = "breadcrumb-sep";
    sep.textContent = "/";
    frag.appendChild(sep);
  };

  if (parts.length === 0 && !fileRel) {
    const rootBtn = document.createElement("button");
    rootBtn.type = "button";
    rootBtn.className = "breadcrumb-link breadcrumb-current";
    rootBtn.textContent = rootName;
    rootBtn.title = "Open Root Folder Explorer";
    rootBtn.addEventListener("click", () => openFolderView(""));
    frag.appendChild(rootBtn);
  } else {
    const rootBtn = document.createElement("button");
    rootBtn.type = "button";
    rootBtn.className = "breadcrumb-link";
    rootBtn.textContent = rootName;
    rootBtn.title = "Open Root Folder Explorer";
    rootBtn.addEventListener("click", () => openFolderView(""));
    frag.appendChild(rootBtn);
  }

  for (let i = 0; i < parts.length; i++) {
    addSep();
    const prefix = parts.slice(0, i + 1).join("/");
    const isLastFolder = i === parts.length - 1 && !fileRel;
    if (isLastFolder) {
      const span = document.createElement("span");
      span.className = "breadcrumb-current";
      span.textContent = parts[i];
      frag.appendChild(span);
    } else {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "breadcrumb-link";
      btn.textContent = parts[i];
      btn.title = `Open Folder "${prefix}"`;
      btn.addEventListener("click", () => openFolderView(prefix));
      frag.appendChild(btn);
    }
  }

  if (fileRel) {
    addSep();
    const leaf = fileRel.split("/").pop() || fileRel;
    const span = document.createElement("span");
    span.className = "breadcrumb-current";
    span.textContent = leaf;
    frag.appendChild(span);
  }

  el.breadcrumb.innerHTML = "";
  el.breadcrumb.appendChild(frag);
}

function updateViewVisibility() {
  const hasVault = Boolean(state.vault);
  const hasFile = Boolean(state.currentFile);
  const showFullGraph = isGraphFullscreen() && hasVault;
  const showSideGraph = isGraphSide() && hasVault;
  const showFolder = state.currentFolderView !== null && hasVault && !showFullGraph;

  el.btnToggleFold.hidden = !hasFile || state.rawMode || showFullGraph || showFolder;
  if (!el.btnToggleFold.hidden) {
    syncFoldButton();
  }
  el.btnToggleRaw.hidden = !hasFile || showFullGraph || showFolder;
  el.btnToggleRaw.classList.toggle("active", state.rawMode);
  el.btnToggleGraph.classList.toggle("active", showFullGraph || showSideGraph);

  const bar = document.getElementById("block-selection-bar");
  if (!hasFile || state.rawMode || showFullGraph || showFolder) {
    if (bar) bar.hidden = true;
    if (!hasFile) aiPanel.syncLiveSelection([]);
  } else {
    editor.updateBlockSelectionBar();
  }

  if (showFullGraph) {
    if (el.graphResizer) el.graphResizer.hidden = true;
    if (el.graphSideHost) el.graphSideHost.hidden = true;
    if (el.appEl && el.graphView.parentElement !== el.appEl) {
      el.appEl.appendChild(el.graphView);
    }
    el.graphView.hidden = false;
    graphView.setDisplayMode("fullscreen");
    graphView.setVisible(true);
  } else if (showSideGraph) {
    if (aiPanel.isOpen()) {
      aiPanel.close();
    }
    if (el.graphSideHost && el.graphView.parentElement !== el.graphSideHost) {
      el.graphSideHost.appendChild(el.graphView);
    }
    if (el.graphResizer) el.graphResizer.hidden = false;
    if (el.graphSideHost) el.graphSideHost.hidden = false;
    el.graphView.hidden = false;
    graphView.setDisplayMode("side");
    graphView.setVisible(true);
  } else {
    if (el.graphResizer) el.graphResizer.hidden = true;
    if (el.graphSideHost) el.graphSideHost.hidden = true;
    el.graphView.hidden = true;
    graphView.setVisible(false);
  }

  if (showFolder) {
    el.conflictBanner.hidden = true;
    el.welcomeView.hidden = true;
    el.folderView.hidden = false;
    el.editorStage.hidden = true;
    el.rawEditorView.hidden = true;
    docOutline.setVisible(false);
    renderBreadcrumb(state.currentFolderView, null);
    setSaveStatus("saved");
    updateStatusBarMetrics();
    return;
  }

  el.folderView.hidden = true;

  if (!hasFile) {
    el.conflictBanner.hidden = true;
    el.welcomeView.hidden = false;
    el.editorStage.hidden = true;
    el.rawEditorView.hidden = true;
    docOutline.setVisible(false);
    el.btnWelcomeNew.hidden = !hasVault;
    el.welcomeSubtitle.innerHTML = hasVault
      ? `Folder <strong>${escapeHtml(state.vault.root_name)}</strong> is open. Select a <code>.md</code> file or create a new note.`
      : `Lightweight block-based editor over plain <code>.md</code> folders.`;
    renderBreadcrumb("", null);
    setSaveStatus("saved");
    updateStatusBarMetrics();
    return;
  }

  el.conflictBanner.hidden = !state.externalConflict || showFullGraph;
  el.welcomeView.hidden = true;
  el.editorStage.hidden = state.rawMode;
  el.rawEditorView.hidden = !state.rawMode;
  docOutline.setVisible(!state.rawMode && !showFullGraph);
  const slashIdx = state.currentFile.lastIndexOf("/");
  const noteFolder = slashIdx === -1 ? "" : state.currentFile.slice(0, slashIdx);
  renderBreadcrumb(noteFolder, state.currentFile);
  updateStatusBarMetrics();
}

function renderBacklinks(backlinks = []) {
  if (!backlinks || backlinks.length === 0) {
    el.backlinksSection.hidden = true;
    el.backlinksList.innerHTML = "";
    return;
  }

  el.backlinksSection.hidden = false;
  el.backlinksCount.textContent = String(backlinks.length);
  el.backlinksList.innerHTML = backlinks
    .map(
      (bl) => `
        <button class="backlink-item" data-rel="${escapeHtml(bl.source_rel_path)}">
          <span class="backlink-title">${escapeHtml(bl.source_title)}</span>
          <span class="backlink-snippet">${escapeHtml(bl.snippet || bl.source_rel_path)}</span>
        </button>
      `
    )
    .join("");

  el.backlinksList.querySelectorAll(".backlink-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      openNote(btn.dataset.rel);
    });
  });
}

async function loadBacklinksAsync(relPath) {
  const seq = ++state.backlinksRequestSeq;
  try {
    const backlinks = await invoke("get_backlinks", { relPath });
    if (seq !== state.backlinksRequestSeq || state.currentFile !== relPath) {
      return;
    }
    renderBacklinks(backlinks || []);
  } catch {
    if (seq === state.backlinksRequestSeq && state.currentFile === relPath) {
      renderBacklinks([]);
    }
  }
}

function applyOpenedNotePayload(payload) {
  clearConflictBanner();
  state.currentFolderView = null;
  state.currentFile = payload.rel_path;
  state.prefs.last_file = payload.rel_path;
  if (isGraphFullscreen()) {
    state.graphDisplayMode = "side";
  }
  state.isDirty = false;
  state.lastKnownDiskHash = payload.disk_hash || null;
  state.lastKnownMtimeMs = payload.mtime_ms ?? null;
  state.lastKnownDiskMd = payload.raw_md ?? "";

  el.docTitle.textContent = payload.title;
  el.docPathHint.textContent = payload.rel_path;
  el.rawTextarea.value = payload.raw_md;

  const collapsedIndices = state.prefs.collapsed_headings[foldKey(payload.rel_path)] || [];
  editor.loadDocument(payload.blocks, collapsedIndices);
  renderBacklinks(payload.backlinks || []);
  sidebar.setActiveFile(payload.rel_path);
  setSaveStatus("saved");
  updateViewVisibility();
  loadBacklinksAsync(payload.rel_path);
  if (isGraphOpen()) {
    graphView.handleActiveFileChanged(payload.rel_path);
  }
}

async function refreshCurrentFolderView() {
  if (!state.vault || state.currentFolderView === null) return;
  try {
    const overview = await invoke("get_folder_overview", {
      folderRel: state.currentFolderView,
    });
    if (state.currentFolderView === null) return;
    folderView.setOverview(overview);
    updateStatusBarMetrics();
  } catch {
    state.currentFolderView = null;
    sidebar.setActiveFolder(null);
    updateViewVisibility();
  }
}

async function openFolderView(folderRel = "") {
  if (!state.vault) return;
  if (state.currentFile) {
    if (state.externalConflict) {
      showToast("Resolve the disk conflict before switching folders", true);
      return;
    }
    const saved = await flushSave();
    if (!saved) return;
  }

  const normalized = String(folderRel ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  try {
    const overview = await invoke("get_folder_overview", { folderRel: normalized });
    clearConflictBanner();
    state.currentFile = null;
    if (isGraphFullscreen()) {
      state.graphDisplayMode = "side";
    }
    state.isDirty = false;
    state.lastKnownDiskHash = null;
    state.lastKnownMtimeMs = null;
    state.lastKnownDiskMd = null;
    state.currentFolderView = overview.folder_rel;

    folderView.setOverview(overview);
    sidebar.setActiveFolder(overview.folder_rel);
    updateViewVisibility();
    if (isGraphOpen()) {
      graphView.handleActiveFileChanged(null);
    }
  } catch (err) {
    showToast(`Failed to open folder view: ${err}`, true);
  }
}

async function applyVaultSnapshot(snapshot, openInitial = true, preloadedInitialNote = null) {
  state.vault = snapshot;
  if (!snapshot) {
    state.currentFile = null;
    state.currentFolderView = null;
    state.prefs.last_folder = null;
    el.vaultName.textContent = "No Folder";
    sidebar.setTree([], null);
    sidebar.setActiveFolder(null);
    updateGitBranchUi(null);
    updateViewVisibility();
    return;
  }

  state.prefs.last_folder = snapshot.root_path;
  el.vaultName.textContent = snapshot.root_name;
  el.vaultName.parentElement.title = snapshot.root_path;
  updateGitBranchUi(snapshot.git_branch || null);
  sidebar.setTree(snapshot.tree, state.currentFile);

  if (openInitial && snapshot.initial_file) {
    if (
      preloadedInitialNote &&
      preloadedInitialNote.rel_path === snapshot.initial_file
    ) {
      applyOpenedNotePayload(preloadedInitialNote);
    } else {
      await openNote(snapshot.initial_file);
    }
  } else if (state.currentFolderView !== null && !state.currentFile && !isGraphFullscreen()) {
    await refreshCurrentFolderView();
    updateViewVisibility();
  } else if (!state.currentFile || isGraphOpen()) {
    updateViewVisibility();
  } else {
    editor.refreshLinkStyles();
  }

  if (openInitial && snapshot.root_path) {
    terminal.syncCwd(snapshot.root_path);
  }

  if (aiPanel.isOpen() || aiPanel.prefsLoaded) {
    aiPanel.refreshSkills();
    aiPanel.refreshHistoryView();
  }
}

async function openNote(relPath) {
  if (!relPath) return;
  if (state.currentFile === relPath && state.externalConflict) {
    showToast("Resolve the disk conflict first", true);
    return;
  }
  if (state.currentFile && state.currentFile !== relPath) {
    if (state.externalConflict) {
      showToast("Resolve the disk conflict before switching notes", true);
      return;
    }
    const saved = await flushSave();
    if (!saved) return;
  }

  try {
    const payload = await invoke("open_note", { relPath });
    applyOpenedNotePayload(payload);
  } catch (err) {
    showToast(`Failed to open note: ${err}`, true);
  }
}

async function handleOpenFolder() {
  if (state.externalConflict) {
    showToast("Resolve the disk conflict before opening another folder", true);
    return;
  }
  const saved = await flushSave();
  if (!saved) return;
  try {
    const snapshot = await invoke("pick_folder");
    if (snapshot) {
      clearConflictBanner();
      imageCache.clear();
      state.currentFile = null;
      state.currentFolderView = null;
      sidebar.setActiveFolder(null);
      state.lastKnownDiskHash = null;
      state.lastKnownMtimeMs = null;
      state.lastKnownDiskMd = null;
      state.rawMode = false;
      state.graphDisplayMode = "closed";
      graphView.clearData();
      state.prefs.last_folder = snapshot.root_path;
      state.prefs.last_file = snapshot.initial_file || null;
      await applyVaultSnapshot(snapshot, true);
    }
  } catch (err) {
    showToast(`Failed to open folder: ${err}`, true);
  }
}

async function handleRefreshVault() {
  if (!state.vault) return;
  try {
    const snapshot = await invoke("refresh_vault");
    await applyVaultSnapshot(snapshot, false);
    if (state.currentFile) {
      await checkActiveNoteExternalChange();
    }
  } catch (err) {
    showToast(`Refresh failed: ${err}`, true);
  }
}

async function promptCreateNote(folderRel = "", templateFileName = null) {
  if (!state.vault) {
    showToast("Open a folder first", true);
    return;
  }
  if (state.externalConflict) {
    showToast("Resolve the disk conflict first", true);
    return;
  }
  const prefix = folderRel ? `${folderRel}/` : "";
  const tplLabel = templateFileName
    ? ` using template "${templateFileName.replace(/\.md$/i, "")}"`
    : "";
  const input = await modal.prompt({
    title: "New Markdown Note",
    description: `${folderRel ? `Create inside "${folderRel}"` : "Create in folder root"}${tplLabel}`,
    defaultValue: "",
    placeholder: "e.g. meeting-notes",
    confirmLabel: "Create",
  });
  if (!input || !input.trim()) return;

  const clean = input.trim().replace(/^[\\/]+/, "");
  const relPath = clean.includes("/") || !prefix ? clean : `${prefix}${clean}`;

  try {
    const saved = await flushSave();
    if (!saved) return;
    const res =
      !clean.includes("/")
        ? await invoke("create_note_from_template", {
            folderRel: folderRel || "",
            noteName: clean,
            templateFileName: templateFileName || null,
          })
        : await invoke("create_note", { relPath });
    state.currentFolderView = null;
    await applyVaultSnapshot(res.vault, false);
    await openNote(res.rel_path);
    editor.focusBottomOrCreate();
  } catch (err) {
    showToast(`Could not create note: ${err}`, true);
  }
}

async function createPageFromAutocomplete(name) {
  if (!state.vault) return null;
  const clean = name.trim().replace(/^[\\/]+/, "");
  if (!clean) return null;
  try {
    const res = await invoke("create_note", { relPath: clean });
    await applyVaultSnapshot(res.vault, false);
    return res.rel_path;
  } catch (err) {
    showToast(`Could not create page: ${err}`, true);
    return null;
  }
}

async function promptCreateFolder(parentRel = "") {
  if (!state.vault) {
    showToast("Open a folder first", true);
    return;
  }
  const input = await modal.prompt({
    title: "New Folder",
    description: parentRel ? `Create inside "${parentRel}"` : "Create in folder root",
    defaultValue: "",
    placeholder: "e.g. projects",
    confirmLabel: "Create",
  });
  if (!input || !input.trim()) return;

  const clean = input.trim().replace(/^[\\/]+/, "");
  const relPath = parentRel && !clean.includes("/") ? `${parentRel}/${clean}` : clean;

  try {
    const snap = await invoke("create_folder", { relPath });
    await applyVaultSnapshot(snap, false);
    if (state.currentFolderView !== null) {
      await refreshCurrentFolderView();
    }
  } catch (err) {
    showToast(`Could not create folder: ${err}`, true);
  }
}

async function promptRenameEntry(node) {
  if (state.externalConflict) {
    showToast("Resolve the disk conflict before renaming", true);
    return;
  }
  const isDir = node.is_dir;
  const normalizedRel = node.rel_path.replace(/\\/g, "/");
  const lastSlash = normalizedRel.lastIndexOf("/");
  const parentDir = lastSlash >= 0 ? normalizedRel.slice(0, lastSlash) : "";
  const baseSegment = lastSlash >= 0 ? normalizedRel.slice(lastSlash + 1) : normalizedRel;
  const currentName = isDir ? baseSegment : baseSegment.replace(/\.md$/i, "");
  const input = await modal.prompt({
    title: isDir ? "Rename Folder" : "Rename Note",
    description: "Links across other markdown files update automatically.",
    defaultValue: currentName,
    confirmLabel: "Rename",
  });
  const trimmed = (input || "").trim();
  if (!trimmed) return;
  const nextName = isDir ? trimmed : trimmed.replace(/\.md$/i, "").trim();
  if (!nextName || nextName === currentName) return;
  if (/[\\/]/.test(nextName)) {
    showToast("Name cannot contain / or \\ — drag in the sidebar to move between folders", true);
    return;
  }
  const newRel = parentDir ? `${parentDir}/${nextName}` : nextName;

  try {
    const saved = await flushSave();
    if (!saved) return;
    const oldFoldKey = foldKey(node.rel_path);
    const res = await invoke("rename_entry", {
      oldRel: node.rel_path,
      newRel,
    });

    if (state.prefs.collapsed_headings[oldFoldKey]) {
      state.prefs.collapsed_headings[foldKey(res.new_rel)] =
        state.prefs.collapsed_headings[oldFoldKey];
      delete state.prefs.collapsed_headings[oldFoldKey];
      persistPrefs();
    }

    if (isDir && state.currentFolderView !== null) {
      if (state.currentFolderView === normalizedRel) {
        state.currentFolderView = res.new_rel;
      } else if (state.currentFolderView.startsWith(`${normalizedRel}/`)) {
        state.currentFolderView = `${res.new_rel}${state.currentFolderView.slice(normalizedRel.length)}`;
      }
      sidebar.setActiveFolder(state.currentFolderView);
    }

    const wasCurrent = state.currentFile === node.rel_path;
    const childPrefix = isDir ? `${normalizedRel}/` : null;
    const renamedActiveChild =
      childPrefix && state.currentFile && state.currentFile.startsWith(childPrefix)
        ? `${res.new_rel}${state.currentFile.slice(normalizedRel.length)}`
        : null;
    await applyVaultSnapshot(res.vault, false);
    if (wasCurrent) {
      await openNote(res.new_rel);
    } else if (renamedActiveChild) {
      await openNote(renamedActiveChild);
    } else if (state.currentFile) {
      await openNote(state.currentFile);
    }
  } catch (err) {
    showToast(`Rename failed: ${err}`, true);
  }
}

async function handleMoveEntry(node, targetFolder) {
  if (state.externalConflict) {
    showToast("Resolve the disk conflict before moving entries", true);
    return;
  }
  const baseName = node.name;
  const newRel = targetFolder ? `${targetFolder}/${baseName}` : baseName;
  if (newRel === node.rel_path) return;

  try {
    const saved = await flushSave();
    if (!saved) return;
    const res = await invoke("rename_entry", {
      oldRel: node.rel_path,
      newRel,
    });

    // Migrate persisted collapsed header indices for moved file or files inside moved folder
    let prefsChanged = false;
    if (!node.is_dir) {
      const oldKey = foldKey(node.rel_path);
      if (state.prefs.collapsed_headings[oldKey]) {
        state.prefs.collapsed_headings[foldKey(res.new_rel)] =
          state.prefs.collapsed_headings[oldKey];
        delete state.prefs.collapsed_headings[oldKey];
        prefsChanged = true;
      }
    } else {
      const oldPrefix = `${state.vault?.root_path || ""}::${node.rel_path}/`;
      const newPrefix = `${state.vault?.root_path || ""}::${res.new_rel}/`;
      for (const k of Object.keys(state.prefs.collapsed_headings)) {
        if (k.startsWith(oldPrefix)) {
          const rest = k.slice(oldPrefix.length);
          state.prefs.collapsed_headings[`${newPrefix}${rest}`] =
            state.prefs.collapsed_headings[k];
          delete state.prefs.collapsed_headings[k];
          prefsChanged = true;
        }
      }
    }
    if (prefsChanged) persistPrefs();

    if (node.is_dir && state.currentFolderView !== null) {
      if (state.currentFolderView === node.rel_path) {
        state.currentFolderView = res.new_rel;
      } else if (state.currentFolderView.startsWith(`${node.rel_path}/`)) {
        state.currentFolderView = `${res.new_rel}/${state.currentFolderView.slice(node.rel_path.length + 1)}`;
      }
      sidebar.setActiveFolder(state.currentFolderView);
    }

    let nextCurrent = state.currentFile;
    if (state.currentFile === node.rel_path) {
      nextCurrent = res.new_rel;
    } else if (node.is_dir && state.currentFile?.startsWith(`${node.rel_path}/`)) {
      nextCurrent = `${res.new_rel}/${state.currentFile.slice(node.rel_path.length + 1)}`;
    }

    await applyVaultSnapshot(res.vault, false);
    if (nextCurrent) {
      await openNote(nextCurrent);
    }
    showToast(`Moved to "${targetFolder || "root"}"`);
  } catch (err) {
    showToast(`Move failed: ${err}`, true);
  }
}

async function promptDeleteEntry(node) {
  const confirmed = await modal.confirm({
    title: `Delete ${node.is_dir ? "Folder" : "Note"}?`,
    description: `This permanently deletes "${node.rel_path}" from disk.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!confirmed) return;

  try {
    const snap = await invoke("delete_entry", { relPath: node.rel_path });
    const deletingCurrent =
      state.currentFile === node.rel_path ||
      (node.is_dir && state.currentFile?.startsWith(`${node.rel_path}/`));

    if (deletingCurrent) {
      clearConflictBanner();
      state.currentFile = null;
      state.isDirty = false;
      state.lastKnownDiskHash = null;
      state.lastKnownMtimeMs = null;
      state.lastKnownDiskMd = null;
    }

    if (
      node.is_dir &&
      state.currentFolderView !== null &&
      (state.currentFolderView === node.rel_path ||
        state.currentFolderView.startsWith(`${node.rel_path}/`))
    ) {
      state.currentFolderView = null;
      sidebar.setActiveFolder(null);
    }

    await applyVaultSnapshot(snap, false);
    updateViewVisibility();
  } catch (err) {
    showToast(`Delete failed: ${err}`, true);
  }
}

async function copyBlockLink(bid) {
  if (!state.currentFile || !bid) return;
  const pageTarget = state.currentFile.replace(/\.md$/i, "");
  const wikilink = `[[${pageTarget}#^${bid}]]`;
  try {
    await navigator.clipboard.writeText(wikilink);
    state.isDirty = true;
    await flushSave();
    showToast(`Copied block link ${wikilink}`);
  } catch {
    showToast(`Block link: ${wikilink}`);
  }
}

async function handleOpenLink(target) {
  if (!state.vault) return;
  const hashIdx = target.indexOf("#");
  const pagePart = hashIdx === -1 ? target.trim() : target.slice(0, hashIdx).trim();
  const anchorPart = hashIdx === -1 ? "" : target.slice(hashIdx + 1).trim();

  if (!pagePart && anchorPart && state.currentFile) {
    editor.scrollToAnchor(anchorPart);
    return;
  }

  try {
    const resolved = await invoke("resolve_link", {
      currentRel: state.currentFile,
      target: pagePart || target,
    });
    if (resolved) {
      await openNote(resolved);
      if (anchorPart) {
        editor.scrollToAnchor(anchorPart);
      }
      return;
    }

    const cleanTarget = pagePart || target.split("#")[0].trim();
    const confirmed = await modal.confirm({
      title: "Create Linked Page?",
      description: `"${cleanTarget}.md" does not exist yet in this folder. Create and open it?`,
      confirmLabel: "Create Note",
      danger: false,
    });
    if (!confirmed) return;

    if (state.externalConflict) {
      showToast("Resolve the disk conflict before creating a linked note", true);
      return;
    }
    const saved = await flushSave();
    if (!saved) return;
    const res = await invoke("create_note", { relPath: cleanTarget });
    await applyVaultSnapshot(res.vault, false);
    await openNote(res.rel_path);
    editor.focusBottomOrCreate();
  } catch (err) {
    showToast(`Failed to open link: ${err}`, true);
  }
}

async function toggleRawMode() {
  if (!state.currentFile) return;

  if (!state.rawMode) {
    const blocks = editor.getBlocks();
    const rawMd = await invoke("serialize_blocks_to_md", { blocks });
    el.rawTextarea.value = rawMd;
    state.rawMode = true;
    updateViewVisibility();
    el.rawTextarea.focus();
  } else {
    const rawMd = el.rawTextarea.value;
    const blocks = await invoke("parse_raw_markdown", { rawMd });
    const collapsedIndices = state.prefs.collapsed_headings[foldKey(state.currentFile)] || [];
    editor.loadDocument(blocks, collapsedIndices);
    state.rawMode = false;
    updateViewVisibility();
    if (state.isDirty) {
      await flushSave();
    }
  }
}

function toggleSidebar() {
  state.prefs.sidebar_collapsed = !state.prefs.sidebar_collapsed;
  sidebar.setCollapsed(state.prefs.sidebar_collapsed);
  persistPrefs();
}

function initGraphResizer() {
  if (!el.graphResizer || !el.graphSideHost) return;
  let dragging = false;
  let startX = 0;
  let startWidth = 340;

  el.graphResizer.addEventListener("mousedown", (e) => {
    if (!isGraphSide()) return;
    dragging = true;
    startX = e.clientX;
    startWidth = el.graphSideHost.getBoundingClientRect().width;
    el.graphResizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const next = Math.min(560, Math.max(260, Math.round(startWidth - (e.clientX - startX))));
    el.graphSideHost.style.width = `${next}px`;
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    el.graphResizer.classList.remove("dragging");
    document.body.style.cursor = "";
    const width = Math.round(el.graphSideHost.getBoundingClientRect().width);
    setRightDrawerWidth(width);
    state.prefs.ai_panel_width = width;
    persistPrefs();
  });
}

async function setGraphDisplayMode(mode) {
  if (!state.vault && mode !== "closed") {
    showToast("Open a folder first", false);
    return;
  }
  if (mode !== "closed" && !isGraphOpen()) {
    if (state.externalConflict) {
      showToast("Resolve the disk conflict first", true);
      return;
    }
    const saved = await flushSave();
    if (!saved) return;
  }
  if (mode === "side" && aiPanel.isOpen()) {
    aiPanel.close();
  }
  state.graphDisplayMode = mode;
  updateViewVisibility();
}

async function toggleGraphMode() {
  if (!state.vault) {
    showToast("Open a folder first", false);
    return;
  }
  if (isGraphOpen()) {
    await setGraphDisplayMode("closed");
  } else {
    await setGraphDisplayMode("side");
  }
}

initGraphResizer();

/* Wire UI Controls */
el.btnConflictDiff.addEventListener("click", openConflictDiff);
el.btnConflictKeep.addEventListener("click", resolveConflictKeepMine);
el.btnConflictReload.addEventListener("click", resolveConflictReload);
el.btnVaultName.addEventListener("click", handleOpenFolder);
el.btnOpenFolder.addEventListener("click", handleOpenFolder);
el.btnWelcomeOpen.addEventListener("click", handleOpenFolder);
el.btnNewNote.addEventListener("click", () => promptCreateNote(""));
el.btnWelcomeNew.addEventListener("click", () => promptCreateNote(""));
el.btnNewFolder.addEventListener("click", () => promptCreateFolder(""));
el.btnRefreshVault.addEventListener("click", handleRefreshVault);
el.btnQuickOpen.addEventListener("click", () => {
  if (state.vault) quickSwitcher.open();
});
el.btnToggleSidebar.addEventListener("click", toggleSidebar);
el.btnToggleFold.addEventListener("click", () => editor.toggleCollapseAll());
el.btnToggleRaw.addEventListener("click", toggleRawMode);
el.btnToggleGraph.addEventListener("click", toggleGraphMode);
el.btnToggleTerminal.addEventListener("click", () => terminal.toggle());
el.btnToggleAi.addEventListener("click", () => aiPanel.toggle());
el.btnToggleTheme.addEventListener("click", () => {
  applyTheme(state.prefs.theme === "dark" ? "light" : "dark");
  persistPrefs();
});

el.docTitle.addEventListener("dblclick", () => {
  if (!state.currentFile) return;
  promptRenameEntry({ rel_path: state.currentFile, is_dir: false });
});

el.bottomClickZone.addEventListener("click", () => {
  if (editor.consumeSuppressedBottomClick()) return;
  if (state.currentFile && !state.rawMode) {
    editor.focusBottomOrCreate();
  }
});

el.backlinksToggle.addEventListener("click", () => {
  const expanded = el.backlinksToggle.getAttribute("aria-expanded") === "true";
  el.backlinksToggle.setAttribute("aria-expanded", String(!expanded));
  el.backlinksList.hidden = expanded;
});

el.rawTextarea.addEventListener("input", () => {
  scheduleAutoSave();
  scheduleStatusMetricsUpdate();
});
el.rawTextarea.addEventListener("select", () => scheduleStatusSelectionUpdate(40));
el.rawTextarea.addEventListener("keyup", () => scheduleStatusSelectionUpdate(60));
el.rawTextarea.addEventListener("mouseup", () => scheduleStatusSelectionUpdate(60));

el.statusGitBranch?.addEventListener("click", () => terminal.toggle());
el.statusModeBtn?.addEventListener("click", () => {
  if (isGraphFullscreen()) {
    setGraphDisplayMode("side");
  } else if (state.currentFile) {
    toggleRawMode();
  }
});

document.addEventListener("selectionchange", () => {
  if (state.currentFile && !state.rawMode && !isGraphFullscreen()) {
    scheduleStatusSelectionUpdate(60);
  }
});

/* Window Zoom Shortcuts (VS Code-style, capture phase so they work everywhere) */
window.addEventListener(
  "keydown",
  (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;

    const isZoomIn =
      e.code === "Equal" ||
      e.code === "NumpadAdd" ||
      e.key === "+" ||
      e.key === "=";
    const isZoomOut =
      e.code === "Minus" ||
      e.code === "NumpadSubtract" ||
      e.key === "-" ||
      e.key === "_";
    const isZoomReset =
      !e.shiftKey &&
      (e.code === "Digit0" || e.code === "Numpad0" || e.key === "0");

    if (isZoomIn) {
      e.preventDefault();
      stepZoom(ZOOM_STEP_PERCENT);
    } else if (isZoomOut) {
      e.preventDefault();
      stepZoom(-ZOOM_STEP_PERCENT);
    } else if (isZoomReset) {
      e.preventDefault();
      resetZoom();
    }
  },
  true
);

/* Global Keyboard Shortcuts */
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "l") {
    const focused = editor.getFocusedBlock();
    if (focused) {
      e.preventDefault();
      const bid = editor.ensureBlockId(focused.idx);
      if (bid) copyBlockLink(bid);
    }
    return;
  }

  if (e.key === "Escape" && diffModal.isOpen()) {
    e.preventDefault();
    diffModal.close();
    return;
  }

  if (e.key === "Escape" && isGraphFullscreen() && !quickSwitcher.isOpen()) {
    const modalEl = document.getElementById("input-modal");
    if (!modalEl || modalEl.hidden) {
      e.preventDefault();
      if (!graphView.handleEscape()) {
        setGraphDisplayMode("side");
      }
      return;
    }
  }

  const activeEl = document.activeElement;
  const isTypingField =
    activeEl?.tagName === "INPUT" ||
    activeEl?.tagName === "TEXTAREA" ||
    activeEl?.isContentEditable;
  const modalHidden = document.getElementById("input-modal")?.hidden !== false;

  if (
    !state.rawMode &&
    !isGraphFullscreen() &&
    state.currentFile &&
    modalHidden &&
    !quickSwitcher.isOpen() &&
    !isTypingField &&
    editor.hasBlockSelection()
  ) {
    if (e.key === "Escape") {
      e.preventDefault();
      editor.clearBlockSelection();
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      editor.deleteSelectedBlocks();
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      editor.outdentSelectedBlocks(e.shiftKey ? 1 : -1);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "c") {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) {
        e.preventDefault();
        const blocks = editor.getSelectedBlocks().map((x) => x.block);
        invoke("serialize_blocks_to_md", { blocks })
          .then((md) => navigator.clipboard.writeText(md))
          .then(() => showToast(`Copied ${blocks.length} block${blocks.length === 1 ? "" : "s"}`))
          .catch((err) => showToast(`Copy failed: ${err}`, true));
        return;
      }
    }
  }

  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;

  const key = e.key.toLowerCase();

  if (e.code === "Backquote" || e.key === "`" || e.key === "~") {
    e.preventDefault();
    terminal.toggle();
  } else if (key === "g" && e.shiftKey) {
    e.preventDefault();
    if (!state.vault) {
      showToast("Open a folder first", false);
      return;
    }
    setGraphDisplayMode(isGraphFullscreen() ? "closed" : "fullscreen");
  } else if (key === "g" && !e.shiftKey) {
    e.preventDefault();
    toggleGraphMode();
  } else if (key === "j" && !e.shiftKey) {
    e.preventDefault();
    if (editor.hasBlockSelection() && !state.rawMode && !isGraphFullscreen()) {
      aiPanel.focusOnHighlightedBlocks(editor.getSelectedBlocksForAi());
      return;
    }
    const selCtx = editor.getSelectedTextContext();
    if (selCtx) {
      aiPanel.attachSelection(selCtx);
    } else {
      const focused = editor.getFocusedBlock();
      if (focused) {
        aiPanel.attachBlock(focused.block);
      } else {
        aiPanel.toggle();
      }
    }
  } else if (key === "a" && e.shiftKey) {
    e.preventDefault();
    aiPanel.toggle();
  } else if (key === "h" && e.shiftKey && !state.rawMode && !isGraphFullscreen() && state.currentFile) {
    if (editor.applyLastUsedColor()) {
      e.preventDefault();
    }
  } else if (key === "d" && !e.shiftKey && !state.rawMode) {
    if (editor.hasBlockSelection()) {
      e.preventDefault();
      editor.duplicateSelectedBlocks();
      return;
    }
    const focused = editor.getFocusedBlock();
    if (focused) {
      e.preventDefault();
      editor.duplicateBlock(focused.idx);
    }
  } else if (key === "o" && e.shiftKey) {
    e.preventDefault();
    if (state.currentFile && !state.rawMode && !isGraphFullscreen()) {
      docOutline.toggle();
    }
  } else if (key === "o" && !e.shiftKey) {
    e.preventDefault();
    handleOpenFolder();
  } else if (key === "n" && !e.shiftKey) {
    e.preventDefault();
    promptCreateNote("");
  } else if (key === "s" && !e.shiftKey) {
    e.preventDefault();
    if (state.externalConflict) {
      showToast("Resolve the disk conflict banner to save", true);
      return;
    }
    state.isDirty = true;
    flushSave();
  } else if ((key === "p" || key === "k") && !e.shiftKey) {
    e.preventDefault();
    if (state.vault) quickSwitcher.open();
  } else if (e.key === "\\" && !e.shiftKey) {
    e.preventDefault();
    toggleSidebar();
  } else if (key === "m" && e.shiftKey) {
    e.preventDefault();
    toggleRawMode();
  } else if (e.key === "[" && e.shiftKey) {
    e.preventDefault();
    if (state.currentFile && !state.rawMode) editor.collapseAll();
  } else if (e.key === "]" && e.shiftKey) {
    e.preventDefault();
    if (state.currentFile && !state.rawMode) editor.expandAll();
  } else if (key === "z" && !state.rawMode && !quickSwitcher.isOpen()) {
    const activeTag = document.activeElement?.tagName;
    if (activeTag === "INPUT" || activeTag === "TEXTAREA" || document.activeElement?.closest?.(".ai-panel")) return;
    if (e.shiftKey) {
      if (editor.redo()) e.preventDefault();
    } else if (editor.undo()) {
      e.preventDefault();
    }
  } else if (key === "y" && !e.shiftKey && !state.rawMode && !quickSwitcher.isOpen()) {
    const activeTag = document.activeElement?.tagName;
    if (activeTag === "INPUT" || activeTag === "TEXTAREA" || document.activeElement?.closest?.(".ai-panel")) return;
    if (editor.redo()) e.preventDefault();
  }
});

window.addEventListener("beforeunload", () => {
  if (state.zoomSaveTimer) {
    clearTimeout(state.zoomSaveTimer);
    state.zoomSaveTimer = null;
    persistPrefs();
  }
  flushSave();
});

/* Bootstrap */
async function init() {
  tauriListen("vault:fs-changed", (event) => {
    enqueueFsChangedEvent(event?.payload);
  });

  tauriListen("terminal-prompt", () => {
    if (state.vault) {
      refreshGitBranch();
    }
  });

  window.addEventListener("focus", () => {
    if (state.vault && state.currentFile && !state.fsEventQueueRunning) {
      checkActiveNoteExternalChange();
    }
    if (state.vault) {
      refreshGitBranch();
    }
  });

  try {
    const startup = await invoke("get_startup_state");
    state.prefs = { ...state.prefs, ...(startup.prefs || {}) };
    if (!state.prefs.collapsed_headings) {
      state.prefs.collapsed_headings = {};
    }
    state.prefs.zoom_percent = clampZoomPercent(state.prefs.zoom_percent);
    applyZoom(state.prefs.zoom_percent, { persist: false, toast: false });
    applyTheme(state.prefs.theme);
    sidebar.setWidth(state.prefs.sidebar_width);
    sidebar.setCollapsed(state.prefs.sidebar_collapsed);
    terminal.setHeight(state.prefs.terminal_height);
    setRightDrawerWidth(state.prefs.ai_panel_width);
    await applyVaultSnapshot(startup.vault, true, startup.initial_note || null);
  } catch (err) {
    showToast(`Startup failed: ${err}`, true);
    updateViewVisibility();
  }
}

init();
