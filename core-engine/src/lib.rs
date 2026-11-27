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

//! Core engine library for the Skillweaver desktop application and MCP server.

pub mod ai;
pub mod base64;
mod commands;
pub mod error;
pub mod fs_util;
pub mod markdown;
pub mod mcp;
pub mod prefs;
pub mod terminal;
pub mod vault;
pub mod watcher;

use commands::AppState;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let saved = prefs::load_prefs();
            if saved.zoom_percent != prefs::ZOOM_DEFAULT_PERCENT {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_zoom((saved.zoom_percent as f64) / 100.0);
                }
            }
            Ok(())
        })
        .manage(AppState {
            vault_root: Mutex::new(None),
        })
        .manage(terminal::TerminalState::default())
        .manage(ai::AiState::default())
        .manage(watcher::VaultWatcherState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_startup_state,
            commands::pick_folder,
            commands::open_folder,
            commands::refresh_vault,
            commands::open_note,
            commands::check_note_on_disk,
            commands::save_note_blocks,
            commands::save_note_raw,
            commands::parse_raw_markdown,
            commands::serialize_blocks_to_md,
            commands::create_note,
            commands::create_folder,
            commands::rename_entry,
            commands::delete_entry,
            commands::resolve_link,
            commands::save_ui_prefs,
            commands::set_window_zoom,
            commands::save_pasted_image,
            commands::read_image_data_url,
            commands::terminal_start,
            commands::terminal_run,
            commands::terminal_interrupt,
            commands::terminal_set_cwd,
            commands::terminal_complete_path,
            commands::get_ai_prefs,
            commands::save_ai_prefs,
            commands::ai_chat_stream,
            commands::ai_cancel_stream,
            commands::ai_list_models,
            commands::get_cached_models,
            commands::ai_list_chats,
            commands::ai_load_chat,
            commands::ai_save_chat,
            commands::ai_update_chat_meta,
            commands::ai_delete_chat,
            commands::ai_list_skills,
            commands::ai_save_skill,
            commands::ai_delete_skill,
            commands::search_vault,
            commands::resolve_block_reference,
            commands::get_vault_graph,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Skillweaver");
}
