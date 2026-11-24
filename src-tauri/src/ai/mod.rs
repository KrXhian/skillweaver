use serde_json::Value;

mod chats;
mod models;
mod prefs;
mod stream;

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub(crate) const HTTP_STATUS_MARKER: &str = "__SW_HTTP_STATUS__:";

pub(crate) fn escape_curl_config_value(value: &str) -> String {
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

pub use chats::{
    chats_dir, delete_chat, delete_chat_in, list_chats, list_chats_in, load_chat, load_chat_in,
    save_chat, save_chat_in, update_chat_meta, update_chat_meta_in, AiChatSession, AiChatSummary,
    StoredChatMessage,
};
pub use models::{
    build_list_models_request, canonical_cache_key, list_models, load_models_cache,
    load_models_cache_from, models_cache_path, parse_models_response, save_models_cache_to,
    AiListModelsRequest, AiModelInfo, CachedModelList, ModelsCache,
};
pub use prefs::{
    ai_prefs_path, load_ai_prefs, load_ai_prefs_from, save_ai_prefs, save_ai_prefs_to, AiPrefs,
};
pub use stream::{
    build_provider_http_request, cancel_stream, parse_sse_delta, parse_sse_finish_reason,
    start_chat_stream, AiChatMessage, AiChatRequest, AiState, AiStreamEvent, ProviderHttpRequest,
};
