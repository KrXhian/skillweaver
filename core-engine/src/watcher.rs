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
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

const DEBOUNCE_WINDOW: Duration = Duration::from_millis(200);
const SELF_WRITE_HASH_WINDOW: Duration = Duration::from_millis(1500);
const SELF_WRITE_STRUCTURAL_WINDOW: Duration = Duration::from_millis(900);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct VaultFsChangeItem {
    pub rel_path: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultFsChangedEvent {
    pub changes: Vec<VaultFsChangeItem>,
    pub tree_changed: bool,
}

/// Categorizes an internal Skillweaver write or deletion for self-write suppression.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelfWriteKind {
    ContentHash(String),
    StructuralCreateOrUpdate,
    Delete,
}

#[derive(Debug, Clone)]
struct SuppressedWrite {
    at: Instant,
    kind: SelfWriteKind,
}

#[derive(Default)]
struct WatcherInner {
    active_root: Option<PathBuf>,
    _debouncer: Option<Debouncer<RecommendedWatcher>>,
    suppressed: Arc<Mutex<HashMap<String, SuppressedWrite>>>,
    known_md_files: Arc<Mutex<HashMap<String, String>>>,
    known_dirs: Arc<Mutex<HashSet<String>>>,
}

/// Managed Tauri state owning the recursive vault filesystem watcher and self-write suppression map.
#[derive(Default)]
pub struct VaultWatcherState {
    inner: Mutex<WatcherInner>,
}

fn norm_lower_key(rel: &str) -> String {
    rel.replace('\\', "/")
        .trim_matches('/')
        .to_ascii_lowercase()
}

/// Returns true for paths ignored by the vault watcher (hidden/dot entries, `node_modules`, `target`, `assets`).
pub fn should_ignore_rel_path(rel: &str) -> bool {
    let trimmed = rel.trim_matches('/');
    if trimmed.is_empty() {
        return true;
    }
    for seg in trimmed.split('/') {
        if seg.is_empty()
            || seg.starts_with('.')
            || seg.eq_ignore_ascii_case("node_modules")
            || seg.eq_ignore_ascii_case("target")
            || seg.eq_ignore_ascii_case("assets")
        {
            return true;
        }
    }
    false
}

/// Converts an OS path from `notify` into a normalized `/`-separated vault-relative path.
/// Strips Windows `\\?\` prefixes on both paths and matches prefixes case-insensitively on Windows.
pub fn to_vault_rel_path(root: &Path, event_path: &Path) -> Option<String> {
    let root_norm = vault::display_path_string(root)
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let event_norm = vault::display_path_string(event_path)
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();

    if root_norm.is_empty() || event_norm.len() <= root_norm.len() {
        return None;
    }
    if !event_norm.is_char_boundary(root_norm.len()) {
        return None;
    }

    let prefix_matches = {
        #[cfg(windows)]
        {
            event_norm[..root_norm.len()].eq_ignore_ascii_case(&root_norm)
        }
        #[cfg(not(windows))]
        {
            event_norm[..root_norm.len()] == root_norm
        }
    };

    if !prefix_matches || event_norm.as_bytes().get(root_norm.len()) != Some(&b'/') {
        return None;
    }

    let rel = &event_norm[root_norm.len() + 1..];
    if rel.is_empty() {
        None
    } else {
        Some(rel.to_string())
    }
}

