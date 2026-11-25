import { displayNameForLink, escapeHtml } from "../inline.js";

export const EDIT_FENCE_REGEX_SOURCE = "```skillweaver-edits[^\\n]*\\r?\\n([\\s\\S]*?)```";

export const PAGE_ICON_SVG = `<svg class="ai-page-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h5.5L13 5.5V14H4z"/><path d="M9.5 2v3.5H13"/><path d="M6.2 8.2h4.2M6.2 10.7h3.2"/></svg>`;

export const PAGE_LINK_ICON_SVG = `<svg class="ai-link-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2h5.5L12 5.5V8.5M3 2v11.5h4.2"/><path d="M8.5 2v3.5H12"/><path d="M5 7.5h3.2M5 10h2"/><path d="M9.5 14l4-4M10.5 10h3v3"/></svg>`;

export function extractEditFences(text) {
  const src = String(text || "");
  const regex = new RegExp(EDIT_FENCE_REGEX_SOURCE, "g");
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

export function stripEditFences(text) {
  return String(text || "")
    .replace(new RegExp(EDIT_FENCE_REGEX_SOURCE, "g"), "")
    .trim();
}

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
  const fences = extractEditFences(text);
  if (!fences.length) return text;

  let out = "";
  let lastIdx = 0;
  fences.forEach((f, idx) => {
    out += text.slice(lastIdx, f.start);
    const ops = parseEditOps(f.rawJson);
    const count = ops ? ops.length : 0;
    const countLabel = count > 0 ? `${count} page edit${count === 1 ? "" : "s"}` : "page edits";
    const status = msg?.proposalStates?.[idx] || "pending";
    const statusLabel =
      status === "accepted"
        ? "Accepted by user"
        : status === "rejected"
          ? "Rejected by user"
          : "Pending review";
    out += `[Proposed ${countLabel} — ${statusLabel}]`;
    lastIdx = f.end;
  });
  out += text.slice(lastIdx);
  return out.trim();
}

function renderInlineLinkButtonHtml(target, label = "") {
  const display = escapeHtml(displayNameForLink(target, label));
  const escTarget = escapeHtml(target);
  return `<button class="ai-ref-link ai-inline-link-btn" data-target="${escTarget}" type="button" title="${escTarget}">${PAGE_LINK_ICON_SVG}<span class="ai-inline-link-label">${display}</span></button>`;
}

export function renderUserMessageHtml(text) {
  const src = String(text || "");
  const regex = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
  let out = "";
  let lastIdx = 0;
  let match;
  while ((match = regex.exec(src)) !== null) {
    if (match.index > lastIdx) {
      out += escapeHtml(src.slice(lastIdx, match.index)).replace(/\n/g, "<br>");
    }
    const target = match[1].trim();
    const label = (match[2] || "").trim();
    if (target) {
      out += renderInlineLinkButtonHtml(target, label);
    } else {
      out += escapeHtml(match[0]).replace(/\n/g, "<br>");
    }
    lastIdx = regex.lastIndex;
  }
  if (lastIdx < src.length) {
    out += escapeHtml(src.slice(lastIdx)).replace(/\n/g, "<br>");
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

export function renderAssistantContentHtml(msg, isStreamingThisMsg = false) {
  const text = msg.content || "";
  const parts = [];
  const fences = extractEditFences(text);
  const fileBadgeHtml = msg.sourceFile
    ? ` <span class="ai-proposal-file" title="Target note">${escapeHtml(msg.sourceFile)}</span>`
    : "";
  let lastIdx = 0;

  fences.forEach((fence, pIdx) => {
    if (fence.start > lastIdx) {
      parts.push(`<div class="ai-text">${renderInlineFormattedText(text.slice(lastIdx, fence.start))}</div>`);
    }

    const ops = parseEditOps(fence.rawJson);
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
            <div class="ai-proposal-title">Proposed Page Edits (${ops.length})${fileBadgeHtml}</div>
            <div class="ai-proposal-ops">${summaryHtml}</div>
            <div class="ai-proposal-actions">${footerHtml}</div>
          </div>
        `);
    } else {
      parts.push(`<pre class="ai-code-preview"><code>${escapeHtml(fence.rawJson)}</code></pre>`);
    }

    lastIdx = fence.end;
  });

  if (lastIdx < text.length) {
    const remainder = text.slice(lastIdx);
    const openFenceIdx = isStreamingThisMsg ? remainder.search(/```skillweaver-edits\b/i) : -1;
    if (openFenceIdx !== -1) {
      const before = remainder.slice(0, openFenceIdx);
      if (before.trim()) {
        parts.push(`<div class="ai-text">${renderInlineFormattedText(before)}</div>`);
      }
      parts.push(`
          <div class="ai-proposal-card ai-proposal-streaming">
            <div class="ai-proposal-title">Drafting page edits…${fileBadgeHtml}</div>
            <div class="ai-thinking">Preparing structured block changes…</div>
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
