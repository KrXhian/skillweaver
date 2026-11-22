use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
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
            model: "gpt-4o-mini".to_string(),
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
    cmd.args(["-sS", "-N", "--max-time", "180", "-K", "-", "--data-binary"])
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
}
