import { escapeHtml } from "./inline.js";

const MAX_SCROLLBACK_LINES = 2000;

function tauriListen(eventName, handler) {
  const listenFn = window.__TAURI__?.event?.listen;
  if (!listenFn) return Promise.resolve(() => {});
  return listenFn(eventName, handler);
}

const SGR_COLOR_MAP = {
  30: "ansi-gray",
  31: "ansi-red",
  32: "ansi-green",
  33: "ansi-yellow",
  34: "ansi-blue",
  35: "ansi-magenta",
  36: "ansi-cyan",
  37: "",
  90: "ansi-gray",
  91: "ansi-red",
  92: "ansi-green",
  93: "ansi-yellow",
  94: "ansi-blue",
  95: "ansi-magenta",
  96: "ansi-cyan",
  97: "ansi-bold",
};

/**
 * Safely converts ANSI SGR color/bold/dim escape sequences to HTML spans,
 * stripping unsupported CSI/OSC sequences.
 */
export function ansiToHtml(text) {
  const cleaned = String(text ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-LN-Za-z]/g, "");

  const parts = cleaned.split(/(\x1b\[[0-9;]*m)/g);
  let bold = false;
  let dim = false;
  let colorClass = "";
  let out = "";

  for (const part of parts) {
    if (part.startsWith("\x1b[") && part.endsWith("m")) {
      const codesStr = part.slice(2, -1);
      const codes = codesStr === "" ? [0] : codesStr.split(";").map((n) => Number(n));
      for (const code of codes) {
        if (code === 0) {
          bold = false;
          dim = false;
          colorClass = "";
        } else if (code === 1) {
          bold = true;
        } else if (code === 2) {
          dim = true;
        } else if (code === 22) {
          bold = false;
          dim = false;
        } else if (code === 39) {
          colorClass = "";
        } else if (Object.prototype.hasOwnProperty.call(SGR_COLOR_MAP, code)) {
          colorClass = SGR_COLOR_MAP[code];
        }
      }
      continue;
    }

    if (!part) continue;
    const escaped = escapeHtml(part);
    const classes = [];
    if (bold) classes.push("ansi-bold");
    if (dim) classes.push("ansi-dim");
    if (colorClass) classes.push(colorClass);

    if (classes.length) {
      out += `<span class="${classes.join(" ")}">${escaped}</span>`;
    } else {
      out += escaped;
    }
  }

  return out;
}

function longestCommonPrefix(items) {
  if (!items.length) return "";
  let prefix = items[0];
  for (let i = 1; i < items.length; i++) {
    const s = items[i];
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j].toLowerCase() === s[j].toLowerCase()) {
      j += 1;
    }
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * VS Code-style bottom-docked interactive PowerShell terminal panel.
 */
export class TerminalPanel {
  constructor(
    {
      panelEl,
      resizerEl,
      cwdBadgeEl,
      outputEl,
      scrollEl,
      promptPrefixEl,
      inputEl,
      clearBtn,
      restartBtn,
      closeBtn,
      toggleBtn,
    },
    { invoke, onResizeEnd, onCommandFinished }
  ) {
    this.panelEl = panelEl;
    this.resizerEl = resizerEl;
    this.cwdBadgeEl = cwdBadgeEl;
    this.outputEl = outputEl;
    this.scrollEl = scrollEl;
    this.promptPrefixEl = promptPrefixEl;
    this.inputEl = inputEl;
    this.toggleBtn = toggleBtn;

    this.invoke = invoke;
    this.onResizeEnd = onResizeEnd;
    this.onCommandFinished = onCommandFinished;

    this.openState = false;
    this.started = false;
    this.cwd = "";
    this.isRunning = false;
    this.history = [];
    this.historyIdx = -1;
    this.draftInput = "";

    clearBtn.addEventListener("click", () => {
      this.clear();
      this.inputEl.focus();
    });
    restartBtn.addEventListener("click", () => this.interrupt());
    closeBtn.addEventListener("click", () => this.close());

    this.scrollEl.addEventListener("mousedown", () => {
      setTimeout(() => {
        const sel = window.getSelection()?.toString();
        if (!sel && this.openState) {
          this.inputEl.focus();
        }
      }, 0);
    });

    this.inputEl.addEventListener("keydown", (e) => this.handleInputKeyDown(e));

    this.initResizer();
    this.initListeners();
  }

