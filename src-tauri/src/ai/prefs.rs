use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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
}
