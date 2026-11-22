use crate::ai::{self, AiChatRequest, AiPrefs, AiState};
use crate::markdown::{self, Block};
use crate::prefs::{self, UiPrefs};
use crate::terminal::{TerminalStartPayload, TerminalState};
use crate::vault::{self, BacklinkEntry, ResolvedBlockRef, VaultGraph, VaultSearchHit, VaultSnapshot};
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
}

#[derive(Debug, Serialize)]
pub struct SavePayload {
    pub raw_md: String,
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
    let blocks = markdown::parse_markdown(&raw_md);
    let backlinks = vault::find_backlinks(root, rel_path).unwrap_or_default();
    Ok(NotePayload {
        rel_path: rel_path.to_string(),
        title: note_title_from_rel(rel_path),
        raw_md,
        blocks,
        backlinks,
    })
}

fn open_folder_internal(
    state: &State<'_, AppState>,
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
    Ok(snapshot)
}

#[tauri::command]
pub fn get_startup_state(state: State<'_, AppState>) -> Result<StartupPayload, String> {
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
pub async fn pick_folder(state: State<'_, AppState>) -> Result<Option<VaultSnapshot>, String> {
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
        Some(folder) => Ok(Some(open_folder_internal(&state, &folder, None)?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn open_folder(
    state: State<'_, AppState>,
    folder_path: String,
) -> Result<VaultSnapshot, String> {
    open_folder_internal(&state, Path::new(&folder_path), None)
}

#[tauri::command]
pub fn refresh_vault(state: State<'_, AppState>) -> Result<VaultSnapshot, String> {
    let root = active_root(&state)?;
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
pub fn save_note_blocks(
    state: State<'_, AppState>,
    rel_path: String,
    blocks: Vec<Block>,
) -> Result<SavePayload, String> {
    let root = active_root(&state)?;
    let norm = vault::normalize_rel_path(&rel_path)?;
    let raw_md = markdown::serialize_markdown(&blocks);
    vault::write_note(&root, &norm, &raw_md)?;
    Ok(SavePayload { raw_md })
}

#[tauri::command]
pub fn save_note_raw(
    state: State<'_, AppState>,
    rel_path: String,
    raw_md: String,
) -> Result<NotePayload, String> {
    let root = active_root(&state)?;
    let norm = vault::normalize_rel_path(&rel_path)?;
    vault::write_note(&root, &norm, &raw_md)?;
    build_note_payload(&root, &norm, raw_md)
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
pub fn create_note(state: State<'_, AppState>, rel_path: String) -> Result<CreateResult, String> {
    let root = active_root(&state)?;
    let created = vault::create_note(&root, &rel_path)?;
    let snap = vault::snapshot_vault(&root, Some(&created))?;
    Ok(CreateResult {
        rel_path: created,
        vault: snap,
    })
}

#[tauri::command]
pub fn create_folder(
    state: State<'_, AppState>,
    rel_path: String,
) -> Result<VaultSnapshot, String> {
    let root = active_root(&state)?;
    vault::create_folder(&root, &rel_path)?;
    vault::snapshot_vault(&root, None)
}

#[tauri::command]
pub fn rename_entry(
    state: State<'_, AppState>,
    old_rel: String,
    new_rel: String,
) -> Result<RenameResult, String> {
    let root = active_root(&state)?;
    let new_norm = vault::rename_entry(&root, &old_rel, &new_rel)?;
    let snap = vault::snapshot_vault(&root, None)?;
    Ok(RenameResult {
        new_rel: new_norm,
        vault: snap,
    })
}

#[tauri::command]
pub fn delete_entry(state: State<'_, AppState>, rel_path: String) -> Result<VaultSnapshot, String> {
    let root = active_root(&state)?;
    vault::delete_entry(&root, &rel_path)?;
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

    prefs::save_prefs(&prefs)
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
