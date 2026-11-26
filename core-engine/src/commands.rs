use crate::ai::{
    self, AiChatRequest, AiChatSession, AiChatSummary, AiListModelsRequest, AiPrefs, AiState,
    CachedModelList, ModelsCache,
};
use crate::markdown::{self, Block};
use crate::prefs::{self, UiPrefs};
use crate::terminal::{TerminalStartPayload, TerminalState};
use crate::vault::{self, BacklinkEntry, ResolvedBlockRef, VaultGraph, VaultSearchHit, VaultSnapshot};
use crate::watcher::VaultWatcherState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, State};

/// Shared application state holding the currently opened vault folder.
pub struct AppState {
    pub vault_root: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Serialize)]
pub struct StartupPayload {
    pub prefs: UiPrefs,
    pub vault: Option<VaultSnapshot>,
}

#[derive(Debug, Serialize)]
pub struct NotePayload {
    pub rel_path: String,
    pub title: String,
    pub raw_md: String,
    pub blocks: Vec<Block>,
    pub backlinks: Vec<BacklinkEntry>,
    pub disk_hash: String,
    pub mtime_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct SavePayload {
    pub raw_md: String,
    pub disk_hash: String,
    pub mtime_ms: Option<u64>,
    pub conflict: bool,
    pub disk_deleted: bool,
    pub disk_md: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SaveRawPayload {
    pub rel_path: String,
    pub raw_md: String,
    pub backlinks: Vec<BacklinkEntry>,
    pub disk_hash: String,
    pub mtime_ms: Option<u64>,
    pub conflict: bool,
    pub disk_deleted: bool,
    pub disk_md: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DiskNoteState {
    pub exists: bool,
    pub rel_path: String,
    pub title: String,
    pub raw_md: Option<String>,
    pub blocks: Option<Vec<Block>>,
    pub backlinks: Vec<BacklinkEntry>,
    pub disk_hash: String,
    pub mtime_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct CreateResult {
    pub rel_path: String,
    pub vault: VaultSnapshot,
}

#[derive(Debug, Serialize)]
pub struct RenameResult {
    pub new_rel: String,
    pub vault: VaultSnapshot,
}

#[derive(Debug, Serialize)]
pub struct SavedImagePayload {
    pub src: String,
    pub data_url: String,
}

fn active_root(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    state
        .vault_root
        .lock()
        .map_err(|_| "App state lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "No folder is currently open".to_string())
}

fn note_title_from_rel(rel_path: &str) -> String {
    Path::new(rel_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| rel_path.to_string())
}

fn build_note_payload(root: &Path, rel_path: &str, raw_md: String) -> Result<NotePayload, String> {
    let disk_hash = vault::content_hash(&raw_md);
    let mtime_ms = vault::read_note_mtime_ms(root, rel_path);
    let blocks = markdown::parse_markdown(&raw_md);
    let backlinks = vault::find_backlinks(root, rel_path).unwrap_or_default();
    Ok(NotePayload {
        rel_path: rel_path.to_string(),
        title: note_title_from_rel(rel_path),
        raw_md,
        blocks,
        backlinks,
        disk_hash,
        mtime_ms,
    })
}

fn open_folder_internal(
    app: &AppHandle,
    state: &State<'_, AppState>,
    watcher: &State<'_, VaultWatcherState>,
    folder: &Path,
    remembered_file: Option<&str>,
) -> Result<VaultSnapshot, String> {
    if !folder.is_dir() {
        return Err(format!("Folder does not exist: {}", folder.display()));
    }
    let snapshot = vault::snapshot_vault(folder, remembered_file)?;
    {
        let mut guard = state
            .vault_root
            .lock()
            .map_err(|_| "App state lock poisoned".to_string())?;
        *guard = Some(PathBuf::from(&snapshot.root_path));
    }
    let mut ui_prefs = prefs::load_prefs();
    ui_prefs.last_folder = Some(snapshot.root_path.clone());
    if remembered_file.is_none() {
        ui_prefs.last_file = snapshot.initial_file.clone();
    }
    let _ = prefs::save_prefs(&ui_prefs);
    let _ = watcher.watch_folder(app, Path::new(&snapshot.root_path));
    Ok(snapshot)
}

#[tauri::command]
pub fn get_startup_state(
    app: AppHandle,
    state: State<'_, AppState>,
    watcher: State<'_, VaultWatcherState>,
) -> Result<StartupPayload, String> {
    let mut ui_prefs = prefs::load_prefs();
    let vault = if let Some(ref folder_str) = ui_prefs.last_folder {
        let folder = PathBuf::from(folder_str);
        if folder.is_dir() {
            let snap = vault::snapshot_vault(&folder, ui_prefs.last_file.as_deref())?;
            let mut guard = state
                .vault_root
                .lock()
                .map_err(|_| "App state lock poisoned".to_string())?;
            *guard = Some(PathBuf::from(&snap.root_path));
            if ui_prefs.last_folder.as_deref() != Some(snap.root_path.as_str()) {
                ui_prefs.last_folder = Some(snap.root_path.clone());
                let _ = prefs::save_prefs(&ui_prefs);
            }
            let _ = watcher.watch_folder(&app, Path::new(&snap.root_path));
            Some(snap)
        } else {
            ui_prefs.last_folder = None;
            ui_prefs.last_file = None;
            let _ = prefs::save_prefs(&ui_prefs);
            None
        }
    } else {
        None
    };

    Ok(StartupPayload {
        prefs: ui_prefs,
        vault,
    })
}

#[tauri::command]
pub async fn pick_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    watcher: State<'_, VaultWatcherState>,
) -> Result<Option<VaultSnapshot>, String> {
    let current = state
        .vault_root
        .lock()
        .ok()
        .and_then(|g| g.clone());

    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = rfd::FileDialog::new().set_title("Open Markdown Folder");
        if let Some(dir) = current {
            if dir.is_dir() {
                dialog = dialog.set_directory(dir);
            }
        }
        dialog.pick_folder()
    })
    .await
    .map_err(|e| format!("Folder dialog failed: {e}"))?;

    match picked {
        Some(folder) => Ok(Some(open_folder_internal(
            &app, &state, &watcher, &folder, None,
        )?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn open_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    watcher: State<'_, VaultWatcherState>,
    folder_path: String,
) -> Result<VaultSnapshot, String> {
    open_folder_internal(&app, &state, &watcher, Path::new(&folder_path), None)
}

#[tauri::command]
pub fn refresh_vault(
    state: State<'_, AppState>,
    watcher: State<'_, VaultWatcherState>,
) -> Result<VaultSnapshot, String> {
    let root = active_root(&state)?;
    watcher.sync_known_vault(&root);
    vault::snapshot_vault(&root, None)
}

#[tauri::command]
pub fn open_note(state: State<'_, AppState>, rel_path: String) -> Result<NotePayload, String> {
    let root = active_root(&state)?;
    let norm = vault::normalize_rel_path(&rel_path)?;
    let raw_md = vault::read_note(&root, &norm)?;

    let mut ui_prefs = prefs::load_prefs();
    ui_prefs.last_folder = Some(vault::display_path_string(&root));
    ui_prefs.last_file = Some(norm.clone());
    let _ = prefs::save_prefs(&ui_prefs);

    build_note_payload(&root, &norm, raw_md)
}

#[tauri::command]
pub fn check_note_on_disk(
    state: State<'_, AppState>,
    rel_path: String,
) -> Result<DiskNoteState, String> {
    let root = active_root(&state)?;
    let norm = vault::normalize_rel_path(&rel_path)?;
    let full = vault::resolve_vault_path(&root, &norm)?;
    if !full.is_file() {
        return Ok(DiskNoteState {
            exists: false,
            rel_path: norm.clone(),
            title: note_title_from_rel(&norm),
            raw_md: None,
            blocks: None,
            backlinks: Vec::new(),
            disk_hash: String::new(),
            mtime_ms: None,
        });
    }
    let raw_md = vault::read_note(&root, &norm)?;
    let disk_hash = vault::content_hash(&raw_md);
    let mtime_ms = vault::read_note_mtime_ms(&root, &norm);
    let blocks = markdown::parse_markdown(&raw_md);
    let backlinks = vault::find_backlinks(&root, &norm).unwrap_or_default();
    Ok(DiskNoteState {
        exists: true,
        rel_path: norm.clone(),
        title: note_title_from_rel(&norm),
        raw_md: Some(raw_md),
        blocks: Some(blocks),
        backlinks,
        disk_hash,
        mtime_ms,
    })
}

enum SaveConflictCheck {
    Proceed,
    DeletedOnDisk,
    ModifiedOnDisk {
        disk_md: String,
        disk_hash: String,
        mtime_ms: Option<u64>,
    },
}

fn check_disk_before_save(
    root: &Path,
    norm_rel: &str,
    expected_hash: Option<&str>,
    force: bool,
) -> Result<SaveConflictCheck, String> {
    if force {
        return Ok(SaveConflictCheck::Proceed);
    }
    let Some(expected) = expected_hash else {
        return Ok(SaveConflictCheck::Proceed);
    };
    let full = vault::resolve_vault_path(root, norm_rel)?;
    if !full.is_file() {
        return Ok(SaveConflictCheck::DeletedOnDisk);
    }
    let disk_md = vault::read_note(root, norm_rel)?;
    let disk_hash = vault::content_hash(&disk_md);
    if disk_hash != expected {
        let mtime_ms = vault::read_note_mtime_ms(root, norm_rel);
        return Ok(SaveConflictCheck::ModifiedOnDisk {
            disk_md,
            disk_hash,
            mtime_ms,
        });
    }
    Ok(SaveConflictCheck::Proceed)
}

#[tauri::command]
pub fn save_note_blocks(
    state: State<'_, AppState>,
    watcher: State<'_, VaultWatcherState>,
    rel_path: String,
    blocks: Vec<Block>,
    expected_hash: Option<String>,
    force: Option<bool>,
) -> Result<SavePayload, String> {
    let root = active_root(&state)?;
    let norm = vault::normalize_rel_path(&rel_path)?;
    let raw_md = markdown::serialize_markdown(&blocks);

    match check_disk_before_save(
        &root,
        &norm,
        expected_hash.as_deref(),
        force.unwrap_or(false),
    )? {
        SaveConflictCheck::Proceed => {}
        SaveConflictCheck::DeletedOnDisk => {
            return Ok(SavePayload {
                raw_md,
                disk_hash: String::new(),
                mtime_ms: None,
                conflict: true,
                disk_deleted: true,
                disk_md: None,
            });
        }
        SaveConflictCheck::ModifiedOnDisk {
            disk_md,
            disk_hash,
            mtime_ms,
        } => {
            return Ok(SavePayload {
                raw_md,
                disk_hash,
                mtime_ms,
                conflict: true,
                disk_deleted: false,
                disk_md: Some(disk_md),
            });
        }
    }

    let new_hash = vault::content_hash(&raw_md);
    watcher.record_self_write(&norm, Some(new_hash.clone()), false);
    vault::write_note(&root, &norm, &raw_md)?;
    watcher.record_self_write(&norm, Some(new_hash.clone()), false);
    let mtime_ms = vault::read_note_mtime_ms(&root, &norm);

    Ok(SavePayload {
        raw_md,
        disk_hash: new_hash,
        mtime_ms,
        conflict: false,
        disk_deleted: false,
        disk_md: None,
    })
}

#[tauri::command]
pub fn save_note_raw(
    state: State<'_, AppState>,
    watcher: State<'_, VaultWatcherState>,
    rel_path: String,
    raw_md: String,
    expected_hash: Option<String>,
    force: Option<bool>,
) -> Result<SaveRawPayload, String> {
    let root = active_root(&state)?;
    let norm = vault::normalize_rel_path(&rel_path)?;

    match check_disk_before_save(
        &root,
        &norm,
        expected_hash.as_deref(),
        force.unwrap_or(false),
    )? {
        SaveConflictCheck::Proceed => {}
        SaveConflictCheck::DeletedOnDisk => {
            return Ok(SaveRawPayload {
                rel_path: norm,
                raw_md,
                backlinks: Vec::new(),
                disk_hash: String::new(),
                mtime_ms: None,
                conflict: true,
                disk_deleted: true,
                disk_md: None,
            });
        }
        SaveConflictCheck::ModifiedOnDisk {
            disk_md,
            disk_hash,
            mtime_ms,
        } => {
            return Ok(SaveRawPayload {
                rel_path: norm,
                raw_md,
                backlinks: Vec::new(),
                disk_hash,
                mtime_ms,
                conflict: true,
                disk_deleted: false,
                disk_md: Some(disk_md),
            });
        }
    }

    let new_hash = vault::content_hash(&raw_md);
    watcher.record_self_write(&norm, Some(new_hash.clone()), false);
    vault::write_note(&root, &norm, &raw_md)?;
    watcher.record_self_write(&norm, Some(new_hash.clone()), false);
    let mtime_ms = vault::read_note_mtime_ms(&root, &norm);
    let backlinks = vault::find_backlinks(&root, &norm).unwrap_or_default();

    Ok(SaveRawPayload {
        rel_path: norm,
        raw_md,
        backlinks,
        disk_hash: new_hash,
        mtime_ms,
        conflict: false,
        disk_deleted: false,
        disk_md: None,
    })
}

#[tauri::command]
pub fn parse_raw_markdown(raw_md: String) -> Vec<Block> {
    markdown::parse_markdown(&raw_md)
}

#[tauri::command]
pub fn serialize_blocks_to_md(blocks: Vec<Block>) -> String {
    markdown::serialize_markdown(&blocks)
}

#[tauri::command]
pub fn create_note(
    state: State<'_, AppState>,
    watcher: State<'_, VaultWatcherState>,
    rel_path: String,
) -> Result<CreateResult, String> {
    let root = active_root(&state)?;
    let empty_hash = vault::content_hash("");
    let created = vault::create_note(&root, &rel_path)?;
    watcher.record_self_write(&created, Some(empty_hash), false);
    watcher.sync_known_vault(&root);
    let snap = vault::snapshot_vault(&root, Some(&created))?;
    Ok(CreateResult {
        rel_path: created,
        vault: snap,
    })
}

#[tauri::command]
pub fn create_folder(
    state: State<'_, AppState>,
    watcher: State<'_, VaultWatcherState>,
    rel_path: String,
) -> Result<VaultSnapshot, String> {
    let root = active_root(&state)?;
    let norm = vault::create_folder(&root, &rel_path)?;
    watcher.record_self_write(&norm, None, false);
    watcher.sync_known_vault(&root);
    vault::snapshot_vault(&root, None)
}

#[tauri::command]
pub fn rename_entry(
    state: State<'_, AppState>,
    watcher: State<'_, VaultWatcherState>,
    old_rel: String,
    new_rel: String,
) -> Result<RenameResult, String> {
    let root = active_root(&state)?;
    if let Ok(old_norm) = vault::normalize_rel_path(&old_rel) {
        watcher.record_self_write(&old_norm, None, true);
    }
    let (new_norm, rewritten) = vault::rename_entry_tracked(&root, &old_rel, &new_rel)?;
    watcher.record_self_write(&new_norm, None, false);
    for (rewritten_rel, rewritten_hash) in rewritten {
        watcher.record_self_write(&rewritten_rel, Some(rewritten_hash), false);
    }
    watcher.sync_known_vault(&root);
    let snap = vault::snapshot_vault(&root, None)?;
    Ok(RenameResult {
        new_rel: new_norm,
        vault: snap,
    })
}

#[tauri::command]
pub fn delete_entry(
    state: State<'_, AppState>,
    watcher: State<'_, VaultWatcherState>,
    rel_path: String,
) -> Result<VaultSnapshot, String> {
    let root = active_root(&state)?;
    if let Ok(norm) = vault::normalize_rel_path(&rel_path) {
        watcher.record_self_write(&norm, None, true);
    }
    vault::delete_entry(&root, &rel_path)?;
    watcher.sync_known_vault(&root);
    vault::snapshot_vault(&root, None)
}

#[tauri::command]
pub fn resolve_link(
    state: State<'_, AppState>,
    current_rel: Option<String>,
    target: String,
) -> Result<Option<String>, String> {
    let root = active_root(&state)?;
    vault::resolve_link(&root, current_rel.as_deref(), &target)
}

#[tauri::command]
pub fn save_ui_prefs(state: State<'_, AppState>, mut prefs: UiPrefs) -> Result<(), String> {
    prefs.last_folder = prefs
        .last_folder
        .map(|f| prefs::clean_folder_path(&f))
        .filter(|f| !f.is_empty());

    if prefs.last_folder.is_none() {
        if let Ok(guard) = state.vault_root.lock() {
            if let Some(root) = guard.as_ref() {
                prefs.last_folder = Some(vault::display_path_string(root));
            }
        }
    }
    if prefs.last_folder.is_none() {
        prefs.last_folder = prefs::load_prefs().last_folder;
    }
    prefs.zoom_percent = prefs::sanitize_zoom_percent(prefs.zoom_percent);

    prefs::save_prefs(&prefs)
}

#[tauri::command]
pub fn set_window_zoom(
    webview: tauri::WebviewWindow,
    zoom_percent: u32,
) -> Result<u32, String> {
    let clamped = prefs::sanitize_zoom_percent(zoom_percent);
    let factor = (clamped as f64) / 100.0;
    webview
        .set_zoom(factor)
        .map_err(|e| format!("Failed to set window zoom: {e}"))?;
    Ok(clamped)
}

#[tauri::command]
pub fn save_pasted_image(
    state: State<'_, AppState>,
    current_rel: Option<String>,
    data_url: String,
) -> Result<SavedImagePayload, String> {
    let root = active_root(&state)?;
    let (src, data_url) = vault::save_pasted_image(&root, current_rel.as_deref(), &data_url)?;
    Ok(SavedImagePayload { src, data_url })
}

#[tauri::command]
pub fn read_image_data_url(
    state: State<'_, AppState>,
    current_rel: Option<String>,
    src: String,
) -> Result<String, String> {
    let root = active_root(&state)?;
    vault::read_image_data_url(&root, current_rel.as_deref(), &src)
}

#[tauri::command]
pub fn terminal_start(
    app: AppHandle,
    app_state: State<'_, AppState>,
    term_state: State<'_, TerminalState>,
) -> Result<TerminalStartPayload, String> {
    let fallback = app_state.vault_root.lock().ok().and_then(|g| g.clone());
    term_state.ensure_started(&app, fallback.as_deref())
}

#[tauri::command]
pub fn terminal_run(
    app: AppHandle,
    app_state: State<'_, AppState>,
    term_state: State<'_, TerminalState>,
    input: String,
) -> Result<(), String> {
    let fallback = app_state.vault_root.lock().ok().and_then(|g| g.clone());
    term_state.run_input(&app, fallback.as_deref(), &input)
}

#[tauri::command]
pub fn terminal_interrupt(
    app: AppHandle,
    app_state: State<'_, AppState>,
    term_state: State<'_, TerminalState>,
) -> Result<TerminalStartPayload, String> {
    let fallback = app_state.vault_root.lock().ok().and_then(|g| g.clone());
    term_state.interrupt(&app, fallback.as_deref())
}

#[tauri::command]
pub fn terminal_set_cwd(
    app: AppHandle,
    term_state: State<'_, TerminalState>,
    folder_path: String,
) -> Result<Option<String>, String> {
    term_state.sync_cwd(&app, Path::new(&folder_path))
}

#[tauri::command]
pub fn terminal_complete_path(
    term_state: State<'_, TerminalState>,
    partial: String,
) -> Result<Vec<String>, String> {
    term_state.complete_path(&partial)
}

#[tauri::command]
pub fn get_ai_prefs() -> AiPrefs {
    ai::load_ai_prefs()
}

#[tauri::command]
pub fn save_ai_prefs(prefs: AiPrefs) -> Result<(), String> {
    ai::save_ai_prefs(&prefs)
}

#[tauri::command]
pub fn ai_chat_stream(
    app: AppHandle,
    ai_state: State<'_, AiState>,
    request: AiChatRequest,
) -> Result<(), String> {
    ai::start_chat_stream(app, &ai_state, request)
}

#[tauri::command]
pub fn ai_cancel_stream(ai_state: State<'_, AiState>) -> Result<(), String> {
    ai::cancel_stream(&ai_state);
    Ok(())
}

#[tauri::command]
pub fn get_cached_models() -> ModelsCache {
    ai::load_models_cache()
}

#[tauri::command]
pub async fn ai_list_models(request: AiListModelsRequest) -> Result<CachedModelList, String> {
    tauri::async_runtime::spawn_blocking(move || ai::list_models(&request))
        .await
        .map_err(|e| format!("Model list task failed: {e}"))?
}

#[tauri::command]
pub fn ai_list_chats() -> Vec<AiChatSummary> {
    ai::list_chats()
}

#[tauri::command]
pub fn ai_load_chat(chat_id: String) -> Result<AiChatSession, String> {
    ai::load_chat(&chat_id)
}

#[tauri::command]
pub fn ai_save_chat(session: AiChatSession) -> Result<Vec<AiChatSummary>, String> {
    ai::save_chat(&session)
}

#[tauri::command]
pub fn ai_update_chat_meta(
    chat_id: String,
    title: Option<String>,
    pinned: Option<bool>,
) -> Result<Vec<AiChatSummary>, String> {
    ai::update_chat_meta(&chat_id, title, pinned)
}

#[tauri::command]
pub fn ai_delete_chat(chat_id: String) -> Result<Vec<AiChatSummary>, String> {
    ai::delete_chat(&chat_id)
}

#[tauri::command]
pub fn search_vault(
    state: State<'_, AppState>,
    query: String,
    exclude_rel: Option<String>,
    max_files: Option<usize>,
) -> Result<Vec<VaultSearchHit>, String> {
    let root = active_root(&state)?;
    vault::search_vault(&root, &query, exclude_rel.as_deref(), max_files.unwrap_or(5))
}

#[tauri::command]
pub fn resolve_block_reference(
    state: State<'_, AppState>,
    current_rel: Option<String>,
    target_ref: String,
) -> Result<Option<ResolvedBlockRef>, String> {
    let root = active_root(&state)?;
    vault::resolve_block_reference(&root, current_rel.as_deref(), &target_ref)
}

#[tauri::command]
pub fn get_vault_graph(state: State<'_, AppState>) -> Result<VaultGraph, String> {
    let root = active_root(&state)?;
    vault::build_vault_graph(&root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("skillweaver_cmd_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn check_disk_before_save_detects_external_mod_and_deletion_unless_forced() {
        let root = temp_dir("conflict");
        vault::create_note(&root, "note").unwrap();
        vault::write_note(&root, "note.md", "initial").unwrap();
        let initial_hash = vault::content_hash("initial");

        assert!(matches!(
            check_disk_before_save(&root, "note.md", Some(&initial_hash), false).unwrap(),
            SaveConflictCheck::Proceed
        ));

        vault::write_note(&root, "note.md", "external edit").unwrap();
        match check_disk_before_save(&root, "note.md", Some(&initial_hash), false).unwrap() {
            SaveConflictCheck::ModifiedOnDisk {
                disk_md, disk_hash, ..
            } => {
                assert_eq!(disk_md, "external edit");
                assert_eq!(disk_hash, vault::content_hash("external edit"));
            }
            _ => panic!("expected ModifiedOnDisk conflict"),
        }

        assert!(matches!(
            check_disk_before_save(&root, "note.md", Some(&initial_hash), true).unwrap(),
            SaveConflictCheck::Proceed
        ));

        vault::delete_entry(&root, "note.md").unwrap();
        assert!(matches!(
            check_disk_before_save(&root, "note.md", Some(&initial_hash), false).unwrap(),
            SaveConflictCheck::DeletedOnDisk
        ));

        let _ = fs::remove_dir_all(&root);
    }
}
