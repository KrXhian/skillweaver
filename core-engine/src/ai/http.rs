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

//! Shared HTTP (`curl`) configuration escaping and error extraction helpers.

use serde_json::Value;
use std::fmt::Write as _;

/// Marker appended via `curl -w` so response body and HTTP status stay separable.
pub(crate) const HTTP_STATUS_MARKER: &str = "__SW_HTTP_STATUS__:";

/// Returns the platform `curl` binary name.
pub(crate) fn curl_binary() -> &'static str {
    if cfg!(windows) {
        "curl.exe"
    } else {
        "curl"
    }
}

/// Returns the `-w` format argument appended to `curl` requests to emit HTTP status.
pub(crate) fn status_write_out_arg() -> String {
    format!("\n{HTTP_STATUS_MARKER}%{{http_code}}\n")
}

/// Escapes a value for use inside a `curl --config` double-quoted string.
pub(crate) fn escape_curl_config_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\r' | '\n' => out.push(' '),
            c if c.is_control() => {}
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// Builds the `--config -` stdin payload containing URL and request headers.
pub(crate) fn build_curl_config_stdin(url: &str, headers: &[(String, String)]) -> String {
    let mut config_stdin = String::with_capacity(64 + headers.len() * 48);
    let _ = writeln!(config_stdin, "url = {}", escape_curl_config_value(url));
    for (name, value) in headers {
        let header_line = format!("{name}: {value}");
        let _ = writeln!(
            config_stdin,
            "header = {}",
            escape_curl_config_value(&header_line)
        );
    }
    config_stdin
}

/// Extracts a readable error message from a provider JSON error body.
#[must_use]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curl_config_escapes_quotes_backslashes_and_newlines() {
        let cfg = build_curl_config_stdin(
            "https://example.com/v1\n/chat",
            &[("Authorization".to_string(), "Bearer a\"b\\c".to_string())],
        );
        assert!(cfg.contains("url = \"https://example.com/v1 /chat\"\n"));
        assert!(cfg.contains("header = \"Authorization: Bearer a\\\"b\\\\c\"\n"));
    }
}