  async initListeners() {
    await tauriListen("terminal-output", (event) => {
      const payload = event?.payload;
      if (!payload) return;
      this.appendLine(payload.text, payload.stream || "stdout");
    });

    await tauriListen("terminal-prompt", (event) => {
      const nextCwd = event?.payload?.cwd;
      if (nextCwd) {
        this.setCwd(nextCwd);
      }
      const wasRunning = this.isRunning;
      this.isRunning = false;
      this.updatePromptUi();
      if (wasRunning && this.onCommandFinished) {
        this.onCommandFinished();
      }
    });
  }

  initResizer() {
    let dragging = false;
    let startY = 0;
    let startHeight = 240;

    this.resizerEl.addEventListener("mousedown", (e) => {
      if (!this.openState) return;
      dragging = true;
      startY = e.clientY;
      startHeight = this.panelEl.getBoundingClientRect().height;
      this.resizerEl.classList.add("dragging");
      document.body.style.cursor = "row-resize";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const maxH = Math.min(600, Math.max(160, window.innerHeight - 160));
      const next = Math.min(maxH, Math.max(120, Math.round(startHeight - (e.clientY - startY))));
      this.panelEl.style.height = `${next}px`;
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      this.resizerEl.classList.remove("dragging");
      document.body.style.cursor = "";
      const height = Math.round(this.panelEl.getBoundingClientRect().height);
      this.onResizeEnd?.(height);
    });
  }

  setHeight(height) {
    const clamped = Math.min(600, Math.max(120, Number(height) || 240));
    this.panelEl.style.height = `${clamped}px`;
  }

  isOpen() {
    return this.openState;
  }

  setCwd(cwd) {
    this.cwd = cwd || "";
    this.cwdBadgeEl.textContent = this.cwd;
    this.cwdBadgeEl.title = this.cwd;
    this.updatePromptUi();
  }

  updatePromptUi() {
    if (this.isRunning) {
      this.promptPrefixEl.textContent = ">";
    } else {
      this.promptPrefixEl.textContent = `PS ${this.cwd || "~"}>`;
    }
    this.inputEl.removeAttribute("placeholder");
  }

  async open() {
    this.openState = true;
    this.panelEl.hidden = false;
    this.resizerEl.hidden = false;
    this.toggleBtn?.classList.add("active");

    try {
      const info = await this.invoke("terminal_start");
      if (info?.cwd) {
        this.setCwd(info.cwd);
      }
      if (!this.started) {
        this.started = true;
        this.appendLine(`Skillweaver ${info?.shell || "PowerShell"} terminal ready.`, "system");
      }
    } catch (err) {
      this.appendLine(`Failed to start terminal: ${err}`, "stderr");
    }

    this.scrollToBottom();
    this.inputEl.focus();
  }

  close() {
    this.openState = false;
    this.panelEl.hidden = true;
    this.resizerEl.hidden = true;
    this.toggleBtn?.classList.remove("active");
  }

  toggle() {
    if (this.openState) {
      this.close();
    } else {
      this.open();
    }
  }

  clear() {
    this.outputEl.innerHTML = "";
  }

  async syncCwd(folderPath) {
    if (!folderPath) return;
    try {
      const next = await this.invoke("terminal_set_cwd", { folderPath });
      if (next) this.setCwd(next);
    } catch {
      // Ignore if session hasn't started yet
    }
  }

  async interrupt() {
    this.isRunning = false;
    this.updatePromptUi();
    try {
      const info = await this.invoke("terminal_interrupt");
      if (info?.cwd) this.setCwd(info.cwd);
    } catch (err) {
      this.appendLine(`Interrupt error: ${err}`, "stderr");
    }
    this.inputEl.focus();
  }

  appendLine(text, stream = "stdout") {
    const lineEl = document.createElement("div");
    lineEl.className = `terminal-line ${stream}`;
    if (stream === "cmd" || stream === "system") {
      lineEl.textContent = text;
    } else {
      lineEl.innerHTML = ansiToHtml(text) || "&nbsp;";
    }
    this.outputEl.appendChild(lineEl);

    while (this.outputEl.childElementCount > MAX_SCROLLBACK_LINES) {
      this.outputEl.firstElementChild.remove();
    }
    this.scrollToBottom();
  }

