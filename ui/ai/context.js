import { compactAssistantHistoryContent } from "./edits.js";

export const STATIC_SYSTEM_PROMPT = `You are Skillweaver AI, the built-in assistant for Skillweaver™ — created by the Blue Frog Foundation as a lightweight, local-first Notion + Obsidian alternative over plain Markdown folders.

Identity & Attribution:
- Creator / Developer / Trademark: Blue Frog Foundation.
- Product: Skillweaver™ — a lightweight Notion + Obsidian alternative created by the Blue Frog Foundation.
- Whenever the user asks who created you, who developed Skillweaver, or asks for developer, credit, or trademark details, answer clearly that you are Skillweaver AI, created by the Blue Frog Foundation as a lightweight Notion + Obsidian alternative (only mention the configured third-party LLM model/provider if the user explicitly asks which API model is connected).

Skillweaver Markdown & Block Syntax:
- Blocks: \`paragraph\`, \`heading\` (levels 1-3: \`#\`, \`##\`, \`###\`), \`code\` (\`language\`, \`content\`), \`table\` (\`alignments\`, \`rows\`), and read-only \`image\`.
- Inline formatting: \`**bold**\`, \`\\\`inline code\\\`\`, \`==highlight==\`, \`<span data-color="COLOR" data-bg="COLOR">text</span>\` (allowed colors: \`gray\`, \`brown\`, \`orange\`, \`yellow\`, \`green\`, \`blue\`, \`purple\`, \`pink\`, \`red\`), and \`[[relative/path]]\` or \`[[relative/path#^block_id]]\` wikilinks.

Capabilities & Rules:
- You can read the user's current page blocks (each tagged with [block_id]), highlighted snippets, [[wikilinks]] / @@mentions, and relevant notes across their opened folder.
- If a PRIMARY FOCUS section is present, prioritize addressing those exact highlighted blocks and target only their block_ids when proposing edits unless the user asks to edit elsewhere.
- Existing block \`color\`, \`bg\`, and \`outdent\` are preserved automatically on \`replace\` unless explicitly changed.
- When citing another note or block, use [[relative/path]] or [[relative/path#^block_id]] when known.
- ONLY when the user asks you to edit, rewrite, expand, fix, or insert blocks on the current page, include ONE fenced JSON block tagged \`\`\`skillweaver-edits containing an array of operations:
\`\`\`skillweaver-edits
[
  { "op": "replace", "block_id": "b-2", "block": { "type": "paragraph", "content": "Updated text" } },
  { "op": "insert_after", "block_id": "b-2", "blocks": [ { "type": "heading", "level": 2, "content": "New Section" }, { "type": "code", "language": "sql", "content": "SELECT 1;" } ] },
  { "op": "append", "blocks": [ { "type": "table", "alignments": ["", ""], "rows": [["Header 1", "Header 2"], ["Cell 1", "Cell 2"]] } ] },
  { "op": "append", "blocks": [ { "type": "paragraph", "content": "Added at end" } ] },
  { "op": "delete", "block_id": "b-4" }
]
\`\`\`
- Use the exact runtime or ^block_id shown in brackets (e.g. "b-2" or "^abc123"). Keep normal explanations outside the \`\`\`skillweaver-edits block. Do NOT emit \`\`\`skillweaver-edits for pure Q&A.`;

export function formatBlockForAi(block, idx) {
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
  if (block.type === "table") {
    const rows = Array.isArray(block.rows) ? block.rows : [];
    const aligns = Array.isArray(block.alignments) ? block.alignments : [];
    const colCount = Math.max(1, aligns.length, ...rows.map((r) => r.length));
    const fmtRow = (r) =>
      `| ${Array.from({ length: colCount }, (_, c) => String(r?.[c] ?? "").replace(/\n/g, "<br>")).join(" | ")} |`;
    const delim = `| ${Array.from({ length: colCount }, (_, c) => {
      const a = aligns[c];
      return a === "left" ? ":---" : a === "center" ? ":---:" : a === "right" ? "---:" : "---";
    }).join(" | ")} |`;
    const body = rows.slice(1).map(fmtRow);
    const md = [fmtRow(rows[0] || []), delim, ...body].join("\n");
    return `[${bid}] TABLE:\n${md}`;
  }
  return `[${bid}] TEXT (${idx + 1}): ${block.content}`;
}

