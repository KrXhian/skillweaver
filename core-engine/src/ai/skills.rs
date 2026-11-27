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

use crate::markdown::extract_links;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// A reusable Markdown AI skill stored in `<vault>/skills/` or `~/.skillweaver/skills/`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkillEntry {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: String,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rel_path: Option<String>,
    pub body: String,
    #[serde(default)]
    pub linked_refs: Vec<String>,
    pub updated_at: u64,
}

/// Request payload for creating, updating, renaming, or moving a skill.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SaveSkillRequest {
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: String,
    pub body: String,
    pub scope: String,
    #[serde(default)]
    pub original_id: Option<String>,
}

/// Returns the global Skill Bank directory at `%USERPROFILE%\.skillweaver\skills` (or `$HOME/.skillweaver/skills`).
pub fn global_skills_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".skillweaver").join("skills"))
}

/// Normalizes a raw skill name or slug into a strict lowercase `[a-z0-9-]` identifier (max 64 chars).
pub fn sanitize_skill_slug(raw: &str) -> Result<String, String> {
    if raw.contains('\0') {
        return Err("Invalid skill slug: null byte is not allowed".to_string());
    }

    let mut out = String::with_capacity(raw.len().min(64));
    let mut prev_dash = true; // suppresses leading '-'
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }

    while out.ends_with('-') {
        out.pop();
    }

    if out.len() > 64 {
        out.truncate(64);
        while out.ends_with('-') {
            out.pop();
        }
    }

    if out.is_empty() {
        return Err("Skill slug must contain at least one letter or digit".to_string());
    }

    Ok(out)
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
                    Some('n') => out.push(' '),
                    Some('r') => {}
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
        return out.trim().to_string();
    }

    if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
        let inner = &trimmed[1..trimmed.len() - 1];
        return inner.replace("''", "'").trim().to_string();
    }

    trimmed.to_string()
}

fn format_yaml_scalar(raw: &str) -> String {
    let clean: String = raw
        .replace("\r\n", " ")
        .replace(['\r', '\n'], " ")
        .trim()
        .to_string();

    if clean.is_empty() {
        return "\"\"".to_string();
    }

    let first = clean.chars().next().unwrap_or(' ');
    let needs_quotes = matches!(
        first,
        '-' | '?'
            | ':'
            | ','
            | '['
            | ']'
            | '{'
            | '}'
            | '&'
            | '*'
            | '!'
            | '|'
            | '>'
            | '\''
            | '"'
            | '%'
            | '@'
            | '`'
            | '#'
    ) || clean.contains(':')
        || clean.contains('#')
        || clean.contains('"')
        || clean.contains('\'');

    if !needs_quotes {
        return clean;
    }

    let mut out = String::with_capacity(clean.len() + 2);
    out.push('"');
    for ch in clean.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn derive_fallback_description(body: &str) -> String {
    for raw_line in body.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("<!--")
            || trimmed.chars().all(|c| c == '-' || c == '*' || c == '_')
        {
            continue;
        }
        let cleaned = trimmed
            .trim_start_matches('#')
            .trim_start_matches(['>', '-', '*', ' '])
            .trim();
        if cleaned.is_empty() {
            continue;
        }
        let clipped: String = cleaned.chars().take(120).collect();
        return if cleaned.chars().count() > 120 {
            format!("{}…", clipped.trim_end())
        } else {
            clipped
        };
    }
    String::new()
}

/// Metadata and body extracted from a `SKILL.md` file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSkillMarkdown {
    pub name: String,
    pub description: String,
    pub body: String,
    pub has_frontmatter: bool,
}

