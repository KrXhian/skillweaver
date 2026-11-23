use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering as CmpOrdering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const HTTP_STATUS_MARKER: &str = "__SW_HTTP_STATUS__:";
static REQ_TMP_SEQ: AtomicU64 = AtomicU64::new(1);

/// User-configured BYOK AI provider settings stored separately at `%USERPROFILE%\.skillweaver\ai.prefs`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct AiPrefs {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

impl Default for AiPrefs {
    fn default() -> Self {
        Self {
            provider: "openai".to_string(),
            api_key: String::new(),
            base_url: "https://api.openai.com/v1/chat/completions".to_string(),
            model: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatRequest {
    pub request_id: String,
    pub system_prompt: String,
    pub messages: Vec<AiChatMessage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStreamEvent {
    pub request_id: String,
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiModelInfo {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub is_snapshot: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier_hint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CachedModelList {
    pub fetched_at_unix: u64,
    pub models: Vec<AiModelInfo>,
}

pub type ModelsCache = HashMap<String, CachedModelList>;

#[derive(Debug, Clone, Deserialize)]
pub struct AiListModelsRequest {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
}

/// Holds the PID of any currently streaming `curl` process so it can be cancelled cleanly.
#[derive(Default)]
pub struct AiState {
    active_pid: Mutex<Option<u32>>,
}

impl Drop for AiState {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.active_pid.lock() {
            if let Some(pid) = guard.take() {
                kill_pid(pid);
            }
        }
    }
}

fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

pub fn ai_prefs_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".skillweaver").join("ai.prefs"))
}

pub fn load_ai_prefs_from(path: &Path) -> AiPrefs {
    let Ok(raw) = fs::read_to_string(path) else {
        return AiPrefs::default();
    };
    serde_json::from_str::<AiPrefs>(&raw).unwrap_or_default()
}

pub fn load_ai_prefs() -> AiPrefs {
    match ai_prefs_path() {
        Some(path) => load_ai_prefs_from(&path),
        None => AiPrefs::default(),
    }
}

pub fn save_ai_prefs_to(path: &Path, prefs: &AiPrefs) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create prefs directory {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| format!("Failed to serialize AI prefs: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Failed to write AI prefs {}: {e}", path.display()))
}

pub fn save_ai_prefs(prefs: &AiPrefs) -> Result<(), String> {
    let path =
        ai_prefs_path().ok_or_else(|| "Could not determine user home directory".to_string())?;
    save_ai_prefs_to(&path, prefs)
}

pub fn models_cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".skillweaver").join("cache").join("models.json"))
}

pub fn canonical_cache_key(provider: &str, base_url: &str) -> String {
    let p = provider.trim().to_ascii_lowercase();
    let trimmed_base = base_url.trim().trim_end_matches('/');
    let default_base = match p.as_str() {
        "gemini" => "https://generativelanguage.googleapis.com/v1beta",
        "anthropic" => "https://api.anthropic.com/v1/messages",
        "openrouter" => "https://openrouter.ai/api/v1/chat/completions",
        "ollama" => "http://localhost:11434/v1/chat/completions",
        "custom" => "http://localhost:1234/v1/chat/completions",
        _ => "https://api.openai.com/v1/chat/completions",
    };
    let effective = if trimmed_base.is_empty() {
        default_base
    } else {
        trimmed_base
    };
    format!("{p}::{effective}")
}

pub fn load_models_cache_from(path: &Path) -> ModelsCache {
    let Ok(raw) = fs::read_to_string(path) else {
        return ModelsCache::new();
    };
    serde_json::from_str::<ModelsCache>(&raw).unwrap_or_default()
}

pub fn load_models_cache() -> ModelsCache {
    match models_cache_path() {
        Some(path) => load_models_cache_from(&path),
        None => ModelsCache::new(),
    }
}

pub fn save_models_cache_to(path: &Path, cache: &ModelsCache) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cache directory {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(cache)
        .map_err(|e| format!("Failed to serialize models cache: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Failed to write models cache {}: {e}", path.display()))
}

fn current_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct StoredChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub proposal_states: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct AiChatSummary {
    pub id: String,
    pub title: String,
    pub vault_path: String,
    pub vault_name: String,
    pub pinned: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub message_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(default)]
pub struct AiChatSession {
    pub id: String,
    pub title: String,
    pub vault_path: String,
    pub vault_name: String,
    pub pinned: bool,
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<StoredChatMessage>,
}

pub fn chats_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".skillweaver").join("chats"))
}

fn validate_chat_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed.len() > 64
        || !trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(format!("Invalid chat ID: {id}"));
    }
    Ok(())
}

fn sort_chat_summaries(items: &mut [AiChatSummary]) {
    items.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
}

pub fn list_chats_in(dir: &Path) -> Vec<AiChatSummary> {
    let index_path = dir.join("index.json");
    let mut list = fs::read_to_string(&index_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<AiChatSummary>>(&raw).ok())
        .unwrap_or_default();
    sort_chat_summaries(&mut list);
    list
}

pub fn list_chats() -> Vec<AiChatSummary> {
    match chats_dir() {
        Some(dir) => list_chats_in(&dir),
        None => Vec::new(),
    }
}

fn save_chat_index_in(dir: &Path, items: &[AiChatSummary]) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create chats directory {}: {e}", dir.display()))?;
    let json = serde_json::to_string_pretty(items)
        .map_err(|e| format!("Failed to serialize chat index: {e}"))?;
    fs::write(dir.join("index.json"), json)
        .map_err(|e| format!("Failed to write chat index: {e}"))
}

pub fn load_chat_in(dir: &Path, chat_id: &str) -> Result<AiChatSession, String> {
    validate_chat_id(chat_id)?;
    let file_path = dir.join(format!("{chat_id}.json"));
    let raw = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read chat {chat_id}: {e}"))?;
    serde_json::from_str::<AiChatSession>(&raw)
        .map_err(|e| format!("Corrupt chat file {chat_id}: {e}"))
}

