import { displayNameForLink, escapeHtml } from "./inline.js";
import { filterPages } from "./links.js";

const MODEL_CACHE_TTL_SEC = 86400;

const PROVIDER_PRESETS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    needsKey: true,
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    needsKey: true,
  },
  anthropic: {
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1/messages",
    needsKey: true,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    needsKey: true,
  },
  ollama: {
    label: "Ollama (Local)",
    baseUrl: "http://localhost:11434/v1/chat/completions",
    needsKey: false,
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "http://localhost:1234/v1/chat/completions",
    needsKey: false,
  },
};

function canonicalCacheKey(provider, baseUrl) {
  const p = String(provider || "openai").trim().toLowerCase();
  const preset = PROVIDER_PRESETS[p] || PROVIDER_PRESETS.openai;
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "") || preset.baseUrl;
  return `${p}::${clean}`;
}

function formatCacheAge(fetchedAtUnix) {
  if (!fetchedAtUnix) return "Not synced yet";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - fetchedAtUnix);
  if (diff < 60) return "Synced just now";
  if (diff < 3600) return `Synced ${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `Synced ${Math.floor(diff / 3600)}h ago`;
  return `Synced ${Math.floor(diff / 86400)}d ago`;
}

function formatRelativeAge(unixSec) {
  if (!unixSec) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / (86400 * 7))}w`;
}

function formatClockTime(unixOrMs) {
  if (!unixOrMs) return "";
  const ms = unixOrMs < 1e12 ? unixOrMs * 1000 : unixOrMs;
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function deriveChatTitle(prompt) {
  const clean = String(prompt || "")
    .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, target, label) => label || displayNameForLink(target))
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "New Conversation";
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
}

function tauriListen(eventName, handler) {
  const listenFn = window.__TAURI__?.event?.listen;
  if (!listenFn) return Promise.resolve(() => {});
  return listenFn(eventName, handler);
}

function formatBlockForAi(block, idx) {
  const bid = block.block_id ? `^${block.block_id}` : block.id;
  if (block.type === "heading") {
    return `[${bid}] H${block.level}: ${block.content}`;
  }
  if (block.type === "code") {
    return `[${bid}] CODE (${block.language || "text"}):\n\`\`\`${block.language || ""}\n${block.content}\n\`\`\``;
  }
  if (block.type === "image") {
    return `[${bid}] IMAGE: ![${block.alt || ""}](${block.src})`;
  }
  return `[${bid}] TEXT (${idx + 1}): ${block.content}`;
}

function summarizeBlockPayload(block) {
  if (!block) return "";
  if (block.type === "heading") return `${"#".repeat(block.level || 1)} ${block.content || ""}`;
  if (block.type === "code") return `\`\`\`${block.language || ""}\n${block.content || ""}\n\`\`\``;
  return block.content || "";
}

function parseEditOps(rawJson) {
  try {
    const parsed = JSON.parse(rawJson);
    const ops = Array.isArray(parsed) ? parsed : parsed?.edits;
    if (!Array.isArray(ops) || !ops.length) return null;
    const valid = ops.filter(
      (op) => op && typeof op.op === "string" && ["replace", "insert_after", "append", "delete"].includes(op.op)
    );
    return valid.length ? valid : null;
  } catch {
    return null;
  }
}

function renderInlineFormattedText(text) {
  const escaped = escapeHtml(text);
  // Render clickable [[wikilinks]], inline code, and bold cleanly inside assistant bubbles
  return escaped
    .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_m, target, label) => {
      const display = escapeHtml(displayNameForLink(target, label || ""));
      return `<button class="ai-ref-link" data-target="${escapeHtml(target)}" type="button">${display}</button>`;
    })
    .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

/**
 * Right-side BYOK AI chat drawer with block/selection chips, vault search, and Accept/Reject edits.
 */