/// Parses a `SKILL.md` file into structured metadata and Markdown body.
/// Tolerates blank lines inside top-of-file YAML frontmatter if previously edited in block mode.
pub fn parse_skill_markdown(raw: &str, fallback_slug: &str) -> ParsedSkillMarkdown {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    let mut name = String::new();
    let mut description = String::new();
    let mut body_start_idx = 0usize;
    let mut has_frontmatter = false;

    if lines.first().map(|l| l.trim() == "---").unwrap_or(false) {
        let mut closing_idx = None;
        for (idx, line) in lines.iter().enumerate().skip(1) {
            if line.trim() == "---" {
                closing_idx = Some(idx);
                break;
            }
        }

        if let Some(end_idx) = closing_idx {
            has_frontmatter = true;
            for line in &lines[1..end_idx] {
                let trimmed = line.trim();
                if trimmed.is_empty() || trimmed.starts_with('#') {
                    continue;
                }
                if !line.starts_with(' ') && !line.starts_with('\t') {
                    if let Some((key, val)) = line.split_once(':') {
                        let key_lower = key.trim().to_ascii_lowercase();
                        let parsed = unquote_yaml_scalar(val);
                        match key_lower.as_str() {
                            "name" if !parsed.is_empty() => name = parsed,
                            "description" if !parsed.is_empty() => description = parsed,
                            _ => {}
                        }
                    }
                }
            }
            body_start_idx = end_idx + 1;
        }
    }

    let body = lines[body_start_idx..].join("\n").trim().to_string();
    if name.is_empty() {
        name = fallback_slug.to_string();
    }
    if description.is_empty() {
        description = derive_fallback_description(&body);
    }

    ParsedSkillMarkdown {
        name,
        description,
        body,
        has_frontmatter,
    }
}

/// Serializes a skill into canonical `SKILL.md` Markdown with YAML frontmatter.
pub fn format_skill_markdown(name: &str, description: &str, body: &str) -> String {
    let clean_name = if name.trim().is_empty() {
        "skill"
    } else {
        name.trim()
    };
    format!(
        "---\nname: {}\ndescription: {}\n---\n\n{}\n",
        format_yaml_scalar(clean_name),
        format_yaml_scalar(description),
        body.replace("\r\n", "\n").replace('\r', "\n").trim()
    )
}

fn extract_unique_link_refs(body: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    for link in extract_links(body) {
        let target = link.target.trim().to_string();
        if target.is_empty() {
            continue;
        }
        let key = target.to_ascii_lowercase();
        if seen.insert(key) {
            refs.push(target);
        }
    }
    refs
}

fn file_updated_at_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn build_skill_entry(
    scope: &str,
    slug: String,
    rel_path: Option<String>,
    file_path: &Path,
) -> Option<SkillEntry> {
    let raw = fs::read_to_string(file_path).ok()?;
    let parsed = parse_skill_markdown(&raw, &slug);
    if !parsed.has_frontmatter {
        return None;
    }
    let linked_refs = extract_unique_link_refs(&parsed.body);
    let updated_at = file_updated_at_secs(file_path);

    Some(SkillEntry {
        id: format!("{scope}:{slug}"),
        slug,
        name: parsed.name,
        description: parsed.description,
        scope: scope.to_string(),
        rel_path,
        body: parsed.body,
        linked_refs,
        updated_at,
    })
}

fn find_skill_md_in_dir(dir: &Path) -> Option<(String, PathBuf)> {
    let entries = fs::read_dir(dir).ok()?;
    let mut fallback: Option<(String, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let fname = entry.file_name().to_string_lossy().to_string();
        if fname == "SKILL.md" {
            return Some((fname, path));
        }
        if fname.eq_ignore_ascii_case("skill.md") {
            fallback = Some((fname, path));
        }
    }
    fallback
}

fn scan_skills_base(base_dir: &Path, scope: &str, out: &mut Vec<SkillEntry>) {
    if !base_dir.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(base_dir) else {
        return;
    };

    let mut seen_slugs = HashSet::new();
    for entry in entries.flatten() {
        let fname = entry.file_name().to_string_lossy().to_string();
        if fname.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            // Leave ordinary story notes (flat `*.md` inside `skills/`) untouched.
            continue;
        }
        let Ok(slug) = sanitize_skill_slug(&fname) else {
            continue;
        };
        let Some((skill_fname, skill_path)) = find_skill_md_in_dir(&path) else {
            continue;
        };
        let rel_path = if scope == "vault" {
            Some(format!("skills/{fname}/{skill_fname}"))
        } else {
            None
        };
        if let Some(item) = build_skill_entry(scope, slug.clone(), rel_path, &skill_path) {
            if seen_slugs.insert(slug) {
                out.push(item);
            }
        }
    }
}

