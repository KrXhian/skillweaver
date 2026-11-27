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

import { displayNameForLink, escapeHtml } from "../inline.js";

export const EDIT_FENCE_REGEX_SOURCE = "```skillweaver-edits[^\\n]*\\r?\\n([\\s\\S]*?)```";
export const SKILL_FENCE_REGEX_SOURCE = "```skillweaver-skill[^\\n]*\\r?\\n([\\s\\S]*?)```";

export const PAGE_ICON_SVG = `<svg class="ai-page-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h5.5L13 5.5V14H4z"/><path d="M9.5 2v3.5H13"/><path d="M6.2 8.2h4.2M6.2 10.7h3.2"/></svg>`;

export const PAGE_LINK_ICON_SVG = `<svg class="ai-link-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2h5.5L12 5.5V8.5M3 2v11.5h4.2"/><path d="M8.5 2v3.5H12"/><path d="M5 7.5h3.2M5 10h2"/><path d="M9.5 14l4-4M10.5 10h3v3"/></svg>`;

export const SKILL_ICON_SVG = `<svg class="ai-skill-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2l1.35 3.65L13 7l-3.65 1.35L8 12l-1.35-3.65L3 7l3.65-1.35z"/><path d="M12.6 10.6l.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55z"/></svg>`;

function extractFencesWithRegex(text, regexSource) {
  const src = String(text || "");
  const regex = new RegExp(regexSource, "g");
  const fences = [];
  let match;
  while ((match = regex.exec(src)) !== null) {
    fences.push({
      start: match.index,
      end: regex.lastIndex,
      rawJson: match[1].trim(),
    });
  }
  return fences;
}

export function extractEditFences(text) {
  return extractFencesWithRegex(text, EDIT_FENCE_REGEX_SOURCE);
}

export function extractSkillFences(text) {
  return extractFencesWithRegex(text, SKILL_FENCE_REGEX_SOURCE);
}

export function stripEditFences(text) {
  return String(text || "")
    .replace(new RegExp(EDIT_FENCE_REGEX_SOURCE, "g"), "")
    .replace(new RegExp(SKILL_FENCE_REGEX_SOURCE, "g"), "")
    .trim();
}

export const stripProposalFences = stripEditFences;

export function isTruncatedFinishReason(reason) {
  if (!reason) return false;
  const lower = String(reason).trim().toLowerCase();
  return lower === "length" || lower === "max_tokens";
}

export function tryParseJsonWithRepair(raw) {
  let candidate = String(raw || "").trim();
  if (!candidate) return null;
  if (candidate.startsWith("```")) {
    candidate = candidate
      .replace(/^```[a-zA-Z0-9_-]*\r?\n?/, "")
      .replace(/\r?\n?```$/, "")
      .trim();
  }
  try {
    return JSON.parse(candidate);
  } catch {
    const firstBracket = candidate.indexOf("[");
    const firstBrace = candidate.indexOf("{");
    let startIdx = -1;
    let endIdx = -1;
    if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
      startIdx = firstBracket;
      endIdx = candidate.lastIndexOf("]");
    } else if (firstBrace !== -1) {
      startIdx = firstBrace;
      endIdx = candidate.lastIndexOf("}");
    }
    if (startIdx === -1 || endIdx <= startIdx) return null;
    const sliced = candidate.slice(startIdx, endIdx + 1).replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(sliced);
    } catch {
      return null;
    }
  }
}

export function parseEditOps(rawJson) {
  const parsed = tryParseJsonWithRepair(rawJson);
  if (!parsed) return null;
  const rawOps = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.edits)
      ? parsed.edits
      : Array.isArray(parsed?.operations)
        ? parsed.operations
        : null;
  if (!Array.isArray(rawOps) || !rawOps.length) return null;

  const normalized = [];
  for (const op of rawOps) {
    if (!op || typeof op.op !== "string") continue;
    if (op.op === "replace") {
      if (
        typeof op.block_id === "string" &&
        op.block_id.trim().length > 0 &&
        op.block &&
        typeof op.block === "object"
      ) {
        normalized.push(op);
      }
    } else if (op.op === "insert_after") {
      const blocks = Array.isArray(op.blocks)
        ? op.blocks
        : op.block && typeof op.block === "object"
          ? [op.block]
          : null;
      if (typeof op.block_id === "string" && op.block_id.trim().length > 0 && blocks && blocks.length > 0) {
        normalized.push({ ...op, blocks });
      }
    } else if (op.op === "append") {
      const blocks = Array.isArray(op.blocks)
        ? op.blocks
        : op.block && typeof op.block === "object"
          ? [op.block]
          : null;
      if (blocks && blocks.length > 0) {
        normalized.push({ ...op, blocks });
      }
    } else if (op.op === "delete") {
      if (typeof op.block_id === "string" && op.block_id.trim().length > 0) {
        normalized.push(op);
      }
    }
  }
  return normalized.length ? normalized : null;
}

