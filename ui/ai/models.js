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
    short: "OpenAI",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    needsKey: true,
  },
  gemini: {
    label: "Google Gemini",
    short: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    needsKey: true,
  },
  anthropic: {
    label: "Anthropic (Claude)",
    short: "Claude",
    baseUrl: "https://api.anthropic.com/v1/messages",
    needsKey: true,
  },
  openrouter: {
    label: "OpenRouter",
    short: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    needsKey: true,
  },
  ollama: {
    label: "Ollama (Local)",
    short: "Ollama",
    baseUrl: "http://localhost:11434/v1/chat/completions",
    needsKey: false,
  },
  custom: {
    label: "Custom (OpenAI-compatible)",
    short: "Custom",
    baseUrl: "http://localhost:1234/v1/chat/completions",
    needsKey: false,
  },
};

export function defaultProfileLabel(provider) {
  const key = String(provider || "openai").trim().toLowerCase();
  return PROVIDER_PRESETS[key]?.label || "OpenAI";
}

export function createProfileId() {
  return `prof_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function maskApiKey(key) {
  const clean = String(key || "").trim();
  if (!clean) return "";
  if (clean.length < 6) return "••••";
  return `••••${clean.slice(-4)}`;
}

export function canonicalCacheKey(provider, baseUrl) {
  const p = String(provider || "openai").trim().toLowerCase();
  const preset = PROVIDER_PRESETS[p] || PROVIDER_PRESETS.openai;
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "") || preset.baseUrl;
  return `${p}::${clean}`;
}

export function profileCacheKey(profileId, provider, baseUrl) {
  const pid = String(profileId || "").trim();
  return pid ? `profile::${pid}` : canonicalCacheKey(provider, baseUrl);
}

export function getActiveProfile(prefs) {
  const profiles = Array.isArray(prefs?.profiles) ? prefs.profiles : [];
  if (profiles.length > 0) {
    const matched = profiles.find((p) => p.id === prefs.active_profile_id);
    if (matched) return matched;
    return profiles[0];
  }
  const provider = String(prefs?.provider || "openai").trim().toLowerCase() || "openai";
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
  return {
    id: null,
    name: defaultProfileLabel(provider),
    provider,
    api_key: String(prefs?.api_key || "").trim(),
    base_url: String(prefs?.base_url || "").trim() || preset.baseUrl,
    model: String(prefs?.model || "").trim(),
    synthetic: true,
  };
}

export function syncActiveProfileFields(prefs) {
  const profiles = Array.isArray(prefs?.profiles)
    ? prefs.profiles.map((p) => ({ ...p }))
    : [];
  if (!profiles.length) {
    return {
      provider: "openai",
      api_key: "",
      base_url: PROVIDER_PRESETS.openai.baseUrl,
      model: "",
      active_profile_id: null,
      profiles: [],
    };
  }
  const active =
    profiles.find((p) => p.id === prefs?.active_profile_id) || profiles[0];
  const preset = PROVIDER_PRESETS[active.provider] || PROVIDER_PRESETS.openai;
  return {
    ...prefs,
    active_profile_id: active.id,
    profiles,
    provider: active.provider,
    api_key: active.api_key || "",
    base_url: active.base_url || preset.baseUrl,
    model: active.model || "",
  };
}

export function formatCacheAge(fetchedAtUnix) {
  if (!fetchedAtUnix) return "Not synced yet";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - fetchedAtUnix);
  if (diff < 60) return "Synced just now";
  if (diff < 3600) return `Synced ${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `Synced ${Math.floor(diff / 3600)}h ago`;
  return `Synced ${Math.floor(diff / 86400)}d ago`;
}

/**
 * Unified model & API-key switcher popover + per-key Settings model picker.
 */
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
    { invoke, getPrefs, setPrefs, getEditingProfileId, onProfileChanged, onToast }
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
    this.getEditingProfileId = getEditingProfileId;
    this.onProfileChanged = onProfileChanged;
    this.onToast = onToast;

    this.modelsCache = {};
    this.open = false;
    this.target = "header";
    this.activeTab = "all"; // "all" | profileId
    this.filterText = "";
    this.showOlderSettings = false;
    this.expandedOlderProfiles = new Set();
    this.fetchingProfileIds = new Set();
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

  getCacheEntryForProfile(profile) {
    const primaryKey = profileCacheKey(profile?.id, profile?.provider, profile?.base_url);
    const primary = this.modelsCache[primaryKey];
    if (primary && (Array.isArray(primary.models) && primary.models.length > 0 || primary.fetched_at_unix)) {
      return { cacheKey: primaryKey, entry: primary };
    }
    if (profile?.id === "prof-default") {
      const legacyKey = canonicalCacheKey(profile.provider, profile.base_url);
      const legacy = this.modelsCache[legacyKey];
      if (legacy) {
        return { cacheKey: legacyKey, entry: legacy };
      }
    }
    return { cacheKey: primaryKey, entry: primary || null };
  }

  isCacheFresh(cacheKey) {
    const entry = this.modelsCache[cacheKey];
    if (!entry || !Array.isArray(entry.models) || entry.models.length === 0) return false;
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec - (entry.fetched_at_unix || 0) < MODEL_CACHE_TTL_SEC;
  }

  isProfileCacheFresh(profile) {
    const { entry } = this.getCacheEntryForProfile(profile);
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

  getBestCachedModel(provider, baseUrl, profileId = null) {
    const { entry } = this.getCacheEntryForProfile({ id: profileId, provider, base_url: baseUrl });
    const cached = entry?.models || [];
    return cached.find((m) => !m.is_snapshot) || cached[0] || null;
  }

  updateHeader() {
    const prefs = this.getPrefs?.() || {};
    const active = getActiveProfile(prefs);
    const providerKey = active.provider || "openai";
    const preset = PROVIDER_PRESETS[providerKey] || PROVIDER_PRESETS.openai;
    const activeModel = (active.model || prefs.model || "").trim();
    const profileName = (active.name || defaultProfileLabel(providerKey)).trim();
    const { cacheKey } = this.getCacheEntryForProfile(active);

    if (this.modelBadgeEl) {
      if (!activeModel) {
        this.modelBadgeEl.textContent =
          Array.isArray(prefs.profiles) && prefs.profiles.length > 0
            ? `${profileName} · Pick model`
            : "Pick model";
      } else if (Array.isArray(prefs.profiles) && prefs.profiles.length > 0) {
        this.modelBadgeEl.innerHTML = `<span class="ai-model-badge-key">${escapeHtml(
          profileName
        )}</span><span class="ai-model-badge-sep">&middot;</span><span class="ai-model-badge-name">${escapeHtml(
          activeModel
        )}</span>`;
      } else {
        this.modelBadgeEl.textContent = activeModel;
      }

      const missing = this.isSavedModelMissing(providerKey, cacheKey, activeModel);
      this.modelBadgeEl.classList.toggle("deprecated", missing);
      this.modelBadgeEl.title = missing
        ? `${profileName} (${preset.label}) · "${activeModel}" was not found in the latest live list — click to switch`
        : `${profileName} (${preset.label})${activeModel ? ` · ${activeModel}` : ""}`;
    }
  }

  getSettingsContext() {
    const provider = this.providerSelect.value;
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
    const baseUrl = this.baseUrlInput.value.trim() || preset.baseUrl;
    const apiKey = this.apiKeyInput.value.trim();
    const currentModel = this.modelInput.value.trim();
    const profileId = this.getEditingProfileId?.() || null;
    const { cacheKey } = this.getCacheEntryForProfile({
      id: profileId,
      provider,
      base_url: baseUrl,
    });
    return {
      id: profileId,
      provider,
      baseUrl,
      apiKey,
      currentModel,
      cacheKey,
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

  async fetchLiveModelsForProfile(profile, silent = false) {
    if (!profile) return null;
    const provider = profile.provider || "openai";
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
    const baseUrl = String(profile.base_url || "").trim() || preset.baseUrl;
    const apiKey = String(profile.api_key || "").trim();
    const profileId = profile.id || null;
    const cacheKey = profileCacheKey(profileId, provider, baseUrl);

    if (preset.needsKey && !apiKey) {
      if (!silent) {
        this.onToast?.(
          `Add an API key for "${profile.name || preset.label}" first`,
          true
        );
      }
      return null;
    }

    const trackKey = profileId || "__form__";
    this.fetchingProfileIds.add(trackKey);
    this.isFetching = true;
    if (this.open) this.render();

    try {
      const entry = await this.invoke("ai_list_models", {
        request: {
          provider,
          api_key: apiKey,
          base_url: baseUrl,
          profile_id: profileId,
        },
      });
      const normalized = {
        fetched_at_unix: entry?.fetched_at_unix || Math.floor(Date.now() / 1000),
        models: Array.isArray(entry?.models) ? entry.models : [],
      };
      this.modelsCache[cacheKey] = normalized;

      const best = normalized.models.find((m) => !m.is_snapshot) || normalized.models[0];
      if (best) {
        if (
          !this.settingsDrawerEl.hidden &&
          this.providerSelect.value === provider &&
          !this.modelInput.value.trim() &&
          (!profileId || this.getEditingProfileId?.() === profileId)
        ) {
          this.modelInput.value = best.id;
        }
        if (profileId) {
          const latest = this.getPrefs?.() || {};
          const list = Array.isArray(latest.profiles) ? latest.profiles : [];
          const idx = list.findIndex((p) => p.id === profileId);
          if (idx !== -1 && !String(list[idx].model || "").trim()) {
            const nextProfiles = list.map((p, i) =>
              i === idx ? { ...p, model: best.id } : p
            );
            const nextPrefs = syncActiveProfileFields({
              ...latest,
              profiles: nextProfiles,
            });
            try {
              const saved = await this.invoke("save_ai_prefs", { prefs: nextPrefs });
              this.setPrefs?.(saved);
              this.onProfileChanged?.(saved);
            } catch {
              // Ignore auto-pick save error
            }
          }
        }
      }

      this.updateHeader();
      if (!silent) {
        this.onToast?.(
          `Synced ${normalized.models.length} models for ${profile.name || preset.label}`
        );
      }
      return normalized;
    } catch (err) {
      if (!silent) {
        this.onToast?.(
          `Failed to load models for ${profile.name || preset.label}: ${err}`,
          true
        );
      }
      return null;
    } finally {
      this.fetchingProfileIds.delete(trackKey);
      this.isFetching = this.fetchingProfileIds.size > 0;
      if (this.open) this.render();
    }
  }

  async fetchLiveModels(providerOverride = null, silent = false) {
    const ctx = this.getSettingsContext();
    return this.fetchLiveModelsForProfile(
      {
        id: ctx.id,
        name: defaultProfileLabel(providerOverride || ctx.provider),
        provider: providerOverride || ctx.provider,
        api_key: ctx.apiKey,
        base_url: ctx.baseUrl,
      },
      silent
    );
  }

  async fetchAllProfiles() {
    const prefs = this.getPrefs?.() || {};
    const profiles = Array.isArray(prefs.profiles) ? prefs.profiles : [];
    const eligible = profiles.filter((p) => {
      const preset = PROVIDER_PRESETS[p.provider] || PROVIDER_PRESETS.openai;
      return !preset.needsKey || Boolean(String(p.api_key || "").trim());
    });
    if (!eligible.length) {
      this.onToast?.("Add a saved API key in Settings first", true);
      return;
    }

    const results = await Promise.allSettled(
      eligible.map((p) => this.fetchLiveModelsForProfile(p, true))
    );
    const okCount = results.filter((r) => r.status === "fulfilled" && r.value).length;
    if (okCount > 0) {
      this.onToast?.(`Synced live models across ${okCount} saved key${okCount === 1 ? "" : "s"}`);
    } else {
      this.onToast?.("Failed to sync models — check your API keys and Base URLs", true);
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
    this.showOlderSettings = false;

    const prefs = this.getPrefs?.() || {};
    const profiles = Array.isArray(prefs.profiles) ? prefs.profiles : [];
    if (target === "header") {
      if (this.activeTab !== "all" && !profiles.some((p) => p.id === this.activeTab)) {
        this.activeTab = "all";
      }
    }

    const panelRect = this.panelEl.getBoundingClientRect();
    let topPx = 42;
    if (target === "settings" && this.modelInput) {
      const rowRect = this.modelInput.getBoundingClientRect();
      topPx = Math.max(42, rowRect.bottom - panelRect.top + 4);
    }
    this.modelPopoverEl.style.top = `${topPx}px`;

    this.render();
    this.modelPopoverEl.querySelector(".ai-model-filter")?.focus();

    if (skipAutoFetch) return;
    if (target === "settings") {
      const ctx = this.getSettingsContext();
      if (!this.isCacheFresh(ctx.cacheKey) && (ctx.apiKey || ctx.provider === "ollama")) {
        this.fetchLiveModels(ctx.provider, true);
      }
    } else {
      const active = getActiveProfile(prefs);
      const preset = PROVIDER_PRESETS[active.provider] || PROVIDER_PRESETS.openai;
      if (
        active.id &&
        !this.isProfileCacheFresh(active) &&
        (!preset.needsKey || active.api_key)
      ) {
        this.fetchLiveModelsForProfile(active, true);
      }
    }
  }

  close() {
    this.open = false;
    this.filterText = "";
    this.showOlderSettings = false;
    if (this.modelPopoverEl) {
      this.modelPopoverEl.hidden = true;
      this.modelPopoverEl.innerHTML = "";
    }
  }

  renderModelRowHtml(m, profileId, isSelected) {
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
    const pidAttr = profileId ? ` data-profile-id="${escapeHtml(profileId)}"` : "";
    return `
      <button class="popover-item${isSelected ? " selected" : ""}" data-model-id="${escapeHtml(
        m.id
      )}"${pidAttr} type="button" role="option">
        <span class="popover-item-main">
          <span class="popover-item-title">${isSelected ? "✓ " : ""}${escapeHtml(m.id)}</span>
        </span>
        ${subHtml}
      </button>
    `;
  }

  renderSettingsListHtml(q) {
    const ctx = this.getSettingsContext();
    const { primary, older, all, fetchedAt, hasLiveList } = this.getAvailableModels(
      ctx.cacheKey,
      ctx.currentModel
    );
    let listHtml = "";
    if (q) {
      const matches = all.filter(
        (m) => m.id.toLowerCase().includes(q) || (m.label || "").toLowerCase().includes(q)
      );
      listHtml = matches.length
        ? matches.map((m) => this.renderModelRowHtml(m, null, m.id === ctx.currentModel)).join("")
        : `<div class="popover-section-label">No matching models</div>`;
    } else if (!all.length) {
      listHtml = `<div class="popover-section-label">${
        this.isFetching
          ? "Fetching live models..."
          : ctx.apiKey || ctx.provider === "ollama"
            ? "Click ↻ Fetch to load models"
            : "Enter your API key first"
      }</div>`;
    } else {
      const visiblePrimary = primary.slice();
      if (ctx.currentModel) {
        const activeOlder = older.find((m) => m.id === ctx.currentModel);
        if (activeOlder && !visiblePrimary.some((m) => m.id === activeOlder.id)) {
          visiblePrimary.unshift(activeOlder);
        }
      }
      listHtml = visiblePrimary
        .map((m) => this.renderModelRowHtml(m, null, m.id === ctx.currentModel))
        .join("");
      if (older.length > 0) {
        const verb = this.showOlderSettings ? "▾ Hide" : "▸ Show";
        listHtml += `<button class="ai-model-expand-btn" data-toggle-older-settings="1" type="button">${verb} older &amp; preview models (${older.length})</button>`;
        if (this.showOlderSettings) {
          listHtml += older
            .map((m) => this.renderModelRowHtml(m, null, m.id === ctx.currentModel))
            .join("");
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

    return { tabsHtml: "", listHtml, statusText, isDeprecated };
  }

  renderHeaderUnifiedHtml(q) {
    const prefs = this.getPrefs?.() || {};
    const profiles = Array.isArray(prefs.profiles) ? prefs.profiles : [];
    const active = getActiveProfile(prefs);

    if (!profiles.length) {
      return {
        tabsHtml: "",
        listHtml: `<div class="popover-section-label">No saved API keys yet — open Settings to add one.</div>`,
        statusText: "No API keys configured",
        isDeprecated: false,
      };
    }

    let tabsHtml = "";
    if (profiles.length > 1) {
      const allBtn = `<button class="ai-model-tab${this.activeTab === "all" ? " active" : ""}" data-profile-tab="all" type="button">All (${profiles.length})</button>`;
      const profileBtns = profiles
        .map(
          (p) =>
            `<button class="ai-model-tab${this.activeTab === p.id ? " active" : ""}" data-profile-tab="${escapeHtml(
              p.id
            )}" type="button" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</button>`
        )
        .join("");
      tabsHtml = `<div class="ai-model-tabs">${allBtn}${profileBtns}</div>`;
    }

    const visibleProfiles =
      this.activeTab === "all"
        ? profiles
        : profiles.filter((p) => p.id === this.activeTab);

    let totalMatches = 0;
    const groupHtmls = [];

    for (const p of visibleProfiles) {
      const preset = PROVIDER_PRESETS[p.provider] || PROVIDER_PRESETS.openai;
      const { cacheKey } = this.getCacheEntryForProfile(p);
      const { primary, older, all } = this.getAvailableModels(cacheKey, p.model || "");
      const isFetchingThis = this.fetchingProfileIds.has(p.id);
      const nameMatches = q && p.name.toLowerCase().includes(q);
      const isSelectedProfile = p.id === active.id;

      let rowsHtml = "";
      if (q) {
        const matches = nameMatches
          ? all
          : all.filter(
              (m) => m.id.toLowerCase().includes(q) || (m.label || "").toLowerCase().includes(q)
            );
        if (!matches.length) continue;
        totalMatches += matches.length;
        rowsHtml = matches
          .map((m) =>
            this.renderModelRowHtml(m, p.id, isSelectedProfile && m.id === p.model)
          )
          .join("");
      } else if (!all.length) {
        rowsHtml = `<div class="ai-model-group-empty">${
          isFetchingThis
            ? "Fetching live models..."
            : preset.needsKey && !p.api_key
              ? "Missing API key — edit in Settings"
              : "Click ↻ to load available models for this key"
        }</div>`;
      } else {
        totalMatches += all.length;
        const visiblePrimary = primary.slice();
        if (p.model) {
          const activeOlder = older.find((m) => m.id === p.model);
          if (activeOlder && !visiblePrimary.some((m) => m.id === activeOlder.id)) {
            visiblePrimary.unshift(activeOlder);
          }
        }
        rowsHtml = visiblePrimary
          .map((m) =>
            this.renderModelRowHtml(m, p.id, isSelectedProfile && m.id === p.model)
          )
          .join("");
        if (older.length > 0) {
          const expanded = this.expandedOlderProfiles.has(p.id);
          const verb = expanded ? "▾ Hide" : "▸ Show";
          rowsHtml += `<button class="ai-model-expand-btn" data-toggle-older-profile="${escapeHtml(
            p.id
          )}" type="button">${verb} older &amp; preview models (${older.length})</button>`;
          if (expanded) {
            rowsHtml += older
              .map((m) =>
                this.renderModelRowHtml(m, p.id, isSelectedProfile && m.id === p.model)
              )
              .join("");
          }
        }
      }

      const showGroupHeader = profiles.length > 1 || this.activeTab === "all";
      const headerHtml = showGroupHeader
        ? `
          <div class="ai-model-group-header">
            <span class="ai-model-group-name">${escapeHtml(p.name)}</span>
            <span class="ai-model-group-right">
              <span class="ai-model-group-provider">${escapeHtml(preset.short || preset.label)}</span>
              <button class="ai-model-group-sync" data-sync-profile="${escapeHtml(
                p.id
              )}" type="button" title="Refresh models for ${escapeHtml(p.name)}">${
                isFetchingThis ? "…" : "↻"
              }</button>
            </span>
          </div>
        `
        : "";

      groupHtmls.push(`<div class="ai-model-group">${headerHtml}${rowsHtml}</div>`);
    }

    const listHtml = groupHtmls.length
      ? groupHtmls.join("")
      : `<div class="popover-section-label">${
          q ? "No matching models across keys" : "No cached models yet — click ↻ Fetch"
        }</div>`;

    const activeCache = this.getCacheEntryForProfile(active);
    const isDeprecated = this.isSavedModelMissing(
      active.provider,
      activeCache.cacheKey,
      active.model
    );
    const statusText = this.isFetching
      ? "Syncing live models..."
      : isDeprecated
        ? `"${active.model}" may be retired — pick another`
        : q
          ? `${totalMatches} match${totalMatches === 1 ? "" : "es"}`
          : `${active.name} · ${
              activeCache.entry?.models?.length
                ? `${formatCacheAge(activeCache.entry.fetched_at_unix)} · ${activeCache.entry.models.length} models`
                : "Not synced yet"
            }`;

    return { tabsHtml, listHtml, statusText, isDeprecated };
  }

  render() {
    if (!this.modelPopoverEl || !this.open) return;
    const prefs = this.getPrefs?.() || {};
    const profiles = Array.isArray(prefs.profiles) ? prefs.profiles : [];
    const q = this.filterText.trim().toLowerCase();

    const { tabsHtml, listHtml, statusText, isDeprecated } =
      this.target === "settings"
        ? this.renderSettingsListHtml(q)
        : this.renderHeaderUnifiedHtml(q);

    const placeholder =
      this.target === "header" && profiles.length > 1
        ? "Filter across all keys..."
        : "Filter models...";
    const fetchTitle =
      this.target === "header" && this.activeTab === "all" && profiles.length > 1
        ? "Sync models across all saved keys"
        : "Fetch live models from provider";

    const existingFilter = this.modelPopoverEl.querySelector(".ai-model-filter");
    if (existingFilter) {
      const tabsWrap = this.modelPopoverEl.querySelector(".ai-model-tabs-wrap");
      const listEl = this.modelPopoverEl.querySelector(".ai-model-popover-list");
      const refreshBtn = this.modelPopoverEl.querySelector("[data-refresh-models]");
      const statusEl = this.modelPopoverEl.querySelector(".ai-model-status-note");
      if (tabsWrap) tabsWrap.innerHTML = tabsHtml;
      if (listEl) listEl.innerHTML = listHtml;
      if (refreshBtn) {
        refreshBtn.textContent = this.isFetching ? "…" : "↻ Fetch";
        refreshBtn.title = fetchTitle;
      }
      if (statusEl) {
        statusEl.textContent = statusText;
        statusEl.classList.toggle("warn", isDeprecated);
      }
    } else {
      this.modelPopoverEl.innerHTML = `
        <div class="ai-model-popover-header">
          <input class="ai-model-filter" type="text" placeholder="${escapeHtml(
            placeholder
          )}" value="${escapeHtml(this.filterText)}" autocomplete="off" />
          <button class="top-text-btn" data-refresh-models="1" type="button" title="${escapeHtml(
            fetchTitle
          )}">${this.isFetching ? "…" : "↻ Fetch"}</button>
        </div>
        <div class="ai-model-tabs-wrap">${tabsHtml}</div>
        <div class="ai-model-popover-list">${listHtml}</div>
        <div class="ai-model-status-note${isDeprecated ? " warn" : ""}">${escapeHtml(
          statusText
        )}</div>
      `;
      this.modelPopoverEl.querySelector(".ai-model-filter")?.addEventListener("input", (e) => {
        this.filterText = e.target.value;
        this.render();
      });
      this.modelPopoverEl
        .querySelector("[data-refresh-models]")
        ?.addEventListener("click", (e) => {
          e.stopPropagation();
          if (this.target === "settings") {
            this.fetchLiveModels(null, false);
          } else if (this.activeTab === "all" && profiles.length > 1) {
            this.fetchAllProfiles();
          } else {
            const targetProfile =
              profiles.find((p) => p.id === this.activeTab) || getActiveProfile(prefs);
            this.fetchLiveModelsForProfile(targetProfile, false);
          }
        });
    }

    this.modelPopoverEl.hidden = false;

    this.modelPopoverEl.querySelectorAll("[data-profile-tab]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.activeTab = btn.dataset.profileTab || "all";
        this.render();
        this.modelPopoverEl.querySelector(".ai-model-filter")?.focus();
      });
    });

    this.modelPopoverEl.querySelectorAll("[data-sync-profile]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const targetProfile = profiles.find((p) => p.id === btn.dataset.syncProfile);
        if (targetProfile) {
          this.fetchLiveModelsForProfile(targetProfile, false);
        }
      });
    });

    this.modelPopoverEl
      .querySelector("[data-toggle-older-settings]")
      ?.addEventListener("click", (e) => {
        e.stopPropagation();
        this.showOlderSettings = !this.showOlderSettings;
        this.render();
        this.modelPopoverEl.querySelector(".ai-model-filter")?.focus();
      });

    this.modelPopoverEl.querySelectorAll("[data-toggle-older-profile]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pid = btn.dataset.toggleOlderProfile;
        if (!pid) return;
        if (this.expandedOlderProfiles.has(pid)) {
          this.expandedOlderProfiles.delete(pid);
        } else {
          this.expandedOlderProfiles.add(pid);
        }
        this.render();
        this.modelPopoverEl.querySelector(".ai-model-filter")?.focus();
      });
    });

    this.modelPopoverEl.querySelectorAll("[data-model-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const chosenId = btn.dataset.modelId;
        const chosenProfileId = btn.dataset.profileId || null;
        if (chosenId) this.selectModel(chosenId, chosenProfileId);
      });
    });
  }

  async selectModel(modelId, profileId = null) {
    if (this.target === "settings") {
      this.modelInput.value = modelId;
      this.close();
      this.modelInput.focus();
      return;
    }

    const prefs = this.getPrefs?.() || {};
    const profiles = Array.isArray(prefs.profiles) ? prefs.profiles : [];
    const targetId = profileId || prefs.active_profile_id || profiles[0]?.id;
    const chosenProfile = profiles.find((p) => p.id === targetId);

    let nextPrefs;
    if (chosenProfile) {
      const nextProfiles = profiles.map((p) =>
        p.id === chosenProfile.id ? { ...p, model: modelId } : p
      );
      nextPrefs = syncActiveProfileFields({
        ...prefs,
        active_profile_id: chosenProfile.id,
        profiles: nextProfiles,
      });
    } else {
      nextPrefs = { ...prefs, model: modelId };
    }

    try {
      const saved = await this.invoke("save_ai_prefs", { prefs: nextPrefs });
      this.setPrefs?.(saved);
      this.onProfileChanged?.(saved);
      this.updateHeader();
      this.close();
      const label = chosenProfile ? `${chosenProfile.name} · ${modelId}` : modelId;
      this.onToast?.(`Switched to ${label}`);
    } catch (err) {
      this.onToast?.(`Failed to switch model: ${err}`, true);
    }
  }
}
