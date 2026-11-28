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

//! Per-folder properties, local note templates, and fast folder overview scanning.

use crate::ai::{format_skill_markdown, parse_skill_markdown, sanitize_skill_slug};
use crate::fs_util::write_atomic;
use crate::vault::{
    create_note, display_path_string, normalize_rel_path, resolve_vault_path, write_note,
};
use serde::{Deserialize, Serialize};
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const SKILLWEAVER_META_DIR: &str = ".skillweaver";
const FRONTMATTER_FILE: &str = "frontmatter.yml";
const TEMPLATES_DIR: &str = "templates";
const FAST_TITLE_READ_BYTES: usize = 2048;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderProperty {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderTemplate {
    pub file_name: String,
    pub rel_path: String,
    pub name: String,
    pub description: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderItemEntry {
    pub name: String,
    pub rel_path: String,
    pub kind: String,
    pub title: Option<String>,
    pub file_name: String,
    pub modified_ms: u64,
    pub child_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FolderOverview {
    pub folder_rel: String,
    pub folder_name: String,
    pub props_rel_path: String,
    pub properties: Vec<FolderProperty>,
    pub templates: Vec<FolderTemplate>,
    pub entries: Vec<FolderItemEntry>,
}

/// Validates and resolves `folder_rel` (`""` for vault root) to `(norm_rel, canonical_dir, display_name)`.
pub fn resolve_folder_dir(
    root: &Path,
    folder_rel: &str,
) -> Result<(String, PathBuf, String), String> {
    let canon_root = fs::canonicalize(root)
        .map_err(|e| format!("Invalid vault root {}: {e}", root.display()))?;
    let trimmed = folder_rel
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();

    if trimmed.is_empty() || trimmed == "." {
        let name = canon_root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Vault".to_string());
        return Ok((String::new(), canon_root, name));
    }

    let norm = normalize_rel_path(&trimmed)?;
    if norm.split('/').any(|seg| seg.starts_with('.')) {
        return Err("Hidden system folders cannot be opened in Folder Explorer".to_string());
    }

    let full = resolve_vault_path(&canon_root, &norm)?;
    if !full.is_dir() {
        return Err(format!("Folder does not exist: {norm}"));
    }

    let display_name = norm
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(&norm)
        .to_string();

    Ok((norm, full, display_name))
}

fn frontmatter_file_path(folder_dir: &Path) -> PathBuf {
    folder_dir.join(SKILLWEAVER_META_DIR).join(FRONTMATTER_FILE)
}

fn templates_dir_path(folder_dir: &Path) -> PathBuf {
    folder_dir.join(SKILLWEAVER_META_DIR).join(TEMPLATES_DIR)
}

fn join_rel(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{parent}/{child}")
    }
}

fn cleanup_empty_meta_dirs(folder_dir: &Path) {
    let templates_dir = templates_dir_path(folder_dir);
    if templates_dir.is_dir() {
        if let Ok(mut entries) = fs::read_dir(&templates_dir) {
            if entries.next().is_none() {
                let _ = fs::remove_dir(&templates_dir);
            }
        }
    }

    let meta_dir = folder_dir.join(SKILLWEAVER_META_DIR);
    if meta_dir.is_dir() {
        if let Ok(mut entries) = fs::read_dir(&meta_dir) {
            if entries.next().is_none() {
                let _ = fs::remove_dir(&meta_dir);
            }
        }
    }
}

fn unquote_yaml_scalar(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        let inner = &trimmed[1..trimmed.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some(other) => {
                        out.push('\\');
                        out.push(other);
                    }
                    None => out.push('\\'),
                }
            } else {
                out.push(ch);
            }
        }
        return out;
    }
    if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        return trimmed[1..trimmed.len() - 1].replace("''", "'");
    }
    trimmed.to_string()
}