export class AiPanel {
  constructor(
    {
      panelEl,
      resizerEl,
      toggleBtn,
      historyBtn,
      historyDrawerEl,
      newChatBtn,
      historySearchEl,
      historyListEl,
      modelBadgeEl,
      modelPopoverEl,
      settingsBtn,
      clearBtn,
      closeBtn,
      settingsDrawerEl,
      providerSelect,
      apiKeyInput,
      toggleKeyVisBtn,
      baseUrlInput,
      modelInput,
      pickModelBtn,
      fetchModelsBtn,
      saveSettingsBtn,
      turnRailEl,
      turnPreviewEl,
      messagesEl,
      chipsEl,
      mentionPopoverEl,
      inputEl,
      sendBtn,
      stopBtn,
    },
    {
      invoke,
      getCurrentContext,
      onResizeEnd,
      onApplyEdits,
      onInsertMarkdown,
      onOpenLink,
      onToast,
      onClearEditorSelection,
      onPromptRenameChat,
    }
  ) {
    this.panelEl = panelEl;
    this.resizerEl = resizerEl;
    this.toggleBtn = toggleBtn;
    this.historyBtn = historyBtn;
    this.historyDrawerEl = historyDrawerEl;
    this.newChatBtn = newChatBtn;
    this.historySearchEl = historySearchEl;
    this.historyListEl = historyListEl;
    this.modelBadgeEl = modelBadgeEl;
    this.modelPopoverEl = modelPopoverEl;
    this.settingsBtn = settingsBtn;
    this.settingsDrawerEl = settingsDrawerEl;
    this.providerSelect = providerSelect;
    this.apiKeyInput = apiKeyInput;
    this.baseUrlInput = baseUrlInput;
    this.modelInput = modelInput;
    this.pickModelBtn = pickModelBtn;
    this.fetchModelsBtn = fetchModelsBtn;
    this.turnRailEl = turnRailEl;
    this.turnPreviewEl = turnPreviewEl;
    this.messagesEl = messagesEl;
    this.chipsEl = chipsEl;
    this.mentionPopoverEl = mentionPopoverEl;
    this.inputEl = inputEl;
    this.sendBtn = sendBtn;
    this.stopBtn = stopBtn;

    this.invoke = invoke;
    this.getCurrentContext = getCurrentContext;
    this.onResizeEnd = onResizeEnd;
    this.onApplyEdits = onApplyEdits;
    this.onInsertMarkdown = onInsertMarkdown;
    this.onOpenLink = onOpenLink;
    this.onToast = onToast;
    this.onClearEditorSelection = onClearEditorSelection;
    this.onPromptRenameChat = onPromptRenameChat;

    this.openState = false;
    this.prefs = {
      provider: "openai",
      api_key: "",
      base_url: PROVIDER_PRESETS.openai.baseUrl,
      model: "",
    };
    this.prefsLoaded = false;

    this.includeCurrentPage = true;
    this.searchFolder = true;
    this.pinnedAttachments = []; // { id, kind: "block"|"selection", label, blockId, text }
    this.liveSelectedBlocks = [];
    this.messages = []; // { id, role, content, createdAt?, error?, proposalStates? }
    this.chats = [];
    this.chatsLoaded = false;
    this.activeChatId = null;
    this.activeChatTitle = "";
    this.activeChatPinned = false;
    this.activeChatCreatedAt = 0;
    this.activeChatVaultPath = "";
    this.activeChatVaultName = "";
    this.historyOpen = false;
    this.historyFilter = "";
    this.activeTurnIdx = 0;
    this._turns = [];
    this._turnPreviewTimer = null;
    this._scrollRaf = null;
    this.activeRequestId = null;
    this.isStreaming = false;
    this.modelsCache = {}; // cacheKey -> { fetched_at_unix, models }
    this.modelPickerOpen = false;
    this.modelPickerTarget = "header";
    this.modelFilterText = "";
    this.showOlderModels = false;
    this.isFetchingModels = false;
    this.mentionState = {
      active: false,
      matchStart: 0,
      matchEnd: 0,
      query: "",
      items: [],
      selectedIndex: 0,
    };

    settingsBtn.addEventListener("click", () => this.toggleSettings());
    this.historyBtn?.addEventListener("click", () => this.toggleHistory());
    this.newChatBtn?.addEventListener("click", () => this.startNewChat());
    this.historySearchEl?.addEventListener("input", () => {
      this.historyFilter = this.historySearchEl.value.trim().toLowerCase();
      this.renderHistoryDrawer();
    });
    this.modelBadgeEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleModelPopover("header");
    });
    this.pickModelBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleModelPopover("settings");
    });
    this.fetchModelsBtn?.addEventListener("click", async (e) => {
      e.stopPropagation();
      this.openModelPopover("settings", true);
      await this.fetchLiveModels(this.providerSelect.value, false);
    });
    clearBtn.addEventListener("click", () => this.startNewChat());
    closeBtn.addEventListener("click", () => this.close());

    this.messagesEl.addEventListener("scroll", () => this.scheduleActiveTurnUpdate(), { passive: true });
    this.turnRailEl?.addEventListener("mouseleave", () => {
      clearTimeout(this._turnPreviewTimer);
      this._turnPreviewTimer = setTimeout(() => this.hideTurnPreview(), 90);
    });

    toggleKeyVisBtn.addEventListener("click", () => {
      this.apiKeyInput.type = this.apiKeyInput.type === "password" ? "text" : "password";
    });

    this.providerSelect.addEventListener("change", () => {
      const nextProvider = this.providerSelect.value;
      const preset = PROVIDER_PRESETS[nextProvider];
      if (preset) {
        this.baseUrlInput.value = preset.baseUrl;
        const cacheKey = canonicalCacheKey(nextProvider, preset.baseUrl);
        const cached = this.modelsCache[cacheKey]?.models || [];
        const best = cached.find((m) => !m.is_snapshot) || cached[0];
        this.modelInput.value = best ? best.id : "";
        if (!preset.needsKey || this.apiKeyInput.value.trim()) {
          if (!this.isCacheFresh(cacheKey)) {
            this.fetchLiveModels(nextProvider, true);
          }
        }
      }
      this.updateModelHeader(nextProvider);
    });

    saveSettingsBtn.addEventListener("click", () => this.saveSettings());

    this.sendBtn.addEventListener("click", () => this.send());
    this.stopBtn.addEventListener("click", () => this.cancel());

    this.inputEl.addEventListener("keydown", (e) => {
      if (this.mentionState.active) {
        if (e.key === "ArrowDown") {
          if (this.mentionState.items.length > 0) {
            e.preventDefault();
            this.mentionState.selectedIndex =
              (this.mentionState.selectedIndex + 1) % this.mentionState.items.length;
            this.renderMentionPopover();
          }
          return;
        }
        if (e.key === "ArrowUp") {
          if (this.mentionState.items.length > 0) {
            e.preventDefault();
            this.mentionState.selectedIndex =
              (this.mentionState.selectedIndex - 1 + this.mentionState.items.length) %
              this.mentionState.items.length;
            this.renderMentionPopover();
          }
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (this.mentionState.items.length > 0) {
            e.preventDefault();
            this.commitMention(this.mentionState.items[this.mentionState.selectedIndex]);
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.closeMentionPopover();
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = `${Math.min(130, Math.max(38, this.inputEl.scrollHeight))}px`;
      this.inspectMentionCaret();
    });

    this.inputEl.addEventListener("click", () => this.inspectMentionCaret());
    this.inputEl.addEventListener("keyup", (e) => {
      if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        this.inspectMentionCaret();
      }
    });

    document.addEventListener("mousedown", (e) => {
      if (
        this.mentionState.active &&
        this.mentionPopoverEl &&
        !this.mentionPopoverEl.contains(e.target) &&
        e.target !== this.inputEl
      ) {
        this.closeMentionPopover();
      }
      if (
        this.modelPickerOpen &&
        this.modelPopoverEl &&
        !this.modelPopoverEl.contains(e.target) &&
        e.target !== this.modelBadgeEl &&
        e.target !== this.pickModelBtn &&
        e.target !== this.fetchModelsBtn
      ) {
        this.closeModelPopover();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.modelPickerOpen) {
        e.preventDefault();
        this.closeModelPopover();
      }
    });

    this.initResizer();
    this.initStreamListener();
    this.updateModelHeader();
    this.ensurePrefsLoaded();
    this.renderChips();
    this.renderMessages();
  }

  isCacheFresh(cacheKey) {
    const entry = this.modelsCache[cacheKey];
    if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - (entry.fetched_at_unix || 0) < MODEL_CACHE_TTL_SEC;
  }

  isSavedModelMissing(provider, cacheKey, modelId) {
    if (!modelId || provider === "custom") return false;
    const cached = this.modelsCache[cacheKey]?.models;
    if (!Array.isArray(cached) || cached.length === 0) return false;
    return !cached.some((m) => m.id === modelId);
  }

  updateModelHeader(providerOverride = null) {
    const providerKey = providerOverride || this.prefs.provider || "openai";
    const baseUrl = this.prefs.base_url?.trim() || PROVIDER_PRESETS[providerKey]?.baseUrl || "";
    const cacheKey = canonicalCacheKey(providerKey, baseUrl);
    const activeModel = this.prefs.model?.trim() || "";
    if (this.modelBadgeEl) {
      this.modelBadgeEl.textContent = activeModel || "Pick model";
      const missing = this.isSavedModelMissing(providerKey, cacheKey, activeModel);
      this.modelBadgeEl.classList.toggle("deprecated", missing);
      this.modelBadgeEl.title = missing
        ? `Model "${activeModel}" was not found in the latest live list — click to switch`
        : "Switch AI model";
    }
  }

  getActiveModelProviderContext(target = this.modelPickerTarget) {
    const useSettings = target === "settings" || !this.settingsDrawerEl.hidden;
    const provider = useSettings ? this.providerSelect.value : this.prefs.provider || "openai";
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
    const baseUrl =
      (useSettings ? this.baseUrlInput.value.trim() : this.prefs.base_url?.trim()) ||
      preset.baseUrl;
    const apiKey = (useSettings ? this.apiKeyInput.value.trim() : this.prefs.api_key?.trim()) || "";
    const currentModel =
      (useSettings ? this.modelInput.value.trim() : this.prefs.model?.trim()) || "";
    return {
      provider,
      baseUrl,
      apiKey,
      currentModel,
      cacheKey: canonicalCacheKey(provider, baseUrl),
    };
  }

  getAvailableModels(cacheKey, currentModel) {
    const entry = this.modelsCache[cacheKey];
    const cached = Array.isArray(entry?.models) ? entry.models : [];
    const primary = [];
    const older = [];
    const seen = new Set();

    for (const m of cached) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.add(m.id);
      const item = {
        id: m.id,
        label: m.label || m.id,
        is_snapshot: Boolean(m.is_snapshot),
        tier_hint: m.tier_hint || null,
        missing: false,
      };
      if (item.is_snapshot) {
        older.push(item);
      } else {
        primary.push(item);
      }
    }

    if (currentModel && !seen.has(currentModel)) {
      primary.unshift({
        id: currentModel,
        label: cached.length > 0 ? "Saved (not in live list)" : "Current",
        is_snapshot: false,
        tier_hint: cached.length > 0 ? "Stale" : null,
        missing: cached.length > 0,
      });
    }

    return {
      primary,
      older,
      all: [...primary, ...older],
      fetchedAt: entry?.fetched_at_unix || 0,
      hasLiveList: cached.length > 0,
    };
  }

  async fetchLiveModels(providerOverride = null, silent = false) {
    const useSettings = Boolean(providerOverride) || !this.settingsDrawerEl.hidden;
    const provider =
      providerOverride ||
      (useSettings ? this.providerSelect.value : this.prefs.provider || "openai");
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
    const baseUrl =
      (useSettings ? this.baseUrlInput.value.trim() : this.prefs.base_url?.trim()) ||
      preset.baseUrl;
    const apiKey = (useSettings ? this.apiKeyInput.value.trim() : this.prefs.api_key?.trim()) || "";
    const cacheKey = canonicalCacheKey(provider, baseUrl);

    if (preset.needsKey && !apiKey) {
      if (!silent) this.onToast?.("Enter your API key first to fetch live models", true);
      return null;
    }

    this.isFetchingModels = true;
    if (this.modelPickerOpen) this.renderModelPopover();

    try {
      const entry = await this.invoke("ai_list_models", {
        request: {
          provider,
          api_key: apiKey,
          base_url: baseUrl,
        },
      });
      const normalized = {
        fetched_at_unix: entry?.fetched_at_unix || Math.floor(Date.now() / 1000),
        models: Array.isArray(entry?.models) ? entry.models : [],
      };
      this.modelsCache[cacheKey] = normalized;

      const best = normalized.models.find((m) => !m.is_snapshot) || normalized.models[0];
      if (best) {
        if (!this.settingsDrawerEl.hidden && this.providerSelect.value === provider && !this.modelInput.value.trim()) {
          this.modelInput.value = best.id;
        }
        if (this.prefs.provider === provider && !this.prefs.model?.trim()) {
          this.prefs = { ...this.prefs, model: best.id };
          try {
            await this.invoke("save_ai_prefs", { prefs: this.prefs });
          } catch {
            // Ignore auto-pick save error
          }
        }
      }

      this.updateModelHeader();
      if (!silent) {
        this.onToast?.(`Synced ${normalized.models.length} live models`);
      }
      return normalized;
    } catch (err) {
      if (!silent) {
        this.onToast?.(`Failed to load models: ${err}`, true);
      }
      return null;
    } finally {
      this.isFetchingModels = false;
      if (this.modelPickerOpen) this.renderModelPopover();
    }
  }

  toggleModelPopover(target = "header") {
    if (this.modelPickerOpen && this.modelPickerTarget === target) {
      this.closeModelPopover();
    } else {
      this.openModelPopover(target, false);
    }
  }

  openModelPopover(target = "header", skipAutoFetch = false) {
    if (!this.modelPopoverEl) return;
    this.modelPickerOpen = true;
    this.modelPickerTarget = target;
    this.modelFilterText = "";
    this.showOlderModels = false;

    const panelRect = this.panelEl.getBoundingClientRect();
    let topPx = 42;
    if (target === "settings" && this.modelInput) {
      const rowRect = this.modelInput.getBoundingClientRect();
      topPx = Math.max(42, rowRect.bottom - panelRect.top + 4);
    }
    this.modelPopoverEl.style.top = `${topPx}px`;

    this.renderModelPopover();
    const filterEl = this.modelPopoverEl.querySelector(".ai-model-filter");
    filterEl?.focus();

    const ctx = this.getActiveModelProviderContext(target);
    if (
      !skipAutoFetch &&
      !this.isCacheFresh(ctx.cacheKey) &&
      (ctx.apiKey || ctx.provider === "ollama")
    ) {
      this.fetchLiveModels(ctx.provider, true);
    }
  }

  closeModelPopover() {
    this.modelPickerOpen = false;
    this.modelFilterText = "";
    this.showOlderModels = false;
    if (this.modelPopoverEl) {
      this.modelPopoverEl.hidden = true;
      this.modelPopoverEl.innerHTML = "";
    }
  }

  renderModelPopover() {
    if (!this.modelPopoverEl || !this.modelPickerOpen) return;
    const ctx = this.getActiveModelProviderContext(this.modelPickerTarget);
    const { primary, older, all, fetchedAt, hasLiveList } = this.getAvailableModels(
      ctx.cacheKey,
      ctx.currentModel
    );
    const q = this.modelFilterText.trim().toLowerCase();

    const renderRow = (m) => {
      const isSel = m.id === ctx.currentModel;
      const hintParts = [];
      if (m.label && m.label !== m.id && !m.missing) hintParts.push(m.label);
      const subText = hintParts.join(" · ");
      const tierBadge = m.tier_hint
        ? `<span class="ai-model-tier">${escapeHtml(m.tier_hint)}</span>`
        : "";
      const subHtml =
        subText || tierBadge
          ? `<span class="popover-item-sub">${tierBadge}${subText ? ` ${escapeHtml(subText)}` : ""}</span>`
          : "";
      return `
        <button class="popover-item${isSel ? " selected" : ""}" data-model-id="${escapeHtml(m.id)}" type="button" role="option">
          <span class="popover-item-main">
            <span class="popover-item-title">${isSel ? "✓ " : ""}${escapeHtml(m.id)}</span>
          </span>
          ${subHtml}
        </button>
      `;
    };

    let listHtml = "";
    if (q) {
      const matches = all.filter(
        (m) => m.id.toLowerCase().includes(q) || (m.label || "").toLowerCase().includes(q)
      );
      listHtml = matches.length
        ? matches.map(renderRow).join("")
        : `<div class="popover-section-label">No matching models</div>`;
    } else if (!all.length) {
      listHtml = `<div class="popover-section-label">${
        this.isFetchingModels
          ? "Fetching live models..."
          : ctx.apiKey || ctx.provider === "ollama"
            ? "Click ↻ Fetch to load models"
            : "Add your API key in Settings first"
      }</div>`;
    } else {
      const visiblePrimary = primary.slice();
      if (ctx.currentModel) {
        const activeOlder = older.find((m) => m.id === ctx.currentModel);
        if (activeOlder && !visiblePrimary.some((m) => m.id === activeOlder.id)) {
          visiblePrimary.unshift(activeOlder);
        }
      }
      listHtml = visiblePrimary.map(renderRow).join("");
      if (older.length > 0) {
        const verb = this.showOlderModels ? "▾ Hide" : "▸ Show";
        listHtml += `<button class="ai-model-expand-btn" data-toggle-older="1" type="button">${verb} older &amp; preview models (${older.length})</button>`;
        if (this.showOlderModels) {
          listHtml += older.map(renderRow).join("");
        }
      }
    }

    const isDeprecated = this.isSavedModelMissing(ctx.provider, ctx.cacheKey, ctx.currentModel);
    const statusText = this.isFetchingModels
      ? "Syncing live models..."
      : isDeprecated
        ? `"${ctx.currentModel}" may be retired — pick another`
        : hasLiveList
          ? `${formatCacheAge(fetchedAt)} · ${all.length} models`
          : "Cached list empty";

    const existingFilter = this.modelPopoverEl.querySelector(".ai-model-filter");
    if (existingFilter) {
      const listEl = this.modelPopoverEl.querySelector(".ai-model-popover-list");
      const refreshBtn = this.modelPopoverEl.querySelector("[data-refresh-models]");
      const statusEl = this.modelPopoverEl.querySelector(".ai-model-status-note");
      if (listEl) listEl.innerHTML = listHtml;
      if (refreshBtn) refreshBtn.textContent = this.isFetchingModels ? "…" : "↻ Fetch";
      if (statusEl) {
        statusEl.textContent = statusText;
        statusEl.classList.toggle("warn", isDeprecated);
      }
    } else {
      this.modelPopoverEl.innerHTML = `
        <div class="ai-model-popover-header">
          <input class="ai-model-filter" type="text" placeholder="Filter models..." value="${escapeHtml(this.modelFilterText)}" autocomplete="off" />
          <button class="top-text-btn" data-refresh-models="1" type="button" title="Fetch live models from provider">${this.isFetchingModels ? "…" : "↻ Fetch"}</button>
        </div>
        <div class="ai-model-popover-list">${listHtml}</div>
        <div class="ai-model-status-note${isDeprecated ? " warn" : ""}">${escapeHtml(statusText)}</div>
      `;
      this.modelPopoverEl.querySelector(".ai-model-filter")?.addEventListener("input", (e) => {
        this.modelFilterText = e.target.value;
        this.renderModelPopover();
      });
      this.modelPopoverEl
        .querySelector("[data-refresh-models]")
        ?.addEventListener("click", (e) => {
          e.stopPropagation();
          this.fetchLiveModels(null, false);
        });
    }

    this.modelPopoverEl.hidden = false;
    this.modelPopoverEl.querySelector("[data-toggle-older]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.showOlderModels = !this.showOlderModels;
      this.renderModelPopover();
      this.modelPopoverEl.querySelector(".ai-model-filter")?.focus();
    });
    this.modelPopoverEl.querySelectorAll("[data-model-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const chosenId = btn.dataset.modelId;
        if (chosenId) this.selectModelFromPopover(chosenId);
      });
    });
  }

  async selectModelFromPopover(modelId) {
    if (this.modelPickerTarget === "settings") {
      this.modelInput.value = modelId;
      this.closeModelPopover();
      this.modelInput.focus();
      return;
    }

    const nextPrefs = { ...this.prefs, model: modelId };
    try {
      await this.invoke("save_ai_prefs", { prefs: nextPrefs });
      this.prefs = nextPrefs;
      this.modelInput.value = modelId;
      this.updateModelHeader();
      this.closeModelPopover();
      this.onToast?.(`Switched to ${modelId}`);
    } catch (err) {
      this.onToast?.(`Failed to switch model: ${err}`, true);
    }
  }

  async initStreamListener() {
    await tauriListen("ai-stream", (event) => {
      const payload = event?.payload;
      if (!payload || payload.request_id !== this.activeRequestId) return;

      const msg = this.messages.find((m) => m.id === payload.request_id);
      if (!msg) return;

      if (payload.kind === "delta") {
        msg.content += payload.text;
        this.renderMessages(true);
      } else if (payload.kind === "error") {
        msg.error = payload.text || "Request failed";
        this.finishStreaming();
      } else if (payload.kind === "done") {
        this.finishStreaming();
      }
    });
  }

  finishStreaming() {
    this.isStreaming = false;
    this.activeRequestId = null;
    this.sendBtn.hidden = false;
    this.stopBtn.hidden = true;
    this.renderMessages(true);
    this.persistActiveChat();
  }

  initResizer() {
    let dragging = false;
    let startX = 0;
    let startWidth = 340;

    this.resizerEl.addEventListener("mousedown", (e) => {
      if (!this.openState) return;
      dragging = true;
      startX = e.clientX;
      startWidth = this.panelEl.getBoundingClientRect().width;
      this.resizerEl.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const next = Math.min(560, Math.max(260, Math.round(startWidth - (e.clientX - startX))));
      this.panelEl.style.width = `${next}px`;
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      this.resizerEl.classList.remove("dragging");
      document.body.style.cursor = "";
      const width = Math.round(this.panelEl.getBoundingClientRect().width);
      this.onResizeEnd?.(width);
    });
  }

  setWidth(width) {
    const clamped = Math.min(560, Math.max(260, Number(width) || 340));
    this.panelEl.style.width = `${clamped}px`;
  }

  isOpen() {
    return this.openState;
  }

  async ensurePrefsLoaded() {
    if (this.prefsLoaded) return;
    try {
      const [loaded, cachedModels, chats] = await Promise.all([
        this.invoke("get_ai_prefs"),
        this.invoke("get_cached_models").catch(() => ({})),
        this.invoke("ai_list_chats").catch(() => []),
      ]);
      if (loaded) {
        this.prefs = { ...this.prefs, ...loaded };
      }
      if (cachedModels && typeof cachedModels === "object") {
        this.modelsCache = cachedModels;
      }
      if (Array.isArray(chats)) {
        this.chats = chats;
        this.chatsLoaded = true;
        if (!this.activeChatId && this.messages.length === 0 && chats.length > 0) {
          const ctx = this.getCurrentContext?.() || {};
          const matchingVault = ctx.vaultPath
            ? chats.find((c) => c.vault_path === ctx.vaultPath)
            : null;
          const targetChat = matchingVault || chats[0];
          if (targetChat?.id) {
            await this.openChat(targetChat.id, false);
          }
        }
      }
      this.prefsLoaded = true;
      this.syncSettingsInputs();
      const preset = PROVIDER_PRESETS[this.prefs.provider] || PROVIDER_PRESETS.openai;
      if (preset.needsKey && !this.prefs.api_key?.trim()) {
        this.settingsDrawerEl.hidden = false;
      } else {
        const cacheKey = canonicalCacheKey(this.prefs.provider, this.prefs.base_url);
        if (!this.isCacheFresh(cacheKey)) {
          this.fetchLiveModels(this.prefs.provider, true);
        }
      }
    } catch {
      this.prefsLoaded = true;
    }
  }

  syncSettingsInputs() {
    this.providerSelect.value = this.prefs.provider || "openai";
    this.apiKeyInput.value = this.prefs.api_key || "";
    this.baseUrlInput.value = this.prefs.base_url || "";
    this.modelInput.value = this.prefs.model || "";
    this.updateModelHeader(this.providerSelect.value);
  }

  async open() {
    this.openState = true;
    this.panelEl.hidden = false;
    this.resizerEl.hidden = false;
    this.toggleBtn?.classList.add("active");
    await this.ensurePrefsLoaded();
    this.updateModelHeader();
    this.renderChips();
    this.inputEl.focus();
  }

  close() {
    this.openState = false;
    this.panelEl.hidden = true;
    this.resizerEl.hidden = true;
    this.toggleBtn?.classList.remove("active");
    this.closeMentionPopover();
    this.closeModelPopover();
    this.hideTurnPreview();
  }

  closeMentionPopover() {
    this.mentionState.active = false;
    this.mentionState.items = [];
    this.mentionState.selectedIndex = 0;
    if (this.mentionPopoverEl) {
      this.mentionPopoverEl.hidden = true;
      this.mentionPopoverEl.innerHTML = "";
    }
  }

  inspectMentionCaret() {
    if (!this.mentionPopoverEl) return;
    const start = this.inputEl.selectionStart;
    const end = this.inputEl.selectionEnd;
    if (start === null || end === null || start !== end) {
      this.closeMentionPopover();
      return;
    }

    const before = this.inputEl.value.slice(0, start);
    const match = before.match(/(@@([^\n@]*))$/);
    if (!match) {
      this.closeMentionPopover();
      return;
    }

    const query = match[2];
    const matchStart = before.length - match[1].length;
    const pages = this.getCurrentContext?.().pages || [];
    const items = filterPages(pages, query);

    this.mentionState = {
      active: true,
      matchStart,
      matchEnd: start,
      query,
      items,
      selectedIndex: Math.min(this.mentionState.selectedIndex, Math.max(0, items.length - 1)),
    };
    this.renderMentionPopover();
  }

  renderMentionPopover() {
    if (!this.mentionPopoverEl) return;
    const { items, selectedIndex } = this.mentionState;

    if (!items.length) {
      this.mentionPopoverEl.innerHTML = `<div class="popover-section-label">No matching notes</div>`;
      this.mentionPopoverEl.hidden = false;
      return;
    }

    this.mentionPopoverEl.innerHTML = items
      .map((page, idx) => {
        const selClass = idx === selectedIndex ? " selected" : "";
        const sub = page.folder || "root";
        return `
          <button class="popover-item${selClass}" data-idx="${idx}" type="button" role="option">
            <span class="popover-item-main">
              <span class="popover-item-title">${escapeHtml(page.title)}</span>
            </span>
            <span class="popover-item-sub">${escapeHtml(sub)}</span>
          </button>
        `;
      })
      .join("");

    this.mentionPopoverEl.hidden = false;
    const selEl = this.mentionPopoverEl.querySelector(".popover-item.selected");
    selEl?.scrollIntoView({ block: "nearest" });

    this.mentionPopoverEl.querySelectorAll(".popover-item").forEach((btn) => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const item = this.mentionState.items[Number(btn.dataset.idx)];
        if (item) this.commitMention(item);
      });
    });
  }

  commitMention(page) {
    if (!page) return;
    const { matchStart, matchEnd } = this.mentionState;
    const insertion = `[[${page.link_target}]] `;
    const val = this.inputEl.value;
    this.inputEl.value = val.slice(0, matchStart) + insertion + val.slice(matchEnd);
    const nextPos = matchStart + insertion.length;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(nextPos, nextPos);
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = `${Math.min(130, Math.max(38, this.inputEl.scrollHeight))}px`;
    this.closeMentionPopover();
  }

  toggle() {
    if (this.openState) this.close();
    else this.open();
  }

  toggleSettings(forceState = null) {
    const nextHidden = forceState === null ? !this.settingsDrawerEl.hidden : !forceState;
    if (!nextHidden && this.historyOpen) {
      this.toggleHistory(false);
    }
    this.settingsDrawerEl.hidden = nextHidden;
    this.settingsBtn?.classList.toggle("active", !nextHidden);
    if (!nextHidden) {
      this.syncSettingsInputs();
      this.apiKeyInput.focus();
    }
  }

  async saveSettings() {
    const provider = this.providerSelect.value;
    const api_key = this.apiKeyInput.value.trim();
    const base_url =
      this.baseUrlInput.value.trim() || PROVIDER_PRESETS[provider]?.baseUrl || "";
    let model = this.modelInput.value.trim();
    const cacheKey = canonicalCacheKey(provider, base_url);

    if (!model && (api_key || provider === "ollama")) {
      const cached = this.modelsCache[cacheKey]?.models || [];
      const fetched =
        cached.length > 0 ? { models: cached } : await this.fetchLiveModels(provider, true);
      const best =
        fetched?.models?.find((m) => !m.is_snapshot) || fetched?.models?.[0];
      if (best?.id) {
        model = best.id;
        this.modelInput.value = model;
      }
    }

    if (!model) {
      this.modelInput.focus();
      this.onToast?.("Pick or type a model name first", true);
      return;
    }

    const nextPrefs = { provider, api_key, base_url, model };
    try {
      await this.invoke("save_ai_prefs", { prefs: nextPrefs });
      this.prefs = nextPrefs;
      this.updateModelHeader();
      this.settingsDrawerEl.hidden = true;
      this.settingsBtn?.classList.remove("active");
      this.onToast?.("AI settings saved");
      if ((api_key || provider === "ollama") && !this.isCacheFresh(cacheKey)) {
        this.fetchLiveModels(provider, true);
      }
    } catch (err) {
      this.onToast?.(`Failed to save AI settings: ${err}`, true);
    }
  }

  clearChat() {
    this.startNewChat();
  }

  refreshHistoryView() {
    if (this.historyOpen) {
      this.renderHistoryDrawer();
    }
  }

  async toggleHistory(forceState = null) {
    if (!this.historyDrawerEl) return;
    const nextOpen = forceState === null ? !this.historyOpen : Boolean(forceState);
    this.historyOpen = nextOpen;
    this.historyDrawerEl.hidden = !nextOpen;
    this.historyBtn?.classList.toggle("active", nextOpen);

    if (nextOpen) {
      if (!this.settingsDrawerEl.hidden) {
        this.settingsDrawerEl.hidden = true;
        this.settingsBtn?.classList.remove("active");
      }
      this.closeModelPopover();
      this.hideTurnPreview();
      try {
        const list = await this.invoke("ai_list_chats");
        if (Array.isArray(list)) {
          this.chats = list;
          this.chatsLoaded = true;
        }
      } catch {
        // Keep cached chat list on error
      }
      this.renderHistoryDrawer();
      this.historySearchEl?.focus();
    }
  }

  startNewChat() {
    if (this.isStreaming) this.cancel();
    this.activeChatId = null;
    this.activeChatTitle = "";
    this.activeChatPinned = false;
    this.activeChatCreatedAt = 0;
    this.activeChatVaultPath = "";
    this.activeChatVaultName = "";
    this.messages = [];
    this.pinnedAttachments = [];
    this.hideTurnPreview();
    if (this.historyOpen) this.toggleHistory(false);
    this.renderChips();
    this.renderMessages();
    if (this.openState) this.inputEl?.focus();
  }

  async openChat(chatId, closeDrawer = true) {
    if (!chatId) return;
    if (this.isStreaming) await this.cancel();
    try {
      const session = await this.invoke("ai_load_chat", { chatId });
      this.activeChatId = session.id;
      this.activeChatTitle = session.title || "Conversation";
      this.activeChatPinned = Boolean(session.pinned);
      this.activeChatCreatedAt = session.created_at || Math.floor(Date.now() / 1000);
      this.activeChatVaultPath = session.vault_path || "";
      this.activeChatVaultName = session.vault_name || "";
      this.messages = (session.messages || []).map((m) => {
        const proposalStates = {};
        if (m.proposal_states && typeof m.proposal_states === "object") {
          for (const [k, v] of Object.entries(m.proposal_states)) {
            proposalStates[k] = v;
          }
        }
        return {
          id: m.id,
          role: m.role,
          content: m.content || "",
          createdAt: m.created_at || 0,
          ...(m.error ? { error: m.error } : {}),
          proposalStates,
        };
      });
      this.pinnedAttachments = [];
      this.hideTurnPreview();
      if (closeDrawer && this.historyOpen) this.toggleHistory(false);
      this.renderChips();
      this.renderMessages(true);
      if (this.historyOpen) this.renderHistoryDrawer();
    } catch (err) {
      this.onToast?.(`Failed to load conversation: ${err}`, true);
    }
  }

  async persistActiveChat() {
    if (!this.messages.length) return;
    const nowSec = Math.floor(Date.now() / 1000);
    if (!this.activeChatId) {
      const rand = Math.random().toString(36).slice(2, 7);
      this.activeChatId = `chat-${Date.now().toString(36)}-${rand}`;
      this.activeChatCreatedAt = nowSec;
      const firstUser = this.messages.find((m) => m.role === "user");
      this.activeChatTitle = deriveChatTitle(firstUser?.content || "");
      const ctx = this.getCurrentContext?.() || {};
      this.activeChatVaultPath = ctx.vaultPath || "";
      this.activeChatVaultName = ctx.vaultName || "";
    }

    const session = {
      id: this.activeChatId,
      title: this.activeChatTitle || "New Conversation",
      vault_path: this.activeChatVaultPath || "",
      vault_name: this.activeChatVaultName || "",
      pinned: Boolean(this.activeChatPinned),
      created_at: this.activeChatCreatedAt || nowSec,
      updated_at: nowSec,
      messages: this.messages.map((m) => {
        const proposal_states = {};
        for (const [k, v] of Object.entries(m.proposalStates || {})) {
          proposal_states[String(k)] = String(v);
        }
        return {
          id: m.id,
          role: m.role,
          content: m.content || "",
          created_at: m.createdAt ? Math.floor(m.createdAt / 1000) : nowSec,
          error: m.error || null,
          proposal_states,
        };
      }),
    };

    try {
      const updated = await this.invoke("ai_save_chat", { session });
      if (Array.isArray(updated)) {
        this.chats = updated;
        this.chatsLoaded = true;
        if (this.historyOpen) this.renderHistoryDrawer();
      }
    } catch (err) {
      console.error("Failed to persist chat:", err);
    }
  }

  renderHistoryDrawer() {
    if (!this.historyListEl) return;
    const q = this.historyFilter;
    const ctx = this.getCurrentContext?.() || {};
    const activeVaultPath = ctx.vaultPath || "";
    const filtered = q
      ? this.chats.filter(
          (c) =>
            (c.title || "").toLowerCase().includes(q) ||
            (c.vault_name || "").toLowerCase().includes(q)
        )
      : this.chats;

    if (!filtered.length) {
      this.historyListEl.innerHTML = `<div class="popover-section-label">${
        q ? "No matching conversations" : "No saved conversations yet"
      }</div>`;
      return;
    }

    const pinned = filtered.filter((c) => c.pinned);
    const inVault = filtered.filter(
      (c) => !c.pinned && activeVaultPath && c.vault_path === activeVaultPath
    );
    const others = filtered.filter(
      (c) => !c.pinned && (!activeVaultPath || c.vault_path !== activeVaultPath)
    );

    const renderGroup = (heading, items) => {
      if (!items.length) return "";
      const rows = items
        .map((c) => {
          const isActive = c.id === this.activeChatId;
          const age = formatRelativeAge(c.updated_at);
          const subTitle =
            c.vault_name && c.vault_path !== activeVaultPath ? ` (${c.vault_name})` : "";
          return `
            <div class="ai-chat-row${isActive ? " active" : ""}" data-chat-id="${escapeHtml(c.id)}" title="${escapeHtml(c.title + subTitle)}">
              <span class="ai-chat-title">${escapeHtml(c.title)}</span>
              <span class="ai-chat-age">${escapeHtml(age)}</span>
              <div class="ai-chat-actions">
                <button class="ai-chat-act-btn${c.pinned ? " pinned" : ""}" data-chat-pin="${escapeHtml(c.id)}" type="button" title="${c.pinned ? "Unpin" : "Pin"}">📌</button>
                <button class="ai-chat-act-btn" data-chat-rename="${escapeHtml(c.id)}" type="button" title="Rename">✎</button>
                <button class="ai-chat-act-btn danger" data-chat-del="${escapeHtml(c.id)}" type="button" title="Delete">×</button>
              </div>
            </div>
          `;
        })
        .join("");
      return `<div class="ai-history-section">${escapeHtml(heading)}</div>${rows}`;
    };

    const html = [
      renderGroup("Pinned", pinned),
      renderGroup(ctx.vaultName || "Current Folder", inVault),
      renderGroup("Conversations", others),
    ].join("");

    this.historyListEl.innerHTML = html;

    this.historyListEl.querySelectorAll(".ai-chat-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        if (e.target.closest(".ai-chat-actions")) return;
        this.openChat(row.dataset.chatId);
      });
    });

    this.historyListEl.querySelectorAll("[data-chat-pin]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const chatId = btn.dataset.chatPin;
        const chat = this.chats.find((c) => c.id === chatId);
        if (!chat) return;
        const nextPinned = !chat.pinned;
        try {
          const updated = await this.invoke("ai_update_chat_meta", {
            chatId,
            title: null,
            pinned: nextPinned,
          });
          if (Array.isArray(updated)) this.chats = updated;
          if (chatId === this.activeChatId) this.activeChatPinned = nextPinned;
          this.renderHistoryDrawer();
        } catch (err) {
          this.onToast?.(`Failed to update chat: ${err}`, true);
        }
      });
    });

    this.historyListEl.querySelectorAll("[data-chat-rename]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const chatId = btn.dataset.chatRename;
        const chat = this.chats.find((c) => c.id === chatId);
        if (!chat || !this.onPromptRenameChat) return;
        const nextTitle = await this.onPromptRenameChat(chat);
        if (!nextTitle || !nextTitle.trim()) return;
        const cleanTitle = nextTitle.trim();
        try {
          const updated = await this.invoke("ai_update_chat_meta", {
            chatId,
            title: cleanTitle,
            pinned: null,
          });
          if (Array.isArray(updated)) this.chats = updated;
          if (chatId === this.activeChatId) this.activeChatTitle = cleanTitle;
          this.renderHistoryDrawer();
        } catch (err) {
          this.onToast?.(`Failed to rename chat: ${err}`, true);
        }
      });
    });

    this.historyListEl.querySelectorAll("[data-chat-del]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const chatId = btn.dataset.chatDel;
        try {
          const updated = await this.invoke("ai_delete_chat", { chatId });
          if (Array.isArray(updated)) this.chats = updated;
          if (chatId === this.activeChatId) {
            this.startNewChat();
            this.toggleHistory(true);
          } else {
            this.renderHistoryDrawer();
          }
        } catch (err) {
          this.onToast?.(`Failed to delete chat: ${err}`, true);
        }
      });
    });
  }

  attachBlock(block) {
    if (!block) return;
    const bid = block.block_id ? `^${block.block_id}` : block.id;
    const preview = summarizeBlockPayload(block).replace(/\s+/g, " ").trim().slice(0, 40) || block.type;
    const id = `blk:${bid}`;
    if (!this.pinnedAttachments.some((a) => a.id === id)) {
      this.pinnedAttachments.push({
        id,
        kind: "block",
        label: `${block.type}: ${preview}`,
        blockId: block.id,
        obsidianId: block.block_id || null,
        text: summarizeBlockPayload(block),
      });
    }
    this.open();
    this.renderChips();
  }

  syncLiveSelection(selectedBlocks) {
    this.liveSelectedBlocks = Array.isArray(selectedBlocks) ? selectedBlocks.slice() : [];
    const count = this.liveSelectedBlocks.length;
    if (this.inputEl) {
      this.inputEl.placeholder =
        count > 0
          ? `Ask about these ${count} highlighted block${count === 1 ? "" : "s"}...`
          : "Ask about this note, highlights, or folder...";
    }
    this.renderChips();
  }

  async focusOnHighlightedBlocks(blocks) {
    this.syncLiveSelection(blocks);
    await this.open();
    this.inputEl?.focus();
  }

  attachBlocks(blocks) {
    this.focusOnHighlightedBlocks(blocks);
  }

  attachSelection({ blockId, block, text }) {
    const clean = String(text || "").trim();
    if (!clean) return;
    const preview = clean.replace(/\s+/g, " ").slice(0, 42);
    const id = `sel:${Date.now().toString(36)}`;
    this.pinnedAttachments.push({
      id,
      kind: "selection",
      label: `"${preview}${clean.length > 42 ? "…" : ""}"`,
      blockId: blockId || block?.id || "",
      obsidianId: block?.block_id || null,
      text: clean,
    });
    this.open();
    this.renderChips();
  }

  renderChips() {
    const parts = [];
    parts.push(
      `<button class="ai-chip${this.includeCurrentPage ? " active" : ""}" data-chip="page" type="button" title="Toggle sending current page blocks">Page</button>`
    );
    parts.push(
      `<button class="ai-chip${this.searchFolder ? " active" : ""}" data-chip="vault" type="button" title="Toggle searching across all .md files in folder">Search Folder</button>`
    );

    if (this.liveSelectedBlocks.length > 0) {
      const count = this.liveSelectedBlocks.length;
      parts.push(`
        <span class="ai-chip ai-focus-chip" title="LLM will focus specifically on your currently highlighted blocks">
          <span class="ai-chip-label">✦ Focus: ${count} highlighted block${count === 1 ? "" : "s"}</span>
          <button class="ai-chip-remove" data-clear-focus="1" type="button" title="Clear highlighted selection">×</button>
        </span>
      `);
    }

    for (const att of this.pinnedAttachments) {
      parts.push(`
        <span class="ai-chip pinned">
          <span class="ai-chip-label">${escapeHtml(att.label)}</span>
          <button class="ai-chip-remove" data-remove="${escapeHtml(att.id)}" type="button" title="Remove">×</button>
        </span>
      `);
    }

    this.chipsEl.innerHTML = parts.join("");

    this.chipsEl.querySelector('[data-chip="page"]')?.addEventListener("click", () => {
      this.includeCurrentPage = !this.includeCurrentPage;
      this.renderChips();
    });
    this.chipsEl.querySelector('[data-chip="vault"]')?.addEventListener("click", () => {
      this.searchFolder = !this.searchFolder;
      this.renderChips();
    });
    this.chipsEl.querySelector('[data-clear-focus="1"]')?.addEventListener("click", () => {
      this.onClearEditorSelection?.();
    });
    this.chipsEl.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.remove;
        this.pinnedAttachments = this.pinnedAttachments.filter((a) => a.id !== id);
        this.renderChips();
      });
    });
  }

  async cancel() {
    try {
      await this.invoke("ai_cancel_stream");
    } catch {
      // Ignore cancel errors
    }
    this.finishStreaming();
  }

  async buildContextBundle(userPrompt) {
    const ctx = this.getCurrentContext();
    const sections = [];

    if (ctx.vaultName) {
      const pageList = (ctx.pages || [])
        .slice(0, 60)
        .map((p) => p.rel_path)
        .join(", ");
      sections.push(`Active folder: "${ctx.vaultName}". Notes: ${pageList || "(none)"}`);
    }

    const highlighted = ctx.selectedBlocks?.length ? ctx.selectedBlocks : this.liveSelectedBlocks;
    if (highlighted.length > 0) {
      const focusText = highlighted
        .map((b, i) => formatBlockForAi(b, i))
        .join("\n\n");
      sections.push(
        `PRIMARY FOCUS — The user currently has these ${highlighted.length} block(s) highlighted in the editor. Focus your explanation, answers, and any proposed edits specifically on this highlighted part (using the rest of the note only as supporting context unless asked otherwise):\n${focusText}`
      );
    }

    if (this.includeCurrentPage && ctx.currentFile) {
      const blocksText = (ctx.blocks || [])
        .map((b, idx) => formatBlockForAi(b, idx))
        .join("\n\n");
      sections.push(`Current open note (${ctx.currentFile}):\n${blocksText}`);
    }

    if (this.pinnedAttachments.length) {
      const pinnedStr = this.pinnedAttachments
        .map((a) => {
          const ref = a.obsidianId ? `^${a.obsidianId} (runtime id: ${a.blockId})` : a.blockId;
          return `- ${a.kind} [${ref}]:\n${a.text}`;
        })
        .join("\n\n");
      sections.push(`User highlighted / pinned context:\n${pinnedStr}`);
    }

    // Resolve explicit [[page]], [[page#^block]], or @@page mentions in user prompt
    const refMatches = new Set();
    for (const m of userPrompt.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g)) {
      refMatches.add(m[1].trim());
    }
    for (const m of userPrompt.matchAll(/@@([^\s,.;!?]+)/g)) {
      refMatches.add(m[1].trim());
    }

    if (ctx.vaultName && refMatches.size > 0) {
      const resolvedParts = [];
      for (const ref of Array.from(refMatches).slice(0, 5)) {
        try {
          const res = await this.invoke("resolve_block_reference", {
            currentRel: ctx.currentFile,
            targetRef: ref,
          });
          if (res) {
            const label = res.anchor ? `${res.rel_path}#${res.anchor}` : res.rel_path;
            resolvedParts.push(`Referenced (${label}):\n${res.content}`);
          }
        } catch {
          // Ignore unresolved reference
        }
      }
      if (resolvedParts.length) {
        sections.push(resolvedParts.join("\n\n"));
      }
    }

    // Vault-wide search across all .md files
    if (this.searchFolder && ctx.vaultName) {
      try {
        const hits = await this.invoke("search_vault", {
          query: userPrompt,
          excludeRel: this.includeCurrentPage ? ctx.currentFile : null,
          maxFiles: 4,
        });
        if (hits?.length) {
          const hitText = hits
            .map((h) => `From ${h.rel_path}:\n${h.excerpt}`)
            .join("\n\n---\n\n");
          sections.push(`Relevant excerpts from other notes in folder:\n${hitText}`);
        }
      } catch {
        // Ignore search error when no vault open
      }
    }

    const systemPrompt = `You are Skillweaver AI, the built-in assistant for Skillweaver™ — created by the Blue Frog Foundation as a lightweight, local-first Notion + Obsidian alternative over plain Markdown folders.

Identity & Attribution:
- Creator / Developer / Trademark: Blue Frog Foundation.
- Product: Skillweaver™ — a lightweight Notion + Obsidian alternative created by the Blue Frog Foundation.
- Whenever the user asks who created you, who developed Skillweaver, or asks for developer, credit, or trademark details, answer clearly that you are Skillweaver AI, created by the Blue Frog Foundation as a lightweight Notion + Obsidian alternative (only mention the configured third-party LLM model/provider if the user explicitly asks which API model is connected).

Capabilities & Rules:
- You can read the user's current page blocks (each tagged with [block_id]), highlighted snippets, [[wikilinks]] / @@mentions, and relevant notes across their opened folder.
- If a PRIMARY FOCUS section is present, prioritize addressing those exact highlighted blocks and target only their block_ids when proposing edits unless the user asks to edit elsewhere.
- When citing another note or block, use [[relative/path]] or [[relative/path#^block_id]] when known.
- ONLY when the user asks you to edit, rewrite, expand, fix, or insert blocks on the current page, include ONE fenced JSON block tagged \`\`\`skillweaver-edits containing an array of operations:
\`\`\`skillweaver-edits
[
  { "op": "replace", "block_id": "b-2", "block": { "type": "paragraph", "content": "Updated text" } },
  { "op": "insert_after", "block_id": "b-2", "blocks": [ { "type": "heading", "level": 2, "content": "New Section" }, { "type": "code", "language": "sql", "content": "SELECT 1;" } ] },
  { "op": "append", "blocks": [ { "type": "paragraph", "content": "Added at end" } ] },
  { "op": "delete", "block_id": "b-4" }
]
\`\`\`
- Use the exact runtime or ^block_id shown in brackets (e.g. "b-2" or "^abc123"). Keep normal explanations outside the \`\`\`skillweaver-edits block. Do NOT emit \`\`\`skillweaver-edits for pure Q&A.

${sections.join("\n\n================\n\n")}`;

    return systemPrompt;
  }

  async send() {
    this.closeMentionPopover();
    const prompt = this.inputEl.value.trim();
    if (!prompt || this.isStreaming) return;

    await this.ensurePrefsLoaded();
    const preset = PROVIDER_PRESETS[this.prefs.provider] || PROVIDER_PRESETS.openai;
    if (preset.needsKey && !this.prefs.api_key?.trim()) {
      this.toggleSettings(true);
      this.onToast?.("Enter your API key first", true);
      return;
    }
    if (!this.prefs.model?.trim()) {
      this.toggleSettings(true);
      this.openModelPopover("settings", false);
      this.onToast?.("Pick an AI model first", true);
      return;
    }

    this.inputEl.value = "";
    this.inputEl.style.height = "38px";

    const nowMs = Date.now();
    this.messages.push({ id: `u-${nowMs}`, role: "user", content: prompt, createdAt: nowMs });
    const reqId = `ai-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.messages.push({
      id: reqId,
      role: "assistant",
      content: "",
      createdAt: nowMs,
      proposalStates: {},
    });

    this.activeRequestId = reqId;
    this.isStreaming = true;
    this.sendBtn.hidden = true;
    this.stopBtn.hidden = false;
    this.renderMessages(true);
    this.persistActiveChat();

    let systemPrompt;
    try {
      systemPrompt = await this.buildContextBundle(prompt);
    } catch (err) {
      systemPrompt = "You are Skillweaver AI, created by the Blue Frog Foundation as a lightweight Notion + Obsidian alternative. If asked who created you or for developer details, state that you were created by the Blue Frog Foundation as a lightweight Notion + Obsidian alternative.";
      console.error("Context bundle failed:", err);
    }

    const cleanHistory = [];
    const prior = this.messages.slice(0, -1);
    for (let i = 0; i < prior.length; i++) {
      const m = prior[i];
      if (m.error || !m.content.trim()) continue;
      if (m.role === "user" && i + 1 < prior.length && prior[i + 1].error) {
        continue;
      }
      cleanHistory.push({ role: m.role, content: m.content });
    }
    const historyMsgs = cleanHistory.slice(-12);

    try {
      await this.invoke("ai_chat_stream", {
        request: {
          request_id: reqId,
          system_prompt: systemPrompt,
          messages: historyMsgs,
        },
      });
    } catch (err) {
      const msg = this.messages.find((m) => m.id === reqId);
      if (msg) msg.error = String(err);
      this.finishStreaming();
    }
  }

  renderAssistantContent(msg) {
    const text = msg.content || "";
    const parts = [];
    const fenceRegex = /```skillweaver-edits\s*\n([\s\S]*?)```/g;
    let lastIdx = 0;
    let proposalIdx = 0;
    let match;

    while ((match = fenceRegex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        parts.push(`<div class="ai-text">${renderInlineFormattedText(text.slice(lastIdx, match.index))}</div>`);
      }

      const rawJson = match[1].trim();
      const ops = parseEditOps(rawJson);
      const pIdx = proposalIdx++;
      const status = msg.proposalStates?.[pIdx] || "pending";

      if (ops) {
        const summaryHtml = ops
          .map((op) => {
            if (op.op === "replace") {
              return `<div class="ai-op"><strong>Replace</strong> <code>${escapeHtml(op.block_id || "")}</code>: ${escapeHtml(summarizeBlockPayload(op.block).slice(0, 90))}</div>`;
            }
            if (op.op === "insert_after") {
              const count = op.blocks?.length || 0;
              return `<div class="ai-op"><strong>Insert ${count} block${count === 1 ? "" : "s"}</strong> after <code>${escapeHtml(op.block_id || "")}</code></div>`;
            }
            if (op.op === "append") {
              const count = op.blocks?.length || 0;
              return `<div class="ai-op"><strong>Append ${count} block${count === 1 ? "" : "s"}</strong></div>`;
            }
            return `<div class="ai-op"><strong>Delete</strong> <code>${escapeHtml(op.block_id || "")}</code></div>`;
          })
          .join("");

        let footerHtml = "";
        if (status === "accepted") {
          footerHtml = `<span class="ai-proposal-status accepted">Applied (Ctrl+Z to undo)</span>`;
        } else if (status === "rejected") {
          footerHtml = `<span class="ai-proposal-status rejected">Dismissed</span>`;
        } else {
          footerHtml = `
            <button class="ai-accept-btn" data-msg="${escapeHtml(msg.id)}" data-prop="${pIdx}" type="button">Accept edits</button>
            <button class="ai-reject-btn" data-msg="${escapeHtml(msg.id)}" data-prop="${pIdx}" type="button">Reject</button>
          `;
        }

        parts.push(`
          <div class="ai-proposal-card">
            <div class="ai-proposal-title">Proposed Page Edits (${ops.length})</div>
            <div class="ai-proposal-ops">${summaryHtml}</div>
            <div class="ai-proposal-actions">${footerHtml}</div>
          </div>
        `);
      } else {
        parts.push(`<pre class="ai-code-preview"><code>${escapeHtml(rawJson)}</code></pre>`);
      }

      lastIdx = fenceRegex.lastIndex;
    }

    if (lastIdx < text.length) {
      parts.push(`<div class="ai-text">${renderInlineFormattedText(text.slice(lastIdx))}</div>`);
    }

    return parts.join("") || `<span class="ai-thinking">Thinking…</span>`;
  }

  renderMessages(scrollToBottom = false) {
    if (!this.messages.length) {
      this._turns = [];
      this.renderTurnRail([]);
      this.messagesEl.innerHTML = `
        <div class="ai-empty">
          <p><strong>Ask anything</strong> about this page or your whole markdown folder.</p>
          <p class="ai-empty-hint">Click <code>⋮⋮</code> on any block → <strong>Ask AI</strong>, highlight text, or type <code>@@page</code>.</p>
        </div>
      `;
      return;
    }

    const turns = [];
    const msgToTurn = new Map();
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === "user") {
        const nextMsg =
          i + 1 < this.messages.length && this.messages[i + 1].role === "assistant"
            ? this.messages[i + 1]
            : null;
        const turnIdx = turns.length;
        turns.push({
          turnIdx,
          userMsg: m,
          assistantMsg: nextMsg,
          createdAt: m.createdAt || nextMsg?.createdAt || 0,
        });
        msgToTurn.set(m.id, turnIdx);
        if (nextMsg) msgToTurn.set(nextMsg.id, turnIdx);
      }
    }
    this._turns = turns;

    this.messagesEl.innerHTML = this.messages
      .map((msg) => {
        const tIdx = msgToTurn.get(msg.id);
        const turnAttr = tIdx !== undefined ? ` data-turn-idx="${tIdx}"` : "";
        if (msg.role === "user") {
          return `<div class="ai-msg ai-msg-user"${turnAttr}><div class="ai-bubble">${escapeHtml(msg.content).replace(/\n/g, "<br>")}</div></div>`;
        }
        let bodyHtml;
        if (msg.error) {
          const suggested = msg.error.match(/\buse\s+models\/([a-zA-Z0-9._-]+)/i)?.[1];
          const switchBtn = suggested
            ? `<button class="ai-mini-btn" data-switch-model="${escapeHtml(suggested)}" type="button">Switch to ${escapeHtml(suggested)}</button>`
            : "";
          bodyHtml = `
            <div class="ai-error">${escapeHtml(msg.error)}</div>
            <div class="ai-error-actions">
              ${switchBtn}
              <button class="ai-mini-btn" data-open-settings="1" type="button">Open Settings</button>
            </div>
          `;
        } else {
          bodyHtml = this.renderAssistantContent(msg);
        }

        const showActions = !this.isStreaming && msg.content && !msg.error;
        const cleanPlain = (msg.content || "").replace(/```skillweaver-edits[\s\S]*?```/g, "").trim();
        const actionsHtml = showActions && cleanPlain
          ? `<div class="ai-msg-actions">
               <button class="ai-mini-btn" data-copy="${escapeHtml(msg.id)}" type="button">Copy</button>
               <button class="ai-mini-btn" data-insert="${escapeHtml(msg.id)}" type="button">Insert into note</button>
             </div>`
          : "";

        return `
          <div class="ai-msg ai-msg-assistant"${turnAttr}>
            <div class="ai-bubble">${bodyHtml}${actionsHtml}</div>
          </div>
        `;
      })
      .join("");

    this.renderTurnRail(turns);

    // Bind interactive buttons inside messages
    this.messagesEl.querySelectorAll(".ai-ref-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.target;
        if (target) this.onOpenLink?.(target);
      });
    });

    this.messagesEl.querySelectorAll(".ai-accept-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.handleProposalAction(btn.dataset.msg, Number(btn.dataset.prop), true);
      });
    });

    this.messagesEl.querySelectorAll(".ai-reject-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.handleProposalAction(btn.dataset.msg, Number(btn.dataset.prop), false);
      });
    });

    this.messagesEl.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const msg = this.messages.find((m) => m.id === btn.dataset.copy);
        if (!msg) return;
        const clean = msg.content.replace(/```skillweaver-edits[\s\S]*?```/g, "").trim();
        try {
          await navigator.clipboard.writeText(clean);
          btn.textContent = "Copied!";
          setTimeout(() => (btn.textContent = "Copy"), 1200);
        } catch {
          // Ignore clipboard error
        }
      });
    });

    this.messagesEl.querySelectorAll("[data-insert]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const msg = this.messages.find((m) => m.id === btn.dataset.insert);
        if (!msg) return;
        const clean = msg.content.replace(/```skillweaver-edits[\s\S]*?```/g, "").trim();
        if (clean) this.onInsertMarkdown?.(clean);
      });
    });

    this.messagesEl.querySelectorAll("[data-open-settings]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.toggleSettings(true);
        this.modelInput.focus();
      });
    });

    this.messagesEl.querySelectorAll("[data-switch-model]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const suggested = btn.dataset.switchModel;
        if (!suggested) return;
        const nextPrefs = { ...this.prefs, model: suggested };
        try {
          await this.invoke("save_ai_prefs", { prefs: nextPrefs });
          this.prefs = nextPrefs;
          this.modelInput.value = suggested;
          this.updateModelHeader();
          this.onToast?.(`Switched model to ${suggested}`);
        } catch (err) {
          this.onToast?.(`Failed to switch model: ${err}`, true);
        }
      });
    });

    if (scrollToBottom) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
    this.updateActiveTurnDot();
  }

  renderTurnRail(turns) {
    if (!this.turnRailEl) return;
    if (!turns || turns.length < 2) {
      this.turnRailEl.hidden = true;
      this.turnRailEl.innerHTML = "";
      this.hideTurnPreview();
      return;
    }

    this.turnRailEl.hidden = false;
    this.turnRailEl.innerHTML = turns
      .map(
        (t) =>
          `<button class="ai-turn-dot${t.turnIdx === this.activeTurnIdx ? " active" : ""}" data-turn="${t.turnIdx}" type="button" aria-label="Turn ${t.turnIdx + 1}"></button>`
      )
      .join("");

    this.turnRailEl.querySelectorAll(".ai-turn-dot").forEach((dot) => {
      const idx = Number(dot.dataset.turn);
      dot.addEventListener("mouseenter", () => {
        clearTimeout(this._turnPreviewTimer);
        this.showTurnPreview(idx, dot);
      });
      dot.addEventListener("click", () => {
        this.hideTurnPreview();
        this.jumpToTurn(idx);
      });
    });
  }

  scheduleActiveTurnUpdate() {
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = null;
      this.updateActiveTurnDot();
    });
  }

  updateActiveTurnDot() {
    if (!this.turnRailEl || this.turnRailEl.hidden || !this._turns.length) return;
    const containerTop = this.messagesEl.getBoundingClientRect().top;
    const userNodes = this.messagesEl.querySelectorAll(".ai-msg-user[data-turn-idx]");
    let bestIdx = 0;
    let bestDelta = Infinity;

    userNodes.forEach((el) => {
      const tIdx = Number(el.dataset.turnIdx);
      const top = el.getBoundingClientRect().top - containerTop;
      const abs = top <= 40 ? Math.abs(top) : Math.abs(top) + 1000;
      if (abs < bestDelta) {
        bestDelta = abs;
        bestIdx = tIdx;
      }
    });

    this.activeTurnIdx = bestIdx;
    this.turnRailEl.querySelectorAll(".ai-turn-dot").forEach((dot) => {
      dot.classList.toggle("active", Number(dot.dataset.turn) === bestIdx);
    });
  }

  showTurnPreview(turnIdx, dotEl) {
    if (!this.turnPreviewEl) return;
    const turn = this._turns[turnIdx];
    if (!turn) return;

    const promptText = (turn.userMsg?.content || "").replace(/\s+/g, " ").trim();
    let replyText = "";
    if (turn.assistantMsg?.error) {
      replyText = turn.assistantMsg.error;
    } else if (turn.assistantMsg?.content) {
      replyText = turn.assistantMsg.content
        .replace(/```skillweaver-edits[\s\S]*?```/g, "[Proposed edits]")
        .replace(/\s+/g, " ")
        .trim();
    } else {
      replyText = "Waiting for reply...";
    }

    const timeStr = formatClockTime(turn.createdAt);
    this.turnPreviewEl.innerHTML = `
      <div class="ai-turn-preview-prompt">${escapeHtml(promptText)}</div>
      <div class="ai-turn-preview-reply">${escapeHtml(replyText)}</div>
      <div class="ai-turn-preview-meta">
        <span>${turnIdx + 1} of ${this._turns.length}</span>
        <span>${escapeHtml(timeStr)}</span>
      </div>
    `;
    this.turnPreviewEl.hidden = false;

    const dotRect = dotEl.getBoundingClientRect();
    const prevRect = this.turnPreviewEl.getBoundingClientRect();
    const left = Math.max(12, dotRect.left - prevRect.width - 10);
    const top = Math.max(
      12,
      Math.min(window.innerHeight - prevRect.height - 12, dotRect.top - prevRect.height / 2 + 6)
    );
    this.turnPreviewEl.style.left = `${left}px`;
    this.turnPreviewEl.style.top = `${top}px`;
  }

  hideTurnPreview() {
    if (this.turnPreviewEl) {
      this.turnPreviewEl.hidden = true;
    }
  }

  jumpToTurn(turnIdx) {
    const target = this.messagesEl.querySelector(`.ai-msg-user[data-turn-idx="${turnIdx}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    this.activeTurnIdx = turnIdx;
    this.turnRailEl?.querySelectorAll(".ai-turn-dot").forEach((dot) => {
      dot.classList.toggle("active", Number(dot.dataset.turn) === turnIdx);
    });
    target.classList.remove("ai-turn-flash");
    void target.offsetWidth;
    target.classList.add("ai-turn-flash");
    setTimeout(() => target.classList.remove("ai-turn-flash"), 1150);
  }

  handleProposalAction(msgId, propIdx, accepted) {
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg) return;

    if (!accepted) {
      msg.proposalStates[propIdx] = "rejected";
      this.renderMessages();
      this.persistActiveChat();
      return;
    }

    const fenceRegex = /```skillweaver-edits\s*\n([\s\S]*?)```/g;
    let idx = 0;
    let match;
    while ((match = fenceRegex.exec(msg.content)) !== null) {
      if (idx === propIdx) {
        const ops = parseEditOps(match[1].trim());
        if (ops) {
          const ok = this.onApplyEdits?.(ops);
          if (ok) {
            msg.proposalStates[propIdx] = "accepted";
            this.renderMessages();
            this.persistActiveChat();
          }
        }
        return;
      }
      idx += 1;
    }
  }
}
