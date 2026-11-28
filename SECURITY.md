# Security Policy & Architecture

Skillweaver is a local-first desktop application that handles sensitive artifacts: your personal Markdown notes, local BYOK AI API keys, and optional external AI agent access via `--mcp`. This document explains the concrete security boundaries implemented in `core-engine/` and how release binaries can be verified.

---

## 1. BYOK API Key Storage (Windows DPAPI)

- **At-rest encryption**: API keys for all provider profiles are stored in `%USERPROFILE%\.skillweaver\ai.prefs` and encrypted individually at rest using Win32 Data Protection API (`CryptProtectData` with `CRYPTPROTECT_UI_FORBIDDEN`, implemented in [`core-engine/src/ai/prefs.rs`](core-engine/src/ai/prefs.rs)). Legacy plaintext keys are automatically migrated to `dpapi:` entries on load.
- **Memory & log hygiene**: `Debug` implementations on `AiPrefs`, `AiProviderProfile`, and `AiListModelsRequest` mask non-empty API keys as `[REDACTED]`, and preferences are written via atomic temp-file swap (`write_atomic` in [`core-engine/src/fs_util.rs`](core-engine/src/fs_util.rs)).
- **Threat-model boundary**:
  - Windows DPAPI protects stored keys against offline disk inspection and other local OS user accounts on the same machine.
  - Like standard desktop apps (browsers, editors, credential stores), DPAPI does **not** protect secrets against malicious code already running under your own active Windows user session.
  - Note: To support the Settings visibility ("Eye") toggle in the desktop UI, `get_ai_prefs` currently returns decrypted profile fields to the local Tauri WebView2 frontend (`commands.rs`).

---

## 2. AI Network Transport (Native Rust `reqwest` + Windows Schannel)

- **In-process HTTPS & SSE**: All AI chat streaming and live model-list requests run in-process through `reqwest` (`default-features = false`, `native-tls`, `system-proxy`) in [`core-engine/src/ai/http.rs`](core-engine/src/ai/http.rs), [`models.rs`](core-engine/src/ai/models.rs), and [`stream.rs`](core-engine/src/ai/stream.rs).
- **OS TLS & proxy support**: On Windows, `native-tls` delegates TLS verification and certificate trust directly to Windows **Schannel**, while `system-proxy` respects system/environment HTTP(S) proxy settings.
- **No external HTTP subprocesses or temp files**: Skillweaver does **not** shell out to external HTTP tools, pass API keys on process command lines, or stage prompt payloads in `%TEMP%`. HTTP headers are strictly validated via `reqwest::header::HeaderName` / `HeaderValue` (rejecting CR/LF injection).

---

## 3. MCP Server Sandbox & `--read-only` Mode

Running `skillweaver.exe --mcp "<vault-folder>"` starts a zero-dependency stdio JSON-RPC 2.0 server ([`core-engine/src/mcp.rs`](core-engine/src/mcp.rs)). Every path passed to MCP tools passes through `normalize_rel_path` and `validate_mcp_rel_path`:

- **Traversal & prefix rejection**: Rejects `..`, drive letters, UNC paths, and null bytes.
- **Protected directory & dotfile exclusion**: Blocks all dot-prefixed files and folders (`.git`, `.env`, `.skillweaver`, `.hidden.md`) as well as `node_modules` and `target`.
- **Markdown-only scope**: Restricts MCP reads and writes strictly to `.md` files (note titles resolve only to indexed Markdown notes).
- **Limited write surface**: `create_note` refuses to overwrite existing files, and the MCP server exposes **no delete, rename, or full-file overwrite tools**.
- **Read-only mode (`--read-only`)**: Pass `--read-only` (e.g., `skillweaver.exe --mcp --read-only "C:\path\to\vault"`) to omit `create_note` and `append_to_note` from `tools/list` and enforce server-side rejection on write calls.

> **Recommendation**: Keep your vault tracked in Git (or backed up) before giving external agents write access via `--mcp`.

---

## 4. Release Build Verification

Portable Windows executables attached to [GitHub Releases](https://github.com/KrXhian/skillweaver/releases) are compiled directly on GitHub Actions runners ([`.github/workflows/release.yml`](.github/workflows/release.yml)) — never manually uploaded — and include:

1. **SHA-256 checksums** (`SHA256SUMS.txt`) generated during the CI build job.
2. **GitHub Build Provenance Attestations** (`actions/attest-build-provenance`), verifiable locally with the GitHub CLI:
   ```powershell
   gh attestation verify skillweaver-windows-x64.exe -R KrXhian/skillweaver
   ```

You can also inspect and compile the full source yourself via `cargo build --release --manifest-path core-engine/Cargo.toml`.

---

## 5. Reporting a Vulnerability

If you discover a security issue in Skillweaver, please avoid disclosing exploit details in a public issue before a fix is available. Report it privately via **GitHub Security Advisories** (`Security` -> `Report a vulnerability` on [`KrXhian/skillweaver`](https://github.com/KrXhian/skillweaver/security/advisories)) or contact `@KrXhian` through GitHub.
