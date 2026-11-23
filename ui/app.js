import { AiPanel } from "./ai.js";
import { BlockEditor } from "./editor.js";
import { GraphView } from "./graph.js";
import { escapeHtml } from "./inline.js";
import { QuickSwitcher } from "./links.js";
import { ModalDialog, SidebarController } from "./sidebar.js";
import { TerminalPanel } from "./terminal.js";

function invoke(cmd, args = {}) {
  const tauriInvoke = window.__TAURI__?.core?.invoke;
  if (!tauriInvoke) {
    return Promise.reject(new Error("Tauri runtime API is unavailable"));
  }
  return tauriInvoke(cmd, args);
}

const el = {
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
  editorScroll: document.getElementById("editor-scroll"),
  rawEditorView: document.getElementById("raw-editor-view"),
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
  toast: document.getElementById("toast"),
};

const state = {
  prefs: {
    last_folder: null,
    last_file: null,
    theme: "dark",
    sidebar_width: 240,
    sidebar_collapsed: false,
    terminal_height: 240,
    ai_panel_width: 340,
    collapsed_headings: {},
  },
  vault: null,
  currentFile: null,
  rawMode: false,
  graphMode: false,
  isDirty: false,
  saveTimer: null,
  toastTimer: null,
};

const imageCache = new Map();

function imageCacheKey(src) {
  return `${state.currentFile || ""}::${src}`;
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
  if (!state.currentFile) {
    el.saveStatus.textContent = "";
    el.saveStatus.classList.remove("unsaved");
    return;
  }
  if (mode === "unsaved") {
    el.saveStatus.textContent = "• Unsaved";
    el.saveStatus.classList.add("unsaved");
  } else if (mode === "saving") {
    el.saveStatus.textContent = "Saving...";
    el.saveStatus.classList.remove("unsaved");
  } else {
    el.saveStatus.textContent = "Saved";
    el.saveStatus.classList.remove("unsaved");
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
  if (state.graphMode && typeof graphView !== "undefined") {
    graphView.draw();
  }
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

const editor = new BlockEditor(
  {
    containerEl: el.blocksContainer,
    selectionToolbarEl: document.getElementById("selection-toolbar"),
    boldBtn: document.getElementById("btn-sel-bold"),
    inlineCodeBtn: document.getElementById("btn-sel-code"),
    highlightBtn: document.getElementById("btn-sel-highlight"),
    askAiSelBtn: document.getElementById("btn-sel-ai"),
    linkPopoverEl: document.getElementById("link-popover"),
    slashPopoverEl: document.getElementById("slash-popover"),
    blockMenuEl: document.getElementById("block-menu"),
    blockSelectionBarEl: document.getElementById("block-selection-bar"),
    blockSelectionCountEl: document.getElementById("block-sel-count"),
    blocksAskAiBtn: document.getElementById("btn-blocks-ask-ai"),
    blocksOutdentBtn: document.getElementById("btn-blocks-outdent"),
    blocksDupBtn: document.getElementById("btn-blocks-dup"),
    blocksDelBtn: document.getElementById("btn-blocks-del"),
    blocksClearBtn: document.getElementById("btn-blocks-clear"),
    blockMarqueeEl: document.getElementById("block-marquee"),
  },
  {
    getPages: () => state.vault?.pages || [],
    onDirty: () => scheduleAutoSave(),
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
    onBlockSelectionChange: (blocks) => aiPanel.syncLiveSelection(blocks),
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
    modelBadgeEl: document.getElementById("ai-model-badge"),
    modelPopoverEl: document.getElementById("ai-model-popover"),
    settingsBtn: document.getElementById("ai-btn-settings"),
    clearBtn: document.getElementById("ai-btn-clear"),
    closeBtn: document.getElementById("ai-btn-close"),
    settingsDrawerEl: document.getElementById("ai-settings-drawer"),
    providerSelect: document.getElementById("ai-provider"),
    apiKeyInput: document.getElementById("ai-api-key"),
    toggleKeyVisBtn: document.getElementById("ai-toggle-key"),
    baseUrlInput: document.getElementById("ai-base-url"),
    modelInput: document.getElementById("ai-model"),
    pickModelBtn: document.getElementById("ai-btn-pick-model"),
    fetchModelsBtn: document.getElementById("ai-btn-fetch-models"),
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
      persistPrefs();
    },
    onApplyEdits: (ops) => {
      if (!state.currentFile || state.rawMode) {
        showToast("Switch to a note in block view to apply edits", true);
        return false;
      }
      return editor.applyAiEdits(ops);
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
      }
    },
  }
);