fn format_yaml_scalar(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quotes = value != trimmed
        || trimmed.contains(':')
        || trimmed.contains('#')
        || trimmed.contains('\n')
        || trimmed.contains('"')
        || trimmed.contains('\'')
        || trimmed.contains('{')
        || trimmed.contains('}')
        || trimmed.contains('[')
        || trimmed.contains(']')
        || trimmed.starts_with(['-', '*', '&', '!', '|', '>', '@', '`', '?']);

    if !needs_quotes {
        return trimmed.to_string();
    }

    let mut escaped = String::with_capacity(value.len() + 4);
    escaped.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => {}
            '\t' => escaped.push_str("\\t"),
            _ => escaped.push(ch),
        }
    }
    escaped.push('"');
    escaped
}

fn sanitize_properties(props: Vec<FolderProperty>) -> Vec<FolderProperty> {
    let mut cleaned: Vec<FolderProperty> = Vec::new();
    for prop in props {
        let key = prop.key.replace(['\r', '\n', ':'], " ").trim().to_string();
        if key.is_empty() {
            continue;
        }
        let value = prop.value.replace(['\r', '\n'], " ").trim().to_string();
        if let Some(existing) = cleaned
            .iter_mut()
            .find(|p| p.key.eq_ignore_ascii_case(&key))
        {
            existing.key = key;
            existing.value = value;
        } else {
            cleaned.push(FolderProperty { key, value });
        }
    }
    cleaned
}

fn render_properties_yaml(props: &[FolderProperty]) -> String {
    let mut out = String::new();
    for prop in props {
        let _ = writeln!(out, "{}: {}", prop.key, format_yaml_scalar(&prop.value));
    }
    out
}

/// Reads per-folder properties from `<folder>/.skillweaver/frontmatter.yml`.
pub fn read_folder_properties(folder_dir: &Path) -> Result<Vec<FolderProperty>, String> {
    let path = frontmatter_file_path(folder_dir);
    if !path.is_file() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", display_path_string(&path)))?;
    let mut props = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed == "---"
            || trimmed == "..."
            || line.starts_with([' ', '\t'])
        {
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let key = k.trim().to_string();
        if key.is_empty() {
            continue;
        }
        props.push(FolderProperty {
            key,
            value: unquote_yaml_scalar(v),
        });
    }
    Ok(sanitize_properties(props))
}

/// Saves per-folder properties atomically; deletes `frontmatter.yml` if empty.
pub fn save_folder_properties(
    folder_dir: &Path,
    properties: Vec<FolderProperty>,
) -> Result<Vec<FolderProperty>, String> {
    let cleaned = sanitize_properties(properties);
    let path = frontmatter_file_path(folder_dir);

    if cleaned.is_empty() {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to remove {}: {e}", display_path_string(&path)))?;
        }
        cleanup_empty_meta_dirs(folder_dir);
        return Ok(Vec::new());
    }

    let meta_dir = folder_dir.join(SKILLWEAVER_META_DIR);
    fs::create_dir_all(&meta_dir)
        .map_err(|e| format!("Failed to create {}: {e}", display_path_string(&meta_dir)))?;

    let yaml = render_properties_yaml(&cleaned);
    write_atomic(&path, yaml.as_bytes())
        .map_err(|e| format!("Failed to save {}: {e}", display_path_string(&path)))?;

    Ok(cleaned)
}

fn validate_template_file_name(raw_name: &str) -> Result<String, String> {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return Err("Template filename cannot be empty".to_string());
    }
    if trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
        || trimmed.contains("..")
        || trimmed.starts_with('.')
    {
        return Err(format!("Invalid template filename: {trimmed}"));
    }
    let with_ext = if trimmed.to_ascii_lowercase().ends_with(".md") {
        trimmed.to_string()
    } else {
        format!("{trimmed}.md")
    };
    if with_ext.len() <= 3 {
        return Err("Template filename must have a valid stem".to_string());
    }
    Ok(with_ext)
}