fn is_self_write_suppressed(
    suppressed: &mut HashMap<String, SuppressedWrite>,
    rel_lower: &str,
    disk_hash: Option<&str>,
    is_missing_on_disk: bool,
) -> bool {
    suppressed.retain(|_, v| v.at.elapsed() <= SELF_WRITE_HASH_WINDOW);

    let Some(entry) = suppressed.get(rel_lower).cloned() else {
        return false;
    };

    match &entry.kind {
        SelfWriteKind::ContentHash(expected_hash) => {
            if !is_missing_on_disk && disk_hash == Some(expected_hash.as_str()) {
                return true;
            }
            // Disk state diverges from what Skillweaver wrote -> external edit happened after our write.
            suppressed.remove(rel_lower);
            false
        }
        SelfWriteKind::StructuralCreateOrUpdate => {
            entry.at.elapsed() <= SELF_WRITE_STRUCTURAL_WINDOW
        }
        SelfWriteKind::Delete => {
            entry.at.elapsed() <= SELF_WRITE_STRUCTURAL_WINDOW && is_missing_on_disk
        }
    }
}

fn read_file_with_retry(path: &Path) -> Option<String> {
    if let Ok(content) = fs::read_to_string(path) {
        return Some(content);
    }
    std::thread::sleep(Duration::from_millis(25));
    fs::read_to_string(path).ok()
}

fn collect_known_pages(root: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(pages) = vault::list_pages(root) {
        for p in pages {
            map.insert(norm_lower_key(&p.rel_path), p.rel_path);
        }
    }
    map
}

fn collect_known_dirs(root: &Path) -> HashSet<String> {
    let mut dirs_set = HashSet::new();
    let Ok(canon_root) = fs::canonicalize(root) else {
        return dirs_set;
    };
    let walker = WalkDir::new(&canon_root).follow_links(false).into_iter();
    for entry in walker.flatten() {
        if entry.depth() == 0 || !entry.file_type().is_dir() {
            continue;
        }
        if let Some(rel) = to_vault_rel_path(&canon_root, entry.path()) {
            if !should_ignore_rel_path(&rel) {
                dirs_set.insert(norm_lower_key(&rel));
            }
        }
    }
    dirs_set
}

fn push_dedup_change(
    changes: &mut Vec<VaultFsChangeItem>,
    index_by_key: &mut HashMap<String, usize>,
    rel_path: String,
    kind: &str,
) {
    let key = norm_lower_key(&rel_path);
    if let Some(&idx) = index_by_key.get(&key) {
        let existing = &mut changes[idx];
        match (existing.kind.as_str(), kind) {
            ("create", "modify") => {}
            ("remove", "create") => {
                existing.kind = "modify".to_string();
                existing.rel_path = rel_path;
            }
            _ => {
                existing.kind = kind.to_string();
                existing.rel_path = rel_path;
            }
        }
    } else {
        index_by_key.insert(key, changes.len());
        changes.push(VaultFsChangeItem {
            rel_path,
            kind: kind.to_string(),
        });
    }
}