/// Lists all skills across `<vault>/skills/` and the global Skill Bank, sorted vault-first then by slug.
pub fn list_skills_in(vault_root: Option<&Path>, global_dir: Option<&Path>) -> Vec<SkillEntry> {
    let mut skills = Vec::new();
    if let Some(root) = vault_root {
        scan_skills_base(&root.join("skills"), "vault", &mut skills);
    }
    if let Some(gdir) = global_dir {
        scan_skills_base(gdir, "global", &mut skills);
    }

    skills.sort_by(|a, b| {
        let scope_rank = |s: &str| if s == "vault" { 0u8 } else { 1u8 };
        scope_rank(&a.scope)
            .cmp(&scope_rank(&b.scope))
            .then_with(|| a.slug.cmp(&b.slug))
    });
    skills
}

/// Lists all skills for the active vault (if any) and the user's global `~/.skillweaver/skills` directory.
pub fn list_skills(vault_root: Option<&Path>) -> Vec<SkillEntry> {
    let global_dir = global_skills_dir();
    list_skills_in(vault_root, global_dir.as_deref())
}

fn resolve_scope_base_dir(
    scope: &str,
    vault_root: Option<&Path>,
    global_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    match scope {
        "vault" => vault_root
            .map(|r| r.join("skills"))
            .ok_or_else(|| "Open a folder first to use vault skills".to_string()),
        "global" => global_dir
            .map(Path::to_path_buf)
            .ok_or_else(|| "Could not determine user home directory".to_string()),
        other => Err(format!(
            "Invalid skill scope '{other}' (expected 'vault' or 'global')"
        )),
    }
}

fn parse_skill_id(skill_id: &str) -> Result<(String, String), String> {
    let trimmed = skill_id.trim();
    let Some((scope_raw, slug_raw)) = trimmed.split_once(':') else {
        return Err(format!("Invalid skill ID: {skill_id}"));
    };
    let scope = scope_raw.trim().to_ascii_lowercase();
    if scope != "vault" && scope != "global" {
        return Err(format!("Invalid skill scope in ID: {skill_id}"));
    }
    let slug = sanitize_skill_slug(slug_raw)?;
    if slug != slug_raw {
        return Err(format!("Invalid skill ID: {skill_id}"));
    }
    Ok((scope, slug))
}

/// Creates, updates, renames, or moves a skill inside `vault_root/skills` or `global_dir`.
pub fn save_skill_in(
    vault_root: Option<&Path>,
    global_dir: Option<&Path>,
    req: &SaveSkillRequest,
) -> Result<SkillEntry, String> {
    let scope = req.scope.trim().to_ascii_lowercase();
    let base_dir = resolve_scope_base_dir(&scope, vault_root, global_dir)?;

    let raw_slug_source = if !req.slug.trim().is_empty() {
        req.slug.as_str()
    } else if let Some(name) = req.name.as_deref().filter(|s| !s.trim().is_empty()) {
        name
    } else {
        return Err("Skill name or slug is required".to_string());
    };
    let slug = sanitize_skill_slug(raw_slug_source)?;

    if req.body.trim().is_empty() {
        return Err("Skill instructions cannot be empty".to_string());
    }

    fs::create_dir_all(&base_dir).map_err(|e| {
        format!(
            "Failed to create skills directory {}: {e}",
            base_dir.display()
        )
    })?;
    let canon_base = fs::canonicalize(&base_dir)
        .map_err(|e| format!("Invalid skills directory {}: {e}", base_dir.display()))?;

    let skill_dir = canon_base.join(&slug);
    fs::create_dir_all(&skill_dir)
        .map_err(|e| format!("Failed to create skill folder {}: {e}", skill_dir.display()))?;
    let canon_skill_dir = fs::canonicalize(&skill_dir)
        .map_err(|e| format!("Invalid skill folder {}: {e}", skill_dir.display()))?;
    if !canon_skill_dir.starts_with(&canon_base) {
        return Err("Invalid skill path: escapes skills directory".to_string());
    }

    let display_name = req
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&slug);
    let formatted = format_skill_markdown(display_name, &req.description, &req.body);
    let target_file = canon_skill_dir.join("SKILL.md");

    crate::fs_util::write_atomic(&target_file, formatted.as_bytes())
        .map_err(|e| format!("Failed to write skill file {}: {e}", target_file.display()))?;

    let new_id = format!("{scope}:{slug}");
    if let Some(orig) = req
        .original_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if orig != new_id {
            let _ = delete_skill_in(vault_root, global_dir, orig);
        }
    }

    let rel_path = if scope == "vault" {
        Some(format!("skills/{slug}/SKILL.md"))
    } else {
        None
    };

    build_skill_entry(&scope, slug, rel_path, &target_file)
        .ok_or_else(|| "Failed to read newly saved skill".to_string())
}

