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

use crate::vault;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::Path;

const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

fn jsonrpc_result(id: &Value, result: &Value) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
    .unwrap_or_else(|_| {
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Serialization failure"}}"#
            .to_string()
    })
}

fn jsonrpc_error(id: &Value, code: i64, message: &str) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        }
    }))
    .unwrap_or_else(|_| {
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Serialization failure"}}"#
            .to_string()
    })
}

fn tool_ok_text(text: &str) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": text,
            }
        ],
        "isError": false,
    })
}

fn tool_ok_json(val: &Value) -> Value {
    let text = serde_json::to_string_pretty(val).unwrap_or_else(|_| val.to_string());
    tool_ok_text(&text)
}

fn tool_err_text(err: &str) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": err,
            }
        ],
        "isError": true,
    })
}

/// Validates that an MCP relative path avoids dot-entries, build folders, and non-Markdown files.
fn validate_mcp_rel_path(rel: &str, require_md_or_title: bool) -> Result<String, String> {
    let norm = vault::normalize_rel_path(rel)?;
    for seg in norm.split('/') {
        if seg.starts_with('.')
            || seg.eq_ignore_ascii_case("node_modules")
            || seg.eq_ignore_ascii_case("target")
        {
            return Err(format!("Access denied for protected path: {rel}"));
        }
    }
    if require_md_or_title {
        if let Some(ext) = Path::new(&norm).extension().and_then(|e| e.to_str()) {
            if !ext.eq_ignore_ascii_case("md") {
                return Err(format!("Only Markdown (.md) notes can be accessed: {rel}"));
            }
        }
    }
    Ok(norm)
}

fn tools_definitions() -> Value {
    json!([
        {
            "name": "list_notes",
            "description": "List all Markdown (.md) notes in the opened Skillweaver vault with their relative paths, titles, and wikilink targets.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        },
        {
            "name": "read_note",
            "description": "Read the raw Markdown contents of a note (and optionally its incoming backlinks). Accepts exact relative paths or wikilink targets.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "rel_path": {
                        "type": "string",
                        "description": "Relative path or note title/link target (e.g. '01 - Data/overview.md' or 'overview')."
                    },
                    "include_backlinks": {
                        "type": "boolean",
                        "description": "Include notes linking to this page (default true)."
                    }
                },
                "required": ["rel_path"],
                "additionalProperties": false
            }
        },
        {
            "name": "search_vault",
            "description": "Search across all notes in the Skillweaver vault by keyword/phrase, returning scored matches and context snippets.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query text."
                    },
                    "max_files": {
                        "type": "integer",
                        "description": "Maximum number of matching notes to return (1-20, default 8).",
                        "minimum": 1,
                        "maximum": 20
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            }
        },
        {
            "name": "resolve_block",
            "description": "Resolve a page reference, heading section ('page#Heading'), or block anchor ('page#^block-id') to its exact Markdown content.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target_ref": {
                        "type": "string",
                        "description": "Reference to resolve, e.g. 'notes/spec#^api-v2' or 'notes/spec#Architecture'."
                    },
                    "current_rel": {
                        "type": "string",
                        "description": "Optional current note relative path for resolving relative/same-page #anchors."
                    }
                },
                "required": ["target_ref"],
                "additionalProperties": false
            }
        },
        {
            "name": "get_vault_graph",
            "description": "Return the vault link graph including node kind ('note' | 'skill' | 'ghost'), skill_slug, folder, in_degree, out_degree, est_tokens, and edge citation weight so LLMs can inspect relationship strengths, hubs, and cluster token budgets in one call.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        },
        {
            "name": "create_note",
            "description": "Create a new Markdown note inside the vault (rejects overwrites and path traversal).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "rel_path": {
                        "type": "string",
                        "description": "Relative path for the new note ('.md' appended automatically if omitted)."
                    },
                    "content": {
                        "type": "string",
                        "description": "Optional initial Markdown content."
                    }
                },
                "required": ["rel_path"],
                "additionalProperties": false
            }
        },
        {
            "name": "append_to_note",
            "description": "Append Markdown content to the end of an existing note in the vault.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "rel_path": {
                        "type": "string",
                        "description": "Relative path of the existing note (e.g. 'notes/daily.md')."
                    },
                    "content": {
                        "type": "string",
                        "description": "Markdown text to append."
                    }
                },
                "required": ["rel_path", "content"],
                "additionalProperties": false
            }
        }
    ])
}