fn process_debounced_events(
    canon_root: &Path,
    events: Vec<DebouncedEvent>,
    suppressed: &Arc<Mutex<HashMap<String, SuppressedWrite>>>,
    known_md_files: &Arc<Mutex<HashMap<String, String>>>,
    known_dirs: &Arc<Mutex<HashSet<String>>>,
) -> Option<VaultFsChangedEvent> {
    let mut unique_rels = Vec::new();
    let mut seen_rels = HashSet::new();

    for ev in events {
        let Some(rel) = to_vault_rel_path(canon_root, &ev.path) else {
            continue;
        };
        if should_ignore_rel_path(&rel) {
            continue;
        }
        let key = norm_lower_key(&rel);
        if seen_rels.insert(key) {
            unique_rels.push(rel);
        }
    }

    if unique_rels.is_empty() {
        return None;
    }

    let mut changes: Vec<VaultFsChangeItem> = Vec::new();
    let mut index_by_key: HashMap<String, usize> = HashMap::new();
    let mut tree_changed = false;
    let mut saw_dir_event = false;

    for rel in unique_rels {
        let rel_lower = norm_lower_key(&rel);
        let full = canon_root.join(&rel);

        if rel_lower.ends_with(".md") && !full.is_dir() {
            if full.is_file() {
                let disk_hash = read_file_with_retry(&full).map(|c| vault::content_hash(&c));
                let suppressed_hit = suppressed
                    .lock()
                    .map(|mut s| {
                        is_self_write_suppressed(&mut s, &rel_lower, disk_hash.as_deref(), false)
                    })
                    .unwrap_or(false);

                let mut known_guard = known_md_files.lock().ok();
                if suppressed_hit {
                    if let Some(ref mut map) = known_guard {
                        map.entry(rel_lower).or_insert(rel);
                    }
                    continue;
                }

                let already_known = known_guard
                    .as_ref()
                    .map(|map| map.contains_key(&rel_lower))
                    .unwrap_or(false);
                if already_known {
                    push_dedup_change(&mut changes, &mut index_by_key, rel, "modify");
                } else {
                    if let Some(ref mut map) = known_guard {
                        map.insert(rel_lower, rel.clone());
                    }
                    tree_changed = true;
                    push_dedup_change(&mut changes, &mut index_by_key, rel, "create");
                }
            } else {
                let suppressed_hit = suppressed
                    .lock()
                    .map(|mut s| is_self_write_suppressed(&mut s, &rel_lower, None, true))
                    .unwrap_or(false);

                let removed_entry = known_md_files
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(&rel_lower));

                if suppressed_hit {
                    continue;
                }

                if removed_entry.is_some() {
                    tree_changed = true;
                    push_dedup_change(&mut changes, &mut index_by_key, rel, "remove");
                }
            }
        } else {
            let is_dir_now = full.is_dir();
            let was_known_dir = known_dirs
                .lock()
                .map(|d| d.contains(&rel_lower))
                .unwrap_or(false);
            let dir_prefix = format!("{rel_lower}/");
            let had_md_children = known_md_files
                .lock()
                .map(|m| m.keys().any(|k| k.starts_with(&dir_prefix)))
                .unwrap_or(false);

            if is_dir_now || was_known_dir || had_md_children {
                let suppressed_hit = suppressed
                    .lock()
                    .map(|mut s| is_self_write_suppressed(&mut s, &rel_lower, None, !is_dir_now))
                    .unwrap_or(false);
                if !suppressed_hit {
                    saw_dir_event = true;
                    tree_changed = true;
                }
            }
        }
    }

    if saw_dir_event {
        let fresh_pages = collect_known_pages(canon_root);
        let fresh_dirs = collect_known_dirs(canon_root);

        if let Ok(mut known_guard) = known_md_files.lock() {
            let old_pages = std::mem::replace(&mut *known_guard, fresh_pages.clone());
            for (old_key, old_rel) in &old_pages {
                if !fresh_pages.contains_key(old_key) {
                    let suppressed_hit = suppressed
                        .lock()
                        .map(|mut s| is_self_write_suppressed(&mut s, old_key, None, true))
                        .unwrap_or(false);
                    if !suppressed_hit {
                        push_dedup_change(
                            &mut changes,
                            &mut index_by_key,
                            old_rel.clone(),
                            "remove",
                        );
                    }
                }
            }
            for (new_key, new_rel) in &fresh_pages {
                if !old_pages.contains_key(new_key) {
                    let suppressed_hit = suppressed
                        .lock()
                        .map(|mut s| is_self_write_suppressed(&mut s, new_key, None, false))
                        .unwrap_or(false);
                    if !suppressed_hit {
                        push_dedup_change(
                            &mut changes,
                            &mut index_by_key,
                            new_rel.clone(),
                            "create",
                        );
                    }
                }
            }
        }

        if let Ok(mut dirs_guard) = known_dirs.lock() {
            *dirs_guard = fresh_dirs;
        }
    }

    if changes.is_empty() && !tree_changed {
        return None;
    }

    Some(VaultFsChangedEvent {
        changes,
        tree_changed,
    })
}

