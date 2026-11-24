import { displayNameForLink, escapeHtml } from "../inline.js";

export function formatRelativeAge(unixSec) {
  if (!unixSec) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d`;
  return `${Math.floor(diff / (86400 * 7))}w`;
}

export function deriveChatTitle(prompt) {
  const clean = String(prompt || "")
    .replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, target, label) => label || displayNameForLink(target))
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "New Conversation";
  return clean.length > 48 ? `${clean.slice(0, 47)}…` : clean;
}

export class AiHistoryDrawer {
  constructor(
    { historyBtn, historyDrawerEl, newChatBtn, historySearchEl, historyListEl },
    {
      invoke,
      getCurrentContext,
      getActiveChatId,
      onBeforeOpen,
      onOpenChat,
      onStartNewChat,
      onActiveMetaChanged,
      onActiveChatDeleted,
      onPromptRenameChat,
      onToast,
    }
  ) {
    this.historyBtn = historyBtn;
    this.historyDrawerEl = historyDrawerEl;
    this.newChatBtn = newChatBtn;
    this.historySearchEl = historySearchEl;
    this.historyListEl = historyListEl;

    this.invoke = invoke;
    this.getCurrentContext = getCurrentContext;
    this.getActiveChatId = getActiveChatId;
    this.onBeforeOpen = onBeforeOpen;
    this.onOpenChat = onOpenChat;
    this.onStartNewChat = onStartNewChat;
    this.onActiveMetaChanged = onActiveMetaChanged;
    this.onActiveChatDeleted = onActiveChatDeleted;
    this.onPromptRenameChat = onPromptRenameChat;
    this.onToast = onToast;

    this.chats = [];
    this.chatsLoaded = false;
    this.isOpen = false;
    this.filter = "";

    this.historyBtn?.addEventListener("click", () => this.toggle());
    this.newChatBtn?.addEventListener("click", () => this.onStartNewChat?.());
    this.historySearchEl?.addEventListener("input", () => {
      this.filter = this.historySearchEl.value.trim().toLowerCase();
      this.render();
    });
  }

  isDrawerOpen() {
    return this.isOpen;
  }

  setChats(list) {
    if (Array.isArray(list)) {
      this.chats = list;
      this.chatsLoaded = true;
    }
  }

  refresh() {
    if (this.isOpen) {
      this.render();
    }
  }

  async toggle(forceState = null) {
    if (!this.historyDrawerEl) return;
    const nextOpen = forceState === null ? !this.isOpen : Boolean(forceState);
    this.isOpen = nextOpen;
    this.historyDrawerEl.hidden = !nextOpen;
    this.historyBtn?.classList.toggle("active", nextOpen);

    if (nextOpen) {
      this.onBeforeOpen?.();
      try {
        const list = await this.invoke("ai_list_chats");
        if (Array.isArray(list)) {
          this.chats = list;
          this.chatsLoaded = true;
        }
      } catch {
        // Keep cached chat list on error
      }
      this.render();
      this.historySearchEl?.focus();
    }
  }

  render() {
    if (!this.historyListEl) return;
    const q = this.filter;
    const ctx = this.getCurrentContext?.() || {};
    const activeVaultPath = ctx.vaultPath || "";
    const activeChatId = this.getActiveChatId?.();
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
          const isActive = c.id === activeChatId;
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
        this.onOpenChat?.(row.dataset.chatId);
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
          if (chatId === this.getActiveChatId?.()) {
            this.onActiveMetaChanged?.({ pinned: nextPinned });
          }
          this.render();
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
          if (chatId === this.getActiveChatId?.()) {
            this.onActiveMetaChanged?.({ title: cleanTitle });
          }
          this.render();
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
          if (chatId === this.getActiveChatId?.()) {
            await this.onActiveChatDeleted?.();
          } else {
            this.render();
          }
        } catch (err) {
          this.onToast?.(`Failed to delete chat: ${err}`, true);
        }
      });
    });
  }
}