/// Saves a skill using the active vault root and the user's global Skill Bank directory.
pub fn save_skill(vault_root: Option<&Path>, req: &SaveSkillRequest) -> Result<SkillEntry, String> {
    let global_dir = global_skills_dir();
    save_skill_in(vault_root, global_dir.as_deref(), req)
}

/// Deletes a skill by ID (`"vault:<slug>"` or `"global:<slug>"`).
/// Returns `Ok(Some(vault_rel_path))` when a vault file was deleted so callers can notify/suppress the watcher.
pub fn delete_skill_in(
    vault_root: Option<&Path>,
    global_dir: Option<&Path>,
    skill_id: &str,
) -> Result<Option<String>, String> {
    let (scope, slug) = parse_skill_id(skill_id)?;
    let base_dir = resolve_scope_base_dir(&scope, vault_root, global_dir)?;
    if !base_dir.is_dir() {
        return Err(format!("Skill not found: {skill_id}"));
    }
    let canon_base = fs::canonicalize(&base_dir)
        .map_err(|e| format!("Invalid skills directory {}: {e}", base_dir.display()))?;

    let mut removed_rel: Option<String> = None;

    // 1. Check matching subdirectory (`<slug>/SKILL.md` or sanitized folder match).
    if let Ok(entries) = fs::read_dir(&canon_base) {
        for entry in entries.flatten() {
            let dir_name = entry.file_name().to_string_lossy().to_string();
            if dir_name.starts_with('.') {
                continue;
            }
            let dir_path = entry.path();
            if !dir_path.is_dir() {
                continue;
            }
            let Ok(entry_slug) = sanitize_skill_slug(&dir_name) else {
                continue;
            };
            if entry_slug != slug {
                continue;
            }
            let Ok(canon_dir) = fs::canonicalize(&dir_path) else {
                continue;
            };
            if !canon_dir.starts_with(&canon_base) {
                return Err("Invalid skill path: escapes skills directory".to_string());
            }
            if let Some((skill_fname, skill_path)) = find_skill_md_in_dir(&canon_dir) {
                let is_tracked_skill = fs::read_to_string(&skill_path)
                    .ok()
                    .map(|raw| parse_skill_markdown(&raw, &slug).has_frontmatter)
                    .unwrap_or(false);
                if !is_tracked_skill {
                    continue;
                }
                fs::remove_file(&skill_path)
                    .map_err(|e| format!("Failed to delete skill {}: {e}", skill_path.display()))?;
                if scope == "vault" {
                    removed_rel = Some(format!("skills/{dir_name}/{skill_fname}"));
                }
                if fs::read_dir(&canon_dir)
                    .map(|mut it| it.next().is_none())
                    .unwrap_or(false)
                {
                    let _ = fs::remove_dir(&canon_dir);
                }
                return Ok(removed_rel);
            }
        }
    }

    Err(format!("Skill not found: {skill_id}"))
}