export function normalizeSkillSlug(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

export function parseSkillProposal(rawJson) {
  const parsed = tryParseJsonWithRepair(rawJson);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const body =
    typeof parsed.body === "string"
      ? parsed.body.trim()
      : typeof parsed.instructions === "string"
        ? parsed.instructions.trim()
        : "";
  const rawSlug = typeof parsed.slug === "string" ? parsed.slug.trim() : "";
  const rawName = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!body || (!rawSlug && !rawName)) return null;

  const slug = normalizeSkillSlug(rawSlug || rawName);
  if (!slug) return null;

  const scope = String(parsed.scope || "vault").trim().toLowerCase() === "global" ? "global" : "vault";
  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  return {
    slug,
    name: rawName || slug,
    description,
    scope,
    body,
  };
}

export function summarizeBlockPayload(block) {
  if (!block) return "";
  if (block.type === "heading") return `${"#".repeat(block.level || 1)} ${block.content || ""}`;
  if (block.type === "bullet_list") return `• ${block.content || ""}`;
  if (block.type === "numbered_list") return `1. ${block.content || ""}`;
  if (block.type === "todo") return `[${block.checked ? "x" : " "}] ${block.content || ""}`;
  if (block.type === "quote") return `> ${block.content || ""}`;
  if (block.type === "divider") return "--- (Divider)";
  if (block.type === "code") return `\`\`\`${block.language || ""}\n${block.content || ""}\n\`\`\``;
  if (block.type === "table") {
    const rows = Array.isArray(block.rows)
      ? block.rows
      : Array.isArray(block.headers)
        ? [block.headers]
        : [];
    const colCount = rows[0]?.length || block.alignments?.length || 0;
    const headerPreview = (rows[0] || []).slice(0, 3).join(" | ");
    return `Table (${rows.length}×${colCount})${headerPreview ? `: ${headerPreview}` : ""}`;
  }
  return block.content || "";
}

export function compactAssistantHistoryContent(msg) {
  const text = String(msg?.content || "");
  const allFences = [
    ...extractEditFences(text).map((f, idx) => ({ ...f, kind: "edit", idx })),
    ...extractSkillFences(text).map((f, idx) => ({ ...f, kind: "skill", idx })),
  ].sort((a, b) => a.start - b.start);
  if (!allFences.length) return text;

  let out = "";
  let lastIdx = 0;
  for (const f of allFences) {
    out += text.slice(lastIdx, f.start);
    if (f.kind === "edit") {
      const ops = parseEditOps(f.rawJson);
      const count = ops ? ops.length : 0;
      const countLabel = count > 0 ? `${count} page edit${count === 1 ? "" : "s"}` : "page edits";
      const status = msg?.proposalStates?.[f.idx] || "pending";
      const statusLabel =
        status === "accepted"
          ? "Accepted by user"
          : status === "rejected"
            ? "Rejected by user"
            : "Pending review";
      out += `[Proposed ${countLabel} — ${statusLabel}]`;
    } else {
      const proposal = parseSkillProposal(f.rawJson);
      const label = proposal ? `@${proposal.slug}` : "skill";
      const status = msg?.proposalStates?.[`skill-${f.idx}`] || "pending";
      const statusLabel =
        status === "accepted"
          ? "Saved by user"
          : status === "accepted-pinned"
            ? "Saved & pinned by user"
            : status === "rejected"
              ? "Rejected by user"
              : "Pending review";
      out += `[Proposed skill ${label} — ${statusLabel}]`;
    }
    lastIdx = f.end;
  }
  out += text.slice(lastIdx);
  return out.trim();
}

function renderInlineLinkButtonHtml(target, label = "") {
  const display = escapeHtml(displayNameForLink(target, label));
  const escTarget = escapeHtml(target);
  return `<button class="ai-ref-link ai-inline-link-btn" data-target="${escTarget}" type="button" title="${escTarget}">${PAGE_LINK_ICON_SVG}<span class="ai-inline-link-label">${display}</span></button>`;
}