fn call_tool(vault_root: &Path, name: &str, args: &Value) -> Value {
    match name {
        "list_notes" => match vault::list_pages(vault_root) {
            Ok(pages) => tool_ok_json(&json!({ "notes": pages })),
            Err(e) => tool_err_text(&e),
        },
        "read_note" => {
            let Some(rel) = args.get("rel_path").and_then(Value::as_str) else {
                return tool_err_text("Missing required string argument: rel_path");
            };
            let include_backlinks = args
                .get("include_backlinks")
                .and_then(Value::as_bool)
                .unwrap_or(true);

            let norm = match validate_mcp_rel_path(rel, true) {
                Ok(n) => n,
                Err(e) => return tool_err_text(&e),
            };

            let resolved_rel = if norm.to_ascii_lowercase().ends_with(".md") {
                match vault::read_note(vault_root, &norm) {
                    Ok(_) => norm,
                    Err(err) if err.is_not_found() => {
                        match vault::resolve_link(vault_root, None, &norm) {
                            Ok(Some(found)) => found,
                            Ok(None) => return tool_err_text(&format!("Note not found: {rel}")),
                            Err(e) => return tool_err_text(&e),
                        }
                    }
                    Err(err) => return tool_err_text(&err.to_string()),
                }
            } else {
                match vault::resolve_link(vault_root, None, &norm) {
                    Ok(Some(found)) => found,
                    Ok(None) => return tool_err_text(&format!("Note not found: {rel}")),
                    Err(e) => return tool_err_text(&e),
                }
            };

            if let Err(e) = validate_mcp_rel_path(&resolved_rel, true) {
                return tool_err_text(&e);
            }

            let raw_md = match vault::read_note(vault_root, &resolved_rel) {
                Ok(content) => content,
                Err(e) => return tool_err_text(&e.to_string()),
            };
            let backlinks = if include_backlinks {
                vault::find_backlinks(vault_root, &resolved_rel).unwrap_or_default()
            } else {
                Vec::new()
            };
            tool_ok_json(&json!({
                "rel_path": resolved_rel,
                "content": raw_md,
                "backlinks": backlinks,
            }))
        }
        "search_vault" => {
            let Some(query) = args.get("query").and_then(Value::as_str) else {
                return tool_err_text("Missing required string argument: query");
            };
            let max_files = args
                .get("max_files")
                .and_then(Value::as_u64)
                .map(|n| n.clamp(1, 20) as usize)
                .unwrap_or(8);
            match vault::search_vault(vault_root, query, None, max_files) {
                Ok(hits) => tool_ok_json(&json!({ "hits": hits })),
                Err(e) => tool_err_text(&e),
            }
        }
        "resolve_block" => {
            let Some(target_ref) = args.get("target_ref").and_then(Value::as_str) else {
                return tool_err_text("Missing required string argument: target_ref");
            };
            let current_rel = args.get("current_rel").and_then(Value::as_str);
            match vault::resolve_block_reference(vault_root, current_rel, target_ref) {
                Ok(Some(resolved)) => tool_ok_json(&json!(resolved)),
                Ok(None) => tool_err_text(&format!("Reference not found: {target_ref}")),
                Err(e) => tool_err_text(&e),
            }
        }
        "get_vault_graph" => match vault::build_vault_graph(vault_root) {
            Ok(graph) => tool_ok_json(&json!(graph)),
            Err(e) => tool_err_text(&e),
        },
        "create_note" => {
            let Some(rel) = args.get("rel_path").and_then(Value::as_str) else {
                return tool_err_text("Missing required string argument: rel_path");
            };
            let norm = match validate_mcp_rel_path(rel, true) {
                Ok(n) => n,
                Err(e) => return tool_err_text(&e),
            };
            let content = args.get("content").and_then(Value::as_str).unwrap_or("");
            match vault::create_note(vault_root, &norm) {
                Ok(created) => {
                    if !content.is_empty() {
                        if let Err(e) = vault::write_note(vault_root, &created, content) {
                            return tool_err_text(&e);
                        }
                    }
                    tool_ok_json(&json!({
                        "created": created,
                        "bytes": content.len(),
                    }))
                }
                Err(e) => tool_err_text(&e),
            }
        }
        "append_to_note" => {
            let Some(rel) = args.get("rel_path").and_then(Value::as_str) else {
                return tool_err_text("Missing required string argument: rel_path");
            };
            let Some(addition) = args.get("content").and_then(Value::as_str) else {
                return tool_err_text("Missing required string argument: content");
            };
            let norm = match validate_mcp_rel_path(rel, true) {
                Ok(n) => n,
                Err(e) => return tool_err_text(&e),
            };
            if !norm.to_ascii_lowercase().ends_with(".md") {
                return tool_err_text(&format!(
                    "Only Markdown (.md) notes can be modified via MCP: {rel}"
                ));
            }
            let existing = match vault::read_note(vault_root, &norm) {
                Ok(txt) => txt,
                Err(e) => return tool_err_text(&e.to_string()),
            };
            let trimmed_addition = addition.trim_start_matches(['\r', '\n']);
            let next_content = if existing.trim().is_empty() {
                trimmed_addition.to_string()
            } else {
                format!(
                    "{}\n\n{}",
                    existing.trim_end_matches(['\r', '\n']),
                    trimmed_addition
                )
            };
            match vault::write_note(vault_root, &norm, &next_content) {
                Ok(()) => tool_ok_json(&json!({
                    "rel_path": norm,
                    "bytes": next_content.len(),
                })),
                Err(e) => tool_err_text(&e),
            }
        }
        _ => tool_err_text(&format!("Unknown tool: {name}")),
    }
}

