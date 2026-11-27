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

export const MODEL_CACHE_TTL_SEC = 86400;

export const PROVIDER_PRESETS = {
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

export function canonicalCacheKey(provider, baseUrl) {
  const p = String(provider || "openai").trim().toLowerCase();
  const preset = PROVIDER_PRESETS[p] || PROVIDER_PRESETS.openai;
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "") || preset.baseUrl;
  return `${p}::${clean}`;
}

export function formatCacheAge(fetchedAtUnix) {
  if (!fetchedAtUnix) return "Not synced yet";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - fetchedAtUnix);
  if (diff < 60) return "Synced just now";
  if (diff < 3600) return `Synced ${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `Synced ${Math.floor(diff / 3600)}h ago`;
  return `Synced ${Math.floor(diff / 86400)}d ago`;
}

export class AiModelPicker {
  constructor(
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
    { invoke, getPrefs, setPrefs, onToast }
  ) {
    this.panelEl = panelEl;
    this.modelBadgeEl = modelBadgeEl;
    this.modelPopoverEl = modelPopoverEl;
    this.settingsDrawerEl = settingsDrawerEl;
    this.providerSelect = providerSelect;
    this.apiKeyInput = apiKeyInput;
    this.baseUrlInput = baseUrlInput;
    this.modelInput = modelInput;
    this.pickModelBtn = pickModelBtn;
    this.fetchModelsBtn = fetchModelsBtn;

    this.invoke = invoke;
    this.getPrefs = getPrefs;
    this.setPrefs = setPrefs;
    this.onToast = onToast;

    this.modelsCache = {}; // cacheKey -> { fetched_at_unix, models }
    this.open = false;
    this.target = "header";
    this.filterText = "";
    this.showOlder = false;
    this.isFetching = false;

    this.modelBadgeEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle("header");
    });
    this.pickModelBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggle("settings");
    });
    this.fetchModelsBtn?.addEventListener("click", async (e) => {
      e.stopPropagation();
      this.openPopover("settings", true);
      await this.fetchLiveModels(this.providerSelect.value, false);
    });

    document.addEventListener("mousedown", (e) => {
      if (
        this.open &&
        this.modelPopoverEl &&
        !this.modelPopoverEl.contains(e.target) &&
        e.target !== this.modelBadgeEl &&
        e.target !== this.pickModelBtn &&
        e.target !== this.fetchModelsBtn
      ) {
        this.close();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.open) {
        e.preventDefault();
        this.close();
      }
    });
  }

  setCache(cache) {
    if (cache && typeof cache === "object") {
      this.modelsCache = cache;
    }
  }

  isOpen() {
    return this.open;
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

  getBestCachedModel(provider, baseUrl) {
    const cacheKey = canonicalCacheKey(provider, baseUrl);
    const cached = this.modelsCache[cacheKey]?.models || [];
    return cached.find((m) => !m.is_snapshot) || cached[0] || null;
  }

  updateHeader(providerOverride = null) {
    const prefs = this.getPrefs?.() || {};
    const providerKey = providerOverride || prefs.provider || "openai";
    const baseUrl = prefs.base_url?.trim() || PROVIDER_PRESETS[providerKey]?.baseUrl || "";
    const cacheKey = canonicalCacheKey(providerKey, baseUrl);
    const activeModel = prefs.model?.trim() || "";
    if (this.modelBadgeEl) {
      this.modelBadgeEl.textContent = activeModel || "Pick model";
      const missing = this.isSavedModelMissing(providerKey, cacheKey, activeModel);
      this.modelBadgeEl.classList.toggle("deprecated", missing);
      this.modelBadgeEl.title = missing
        ? `Model "${activeModel}" was not found in the latest live list — click to switch`
        : "Switch AI model";
    }
  }

  getActiveProviderContext(target = this.target) {
    const prefs = this.getPrefs?.() || {};
    const useSettings = target === "settings" || !this.settingsDrawerEl.hidden;
    const provider = useSettings ? this.providerSelect.value : prefs.provider || "openai";
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
    const baseUrl =
      (useSettings ? this.baseUrlInput.value.trim() : prefs.base_url?.trim()) || preset.baseUrl;
    const apiKey = (useSettings ? this.apiKeyInput.value.trim() : prefs.api_key?.trim()) || "";
    const currentModel = (useSettings ? this.modelInput.value.trim() : prefs.model?.trim()) || "";
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
    const prefs = this.getPrefs?.() || {};
    const useSettings = Boolean(providerOverride) || !this.settingsDrawerEl.hidden;
    const provider =
      providerOverride ||
      (useSettings ? this.providerSelect.value : prefs.provider || "openai");
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
    const baseUrl =
      (useSettings ? this.baseUrlInput.value.trim() : prefs.base_url?.trim()) || preset.baseUrl;
    const apiKey = (useSettings ? this.apiKeyInput.value.trim() : prefs.api_key?.trim()) || "";
    const cacheKey = canonicalCacheKey(provider, baseUrl);

    if (preset.needsKey && !apiKey) {
      if (!silent) this.onToast?.("Enter your API key first to fetch live models", true);
      return null;
    }

    this.isFetching = true;
    if (this.open) this.render();

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
        const latestPrefs = this.getPrefs?.() || {};
        if (latestPrefs.provider === provider && !latestPrefs.model?.trim()) {
          const nextPrefs = { ...latestPrefs, model: best.id };
          this.setPrefs?.(nextPrefs);
          try {
            await this.invoke("save_ai_prefs", { prefs: nextPrefs });
          } catch {
            // Ignore auto-pick save error
          }
        }
      }

      this.updateHeader();
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
      this.isFetching = false;
      if (this.open) this.render();
    }
  }

  toggle(target = "header") {
    if (this.open && this.target === target) {
      this.close();
    } else {
      this.openPopover(target, false);
    }
  }

  openPopover(target = "header", skipAutoFetch = false) {
    if (!this.modelPopoverEl) return;
    this.open = true;
    this.target = target;
    this.filterText = "";
    this.showOlder = false;

    const panelRect = this.panelEl.getBoundingClientRect();
    let topPx = 42;
    if (target === "settings" && this.modelInput) {
      const rowRect = this.modelInput.getBoundingClientRect();
      topPx = Math.max(42, rowRect.bottom - panelRect.top + 4);
    }
    this.modelPopoverEl.style.top = `${topPx}px`;

    this.render();
    const filterEl = this.modelPopoverEl.querySelector(".ai-model-filter");
    filterEl?.focus();

    const ctx = this.getActiveProviderContext(target);
    if (
      !skipAutoFetch &&
      !this.isCacheFresh(ctx.cacheKey) &&
      (ctx.apiKey || ctx.provider === "ollama")
    ) {
      this.fetchLiveModels(ctx.provider, true);
    }
  }

  close() {
    this.open = false;
    this.filterText = "";
    this.showOlder = false;
    if (this.modelPopoverEl) {
      this.modelPopoverEl.hidden = true;
      this.modelPopoverEl.innerHTML = "";
    }
  }

  render() {
    if (!this.modelPopoverEl || !this.open) return;
    const ctx = this.getActiveProviderContext(this.target);
    const { primary, older, all, fetchedAt, hasLiveList } = this.getAvailableModels(
      ctx.cacheKey,
      ctx.currentModel
    );
    const q = this.filterText.trim().toLowerCase();

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
        this.isFetching
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
        const verb = this.showOlder ? "▾ Hide" : "▸ Show";
        listHtml += `<button class="ai-model-expand-btn" data-toggle-older="1" type="button">${verb} older &amp; preview models (${older.length})</button>`;
        if (this.showOlder) {
          listHtml += older.map(renderRow).join("");
        }
      }
    }

    const isDeprecated = this.isSavedModelMissing(ctx.provider, ctx.cacheKey, ctx.currentModel);
    const statusText = this.isFetching
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
      if (refreshBtn) refreshBtn.textContent = this.isFetching ? "…" : "↻ Fetch";
      if (statusEl) {
        statusEl.textContent = statusText;
        statusEl.classList.toggle("warn", isDeprecated);
      }
    } else {
      this.modelPopoverEl.innerHTML = `
        <div class="ai-model-popover-header">
          <input class="ai-model-filter" type="text" placeholder="Filter models..." value="${escapeHtml(this.filterText)}" autocomplete="off" />
          <button class="top-text-btn" data-refresh-models="1" type="button" title="Fetch live models from provider">${this.isFetching ? "…" : "↻ Fetch"}</button>
        </div>
        <div class="ai-model-popover-list">${listHtml}</div>
        <div class="ai-model-status-note${isDeprecated ? " warn" : ""}">${escapeHtml(statusText)}</div>
      `;
      this.modelPopoverEl.querySelector(".ai-model-filter")?.addEventListener("input", (e) => {
        this.filterText = e.target.value;
        this.render();
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
      this.showOlder = !this.showOlder;
      this.render();
      this.modelPopoverEl.querySelector(".ai-model-filter")?.focus();
    });
    this.modelPopoverEl.querySelectorAll("[data-model-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const chosenId = btn.dataset.modelId;
        if (chosenId) this.selectModel(chosenId);
      });
    });
  }

  async selectModel(modelId) {
    if (this.target === "settings") {
      this.modelInput.value = modelId;
      this.close();
      this.modelInput.focus();
      return;
    }

    const prefs = this.getPrefs?.() || {};
    const nextPrefs = { ...prefs, model: modelId };
    try {
      await this.invoke("save_ai_prefs", { prefs: nextPrefs });
      this.setPrefs?.(nextPrefs);
      this.modelInput.value = modelId;
      this.updateHeader();
      this.close();
      this.onToast?.(`Switched to ${modelId}`);
    } catch (err) {
      this.onToast?.(`Failed to switch model: ${err}`, true);
    }
  }
}