function renderInlineSkillButtonHtml(slug) {
  const cleanSlug = String(slug || "").toLowerCase();
  const escSlug = escapeHtml(cleanSlug);
  return `<button class="ai-inline-skill-btn" data-skill-slug="${escSlug}" type="button" title="Open skill @${escSlug}">${SKILL_ICON_SVG}<span class="ai-inline-skill-label">@${escapeHtml(slug)}</span></button>`;
}

function renderPlainUserSegment(seg, knownSkillSlugs) {
  if (!seg) return "";
  if (!knownSkillSlugs || knownSkillSlugs.size === 0) {
    return escapeHtml(seg).replace(/\n/g, "<br>");
  }

  const skillRegex = /(^|[\s(\[])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})(?=$|[\s.,!?;:)\]])/g;
  let out = "";
  let lastIdx = 0;
  let match;
  while ((match = skillRegex.exec(seg)) !== null) {
    const lead = match[1] || "";
    const rawSlug = match[2];
    const tokenStart = match.index + lead.length;
    if (knownSkillSlugs.has(rawSlug.toLowerCase())) {
      if (tokenStart > lastIdx) {
        out += escapeHtml(seg.slice(lastIdx, tokenStart)).replace(/\n/g, "<br>");
      }
      out += renderInlineSkillButtonHtml(rawSlug);
      lastIdx = skillRegex.lastIndex;
    }
  }
  if (lastIdx < seg.length) {
    out += escapeHtml(seg.slice(lastIdx)).replace(/\n/g, "<br>");
  }
  return out;
}

export function renderUserMessageHtml(text, knownSkillSlugs = null) {
  const src = String(text || "");
  const regex = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
  let out = "";
  let lastIdx = 0;
  let match;
  while ((match = regex.exec(src)) !== null) {
    if (match.index > lastIdx) {
      out += renderPlainUserSegment(src.slice(lastIdx, match.index), knownSkillSlugs);
    }
    const target = match[1].trim();
    const label = (match[2] || "").trim();
    if (target) {
      out += renderInlineLinkButtonHtml(target, label);
    } else {
      out += renderPlainUserSegment(match[0], knownSkillSlugs);
    }
    lastIdx = regex.lastIndex;
  }
  if (lastIdx < src.length) {
    out += renderPlainUserSegment(src.slice(lastIdx), knownSkillSlugs);
  }
  return out;
}

export function renderInlineFormattedText(text) {
  const tokens = [];
  const withTokens = String(text || "").replace(
    /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g,
    (full, rawTarget, rawLabel) => {
      const target = rawTarget.trim();
      const label = (rawLabel || "").trim();
      if (!target) return full;
      const idx = tokens.length;
      tokens.push(renderInlineLinkButtonHtml(target, label));
      return `\uE000SWLINK${idx}\uE001`;
    }
  );
  // Render clickable [[wikilinks]], inline code, bold, and italic cleanly inside assistant bubbles
  const formatted = escapeHtml(withTokens)
    .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s\n](?:[^*\n]*[^*\s\n])?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
  return formatted.replace(/\uE000SWLINK(\d+)\uE001/g, (_, i) => tokens[Number(i)] || "");
}

function renderEditProposalCard(ops, msg, pIdx, fileBadgeHtml) {
  const status = msg.proposalStates?.[pIdx] || "pending";
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

  return `
      <div class="ai-proposal-card">
        <div class="ai-proposal-title">Proposed Page Edits (${ops.length})${fileBadgeHtml}</div>
        <div class="ai-proposal-ops">${summaryHtml}</div>
        <div class="ai-proposal-actions">${footerHtml}</div>
      </div>
    `;
}