pub fn load_chat(chat_id: &str) -> Result<AiChatSession, String> {
    let dir = chats_dir().ok_or_else(|| "Could not determine user home directory".to_string())?;
    load_chat_in(&dir, chat_id)
}

pub fn save_chat_in(dir: &Path, session: &AiChatSession) -> Result<Vec<AiChatSummary>, String> {
    validate_chat_id(&session.id)?;
    fs::create_dir_all(dir)
        .map_err(|e| format!("Failed to create chats directory {}: {e}", dir.display()))?;

    let file_path = dir.join(format!("{}.json", session.id));
    let json = serde_json::to_string_pretty(session)
        .map_err(|e| format!("Failed to serialize chat {}: {e}", session.id))?;
    fs::write(&file_path, json)
        .map_err(|e| format!("Failed to write chat {}: {e}", session.id))?;

    let summary = AiChatSummary {
        id: session.id.clone(),
        title: if session.title.trim().is_empty() {
            "New Conversation".to_string()
        } else {
            session.title.trim().to_string()
        },
        vault_path: session.vault_path.clone(),
        vault_name: session.vault_name.clone(),
        pinned: session.pinned,
        created_at: session.created_at,
        updated_at: session.updated_at,
        message_count: session.messages.len(),
    };

    let mut list = list_chats_in(dir);
    if let Some(existing) = list.iter_mut().find(|c| c.id == session.id) {
        *existing = summary;
    } else {
        list.push(summary);
    }
    sort_chat_summaries(&mut list);
    save_chat_index_in(dir, &list)?;
    Ok(list)
}

pub fn save_chat(session: &AiChatSession) -> Result<Vec<AiChatSummary>, String> {
    let dir = chats_dir().ok_or_else(|| "Could not determine user home directory".to_string())?;
    save_chat_in(&dir, session)
}

pub fn update_chat_meta_in(
    dir: &Path,
    chat_id: &str,
    title: Option<String>,
    pinned: Option<bool>,
) -> Result<Vec<AiChatSummary>, String> {
    validate_chat_id(chat_id)?;
    let mut session = load_chat_in(dir, chat_id)?;
    if let Some(t) = title {
        let clean = t.trim().to_string();
        if !clean.is_empty() {
            session.title = clean;
        }
    }
    if let Some(p) = pinned {
        session.pinned = p;
    }
    save_chat_in(dir, &session)
}

pub fn update_chat_meta(
    chat_id: &str,
    title: Option<String>,
    pinned: Option<bool>,
) -> Result<Vec<AiChatSummary>, String> {
    let dir = chats_dir().ok_or_else(|| "Could not determine user home directory".to_string())?;
    update_chat_meta_in(&dir, chat_id, title, pinned)
}

pub fn delete_chat_in(dir: &Path, chat_id: &str) -> Result<Vec<AiChatSummary>, String> {
    validate_chat_id(chat_id)?;
    let file_path = dir.join(format!("{chat_id}.json"));
    if file_path.exists() {
        fs::remove_file(&file_path)
            .map_err(|e| format!("Failed to delete chat {chat_id}: {e}"))?;
    }
    let mut list = list_chats_in(dir);
    list.retain(|c| c.id != chat_id);
    save_chat_index_in(dir, &list)?;
    Ok(list)
}

pub fn delete_chat(chat_id: &str) -> Result<Vec<AiChatSummary>, String> {
    let dir = chats_dir().ok_or_else(|| "Could not determine user home directory".to_string())?;
    delete_chat_in(&dir, chat_id)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderHttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body_json: String,
}

/// Builds the provider-specific URL, HTTP headers, and streaming JSON request body.
pub fn build_provider_http_request(
    prefs: &AiPrefs,
    req: &AiChatRequest,
) -> Result<ProviderHttpRequest, String> {
    let provider = prefs.provider.trim().to_ascii_lowercase();
    let model = prefs.model.trim();
    if model.is_empty() {
        return Err("Model name cannot be empty in AI settings".to_string());
    }
    let api_key = prefs.api_key.trim();

    if !matches!(provider.as_str(), "ollama" | "custom") && api_key.is_empty() {
        return Err(format!(
            "API key is required for provider '{}'. Open AI settings to add your key.",
            prefs.provider
        ));
    }

    match provider.as_str() {
        "gemini" => {
            let base = if prefs.base_url.trim().is_empty() {
                "https://generativelanguage.googleapis.com/v1beta"
            } else {
                prefs.base_url.trim().trim_end_matches('/')
            };
            let url = format!("{base}/models/{model}:streamGenerateContent?alt=sse");
            let contents: Vec<Value> = req
                .messages
                .iter()
                .map(|m| {
                    let role = if m.role == "assistant" { "model" } else { "user" };
                    json!({
                        "role": role,
                        "parts": [{ "text": m.content }]
                    })
                })
                .collect();
            let mut body = json!({ "contents": contents });
            if !req.system_prompt.trim().is_empty() {
                body["system_instruction"] = json!({
                    "parts": [{ "text": req.system_prompt }]
                });
            }
            Ok(ProviderHttpRequest {
                url,
                headers: vec![
                    ("Content-Type".to_string(), "application/json".to_string()),
                    ("x-goog-api-key".to_string(), api_key.to_string()),
                ],
                body_json: body.to_string(),
            })
        }
        "anthropic" => {
            let url = if prefs.base_url.trim().is_empty() {
                "https://api.anthropic.com/v1/messages".to_string()
            } else {
                prefs.base_url.trim().to_string()
            };
            let messages: Vec<Value> = req
                .messages
                .iter()
                .map(|m| {
                    let role = if m.role == "assistant" {
                        "assistant"
                    } else {
                        "user"
                    };
                    json!({ "role": role, "content": m.content })
                })
                .collect();
            let mut body = json!({
                "model": model,
                "max_tokens": 4096,
                "stream": true,
                "messages": messages,
            });
            if !req.system_prompt.trim().is_empty() {
                body["system"] = json!(req.system_prompt);
            }
            Ok(ProviderHttpRequest {
                url,
                headers: vec![
                    ("Content-Type".to_string(), "application/json".to_string()),
                    ("x-api-key".to_string(), api_key.to_string()),
                    ("anthropic-version".to_string(), "2023-06-01".to_string()),
                ],
                body_json: body.to_string(),
            })
        }
        "openai" | "openrouter" | "ollama" | "custom" => {
            let default_url = match provider.as_str() {
                "openrouter" => "https://openrouter.ai/api/v1/chat/completions",
                "ollama" => "http://localhost:11434/v1/chat/completions",
                _ => "https://api.openai.com/v1/chat/completions",
            };
            let url = if prefs.base_url.trim().is_empty() {
                default_url.to_string()
            } else {
                prefs.base_url.trim().to_string()
            };

            let mut messages = Vec::with_capacity(req.messages.len() + 1);
            if !req.system_prompt.trim().is_empty() {
                messages.push(json!({ "role": "system", "content": req.system_prompt }));
            }
            for m in &req.messages {
                messages.push(json!({ "role": m.role, "content": m.content }));
            }

            let body = json!({
                "model": model,
                "stream": true,
                "messages": messages,
            });

            let mut headers = vec![("Content-Type".to_string(), "application/json".to_string())];
            if !api_key.is_empty() {
                headers.push(("Authorization".to_string(), format!("Bearer {api_key}")));
            }
            if provider == "openrouter" {
                headers.push((
                    "HTTP-Referer".to_string(),
                    "https://skillweaver.local".to_string(),
                ));
                headers.push(("X-Title".to_string(), "Skillweaver".to_string()));
            }

            Ok(ProviderHttpRequest {
                url,
                headers,
                body_json: body.to_string(),
            })
        }
        other => Err(format!("Unsupported AI provider: {other}")),
    }
}

