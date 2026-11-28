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

//! Shared native HTTP client helpers and provider error extraction.

use reqwest::header::{HeaderName, HeaderValue};
use reqwest::{Client, RequestBuilder};
use serde_json::Value;
use std::time::Duration;

/// Builds a configured `reqwest::Client` using OS-native TLS and system proxy settings.
pub(crate) fn build_http_client(
    connect_timeout: Duration,
    total_timeout: Duration,
) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(total_timeout)
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {e}"))
}

/// Validates and attaches HTTP headers to a `RequestBuilder`, rejecting invalid or injected lines.
pub(crate) fn apply_headers(
    mut builder: RequestBuilder,
    headers: &[(String, String)],
) -> Result<RequestBuilder, String> {
    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| format!("Invalid HTTP header name '{name}': {e}"))?;
        let header_value = HeaderValue::from_str(value)
            .map_err(|e| format!("Invalid HTTP header value for '{name}': {e}"))?;
        builder = builder.header(header_name, header_value);
    }
    Ok(builder)
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
    fn apply_headers_accepts_provider_headers_and_rejects_crlf_injection() {
        let client = build_http_client(Duration::from_secs(5), Duration::from_secs(10)).unwrap();
        let valid_headers = vec![
            (
                "Authorization".to_string(),
                "Bearer sk-test-123".to_string(),
            ),
            ("x-api-key".to_string(), "sk-ant-1".to_string()),
            ("x-goog-api-key".to_string(), "AIzaTest".to_string()),
        ];
        let req = apply_headers(client.get("https://example.com/v1/models"), &valid_headers)
            .unwrap()
            .build()
            .unwrap();
        assert_eq!(
            req.headers().get("authorization").unwrap(),
            "Bearer sk-test-123"
        );
        assert_eq!(req.headers().get("x-api-key").unwrap(), "sk-ant-1");
        assert_eq!(req.headers().get("x-goog-api-key").unwrap(), "AIzaTest");

        let injected_headers = vec![(
            "Authorization".to_string(),
            "Bearer abc\r\nX-Injected: evil".to_string(),
        )];
        assert!(apply_headers(
            client.get("https://example.com/v1/models"),
            &injected_headers
        )
        .is_err());
    }

    #[test]
    fn extract_http_error_message_reads_nested_and_top_level_json() {
        let nested = r#"{"error":{"message":"Quota exceeded"}}"#;
        assert_eq!(extract_http_error_message(nested), "Quota exceeded");

        let top = r#"{"message":"Unauthorized"}"#;
        assert_eq!(extract_http_error_message(top), "Unauthorized");

        assert_eq!(
            extract_http_error_message("   "),
            "Request failed with no response body"
        );
    }
}