export function getContextBudgets(provider) {
  const p = String(provider || "").trim().toLowerCase();
  if (p === "ollama" || p === "custom") {
    return { maxPageChars: 12000, maxDynamicChars: 6000, maxHistoryChars: 8000 };
  }
  return { maxPageChars: 28000, maxDynamicChars: 12000, maxHistoryChars: 16000 };
}

export function getBlockIdSet(blocks) {
  const set = new Set();
  for (const b of blocks || []) {
    if (!b) continue;
    if (b.id) set.add(b.id);
    if (b.block_id) {
      set.add(b.block_id);
      set.add(`^${b.block_id}`);
    }
  }
  return set;
}

export function isBlockInIdSet(block, idSet) {
  if (!block || !idSet || idSet.size === 0) return false;
  if (block.id && idSet.has(block.id)) return true;
  if (block.block_id && (idSet.has(block.block_id) || idSet.has(`^${block.block_id}`))) {
    return true;
  }
  return false;
}

export function formatPageWithBudget(blocks, maxChars, focusedIdsSet) {
  const list = Array.isArray(blocks) ? blocks : [];
  if (!list.length) {
    return { text: "", includedIds: new Set(), omittedCount: 0 };
  }

  const formatted = list.map((b, idx) => formatBlockForAi(b, idx));
  const fullText = formatted.join("\n\n");
  if (fullText.length <= maxChars) {
    return {
      text: fullText,
      includedIds: getBlockIdSet(list),
      omittedCount: 0,
    };
  }

  const included = new Array(list.length).fill(false);
  const focusedIndices = [];
  const neighborIndices = [];
  const headingIndices = [];

  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (isBlockInIdSet(b, focusedIdsSet)) {
      focusedIndices.push(i);
    } else if (b.type === "heading") {
      headingIndices.push(i);
    }
  }

  const neighborSeen = new Set(focusedIndices);
  for (const fi of focusedIndices) {
    for (let d = -2; d <= 2; d++) {
      const ni = fi + d;
      if (ni >= 0 && ni < list.length && !neighborSeen.has(ni)) {
        neighborSeen.add(ni);
        neighborIndices.push(ni);
      }
    }
  }

  let usedChars = 0;
  const tryInclude = (idx, force = false) => {
    if (included[idx]) return true;
    const cost = formatted[idx].length + 2;
    if (!force && usedChars + cost > maxChars) return false;
    included[idx] = true;
    usedChars += cost;
    return true;
  };

  for (const idx of focusedIndices) tryInclude(idx, true);
  for (const idx of neighborIndices) tryInclude(idx, false);
  for (const idx of headingIndices) tryInclude(idx, false);
  for (let i = 0; i < list.length; i++) {
    if (usedChars >= maxChars) break;
    tryInclude(i, false);
  }

  const outParts = [];
  const includedIds = new Set();
  let omittedCount = 0;
  let i = 0;
  while (i < list.length) {
    if (included[i]) {
      outParts.push(formatted[i]);
      if (list[i].id) includedIds.add(list[i].id);
      if (list[i].block_id) {
        includedIds.add(list[i].block_id);
        includedIds.add(`^${list[i].block_id}`);
      }
      i += 1;
    } else {
      const start = i;
      while (i < list.length && !included[i]) {
        omittedCount += 1;
        i += 1;
      }
      const count = i - start;
      const firstId = list[start].block_id ? `^${list[start].block_id}` : list[start].id;
      const lastId = list[i - 1].block_id ? `^${list[i - 1].block_id}` : list[i - 1].id;
      outParts.push(`[... ${count} block${count === 1 ? "" : "s"} omitted for length (${firstId}..${lastId}) ...]`);
    }
  }

  return {
    text: outParts.join("\n\n"),
    includedIds,
    omittedCount,
  };
}

