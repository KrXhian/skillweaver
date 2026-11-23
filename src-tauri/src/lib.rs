pub mod ai;
mod commands;
pub mod markdown;
pub mod prefs;
pub mod terminal;
pub mod vault;

use commands::AppState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            vault_root: Mutex::new(None),
        })
        .manage(terminal::TerminalState::default())
        .manage(ai::AiState::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_startup_state,
            commands::pick_folder,
            commands::open_folder,
            commands::refresh_vault,
            commands::open_note,
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
            commands::search_vault,
            commands::resolve_block_reference,
            commands::get_vault_graph,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Skillweaver");
}
