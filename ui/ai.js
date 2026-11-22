import { displayNameForLink, escapeHtml } from "./inline.js";
import { filterPages } from "./links.js";

const PROVIDER_PRESETS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "o3-mini"],
    needsKey: true,
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-3.8-flash",
    models: [
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-4-hydrogen",
      "gemini-4-neon",
    ],
    needsKey: true,
  },
  anthropic: {
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-3-5-sonnet-latest",
    models: ["claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest", "claude-3-5-haiku-latest"],
    needsKey: true,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "openai/gpt-4o-mini",
    models: ["openai/gpt-4o-mini", "google/gemini-3.8-flash", "anthropic/claude-3.5-sonnet"],
    needsKey: true,
  },
  ollama: {
    label: "Ollama (Local)",
    baseUrl: "http://localhost:11434/v1/chat/completions",
    defaultModel: "llama3.2",
    models: ["llama3.2", "qwen2.5-coder", "mistral"],
    needsKey: false,
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "http://localhost:1234/v1/chat/completions",
    defaultModel: "local-model",
    models: ["local-model"],
    needsKey: false,
  },
};

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
    }
  ) {
    this.panelEl = panelEl;
    this.resizerEl = resizerEl;
    this.toggleBtn = toggleBtn;
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

    this.openState = false;
    this.prefs = {
      provider: "openai",
      api_key: "",
      base_url: PROVIDER_PRESETS.openai.baseUrl,
      model: PROVIDER_PRESETS.openai.defaultModel,
    };
    this.prefsLoaded = false;

    this.includeCurrentPage = true;
    this.searchFolder = true;
    this.pinnedAttachments = []; // { id, kind: "block"|"selection", label, blockId, text }
    this.liveSelectedBlocks = [];
    this.messages = []; // { id, role, content, error?, proposalStates? }
    this.activeRequestId = null;
    this.isStreaming = false;
    this.cachedModelsByProvider = new Map();
    this.modelPickerOpen = false;
    this.modelPickerTarget = "header";
    this.modelFilterText = "";
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
    clearBtn.addEventListener("click", () => this.clearChat());
    closeBtn.addEventListener("click", () => this.close());

    toggleKeyVisBtn.addEventListener("click", () => {
      this.apiKeyInput.type = this.apiKeyInput.type === "password" ? "text" : "password";
    });

    this.providerSelect.addEventListener("change", () => {
      const preset = PROVIDER_PRESETS[this.providerSelect.value];
      if (preset) {
        this.baseUrlInput.value = preset.baseUrl;
        this.modelInput.value = preset.defaultModel;
      }
      this.updateModelHeader(this.providerSelect.value);
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

  updateModelHeader(providerOverride = null) {
    const providerKey = providerOverride || this.prefs.provider || "openai";
    const preset = PROVIDER_PRESETS[providerKey] || PROVIDER_PRESETS.openai;
    if (this.modelBadgeEl) {
      this.modelBadgeEl.textContent = this.prefs.model?.trim() || preset.defaultModel || "Configure";
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
      (useSettings ? this.modelInput.value.trim() : this.prefs.model?.trim()) || preset.defaultModel;
    return { provider, baseUrl, apiKey, currentModel, cacheKey: `${provider}::${baseUrl}` };
  }

  getAvailableModels(providerKey, cacheKey, currentModel) {
    const preset = PROVIDER_PRESETS[providerKey] || PROVIDER_PRESETS.openai;
    const seen = new Set();
    const out = [];

    const cached = this.cachedModelsByProvider.get(cacheKey);
    if (Array.isArray(cached)) {
      for (const m of cached) {
        if (m?.id && !seen.has(m.id)) {
          seen.add(m.id);
          out.push({ id: m.id, label: m.label || m.id, live: true });
        }
      }
    }

    for (const id of preset.models || [preset.defaultModel]) {
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push({ id, label: id, live: false });
      }
    }

    if (currentModel && !seen.has(currentModel)) {
      seen.add(currentModel);
      out.push({ id: currentModel, label: currentModel, live: false });
    }

    return out;
  }

  async fetchLiveModels(providerOverride = null, silent = false) {
    const ctx = this.getActiveModelProviderContext(this.modelPickerTarget);
    const provider = providerOverride || ctx.provider;
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
    const baseUrl = ctx.baseUrl || preset.baseUrl;
    const cacheKey = `${provider}::${baseUrl}`;

    if (preset.needsKey && !ctx.apiKey) {
      if (!silent) this.onToast?.("Enter your API key first to fetch live models", true);
      return;
    }

    this.isFetchingModels = true;
    if (this.modelPickerOpen) this.renderModelPopover();

    try {
      const list = await this.invoke("ai_list_models", {
        request: {
          provider,
          api_key: ctx.apiKey,
          base_url: baseUrl,
        },
      });
      this.cachedModelsByProvider.set(cacheKey, Array.isArray(list) ? list : []);
      if (!silent) {
        this.onToast?.(`Loaded ${(list || []).length} models`);
      }
    } catch (err) {
      if (!silent) {
        this.onToast?.(`Failed to load models: ${err}`, true);
      }
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
      !this.cachedModelsByProvider.has(ctx.cacheKey) &&
      (ctx.apiKey || ctx.provider === "ollama")
    ) {
      this.fetchLiveModels(ctx.provider, true);
    }
  }

  closeModelPopover() {
    this.modelPickerOpen = false;
    this.modelFilterText = "";
    if (this.modelPopoverEl) {
      this.modelPopoverEl.hidden = true;
      this.modelPopoverEl.innerHTML = "";
    }
  }

  renderModelPopover() {
    if (!this.modelPopoverEl || !this.modelPickerOpen) return;
    const ctx = this.getActiveModelProviderContext(this.modelPickerTarget);
    const allModels = this.getAvailableModels(ctx.provider, ctx.cacheKey, ctx.currentModel);
    const q = this.modelFilterText.trim().toLowerCase();
    const filtered = q
      ? allModels.filter(
          (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)
        )
      : allModels;

    const listHtml = filtered.length
      ? filtered
          .map((m) => {
            const isSel = m.id === ctx.currentModel;
            const sub = m.label !== m.id ? m.label : m.live ? "Live" : "Preset";
            return `
              <button class="popover-item${isSel ? " selected" : ""}" data-model-id="${escapeHtml(m.id)}" type="button" role="option">
                <span class="popover-item-main">
                  <span class="popover-item-title">${isSel ? "✓ " : ""}${escapeHtml(m.id)}</span>
                </span>
                <span class="popover-item-sub">${escapeHtml(sub)}</span>
              </button>
            `;
          })
          .join("")
      : `<div class="popover-section-label">No matching models</div>`;

    const existingFilter = this.modelPopoverEl.querySelector(".ai-model-filter");
    if (existingFilter) {
      const listEl = this.modelPopoverEl.querySelector(".ai-model-popover-list");
      const refreshBtn = this.modelPopoverEl.querySelector("[data-refresh-models]");
      if (listEl) listEl.innerHTML = listHtml;
      if (refreshBtn) refreshBtn.textContent = this.isFetchingModels ? "…" : "↻ Fetch";
    } else {
      this.modelPopoverEl.innerHTML = `
        <div class="ai-model-popover-header">
          <input class="ai-model-filter" type="text" placeholder="Filter ${allModels.length} models..." value="${escapeHtml(this.modelFilterText)}" autocomplete="off" />
          <button class="top-text-btn" data-refresh-models="1" type="button" title="Fetch live models from provider">${this.isFetchingModels ? "…" : "↻ Fetch"}</button>
        </div>
        <div class="ai-model-popover-list">${listHtml}</div>
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
      const loaded = await this.invoke("get_ai_prefs");
      if (loaded) {
        this.prefs = { ...this.prefs, ...loaded };
      }
      this.prefsLoaded = true;
      this.syncSettingsInputs();
      const preset = PROVIDER_PRESETS[this.prefs.provider] || PROVIDER_PRESETS.openai;
      if (preset.needsKey && !this.prefs.api_key?.trim()) {
        this.settingsDrawerEl.hidden = false;
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
    this.settingsDrawerEl.hidden = nextHidden;
    this.settingsBtn?.classList.toggle("active", !nextHidden);
    if (!nextHidden) {
      this.syncSettingsInputs();
      this.apiKeyInput.focus();
    }
  }

  async saveSettings() {
    const nextPrefs = {
      provider: this.providerSelect.value,
      api_key: this.apiKeyInput.value.trim(),
      base_url: this.baseUrlInput.value.trim(),
      model: this.modelInput.value.trim(),
    };
    try {
      await this.invoke("save_ai_prefs", { prefs: nextPrefs });
      this.prefs = nextPrefs;
      this.updateModelHeader();
      this.settingsDrawerEl.hidden = true;
      this.settingsBtn?.classList.remove("active");
      this.onToast?.("AI settings saved");
    } catch (err) {
      this.onToast?.(`Failed to save AI settings: ${err}`, true);
    }
  }

  clearChat() {
    if (this.isStreaming) this.cancel();
    this.messages = [];
    this.pinnedAttachments = [];
    this.renderChips();
    this.renderMessages();
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

    const systemPrompt = `You are Skillweaver AI, a concise Notion + Obsidian workspace assistant embedded in a markdown block editor.

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

    this.inputEl.value = "";
    this.inputEl.style.height = "38px";

    this.messages.push({ id: `u-${Date.now()}`, role: "user", content: prompt });
    const reqId = `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.messages.push({ id: reqId, role: "assistant", content: "", proposalStates: {} });

    this.activeRequestId = reqId;
    this.isStreaming = true;
    this.sendBtn.hidden = true;
    this.stopBtn.hidden = false;
    this.renderMessages(true);

    let systemPrompt;
    try {
      systemPrompt = await this.buildContextBundle(prompt);
    } catch (err) {
      systemPrompt = "You are Skillweaver AI.";
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
      this.messagesEl.innerHTML = `
        <div class="ai-empty">
          <p><strong>Ask anything</strong> about this page or your whole markdown folder.</p>
          <p class="ai-empty-hint">Click <code>⋮⋮</code> on any block → <strong>Ask AI</strong>, highlight text, or type <code>@@page</code>.</p>
        </div>
      `;
      return;
    }

    this.messagesEl.innerHTML = this.messages
      .map((msg) => {
        if (msg.role === "user") {
          return `<div class="ai-msg ai-msg-user"><div class="ai-bubble">${escapeHtml(msg.content).replace(/\n/g, "<br>")}</div></div>`;
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
          <div class="ai-msg ai-msg-assistant">
            <div class="ai-bubble">${bodyHtml}${actionsHtml}</div>
          </div>
        `;
      })
      .join("");

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
  }

  handleProposalAction(msgId, propIdx, accepted) {
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg) return;

    if (!accepted) {
      msg.proposalStates[propIdx] = "rejected";
      this.renderMessages();
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
          }
        }
        return;
      }
      idx += 1;
    }
  }
}