/// Deletes a skill using the active vault root and the user's global Skill Bank directory.
pub fn delete_skill(vault_root: Option<&Path>, skill_id: &str) -> Result<Option<String>, String> {
    let global_dir = global_skills_dir();
    delete_skill_in(vault_root, global_dir.as_deref(), skill_id)
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
        let dir = std::env::temp_dir().join(format!("skillweaver_skills_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sanitize_skill_slug_normalizes_and_rejects_empty() {
        assert_eq!(sanitize_skill_slug("Lore Keeper").unwrap(), "lore-keeper");
        assert_eq!(
            sanitize_skill_slug("  @Rust_Reviewer!! v2 ").unwrap(),
            "rust-reviewer-v2"
        );
        assert_eq!(sanitize_skill_slug("---My___Skill---").unwrap(), "my-skill");
        let long = "a".repeat(80);
        assert_eq!(sanitize_skill_slug(&long).unwrap().len(), 64);

        assert!(sanitize_skill_slug("").is_err());
        assert!(sanitize_skill_slug("---!!!").is_err());
        assert!(sanitize_skill_slug("bad\0slug").is_err());
    }

    #[test]
    fn parse_and_format_skill_markdown_round_trip_and_tolerant_frontmatter() {
        let formatted = format_skill_markdown(
            "Character Voice: Rimuru",
            "Keep dialogue sharp & true to [[Characters/Rimuru]]",
            "# Purpose\nCheck dialogue tone.\n\n- Keep humor light.",
        );
        let parsed = parse_skill_markdown(&formatted, "fallback");
        assert!(parsed.has_frontmatter);
        assert_eq!(parsed.name, "Character Voice: Rimuru");
        assert_eq!(
            parsed.description,
            "Keep dialogue sharp & true to [[Characters/Rimuru]]"
        );
        assert!(parsed.body.starts_with("# Purpose"));
        assert!(parsed.body.contains("- Keep humor light."));

        // Tolerate blank lines inside frontmatter (e.g., after block-editor save)
        let spaced = "---\n\nname: 'Plot Guard'\n\ndescription: \"Watch continuity\"\n\n---\n\n# Rules\nNever contradict Chapter 1.";
        let p2 = parse_skill_markdown(spaced, "plot-guard");
        assert!(p2.has_frontmatter);
        assert_eq!(p2.name, "Plot Guard");
        assert_eq!(p2.description, "Watch continuity");
        assert_eq!(p2.body, "# Rules\nNever contradict Chapter 1.");

        // Fallback when no frontmatter exists
        let plain = "# Combat Scene Pacing\n\nKeep sentences punchy during action beats.";
        let p3 = parse_skill_markdown(plain, "combat-pacing");
        assert!(!p3.has_frontmatter);
        assert_eq!(p3.name, "combat-pacing");
        assert_eq!(p3.description, "Combat Scene Pacing");
        assert_eq!(p3.body, plain);
    }

    #[test]
    fn skills_crud_vault_global_rename_move_and_wikilinks() {
        let root = temp_dir("crud");
        let vault = root.join("vault");
        let global = root.join("global");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&global).unwrap();

        let saved_vault = save_skill_in(
            Some(&vault),
            Some(&global),
            &SaveSkillRequest {
                slug: "lore-check".into(),
                name: Some("Lore Check".into()),
                description: "Verify novel canon".into(),
                body: "Check [[Characters/Hero#^bio]] and ignore `[[Code/Example]]`.\nAlso check [[World/Map]].".into(),
                scope: "vault".into(),
                original_id: None,
            },
        )
        .unwrap();

        assert_eq!(saved_vault.id, "vault:lore-check");
        assert_eq!(
            saved_vault.rel_path.as_deref(),
            Some("skills/lore-check/SKILL.md")
        );
        assert_eq!(
            saved_vault.linked_refs,
            vec!["Characters/Hero#^bio", "World/Map"]
        );
        assert!(vault.join("skills/lore-check/SKILL.md").is_file());

        let saved_global = save_skill_in(
            Some(&vault),
            Some(&global),
            &SaveSkillRequest {
                slug: "concise-edits".into(),
                name: Some("Concise Edits".into()),
                description: "Keep diffs minimal".into(),
                body: "Only modify requested blocks.".into(),
                scope: "global".into(),
                original_id: None,
            },
        )
        .unwrap();
        assert_eq!(saved_global.id, "global:concise-edits");
        assert_eq!(saved_global.rel_path, None);

        let all = list_skills_in(Some(&vault), Some(&global));
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].scope, "vault");
        assert_eq!(all[1].scope, "global");

        // Rename & move vault skill -> global scope
        let moved = save_skill_in(
            Some(&vault),
            Some(&global),
            &SaveSkillRequest {
                slug: "canon-check".into(),
                name: Some("Canon Check".into()),
                description: "Verify canon everywhere".into(),
                body: "Cross-check timeline.".into(),
                scope: "global".into(),
                original_id: Some("vault:lore-check".into()),
            },
        )
        .unwrap();
        assert_eq!(moved.id, "global:canon-check");
        assert!(!vault.join("skills/lore-check/SKILL.md").exists());
        assert!(global.join("canon-check/SKILL.md").is_file());

        let after_move = list_skills_in(Some(&vault), Some(&global));
        assert_eq!(after_move.len(), 2);
        assert!(after_move.iter().all(|s| s.scope == "global"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_skill_rejects_traversal_and_cleans_empty_dir() {
        let root = temp_dir("del");
        let vault = root.join("vault");
        let global = root.join("global");
        fs::create_dir_all(&vault).unwrap();
        fs::create_dir_all(&global).unwrap();

        assert!(delete_skill_in(Some(&vault), Some(&global), "vault:../escape").is_err());
        assert!(delete_skill_in(Some(&vault), Some(&global), "vault:foo/bar").is_err());
        assert!(delete_skill_in(Some(&vault), Some(&global), "invalid-id").is_err());

        save_skill_in(
            Some(&vault),
            Some(&global),
            &SaveSkillRequest {
                slug: "temp-skill".into(),
                name: None,
                description: "Disposable".into(),
                body: "Hello".into(),
                scope: "vault".into(),
                original_id: None,
            },
        )
        .unwrap();

        let removed_rel = delete_skill_in(Some(&vault), Some(&global), "vault:temp-skill").unwrap();
        assert_eq!(removed_rel.as_deref(), Some("skills/temp-skill/SKILL.md"));
        assert!(!vault.join("skills/temp-skill").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn skills_scan_ignores_flat_story_notes_and_missing_frontmatter() {
        let root = temp_dir("story_notes");
        let vault = root.join("vault");
        let skills_dir = vault.join("skills");
        fs::create_dir_all(skills_dir.join("draft-folder")).unwrap();

        // Ordinary novel story note in <vault>/skills/ (must never be loaded or deleted as a skill)
        let flat_note = skills_dir.join("character-abilities.md");
        fs::write(
            &flat_note,
            "---\nname: Ignore Me\n---\n\n# Rimuru's Unique Skills\n",
        )
        .unwrap();

        // Subfolder SKILL.md lacking YAML frontmatter (ignored until frontmatter is added)
        fs::write(
            skills_dir.join("draft-folder").join("SKILL.md"),
            "# Unfinished draft\nNo frontmatter yet.\n",
        )
        .unwrap();

        // Valid tracked skill with YAML frontmatter
        save_skill_in(
            Some(&vault),
            None,
            &SaveSkillRequest {
                slug: "character-abilities".into(),
                name: Some("Character Abilities".into()),
                description: "Track skill evolutions".into(),
                body: "List awakened skills.".into(),
                scope: "vault".into(),
                original_id: None,
            },
        )
        .unwrap();

        let listed = list_skills_in(Some(&vault), None);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].slug, "character-abilities");

        // Flat story note still exists after saving and deleting a skill of the same slug
        assert!(flat_note.is_file());
        delete_skill_in(Some(&vault), None, "vault:character-abilities").unwrap();
        assert!(flat_note.is_file());
        assert!(delete_skill_in(Some(&vault), None, "vault:draft-folder").is_err());

        let _ = fs::remove_dir_all(&root);
    }
}