const graphView = new GraphView(
  {
    viewEl: document.getElementById("graph-view"),
    canvasEl: document.getElementById("graph-canvas"),
    filterInputEl: document.getElementById("graph-filter"),
    localToggleBtn: document.getElementById("graph-local-toggle"),
    orphansToggleBtn: document.getElementById("graph-orphans-toggle"),
    refreshBtn: document.getElementById("graph-refresh"),
    statsEl: document.getElementById("graph-stats"),
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
    onToast: (msg, isErr) => showToast(msg, isErr),
  }
);

function scheduleAutoSave() {
  if (!state.currentFile) return;
  state.isDirty = true;
  setSaveStatus("unsaved");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    flushSave();
  }, 900);
}

async function flushSave() {
  clearTimeout(state.saveTimer);
  if (!state.currentFile || !state.isDirty) return;

  const fileToSave = state.currentFile;
  setSaveStatus("saving");

  try {
    if (state.rawMode) {
      const payload = await invoke("save_note_raw", {
        relPath: fileToSave,
        rawMd: el.rawTextarea.value,
      });
      if (state.currentFile === fileToSave) {
        renderBacklinks(payload.backlinks);
      }
    } else {
      const blocks = editor.getBlocks();
      await invoke("save_note_blocks", {
        relPath: fileToSave,
        blocks,
      });
    }
    state.isDirty = false;
    setSaveStatus("saved");
  } catch (err) {
    showToast(`Save failed: ${err}`, true);
    setSaveStatus("unsaved");
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

function updateViewVisibility() {
  const hasVault = Boolean(state.vault);
  const hasFile = Boolean(state.currentFile);
  const showGraph = state.graphMode && hasVault;

  el.btnToggleFold.hidden = !hasFile || state.rawMode || showGraph;
  if (!el.btnToggleFold.hidden) {
    syncFoldButton();
  }
  el.btnToggleRaw.hidden = !hasFile || showGraph;
  el.btnToggleRaw.classList.toggle("active", state.rawMode);
  el.btnToggleGraph.classList.toggle("active", showGraph);

  const bar = document.getElementById("block-selection-bar");
  if (!hasFile || state.rawMode || showGraph) {
    if (bar) bar.hidden = true;
    if (!hasFile) aiPanel.syncLiveSelection([]);
  } else {
    editor.updateBlockSelectionBar();
  }

  if (showGraph) {
    el.welcomeView.hidden = true;
    el.editorScroll.hidden = true;
    el.rawEditorView.hidden = true;
    el.graphView.hidden = false;
    el.breadcrumb.textContent = `${state.vault.root_name} / Graph View`;
    graphView.setVisible(true);
    return;
  }

  el.graphView.hidden = true;
  graphView.setVisible(false);

  if (!hasFile) {
    el.welcomeView.hidden = false;
    el.editorScroll.hidden = true;
    el.rawEditorView.hidden = true;
    el.btnWelcomeNew.hidden = !hasVault;
    el.welcomeSubtitle.innerHTML = hasVault
      ? `Folder <strong>${escapeHtml(state.vault.root_name)}</strong> is open. Select a <code>.md</code> file or create a new note.`
      : `Lightweight Notion-style block editor over plain <code>.md</code> folders.`;
    el.breadcrumb.textContent = hasVault ? state.vault.root_name : "Skillweaver";
    setSaveStatus("saved");
    return;
  }

  el.welcomeView.hidden = true;
  el.editorScroll.hidden = state.rawMode;
  el.rawEditorView.hidden = !state.rawMode;
  el.breadcrumb.textContent = `${state.vault?.root_name || ""} / ${state.currentFile}`;
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

async function applyVaultSnapshot(snapshot, openInitial = true) {
  state.vault = snapshot;
  if (!snapshot) {
    state.currentFile = null;
    state.prefs.last_folder = null;
    el.vaultName.textContent = "No Folder";
    sidebar.setTree([], null);
    updateViewVisibility();
    return;
  }

  state.prefs.last_folder = snapshot.root_path;
  el.vaultName.textContent = snapshot.root_name;
  el.vaultName.parentElement.title = snapshot.root_path;
  sidebar.setTree(snapshot.tree, state.currentFile);

  if (openInitial && snapshot.initial_file) {
    await openNote(snapshot.initial_file);
  } else if (!state.currentFile || state.graphMode) {
    updateViewVisibility();
  } else {
    editor.refreshLinkStyles();
  }

  if (openInitial && snapshot.root_path) {
    terminal.syncCwd(snapshot.root_path);
  }
  aiPanel.refreshHistoryView();
}

async function openNote(relPath) {
  if (!relPath) return;
  if (state.currentFile && state.currentFile !== relPath) {
    await flushSave();
  }

  try {
    const payload = await invoke("open_note", { relPath });
    state.currentFile = payload.rel_path;
    state.prefs.last_file = payload.rel_path;
    state.graphMode = false;
    state.isDirty = false;

    el.docTitle.textContent = payload.title;
    el.docPathHint.textContent = payload.rel_path;
    el.breadcrumb.textContent = `${state.vault?.root_name || ""} / ${payload.rel_path}`;
    el.rawTextarea.value = payload.raw_md;

    const collapsedIndices = state.prefs.collapsed_headings[foldKey(payload.rel_path)] || [];
    editor.loadDocument(payload.blocks, collapsedIndices);
    renderBacklinks(payload.backlinks);
    sidebar.setActiveFile(payload.rel_path);
    setSaveStatus("saved");
    updateViewVisibility();
  } catch (err) {
    showToast(`Failed to open note: ${err}`, true);
  }
}

async function handleOpenFolder() {
  await flushSave();
  try {
    const snapshot = await invoke("pick_folder");
    if (snapshot) {
      imageCache.clear();
      state.currentFile = null;
      state.rawMode = false;
      state.graphMode = false;
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
    if (state.currentFile && !snapshot.pages.some((p) => p.rel_path === state.currentFile)) {
      state.currentFile = null;
      updateViewVisibility();
    }
  } catch (err) {
    showToast(`Refresh failed: ${err}`, true);
  }
}

async function promptCreateNote(folderRel = "") {
  if (!state.vault) {
    showToast("Open a folder first", true);
    return;
  }
  const prefix = folderRel ? `${folderRel}/` : "";
  const input = await modal.prompt({
    title: "New Markdown Note",
    description: folderRel ? `Create inside "${folderRel}"` : "Create in folder root",
    defaultValue: "",
    placeholder: "e.g. meeting-notes",
    confirmLabel: "Create",
  });
  if (!input || !input.trim()) return;

  const clean = input.trim().replace(/^[\\/]+/, "");
  const relPath = clean.includes("/") || !prefix ? clean : `${prefix}${clean}`;

  try {
    await flushSave();
    const res = await invoke("create_note", { relPath });
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
  } catch (err) {
    showToast(`Could not create folder: ${err}`, true);
  }
}

async function promptRenameEntry(node) {
  const isDir = node.is_dir;
  const currentName = isDir ? node.rel_path : node.rel_path.replace(/\.md$/i, "");
  const input = await modal.prompt({
    title: isDir ? "Rename Folder" : "Rename Note",
    description: "Links across other markdown files update automatically.",
    defaultValue: currentName,
    confirmLabel: "Rename",
  });
  if (!input || !input.trim() || input.trim() === currentName) return;

  try {
    await flushSave();
    const oldFoldKey = foldKey(node.rel_path);
    const res = await invoke("rename_entry", {
      oldRel: node.rel_path,
      newRel: input.trim(),
    });

    if (state.prefs.collapsed_headings[oldFoldKey]) {
      state.prefs.collapsed_headings[foldKey(res.new_rel)] =
        state.prefs.collapsed_headings[oldFoldKey];
      delete state.prefs.collapsed_headings[oldFoldKey];
      persistPrefs();
    }

    const wasCurrent = state.currentFile === node.rel_path;
    await applyVaultSnapshot(res.vault, false);
    if (wasCurrent) {
      await openNote(res.new_rel);
    } else if (state.currentFile) {
      await openNote(state.currentFile);
    }
  } catch (err) {
    showToast(`Rename failed: ${err}`, true);
  }
}

async function handleMoveEntry(node, targetFolder) {
  const baseName = node.name;
  const newRel = targetFolder ? `${targetFolder}/${baseName}` : baseName;
  if (newRel === node.rel_path) return;

  try {
    await flushSave();
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
      state.currentFile = null;
      state.isDirty = false;
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

    await flushSave();
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

async function toggleGraphMode() {
  if (!state.vault) {
    showToast("Open a folder first", false);
    return;
  }
  if (!state.graphMode) {
    await flushSave();
  }
  state.graphMode = !state.graphMode;
  updateViewVisibility();
}

/* Wire UI Controls */
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
});

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

  if (e.key === "Escape" && state.graphMode && !quickSwitcher.isOpen()) {
    const modalEl = document.getElementById("input-modal");
    if (!modalEl || modalEl.hidden) {
      e.preventDefault();
      state.graphMode = false;
      updateViewVisibility();
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
    !state.graphMode &&
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
  } else if (key === "g" && !e.shiftKey) {
    e.preventDefault();
    toggleGraphMode();
  } else if (key === "j" && !e.shiftKey) {
    e.preventDefault();
    if (editor.hasBlockSelection() && !state.rawMode && !state.graphMode) {
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
  } else if (key === "o" && !e.shiftKey) {
    e.preventDefault();
    handleOpenFolder();
  } else if (key === "n" && !e.shiftKey) {
    e.preventDefault();
    promptCreateNote("");
  } else if (key === "s" && !e.shiftKey) {
    e.preventDefault();
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
    if (activeTag === "INPUT") return;
    if (e.shiftKey) {
      if (editor.redo()) e.preventDefault();
    } else if (editor.undo()) {
      e.preventDefault();
    }
  } else if (key === "y" && !e.shiftKey && !state.rawMode && !quickSwitcher.isOpen()) {
    const activeTag = document.activeElement?.tagName;
    if (activeTag === "INPUT") return;
    if (editor.redo()) e.preventDefault();
  }
});

window.addEventListener("beforeunload", () => {
  flushSave();
});

/* Bootstrap */
async function init() {
  try {
    const startup = await invoke("get_startup_state");
    state.prefs = { ...state.prefs, ...(startup.prefs || {}) };
    if (!state.prefs.collapsed_headings) {
      state.prefs.collapsed_headings = {};
    }
    applyTheme(state.prefs.theme);
    sidebar.setWidth(state.prefs.sidebar_width);
    sidebar.setCollapsed(state.prefs.sidebar_collapsed);
    terminal.setHeight(state.prefs.terminal_height);
    aiPanel.setWidth(state.prefs.ai_panel_width);
    await applyVaultSnapshot(startup.vault, true);
  } catch (err) {
    showToast(`Startup failed: ${err}`, true);
    updateViewVisibility();
  }
}

init();
