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
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pinned_skills: Vec<String>,
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

fn summary_from_session(session: &AiChatSession) -> AiChatSummary {
    AiChatSummary {
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
    }
}

fn rebuild_chat_index_from_files(dir: &Path) -> Vec<AiChatSummary> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(fname) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if fname == "index.json" || !fname.ends_with(".json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(session) = serde_json::from_str::<AiChatSession>(&raw) {
            if validate_chat_id(&session.id).is_ok() {
                list.push(summary_from_session(&session));
            }
        }
    }
    sort_chat_summaries(&mut list);
    list
}

pub fn list_chats_in(dir: &Path) -> Vec<AiChatSummary> {
    let index_path = dir.join("index.json");
    if let Ok(raw) = fs::read_to_string(&index_path) {
        if let Ok(mut list) = serde_json::from_str::<Vec<AiChatSummary>>(&raw) {
            sort_chat_summaries(&mut list);
            return list;
        }
    }

    let rebuilt = rebuild_chat_index_from_files(dir);
    if index_path.exists() || !rebuilt.is_empty() {
        let _ = save_chat_index_in(dir, &rebuilt);
    }
    rebuilt
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
    crate::fs_util::write_atomic(&dir.join("index.json"), json.as_bytes())
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
    crate::fs_util::write_atomic(&file_path, json.as_bytes())
        .map_err(|e| format!("Failed to write chat {}: {e}", session.id))?;

    let summary = summary_from_session(session);

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
        fs::remove_file(&file_path).map_err(|e| format!("Failed to delete chat {chat_id}: {e}"))?;
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
            pinned_skills: vec!["vault:lore-check".into()],
            messages: vec![StoredChatMessage {
                id: "u-1".into(),
                role: "user".into(),
                content: "hello".into(),
                created_at: 100,
                error: None,
                proposal_states: HashMap::new(),
                source_file: None,
                finish_reason: None,
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
            pinned_skills: Vec::new(),
            messages: vec![],
        };

        save_chat_in(&dir, &c1).unwrap();
        let list = save_chat_in(&dir, &c2).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "chat-2");
        assert_eq!(list[1].id, "chat-1");

        // Pin & rename older chat -> moves to top
        let updated =
            update_chat_meta_in(&dir, "chat-1", Some("Pinned Topic".into()), Some(true)).unwrap();
        assert_eq!(updated[0].id, "chat-1");
        assert_eq!(updated[0].title, "Pinned Topic");
        assert!(updated[0].pinned);

        let loaded = load_chat_in(&dir, "chat-1").unwrap();
        assert_eq!(loaded.title, "Pinned Topic");
        assert_eq!(loaded.pinned_skills, vec!["vault:lore-check".to_string()]);
        assert_eq!(loaded.messages.len(), 1);

        let after_del = delete_chat_in(&dir, "chat-1").unwrap();
        assert_eq!(after_del.len(), 1);
        assert_eq!(after_del[0].id, "chat-2");
        assert!(load_chat_in(&dir, "chat-1").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stored_chat_message_backward_compat_and_round_trip() {
        let legacy_json = r#"{
            "id": "a-1",
            "role": "assistant",
            "content": "Done",
            "created_at": 123,
            "proposal_states": {"0": "accepted"}
        }"#;
        let parsed: StoredChatMessage = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(parsed.id, "a-1");
        assert_eq!(parsed.source_file, None);
        assert_eq!(parsed.finish_reason, None);

        let modern = StoredChatMessage {
            id: "a-2".into(),
            role: "assistant".into(),
            content: "Partial".into(),
            created_at: 456,
            error: None,
            proposal_states: HashMap::new(),
            source_file: Some("notes/plan.md".into()),
            finish_reason: Some("length".into()),
        };
        let encoded = serde_json::to_string(&modern).unwrap();
        let round_trip: StoredChatMessage = serde_json::from_str(&encoded).unwrap();
        assert_eq!(round_trip, modern);
    }

    #[test]
    fn chat_session_pinned_skills_backward_compat_and_round_trip() {
        let legacy_session_json = r#"{
            "id": "chat-legacy",
            "title": "Old Session",
            "vault_path": "C:/notes",
            "vault_name": "notes",
            "pinned": false,
            "created_at": 100,
            "updated_at": 200,
            "messages": []
        }"#;
        let parsed: AiChatSession = serde_json::from_str(legacy_session_json).unwrap();
        assert!(parsed.pinned_skills.is_empty());

        let modern = AiChatSession {
            id: "chat-skills".into(),
            title: "With Skills".into(),
            vault_path: "C:/notes".into(),
            vault_name: "notes".into(),
            pinned: true,
            created_at: 100,
            updated_at: 300,
            pinned_skills: vec!["vault:world-lore".into(), "global:editor-pass".into()],
            messages: vec![],
        };
        let encoded = serde_json::to_string(&modern).unwrap();
        let round_trip: AiChatSession = serde_json::from_str(&encoded).unwrap();
        assert_eq!(round_trip, modern);
    }

    #[test]
    fn corrupt_index_heals_from_existing_chat_files() {
        let dir = std::env::temp_dir().join(format!(
            "skillweaver_chats_heal_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        let session = AiChatSession {
            id: "chat-recovered".into(),
            title: "Recovered Story Chat".into(),
            vault_path: "C:/vault".into(),
            vault_name: "vault".into(),
            pinned: true,
            created_at: 10,
            updated_at: 20,
            pinned_skills: Vec::new(),
            messages: vec![],
        };
        save_chat_in(&dir, &session).unwrap();
        fs::write(dir.join("index.json"), "{corrupt json").unwrap();

        let listed = list_chats_in(&dir);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "chat-recovered");
        assert_eq!(listed[0].title, "Recovered Story Chat");

        // Index file on disk should also have been repaired cleanly.
        let repaired_raw = fs::read_to_string(dir.join("index.json")).unwrap();
        let parsed: Vec<AiChatSummary> = serde_json::from_str(&repaired_raw).unwrap();
        assert_eq!(parsed.len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }
}