/// Processes a single JSON-RPC 2.0 request/notification line for the Skillweaver MCP server.
/// Returns `None` for notifications or blank lines (which must not emit a response).
pub fn handle_jsonrpc_line(vault_root: &Path, line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let req: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            return Some(jsonrpc_error(
                &Value::Null,
                -32700,
                &format!("Parse error: {e}"),
            ))
        }
    };

    let Some(obj) = req.as_object() else {
        return Some(jsonrpc_error(
            &Value::Null,
            -32600,
            "Invalid Request: expected JSON object",
        ));
    };

    let method = obj.get("method").and_then(Value::as_str).unwrap_or("");
    let id = obj.get("id").cloned();

    // JSON-RPC notifications have no id and expect no reply.
    if id.is_none() || method.starts_with("notifications/") {
        return None;
    }
    let id = id.unwrap_or(Value::Null);

    if method.is_empty() {
        return Some(jsonrpc_error(
            &id,
            -32600,
            "Invalid Request: missing method",
        ));
    }

    let params = obj.get("params").cloned().unwrap_or_else(|| json!({}));

    let response = match method {
        "initialize" => {
            let client_ver = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .unwrap_or(MCP_PROTOCOL_VERSION);
            let proto = if client_ver == MCP_PROTOCOL_VERSION {
                client_ver
            } else {
                MCP_PROTOCOL_VERSION
            };
            jsonrpc_result(
                &id,
                &json!({
                    "protocolVersion": proto,
                    "capabilities": {
                        "tools": {
                            "listChanged": false
                        }
                    },
                    "serverInfo": {
                        "name": "skillweaver",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "instructions": "Skillweaver local-first Markdown vault MCP server. Read, search, resolve block anchors (#^block-id), inspect the wikilink graph, and create or append notes."
                }),
            )
        }
        "ping" => jsonrpc_result(&id, &json!({})),
        "tools/list" => jsonrpc_result(&id, &json!({ "tools": tools_definitions() })),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(jsonrpc_error(
                    &id,
                    -32602,
                    "Invalid params: missing tool name",
                ));
            };
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            jsonrpc_result(&id, &call_tool(vault_root, name, &args))
        }
        _ => jsonrpc_error(&id, -32601, &format!("Method not found: {method}")),
    };

    Some(response)
}

