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

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering as CmpOrdering;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use super::http::{
    build_curl_config_stdin, curl_binary, extract_http_error_message, status_write_out_arg,
    HTTP_STATUS_MARKER,
};
#[cfg(windows)]
use crate::fs_util::CREATE_NO_WINDOW;

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

#[derive(Clone, Deserialize)]
pub struct AiListModelsRequest {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
}

impl fmt::Debug for AiListModelsRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let masked_key = if self.api_key.is_empty() {
            ""
        } else {
            "[REDACTED]"
        };
        f.debug_struct("AiListModelsRequest")
            .field("provider", &self.provider)
            .field("api_key", &masked_key)
            .field("base_url", &self.base_url)
            .finish()
    }
}

/// Prepared HTTP request parameters for listing live provider models.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListModelsHttpRequest {
    pub url: String,
    pub headers: Vec<(String, String)>,
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
    let json = serde_json::to_string_pretty(cache)
        .map_err(|e| format!("Failed to serialize models cache: {e}"))?;
    crate::fs_util::write_atomic(path, json.as_bytes())
        .map_err(|e| format!("Failed to write models cache {}: {e}", path.display()))
}

fn current_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Builds the provider URL and headers for listing live available models.
pub fn build_list_models_request(
    req: &AiListModelsRequest,
) -> Result<ListModelsHttpRequest, String> {
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
            Ok(ListModelsHttpRequest {
                url: format!("{root}/models?pageSize=100"),
                headers: vec![("x-goog-api-key".to_string(), api_key.to_string())],
            })
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
            Ok(ListModelsHttpRequest {
                url,
                headers: vec![
                    ("x-api-key".to_string(), api_key.to_string()),
                    ("anthropic-version".to_string(), "2023-06-01".to_string()),
                ],
            })
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
            Ok(ListModelsHttpRequest {
                url: format!("{root}/api/tags"),
                headers: Vec::new(),
            })
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
            Ok(ListModelsHttpRequest { url, headers })
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

enum VersionChunk {
    Numeric(u64),
    Text(String),
}

fn natural_version_desc(a: &str, b: &str) -> CmpOrdering {
    fn next_chunk(bytes: &[u8], i: &mut usize) -> VersionChunk {
        let start = *i;
        let is_num = bytes[*i].is_ascii_digit();
        while *i < bytes.len() && bytes[*i].is_ascii_digit() == is_num {
            *i += 1;
        }
        let slice = std::str::from_utf8(&bytes[start..*i]).unwrap_or("");
        if is_num {
            VersionChunk::Numeric(slice.parse::<u64>().unwrap_or(0))
        } else {
            VersionChunk::Text(slice.to_ascii_lowercase())
        }
    }

    let ba = a.as_bytes();
    let bb = b.as_bytes();
    let (mut ia, mut ib) = (0usize, 0usize);
    while ia < ba.len() && ib < bb.len() {
        let ca = next_chunk(ba, &mut ia);
        let cb = next_chunk(bb, &mut ib);
        let ord = match (ca, cb) {
            (VersionChunk::Numeric(na), VersionChunk::Numeric(nb)) => nb.cmp(&na),
            (VersionChunk::Text(ta), VersionChunk::Text(tb)) => tb.cmp(&ta),
            (VersionChunk::Numeric(_), VersionChunk::Text(_)) => CmpOrdering::Less,
            (VersionChunk::Text(_), VersionChunk::Numeric(_)) => CmpOrdering::Greater,
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
            models.sort_by_key(|m| m.is_snapshot);
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
    let http_req = build_list_models_request(req)?;
    let config_stdin = build_curl_config_stdin(&http_req.url, &http_req.headers);

    let curl_bin = curl_binary();
    let write_out = status_write_out_arg();
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
        &write_out,
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
    fn list_models_request_builders_and_parsers_work() {
        let gem_req = build_list_models_request(&AiListModelsRequest {
            provider: "gemini".into(),
            api_key: "AIzaSecret".into(),
            base_url: "".into(),
        })
        .unwrap();
        assert_eq!(
            gem_req.url,
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100"
        );
        assert!(gem_req
            .headers
            .iter()
            .any(|(k, v)| k == "x-goog-api-key" && v == "AIzaSecret"));

        let ollama_req = build_list_models_request(&AiListModelsRequest {
            provider: "ollama".into(),
            api_key: "".into(),
            base_url: "http://localhost:11434/v1/chat/completions".into(),
        })
        .unwrap();
        assert_eq!(ollama_req.url, "http://localhost:11434/api/tags");

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
}
