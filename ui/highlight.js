import { escapeHtml } from "./inline.js";

const MAX_HIGHLIGHT_LEN = 120000;

const LANG_ALIASES = {
  "": "text",
  plain: "text",
  plaintext: "text",
  txt: "text",
  text: "text",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  sql: "sql",
  pgsql: "sql",
  postgres: "sql",
  postgresql: "sql",
  mysql: "sql",
  sqlite: "sql",
  tsql: "sql",
  plsql: "sql",
  bigquery: "sql",
  snowflake: "sql",
  duckdb: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  shell: "bash",
  ps1: "powershell",
  pwsh: "powershell",
  powershell: "powershell",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  markup: "markup",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  markdown: "markdown",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  "c++": "cpp",
  cs: "csharp",
  csharp: "csharp",
  java: "java",
  go: "go",
  golang: "go",
  docker: "docker",
  dockerfile: "docker",
  diff: "diff",
  regex: "regex",
};

/** Normalizes a code block language identifier to a Prism grammar key. */
export function normalizeLanguage(lang) {
  const key = String(lang || "").trim().toLowerCase();
  return LANG_ALIASES[key] || key || "text";
}

/**
 * Highlights source code into safe HTML tokens via vendored Prism.js.
 * Always returns HTML-escaped output; falls back to plain escaped text for `text` or unknown languages.
 */
export function highlightCode(code, language) {
  if (!code) return "";
  if (code.length > MAX_HIGHLIGHT_LEN) return escapeHtml(code);

  const lang = normalizeLanguage(language);
  if (lang === "text") return escapeHtml(code);

  const grammar = window.Prism?.languages?.[lang];
  if (!grammar) return escapeHtml(code);

  try {
    return window.Prism.highlight(code, grammar, lang);
  } catch {
    return escapeHtml(code);
  }
}
