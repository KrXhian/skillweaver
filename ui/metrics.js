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

/**
 * Lightweight, zero-dependency word, character, reading-time, and BPE-aware token estimators.
 */

const TOKEN_SEGMENT_RE =
  /(?:[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef])|(?:[A-Za-z0-9]+)|(?:[^\sA-Za-z0-9\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]+)/g;
const WORD_RE = /[\p{L}\p{N}]+(?:['’\-_\/\.][\p{L}\p{N}]+)*/gu;
const CAMEL_TRANSITION_RE = /[a-z][A-Z]/g;

/**
 * Estimates LLM input token count for text without loading a heavy tokenizer binary.
 */
export function estimateTokens(text) {
  const clean = String(text || "").replace(/\r/g, "").replace(/\u200B/g, "");
  if (clean.trim().length === 0) return 0;

  let total = 0;
  let match;
  TOKEN_SEGMENT_RE.lastIndex = 0;

  while ((match = TOKEN_SEGMENT_RE.exec(clean)) !== null) {
    const seg = match[0];
    const code = seg.charCodeAt(0);
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      total += 1.5;
    } else if (/^[A-Za-z0-9]/.test(seg)) {
      total += seg.length <= 7 ? 1 : Math.ceil(seg.length / 4.5);
      const camelMatches = seg.match(CAMEL_TRANSITION_RE);
      if (camelMatches) {
        total += camelMatches.length * 0.5;
      }
    } else {
      total += seg.length === 1 ? 0.5 : Math.ceil(seg.length / 2);
    }
  }

  return Math.max(1, Math.round(total));
}

/**
 * Counts human-readable words across Latin, numeric, and Unicode text.
 */
export function countWords(text) {
  const clean = String(text || "").replace(/\u200B/g, "");
  if (!clean.trim()) return 0;
  const matches = clean.match(WORD_RE);
  return matches ? matches.length : 0;
}

/**
 * Computes `{ words, chars, tokens, readMins }` from prose text and optional raw token source.
 */
export function computeTextMetrics(text, tokenSourceText = null) {
  const clean = String(text || "").replace(/\r/g, "").replace(/\u200B/g, "");
  const words = countWords(clean);
  const chars = clean.length;
  const tokens = estimateTokens(tokenSourceText !== null ? tokenSourceText : clean);
  const readMins = words === 0 ? 0 : Math.max(1, Math.round(words / 225));
  return { words, chars, tokens, readMins };
}

function stripInlineSyntaxForProse(md) {
  return String(md || "")
    .replace(/\u200B/g, "")
    .replace(/<span\b[^>]*>([\s\S]*?)<\/span>/gi, "$1")
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, "$2")
    .replace(/\[\[([^\]\n]+)\]\]/g, "$1")
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/==([^=\n]+)==/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
}

/**
 * Computes metrics directly from in-memory editor blocks (zero Rust IPC overhead).
 */
export function extractBlocksMetrics(blocks = []) {
  const list = Array.isArray(blocks) ? blocks : [];
  const proseParts = [];
  const tokenParts = [];

  for (const b of list) {
    if (!b || typeof b !== "object") continue;

    if (b.type === "divider") {
      tokenParts.push("---");
      continue;
    }

    if (b.type === "image") {
      const alt = String(b.alt || "").trim();
      if (alt) proseParts.push(alt);
      tokenParts.push(`![${alt}](${String(b.src || "")})`);
      continue;
    }

    if (b.type === "code") {
      const code = String(b.content || "");
      if (code.trim()) proseParts.push(code);
      tokenParts.push(`\`\`\`${String(b.language || "")}\n${code}\n\`\`\``);
      continue;
    }

    if (b.type === "table") {
      const rows = Array.isArray(b.rows) ? b.rows : [];
      const rowTexts = [];
      const mdRows = [];
      for (const row of rows) {
        const cells = Array.isArray(row) ? row : [];
        rowTexts.push(cells.map((c) => stripInlineSyntaxForProse(c)).join(" "));
        mdRows.push(`| ${cells.map((c) => String(c || "")).join(" | ")} |`);
      }
      const joinedProse = rowTexts.join("\n").trim();
      if (joinedProse) proseParts.push(joinedProse);
      if (mdRows.length) tokenParts.push(mdRows.join("\n"));
      continue;
    }

    const content = String(b.content || "");
    const cleanProse = stripInlineSyntaxForProse(content);
    if (cleanProse.trim()) {
      proseParts.push(cleanProse);
    }

    if (b.type === "heading") {
      const hashes = "#".repeat(Math.min(6, Math.max(1, Number(b.level) || 1)));
      tokenParts.push(`${hashes} ${content}`);
    } else if (b.type === "bullet_list") {
      tokenParts.push(`- ${content}`);
    } else if (b.type === "numbered_list") {
      tokenParts.push(`1. ${content}`);
    } else if (b.type === "todo") {
      tokenParts.push(`- [${b.checked ? "x" : " "}] ${content}`);
    } else if (b.type === "quote") {
      tokenParts.push(`> ${content}`);
    } else if (content) {
      tokenParts.push(content);
    }
  }

  const proseText = proseParts.join("\n");
  const tokenText = tokenParts.join("\n\n");
  return {
    ...computeTextMetrics(proseText, tokenText),
    blockCount: list.length,
  };
}

/**
 * Computes metrics from raw Markdown text, keeping metadata comments out of human word/char counts.
 */
export function extractRawMarkdownMetrics(rawMd) {
  const full = String(rawMd || "").replace(/\r/g, "");
  const withoutMeta = full
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(?:^|\s)\^[a-zA-Z0-9_-]{2,32}(?=\s|$)/gm, "");
  const prose = stripInlineSyntaxForProse(withoutMeta).trim();
  return computeTextMetrics(prose, full);
}

/**
 * Formats a token count compactly for status/skill pills (e.g. `~180 tok`, `~1.4k tok`).
 */
export function formatTokenCompact(tokens) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (n >= 1000) {
    return `~${(n / 1000).toFixed(1)}k tok`;
  }
  return `~${n} tok`;
}