/// Runs the blocking newline-delimited MCP JSON-RPC 2.0 server over stdin/stdout.
pub fn run_stdio(vault_root: &Path) -> Result<(), String> {
    if !vault_root.is_dir() {
        return Err(format!(
            "Vault folder does not exist: {}",
            vault_root.display()
        ));
    }

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    for line_res in stdin.lock().lines() {
        let line = line_res.map_err(|e| format!("Failed reading stdin: {e}"))?;
        if let Some(reply) = handle_jsonrpc_line(vault_root, &line) {
            writeln!(out, "{reply}").map_err(|e| format!("Failed writing stdout: {e}"))?;
            out.flush()
                .map_err(|e| format!("Failed flushing stdout: {e}"))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("skillweaver_mcp_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mcp_initialize_ping_and_notifications() {
        let root = temp_vault("init");
        let init_req = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#;
        let resp: Value =
            serde_json::from_str(&handle_jsonrpc_line(&root, init_req).unwrap()).unwrap();
        assert_eq!(resp["id"], 1);
        assert_eq!(resp["result"]["serverInfo"]["name"], "skillweaver");
        assert_eq!(resp["result"]["protocolVersion"], MCP_PROTOCOL_VERSION);

        let notif = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        assert!(handle_jsonrpc_line(&root, notif).is_none());

        let ping = r#"{"jsonrpc":"2.0","id":"p1","method":"ping"}"#;
        let ping_resp: Value =
            serde_json::from_str(&handle_jsonrpc_line(&root, ping).unwrap()).unwrap();
        assert_eq!(ping_resp["id"], "p1");
        assert!(ping_resp["result"].is_object());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mcp_tools_list_exposes_all_seven_tools() {
        let root = temp_vault("list");
        let req = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#;
        let resp: Value = serde_json::from_str(&handle_jsonrpc_line(&root, req).unwrap()).unwrap();
        let names: Vec<&str> = resp["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "list_notes",
                "read_note",
                "search_vault",
                "resolve_block",
                "get_vault_graph",
                "create_note",
                "append_to_note"
            ]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mcp_tools_end_to_end_and_path_traversal_guard() {
        let root = temp_vault("e2e");

        let create_req = json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "create_note",
                "arguments": {
                    "rel_path": "notes/spec",
                    "content": "# Spec\n\nETL runs nightly. ^spec1\n\nSee [[hero]]."
                }
            }
        });
        let create_resp: Value =
            serde_json::from_str(&handle_jsonrpc_line(&root, &create_req.to_string()).unwrap())
                .unwrap();
        assert_eq!(create_resp["result"]["isError"], false);

        let append_req = json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "append_to_note",
                "arguments": {
                    "rel_path": "notes/spec.md",
                    "content": "- [x] Added monitoring"
                }
            }
        });
        let append_resp: Value =
            serde_json::from_str(&handle_jsonrpc_line(&root, &append_req.to_string()).unwrap())
                .unwrap();
        assert_eq!(append_resp["result"]["isError"], false);

        let read_req = json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {
                "name": "read_note",
                "arguments": { "rel_path": "spec" }
            }
        });
        let read_resp: Value =
            serde_json::from_str(&handle_jsonrpc_line(&root, &read_req.to_string()).unwrap())
                .unwrap();
        assert!(read_resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Added monitoring"));

        let resolve_req = json!({
            "jsonrpc": "2.0",
            "id": 13,
            "method": "tools/call",
            "params": {
                "name": "resolve_block",
                "arguments": { "target_ref": "notes/spec#^spec1" }
            }
        });
        let resolve_resp: Value =
            serde_json::from_str(&handle_jsonrpc_line(&root, &resolve_req.to_string()).unwrap())
                .unwrap();
        assert!(resolve_resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("ETL runs nightly."));

        let graph_req = json!({
            "jsonrpc": "2.0",
            "id": 14,
            "method": "tools/call",
            "params": { "name": "get_vault_graph", "arguments": {} }
        });
        let graph_resp: Value =
            serde_json::from_str(&handle_jsonrpc_line(&root, &graph_req.to_string()).unwrap())
                .unwrap();
        assert!(graph_resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("notes/spec.md"));

        let escape_req = json!({
            "jsonrpc": "2.0",
            "id": 15,
            "method": "tools/call",
            "params": {
                "name": "read_note",
                "arguments": { "rel_path": "../../etc/passwd" }
            }
        });
        let escape_resp: Value =
            serde_json::from_str(&handle_jsonrpc_line(&root, &escape_req.to_string()).unwrap())
                .unwrap();
        assert_eq!(escape_resp["result"]["isError"], true);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mcp_blocks_dot_files_git_and_non_markdown_paths() {
        let root = temp_vault("sec_guard");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("config"), "secret").unwrap();
        fs::write(root.join(".env"), "TOKEN=abc").unwrap();
        fs::write(root.join("secrets.json"), "{}").unwrap();

        for (tool, rel) in [
            ("read_note", ".git/config"),
            ("read_note", ".env"),
            ("read_note", "secrets.json"),
            ("create_note", ".env"),
            ("create_note", "sub/.hidden.md"),
            ("create_note", "config.json"),
            ("append_to_note", ".git/config"),
            ("append_to_note", "secrets.json"),
        ] {
            let req = json!({
                "jsonrpc": "2.0",
                "id": 99,
                "method": "tools/call",
                "params": {
                    "name": tool,
                    "arguments": {
                        "rel_path": rel,
                        "content": "ignored"
                    }
                }
            });
            let resp: Value =
                serde_json::from_str(&handle_jsonrpc_line(&root, &req.to_string()).unwrap())
                    .unwrap();
            assert_eq!(
                resp["result"]["isError"], true,
                "expected error for {tool}({rel})"
            );
        }

        let _ = fs::remove_dir_all(&root);
    }
}
