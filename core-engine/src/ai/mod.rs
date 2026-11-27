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

//! AI provider configuration, model discovery, chat persistence, skills, and streaming.

mod chats;
mod http;
mod models;
mod prefs;
mod skills;
mod stream;

pub use chats::{
    chats_dir, delete_chat, delete_chat_in, list_chats, list_chats_in, load_chat, load_chat_in,
    save_chat, save_chat_in, update_chat_meta, update_chat_meta_in, AiChatSession, AiChatSummary,
    StoredChatMessage,
};
pub use http::extract_http_error_message;
pub use models::{
    build_list_models_request, canonical_cache_key, list_models, load_models_cache,
    load_models_cache_from, models_cache_path, parse_models_response, save_models_cache_to,
    AiListModelsRequest, AiModelInfo, CachedModelList, ListModelsHttpRequest, ModelsCache,
};
pub use prefs::{
    ai_prefs_path, load_ai_prefs, load_ai_prefs_from, save_ai_prefs, save_ai_prefs_to, AiPrefs,
};
pub use skills::{
    delete_skill, delete_skill_in, format_skill_markdown, global_skills_dir, list_skills,
    list_skills_in, parse_skill_markdown, sanitize_skill_slug, save_skill, save_skill_in,
    ParsedSkillMarkdown, SaveSkillRequest, SkillEntry,
};
pub use stream::{
    build_provider_http_request, cancel_stream, parse_sse_delta, parse_sse_finish_reason,
    start_chat_stream, AiChatMessage, AiChatRequest, AiState, AiStreamEvent, ProviderHttpRequest,
};