  scrollToBottom() {
    this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
  }

  async handleInputKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      this.clear();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      const selected = window.getSelection()?.toString();
      if (selected) return; // Allow normal copy
      e.preventDefault();
      if (this.isRunning) {
        await this.interrupt();
      } else {
        this.appendLine(`${this.promptPrefixEl.textContent} ${this.inputEl.value}^C`, "system");
        this.inputEl.value = "";
        this.historyIdx = -1;
      }
      return;
    }

    if (e.key === "ArrowUp") {
      if (!this.history.length || this.isRunning) return;
      e.preventDefault();
      if (this.historyIdx === -1) {
        this.draftInput = this.inputEl.value;
        this.historyIdx = this.history.length - 1;
      } else if (this.historyIdx > 0) {
        this.historyIdx -= 1;
      }
      this.inputEl.value = this.history[this.historyIdx];
      this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
      return;
    }

    if (e.key === "ArrowDown") {
      if (this.historyIdx === -1 || this.isRunning) return;
      e.preventDefault();
      if (this.historyIdx < this.history.length - 1) {
        this.historyIdx += 1;
        this.inputEl.value = this.history[this.historyIdx];
      } else {
        this.historyIdx = -1;
        this.inputEl.value = this.draftInput;
      }
      this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      await this.handleTabComplete();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      await this.submitInput();
    }
  }

  async handleTabComplete() {
    const val = this.inputEl.value;
    const caret = this.inputEl.selectionStart ?? val.length;
    const beforeCaret = val.slice(0, caret);
    const afterCaret = val.slice(caret);

    const match = beforeCaret.match(/(?:^|\s)(?:"([^"]*)|([^\s"]*))$/);
    if (!match) return;

    const rawToken = match[1] !== undefined ? match[1] : match[2] || "";
    const tokenStart = beforeCaret.length - rawToken.length - (match[1] !== undefined ? 1 : 0);

    let candidates = [];
    try {
      candidates = await this.invoke("terminal_complete_path", { partial: rawToken });
    } catch {
      return;
    }
    if (!candidates.length) return;

    const applyReplacement = (text) => {
      const quoted = /\s/.test(text) ? `"${text}"` : text;
      const prefix = val.slice(0, tokenStart);
      this.inputEl.value = prefix + quoted + afterCaret;
      const nextCaret = prefix.length + quoted.length;
      this.inputEl.setSelectionRange(nextCaret, nextCaret);
    };

    if (candidates.length === 1) {
      applyReplacement(candidates[0]);
      return;
    }

    const common = longestCommonPrefix(candidates);
    if (common.length > rawToken.length) {
      applyReplacement(common);
    } else {
      this.appendLine(candidates.join("   "), "system");
    }
  }

  async submitInput() {
    const raw = this.inputEl.value;
    const trimmed = raw.trim();
    this.inputEl.value = "";
    this.historyIdx = -1;
    this.draftInput = "";

    if (this.isRunning) {
      this.appendLine(raw, "cmd");
      try {
        await this.invoke("terminal_run", { input: raw });
      } catch (err) {
        this.appendLine(`Error: ${err}`, "stderr");
      }
      return;
    }

    if (!trimmed) {
      this.appendLine(this.promptPrefixEl.textContent, "cmd");
      return;
    }

    if (this.history[this.history.length - 1] !== raw) {
      this.history.push(raw);
      if (this.history.length > 200) this.history.shift();
    }

    const lower = trimmed.toLowerCase();
    if (lower === "cls" || lower === "clear") {
      this.clear();
      return;
    }
    if (lower === "exit") {
      this.close();
      try {
        await this.invoke("terminal_run", { input: "exit" });
      } catch {
        // Ignore on exit
      }
      this.started = false;
      return;
    }

    this.appendLine(`${this.promptPrefixEl.textContent} ${raw}`, "cmd");
    this.isRunning = true;
    this.updatePromptUi();

    try {
      await this.invoke("terminal_run", { input: raw });
    } catch (err) {
      this.isRunning = false;
      this.updatePromptUi();
      this.appendLine(`Error: ${err}`, "stderr");
    }
  }
}
