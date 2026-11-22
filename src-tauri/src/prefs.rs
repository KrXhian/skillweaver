use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Persisted UI preferences stored at `%USERPROFILE%\.skillweaver\ui.prefs`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct UiPrefs {
    pub last_folder: Option<String>,
    pub last_file: Option<String>,
    pub theme: String,
    pub sidebar_width: u32,
    pub sidebar_collapsed: bool,
    pub terminal_height: u32,
    pub ai_panel_width: u32,
    pub collapsed_headings: HashMap<String, Vec<usize>>,
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            last_folder: None,
            last_file: None,
            theme: "dark".to_string(),
            sidebar_width: 240,
            sidebar_collapsed: false,
            terminal_height: 240,
            ai_panel_width: 340,
            collapsed_headings: HashMap::new(),
        }
    }
}

/// Strips Windows `\\?\` / `\\?\UNC\` extended-length path prefixes for clean storage.
pub fn clean_folder_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(unc) = trimmed.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(stripped) = trimmed.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Returns `%USERPROFILE%\.skillweaver\ui.prefs` (or `$HOME/.skillweaver/ui.prefs`).
pub fn prefs_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".skillweaver").join("ui.prefs"))
}

/// Loads preferences from a specific path, gracefully handling legacy plain-text or corrupt files.
pub fn load_prefs_from(path: &Path) -> UiPrefs {
    let raw = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return UiPrefs::default(),
    };

    if let Ok(mut prefs) = serde_json::from_str::<UiPrefs>(&raw) {
        if prefs.theme != "light" && prefs.theme != "dark" {
            prefs.theme = "dark".to_string();
        }
        prefs.sidebar_width = prefs.sidebar_width.clamp(160, 480);
        prefs.terminal_height = prefs.terminal_height.clamp(120, 600);
        prefs.ai_panel_width = prefs.ai_panel_width.clamp(260, 560);
        prefs.last_folder = prefs
            .last_folder
            .map(|f| clean_folder_path(&f))
            .filter(|f| !f.is_empty());
        return prefs;
    }

    // Legacy fallback: inspect non-empty lines for `folder=...` or an existing folder path.
    let mut prefs = UiPrefs::default();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let candidate = trimmed
            .strip_prefix("folder=")
            .or_else(|| trimmed.strip_prefix("last_folder="))
            .unwrap_or(trimmed)
            .trim_matches('"');
        let cleaned = clean_folder_path(candidate);
        if !cleaned.is_empty() && Path::new(&cleaned).is_dir() {
            prefs.last_folder = Some(cleaned);
            break;
        }
    }
    prefs
}

/// Loads preferences from the default user prefs path.
pub fn load_prefs() -> UiPrefs {
    match prefs_path() {
        Some(path) => load_prefs_from(&path),
        None => UiPrefs::default(),
    }
}

/// Saves preferences as pretty JSON to the given path, creating parent directories if needed.
pub fn save_prefs_to(path: &Path, prefs: &UiPrefs) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create prefs directory {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| format!("Failed to serialize prefs: {e}"))?;
    fs::write(path, json).map_err(|e| format!("Failed to write prefs {}: {e}", path.display()))
}

/// Saves preferences to the default user prefs path.
pub fn save_prefs(prefs: &UiPrefs) -> Result<(), String> {
    let path = prefs_path().ok_or_else(|| "Could not determine user home directory".to_string())?;
    save_prefs_to(&path, prefs)
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
        let dir = std::env::temp_dir().join(format!("skillweaver_prefs_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn round_trip_save_and_load() {
        let dir = temp_dir("rt");
        let path = dir.join(".skillweaver").join("ui.prefs");

        let mut collapsed = HashMap::new();
        collapsed.insert("C:/vault::hero.md".to_string(), vec![0, 3]);
        let prefs = UiPrefs {
            last_folder: Some("C:/vault".to_string()),
            last_file: Some("hero.md".to_string()),
            theme: "light".to_string(),
            sidebar_width: 280,
            sidebar_collapsed: true,
            terminal_height: 300,
            ai_panel_width: 360,
            collapsed_headings: collapsed,
        };

        save_prefs_to(&path, &prefs).unwrap();
        let loaded = load_prefs_from(&path);
        assert_eq!(loaded, prefs);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_plain_text_folder_fallback() {
        let dir = temp_dir("legacy");
        let vault_dir = dir.join("my_vault");
        fs::create_dir_all(&vault_dir).unwrap();
        let prefs_file = dir.join("ui.prefs");
        fs::write(&prefs_file, format!("folder={}\n", vault_dir.display())).unwrap();

        let loaded = load_prefs_from(&prefs_file);
        assert_eq!(
            loaded.last_folder.as_deref(),
            Some(vault_dir.to_string_lossy().as_ref())
        );
        assert_eq!(loaded.theme, "dark");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_prefs_returns_defaults() {
        let dir = temp_dir("corrupt");
        let prefs_file = dir.join("ui.prefs");
        fs::write(&prefs_file, "{not valid json!!!").unwrap();

        let loaded = load_prefs_from(&prefs_file);
        assert_eq!(loaded, UiPrefs::default());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_folder_path_strips_extended_windows_prefix() {
        assert_eq!(
            clean_folder_path(r"\\?\C:\Users\Krist\notes"),
            r"C:\Users\Krist\notes"
        );
        assert_eq!(
            clean_folder_path(r"\\?\UNC\server\share\notes"),
            r"\\server\share\notes"
        );

        let dir = temp_dir("extended");
        let prefs_file = dir.join("ui.prefs");
        fs::write(
            &prefs_file,
            r#"{"last_folder":"\\\\?\\C:\\Users\\Krist\\notes","theme":"light"}"#,
        )
        .unwrap();

        let loaded = load_prefs_from(&prefs_file);
        assert_eq!(loaded.last_folder.as_deref(), Some(r"C:\Users\Krist\notes"));
        assert_eq!(loaded.theme, "light");

        let _ = fs::remove_dir_all(&dir);
    }
}