function renderSkillProposalCard(proposal, msg, sIdx) {
  const status = msg.proposalStates?.[`skill-${sIdx}`] || "pending";
  const scopeLabel = proposal.scope === "global" ? "Global" : "Vault";
  const previewLines = proposal.body.split("\n").slice(0, 6).join("\n");
  const clippedPreview =
    previewLines.length > 260 ? `${previewLines.slice(0, 260).trimEnd()}…` : previewLines;

  let footerHtml = "";
  if (status === "accepted") {
    footerHtml = `<span class="ai-proposal-status accepted">Saved to Skill Bank</span>`;
  } else if (status === "accepted-pinned") {
    footerHtml = `<span class="ai-proposal-status accepted">Saved &amp; Pinned</span>`;
  } else if (status === "rejected") {
    footerHtml = `<span class="ai-proposal-status rejected">Dismissed</span>`;
  } else {
    const msgAttr = `data-msg="${escapeHtml(msg.id)}" data-skill-prop="${sIdx}"`;
    footerHtml = `
        <button class="ai-accept-btn" data-skill-action="save" ${msgAttr} type="button">Save Skill</button>
        <button class="ai-mini-btn ai-skill-save-pin-btn" data-skill-action="save-pin" ${msgAttr} type="button">Save &amp; Pin</button>
        <button class="ai-mini-btn" data-skill-action="edit" ${msgAttr} type="button">Edit</button>
        <button class="ai-reject-btn" data-skill-action="reject" ${msgAttr} type="button">Reject</button>
      `;
  }

  const descHtml = proposal.description
    ? `<div class="ai-skill-proposal-desc">${escapeHtml(proposal.description)}</div>`
    : "";

  return `
      <div class="ai-proposal-card ai-skill-proposal-card">
        <div class="ai-proposal-title ai-skill-proposal-title">
          ${SKILL_ICON_SVG}
          <span>Proposed Skill: @${escapeHtml(proposal.slug)}</span>
          <span class="ai-skill-scope">${scopeLabel}</span>
        </div>
        ${descHtml}
        <pre class="ai-skill-preview"><code>${escapeHtml(clippedPreview)}</code></pre>
        <div class="ai-proposal-actions">${footerHtml}</div>
      </div>
    `;
}

export function renderAssistantContentHtml(msg, isStreamingThisMsg = false) {
  const text = msg.content || "";
  const parts = [];
  const allFences = [
    ...extractEditFences(text).map((f, idx) => ({ ...f, kind: "edit", idx })),
    ...extractSkillFences(text).map((f, idx) => ({ ...f, kind: "skill", idx })),
  ].sort((a, b) => a.start - b.start);

  const fileBadgeHtml = msg.sourceFile
    ? ` <span class="ai-proposal-file" title="Target note">${escapeHtml(msg.sourceFile)}</span>`
    : "";
  let lastIdx = 0;

  for (const fence of allFences) {
    if (fence.start > lastIdx) {
      parts.push(`<div class="ai-text">${renderInlineFormattedText(text.slice(lastIdx, fence.start))}</div>`);
    }

    if (fence.kind === "edit") {
      const ops = parseEditOps(fence.rawJson);
      if (ops) {
        parts.push(renderEditProposalCard(ops, msg, fence.idx, fileBadgeHtml));
      } else {
        parts.push(`<pre class="ai-code-preview"><code>${escapeHtml(fence.rawJson)}</code></pre>`);
      }
    } else {
      const proposal = parseSkillProposal(fence.rawJson);
      if (proposal) {
        parts.push(renderSkillProposalCard(proposal, msg, fence.idx));
      } else {
        parts.push(`<pre class="ai-code-preview"><code>${escapeHtml(fence.rawJson)}</code></pre>`);
      }
    }

    lastIdx = fence.end;
  }

  if (lastIdx < text.length) {
    const remainder = text.slice(lastIdx);
    const openMatch = isStreamingThisMsg ? remainder.match(/```skillweaver-(edits|skill)\b/i) : null;
    if (openMatch) {
      const before = remainder.slice(0, openMatch.index);
      if (before.trim()) {
        parts.push(`<div class="ai-text">${renderInlineFormattedText(before)}</div>`);
      }
      const isSkill = openMatch[1].toLowerCase() === "skill";
      parts.push(`
          <div class="ai-proposal-card ai-proposal-streaming${isSkill ? " ai-skill-proposal-card" : ""}">
            <div class="ai-proposal-title">${isSkill ? "Drafting skill…" : `Drafting page edits…${fileBadgeHtml}`}</div>
            <div class="ai-thinking">${isSkill ? "Preparing reusable SKILL.md instructions…" : "Preparing structured block changes…"}</div>
          </div>
        `);
    } else {
      parts.push(`<div class="ai-text">${renderInlineFormattedText(remainder)}</div>`);
    }
  }

  if (!isStreamingThisMsg && isTruncatedFinishReason(msg.finishReason)) {
    parts.push(
      `<div class="ai-truncation-warn">Response stopped early (max output limit reached). Text or proposed edits may be incomplete.</div>`
    );
  }

  return parts.join("") || `<span class="ai-thinking">Thinking…</span>`;
}