/// Lists all Markdown templates in `<folder>/.skillweaver/templates/*.md`.
pub fn read_folder_templates(
    folder_dir: &Path,
    folder_rel: &str,
) -> Result<Vec<FolderTemplate>, String> {
    let dir = templates_dir_path(folder_dir);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }

    let read_dir = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read templates directory {}: {e}", dir.display()))?;
    let mut templates = Vec::new();

    for entry_res in read_dir {
        let Ok(entry) = entry_res else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') || !file_name.to_ascii_lowercase().ends_with(".md") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| file_name.clone());
        let parsed = parse_skill_markdown(&raw, &stem);
        let rel_path = join_rel(
            folder_rel,
            &format!("{SKILLWEAVER_META_DIR}/{TEMPLATES_DIR}/{file_name}"),
        );
        templates.push(FolderTemplate {
            file_name,
            rel_path,
            name: parsed.name,
            description: parsed.description,
            body: parsed.body,
        });
    }

    templates.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
            .then_with(|| {
                a.file_name
                    .to_ascii_lowercase()
                    .cmp(&b.file_name.to_ascii_lowercase())
            })
    });

    Ok(templates)
}

/// Creates or updates a local template under `<folder>/.skillweaver/templates/`.
pub fn save_folder_template(
    folder_dir: &Path,
    folder_rel: &str,
    file_name: Option<&str>,
    name: &str,
    description: &str,
    body: &str,
) -> Result<FolderTemplate, String> {
    let clean_name = name.trim();
    if clean_name.is_empty() {
        return Err("Template name cannot be empty".to_string());
    }

    let resolved_file_name = match file_name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(existing) => validate_template_file_name(existing)?,
        None => {
            let slug = sanitize_skill_slug(clean_name)?;
            format!("{slug}.md")
        }
    };

    let dir = templates_dir_path(folder_dir);
    fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Failed to create templates directory {}: {e}",
            dir.display()
        )
    })?;

    let target_path = dir.join(&resolved_file_name);
    let clean_desc = description.replace(['\r', '\n'], " ").trim().to_string();
    let formatted = format_skill_markdown(clean_name, &clean_desc, body);

    write_atomic(&target_path, formatted.as_bytes()).map_err(|e| {
        format!(
            "Failed to save template {}: {e}",
            display_path_string(&target_path)
        )
    })?;

    let parsed = parse_skill_markdown(&formatted, &resolved_file_name);
    Ok(FolderTemplate {
        rel_path: join_rel(
            folder_rel,
            &format!("{SKILLWEAVER_META_DIR}/{TEMPLATES_DIR}/{resolved_file_name}"),
        ),
        file_name: resolved_file_name,
        name: parsed.name,
        description: parsed.description,
        body: parsed.body,
    })
}

/// Deletes a template file inside `<folder>/.skillweaver/templates/`.
pub fn delete_folder_template(folder_dir: &Path, file_name: &str) -> Result<(), String> {
    let valid_name = validate_template_file_name(file_name)?;
    let path = templates_dir_path(folder_dir).join(&valid_name);
    if path.is_file() {
        fs::remove_file(&path).map_err(|e| {
            format!(
                "Failed to delete template {}: {e}",
                display_path_string(&path)
            )
        })?;
    }
    cleanup_empty_meta_dirs(folder_dir);
    Ok(())
}

