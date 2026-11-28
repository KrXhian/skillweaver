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
 * Deterministic inline Markdown <-> DOM codec for Skillweaver blocks.
 * Supports bold (**text**), inline code (`code`), ==highlight==,
 * <span data-color/bg="..."> inline colors, [[wikilinks]], and [label](target.md).
 */

export const BLOCK_COLORS = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];

const VALID_COLOR_SET = new Set(BLOCK_COLORS);

export function isValidColorName(name) {
  return typeof name === "string" && VALID_COLOR_SET.has(name);
}

function findMatchingSpanClose(text, startIdx) {
  let depth = 1;
  let pos = startIdx;
  while (pos < text.length) {
    const closeIdx = text.indexOf("</span>", pos);
    if (closeIdx === -1) return -1;
    let openIdx = text.indexOf("<span", pos);
    while (openIdx !== -1 && openIdx < closeIdx) {
      const nextCh = text[openIdx + 5];
      if (nextCh === ">" || nextCh === " " || nextCh === "\t" || nextCh === "\n") {
        break;
      }
      openIdx = text.indexOf("<span", openIdx + 5);
    }
    if (openIdx !== -1 && openIdx < closeIdx) {
      depth += 1;
      pos = openIdx + 5;
    } else {
      depth -= 1;
      if (depth === 0) return closeIdx;
      pos = closeIdx + 7;
    }
  }
  return -1;
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanTargetKey(raw) {
  const noAnchor = String(raw || "").split("#")[0].trim().replace(/\\/g, "/");
  return noAnchor.replace(/^\.\//, "").replace(/^\//, "").replace(/\.md$/i, "").toLowerCase();
}

export function buildPageLookup(pages = []) {
  const targets = new Set();
  const titles = new Set();
  for (const p of pages) {
    targets.add(cleanTargetKey(p.link_target));
    titles.add(p.title.toLowerCase());
  }
  return {
    has(target) {
      const key = cleanTargetKey(target);
      if (!key) return false;
      if (targets.has(key)) return true;
      const base = key.split("/").pop();
      return titles.has(base);
    },
  };
}

export function displayNameForLink(target, label) {
  if (label && label.trim()) return label.trim();
  const raw = String(target || "").trim().replace(/\\/g, "/");
  const [pagePart, anchorPart] = raw.split("#");
  const base = (pagePart.split("/").pop() || pagePart).replace(/\.md$/i, "");
  if (anchorPart) {
    if (anchorPart.startsWith("^")) {
      return base ? `${base} §` : "Block link";
    }
    return base ? `${base} #${anchorPart}` : `#${anchorPart}`;
  }
  return base;
}

export function createPageLinkElement(target, label = "", exists = true) {
  const span = document.createElement("span");
  span.className = exists ? "page-link" : "page-link page-link-missing";
  span.setAttribute("contenteditable", "false");
  span.spellcheck = false;
  span.setAttribute("spellcheck", "false");
  span.dataset.target = target;
  if (label) {
    span.dataset.label = label;
  }
  span.textContent = displayNameForLink(target, label);
  return span;
}

function renderLinkHtml(target, label, pageLookup) {
  const exists = !pageLookup || pageLookup.has(target);
  const cls = exists ? "page-link" : "page-link page-link-missing";
  const labelAttr = label ? ` data-label="${escapeHtml(label)}"` : "";
  const display = escapeHtml(displayNameForLink(target, label));
  return `<span class="${cls}" contenteditable="false" spellcheck="false" data-target="${escapeHtml(target)}"${labelAttr}>${display}</span>`;
}

function tokenizeInline(text, pageLookup, insideBold = false, insideItalic = false) {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    // Newline -> <br>
    if (ch === "\n") {
      out += "<br>";
      i += 1;
      continue;
    }

    // Inline code: `...`
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) {
        const codeContent = text.slice(i + 1, close);
        if (!codeContent.includes("\n")) {
          out += `<code class="inline-code" spellcheck="false">${escapeHtml(codeContent)}</code>`;
          i = close + 1;
          continue;
        }
      }
    }

    // Wikilink: [[target]] or [[target|label]]
    if (ch === "[" && text[i + 1] === "[") {
      const close = text.indexOf("]]", i + 2);
      if (close !== -1) {
        const inner = text.slice(i + 2, close);
        if (!inner.includes("\n") && inner.trim().length > 0) {
          const pipeIdx = inner.indexOf("|");
          const target = (pipeIdx === -1 ? inner : inner.slice(0, pipeIdx)).trim();
          const label = pipeIdx === -1 ? "" : inner.slice(pipeIdx + 1).trim();
          if (target) {
            out += renderLinkHtml(target, label, pageLookup);
            i = close + 2;
            continue;
          }
        }
      }
    }

    // Relative Markdown link: [label](target.md)
    if (ch === "[" && (i === 0 || text[i - 1] !== "!")) {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeBracket).trim();
          const href = text.slice(closeBracket + 2, closeParen).trim();
          const lower = href.toLowerCase();
          if (
            href &&
            !href.includes("\n") &&
            !lower.startsWith("http://") &&
            !lower.startsWith("https://") &&
            !lower.startsWith("mailto:") &&
            !href.startsWith("#")
          ) {
            const cleanHref = href.replace(/\.md$/i, "");
            const defaultDisplay = displayNameForLink(cleanHref, "");
            const customLabel = label && label !== defaultDisplay ? label : "";
            out += renderLinkHtml(cleanHref, customLabel, pageLookup);
            i = closeParen + 1;
            continue;
          }
        }
      }
    }

    // Highlight: ==...==
    if (ch === "=" && text[i + 1] === "=") {
      const close = text.indexOf("==", i + 2);
      if (close > i + 2) {
        const inner = text.slice(i + 2, close);
        if (!inner.includes("\n")) {
          out += `<mark class="inline-highlight">${tokenizeInline(inner, pageLookup, insideBold, insideItalic)}</mark>`;
          i = close + 2;
          continue;
        }
      }
    }

    // Bold: **...**
    if (!insideBold && ch === "*" && text[i + 1] === "*") {
      const close = text.indexOf("**", i + 2);
      if (close > i + 2) {
        const inner = text.slice(i + 2, close);
        if (!inner.includes("\n")) {
          out += `<strong>${tokenizeInline(inner, pageLookup, true, insideItalic)}</strong>`;
          i = close + 2;
          continue;
        }
      }
    }

    // Italic: *...*
    if (!insideItalic && ch === "*" && text[i + 1] !== "*" && i + 1 < text.length) {
      const nextCh = text[i + 1];
      if (nextCh !== " " && nextCh !== "\t" && nextCh !== "\n") {
        let j = i + 1;
        let closeIdx = -1;
        while (j < text.length && text[j] !== "\n") {
          if (text[j] === "*") {
            const prevCh = text[j - 1];
            const afterCh = text[j + 1];
            const isClosingTripleInsideBold = insideBold && afterCh === "*" && text[j + 2] !== "*";
            if (prevCh !== " " && prevCh !== "\t" && (afterCh !== "*" || isClosingTripleInsideBold)) {
              closeIdx = j;
              break;
            }
          }
          j += 1;
        }
        if (closeIdx > i + 1) {
          const inner = text.slice(i + 1, closeIdx);
          out += `<em>${tokenizeInline(inner, pageLookup, insideBold, true)}</em>`;
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // Inline color span: <span data-color="..." data-bg="...">...</span>
    if (ch === "<" && text.startsWith("<span", i)) {
      const spanMatch = text
        .slice(i)
        .match(
          /^<span((?:\s+data-(?:color|bg)="(?:gray|brown|orange|yellow|green|blue|purple|pink|red)"){1,2})>/
        );
      if (spanMatch) {
        const attrs = spanMatch[1];
        const colorM = attrs.match(/data-color="([a-z]+)"/);
        const bgM = attrs.match(/data-bg="([a-z]+)"/);
        const c = colorM && isValidColorName(colorM[1]) ? colorM[1] : "";
        const bg = bgM && isValidColorName(bgM[1]) ? bgM[1] : "";
        if (c || bg) {
          const contentStart = i + spanMatch[0].length;
          const closeIdx = findMatchingSpanClose(text, contentStart);
          if (closeIdx !== -1) {
            const inner = text.slice(contentStart, closeIdx);
            const cls = `sw-inline-color${c ? ` sw-color-${c}` : ""}${bg ? ` sw-bg-${bg}` : ""}`;
            const cAttr = c ? ` data-color="${c}"` : "";
            const bgAttr = bg ? ` data-bg="${bg}"` : "";
            out += `<span class="${cls}"${cAttr}${bgAttr}>${tokenizeInline(inner, pageLookup, insideBold, insideItalic)}</span>`;
            i = closeIdx + 7;
            continue;
          }
        }
      }
    }

    out += escapeHtml(ch);
    i += 1;
  }

  return out;
}

/**
 * Converts inline Markdown to safe HTML for a contenteditable block.
 */
export function inlineMarkdownToHtml(md, pageLookup) {
  if (!md) return "";
  return tokenizeInline(md, pageLookup, false, false);
}

function serializeChildNodes(parent, insideBold = false, insideItalic = false) {
  let out = "";
  const children = Array.from(parent.childNodes);

  for (let idx = 0; idx < children.length; idx++) {
    const node = children[idx];

    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.nodeValue || "").replace(/\u200B/g, "");
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const tag = node.tagName.toUpperCase();

    if (node.classList.contains("page-link")) {
      const target = node.dataset.target || "";
      const label = node.dataset.label || "";
      if (target) {
        out += label ? `[[${target}|${label}]]` : `[[${target}]]`;
      }
      continue;
    }

    if (node.classList.contains("sw-inline-color")) {
      const inner = serializeChildNodes(node, insideBold, insideItalic);
      if (inner.length === 0) continue;
      const c = isValidColorName(node.dataset.color) ? node.dataset.color : "";
      const bg = isValidColorName(node.dataset.bg) ? node.dataset.bg : "";
      if (!c && !bg) {
        out += inner;
      } else {
        const cAttr = c ? ` data-color="${c}"` : "";
        const bgAttr = bg ? ` data-bg="${bg}"` : "";
        out += `<span${cAttr}${bgAttr}>${inner}</span>`;
      }
      continue;
    }

    if (tag === "BR") {
      // Ignore browser-inserted trailing sentinel <br> at the end of a contenteditable element
      const isTrailingSentinel = idx === children.length - 1 && out.length > 0 && !out.endsWith("\n");
      if (isTrailingSentinel && node.getAttribute("type") === "_moz") {
        continue;
      }
      if (idx === children.length - 1 && children.length === 1 && out === "") {
        continue;
      }
      // Standard trailing BR in empty line vs intentional line break:
      if (idx === children.length - 1) {
        continue;
      }
      out += "\n";
      continue;
    }

    if (tag === "CODE") {
      const codeText = (node.textContent || "").replace(/\u200B/g, "");
      out += `\`${codeText}\``;
      continue;
    }

    if (tag === "MARK") {
      const inner = serializeChildNodes(node, insideBold, insideItalic);
      if (inner.length === 0) continue;
      out += `==${inner}==`;
      continue;
    }

    if (tag === "STRONG" || tag === "B") {
      const inner = serializeChildNodes(node, true, insideItalic);
      if (inner.length === 0) continue;
      if (insideBold) {
        out += inner;
      } else {
        out += `**${inner}**`;
      }
      continue;
    }

    if (tag === "EM" || tag === "I") {
      const inner = serializeChildNodes(node, insideBold, true);
      if (inner.length === 0) continue;
      if (insideItalic) {
        out += inner;
      } else {
        out += `*${inner}*`;
      }
      continue;
    }

    if (tag === "DIV" || tag === "P") {
      const inner = serializeChildNodes(node, insideBold, insideItalic);
      if (out.length > 0 && !out.endsWith("\n")) {
        out += "\n";
      }
      out += inner;
      continue;
    }

    out += serializeChildNodes(node, insideBold, insideItalic);
  }

  return out;
}

