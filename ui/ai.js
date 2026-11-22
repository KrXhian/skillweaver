import { displayNameForLink, escapeHtml } from "./inline.js";

const PROVIDER_PRESETS = {
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
    needsKey: true,
  },
  anthropic: {
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1/messages",
    defaultModel: "claude-3-5-sonnet-latest",
    needsKey: true,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "openai/gpt-4o-mini",
    needsKey: true,
  },
  ollama: {
    label: "Ollama (Local)",
    baseUrl: "http://localhost:11434/v1/chat/completions",
    defaultModel: "llama3.2",
    needsKey: false,
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    baseUrl: "http://localhost:1234/v1/chat/completions",
    defaultModel: "local-model",
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
      settingsBtn,
      clearBtn,
      closeBtn,
      settingsDrawerEl,
      providerSelect,
      apiKeyInput,
      toggleKeyVisBtn,
      baseUrlInput,
      modelInput,
      saveSettingsBtn,
      messagesEl,
      chipsEl,
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
    }
  ) {
    this.panelEl = panelEl;
    this.resizerEl = resizerEl;
    this.toggleBtn = toggleBtn;
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
    this.onToast = onToast;

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
    this.messages = []; // { id, role, content, error?, proposalStates? }
    this.activeRequestId = null;
    this.isStreaming = false;

    settingsBtn.addEventListener("click", () => this.toggleSettings());
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
    });

    saveSettingsBtn.addEventListener("click", () => this.saveSettings());

    this.sendBtn.addEventListener("click", () => this.send());
    this.stopBtn.addEventListener("click", () => this.cancel());

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.send();
      }
    });

    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = `${Math.min(130, Math.max(38, this.inputEl.scrollHeight))}px`;
    });

    this.initResizer();
    this.initStreamListener();
    this.renderChips();
    this.renderMessages();
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
  }

  async open() {
    this.openState = true;
    this.panelEl.hidden = false;
    this.resizerEl.hidden = false;
    this.toggleBtn?.classList.add("active");
    await this.ensurePrefsLoaded();
    this.renderChips();
    this.inputEl.focus();
  }

  close() {
    this.openState = false;
    this.panelEl.hidden = true;
    this.resizerEl.hidden = true;
    this.toggleBtn?.classList.remove("active");
  }

  toggle() {
    if (this.openState) this.close();
    else this.open();
  }

  toggleSettings(forceState = null) {
    const nextHidden = forceState === null ? !this.settingsDrawerEl.hidden : !forceState;
    this.settingsDrawerEl.hidden = nextHidden;
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
      this.settingsDrawerEl.hidden = true;
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

    const historyMsgs = this.messages
      .slice(0, -1)
      .filter((m) => !m.error && m.content.trim())
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));

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
        const bodyHtml = msg.error
          ? `<div class="ai-error">${escapeHtml(msg.error)}</div>`
          : this.renderAssistantContent(msg);

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