fn today_iso_date() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let z = i64::try_from(days).unwrap_or(0) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Creates a new note inside `folder_rel`, applying folder properties and an optional template.
pub fn create_note_from_template(
    root: &Path,
    folder_rel: &str,
    note_name: &str,
    template_file_name: Option<&str>,
) -> Result<String, String> {
    let (norm_folder, folder_dir, _) = resolve_folder_dir(root, folder_rel)?;
    let trimmed_name = note_name.trim();
    if trimmed_name.is_empty()
        || trimmed_name.contains('/')
        || trimmed_name.contains('\\')
        || trimmed_name.contains("..")
        || trimmed_name.contains('\0')
    {
        return Err("Invalid note name".to_string());
    }

    let title_clean = if trimmed_name.to_ascii_lowercase().ends_with(".md") {
        trimmed_name[..trimmed_name.len() - 3].trim()
    } else {
        trimmed_name
    };
    if title_clean.is_empty() {
        return Err("Invalid note name".to_string());
    }

    let props = read_folder_properties(&folder_dir)?;
    let mut expanded_body = String::new();

    if let Some(tpl_name) = template_file_name.map(str::trim).filter(|s| !s.is_empty()) {
        let valid_tpl = validate_template_file_name(tpl_name)?;
        let tpl_path = templates_dir_path(&folder_dir).join(&valid_tpl);
        let raw_tpl = fs::read_to_string(&tpl_path).map_err(|e| {
            format!(
                "Failed to read template {}: {e}",
                display_path_string(&tpl_path)
            )
        })?;
        let parsed = parse_skill_markdown(&raw_tpl, &valid_tpl);
        let today = today_iso_date();
        expanded_body = parsed
            .body
            .replace("{{title}}", title_clean)
            .replace("{{date}}", &today)
            .trim()
            .to_string();
    }

    let mut content = String::new();
    if !props.is_empty() {
        content.push_str("---\n");
        content.push_str(&render_properties_yaml(&props));
        content.push_str("---\n\n");
    }
    if !expanded_body.is_empty() {
        content.push_str(&expanded_body);
        content.push('\n');
    }

    let rel_input = join_rel(&norm_folder, title_clean);
    let created_rel = create_note(root, &rel_input)?;
    if !content.is_empty() {
        write_note(root, &created_rel, &content)?;
    }

    Ok(created_rel)
}

fn metadata_modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn is_ignored_folder_entry(name: &str) -> bool {
    name.starts_with('.')
        || name.eq_ignore_ascii_case("node_modules")
        || name.eq_ignore_ascii_case("target")
}

fn count_visible_children(dir: &Path) -> usize {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return 0;
    };
    let mut count = 0usize;
    for entry in read_dir.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_folder_entry(&name) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() || (file_type.is_file() && name.to_ascii_lowercase().ends_with(".md"))
        {
            count += 1;
        }
    }
    count
}

fn is_horizontal_rule_line(trimmed: &str) -> bool {
    if trimmed.len() < 3 {
        return false;
    }
    let first = trimmed.chars().next().unwrap_or(' ');
    matches!(first, '-' | '*' | '_') && trimmed.chars().all(|c| c == first || c == ' ')
}

fn strip_trailing_block_id(line: &str) -> &str {
    let trimmed = line.trim_end();
    if let Some((head, tail)) = trimmed.rsplit_once(" ^") {
        let id_part = tail.trim();
        if !id_part.is_empty()
            && id_part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return head.trim_end();
        }
    }
    trimmed
}

fn strip_list_and_prefix(mut line: &str) -> &str {
    loop {
        let prev = line;
        line = line.trim_start();
        if let Some(rest) = line.strip_prefix('#') {
            line = rest.trim_start_matches('#').trim_start();
        } else if let Some(rest) = line.strip_prefix('>') {
            line = rest.trim_start();
            if line.starts_with("[!") {
                if let Some(close_idx) = line.find(']') {
                    line = line[close_idx + 1..].trim_start();
                }
            }
        } else if let Some(rest) = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .or_else(|| line.strip_prefix("+ "))
        {
            line = rest.trim_start();
        } else {
            let digits_len = line.bytes().take_while(|b| b.is_ascii_digit()).count();
            if digits_len > 0 && digits_len < line.len() {
                let after = &line[digits_len..];
                if let Some(rest) = after
                    .strip_prefix(". ")
                    .or_else(|| after.strip_prefix(") "))
                {
                    line = rest.trim_start();
                }
            }
        }

        if let Some(rest) = line
            .strip_prefix("[ ] ")
            .or_else(|| line.strip_prefix("[x] "))
            .or_else(|| line.strip_prefix("[X] "))
        {
            line = rest.trim_start();
        }

        if line == prev {
            break;
        }
    }
    line
}

