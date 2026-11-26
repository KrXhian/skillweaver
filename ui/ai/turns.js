import { escapeHtml } from "../inline.js";
import { EDIT_FENCE_REGEX_SOURCE } from "./edits.js";

export function formatClockTime(unixOrMs) {
  if (!unixOrMs) return "";
  const ms = unixOrMs < 1e12 ? unixOrMs * 1000 : unixOrMs;
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

export class AiTurnRail {
  constructor({ turnRailEl, turnPreviewEl, messagesEl }) {
    this.turnRailEl = turnRailEl;
    this.turnPreviewEl = turnPreviewEl;
    this.messagesEl = messagesEl;

    this.turns = [];
    this.activeTurnIdx = 0;
    this._previewTimer = null;
    this._scrollRaf = null;

    this.turnRailEl?.addEventListener("mouseleave", () => {
      clearTimeout(this._previewTimer);
      this._previewTimer = setTimeout(() => this.hidePreview(), 90);
    });
  }

  render(turns) {
    this.turns = Array.isArray(turns) ? turns : [];
    if (!this.turnRailEl) return;
    if (!this.turns.length || this.turns.length < 2) {
      this.turnRailEl.hidden = true;
      this.turnRailEl.innerHTML = "";
      this.hidePreview();
      return;
    }

    this.turnRailEl.hidden = false;
    this.turnRailEl.innerHTML = this.turns
      .map(
        (t) =>
          `<button class="ai-turn-dot${t.turnIdx === this.activeTurnIdx ? " active" : ""}" data-turn="${t.turnIdx}" type="button" aria-label="Turn ${t.turnIdx + 1}"></button>`
      )
      .join("");

    this.turnRailEl.querySelectorAll(".ai-turn-dot").forEach((dot) => {
      const idx = Number(dot.dataset.turn);
      dot.addEventListener("mouseenter", () => {
        clearTimeout(this._previewTimer);
        this.showPreview(idx, dot);
      });
      dot.addEventListener("click", () => {
        this.hidePreview();
        this.jumpToTurn(idx);
      });
    });
  }

  scheduleActiveUpdate() {
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = null;
      this.updateActiveDot();
    });
  }

  updateActiveDot() {
    if (!this.turnRailEl || this.turnRailEl.hidden || !this.turns.length) return;
    const containerTop = this.messagesEl.getBoundingClientRect().top;
    const userNodes = this.messagesEl.querySelectorAll(".ai-msg-user[data-turn-idx]");
    let bestIdx = 0;
    let bestDelta = Infinity;

    userNodes.forEach((el) => {
      const tIdx = Number(el.dataset.turnIdx);
      const top = el.getBoundingClientRect().top - containerTop;
      const abs = top <= 40 ? Math.abs(top) : Math.abs(top) + 1000;
      if (abs < bestDelta) {
        bestDelta = abs;
        bestIdx = tIdx;
      }
    });

    this.activeTurnIdx = bestIdx;
    this.turnRailEl.querySelectorAll(".ai-turn-dot").forEach((dot) => {
      dot.classList.toggle("active", Number(dot.dataset.turn) === bestIdx);
    });
  }

  showPreview(turnIdx, dotEl) {
    if (!this.turnPreviewEl) return;
    const turn = this.turns[turnIdx];
    if (!turn) return;

    const promptText = (turn.userMsg?.content || "").replace(/\s+/g, " ").trim();
    let replyText = "";
    if (turn.assistantMsg?.error) {
      replyText = turn.assistantMsg.error;
    } else if (turn.assistantMsg?.content) {
      replyText = turn.assistantMsg.content
        .replace(new RegExp(EDIT_FENCE_REGEX_SOURCE, "g"), "[Proposed edits]")
        .replace(/\s+/g, " ")
        .trim();
    } else {
      replyText = "Waiting for reply...";
    }

    const timeStr = formatClockTime(turn.createdAt);
    this.turnPreviewEl.innerHTML = `
      <div class="ai-turn-preview-prompt">${escapeHtml(promptText)}</div>
      <div class="ai-turn-preview-reply">${escapeHtml(replyText)}</div>
      <div class="ai-turn-preview-meta">
        <span>${turnIdx + 1} of ${this.turns.length}</span>
        <span>${escapeHtml(timeStr)}</span>
      </div>
    `;
    this.turnPreviewEl.hidden = false;

    const dotRect = dotEl.getBoundingClientRect();
    const prevRect = this.turnPreviewEl.getBoundingClientRect();
    const left = Math.max(12, dotRect.left - prevRect.width - 10);
    const top = Math.max(
      12,
      Math.min(window.innerHeight - prevRect.height - 12, dotRect.top - prevRect.height / 2 + 6)
    );
    this.turnPreviewEl.style.left = `${left}px`;
    this.turnPreviewEl.style.top = `${top}px`;
  }

  hidePreview() {
    if (this.turnPreviewEl) {
      this.turnPreviewEl.hidden = true;
    }
  }

  jumpToTurn(turnIdx) {
    const target = this.messagesEl.querySelector(`.ai-msg-user[data-turn-idx="${turnIdx}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    this.activeTurnIdx = turnIdx;
    this.turnRailEl?.querySelectorAll(".ai-turn-dot").forEach((dot) => {
      dot.classList.toggle("active", Number(dot.dataset.turn) === turnIdx);
    });
    target.classList.remove("ai-turn-flash");
    void target.offsetWidth;
    target.classList.add("ai-turn-flash");
    setTimeout(() => target.classList.remove("ai-turn-flash"), 1150);
  }
}