/**
 * Serializes a contenteditable block DOM back to inline Markdown.
 */
export function domToInlineMarkdown(el) {
  return serializeChildNodes(el, false, false).replace(/\u200B/g, "");
}

/**
 * Detects newly closed `**bold**` or `` `code` `` right before the caret
 * and converts it into a styled DOM element in-place.
 * Returns true if a conversion occurred.
 */
export function tryAutoFormatInline(el) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;

  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return false;
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;

  const textNode = range.startContainer;
  // Do not nest inside existing inline code or page link
  if (textNode.parentElement?.closest("code, .page-link")) {
    return false;
  }

  const offset = range.startOffset;
  const full = textNode.nodeValue || "";
  const before = full.slice(0, offset);
  const after = full.slice(offset);

  // Match newly closed `inline code`
  const codeMatch = before.match(/`([^`\n]+)`$/);
  if (codeMatch) {
    const inside = codeMatch[1];
    const startIdx = before.length - codeMatch[0].length;
    const prefix = before.slice(0, startIdx);

    const codeEl = document.createElement("code");
    codeEl.className = "inline-code";
    codeEl.spellcheck = false;
    codeEl.setAttribute("spellcheck", "false");
    codeEl.textContent = inside;

    const parent = textNode.parentNode;
    if (prefix) {
      parent.insertBefore(document.createTextNode(prefix), textNode);
    }
    parent.insertBefore(codeEl, textNode);
    const trailing = document.createTextNode(after.length > 0 ? after : "\u200B");
    parent.insertBefore(trailing, textNode);
    parent.removeChild(textNode);

    const nextRange = document.createRange();
    nextRange.setStart(trailing, after.length > 0 ? 0 : 1);
    nextRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(nextRange);
    return true;
  }

  // Match newly closed **bold** (skip if already inside <strong>)
  if (!textNode.parentElement?.closest("strong, b")) {
    const boldMatch = before.match(/\*\*([^*\n]+)\*\*$/);
    if (boldMatch) {
      const inside = boldMatch[1];
      const startIdx = before.length - boldMatch[0].length;
      const prefix = before.slice(0, startIdx);

      const strongEl = document.createElement("strong");
      strongEl.textContent = inside;

      const parent = textNode.parentNode;
      if (prefix) {
        parent.insertBefore(document.createTextNode(prefix), textNode);
      }
      parent.insertBefore(strongEl, textNode);
      const trailing = document.createTextNode(after.length > 0 ? after : "\u200B");
      parent.insertBefore(trailing, textNode);
      parent.removeChild(textNode);

      const nextRange = document.createRange();
      nextRange.setStart(trailing, after.length > 0 ? 0 : 1);
      nextRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nextRange);
      return true;
    }
  }

  // Match newly closed ==highlight== (skip if already inside <mark>)
  if (!textNode.parentElement?.closest("mark")) {
    const hlMatch = before.match(/==([^=\n]+)==$/);
    if (hlMatch) {
      const inside = hlMatch[1];
      const startIdx = before.length - hlMatch[0].length;
      const prefix = before.slice(0, startIdx);

      const markEl = document.createElement("mark");
      markEl.className = "inline-highlight";
      markEl.textContent = inside;

      const parent = textNode.parentNode;
      if (prefix) {
        parent.insertBefore(document.createTextNode(prefix), textNode);
      }
      parent.insertBefore(markEl, textNode);
      const trailing = document.createTextNode(after.length > 0 ? after : "\u200B");
      parent.insertBefore(trailing, textNode);
      parent.removeChild(textNode);

      const nextRange = document.createRange();
      nextRange.setStart(trailing, after.length > 0 ? 0 : 1);
      nextRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nextRange);
      return true;
    }
  }

  // Match newly closed *italic* (skip if already inside <em> or **)
  if (!textNode.parentElement?.closest("em, i")) {
    const emMatch = before.match(/(^|[^*])\*([^*\s\n](?:[^*\n]*[^*\s\n])?)\*$/);
    if (emMatch) {
      const inside = emMatch[2];
      const lead = emMatch[1] || "";
      const startIdx = before.length - emMatch[0].length + lead.length;
      const prefix = before.slice(0, startIdx);

      const emEl = document.createElement("em");
      emEl.textContent = inside;

      const parent = textNode.parentNode;
      if (prefix) {
        parent.insertBefore(document.createTextNode(prefix), textNode);
      }
      parent.insertBefore(emEl, textNode);
      const trailing = document.createTextNode(after.length > 0 ? after : "\u200B");
      parent.insertBefore(trailing, textNode);
      parent.removeChild(textNode);

      const nextRange = document.createRange();
      nextRange.setStart(trailing, after.length > 0 ? 0 : 1);
      nextRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nextRange);
      return true;
    }
  }

  return false;
}
