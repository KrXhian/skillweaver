use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::prefs::{load_ai_prefs, AiPrefs};
#[cfg(windows)]
use super::CREATE_NO_WINDOW;
use super::{escape_curl_config_value, extract_http_error_message, HTTP_STATUS_MARKER};

static REQ_TMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiChatRequest {
    pub request_id: String,
    pub system_prompt: String,
    #[serde(default)]
    pub stable_context: Option<String>,
    pub messages: Vec<AiChatMessage>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStreamEvent {
    pub request_id: String,
    pub kind: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

/// Holds the PID of any currently streaming `curl` process so it can be cancelled cleanly.
#[derive(Default)]
pub struct AiState {
    active_pid: Arc<Mutex<Option<u32>>>,
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

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderHttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body_json: String,
}

fn anthropic_max_tokens(model: &str) -> u32 {
    let lower = model.trim().to_ascii_lowercase();
    if lower.starts_with("claude-3-")
        && !lower.starts_with("claude-3-5")
        && !lower.starts_with("claude-3-7")
    {
        4096
    } else {
        8192
    }
}

fn coalesce_consecutive_roles(messages: &[AiChatMessage]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::with_capacity(messages.len());
    for m in messages {
        if m.content.trim().is_empty() {
            continue;
        }
        let role = if m.role == "assistant" {
            "assistant".to_string()
        } else {
            "user".to_string()
        };
        if let Some(last) = out.last_mut() {
            if last.0 == role {
                last.1.push_str("\n\n");
                last.1.push_str(&m.content);
                continue;
            }
        }
        out.push((role, m.content.clone()));
    }
    out
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
    if req.messages.is_empty() {
        return Err("At least one chat message is required".to_string());
    }
    let api_key = prefs.api_key.trim();

    if !matches!(provider.as_str(), "ollama" | "custom") && api_key.is_empty() {
        return Err(format!(
            "API key is required for provider '{}'. Open AI settings to add your key.",
            prefs.provider
        ));
    }

    let static_sys = req.system_prompt.trim();
    let stable_ctx = req
        .stable_context
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match provider.as_str() {
        "gemini" => {
            let base = if prefs.base_url.trim().is_empty() {
                "https://generativelanguage.googleapis.com/v1beta"
            } else {
                prefs.base_url.trim().trim_end_matches('/')
            };
            let url = format!("{base}/models/{model}:streamGenerateContent?alt=sse");
            let coalesced = coalesce_consecutive_roles(&req.messages);
            let contents: Vec<Value> = coalesced
                .into_iter()
                .map(|(role, content)| {
                    let gem_role = if role == "assistant" { "model" } else { "user" };
                    json!({
                        "role": gem_role,
                        "parts": [{ "text": content }]
                    })
                })
                .collect();
            let mut body = json!({ "contents": contents });
            let mut system_parts: Vec<Value> = Vec::new();
            if !static_sys.is_empty() {
                system_parts.push(json!({ "text": static_sys }));
            }
            if let Some(sc) = stable_ctx {
                system_parts.push(json!({ "text": sc }));
            }
            if !system_parts.is_empty() {
                body["system_instruction"] = json!({ "parts": system_parts });
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
            let coalesced = coalesce_consecutive_roles(&req.messages);
            let messages: Vec<Value> = coalesced
                .into_iter()
                .map(|(role, content)| json!({ "role": role, "content": content }))
                .collect();
            let mut body = json!({
                "model": model,
                "max_tokens": anthropic_max_tokens(model),
                "stream": true,
                "messages": messages,
            });
            let mut system_blocks: Vec<Value> = Vec::new();
            if !static_sys.is_empty() {
                system_blocks.push(json!({
                    "type": "text",
                    "text": static_sys,
                    "cache_control": { "type": "ephemeral" }
                }));
            }
            if let Some(sc) = stable_ctx {
                system_blocks.push(json!({
                    "type": "text",
                    "text": sc,
                    "cache_control": { "type": "ephemeral" }
                }));
            }
            if !system_blocks.is_empty() {
                body["system"] = Value::Array(system_blocks);
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
            let combined_sys = match (static_sys.is_empty(), stable_ctx) {
                (false, Some(sc)) => Some(format!("{static_sys}\n\n================\n\n{sc}")),
                (false, None) => Some(static_sys.to_string()),
                (true, Some(sc)) => Some(sc.to_string()),
                (true, None) => None,
            };
            if let Some(sys_content) = combined_sys {
                messages.push(json!({ "role": "system", "content": sys_content }));
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

/// Extracts a stop/finish reason from a single SSE `data:` JSON payload, if present.
pub fn parse_sse_finish_reason(provider: &str, data_line: &str) -> Option<String> {
    let val: Value = serde_json::from_str(data_line).ok()?;
    let reason = match provider.trim().to_ascii_lowercase().as_str() {
        "gemini" => val
            .get("candidates")?
            .get(0)?
            .get("finishReason")?
            .as_str()
            .filter(|s| *s != "FINISH_REASON_UNSPECIFIED")?,
        "anthropic" => {
            if val.get("type").and_then(Value::as_str) != Some("message_delta") {
                return None;
            }
            val.get("delta")?.get("stop_reason")?.as_str()?
        }
        _ => val.get("choices")?.get(0)?.get("finish_reason")?.as_str()?,
    };
    let trimmed = reason.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

struct PidClearGuard {
    active_pid: Arc<Mutex<Option<u32>>>,
    pid: u32,
}

impl Drop for PidClearGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.active_pid.lock() {
            if *guard == Some(self.pid) {
                *guard = None;
            }
        }
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
        config_stdin.push_str(&format!(
            "header = {}\n",
            escape_curl_config_value(&header_line)
        ));
    }

    let curl_bin = if cfg!(windows) { "curl.exe" } else { "curl" };
    let mut cmd = Command::new(curl_bin);
    cmd.args([
        "-sS",
        "-N",
        "--connect-timeout",
        "20",
        "--max-time",
        "180",
        "-K",
        "-",
        "--data-binary",
    ])
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
    let active_pid_ref = Arc::clone(&ai_state.active_pid);

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
        let _pid_guard = PidClearGuard {
            active_pid: active_pid_ref,
            pid,
        };
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        let mut http_status: u16 = 0;
        let mut emitted_any_delta = false;
        let mut finish_reason: Option<String> = None;
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
                        if let Some(reason) = parse_sse_finish_reason(&provider, data) {
                            finish_reason = Some(reason);
                        }
                        if let Some(delta) = parse_sse_delta(&provider, data) {
                            emitted_any_delta = true;
                            let _ = app.emit(
                                "ai-stream",
                                AiStreamEvent {
                                    request_id: request_id.clone(),
                                    kind: "delta".to_string(),
                                    text: delta,
                                    finish_reason: None,
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
                    finish_reason: None,
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
                    finish_reason: None,
                },
            );
            return;
        }

        if !emitted_any_delta && !raw_non_sse.trim().is_empty() {
            if let Some(reason) = parse_sse_finish_reason(&provider, &raw_non_sse) {
                finish_reason = Some(reason);
            }
            if let Some(fallback_text) = parse_sse_delta(&provider, &raw_non_sse) {
                let _ = app.emit(
                    "ai-stream",
                    AiStreamEvent {
                        request_id: request_id.clone(),
                        kind: "delta".to_string(),
                        text: fallback_text,
                        finish_reason: None,
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
                finish_reason,
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

    #[test]
    fn provider_request_builders_and_sse_parsers_work() {
        let req = AiChatRequest {
            request_id: "r-1".into(),
            system_prompt: "Be concise".into(),
            stable_context: None,
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
        // Thought parts from Gemini thinking models should not leak into visible text deltas
        assert_eq!(
            parse_sse_delta(
                "gemini",
                r#"{"candidates":[{"content":{"parts":[{"text":"internal","thought":true},{"text":"Visible"}]}}]}"#
            ),
            Some("Visible".to_string())
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
    fn prompt_caching_split_role_coalescing_and_anthropic_max_tokens_work() {
        let req = AiChatRequest {
            request_id: "r-cache".into(),
            system_prompt: "Static instructions".into(),
            stable_context: Some("Current open note (hero.md):\n[b-1] TEXT (1): Hello".into()),
            messages: vec![
                AiChatMessage {
                    role: "user".into(),
                    content: "First".into(),
                },
                AiChatMessage {
                    role: "user".into(),
                    content: "Second".into(),
                },
                AiChatMessage {
                    role: "assistant".into(),
                    content: "Reply".into(),
                },
            ],
        };

        // Anthropic: 2 ephemeral cache blocks, 8192 max_tokens for modern model, coalesced roles
        let ant_modern = AiPrefs {
            provider: "anthropic".into(),
            api_key: "sk-ant".into(),
            base_url: "".into(),
            model: "claude-sonnet-4-5".into(),
        };
        let built_ant = build_provider_http_request(&ant_modern, &req).unwrap();
        let ant_json: Value = serde_json::from_str(&built_ant.body_json).unwrap();
        assert_eq!(ant_json["max_tokens"], 8192);
        let sys_arr = ant_json["system"].as_array().unwrap();
        assert_eq!(sys_arr.len(), 2);
        assert_eq!(sys_arr[0]["text"], "Static instructions");
        assert_eq!(sys_arr[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(
            sys_arr[1]["text"],
            "Current open note (hero.md):\n[b-1] TEXT (1): Hello"
        );
        assert_eq!(sys_arr[1]["cache_control"]["type"], "ephemeral");
        let ant_msgs = ant_json["messages"].as_array().unwrap();
        assert_eq!(ant_msgs.len(), 2);
        assert_eq!(ant_msgs[0]["role"], "user");
        assert_eq!(ant_msgs[0]["content"], "First\n\nSecond");
        assert_eq!(ant_msgs[1]["role"], "assistant");

        // Legacy Claude 3.0 retains 4096 max_tokens
        let ant_legacy = AiPrefs {
            model: "claude-3-haiku-20240307".into(),
            ..ant_modern
        };
        let built_legacy = build_provider_http_request(&ant_legacy, &req).unwrap();
        let legacy_json: Value = serde_json::from_str(&built_legacy.body_json).unwrap();
        assert_eq!(legacy_json["max_tokens"], 4096);

        // Gemini: 2 system_instruction parts and coalesced user turns
        let gem_prefs = AiPrefs {
            provider: "gemini".into(),
            api_key: "AIzaTest".into(),
            base_url: "".into(),
            model: "gemini-2.5-flash".into(),
        };
        let built_gem = build_provider_http_request(&gem_prefs, &req).unwrap();
        let gem_json: Value = serde_json::from_str(&built_gem.body_json).unwrap();
        let gem_parts = gem_json["system_instruction"]["parts"].as_array().unwrap();
        assert_eq!(gem_parts.len(), 2);
        assert_eq!(gem_parts[0]["text"], "Static instructions");
        assert_eq!(
            gem_parts[1]["text"],
            "Current open note (hero.md):\n[b-1] TEXT (1): Hello"
        );
        let gem_contents = gem_json["contents"].as_array().unwrap();
        assert_eq!(gem_contents.len(), 2);
        assert_eq!(gem_contents[0]["role"], "user");
        assert_eq!(gem_contents[0]["parts"][0]["text"], "First\n\nSecond");
        assert_eq!(gem_contents[1]["role"], "model");

        // OpenAI: combined leading system message preserving static prefix first
        let oa_prefs = AiPrefs {
            provider: "openai".into(),
            api_key: "sk-oa".into(),
            base_url: "".into(),
            model: "gpt-4o-mini".into(),
        };
        let built_oa = build_provider_http_request(&oa_prefs, &req).unwrap();
        let oa_json: Value = serde_json::from_str(&built_oa.body_json).unwrap();
        let oa_msgs = oa_json["messages"].as_array().unwrap();
        assert_eq!(oa_msgs[0]["role"], "system");
        let sys_str = oa_msgs[0]["content"].as_str().unwrap();
        assert!(sys_str.starts_with("Static instructions\n\n================\n\nCurrent open note"));
    }

    #[test]
    fn parse_sse_finish_reason_handles_all_providers() {
        assert_eq!(
            parse_sse_finish_reason(
                "openai",
                r#"{"choices":[{"delta":{},"finish_reason":"length"}]}"#
            ),
            Some("length".to_string())
        );
        assert_eq!(
            parse_sse_finish_reason(
                "openai",
                r#"{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}"#
            ),
            None
        );
        assert_eq!(
            parse_sse_finish_reason("gemini", r#"{"candidates":[{"finishReason":"MAX_TOKENS"}]}"#),
            Some("MAX_TOKENS".to_string())
        );
        assert_eq!(
            parse_sse_finish_reason(
                "gemini",
                r#"{"candidates":[{"finishReason":"FINISH_REASON_UNSPECIFIED"}]}"#
            ),
            None
        );
        assert_eq!(
            parse_sse_finish_reason(
                "anthropic",
                r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#
            ),
            Some("max_tokens".to_string())
        );
        assert_eq!(
            parse_sse_finish_reason(
                "anthropic",
                r#"{"type":"content_block_delta","delta":{"text":"hi"}}"#
            ),
            None
        );
    }
}