fn strip_inline_markup(input: &str) -> String {
    let mut s = input.to_string();

    // Unwrap wikilinks [[target|alias]] -> alias or [[target]] -> target
    while let Some(start) = s.find("[[") {
        if let Some(rel_end) = s[start + 2..].find("]]") {
            let end = start + 2 + rel_end;
            let inner = &s[start + 2..end];
            let replacement = inner
                .split_once('|')
                .map(|(_, alias)| alias)
                .unwrap_or(inner)
                .trim()
                .to_string();
            s.replace_range(start..end + 2, &replacement);
        } else {
            break;
        }
    }

    // Unwrap markdown links [label](url) -> label (ignoring ![alt](url) leading !)
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '[' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != ']' && chars[j] != '\n' {
                j += 1;
            }
            if j + 1 < chars.len() && chars[j] == ']' && chars[j + 1] == '(' {
                let mut k = j + 2;
                while k < chars.len() && chars[k] != ')' && chars[k] != '\n' {
                    k += 1;
                }
                if k < chars.len() && chars[k] == ')' {
                    let label: String = chars[i + 1..j].iter().collect();
                    out.push_str(&label);
                    i = k + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }

    let cleaned = out
        .replace("**", "")
        .replace("__", "")
        .replace("~~", "")
        .replace('`', "");
    cleaned.replace('*', "").trim().to_string()
}

/// Extracts a clean display title from the first 2 KB of a Markdown file without full AST parsing.
pub fn extract_fast_note_title(path: &Path, fallback_stem: &str) -> String {
    let Ok(file) = File::open(path) else {
        return fallback_stem.to_string();
    };
    let mut buf = Vec::with_capacity(FAST_TITLE_READ_BYTES);
    if file
        .take(FAST_TITLE_READ_BYTES as u64)
        .read_to_end(&mut buf)
        .is_err()
        || buf.is_empty()
    {
        return fallback_stem.to_string();
    }

    let lossy = String::from_utf8_lossy(&buf);
    let normalized = lossy
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");

    let mut frontmatter_title: Option<String> = None;
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut idx = 0usize;

    if lines.first().map(|l| l.trim() == "---").unwrap_or(false) {
        idx = 1;
        while idx < lines.len() {
            let trimmed = lines[idx].trim();
            if trimmed == "---" || trimmed == "..." {
                idx += 1;
                break;
            }
            if let Some((k, v)) = lines[idx].split_once(':') {
                if k.trim().eq_ignore_ascii_case("title") {
                    let candidate = unquote_yaml_scalar(v);
                    if !candidate.trim().is_empty() {
                        frontmatter_title = Some(candidate.trim().to_string());
                    }
                }
            }
            idx += 1;
        }
    }

    let mut in_html_comment = false;
    for raw_line in lines.iter().skip(idx) {
        let mut line = raw_line.trim();
        if in_html_comment {
            if let Some((_, after)) = line.split_once("-->") {
                in_html_comment = false;
                line = after.trim();
            } else {
                continue;
            }
        }
        while let Some(comment_start) = line.find("<!--") {
            let prefix = line[..comment_start].trim();
            if let Some(after_rel) = line[comment_start + 4..].find("-->") {
                if prefix.is_empty() {
                    line = line[comment_start + 4 + after_rel + 3..].trim();
                } else {
                    line = prefix;
                    break;
                }
            } else {
                in_html_comment = true;
                line = prefix;
                break;
            }
        }

        if line.is_empty()
            || is_horizontal_rule_line(line)
            || line.starts_with("```")
            || line.starts_with("~~~")
            || line.starts_with(":::")
            || (line.starts_with("style:") && !line.contains(' '))
        {
            continue;
        }

        let no_prefix = strip_list_and_prefix(line);
        let no_block_id = strip_trailing_block_id(no_prefix);
        let plain = strip_inline_markup(no_block_id);
        let title = plain.trim();
        if !title.is_empty() {
            return if title.chars().count() > 140 {
                title.chars().take(140).collect()
            } else {
                title.to_string()
            };
        }
    }

    frontmatter_title.unwrap_or_else(|| fallback_stem.to_string())
}

/// Scans immediate folders and `.md` notes inside `folder_rel`, plus folder properties and templates.
pub fn get_folder_overview(root: &Path, folder_rel: &str) -> Result<FolderOverview, String> {
    let (norm_rel, folder_dir, folder_name) = resolve_folder_dir(root, folder_rel)?;
    let properties = read_folder_properties(&folder_dir)?;
    let templates = read_folder_templates(&folder_dir, &norm_rel)?;

    let read_dir = fs::read_dir(&folder_dir).map_err(|e| {
        format!(
            "Failed to read folder {}: {e}",
            display_path_string(&folder_dir)
        )
    })?;
    let mut entries = Vec::new();

    for entry_res in read_dir {
        let Ok(entry) = entry_res else {
            continue;
        };
        let file_name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_folder_entry(&file_name) {
            continue;
        }

        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let modified_ms = metadata_modified_ms(&meta);
        let rel_path = join_rel(&norm_rel, &file_name);

        if meta.is_dir() {
            let child_count = count_visible_children(&path);
            if norm_rel.is_empty() && file_name.eq_ignore_ascii_case("assets") && child_count == 0 {
                continue;
            }
            entries.push(FolderItemEntry {
                name: file_name.clone(),
                rel_path,
                kind: "dir".to_string(),
                title: None,
                file_name,
                modified_ms,
                child_count,
            });
        } else if meta.is_file() && file_name.to_ascii_lowercase().ends_with(".md") {
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| file_name.clone());
            let title = extract_fast_note_title(&path, &stem);
            entries.push(FolderItemEntry {
                name: stem,
                rel_path,
                kind: "note".to_string(),
                title: Some(title),
                file_name,
                modified_ms,
                child_count: 0,
            });
        }
    }

    entries.sort_by(|a, b| {
        let a_rank = usize::from(a.kind != "dir");
        let b_rank = usize::from(b.kind != "dir");
        a_rank.cmp(&b_rank).then_with(|| {
            let a_label = a.title.as_deref().unwrap_or(&a.name).to_ascii_lowercase();
            let b_label = b.title.as_deref().unwrap_or(&b.name).to_ascii_lowercase();
            a_label.cmp(&b_label)
        })
    });

    let props_rel_path = join_rel(
        &norm_rel,
        &format!("{SKILLWEAVER_META_DIR}/{FRONTMATTER_FILE}"),
    );

    Ok(FolderOverview {
        folder_rel: norm_rel,
        folder_name,
        props_rel_path,
        properties,
        templates,
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("skillweaver_folder_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn extract_fast_note_title_strips_frontmatter_comments_markup_and_block_id() {
        let root = temp_vault("fast_title");
        let note = root.join("01 - Rust Loader Main Data.md");
        let content = concat!(
            "---\n",
            "status: draft\n",
            "owner: Blue Frog\n",
            "---\n",
            "<!-- internal comment\n",
            "spanning two lines -->\n",
            "style:color=blue;bg=blue\n\n",
            "# **Rust Data Pipelines** [[Core|Core]] ^showcase-top\n\n",
            "Body paragraph below.\n"
        );
        fs::write(&note, content).unwrap();

        let title = extract_fast_note_title(&note, "01 - Rust Loader Main Data");
        assert_eq!(title, "Rust Data Pipelines Core");

        let fallback_note = root.join("empty.md");
        fs::write(&fallback_note, "---\ntags: a\n---\n\n").unwrap();
        assert_eq!(extract_fast_note_title(&fallback_note, "empty"), "empty");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_properties_yaml_round_trip_and_cleanup_when_empty() {
        let root = temp_vault("props");
        let folder = root.join("01 - Rust Data Loader");
        fs::create_dir_all(&folder).unwrap();

        let saved = save_folder_properties(
            &folder,
            vec![
                FolderProperty {
                    key: "status".to_string(),
                    value: "active".to_string(),
                },
                FolderProperty {
                    key: "summary".to_string(),
                    value: "Phase 1: core #pipeline".to_string(),
                },
                FolderProperty {
                    key: "status".to_string(),
                    value: "reviewed".to_string(),
                },
            ],
        )
        .unwrap();

        assert_eq!(saved.len(), 2);
        assert_eq!(saved[0].value, "reviewed");

        let loaded = read_folder_properties(&folder).unwrap();
        assert_eq!(loaded, saved);
        assert!(folder.join(".skillweaver/frontmatter.yml").is_file());

        let cleared = save_folder_properties(&folder, Vec::new()).unwrap();
        assert!(cleared.is_empty());
        assert!(!folder.join(".skillweaver/frontmatter.yml").exists());
        assert!(!folder.join(".skillweaver").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn folder_template_crud_and_create_note_substitutes_placeholders_and_frontmatter() {
        let root = temp_vault("templates");
        let sub = root.join("Pipelines");
        fs::create_dir_all(&sub).unwrap();

        save_folder_properties(
            &sub,
            vec![FolderProperty {
                key: "area".to_string(),
                value: "Data Loader".to_string(),
            }],
        )
        .unwrap();

        let tpl = save_folder_template(
            &sub,
            "Pipelines",
            None,
            "Design Spec",
            "Architecture note template",
            "# {{title}}\n\nCreated on {{date}}.\n",
        )
        .unwrap();
        assert_eq!(tpl.file_name, "design-spec.md");
        assert_eq!(
            tpl.rel_path,
            "Pipelines/.skillweaver/templates/design-spec.md"
        );

        let list = read_folder_templates(&sub, "Pipelines").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Design Spec");

        let rel =
            create_note_from_template(&root, "Pipelines", "CSV Ingestion", Some(&tpl.file_name))
                .unwrap();
        assert_eq!(rel, "Pipelines/CSV Ingestion.md");

        let disk = fs::read_to_string(sub.join("CSV Ingestion.md")).unwrap();
        assert!(disk.starts_with("---\narea: Data Loader\n---\n\n# CSV Ingestion"));
        assert!(!disk.contains("{{title}}"));
        assert!(!disk.contains("{{date}}"));

        delete_folder_template(&sub, &tpl.file_name).unwrap();
        assert!(read_folder_templates(&sub, "Pipelines").unwrap().is_empty());
        assert!(!sub.join(".skillweaver/templates").exists());
        // frontmatter.yml still exists, so .skillweaver dir stays intact
        assert!(sub.join(".skillweaver/frontmatter.yml").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn get_folder_overview_skips_dotfiles_and_collects_dirs_and_notes() {
        let root = temp_vault("overview");
        let sub = root.join("Submodule");
        let nested = sub.join("Nested");
        let hidden = root.join(".skillweaver");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&hidden).unwrap();
        fs::write(hidden.join("ignored.md"), "# Secret").unwrap();
        fs::write(nested.join("inner.md"), "# Inner").unwrap();
        fs::write(sub.join("deep.md"), "# Deep").unwrap();
        fs::write(root.join("alpha.md"), "# Alpha Title ^top").unwrap();
        fs::write(root.join("notes.txt"), "not markdown").unwrap();

        let overview = get_folder_overview(&root, "").unwrap();
        assert_eq!(overview.folder_rel, "");
        assert_eq!(overview.props_rel_path, ".skillweaver/frontmatter.yml");
        assert_eq!(overview.entries.len(), 2);

        assert_eq!(overview.entries[0].kind, "dir");
        assert_eq!(overview.entries[0].name, "Submodule");
        assert_eq!(overview.entries[0].child_count, 2);

        assert_eq!(overview.entries[1].kind, "note");
        assert_eq!(overview.entries[1].file_name, "alpha.md");
        assert_eq!(overview.entries[1].title.as_deref(), Some("Alpha Title"));

        let _ = fs::remove_dir_all(&root);
    }
}
