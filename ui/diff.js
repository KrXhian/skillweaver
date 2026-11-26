import { escapeHtml } from "./inline.js";

function splitLinesNormalized(text) {
  const normalized = String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (normalized === "") return [];
  return normalized.split("\n");
}

/**
 * Computes a line-level unified diff between the user's unsaved buffer (`mineText`)
 * and the external file on disk (`diskText`).
 */
export function computeLineDiff(mineText, diskText) {
  const a = splitLinesNormalized(mineText);
  const b = splitLinesNormalized(diskText);

  let prefix = 0;
  const minLen = Math.min(a.length, b.length);
  while (prefix < minLen && a[prefix] === b[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const rows = [];
  for (let i = 0; i < prefix; i++) {
    rows.push({
      type: "equal",
      mineLine: i + 1,
      diskLine: i + 1,
      text: a[i],
    });
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  let addedCount = 0;
  let removedCount = 0;

  if (midA.length === 0 && midB.length === 0) {
    // Identical middle
  } else if (midA.length * midB.length > 250_000) {
    // Guard against quadratic memory/time on very large diffs
    for (let i = 0; i < midA.length; i++) {
      rows.push({
        type: "del",
        mineLine: prefix + i + 1,
        diskLine: null,
        text: midA[i],
      });
      removedCount += 1;
    }
    for (let j = 0; j < midB.length; j++) {
      rows.push({
        type: "add",
        mineLine: null,
        diskLine: prefix + j + 1,
        text: midB[j],
      });
      addedCount += 1;
    }
  } else {
    const m = midA.length;
    const n = midB.length;
    const cols = n + 1;
    const dp = new Int32Array((m + 1) * cols);

    for (let i = m - 1; i >= 0; i--) {
      const rowOffset = i * cols;
      const nextRowOffset = (i + 1) * cols;
      for (let j = n - 1; j >= 0; j--) {
        if (midA[i] === midB[j]) {
          dp[rowOffset + j] = dp[nextRowOffset + j + 1] + 1;
        } else {
          const down = dp[nextRowOffset + j];
          const right = dp[rowOffset + j + 1];
          dp[rowOffset + j] = down >= right ? down : right;
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && midA[i] === midB[j]) {
        rows.push({
          type: "equal",
          mineLine: prefix + i + 1,
          diskLine: prefix + j + 1,
          text: midA[i],
        });
        i += 1;
        j += 1;
      } else if (j < n && (i === m || dp[i * cols + (j + 1)] >= dp[(i + 1) * cols + j])) {
        rows.push({
          type: "add",
          mineLine: null,
          diskLine: prefix + j + 1,
          text: midB[j],
        });
        addedCount += 1;
        j += 1;
      } else {
        rows.push({
          type: "del",
          mineLine: prefix + i + 1,
          diskLine: null,
          text: midA[i],
        });
        removedCount += 1;
        i += 1;
      }
    }
  }

  for (let k = 0; k < suffix; k++) {
    const aIdx = a.length - suffix + k;
    const bIdx = b.length - suffix + k;
    rows.push({
      type: "equal",
      mineLine: aIdx + 1,
      diskLine: bIdx + 1,
      text: a[aIdx],
    });
  }

  return { rows, addedCount, removedCount };
}

/**
 * Collapses long stretches of unchanged lines while keeping `contextLines` around edits.
 */
export function collapseUnchangedContext(rows, contextLines = 3) {
  if (!rows.length) return [];
  const keep = new Uint8Array(rows.length);
  let hasChanges = false;

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== "equal") {
      hasChanges = true;
      const start = Math.max(0, i - contextLines);
      const end = Math.min(rows.length - 1, i + contextLines);
      for (let k = start; k <= end; k++) {
        keep[k] = 1;
      }
    }
  }

  if (!hasChanges) {
    return rows.slice(0, Math.min(rows.length, 40));
  }

  const out = [];
  let idx = 0;
  while (idx < rows.length) {
    if (keep[idx]) {
      out.push(rows[idx]);
      idx += 1;
      continue;
    }
    let runEnd = idx;
    while (runEnd < rows.length && !keep[runEnd]) {
      runEnd += 1;
    }
    const skipped = runEnd - idx;
    if (skipped <= 2) {
      for (let k = idx; k < runEnd; k++) {
        out.push(rows[k]);
      }
    } else {
      out.push({ type: "sep", skipped });
    }
    idx = runEnd;
  }
  return out;
}

/**
 * Modal displaying a line diff between the user's unsaved note buffer and the disk file.
 */
export class DiffModal {
  constructor(
    {
      backdropEl,
      subtitleEl,
      statsEl,
      bodyEl,
      closeBtn,
      cancelBtn,
      keepBtn,
      reloadBtn,
    },
    { onKeepMine, onReload }
  ) {
    this.backdropEl = backdropEl;
    this.subtitleEl = subtitleEl;
    this.statsEl = statsEl;
    this.bodyEl = bodyEl;
    this.onKeepMine = onKeepMine;
    this.onReload = onReload;

    closeBtn.addEventListener("click", () => this.close());
    cancelBtn.addEventListener("click", () => this.close());
    keepBtn.addEventListener("click", async () => {
      this.close();
      await this.onKeepMine?.();
    });
    reloadBtn.addEventListener("click", async () => {
      this.close();
      await this.onReload?.();
    });

    this.backdropEl.addEventListener("mousedown", (e) => {
      if (e.target === this.backdropEl) {
        this.close();
      }
    });
  }

  isOpen() {
    return !this.backdropEl.hidden;
  }

  open({ relPath, mineText, diskText }) {
    this.render({ relPath, mineText, diskText });
    this.backdropEl.hidden = false;
  }

  update({ relPath, mineText, diskText }) {
    if (!this.isOpen()) return;
    this.render({ relPath, mineText, diskText });
  }

  close() {
    this.backdropEl.hidden = true;
    this.bodyEl.innerHTML = "";
  }

  render({ relPath, mineText, diskText }) {
    this.subtitleEl.textContent = relPath || "";
    const { rows, addedCount, removedCount } = computeLineDiff(mineText, diskText);

    const parts = [];
    if (addedCount > 0) parts.push(`<span class="diff-stat-add">+${addedCount} on disk</span>`);
    if (removedCount > 0) parts.push(`<span class="diff-stat-del">-${removedCount} in mine</span>`);
    if (!parts.length) parts.push(`<span class="diff-stat-same">No line differences</span>`);
    this.statsEl.innerHTML = parts.join(" ");

    if (!rows.length) {
      this.bodyEl.innerHTML = `<div class="diff-empty">Both your buffer and the file on disk are empty.</div>`;
      return;
    }

    const displayRows = collapseUnchangedContext(rows, 3);
    const htmlRows = displayRows
      .map((row) => {
        if (row.type === "sep") {
          return `<div class="diff-row diff-row-sep"><span class="diff-sep-label">⋯ ${row.skipped} unchanged line${row.skipped === 1 ? "" : "s"} ⋯</span></div>`;
        }
        const cls =
          row.type === "add"
            ? "diff-row diff-row-add"
            : row.type === "del"
              ? "diff-row diff-row-del"
              : "diff-row";
        const mineNum = row.mineLine !== null ? String(row.mineLine) : "";
        const diskNum = row.diskLine !== null ? String(row.diskLine) : "";
        const sign = row.type === "add" ? "+" : row.type === "del" ? "−" : " ";
        const code = row.text === "" ? " " : escapeHtml(row.text);
        return `<div class="${cls}"><span class="diff-ln">${mineNum}</span><span class="diff-ln">${diskNum}</span><span class="diff-sign">${sign}</span><span class="diff-code">${code}</span></div>`;
      })
      .join("");

    this.bodyEl.innerHTML = `<div class="diff-table">${htmlRows}</div>`;
  }
}