impl VaultWatcherState {
    /// Starts (or switches) recursive watching on `root`, emitting `vault:fs-changed` events.
    pub fn watch_folder(&self, app: &AppHandle, root: &Path) -> Result<(), String> {
        let canon_root = fs::canonicalize(root).map_err(|e| {
            format!(
                "Failed to canonicalize watched folder {}: {e}",
                root.display()
            )
        })?;

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Vault watcher lock poisoned".to_string())?;

        if guard.active_root.as_ref() == Some(&canon_root) && guard._debouncer.is_some() {
            return Ok(());
        }

        // Drop any previous debouncer before initializing the new watcher.
        guard._debouncer = None;
        guard.active_root = Some(canon_root.clone());

        if let Ok(mut s) = guard.suppressed.lock() {
            s.clear();
        }
        if let Ok(mut m) = guard.known_md_files.lock() {
            *m = collect_known_pages(&canon_root);
        }
        if let Ok(mut d) = guard.known_dirs.lock() {
            *d = collect_known_dirs(&canon_root);
        }

        let app_handle = app.clone();
        let watch_root = canon_root.clone();
        let suppressed = Arc::clone(&guard.suppressed);
        let known_md = Arc::clone(&guard.known_md_files);
        let known_dirs = Arc::clone(&guard.known_dirs);

        let mut debouncer = new_debouncer(DEBOUNCE_WINDOW, move |res: DebounceEventResult| {
            let Ok(events) = res else {
                return;
            };
            if let Some(payload) =
                process_debounced_events(&watch_root, events, &suppressed, &known_md, &known_dirs)
            {
                let _ = app_handle.emit("vault:fs-changed", payload);
            }
        })
        .map_err(|e| format!("Failed to initialize vault watcher: {e}"))?;

        debouncer
            .watcher()
            .watch(&canon_root, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch folder {}: {e}", canon_root.display()))?;

        guard._debouncer = Some(debouncer);
        Ok(())
    }

    /// Records an internal Skillweaver write/delete so the watcher suppresses self-triggered events.
    pub fn record_self_write(&self, rel_path: &str, kind: SelfWriteKind) {
        let Ok(guard) = self.inner.lock() else {
            return;
        };
        let normalized = rel_path.replace('\\', "/").trim_matches('/').to_string();
        let key = normalized.to_ascii_lowercase();
        if key.is_empty() {
            return;
        }

        let is_delete = matches!(kind, SelfWriteKind::Delete);
        if let Ok(mut suppressed) = guard.suppressed.lock() {
            suppressed.insert(
                key.clone(),
                SuppressedWrite {
                    at: Instant::now(),
                    kind,
                },
            );
        }

        if key.ends_with(".md") {
            if let Ok(mut known) = guard.known_md_files.lock() {
                if is_delete {
                    known.remove(&key);
                } else {
                    known.insert(key, normalized);
                }
            }
        }
    }

    /// Refreshes the watcher's known markdown/directory snapshot after structural UI operations.
    pub fn sync_known_vault(&self, root: &Path) {
        let Ok(guard) = self.inner.lock() else {
            return;
        };
        let Ok(canon_root) = fs::canonicalize(root) else {
            return;
        };
        if let Ok(mut m) = guard.known_md_files.lock() {
            *m = collect_known_pages(&canon_root);
        }
        if let Ok(mut d) = guard.known_dirs.lock() {
            *d = collect_known_dirs(&canon_root);
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::UNIX_EPOCH;

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("skillweaver_watcher_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn ignores_hidden_git_node_modules_target_and_assets() {
        assert!(should_ignore_rel_path(""));
        assert!(should_ignore_rel_path(".git/HEAD"));
        assert!(should_ignore_rel_path("sub/.obsidian/workspace.json"));
        assert!(should_ignore_rel_path("node_modules/pkg/readme.md"));
        assert!(should_ignore_rel_path("core-engine/target/debug/out.md"));
        assert!(should_ignore_rel_path("assets/pasted-1.png"));
        assert!(!should_ignore_rel_path("notes/architecture.md"));
        assert!(!should_ignore_rel_path("hero.md"));
    }

    #[test]
    fn to_vault_rel_path_handles_windows_extended_prefix_and_case() {
        #[cfg(windows)]
        {
            let root = Path::new(r"\\?\C:\Users\Alice\Vault");
            let ev1 = Path::new(r"c:\users\alice\vault\notes\spec.md");
            let ev2 = Path::new(r"\\?\C:\Users\Alice\Vault\hero.md");
            let outside = Path::new(r"C:\Users\Alice\Other\hero.md");

            assert_eq!(
                to_vault_rel_path(root, ev1).as_deref(),
                Some("notes/spec.md")
            );
            assert_eq!(to_vault_rel_path(root, ev2).as_deref(), Some("hero.md"));
            assert_eq!(to_vault_rel_path(root, root), None);
            assert_eq!(to_vault_rel_path(root, outside), None);
        }
        #[cfg(not(windows))]
        {
            let root = Path::new("/tmp/vault");
            let ev = Path::new("/tmp/vault/notes/spec.md");
            assert_eq!(
                to_vault_rel_path(root, ev).as_deref(),
                Some("notes/spec.md")
            );
        }
    }

    #[test]
    fn self_write_suppression_blocks_matching_hash_but_allows_different_external_hash() {
        let mut map = HashMap::new();
        let my_hash = vault::content_hash("my saved content");
        let ext_hash = vault::content_hash("external agent edit");

        map.insert(
            "notes/spec.md".to_string(),
            SuppressedWrite {
                at: Instant::now(),
                kind: SelfWriteKind::ContentHash(my_hash.clone()),
            },
        );

        assert!(is_self_write_suppressed(
            &mut map,
            "notes/spec.md",
            Some(&my_hash),
            false
        ));
        assert!(!is_self_write_suppressed(
            &mut map,
            "notes/spec.md",
            Some(&ext_hash),
            false
        ));
        assert!(!map.contains_key("notes/spec.md"));
    }

    #[test]
    fn debouncer_detects_real_create_modify_remove_in_temp_dir() {
        let root = temp_vault("integration");
        let (tx, rx) = mpsc::channel();
        let mut debouncer = new_debouncer(Duration::from_millis(80), tx).unwrap();
        debouncer
            .watcher()
            .watch(&root, RecursiveMode::Recursive)
            .unwrap();

        let suppressed = Arc::new(Mutex::new(HashMap::new()));
        let known_md = Arc::new(Mutex::new(collect_known_pages(&root)));
        let known_dirs = Arc::new(Mutex::new(collect_known_dirs(&root)));

        let note_path = root.join("agent-note.md");
        fs::write(&note_path, "# Created by agent\n").unwrap();

        let ev_create = loop {
            let res = rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
            if let Some(ev) =
                process_debounced_events(&root, res, &suppressed, &known_md, &known_dirs)
            {
                break ev;
            }
        };
        assert!(ev_create
            .changes
            .iter()
            .any(|c| c.rel_path == "agent-note.md" && c.kind == "create"));

        fs::write(&note_path, "# Modified by agent\n").unwrap();
        let ev_modify = loop {
            let res = rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
            if let Some(ev) =
                process_debounced_events(&root, res, &suppressed, &known_md, &known_dirs)
            {
                break ev;
            }
        };
        assert!(ev_modify
            .changes
            .iter()
            .any(|c| c.rel_path == "agent-note.md" && c.kind == "modify"));

        fs::remove_file(&note_path).unwrap();
        let ev_remove = loop {
            let res = rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
            if let Some(ev) =
                process_debounced_events(&root, res, &suppressed, &known_md, &known_dirs)
            {
                break ev;
            }
        };
        assert!(ev_remove
            .changes
            .iter()
            .any(|c| c.rel_path == "agent-note.md" && c.kind == "remove"));

        drop(debouncer);
        let _ = fs::remove_dir_all(&root);
    }
}