/// Extracts a text delta from a single SSE `data:` JSON payload.
pub fn parse_sse_delta(provider: &str, data_line: &str) -> Option<String> {
    let val: Value = serde_json::from_str(data_line).ok()?;
    match provider.trim().to_ascii_lowercase().as_str() {
        "gemini" => {
            let parts = val
                .get("candidates")?
                .get(0)?
                .get("content")?
                .get("parts")?
                .as_array()?;
            let mut out = String::new();
            for p in parts {
                if p.get("thought").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                if let Some(t) = p.get("text").and_then(Value::as_str) {
                    out.push_str(t);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        "anthropic" => {
            if val.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                return None;
            }
            val.get("delta")?
                .get("text")?
                .as_str()
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        }
        _ => {
            let choice = val.get("choices")?.get(0)?;
            let delta_text = choice
                .get("delta")
                .and_then(|d| d.get("content"))
                .and_then(Value::as_str)
                .or_else(|| {
                    choice
                        .get("message")
                        .and_then(|m| m.get("content"))
                        .and_then(Value::as_str)
                })?;
            if delta_text.is_empty() {
                None
            } else {
                Some(delta_text.to_string())
            }
        }
    }
}

/// Extracts a readable error message from a provider JSON error body.
pub fn extract_http_error_message(body: &str) -> String {
    let trimmed = body.trim();
    if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
        if let Some(msg) = val
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
        {
            return msg.to_string();
        }
        if let Some(msg) = val.get("message").and_then(Value::as_str) {
            return msg.to_string();
        }
    }
    if trimmed.is_empty() {
        "Request failed with no response body".to_string()
    } else {
        trimmed.chars().take(320).collect()
    }
}

fn escape_curl_config_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\r' | '\n' => out.push(' '),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Starts a background streaming chat request using `curl.exe` with secrets passed via stdin.
pub fn start_chat_stream(
    app: AppHandle,
    ai_state: &AiState,
    req: AiChatRequest,
) -> Result<(), String> {
    cancel_stream(ai_state);

    let prefs = load_ai_prefs();
    let http_req = build_provider_http_request(&prefs, &req)?;
    let provider = prefs.provider.clone();
    let request_id = req.request_id.clone();

    let seq = REQ_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = std::env::temp_dir().join(format!(
        "skillweaver_ai_{}_{}.json",
        std::process::id(),
        seq
    ));
    fs::write(&tmp_path, http_req.body_json.as_bytes())
        .map_err(|e| format!("Failed to stage AI request body: {e}"))?;

    let mut config_stdin = format!("url = {}\n", escape_curl_config_value(&http_req.url));
    for (k, v) in &http_req.headers {
        let header_line = format!("{k}: {v}");
        config_stdin.push_str(&format!("header = {}\n", escape_curl_config_value(&header_line)));
    }

    let curl_bin = if cfg!(windows) { "curl.exe" } else { "curl" };
    let mut cmd = Command::new(curl_bin);
    cmd.args(["-sS", "-N", "--connect-timeout", "20", "--max-time", "180", "-K", "-", "--data-binary"])
        .arg(format!("@{}", tmp_path.display()))
        .args(["-w", &format!("\n{HTTP_STATUS_MARKER}%{{http_code}}\n")])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("Failed to launch {curl_bin}: {e}"));
        }
    };

    let pid = child.id();
    if let Ok(mut guard) = ai_state.active_pid.lock() {
        *guard = Some(pid);
    }

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(config_stdin.as_bytes());
        let _ = stdin.flush();
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to attach curl stdout".to_string())?;
    let stderr = child.stderr.take();

    thread::spawn(move || {
        let _tmp_guard = TempFileGuard(tmp_path);
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        let mut http_status: u16 = 0;
        let mut emitted_any_delta = false;
        let mut raw_non_sse = String::new();

        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line_lossy = String::from_utf8_lossy(&buf);
                    let line = line_lossy.trim_end_matches(['\r', '\n']);

                    if let Some(code_str) = line.strip_prefix(HTTP_STATUS_MARKER) {
                        if let Ok(code) = code_str.trim().parse::<u16>() {
                            http_status = code;
                        }
                        continue;
                    }

                    if let Some(data_raw) = line.strip_prefix("data:") {
                        let data = data_raw.trim();
                        if data.is_empty() || data == "[DONE]" {
                            continue;
                        }
                        if let Some(delta) = parse_sse_delta(&provider, data) {
                            emitted_any_delta = true;
                            let _ = app.emit(
                                "ai-stream",
                                AiStreamEvent {
                                    request_id: request_id.clone(),
                                    kind: "delta".to_string(),
                                    text: delta,
                                },
                            );
                        }
                    } else if !line.trim().is_empty() && raw_non_sse.len() < 16384 {
                        if !raw_non_sse.is_empty() {
                            raw_non_sse.push('\n');
                        }
                        raw_non_sse.push_str(line);
                    }
                }
            }
        }

        let stderr_text = stderr
            .map(|mut s| {
                let mut err_str = String::new();
                let _ = std::io::Read::read_to_string(&mut s, &mut err_str);
                err_str
            })
            .unwrap_or_default();

        let status = child.wait();
        let exit_ok = status.map(|s| s.success()).unwrap_or(false);

        if http_status >= 400 {
            let msg = extract_http_error_message(&raw_non_sse);
            let _ = app.emit(
                "ai-stream",
                AiStreamEvent {
                    request_id,
                    kind: "error".to_string(),
                    text: format!("HTTP {http_status}: {msg}"),
                },
            );
            return;
        }

        if !exit_ok && !emitted_any_delta {
            let msg = if !stderr_text.trim().is_empty() {
                stderr_text.trim().to_string()
            } else {
                "AI request cancelled or failed".to_string()
            };
            let _ = app.emit(
                "ai-stream",
                AiStreamEvent {
                    request_id,
                    kind: "error".to_string(),
                    text: msg,
                },
            );
            return;
        }

        if !emitted_any_delta && !raw_non_sse.trim().is_empty() {
            if let Some(fallback_text) = parse_sse_delta(&provider, &raw_non_sse) {
                let _ = app.emit(
                    "ai-stream",
                    AiStreamEvent {
                        request_id: request_id.clone(),
                        kind: "delta".to_string(),
                        text: fallback_text,
                    },
                );
            }
        }

        let _ = app.emit(
            "ai-stream",
            AiStreamEvent {
                request_id,
                kind: "done".to_string(),
                text: String::new(),
            },
        );
    });

    Ok(())
}

