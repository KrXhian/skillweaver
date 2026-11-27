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

import { escapeHtml } from "../inline.js";
import {
  STATIC_SYSTEM_PROMPT,
  buildContextPayload,
  buildOutgoingHistory,
  getContextBudgets,
} from "./context.js";
import {
  extractEditFences,
  extractSkillFences,
  parseEditOps,
  parseSkillProposal,
  renderAssistantContentHtml,
  renderUserMessageHtml,
  stripEditFences,
  summarizeBlockPayload,
} from "./edits.js";
import { AiHistoryDrawer, deriveChatTitle } from "./history.js";
import {
  AiMentionPopover,
  createAiSkillChipEl,
  handleComposerChipBackspace,
  insertPlainTextIntoComposer,
  normalizeEmptyComposer,
  serializeComposerToPrompt,
} from "./mentions.js";
import { AiModelPicker, PROVIDER_PRESETS, canonicalCacheKey } from "./models.js";
import { AiSkillsDrawer } from "./skills.js";
import { AiTurnRail } from "./turns.js";

function tauriListen(eventName, handler) {
  const listenFn = window.__TAURI__?.event?.listen;
  if (!listenFn) return Promise.resolve(() => {});
  return listenFn(eventName, handler);
}

/**
 * Right-side BYOK AI chat drawer with block/selection chips, skills, vault search, and Accept/Reject edits.
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
      skillsBtn,
      skillsDrawerEl,
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
      onOpenRawFile,
      onVaultChanged,
      onConfirmDeleteSkill,
      onToast,
      onClearEditorSelection,
      onPromptRenameChat,
    }
  ) {
    this.panelEl = panelEl;
    this.resizerEl = resizerEl;
    this.toggleBtn = toggleBtn;
    this.settingsBtn = settingsBtn;
    this.settingsDrawerEl = settingsDrawerEl;
    this.providerSelect = providerSelect;
    this.apiKeyInput = apiKeyInput;
    this.baseUrlInput = baseUrlInput;
    this.modelInput = modelInput;
    this.messagesEl = messagesEl;
    this.chipsEl = chipsEl;
    this.inputEl = inputEl;
    this.sendBtn = sendBtn;
    this.stopBtn = stopBtn;

    this.invoke = invoke;
    this.getCurrentContext = getCurrentContext;
    this.onResizeEnd = onResizeEnd;
    this.onApplyEdits = onApplyEdits;
    this.onInsertMarkdown = onInsertMarkdown;
    this.onOpenLink = onOpenLink;
    this.onOpenRawFile = onOpenRawFile;
    this.onVaultChanged = onVaultChanged;
    this.onConfirmDeleteSkill = onConfirmDeleteSkill;
    this.onToast = onToast;
    this.onClearEditorSelection = onClearEditorSelection;

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
    this.pinnedAttachments = []; // { id, kind: "block"|"selection", label, blockId, anchorId, text }
    this.liveSelectedBlocks = [];
    this.skills = [];
    this.skillsLoaded = false;
    this.pinnedSkillIds = [];
    this.messages = []; // { id, role, content, createdAt?, error?, sourceFile?, finishReason?, proposalStates? }
    this.activeChatId = null;
    this.activeChatTitle = "";
    this.activeChatPinned = false;
    this.activeChatCreatedAt = 0;
    this.activeChatVaultPath = "";
    this.activeChatVaultName = "";

    this._streamRaf = null;
    this._pendingStreamMsgId = null;
    this._autoScrollLocked = true;
    this._applyingProposal = false;
    this.activeRequestId = null;
    this.isStreaming = false;

    this.modelPicker = new AiModelPicker(
      {
        panelEl,
        modelBadgeEl,
        modelPopoverEl,
        settingsDrawerEl,
        providerSelect,
        apiKeyInput,
        baseUrlInput,
        modelInput,
        pickModelBtn,
        fetchModelsBtn,
      },
      {
        invoke,
        getPrefs: () => this.prefs,
        setPrefs: (next) => {
          this.prefs = next;
        },
        onToast,
      }
    );

    this.historyDrawer = new AiHistoryDrawer(
      { historyBtn, historyDrawerEl, newChatBtn, historySearchEl, historyListEl },
      {
        invoke,
        getCurrentContext,
        getActiveChatId: () => this.activeChatId,
        onBeforeOpen: () => {
          if (!this.settingsDrawerEl.hidden) {
            this.settingsDrawerEl.hidden = true;
            this.settingsBtn?.classList.remove("active");
          }
          if (this.skillsDrawer.isDrawerOpen()) {
            this.skillsDrawer.toggle(false);
          }
          this.modelPicker.close();
          this.turnRail.hidePreview();
        },
        onOpenChat: (chatId) => this.openChat(chatId),
        onStartNewChat: () => this.startNewChat(),
        onActiveMetaChanged: ({ title, pinned }) => {
          if (title !== undefined) this.activeChatTitle = title;
          if (pinned !== undefined) this.activeChatPinned = pinned;
        },
        onActiveChatDeleted: async () => {
          this.startNewChat();
          await this.historyDrawer.toggle(true);
        },
        onPromptRenameChat,
        onToast,
      }
    );

    this.skillsDrawer = new AiSkillsDrawer(
      { skillsBtn, skillsDrawerEl },
      {
        invoke,
        getCurrentContext,
        getSkills: () => this.skills,
        setSkills: (list, opts) => this.setSkills(list, opts),
        getPinnedSkillIds: () => this.pinnedSkillIds,
        onTogglePinSkill: (skill, forceState = null) =>
          this.togglePinSkill(skill, forceState, true),
        onInsertSkillMention: (skill) => this.insertSkillMentionInComposer(skill),
        onHarvestChat: () => this.harvestSkillFromChat(),
        onOpenRawFile,
        onVaultChanged,
        onBeforeOpen: () => {
          if (!this.settingsDrawerEl.hidden) {
            this.settingsDrawerEl.hidden = true;
            this.settingsBtn?.classList.remove("active");
          }
          if (this.historyDrawer.isDrawerOpen()) {
            this.historyDrawer.toggle(false);
          }
          this.modelPicker.close();
          this.turnRail.hidePreview();
        },
        onOpenStateChange: () => this.renderChips(),
        onConfirmDelete: onConfirmDeleteSkill,
        onToast,
      }
    );

    this.turnRail = new AiTurnRail({ turnRailEl, turnPreviewEl, messagesEl });

    this.mentions = new AiMentionPopover({
      inputEl,
      mentionPopoverEl,
      getPages: () => this.getCurrentContext?.().pages || [],
      getCurrentFile: () => this.getCurrentContext?.().currentFile || "",
      getSkills: () => this.skills,
      getPinnedSkillIds: () => this.pinnedSkillIds,
      onPinSkill: (skill) => {
        const nowPinned = this.togglePinSkill(skill, null, true);
        this.onToast?.(
          nowPinned ? `Pinned @${skill.slug} to conversation` : `Unpinned @${skill.slug}`
        );
      },
      onCreateSkill: (query) => {
        this.skillsDrawer.openCreateForm({
          slug: query,
          name: query,
        });
      },
    });

    settingsBtn.addEventListener("click", () => this.toggleSettings());
    clearBtn.addEventListener("click", () => this.startNewChat());
    closeBtn.addEventListener("click", () => this.close());

    this.messagesEl.addEventListener(
      "scroll",
      () => {
        if (this.isStreaming) {
          this._autoScrollLocked = this.isNearBottom(48);
        }
        this.turnRail.scheduleActiveUpdate();
      },
      { passive: true }
    );
    this.messagesEl.addEventListener("click", (e) => this.handleMessagesClick(e));

    toggleKeyVisBtn.addEventListener("click", () => {
      this.apiKeyInput.type = this.apiKeyInput.type === "password" ? "text" : "password";
    });

    this.providerSelect.addEventListener("change", () => {
      const nextProvider = this.providerSelect.value;
      const preset = PROVIDER_PRESETS[nextProvider];
      if (preset) {
        this.baseUrlInput.value = preset.baseUrl;
        const best = this.modelPicker.getBestCachedModel(nextProvider, preset.baseUrl);
        this.modelInput.value = best ? best.id : "";
        if (!preset.needsKey || this.apiKeyInput.value.trim()) {
          const cacheKey = canonicalCacheKey(nextProvider, preset.baseUrl);
          if (!this.modelPicker.isCacheFresh(cacheKey)) {
            this.modelPicker.fetchLiveModels(nextProvider, true);
          }
        }
      }
      this.modelPicker.updateHeader(nextProvider);
    });

    saveSettingsBtn.addEventListener("click", () => this.saveSettings());

    this.sendBtn.addEventListener("click", () => this.send());
    this.stopBtn.addEventListener("click", () => this.cancel());

    this.inputEl.addEventListener("keydown", (e) => {
      if (this.mentions.handleKeydown(e)) {
        return;
      }
      if (handleComposerChipBackspace(this.inputEl, e)) {
        this.mentions.inspectCaret();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    this.inputEl.addEventListener("input", () => {
      normalizeEmptyComposer(this.inputEl);
      this.mentions.inspectCaret();
    });

    this.inputEl.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") || "";
      if (text) {
        insertPlainTextIntoComposer(this.inputEl, text);
        normalizeEmptyComposer(this.inputEl);
        this.mentions.inspectCaret();
      }
    });

    this.inputEl.addEventListener("click", () => this.mentions.inspectCaret());
    this.inputEl.addEventListener("keyup", (e) => {
      if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "Home" ||
        e.key === "End"
      ) {
        this.mentions.inspectCaret();
      }
    });

    this.initResizer();
    this.initStreamListener();
    this.modelPicker.updateHeader();
    this.ensurePrefsLoaded();
    this.renderChips();
    this.renderMessages();
  }

  setSkills(list, opts = {}) {
    this.skills = Array.isArray(list) ? list : [];
    this.skillsLoaded = true;

    if (opts?.renamedFrom && opts?.renamedTo) {
      this.pinnedSkillIds = this.pinnedSkillIds.map((id) =>
        id === opts.renamedFrom ? opts.renamedTo : id
      );
    }

    const validIds = new Set(this.skills.map((s) => s.id));
    const pruned = [];
    const seen = new Set();
    for (const id of this.pinnedSkillIds) {
      if (validIds.has(id) && !seen.has(id)) {
        seen.add(id);
        pruned.push(id);
      }
    }
    this.pinnedSkillIds = pruned;

    this.renderChips();
    this.skillsDrawer.refresh();
    if (!this.isStreaming && this.messages.length > 0) {
      this.renderMessages();
    }
  }

  async refreshSkills() {
    try {
      const list = await this.invoke("ai_list_skills");
      if (Array.isArray(list)) {
        this.setSkills(list);
      }
    } catch {
      // Ignore skill refresh errors when backend is unavailable
    }
  }

  togglePinSkill(skillOrId, forceState = null, persistNow = true) {
    const id = typeof skillOrId === "string" ? skillOrId : skillOrId?.id;
    if (!id) return false;

    const currentlyPinned = this.pinnedSkillIds.includes(id);
    const shouldPin = forceState === null ? !currentlyPinned : Boolean(forceState);
    if (shouldPin && !currentlyPinned) {
      this.pinnedSkillIds = [...this.pinnedSkillIds, id];
    } else if (!shouldPin && currentlyPinned) {
      this.pinnedSkillIds = this.pinnedSkillIds.filter((x) => x !== id);
    }

    this.renderChips();
    this.skillsDrawer.refresh();
    if (persistNow && this.messages.length > 0) {
      this.persistActiveChat();
    }
    return shouldPin;
  }

  insertSkillMentionInComposer(skill) {
    if (!skill || !this.inputEl) return;
    if (this.skillsDrawer.isDrawerOpen()) {
      this.skillsDrawer.toggle(false);
    }

    const chip = createAiSkillChipEl(skill.slug, skill.id, skill.description || "");
    const spaceNode = document.createTextNode(" ");
    const frag = document.createDocumentFragment();
    frag.appendChild(chip);
    frag.appendChild(spaceNode);

    this.inputEl.focus();
    const sel = window.getSelection();
    let range = null;
    if (sel && sel.rangeCount > 0 && this.inputEl.contains(sel.getRangeAt(0).startContainer)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(this.inputEl);
      range.collapse(false);
    }

    range.insertNode(frag);
    if (sel) {
      const next = document.createRange();
      next.setStart(spaceNode, 1);
      next.collapse(true);
      sel.removeAllRanges();
      sel.addRange(next);
    }
    normalizeEmptyComposer(this.inputEl);
    this.mentions.close();
  }

  isNearBottom(thresholdPx = 48) {
    if (!this.messagesEl) return true;
    const { scrollHeight, scrollTop, clientHeight } = this.messagesEl;
    return scrollHeight - scrollTop - clientHeight <= thresholdPx;
  }

  cancelPendingStreamRender() {
    if (this._streamRaf !== null) {
      cancelAnimationFrame(this._streamRaf);
      this._streamRaf = null;
    }
    this._pendingStreamMsgId = null;
  }

  scheduleStreamRender(msgId) {
    this._pendingStreamMsgId = msgId;
    if (this._streamRaf !== null) return;
    this._streamRaf = requestAnimationFrame(() => {
      this._streamRaf = null;
      const targetId = this._pendingStreamMsgId;
      this._pendingStreamMsgId = null;
      const msg = this.messages.find((m) => m.id === targetId);
      if (!msg) return;

      const rowEl = this.messagesEl?.querySelector(`.ai-msg[data-msg-id="${CSS.escape(msg.id)}"]`);
      const bubbleEl = rowEl?.querySelector(".ai-bubble");
      if (bubbleEl) {
        bubbleEl.innerHTML = renderAssistantContentHtml(msg, true);
        if (this._autoScrollLocked) {
          this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        }
      } else {
        this.renderMessages(this._autoScrollLocked);
      }
    });
  }

  async initStreamListener() {
    await tauriListen("ai-stream", (event) => {
      const payload = event?.payload;
      if (!payload || payload.request_id !== this.activeRequestId) return;

      const msg = this.messages.find((m) => m.id === payload.request_id);
      if (!msg) return;

      if (payload.kind === "delta") {
        msg.content += payload.text;
        this.scheduleStreamRender(msg.id);
      } else if (payload.kind === "error") {
        this.cancelPendingStreamRender();
        msg.error = payload.text || "Request failed";
        this.finishStreaming();
      } else if (payload.kind === "done") {
        this.cancelPendingStreamRender();
        if (payload.finish_reason) {
          msg.finishReason = payload.finish_reason;
        }
        this.finishStreaming();
      }
    });
  }

  finishStreaming() {
    this.cancelPendingStreamRender();
    this.isStreaming = false;
    this.activeRequestId = null;
    this.sendBtn.hidden = false;
    this.stopBtn.hidden = true;
    this.renderMessages(this._autoScrollLocked);
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
      const [loaded, cachedModels, chats, skills] = await Promise.all([
        this.invoke("get_ai_prefs"),
        this.invoke("get_cached_models").catch(() => ({})),
        this.invoke("ai_list_chats").catch(() => []),
        this.invoke("ai_list_skills").catch(() => []),
      ]);
      if (loaded) {
        this.prefs = { ...this.prefs, ...loaded };
      }
      this.modelPicker.setCache(cachedModels);
      if (Array.isArray(skills)) {
        this.skills = skills;
        this.skillsLoaded = true;
      }
      if (Array.isArray(chats)) {
        this.historyDrawer.setChats(chats);
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
      this.renderChips();
      const preset = PROVIDER_PRESETS[this.prefs.provider] || PROVIDER_PRESETS.openai;
      if (preset.needsKey && !this.prefs.api_key?.trim()) {
        this.settingsDrawerEl.hidden = false;
      } else {
        const cacheKey = canonicalCacheKey(this.prefs.provider, this.prefs.base_url);
        if (!this.modelPicker.isCacheFresh(cacheKey)) {
          this.modelPicker.fetchLiveModels(this.prefs.provider, true);
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
    this.modelPicker.updateHeader(this.providerSelect.value);
  }

  async open() {
    this.openState = true;
    this.panelEl.hidden = false;
    this.resizerEl.hidden = false;
    this.toggleBtn?.classList.add("active");
    await this.ensurePrefsLoaded();
    this.modelPicker.updateHeader();
    this.renderChips();
    this.inputEl.focus();
  }

  close() {
    this.openState = false;
    this.panelEl.hidden = true;
    this.resizerEl.hidden = true;
    this.toggleBtn?.classList.remove("active");
    this.mentions.close();
    this.modelPicker.close();
    this.turnRail.hidePreview();
  }

  toggle() {
    if (this.openState) this.close();
    else this.open();
  }

  toggleSettings(forceState = null) {
    const nextHidden = forceState === null ? !this.settingsDrawerEl.hidden : !forceState;
    if (!nextHidden && this.historyDrawer.isDrawerOpen()) {
      this.historyDrawer.toggle(false);
    }
    if (!nextHidden && this.skillsDrawer.isDrawerOpen()) {
      this.skillsDrawer.toggle(false);
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
      let best = this.modelPicker.getBestCachedModel(provider, base_url);
      if (!best) {
        const fetched = await this.modelPicker.fetchLiveModels(provider, true);
        best = fetched?.models?.find((m) => !m.is_snapshot) || fetched?.models?.[0] || null;
      }
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
      this.modelPicker.updateHeader();
      this.settingsDrawerEl.hidden = true;
      this.settingsBtn?.classList.remove("active");
      this.onToast?.("AI settings saved");
      if ((api_key || provider === "ollama") && !this.modelPicker.isCacheFresh(cacheKey)) {
        this.modelPicker.fetchLiveModels(provider, true);
      }
    } catch (err) {
      this.onToast?.(`Failed to save AI settings: ${err}`, true);
    }
  }

  clearChat() {
    this.startNewChat();
  }

  refreshHistoryView() {
    this.historyDrawer.refresh();
  }

  async toggleHistory(forceState = null) {
    await this.historyDrawer.toggle(forceState);
  }

  startNewChat() {
    this.cancelPendingStreamRender();
    if (this.isStreaming) this.cancel();
    this.activeChatId = null;
    this.activeChatTitle = "";
    this.activeChatPinned = false;
    this.activeChatCreatedAt = 0;
    this.activeChatVaultPath = "";
    this.activeChatVaultName = "";
    this.messages = [];
    this.pinnedAttachments = [];
    this.pinnedSkillIds = [];
    this.turnRail.hidePreview();
    if (this.historyDrawer.isDrawerOpen()) this.historyDrawer.toggle(false);
    this.renderChips();
    this.skillsDrawer.refresh();
    this.renderMessages();
    if (this.openState) this.inputEl?.focus();
  }

  async openChat(chatId, closeDrawer = true) {
    if (!chatId) return;
    this.cancelPendingStreamRender();
    if (this.isStreaming) await this.cancel();
    try {
      const session = await this.invoke("ai_load_chat", { chatId });
      this.activeChatId = session.id;
      this.activeChatTitle = session.title || "Conversation";
      this.activeChatPinned = Boolean(session.pinned);
      this.activeChatCreatedAt = session.created_at || Math.floor(Date.now() / 1000);
      this.activeChatVaultPath = session.vault_path || "";
      this.activeChatVaultName = session.vault_name || "";
      this.pinnedSkillIds = Array.isArray(session.pinned_skills)
        ? session.pinned_skills.filter((id) => typeof id === "string" && id.trim())
        : [];
      if (this.skillsLoaded) {
        const validIds = new Set(this.skills.map((s) => s.id));
        this.pinnedSkillIds = this.pinnedSkillIds.filter((id) => validIds.has(id));
      }
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
          ...(m.source_file ? { sourceFile: m.source_file } : {}),
          ...(m.finish_reason ? { finishReason: m.finish_reason } : {}),
          proposalStates,
        };
      });
      this.pinnedAttachments = [];
      this.turnRail.hidePreview();
      if (closeDrawer && this.historyDrawer.isDrawerOpen()) this.historyDrawer.toggle(false);
      this.renderChips();
      this.skillsDrawer.refresh();
      this.renderMessages(true);
      this.historyDrawer.refresh();
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
      pinned_skills: this.pinnedSkillIds.slice(),
      messages: this.messages.map((m) => {
        const proposal_states = {};
        for (const [k, v] of Object.entries(m.proposalStates || {})) {
          proposal_states[String(k)] = String(v);
        }
        const createdAtSec = m.createdAt
          ? m.createdAt > 1e12
            ? Math.floor(m.createdAt / 1000)
            : Math.floor(m.createdAt)
          : nowSec;
        return {
          id: m.id,
          role: m.role,
          content: m.content || "",
          created_at: createdAtSec,
          error: m.error || null,
          proposal_states,
          source_file: m.sourceFile || null,
          finish_reason: m.finishReason || null,
        };
      }),
    };

    try {
      const updated = await this.invoke("ai_save_chat", { session });
      if (Array.isArray(updated)) {
        this.historyDrawer.setChats(updated);
        this.historyDrawer.refresh();
      }
    } catch (err) {
      console.error("Failed to persist chat:", err);
    }
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
        anchorId: block.block_id || null,
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
      this.inputEl.dataset.placeholder =
        count > 0
          ? `Ask about these ${count} highlighted block${count === 1 ? "" : "s"}...`
          : "Ask AI, @skill, or @@page...";
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
      anchorId: block?.block_id || null,
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

    const skillById = new Map(this.skills.map((s) => [s.id, s]));
    const activePinnedSkills = this.pinnedSkillIds
      .map((id) => skillById.get(id))
      .filter(Boolean);
    const skillsTriggerActive = this.skillsDrawer.isDrawerOpen() || activePinnedSkills.length > 0;
    const skillsBadgeLabel = activePinnedSkills.length > 0
      ? `✦ Skills (${activePinnedSkills.length})`
      : "✦ Skills";

    parts.push(
      `<button class="ai-chip ai-skills-trigger${skillsTriggerActive ? " active" : ""}" data-chip="skills" type="button" title="Manage, create, or pin AI skills (@skill)">${skillsBadgeLabel}</button>`
    );

    for (const skill of activePinnedSkills) {
      const tip = skill.description
        ? `@${skill.slug} (${skill.scope}) — ${skill.description}`
        : `@${skill.slug} (${skill.scope})`;
      parts.push(`
        <span class="ai-chip ai-skill-chip" data-open-skill="${escapeHtml(skill.id)}" title="${escapeHtml(tip)}">
          <span class="ai-chip-label">✦ @${escapeHtml(skill.slug)}</span>
          <button class="ai-chip-remove" data-unpin-skill="${escapeHtml(skill.id)}" type="button" title="Unpin skill">×</button>
        </span>
      `);
    }

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
    this.chipsEl.querySelector('[data-chip="skills"]')?.addEventListener("click", () => {
      this.skillsDrawer.toggle();
    });
    this.chipsEl.querySelectorAll("[data-open-skill]").forEach((chip) => {
      chip.addEventListener("click", (e) => {
        if (e.target.closest("[data-unpin-skill]")) return;
        const skill = this.skills.find((s) => s.id === chip.dataset.openSkill);
        if (skill) {
          this.skillsDrawer.openEditForm(skill);
        }
      });
    });
    this.chipsEl.querySelectorAll("[data-unpin-skill]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.togglePinSkill(btn.dataset.unpinSkill, false, true);
      });
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
    this.cancelPendingStreamRender();
    try {
      await this.invoke("ai_cancel_stream");
    } catch {
      // Ignore cancel errors
    }
    this.finishStreaming();
  }

  async send(overridePrompt = null) {
    this.mentions.close();
    const isManualSend = overridePrompt === null;
    const prompt = isManualSend
      ? serializeComposerToPrompt(this.inputEl).trim()
      : String(overridePrompt).trim();
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
      this.modelPicker.openPopover("settings", false);
      this.onToast?.("Pick an AI model first", true);
      return;
    }

    if (isManualSend) {
      this.inputEl.innerHTML = "";
    }

    const currentCtx = this.getCurrentContext?.() || {};
    const sourceFile = currentCtx.currentFile || null;
    const nowMs = Date.now();
    this.messages.push({ id: `u-${nowMs}`, role: "user", content: prompt, createdAt: nowMs });
    const reqId = `ai-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.messages.push({
      id: reqId,
      role: "assistant",
      content: "",
      createdAt: nowMs,
      sourceFile,
      proposalStates: {},
    });

    this.activeRequestId = reqId;
    this.isStreaming = true;
    this._autoScrollLocked = true;
    this.sendBtn.hidden = true;
    this.stopBtn.hidden = false;
    this.renderMessages(true);
    this.persistActiveChat();

    let ctxPayload;
    try {
      ctxPayload = await buildContextPayload({
        ctx: currentCtx,
        userPrompt: prompt,
        provider: this.prefs?.provider,
        includeCurrentPage: this.includeCurrentPage,
        searchFolder: this.searchFolder,
        liveSelectedBlocks: this.liveSelectedBlocks,
        pinnedAttachments: this.pinnedAttachments,
        skills: this.skills,
        pinnedSkillIds: this.pinnedSkillIds,
        invoke: this.invoke,
      });
    } catch (err) {
      ctxPayload = {
        systemPrompt: STATIC_SYSTEM_PROMPT,
        stableContext: "",
        dynamicContext: "",
        budgets: getContextBudgets(this.prefs?.provider),
      };
      console.error("Context payload failed:", err);
    }

    const historyMsgs = buildOutgoingHistory({
      messages: this.messages,
      dynamicContext: ctxPayload.dynamicContext,
      maxHistoryChars: ctxPayload.budgets?.maxHistoryChars || 16000,
    });

    try {
      await this.invoke("ai_chat_stream", {
        request: {
          request_id: reqId,
          system_prompt: ctxPayload.systemPrompt,
          stable_context: ctxPayload.stableContext || null,
          messages: historyMsgs,
        },
      });
    } catch (err) {
      const msg = this.messages.find((m) => m.id === reqId);
      if (msg) msg.error = String(err);
      this.finishStreaming();
    }
  }

  harvestSkillFromChat() {
    if (this.isStreaming) {
      this.onToast?.("Wait for the current response to finish", true);
      return;
    }
    if (!this.messages.length) {
      this.skillsDrawer.openCreateForm({});
      this.onToast?.("Start a conversation to harvest from, or create a skill manually here");
      return;
    }
    if (this.skillsDrawer.isDrawerOpen()) {
      this.skillsDrawer.toggle(false);
    }
    this.send(
      "Harvest the reusable workflow, rules, and patterns from our conversation above into a clean Skillweaver skill proposal using ```skillweaver-skill."
    );
  }

  async handleMessagesClick(e) {
    const refBtn = e.target.closest(".ai-ref-link");
    if (refBtn) {
      const target = refBtn.dataset.target;
      if (target) this.onOpenLink?.(target);
      return;
    }

    const skillLinkBtn = e.target.closest(".ai-inline-skill-btn");
    if (skillLinkBtn) {
      const slug = String(skillLinkBtn.dataset.skillSlug || "").toLowerCase();
      const matched = this.skills.find((s) => (s.slug || "").toLowerCase() === slug);
      if (matched) {
        this.skillsDrawer.openEditForm(matched);
      } else {
        this.onToast?.(`Skill @${slug} was not found`, true);
      }
      return;
    }

    const skillActBtn = e.target.closest("[data-skill-action]");
    if (skillActBtn) {
      await this.handleSkillProposalAction(
        skillActBtn.dataset.msg,
        Number(skillActBtn.dataset.skillProp),
        skillActBtn.dataset.skillAction
      );
      return;
    }

    const acceptBtn = e.target.closest(".ai-accept-btn[data-prop]");
    if (acceptBtn) {
      await this.handleProposalAction(acceptBtn.dataset.msg, Number(acceptBtn.dataset.prop), true);
      return;
    }

    const rejectBtn = e.target.closest(".ai-reject-btn[data-prop]");
    if (rejectBtn) {
      await this.handleProposalAction(rejectBtn.dataset.msg, Number(rejectBtn.dataset.prop), false);
      return;
    }

    const copyBtn = e.target.closest("[data-copy]");
    if (copyBtn) {
      const msg = this.messages.find((m) => m.id === copyBtn.dataset.copy);
      if (!msg) return;
      const clean = stripEditFences(msg.content);
      try {
        await navigator.clipboard.writeText(clean);
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          if (copyBtn.isConnected) copyBtn.textContent = "Copy";
        }, 1200);
      } catch {
        // Ignore clipboard error
      }
      return;
    }

    const insertBtn = e.target.closest("[data-insert]");
    if (insertBtn) {
      const msg = this.messages.find((m) => m.id === insertBtn.dataset.insert);
      if (!msg) return;
      const clean = stripEditFences(msg.content);
      if (clean) this.onInsertMarkdown?.(clean);
      return;
    }

    const saveSkillBtn = e.target.closest("[data-save-skill]");
    if (saveSkillBtn) {
      const msg = this.messages.find((m) => m.id === saveSkillBtn.dataset.saveSkill);
      if (!msg) return;
      const clean = stripEditFences(msg.content);
      if (!clean) return;
      const headingMatch = clean.match(/^#{1,3}\s+(.+)$/m);
      const suggestedName = headingMatch ? headingMatch[1].trim().slice(0, 60) : "";
      this.skillsDrawer.openCreateForm({
        name: suggestedName,
        body: clean,
      });
      return;
    }

    if (e.target.closest("[data-open-settings]")) {
      this.toggleSettings(true);
      this.modelInput.focus();
      return;
    }

    const switchBtn = e.target.closest("[data-switch-model]");
    if (switchBtn) {
      const suggested = switchBtn.dataset.switchModel;
      if (!suggested) return;
      const nextPrefs = { ...this.prefs, model: suggested };
      try {
        await this.invoke("save_ai_prefs", { prefs: nextPrefs });
        this.prefs = nextPrefs;
        this.modelInput.value = suggested;
        this.modelPicker.updateHeader();
        this.onToast?.(`Switched model to ${suggested}`);
      } catch (err) {
        this.onToast?.(`Failed to switch model: ${err}`, true);
      }
    }
  }

  renderMessages(scrollToBottom = false) {
    if (!this.messages.length) {
      this.turnRail.render([]);
      this.messagesEl.innerHTML = `
        <div class="ai-empty">
          <p><strong>Ask anything</strong> about this page or your whole markdown folder.</p>
          <p class="ai-empty-hint">Click <code>⋮⋮</code> on any block → <strong>Ask AI</strong>, type <code>@skill</code>, <code>@@page</code>, or pin skills below.</p>
        </div>
      `;
      return;
    }

    const knownSkillSlugs = new Set(this.skills.map((s) => String(s.slug || "").toLowerCase()));
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

    this.messagesEl.innerHTML = this.messages
      .map((msg) => {
        const tIdx = msgToTurn.get(msg.id);
        const turnAttr = tIdx !== undefined ? ` data-turn-idx="${tIdx}"` : "";
        const msgAttr = ` data-msg-id="${escapeHtml(msg.id)}"`;
        if (msg.role === "user") {
          return `<div class="ai-msg ai-msg-user"${msgAttr}${turnAttr}><div class="ai-bubble">${renderUserMessageHtml(msg.content, knownSkillSlugs)}</div></div>`;
        }
        const isStreamingThis = this.isStreaming && msg.id === this.activeRequestId;
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
          bodyHtml = renderAssistantContentHtml(msg, isStreamingThis);
        }

        const showActions = !isStreamingThis && msg.content && !msg.error;
        const cleanPlain = stripEditFences(msg.content || "");
        const actionsHtml =
          showActions && cleanPlain
            ? `<div class="ai-msg-actions">
               <button class="ai-mini-btn" data-copy="${escapeHtml(msg.id)}" type="button">Copy</button>
               <button class="ai-mini-btn" data-insert="${escapeHtml(msg.id)}" type="button">Insert into note</button>
               <button class="ai-mini-btn" data-save-skill="${escapeHtml(msg.id)}" type="button" title="Save this response as a reusable Skill">Save as Skill</button>
             </div>`
            : "";

        return `
          <div class="ai-msg ai-msg-assistant"${msgAttr}${turnAttr}>
            <div class="ai-bubble">${bodyHtml}${actionsHtml}</div>
          </div>
        `;
      })
      .join("");

    this.turnRail.render(turns);

    if (scrollToBottom) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
    this.turnRail.updateActiveDot();
  }

  async handleSkillProposalAction(msgId, propIdx, action) {
    if (this._applyingProposal) return;
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg) return;

    const stateKey = `skill-${propIdx}`;
    if (action === "reject") {
      msg.proposalStates[stateKey] = "rejected";
      this.renderMessages();
      this.persistActiveChat();
      return;
    }

    const fences = extractSkillFences(msg.content);
    const targetFence = fences[propIdx];
    if (!targetFence) return;

    const proposal = parseSkillProposal(targetFence.rawJson);
    if (!proposal) return;

    if (action === "edit") {
      this.skillsDrawer.openCreateForm(proposal);
      return;
    }

    const ctx = this.getCurrentContext?.() || {};
    const effectiveScope =
      proposal.scope === "vault" && !ctx.vaultPath ? "global" : proposal.scope;

    this._applyingProposal = true;
    try {
      const saved = await this.invoke("ai_save_skill", {
        request: {
          slug: proposal.slug,
          name: proposal.name,
          description: proposal.description,
          scope: effectiveScope,
          body: proposal.body,
          original_id: null,
        },
      });
      const list = await this.invoke("ai_list_skills").catch(() => null);
      if (Array.isArray(list)) {
        this.skills = list;
        this.skillsLoaded = true;
      }

      const pinAfter = action === "save-pin";
      if (pinAfter) {
        this.togglePinSkill(saved.id, true, false);
      }

      msg.proposalStates[stateKey] = pinAfter ? "accepted-pinned" : "accepted";
      if (saved.scope === "vault") {
        this.onVaultChanged?.();
      }
      this.renderChips();
      this.skillsDrawer.refresh();
      this.renderMessages();
      this.persistActiveChat();
      this.onToast?.(
        pinAfter
          ? `Saved & pinned @${saved.slug}`
          : `Saved skill @${saved.slug} (${saved.scope})`
      );
    } catch (err) {
      this.onToast?.(`Failed to save skill: ${err}`, true);
    } finally {
      this._applyingProposal = false;
    }
  }

  async handleProposalAction(msgId, propIdx, accepted) {
    if (this._applyingProposal) return;
    const msg = this.messages.find((m) => m.id === msgId);
    if (!msg) return;

    if (!accepted) {
      msg.proposalStates[propIdx] = "rejected";
      this.renderMessages();
      this.persistActiveChat();
      return;
    }

    const fences = extractEditFences(msg.content);
    const targetFence = fences[propIdx];
    if (!targetFence) return;

    const ops = parseEditOps(targetFence.rawJson);
    if (!ops) return;

    this._applyingProposal = true;
    try {
      const result = await this.onApplyEdits?.(ops, msg.sourceFile || null);
      if (result === true || result?.ok === true) {
        msg.proposalStates[propIdx] = "accepted";
        this.renderMessages();
        this.persistActiveChat();
      }
    } finally {
      this._applyingProposal = false;
    }
  }
}