export async function buildContextPayload({
  ctx,
  userPrompt,
  provider,
  includeCurrentPage,
  searchFolder,
  liveSelectedBlocks,
  pinnedAttachments,
  invoke,
}) {
  const budgets = getContextBudgets(provider);
  const stableSections = [];
  const dynamicSections = [];

  if (ctx.vaultName) {
    const pageList = (ctx.pages || [])
      .slice(0, 60)
      .map((p) => p.rel_path)
      .join(", ");
    stableSections.push(`Active folder: "${ctx.vaultName}". Notes: ${pageList || "(none)"}`);
  }

  const highlighted = ctx.selectedBlocks?.length ? ctx.selectedBlocks : liveSelectedBlocks;
  const focusedIdsSet = getBlockIdSet(highlighted);
  let pageIncludedIds = new Set();

  if (includeCurrentPage && ctx.currentFile) {
    const pageRes = formatPageWithBudget(ctx.blocks || [], budgets.maxPageChars, focusedIdsSet);
    pageIncludedIds = pageRes.includedIds;
    const truncationNote =
      pageRes.omittedCount > 0
        ? `\n(Note: ${pageRes.omittedCount} non-focused block(s) omitted to fit context budget.)`
        : "";
    stableSections.push(`Current open note (${ctx.currentFile}):\n${pageRes.text}${truncationNote}`);
  }

  let dynamicChars = 0;
  const pushDynamic = (sectionText, force = false) => {
    if (!sectionText) return false;
    const remaining = budgets.maxDynamicChars - dynamicChars;
    if (remaining <= 0 && !force) return false;
    let toAdd = sectionText;
    if (!force && toAdd.length > remaining) {
      if (remaining < 160) return false;
      toAdd = `${toAdd.slice(0, remaining - 24)}\n… [truncated for budget]`;
    }
    dynamicSections.push(toAdd);
    dynamicChars += toAdd.length + 18;
    return true;
  };

  if (highlighted.length > 0) {
    const notIncluded = [];
    const alreadyIncludedRefs = [];
    highlighted.forEach((b, idx) => {
      const refTag = `[${b.block_id ? `^${b.block_id}` : b.id}]`;
      if (includeCurrentPage && ctx.currentFile && isBlockInIdSet(b, pageIncludedIds)) {
        alreadyIncludedRefs.push(refTag);
      } else {
        notIncluded.push(formatBlockForAi(b, idx));
      }
    });

    if (notIncluded.length === 0) {
      pushDynamic(
        `PRIMARY FOCUS — The user currently has ${highlighted.length} block(s) highlighted in ${ctx.currentFile || "the current note"}: ${alreadyIncludedRefs.join(", ")}. Focus your explanation, answers, and any proposed edits specifically on these exact block_ids (using the rest of the note only as supporting context unless asked otherwise).`,
        true
      );
    } else {
      const extraNote = alreadyIncludedRefs.length
        ? `\nAlso focused from ${ctx.currentFile}: ${alreadyIncludedRefs.join(", ")}`
        : "";
      pushDynamic(
        `PRIMARY FOCUS — The user currently has these ${highlighted.length} block(s) highlighted in the editor. Focus your explanation, answers, and any proposed edits specifically on this highlighted part (using the rest of the note only as supporting context unless asked otherwise):\n${notIncluded.join("\n\n")}${extraNote}`,
        true
      );
    }
  }

  if (pinnedAttachments.length) {
    const pinnedLines = [];
    for (const a of pinnedAttachments) {
      if (a.kind === "block") {
        const fakeBlock = { id: a.blockId, block_id: a.obsidianId };
        if (
          (includeCurrentPage && isBlockInIdSet(fakeBlock, pageIncludedIds)) ||
          isBlockInIdSet(fakeBlock, focusedIdsSet)
        ) {
          const ref = a.obsidianId ? `^${a.obsidianId}` : a.blockId;
          pinnedLines.push(`- Pinned block [${ref}] (already shown above)`);
          continue;
        }
      }
      const ref = a.obsidianId ? `^${a.obsidianId} (runtime id: ${a.blockId})` : a.blockId;
      pinnedLines.push(`- ${a.kind} [${ref}]:\n${a.text}`);
    }
    if (pinnedLines.length) {
      pushDynamic(`User highlighted / pinned context:\n${pinnedLines.join("\n\n")}`);
    }
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
        const res = await invoke("resolve_block_reference", {
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
      pushDynamic(resolvedParts.join("\n\n"));
    }
  }

  // Vault-wide search across all .md files when remaining budget permits
  if (searchFolder && ctx.vaultName && budgets.maxDynamicChars - dynamicChars > 400) {
    try {
      const hits = await invoke("search_vault", {
        query: userPrompt,
        excludeRel: includeCurrentPage ? ctx.currentFile : null,
        maxFiles: 4,
      });
      if (hits?.length) {
        const hitText = hits
          .map((h) => `From ${h.rel_path}:\n${h.excerpt}`)
          .join("\n\n---\n\n");
        pushDynamic(`Relevant excerpts from other notes in folder:\n${hitText}`);
      }
    } catch {
      // Ignore search error when no vault open
    }
  }

  return {
    systemPrompt: STATIC_SYSTEM_PROMPT,
    stableContext: stableSections.join("\n\n================\n\n"),
    dynamicContext: dynamicSections.join("\n\n================\n\n"),
    budgets,
  };
}

export function buildOutgoingHistory({ messages, dynamicContext, maxHistoryChars = 16000 }) {
  const cleanHistory = [];
  const prior = (messages || []).slice(0, -1);
  for (let i = 0; i < prior.length; i++) {
    const m = prior[i];
    if (m.error) continue;
    if (m.role === "user" && i + 1 < prior.length && prior[i + 1].role === "assistant") {
      const nextReply = prior[i + 1];
      if (nextReply.error || !String(nextReply.content || "").trim()) {
        continue;
      }
    }
    const content =
      m.role === "assistant"
        ? compactAssistantHistoryContent(m)
        : String(m.content || "");
    if (!content.trim()) continue;
    cleanHistory.push({ role: m.role, content });
  }

  // Budget history from newest backward (up to 12 turns), always keeping the latest user message
  const selectedRev = [];
  let histChars = 0;
  for (let i = cleanHistory.length - 1; i >= 0 && selectedRev.length < 12; i--) {
    const msg = cleanHistory[i];
    const isLatest = i === cleanHistory.length - 1;
    if (!isLatest && histChars + msg.content.length > maxHistoryChars) {
      break;
    }
    selectedRev.push({ role: msg.role, content: msg.content });
    histChars += msg.content.length;
  }
  selectedRev.reverse();

  // Coalesce any consecutive same-role entries
  const historyMsgs = [];
  for (const m of selectedRev) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const prev = historyMsgs[historyMsgs.length - 1];
    if (prev && prev.role === role) {
      prev.content = `${prev.content}\n\n${m.content}`;
    } else {
      historyMsgs.push({ role, content: m.content });
    }
  }

  // Attach volatile per-turn context to the latest user message so system prompt + page cache stay warm
  if (dynamicContext && historyMsgs.length > 0) {
    const lastMsg = historyMsgs[historyMsgs.length - 1];
    if (lastMsg.role === "user") {
      lastMsg.content = `<context>\n${dynamicContext}\n</context>\n\n${lastMsg.content}`;
    }
  }

  return historyMsgs;
}