/// Cancels any active streaming AI request.
pub fn cancel_stream(ai_state: &AiState) {
    if let Ok(mut guard) = ai_state.active_pid.lock() {
        if let Some(pid) = guard.take() {
            kill_pid(pid);
        }
    }
}

/// Builds the provider URL and headers for listing live available models.
pub fn build_list_models_request(
    req: &AiListModelsRequest,
) -> Result<(String, Vec<(String, String)>), String> {
    let provider = req.provider.trim().to_ascii_lowercase();
    let api_key = req.api_key.trim();
    let base = req.base_url.trim().trim_end_matches('/');

    match provider.as_str() {
        "gemini" => {
            if api_key.is_empty() {
                return Err("Enter your Google Gemini API key first".to_string());
            }
            let root = if base.is_empty() {
                "https://generativelanguage.googleapis.com/v1beta"
            } else {
                base
            };
            Ok((
                format!("{root}/models?pageSize=100"),
                vec![("x-goog-api-key".to_string(), api_key.to_string())],
            ))
        }
        "anthropic" => {
            if api_key.is_empty() {
                return Err("Enter your Anthropic API key first".to_string());
            }
            let url = if base.is_empty() {
                "https://api.anthropic.com/v1/models".to_string()
            } else if let Some(prefix) = base.strip_suffix("/messages") {
                format!("{prefix}/models")
            } else if base.ends_with("/models") {
                base.to_string()
            } else {
                format!("{base}/models")
            };
            Ok((
                url,
                vec![
                    ("x-api-key".to_string(), api_key.to_string()),
                    ("anthropic-version".to_string(), "2023-06-01".to_string()),
                ],
            ))
        }
        "ollama" => {
            let root = if base.is_empty() {
                "http://localhost:11434"
            } else {
                base.strip_suffix("/v1/chat/completions")
                    .or_else(|| base.strip_suffix("/chat/completions"))
                    .or_else(|| base.strip_suffix("/api/tags"))
                    .or_else(|| base.strip_suffix("/v1"))
                    .unwrap_or(base)
            };
            Ok((format!("{root}/api/tags"), Vec::new()))
        }
        "openai" | "openrouter" | "custom" => {
            if provider != "custom" && api_key.is_empty() {
                return Err(format!("Enter your {} API key first", req.provider));
            }
            let default_url = if provider == "openrouter" {
                "https://openrouter.ai/api/v1/models"
            } else {
                "https://api.openai.com/v1/models"
            };
            let url = if base.is_empty() {
                default_url.to_string()
            } else if let Some(prefix) = base.strip_suffix("/chat/completions") {
                format!("{prefix}/models")
            } else if let Some(prefix) = base.strip_suffix("/completions") {
                format!("{prefix}/models")
            } else if base.ends_with("/models") {
                base.to_string()
            } else {
                format!("{base}/models")
            };
            let mut headers = Vec::new();
            if !api_key.is_empty() {
                headers.push(("Authorization".to_string(), format!("Bearer {api_key}")));
            }
            Ok((url, headers))
        }
        other => Err(format!("Unsupported AI provider: {other}")),
    }
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn is_snapshot_or_preview_id(id: &str) -> bool {
    let lower = id.trim().to_ascii_lowercase();
    let noisy_markers = [
        "-preview",
        "-exp",
        "experimental",
        "-alpha",
        "-beta",
        "gemma-",
        "learnlm-",
        "deep-research",
        "robotics",
        "computer-use",
        "customtools",
    ];
    if noisy_markers.iter().any(|m| lower.contains(m)) {
        return true;
    }

    let base = lower.split(':').next().unwrap_or(&lower);
    let parts: Vec<&str> = base.split('-').collect();
    if let Some(last) = parts.last() {
        // YYYYMMDD (8 digits), MMDD (4 digits), or 3-digit revision like 001/002
        if is_digits(last) && (last.len() == 8 || last.len() == 4 || last.len() == 3) {
            return true;
        }
    }
    // Check YYYY-MM-DD or MM-DD trailing pattern
    if parts.len() >= 2 {
        let n = parts.len();
        if is_digits(parts[n - 1])
            && parts[n - 1].len() == 2
            && is_digits(parts[n - 2])
            && parts[n - 2].len() == 2
        {
            return true;
        }
    }
    false
}

fn natural_version_desc(a: &str, b: &str) -> CmpOrdering {
    fn next_chunk(bytes: &[u8], i: &mut usize) -> (bool, u64, String) {
        let start = *i;
        let is_num = bytes[*i].is_ascii_digit();
        while *i < bytes.len() && bytes[*i].is_ascii_digit() == is_num {
            *i += 1;
        }
        let slice = std::str::from_utf8(&bytes[start..*i]).unwrap_or("");
        if is_num {
            (true, slice.parse::<u64>().unwrap_or(0), String::new())
        } else {
            (false, 0, slice.to_ascii_lowercase())
        }
    }

    let ba = a.as_bytes();
    let bb = b.as_bytes();
    let (mut ia, mut ib) = (0usize, 0usize);
    while ia < ba.len() && ib < bb.len() {
        let ca = next_chunk(ba, &mut ia);
        let cb = next_chunk(bb, &mut ib);
        let ord = match (ca.0, cb.0) {
            (true, true) => cb.1.cmp(&ca.1), // Numeric descending
            (false, false) => cb.2.cmp(&ca.2),
            (true, false) => CmpOrdering::Less,
            (false, true) => CmpOrdering::Greater,
        };
        if ord != CmpOrdering::Equal {
            return ord;
        }
    }
    bb.len().cmp(&ba.len())
}

fn anthropic_family_key(id: &str) -> String {
    let parts: Vec<&str> = id.split('-').collect();
    if let Some(last) = parts.last() {
        if is_digits(last) && last.len() == 8 && parts.len() > 1 {
            return parts[..parts.len() - 1].join("-");
        }
    }
    id.to_string()
}

/// Parses a provider's model-listing JSON response into normalized `AiModelInfo` items.
pub fn parse_models_response(provider: &str, body: &str) -> Result<Vec<AiModelInfo>, String> {
    let val: Value =
        serde_json::from_str(body).map_err(|e| format!("Invalid model list JSON: {e}"))?;
    let p = provider.trim().to_ascii_lowercase();
    let mut models: Vec<AiModelInfo> = Vec::new();
    let mut seen = HashSet::new();

    match p.as_str() {
        "gemini" => {
            if let Some(arr) = val.get("models").and_then(Value::as_array) {
                for item in arr {
                    let supports_chat = item
                        .get("supportedGenerationMethods")
                        .and_then(Value::as_array)
                        .map(|methods| {
                            methods
                                .iter()
                                .any(|m| m.as_str() == Some("generateContent"))
                        })
                        .unwrap_or(true);
                    if !supports_chat {
                        continue;
                    }
                    let Some(raw_name) = item.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    let id = raw_name.strip_prefix("models/").unwrap_or(raw_name).trim();
                    if id.is_empty() {
                        continue;
                    }
                    let lower = id.to_ascii_lowercase();
                    if lower.contains("embedding")
                        || lower.contains("aqa")
                        || lower.contains("imagen")
                        || lower.contains("veo")
                        || lower.contains("-tts")
                        || lower.contains("native-audio")
                        || lower.contains("live-")
                    {
                        continue;
                    }
                    let label = item
                        .get("displayName")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(id)
                        .to_string();
                    let is_snapshot = is_snapshot_or_preview_id(id);
                    let tier_hint = if lower.contains("flash-lite") {
                        Some("Lite".to_string())
                    } else if lower.contains("flash") || lower.contains("hydrogen") {
                        Some("Fast".to_string())
                    } else {
                        None
                    };
                    if seen.insert(id.to_string()) {
                        models.push(AiModelInfo {
                            id: id.to_string(),
                            label,
                            is_snapshot,
                            tier_hint,
                        });
                    }
                }
            }
            models.sort_by(|a, b| {
                let rank = |id: &str| -> u8 {
                    let l = id.to_ascii_lowercase();
                    if l.contains("flash-lite") {
                        0
                    } else if l.contains("flash") {
                        1
                    } else if l.contains("hydrogen") {
                        2
                    } else if l.contains("neon") {
                        3
                    } else if l.contains("gemini") {
                        4
                    } else {
                        5
                    }
                };
                a.is_snapshot
                    .cmp(&b.is_snapshot)
                    .then_with(|| rank(&a.id).cmp(&rank(&b.id)))
                    .then_with(|| natural_version_desc(&a.id, &b.id))
            });
        }
        "openai" => {
            let excluded = [
                "whisper",
                "dall-e",
                "tts",
                "embedding",
                "moderation",
                "babbage",
                "davinci",
                "curie",
                "ada",
                "realtime",
                "audio",
                "transcribe",
                "sora",
                "search-preview",
            ];
            if let Some(arr) = val.get("data").and_then(Value::as_array) {
                for item in arr {
                    let Some(raw_id) = item.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let id = raw_id.trim();
                    if id.is_empty() {
                        continue;
                    }
                    let lower = id.to_ascii_lowercase();
                    if excluded.iter().any(|ex| lower.contains(ex)) {
                        continue;
                    }
                    let is_snapshot = is_snapshot_or_preview_id(id);
                    let tier_hint = if lower.contains("nano") {
                        Some("Nano".to_string())
                    } else if lower.contains("mini") {
                        Some("Mini".to_string())
                    } else {
                        None
                    };
                    if seen.insert(id.to_string()) {
                        models.push(AiModelInfo {
                            id: id.to_string(),
                            label: id.to_string(),
                            is_snapshot,
                            tier_hint,
                        });
                    }
                }
            }
            models.sort_by(|a, b| {
                let rank = |id: &str| -> u8 {
                    let l = id.to_ascii_lowercase();
                    if l.contains("nano") {
                        0
                    } else if l.contains("mini") {
                        1
                    } else if l.contains("pro") {
                        3
                    } else {
                        2
                    }
                };
                a.is_snapshot
                    .cmp(&b.is_snapshot)
                    .then_with(|| rank(&a.id).cmp(&rank(&b.id)))
                    .then_with(|| natural_version_desc(&a.id, &b.id))
            });
        }
        "anthropic" => {
            if let Some(arr) = val.get("data").and_then(Value::as_array) {
                for item in arr {
                    let Some(raw_id) = item.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let id = raw_id.trim();
                    if id.is_empty() {
                        continue;
                    }
                    let lower = id.to_ascii_lowercase();
                    let label = item
                        .get("display_name")
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(id)
                        .to_string();
                    let tier_hint = if lower.contains("haiku") {
                        Some("Fast".to_string())
                    } else {
                        None
                    };
                    if seen.insert(id.to_string()) {
                        models.push(AiModelInfo {
                            id: id.to_string(),
                            label,
                            is_snapshot: true,
                            tier_hint,
                        });
                    }
                }
            }
            models.sort_by(|a, b| {
                let rank = |id: &str| -> u8 {
                    let l = id.to_ascii_lowercase();
                    if l.contains("haiku") {
                        0
                    } else if l.contains("sonnet") {
                        1
                    } else if l.contains("opus") {
                        2
                    } else {
                        3
                    }
                };
                rank(&a.id)
                    .cmp(&rank(&b.id))
                    .then_with(|| natural_version_desc(&a.id, &b.id))
            });
            // Promote the newest entry in each Claude family to primary (latest)
            let mut promoted_families = HashSet::new();
            for m in &mut models {
                let fam = anthropic_family_key(&m.id);
                if promoted_families.insert(fam) {
                    m.is_snapshot = false;
                }
            }
            models.sort_by(|a, b| a.is_snapshot.cmp(&b.is_snapshot));
        }
        "openrouter" => {
            let mut priced: Vec<(f64, AiModelInfo)> = Vec::new();
            if let Some(arr) = val.get("data").and_then(Value::as_array) {
                for item in arr {
                    let Some(raw_id) = item.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let id = raw_id.trim();
                    if id.is_empty() {
                        continue;
                    }
                    let label = item
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(id)
                        .to_string();
                    let prompt_usd: f64 = item
                        .get("pricing")
                        .and_then(|pr| pr.get("prompt"))
                        .and_then(|v| {
                            v.as_f64()
                                .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
                        })
                        .filter(|x| x.is_finite() && *x >= 0.0)
                        .unwrap_or(1e9);

                    let per_million = prompt_usd * 1_000_000.0;
                    let is_free = id.ends_with(":free") || prompt_usd == 0.0;
                    let tier_hint = if is_free {
                        Some("Free".to_string())
                    } else if prompt_usd < 1e8 {
                        if per_million < 0.1 {
                            Some(format!("${per_million:.3}/M"))
                        } else {
                            Some(format!("${per_million:.2}/M"))
                        }
                    } else {
                        None
                    };
                    let is_snapshot = is_snapshot_or_preview_id(id);
                    if seen.insert(id.to_string()) {
                        let sort_price = if is_free { 0.0 } else { prompt_usd };
                        priced.push((
                            sort_price,
                            AiModelInfo {
                                id: id.to_string(),
                                label,
                                is_snapshot,
                                tier_hint,
                            },
                        ));
                    }
                }
            }
            priced.sort_by(|(pa, a), (pb, b)| {
                a.is_snapshot
                    .cmp(&b.is_snapshot)
                    .then_with(|| pa.partial_cmp(pb).unwrap_or(CmpOrdering::Equal))
                    .then_with(|| a.id.cmp(&b.id))
            });
            models = priced.into_iter().map(|(_, m)| m).collect();
        }
        "ollama" => {
            if let Some(arr) = val.get("models").and_then(Value::as_array) {
                for item in arr {
                    let Some(name) = item
                        .get("name")
                        .or_else(|| item.get("model"))
                        .and_then(Value::as_str)
                    else {
                        continue;
                    };
                    let id = name.trim();
                    if !id.is_empty() && seen.insert(id.to_string()) {
                        models.push(AiModelInfo {
                            id: id.to_string(),
                            label: id.to_string(),
                            is_snapshot: false,
                            tier_hint: Some("Local".to_string()),
                        });
                    }
                }
            }
        }
        _ => {
            if let Some(arr) = val.get("data").and_then(Value::as_array) {
                for item in arr {
                    let Some(raw_id) = item.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    let id = raw_id.trim();
                    if id.is_empty() {
                        continue;
                    }
                    let label = item
                        .get("display_name")
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(id)
                        .to_string();
                    if seen.insert(id.to_string()) {
                        models.push(AiModelInfo {
                            id: id.to_string(),
                            label,
                            is_snapshot: false,
                            tier_hint: None,
                        });
                    }
                }
            }
        }
    }

    // Safety fallback: never leave the default picker completely empty if all models were flagged
    if !models.is_empty() && models.iter().all(|m| m.is_snapshot) {
        for m in models.iter_mut().take(8) {
            m.is_snapshot = false;
        }
    }

    Ok(models)
}

/// Fetches the live model list from the configured provider and updates `~/.skillweaver/cache/models.json`.
pub fn list_models(req: &AiListModelsRequest) -> Result<CachedModelList, String> {
    let (url, headers) = build_list_models_request(req)?;
    let mut config_stdin = format!("url = {}\n", escape_curl_config_value(&url));
    for (k, v) in &headers {
        let header_line = format!("{k}: {v}");
        config_stdin.push_str(&format!("header = {}\n", escape_curl_config_value(&header_line)));
    }

    let curl_bin = if cfg!(windows) { "curl.exe" } else { "curl" };
    let mut cmd = Command::new(curl_bin);
    cmd.args([
        "-sS",
        "--connect-timeout",
        "12",
        "--max-time",
        "25",
        "-K",
        "-",
        "-w",
        &format!("\n{HTTP_STATUS_MARKER}%{{http_code}}\n"),
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch {curl_bin}: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(config_stdin.as_bytes());
        let _ = stdin.flush();
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed waiting for {curl_bin}: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut http_status: u16 = 0;
    let mut body_lines = Vec::new();
    for line in stdout.lines() {
        if let Some(code_str) = line.strip_prefix(HTTP_STATUS_MARKER) {
            if let Ok(code) = code_str.trim().parse::<u16>() {
                http_status = code;
            }
        } else {
            body_lines.push(line);
        }
    }
    let body = body_lines.join("\n");

    if http_status >= 400 {
        return Err(format!(
            "HTTP {http_status}: {}",
            extract_http_error_message(&body)
        ));
    }
    if !output.status.success() && body.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Failed to fetch models".to_string()
        } else {
            stderr
        });
    }

    let models = parse_models_response(&req.provider, &body)?;
    let entry = CachedModelList {
        fetched_at_unix: current_unix_secs(),
        models,
    };

    if let Some(cache_path) = models_cache_path() {
        let mut cache = load_models_cache_from(&cache_path);
        let key = canonical_cache_key(&req.provider, &req.base_url);
        cache.insert(key, entry.clone());
        let _ = save_models_cache_to(&cache_path, &cache);
    }

    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("skillweaver_ai_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ai_prefs_round_trip() {
        let dir = temp_dir("prefs");
        let path = dir.join("ai.prefs");
        let prefs = AiPrefs {
            provider: "gemini".to_string(),
            api_key: "sk-test-123".to_string(),
            base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
            model: "gemini-2.5-flash".to_string(),
        };
        save_ai_prefs_to(&path, &prefs).unwrap();
        assert_eq!(load_ai_prefs_from(&path), prefs);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn provider_request_builders_and_sse_parsers_work() {
        let req = AiChatRequest {
            request_id: "r-1".into(),
            system_prompt: "Be concise".into(),
            messages: vec![AiChatMessage {
                role: "user".into(),
                content: "Hi".into(),
            }],
        };

        // OpenAI
        let openai_prefs = AiPrefs {
            provider: "openai".into(),
            api_key: "sk-openai".into(),
            base_url: "https://api.openai.com/v1/chat/completions".into(),
            model: "gpt-4o-mini".into(),
        };
        let built_oa = build_provider_http_request(&openai_prefs, &req).unwrap();
        assert_eq!(built_oa.url, "https://api.openai.com/v1/chat/completions");
        assert!(built_oa
            .headers
            .iter()
            .any(|(k, v)| k == "Authorization" && v == "Bearer sk-openai"));
        assert_eq!(
            parse_sse_delta("openai", r#"{"choices":[{"delta":{"content":"Hello"}}]}"#),
            Some("Hello".to_string())
        );

        // Gemini
        let gem_prefs = AiPrefs {
            provider: "gemini".into(),
            api_key: "AIzaTest".into(),
            base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            model: "gemini-2.5-flash".into(),
        };
        let built_gem = build_provider_http_request(&gem_prefs, &req).unwrap();
        assert_eq!(
            built_gem.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
        );
        assert!(built_gem
            .headers
            .iter()
            .any(|(k, v)| k == "x-goog-api-key" && v == "AIzaTest"));
        assert_eq!(
            parse_sse_delta(
                "gemini",
                r#"{"candidates":[{"content":{"parts":[{"text":"World"}]}}]}"#
            ),
            Some("World".to_string())
        );

        // Anthropic
        let ant_prefs = AiPrefs {
            provider: "anthropic".into(),
            api_key: "sk-ant-1".into(),
            base_url: "https://api.anthropic.com/v1/messages".into(),
            model: "claude-3-5-sonnet-latest".into(),
        };
        let built_ant = build_provider_http_request(&ant_prefs, &req).unwrap();
        assert!(built_ant
            .headers
            .iter()
            .any(|(k, v)| k == "x-api-key" && v == "sk-ant-1"));
        assert_eq!(
            parse_sse_delta(
                "anthropic",
                r#"{"type":"content_block_delta","delta":{"text":"Claude"}}"#
            ),
            Some("Claude".to_string())
        );
    }

    #[test]
    fn extract_http_error_message_reads_nested_json() {
        let body = r#"{"error":{"message":"Invalid API key provided"}}"#;
        assert_eq!(extract_http_error_message(body), "Invalid API key provided");
    }

    #[test]
    fn list_models_request_builders_and_parsers_work() {
        let (gem_url, gem_headers) = build_list_models_request(&AiListModelsRequest {
            provider: "gemini".into(),
            api_key: "AIzaSecret".into(),
            base_url: "".into(),
        })
        .unwrap();
        assert_eq!(
            gem_url,
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100"
        );
        assert!(gem_headers
            .iter()
            .any(|(k, v)| k == "x-goog-api-key" && v == "AIzaSecret"));

        let (ollama_url, _) = build_list_models_request(&AiListModelsRequest {
            provider: "ollama".into(),
            api_key: "".into(),
            base_url: "http://localhost:11434/v1/chat/completions".into(),
        })
        .unwrap();
        assert_eq!(ollama_url, "http://localhost:11434/api/tags");

        let gem_json = r#"{
            "models": [
                {"name": "models/gemini-3.8-flash", "displayName": "Gemini 3.8 Flash", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-3.5-flash-lite", "displayName": "Gemini 3.5 Flash-Lite", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-3.5-flash-preview-04-17", "displayName": "Gemini Preview", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/text-embedding-004", "displayName": "Embedding 004", "supportedGenerationMethods": ["embedContent"]}
            ]
        }"#;
        let gem_models = parse_models_response("gemini", gem_json).unwrap();
        assert_eq!(gem_models.len(), 3);
        assert_eq!(gem_models[0].id, "gemini-3.5-flash-lite");
        assert!(!gem_models[0].is_snapshot);
        assert_eq!(gem_models[1].id, "gemini-3.8-flash");
        assert!(!gem_models[1].is_snapshot);
        assert_eq!(gem_models[2].id, "gemini-3.5-flash-preview-04-17");
        assert!(gem_models[2].is_snapshot);

        let oa_json = r#"{"data":[
            {"id":"gpt-4o"},
            {"id":"gpt-4o-mini"},
            {"id":"gpt-4o-mini-2024-07-18"},
            {"id":"whisper-1"}
        ]}"#;
        let oa_models = parse_models_response("openai", oa_json).unwrap();
        assert_eq!(oa_models.len(), 3);
        assert_eq!(oa_models[0].id, "gpt-4o-mini");
        assert!(!oa_models[0].is_snapshot);
        assert_eq!(oa_models[1].id, "gpt-4o");
        assert!(!oa_models[1].is_snapshot);
        assert_eq!(oa_models[2].id, "gpt-4o-mini-2024-07-18");
        assert!(oa_models[2].is_snapshot);

        let ant_json = r#"{"data":[
            {"id":"claude-haiku-4-5-20251001","display_name":"Claude Haiku 4.5"},
            {"id":"claude-haiku-4-5-20250101","display_name":"Claude Haiku Old"},
            {"id":"claude-sonnet-4-5-20250929","display_name":"Claude Sonnet 4.5"}
        ]}"#;
        let ant_models = parse_models_response("anthropic", ant_json).unwrap();
        assert_eq!(ant_models.len(), 3);
        assert!(!ant_models[0].is_snapshot);
        assert!(!ant_models[1].is_snapshot);
        assert!(ant_models[2].is_snapshot);

        let or_json = r#"{"data":[
            {"id":"anthropic/claude-3.5-sonnet","name":"Claude 3.5 Sonnet","pricing":{"prompt":"0.000003"}},
            {"id":"google/gemini-flash:free","name":"Gemini Flash Free","pricing":{"prompt":"0"}}
        ]}"#;
        let or_models = parse_models_response("openrouter", or_json).unwrap();
        assert_eq!(or_models[0].id, "google/gemini-flash:free");
        assert_eq!(or_models[0].tier_hint.as_deref(), Some("Free"));
        assert_eq!(or_models[1].tier_hint.as_deref(), Some("$3.00/M"));

        let ol_json = r#"{"models":[{"name":"llama3.2:latest"},{"name":"qwen2.5-coder:7b"}]}"#;
        let ol_models = parse_models_response("ollama", ol_json).unwrap();
        assert_eq!(ol_models.len(), 2);
        assert_eq!(ol_models[1].id, "qwen2.5-coder:7b");

        // Thought parts from Gemini thinking models should not leak into visible text deltas
        assert_eq!(
            parse_sse_delta(
                "gemini",
                r#"{"candidates":[{"content":{"parts":[{"text":"internal","thought":true},{"text":"Visible"}]}}]}"#
            ),
            Some("Visible".to_string())
        );
    }

    #[test]
    fn models_cache_round_trip() {
        let dir = temp_dir("cache");
        let path = dir.join("cache").join("models.json");
        let mut cache = ModelsCache::new();
        cache.insert(
            canonical_cache_key("gemini", ""),
            CachedModelList {
                fetched_at_unix: 123456,
                models: vec![AiModelInfo {
                    id: "test-model".into(),
                    label: "Test Model".into(),
                    is_snapshot: false,
                    tier_hint: Some("Fast".into()),
                }],
            },
        );
        save_models_cache_to(&path, &cache).unwrap();
        assert_eq!(load_models_cache_from(&path), cache);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn chat_history_crud_pin_rename_and_path_safety() {
        let dir = temp_dir("chats");
        assert!(load_chat_in(&dir, "../evil").is_err());
        assert!(delete_chat_in(&dir, "bad/id").is_err());

        let c1 = AiChatSession {
            id: "chat-1".into(),
            title: "Older Chat".into(),
            vault_path: "C:/notes".into(),
            vault_name: "notes".into(),
            pinned: false,
            created_at: 100,
            updated_at: 200,
            messages: vec![StoredChatMessage {
                id: "u-1".into(),
                role: "user".into(),
                content: "hello".into(),
                created_at: 100,
                error: None,
                proposal_states: HashMap::new(),
            }],
        };
        let c2 = AiChatSession {
            id: "chat-2".into(),
            title: "Newer Chat".into(),
            vault_path: "C:/notes".into(),
            vault_name: "notes".into(),
            pinned: false,
            created_at: 150,
            updated_at: 300,
            messages: vec![],
        };

        save_chat_in(&dir, &c1).unwrap();
        let list = save_chat_in(&dir, &c2).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "chat-2");
        assert_eq!(list[1].id, "chat-1");

        // Pin & rename older chat -> moves to top
        let updated = update_chat_meta_in(&dir, "chat-1", Some("Pinned Topic".into()), Some(true)).unwrap();
        assert_eq!(updated[0].id, "chat-1");
        assert_eq!(updated[0].title, "Pinned Topic");
        assert!(updated[0].pinned);

        let loaded = load_chat_in(&dir, "chat-1").unwrap();
        assert_eq!(loaded.title, "Pinned Topic");
        assert_eq!(loaded.messages.len(), 1);

        let after_del = delete_chat_in(&dir, "chat-1").unwrap();
        assert_eq!(after_del.len(), 1);
        assert_eq!(after_del[0].id, "chat-2");
        assert!(load_chat_in(&dir, "chat-1").is_err());

        let _ = fs::remove_dir_all(&dir);
    }
}
