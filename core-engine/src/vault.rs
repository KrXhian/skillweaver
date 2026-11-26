use crate::markdown::{extract_links, extract_snippet, parse_markdown, rewrite_wikilinks, serialize_markdown, Block};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::{DirEntry, WalkDir};

const MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
static IMAGE_SEQ: AtomicU64 = AtomicU64::new(1);

/// Node in the sidebar file tree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileTreeNode {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub children: Vec<FileTreeNode>,
}

/// Flat index entry for `@@` autocomplete, `Ctrl+P` quick switcher, and link resolution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PageEntry {
    pub rel_path: String,
    pub title: String,
    pub link_target: String,
    pub folder: String,
}

/// Incoming reference from another `.md` file in the vault.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BacklinkEntry {
    pub source_rel_path: String,
    pub source_title: String,
    pub snippet: String,
}

/// Vault-wide search hit returned for AI context retrieval.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultSearchHit {
    pub rel_path: String,
    pub title: String,
    pub score: u32,
    pub excerpt: String,
}

/// Resolved page, heading section, or `^block-id` block excerpt.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedBlockRef {
    pub rel_path: String,
    pub title: String,
    pub anchor: Option<String>,
    pub content: String,
}

/// Node in the vault knowledge graph.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphNode {
    pub id: String,
    pub rel_path: Option<String>,
    pub label: String,
    pub folder: String,
    pub exists: bool,
    pub degree: usize,
}

/// Directed link edge in the vault knowledge graph.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

/// Complete link graph for all `.md` files and unresolved wikilinks in a vault.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Complete snapshot of an opened folder/vault.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultSnapshot {
    pub root_path: String,
    pub root_name: String,
    pub tree: Vec<FileTreeNode>,
    pub pages: Vec<PageEntry>,
    pub initial_file: Option<String>,
}

fn is_ignored_name(name: &str) -> bool {
    name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") || name.eq_ignore_ascii_case("target")
}

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn strip_md_ext(rel_path: &str) -> String {
    if rel_path.len() >= 3 && rel_path[rel_path.len() - 3..].eq_ignore_ascii_case(".md") {
        rel_path[..rel_path.len() - 3].to_string()
    } else {
        rel_path.to_string()
    }
}

fn ensure_md_ext(rel_path: &str) -> String {
    if rel_path.len() >= 3 && rel_path[rel_path.len() - 3..].eq_ignore_ascii_case(".md") {
        rel_path.to_string()
    } else {
        format!("{rel_path}.md")
    }
}

/// Normalizes a vault-relative path, rejecting traversal (`..`), drive prefixes, and null bytes.
pub fn normalize_rel_path(rel: &str) -> Result<String, String> {
    if rel.contains('\0') {
        return Err("Invalid path: null byte not allowed".to_string());
    }
    let replaced = rel.replace('\\', "/");
    let trimmed = replaced.trim().trim_start_matches('/').trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    let mut clean_parts = Vec::new();
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err("Invalid path: '..' traversal is not allowed".to_string());
        }
        if seg.contains(':') {
            return Err("Invalid path: drive prefixes are not allowed".to_string());
        }
        clean_parts.push(seg);
    }
    if clean_parts.is_empty() {
        return Err("Path cannot be empty".to_string());
    }
    Ok(clean_parts.join("/"))
}

/// Resolves a vault-relative path safely inside `root`, verifying canonical ancestry.
pub fn resolve_vault_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let normalized = normalize_rel_path(rel)?;
    let canon_root = fs::canonicalize(root)
        .map_err(|e| format!("Invalid vault root {}: {e}", root.display()))?;

    let mut candidate = canon_root.clone();
    for seg in normalized.split('/') {
        candidate.push(seg);
    }

    if candidate.exists() {
        let canon_target = fs::canonicalize(&candidate)
            .map_err(|e| format!("Failed to resolve path {}: {e}", candidate.display()))?;
        if !canon_target.starts_with(&canon_root) {
            return Err("Access denied: path escapes vault root".to_string());
        }
        return Ok(canon_target);
    }

    // Walk up to nearest existing ancestor and verify it stays inside `canon_root`.
    let mut ancestor = candidate.as_path();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| "Invalid path: no existing ancestor".to_string())?;
    }
    let canon_ancestor = fs::canonicalize(ancestor)
        .map_err(|e| format!("Failed to resolve ancestor {}: {e}", ancestor.display()))?;
    if !canon_ancestor.starts_with(&canon_root) {
        return Err("Access denied: path escapes vault root".to_string());
    }

    Ok(candidate)
}

fn build_tree_dir(root: &Path, dir: &Path, rel_prefix: &str) -> Result<Vec<FileTreeNode>, String> {
    let entries = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory {}: {e}", dir.display()))?;

    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for entry_res in entries {
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_name(&file_name) {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        // Skip symlinks pointing outside root
        if file_type.is_symlink() {
            let Ok(canon_entry) = fs::canonicalize(entry.path()) else {
                continue;
            };
            let Ok(canon_root) = fs::canonicalize(root) else {
                continue;
            };
            if !canon_entry.starts_with(&canon_root) {
                continue;
            }
        }

        let rel_path = if rel_prefix.is_empty() {
            file_name.clone()
        } else {
            format!("{rel_prefix}/{file_name}")
        };

        if entry.path().is_dir() {
            let children = build_tree_dir(root, &entry.path(), &rel_path)?;
            if rel_prefix.is_empty() && file_name.eq_ignore_ascii_case("assets") && children.is_empty() {
                continue;
            }
            dirs.push(FileTreeNode {
                name: file_name,
                rel_path,
                is_dir: true,
                children,
            });
        } else if entry.path().is_file() && is_markdown_file(&entry.path()) {
            files.push(FileTreeNode {
                name: file_name,
                rel_path,
                is_dir: false,
                children: Vec::new(),
            });
        }
    }

    let cmp_name = |a: &FileTreeNode, b: &FileTreeNode| -> Ordering {
        a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase())
    };
    dirs.sort_by(cmp_name);
    files.sort_by(cmp_name);

    dirs.extend(files);
    Ok(dirs)
}

/// Builds the recursive sidebar tree of folders and `.md` files.
pub fn build_tree(root: &Path) -> Result<Vec<FileTreeNode>, String> {
    if !root.is_dir() {
        return Err(format!("Folder does not exist: {}", root.display()));
    }
    build_tree_dir(root, root, "")
}

fn should_visit_entry(entry: &DirEntry, root_depth: usize) -> bool {
    if entry.depth() <= root_depth {
        return true;
    }
    let name = entry.file_name().to_string_lossy();
    !is_ignored_name(&name)
}

/// Returns all `.md` files in the vault as a sorted flat list of `PageEntry`.
pub fn list_pages(root: &Path) -> Result<Vec<PageEntry>, String> {
    if !root.is_dir() {
        return Err(format!("Folder does not exist: {}", root.display()));
    }
    let canon_root = fs::canonicalize(root)
        .map_err(|e| format!("Invalid vault root {}: {e}", root.display()))?;

    let mut pages = Vec::new();
    let walker = WalkDir::new(&canon_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| should_visit_entry(e, 0));

    for entry_res in walker {
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() || !is_markdown_file(entry.path()) {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(&canon_root) else {
            continue;
        };
        let rel_path = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("/");
        if rel_path.is_empty() {
            continue;
        }

        let link_target = strip_md_ext(&rel_path);
        let title = entry
            .path()
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| link_target.clone());
        let folder = match rel_path.rsplit_once('/') {
            Some((parent, _)) => parent.to_string(),
            None => String::new(),
        };

        pages.push(PageEntry {
            rel_path,
            title,
            link_target,
            folder,
        });
    }

    pages.sort_by(|a, b| {
        a.rel_path
            .to_ascii_lowercase()
            .cmp(&b.rel_path.to_ascii_lowercase())
    });

    Ok(pages)
}

/// Picks the initial `.md` file to open when loading a vault.
pub fn pick_initial_file(
    _root: &Path,
    pages: &[PageEntry],
    remembered_file: Option<&str>,
) -> Option<String> {
    if let Some(remembered) = remembered_file {
        if let Ok(norm) = normalize_rel_path(remembered) {
            if let Some(found) = pages
                .iter()
                .find(|p| p.rel_path.eq_ignore_ascii_case(&norm))
            {
                return Some(found.rel_path.clone());
            }
        }
    }

    if let Some(hero) = pages
        .iter()
        .find(|p| p.rel_path.eq_ignore_ascii_case("hero.md"))
    {
        return Some(hero.rel_path.clone());
    }

    pages.first().map(|p| p.rel_path.clone())
}

/// Converts a canonicalized path to a clean display string without Windows `\\?\` prefixes.
pub fn display_path_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        raw.into_owned()
    }
}

/// Builds a complete `VaultSnapshot` for an opened folder.
pub fn snapshot_vault(root: &Path, remembered_file: Option<&str>) -> Result<VaultSnapshot, String> {
    let canon_root = fs::canonicalize(root)
        .map_err(|e| format!("Failed to open folder {}: {e}", root.display()))?;
    let tree = build_tree(&canon_root)?;
    let pages = list_pages(&canon_root)?;
    let initial_file = pick_initial_file(&canon_root, &pages, remembered_file);
    let root_name = canon_root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| display_path_string(&canon_root));

    Ok(VaultSnapshot {
        root_path: display_path_string(&canon_root),
        root_name,
        tree,
        pages,
        initial_file,
    })
}

pub fn read_note(root: &Path, rel_path: &str) -> Result<String, String> {
    let full = resolve_vault_path(root, rel_path)?;
    if !full.is_file() {
        return Err(format!("Note does not exist: {rel_path}"));
    }
    fs::read_to_string(&full).map_err(|e| format!("Failed to read {rel_path}: {e}"))
}

/// Computes a fast deterministic 64-bit FNV-1a hex hash of file contents.
pub fn content_hash(content: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in content.as_bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Returns the file modification timestamp in Unix epoch milliseconds, if available.
pub fn read_note_mtime_ms(root: &Path, rel_path: &str) -> Option<u64> {
    let full = resolve_vault_path(root, rel_path).ok()?;
    let meta = fs::metadata(&full).ok()?;
    let modified = meta.modified().ok()?;
    let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis();
    u64::try_from(millis).ok()
}

pub fn write_note(root: &Path, rel_path: &str, content: &str) -> Result<(), String> {
    let full = resolve_vault_path(root, rel_path)?;
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent folder: {e}"))?;
    }
    fs::write(&full, content).map_err(|e| format!("Failed to save {rel_path}: {e}"))
}

pub fn create_note(root: &Path, rel_path: &str) -> Result<String, String> {
    let normalized = ensure_md_ext(&normalize_rel_path(rel_path)?);
    let full = resolve_vault_path(root, &normalized)?;
    if full.exists() {
        return Err(format!("Note already exists: {normalized}"));
    }
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent folder: {e}"))?;
    }
    fs::write(&full, "").map_err(|e| format!("Failed to create {normalized}: {e}"))?;
    Ok(normalized)
}

pub fn create_folder(root: &Path, rel_path: &str) -> Result<String, String> {
    let normalized = normalize_rel_path(rel_path)?;
    let full = resolve_vault_path(root, &normalized)?;
    if full.exists() {
        return Err(format!("Folder already exists: {normalized}"));
    }
    fs::create_dir_all(&full).map_err(|e| format!("Failed to create folder {normalized}: {e}"))?;
    Ok(normalized)
}

fn rewrite_links_across_vault(
    root: &Path,
    old_target: &str,
    old_basename: &str,
    new_target: &str,
    is_old_basename_unique: bool,
) -> Result<Vec<(String, String)>, String> {
    let pages = list_pages(root)?;
    let mut rewritten = Vec::new();
    for page in pages {
        if let Ok(content) = read_note(root, &page.rel_path) {
            let (updated, changed) = rewrite_wikilinks(
                &content,
                old_target,
                old_basename,
                new_target,
                is_old_basename_unique,
            );
            if changed {
                write_note(root, &page.rel_path, &updated)?;
                rewritten.push((page.rel_path, content_hash(&updated)));
            }
        }
    }
    Ok(rewritten)
}

/// Renames a `.md` file or folder inside the vault, updating incoming `[[wikilinks]]`
/// and returning `(new_rel_path, Vec<(rewritten_rel_path, content_hash)>)`.
pub fn rename_entry_tracked(
    root: &Path,
    old_rel: &str,
    new_rel: &str,
) -> Result<(String, Vec<(String, String)>), String> {
    let old_norm = normalize_rel_path(old_rel)?;
    let old_full = resolve_vault_path(root, &old_norm)?;
    if !old_full.exists() {
        return Err(format!("Path does not exist: {old_norm}"));
    }

    let is_dir = old_full.is_dir();
    let new_norm = if is_dir {
        normalize_rel_path(new_rel)?
    } else {
        ensure_md_ext(&normalize_rel_path(new_rel)?)
    };

    if old_norm.eq_ignore_ascii_case(&new_norm) && old_norm == new_norm {
        return Ok((new_norm, Vec::new()));
    }

    if is_dir
        && new_norm
            .to_ascii_lowercase()
            .starts_with(&format!("{}/", old_norm.to_ascii_lowercase()))
    {
        return Err("Cannot move a folder into itself".to_string());
    }

    let new_full = resolve_vault_path(root, &new_norm)?;
    // Allow case-only renames on Windows where old_full and new_full refer to the same file.
    if new_full.exists() && !old_norm.eq_ignore_ascii_case(&new_norm) {
        return Err(format!("Destination already exists: {new_norm}"));
    }

    if let Some(parent) = new_full.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination folder: {e}"))?;
    }

    // Collect pre-rename page metadata so we can update wikilinks accurately.
    let pages_before = list_pages(root)?;

    fs::rename(&old_full, &new_full)
        .map_err(|e| format!("Failed to rename {old_norm} to {new_norm}: {e}"))?;

    let mut rewritten = Vec::new();
    if !is_dir && is_markdown_file(&new_full) {
        let old_target = strip_md_ext(&old_norm);
        let new_target = strip_md_ext(&new_norm);
        let old_basename = old_target.rsplit('/').next().unwrap_or(&old_target);
        let basename_count = pages_before
            .iter()
            .filter(|p| p.title.eq_ignore_ascii_case(old_basename))
            .count();
        rewritten.extend(rewrite_links_across_vault(
            root,
            &old_target,
            old_basename,
            &new_target,
            basename_count <= 1,
        )?);
    } else if is_dir {
        let prefix = format!("{old_norm}/");
        for page in &pages_before {
            if let Some(rest) = page.rel_path.strip_prefix(&prefix) {
                let old_target = strip_md_ext(&page.rel_path);
                let new_rel_child = format!("{new_norm}/{rest}");
                let new_target = strip_md_ext(&new_rel_child);
                let old_basename = old_target.rsplit('/').next().unwrap_or(&old_target);
                let basename_count = pages_before
                    .iter()
                    .filter(|p| p.title.eq_ignore_ascii_case(old_basename))
                    .count();
                rewritten.extend(rewrite_links_across_vault(
                    root,
                    &old_target,
                    old_basename,
                    &new_target,
                    basename_count <= 1,
                )?);
            }
        }
    }

    Ok((new_norm, rewritten))
}

/// Renames a `.md` file or folder inside the vault, automatically updating incoming `[[wikilinks]]`.
pub fn rename_entry(root: &Path, old_rel: &str, new_rel: &str) -> Result<String, String> {
    rename_entry_tracked(root, old_rel, new_rel).map(|(new_norm, _)| new_norm)
}

pub fn delete_entry(root: &Path, rel_path: &str) -> Result<(), String> {
    let norm = normalize_rel_path(rel_path)?;
    let full = resolve_vault_path(root, &norm)?;
    let canon_root = fs::canonicalize(root)
        .map_err(|e| format!("Invalid vault root {}: {e}", root.display()))?;
    if full == canon_root {
        return Err("Cannot delete the vault root folder".to_string());
    }
    if !full.exists() {
        return Err(format!("Path does not exist: {norm}"));
    }
    if full.is_dir() {
        fs::remove_dir_all(&full).map_err(|e| format!("Failed to delete folder {norm}: {e}"))
    } else {
        fs::remove_file(&full).map_err(|e| format!("Failed to delete file {norm}: {e}"))
    }
}

fn clean_link_target(raw_target: &str) -> String {
    let no_anchor = raw_target.split('#').next().unwrap_or(raw_target).trim();
    let slashed = no_anchor.replace('\\', "/");
    let trimmed = slashed.trim_start_matches("./").trim_start_matches('/');
    strip_md_ext(trimmed)
}

/// Resolves a wikilink or relative markdown link target to a vault-relative `.md` path.
pub fn resolve_link(
    root: &Path,
    current_rel: Option<&str>,
    raw_target: &str,
) -> Result<Option<String>, String> {
    let target = clean_link_target(raw_target);
    if target.is_empty() {
        return Ok(None);
    }

    let pages = list_pages(root)?;

    // 1. Exact vault-relative `link_target` match (case-insensitive)
    if let Some(found) = pages
        .iter()
        .find(|p| p.link_target.eq_ignore_ascii_case(&target))
    {
        return Ok(Some(found.rel_path.clone()));
    }

    let current_folder = current_rel
        .and_then(|r| normalize_rel_path(r).ok())
        .and_then(|r| r.rsplit_once('/').map(|(dir, _)| dir.to_string()))
        .unwrap_or_default();

    // 2. Relative to current file's folder
    if !current_folder.is_empty() {
        let rel_candidate = format!("{current_folder}/{target}");
        if let Some(found) = pages
            .iter()
            .find(|p| p.link_target.eq_ignore_ascii_case(&rel_candidate))
        {
            return Ok(Some(found.rel_path.clone()));
        }
    }

    // 3. Basename match (prefer same folder, then shortest rel_path)
    let basename = target.rsplit('/').next().unwrap_or(&target);
    let mut matches: Vec<&PageEntry> = pages
        .iter()
        .filter(|p| p.title.eq_ignore_ascii_case(basename))
        .collect();
    if matches.is_empty() {
        return Ok(None);
    }

    matches.sort_by(|a, b| {
        let a_same = a.folder.eq_ignore_ascii_case(&current_folder);
        let b_same = b.folder.eq_ignore_ascii_case(&current_folder);
        b_same
            .cmp(&a_same)
            .then_with(|| a.rel_path.len().cmp(&b.rel_path.len()))
            .then_with(|| {
                a.rel_path
                    .to_ascii_lowercase()
                    .cmp(&b.rel_path.to_ascii_lowercase())
            })
    });

    Ok(Some(matches[0].rel_path.clone()))
}

/// Finds all notes in the vault that link to `target_rel`.
pub fn find_backlinks(root: &Path, target_rel: &str) -> Result<Vec<BacklinkEntry>, String> {
    let target_norm = normalize_rel_path(target_rel)?;
    let target_no_ext = strip_md_ext(&target_norm);
    let pages = list_pages(root)?;
    let mut backlinks = Vec::new();
    let mut seen_sources = HashSet::new();

    for page in &pages {
        if page.rel_path.eq_ignore_ascii_case(&target_norm) {
            continue;
        }
        let Ok(content) = read_note(root, &page.rel_path) else {
            continue;
        };
        let links = extract_links(&content);
        let mut matched_needle: Option<String> = None;

        for link in links {
            if let Ok(Some(resolved)) = resolve_link(root, Some(&page.rel_path), &link.target) {
                if resolved.eq_ignore_ascii_case(&target_norm) {
                    matched_needle = Some(link.target);
                    break;
                }
            }
        }

        if let Some(needle) = matched_needle {
            if seen_sources.insert(page.rel_path.to_ascii_lowercase()) {
                let snippet = extract_snippet(&content, &needle)
                    .if_empty_then(|| extract_snippet(&content, &target_no_ext));
                backlinks.push(BacklinkEntry {
                    source_rel_path: page.rel_path.clone(),
                    source_title: page.title.clone(),
                    snippet,
                });
            }
        }
    }

    Ok(backlinks)
}

const B64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encodes raw bytes as standard Base64.
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(B64_ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(B64_ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_ALPHABET[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_ALPHABET[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Decodes standard Base64 (ignoring ASCII whitespace).
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if clean.is_empty() {
        return Ok(Vec::new());
    }
    if clean.len() % 4 != 0 {
        return Err("Invalid base64 length".to_string());
    }

    let val = |b: u8| -> Result<u8, String> {
        match b {
            b'A'..=b'Z' => Ok(b - b'A'),
            b'a'..=b'z' => Ok(b - b'a' + 26),
            b'0'..=b'9' => Ok(b - b'0' + 52),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err("Invalid base64 character".to_string()),
        }
    };

    let mut out = Vec::with_capacity((clean.len() / 4) * 3);
    for (idx, chunk) in clean.chunks_exact(4).enumerate() {
        let is_last = idx == clean.len() / 4 - 1;
        if chunk[0] == b'=' || chunk[1] == b'=' {
            return Err("Invalid base64 padding".to_string());
        }
        let v0 = val(chunk[0])? as u32;
        let v1 = val(chunk[1])? as u32;

        match (chunk[2], chunk[3]) {
            (b'=', b'=') if is_last => {
                let triple = (v0 << 18) | (v1 << 12);
                out.push(((triple >> 16) & 0xFF) as u8);
            }
            (c2, b'=') if is_last => {
                let v2 = val(c2)? as u32;
                let triple = (v0 << 18) | (v1 << 12) | (v2 << 6);
                out.push(((triple >> 16) & 0xFF) as u8);
                out.push(((triple >> 8) & 0xFF) as u8);
            }
            (c2, c3) if c2 != b'=' && c3 != b'=' => {
                let v2 = val(c2)? as u32;
                let v3 = val(c3)? as u32;
                let triple = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
                out.push(((triple >> 16) & 0xFF) as u8);
                out.push(((triple >> 8) & 0xFF) as u8);
                out.push((triple & 0xFF) as u8);
            }
            _ => return Err("Invalid base64 padding".to_string()),
        }
    }
    Ok(out)
}

fn decode_percent_spaces(s: &str) -> String {
    s.replace("%20", " ")
}

fn resolve_relative_stack(base_segments: &[&str], rel_src: &str) -> Result<String, String> {
    if rel_src.contains('\0') || rel_src.contains(':') {
        return Err("Invalid image path".to_string());
    }
    let mut stack: Vec<String> = base_segments.iter().map(|s| (*s).to_string()).collect();
    for seg in rel_src.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if stack.pop().is_none() {
                return Err("Image path escapes vault root".to_string());
            }
        } else {
            stack.push(seg.to_string());
        }
    }
    if stack.is_empty() {
        return Err("Image path cannot be empty".to_string());
    }
    Ok(stack.join("/"))
}

fn resolve_image_path(
    root: &Path,
    current_rel: Option<&str>,
    src: &str,
) -> Result<PathBuf, String> {
    let trimmed = decode_percent_spaces(src.trim()).replace('\\', "/");
    let clean = trimmed
        .split('#')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("")
        .trim();
    if clean.is_empty() || clean.contains('\0') || clean.contains(':') {
        return Err("Invalid image path".to_string());
    }

    let canon_root = fs::canonicalize(root)
        .map_err(|e| format!("Invalid vault root {}: {e}", root.display()))?;

    let mut candidates: Vec<String> = Vec::new();
    let current_dir_segments: Vec<String> = current_rel
        .and_then(|r| normalize_rel_path(r).ok())
        .and_then(|r| r.rsplit_once('/').map(|(d, _)| d.to_string()))
        .map(|d| d.split('/').map(|s| s.to_string()).collect())
        .unwrap_or_default();

    if !clean.starts_with('/') && !current_dir_segments.is_empty() {
        let refs: Vec<&str> = current_dir_segments.iter().map(String::as_str).collect();
        if let Ok(rel_joined) = resolve_relative_stack(&refs, clean) {
            candidates.push(rel_joined);
        }
    }

    let root_trimmed = clean.trim_start_matches('/');
    if let Ok(root_norm) = resolve_relative_stack(&[], root_trimmed) {
        if !candidates.iter().any(|c| c == &root_norm) {
            candidates.push(root_norm.clone());
        }
        if !root_norm.contains('/') {
            candidates.push(format!("assets/{root_norm}"));
        }
    }

    let stripped_up = root_trimmed.trim_start_matches("../");
    if stripped_up != root_trimmed {
        if let Ok(up_norm) = resolve_relative_stack(&[], stripped_up) {
            if !candidates.iter().any(|c| c == &up_norm) {
                candidates.push(up_norm.clone());
            }
            if !up_norm.contains('/') {
                candidates.push(format!("assets/{up_norm}"));
            }
        }
    }

    if candidates.is_empty() {
        return Err("Image path escapes vault root".to_string());
    }

    for rel_candidate in candidates {
        if let Ok(resolved) = resolve_vault_path(&canon_root, &rel_candidate) {
            if resolved.is_file() {
                return Ok(resolved);
            }
        }
    }

    Err(format!("Image file not found: {src}"))
}

fn image_ext_from_mime(subtype: &str) -> Result<&'static str, String> {
    match subtype.to_ascii_lowercase().as_str() {
        "png" => Ok("png"),
        "jpeg" | "jpg" => Ok("jpg"),
        "gif" => Ok("gif"),
        "webp" => Ok("webp"),
        "bmp" => Ok("bmp"),
        other => Err(format!("Unsupported pasted image type: image/{other}")),
    }
}

fn mime_from_image_ext(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Saves a pasted `data:image/...;base64,...` image into `<vault>/assets/` and returns
/// `(markdown_src, data_url)` with `markdown_src` relative to `current_rel`.
pub fn save_pasted_image(
    root: &Path,
    current_rel: Option<&str>,
    data_url: &str,
) -> Result<(String, String), String> {
    let rest = data_url
        .strip_prefix("data:image/")
        .ok_or_else(|| "Expected data:image/... URL".to_string())?;
    let (meta, payload) = rest
        .split_once(',')
        .ok_or_else(|| "Malformed image data URL".to_string())?;
    let subtype = meta
        .split(';')
        .next()
        .ok_or_else(|| "Missing image MIME subtype".to_string())?
        .trim();
    if !meta.to_ascii_lowercase().contains(";base64") {
        return Err("Only base64 image data URLs are supported".to_string());
    }

    let ext = image_ext_from_mime(subtype)?;
    let bytes = base64_decode(payload)?;
    if bytes.is_empty() {
        return Err("Image data is empty".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image exceeds 25 MB limit".to_string());
    }

    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = IMAGE_SEQ.fetch_add(1, AtomicOrdering::Relaxed);
    let rel_asset = format!("assets/pasted-{epoch_ms}-{seq}.{ext}");

    let dest = resolve_vault_path(root, &rel_asset)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create assets folder: {e}"))?;
    }
    fs::write(&dest, &bytes).map_err(|e| format!("Failed to write image {rel_asset}: {e}"))?;

    let depth = current_rel
        .and_then(|r| normalize_rel_path(r).ok())
        .map(|r| r.matches('/').count())
        .unwrap_or(0);
    let md_src = if depth == 0 {
        rel_asset
    } else {
        format!("{}{}", "../".repeat(depth), rel_asset)
    };

    Ok((md_src, data_url.to_string()))
}

/// Reads an image inside the vault and returns a `data:<mime>;base64,...` URL.
pub fn read_image_data_url(
    root: &Path,
    current_rel: Option<&str>,
    src: &str,
) -> Result<String, String> {
    let path = resolve_image_path(root, current_rel, src)?;
    let meta = fs::metadata(&path).map_err(|e| format!("Failed to stat image: {e}"))?;
    if meta.len() > MAX_IMAGE_BYTES as u64 {
        return Err("Image exceeds 25 MB limit".to_string());
    }
    let bytes = fs::read(&path).map_err(|e| format!("Failed to read image: {e}"))?;
    let mime = mime_from_image_ext(&path);
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

fn is_stopword(term: &str) -> bool {
    matches!(
        term,
        "the"
            | "and"
            | "for"
            | "with"
            | "this"
            | "that"
            | "from"
            | "what"
            | "when"
            | "where"
            | "which"
            | "who"
            | "how"
            | "can"
            | "you"
            | "are"
            | "was"
            | "were"
            | "have"
            | "has"
            | "not"
            | "but"
            | "into"
            | "about"
    )
}

fn tokenize_search_query(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    for raw in query.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-') {
        let lower = raw.trim().to_ascii_lowercase();
        if lower.len() >= 2 && !is_stopword(&lower) && !terms.contains(&lower) {
            terms.push(lower);
        }
    }
    terms
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let s: String = text.chars().take(max_chars.saturating_sub(1)).collect();
        format!("{s}…")
    }
}

/// Searches all `.md` files in the vault and returns top matching excerpts for AI context.
pub fn search_vault(
    root: &Path,
    query: &str,
    exclude_rel: Option<&str>,
    max_files: usize,
) -> Result<Vec<VaultSearchHit>, String> {
    let terms = tokenize_search_query(query);
    if terms.is_empty() || max_files == 0 {
        return Ok(Vec::new());
    }

    let exclude_norm = exclude_rel.and_then(|r| normalize_rel_path(r).ok());
    let pages = list_pages(root)?;
    let mut hits = Vec::new();

    for page in pages {
        if let Some(ref ex) = exclude_norm {
            if page.rel_path.eq_ignore_ascii_case(ex) {
                continue;
            }
        }

        let Ok(content) = read_note(root, &page.rel_path) else {
            continue;
        };

        let mut score = 0u32;
        let title_lower = page.title.to_ascii_lowercase();
        let path_lower = page.rel_path.to_ascii_lowercase();
        for term in &terms {
            if title_lower.contains(term) {
                score += 6;
            } else if path_lower.contains(term) {
                score += 4;
            }
        }

        let lines: Vec<&str> = content.lines().collect();
        let mut matched_indices = HashSet::new();
        for (idx, line) in lines.iter().enumerate() {
            let lower = line.to_ascii_lowercase();
            let mut line_hits = 0u32;
            for term in &terms {
                if lower.contains(term) {
                    line_hits += 1;
                }
            }
            if line_hits > 0 {
                score += line_hits * 2;
                matched_indices.insert(idx);
                if idx + 1 < lines.len() && !lines[idx + 1].trim().is_empty() {
                    matched_indices.insert(idx + 1);
                }
            }
        }

        if score == 0 {
            continue;
        }

        let mut sorted_idxs: Vec<usize> = matched_indices.into_iter().collect();
        sorted_idxs.sort_unstable();
        let mut excerpt_lines = Vec::new();
        let mut total_len = 0usize;
        for idx in sorted_idxs {
            let line = lines[idx].trim_end();
            if line.is_empty() {
                continue;
            }
            if total_len + line.len() > 1100 {
                break;
            }
            total_len += line.len() + 1;
            excerpt_lines.push(line);
        }

        let excerpt = if excerpt_lines.is_empty() {
            truncate_chars(content.trim(), 400)
        } else {
            truncate_chars(&excerpt_lines.join("\n"), 1200)
        };

        hits.push(VaultSearchHit {
            rel_path: page.rel_path,
            title: page.title,
            score,
            excerpt,
        });
    }

    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    hits.truncate(max_files);
    Ok(hits)
}

fn block_ref_id(block: &Block) -> Option<&str> {
    match block {
        Block::Heading { block_id, .. }
        | Block::Paragraph { block_id, .. }
        | Block::BulletList { block_id, .. }
        | Block::NumberedList { block_id, .. }
        | Block::Todo { block_id, .. }
        | Block::Quote { block_id, .. }
        | Block::Divider { block_id, .. }
        | Block::Code { block_id, .. }
        | Block::Image { block_id, .. }
        | Block::Table { block_id, .. } => block_id.as_deref(),
    }
}

/// Resolves a page, heading section, or `^block-id` reference for AI context or previews.
pub fn resolve_block_reference(
    root: &Path,
    current_rel: Option<&str>,
    raw_ref: &str,
) -> Result<Option<ResolvedBlockRef>, String> {
    let trimmed = raw_ref.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let (page_part, anchor_opt) = match trimmed.split_once('#') {
        Some((p, a)) => (p.trim(), Some(a.trim().to_string()).filter(|s| !s.is_empty())),
        None => (trimmed, None),
    };

    let target_rel = if page_part.is_empty() {
        match current_rel.and_then(|r| normalize_rel_path(r).ok()) {
            Some(rel) => rel,
            None => return Ok(None),
        }
    } else {
        match resolve_link(root, current_rel, page_part)? {
            Some(rel) => rel,
            None => return Ok(None),
        }
    };

    let raw_md = read_note(root, &target_rel)?;
    let title = Path::new(&target_rel)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| target_rel.clone());

    let content = if let Some(ref anchor) = anchor_opt {
        let blocks = parse_markdown(&raw_md);
        if let Some(bid) = anchor.strip_prefix('^') {
            if let Some(found) = blocks
                .into_iter()
                .find(|b| block_ref_id(b).map(|x| x.eq_ignore_ascii_case(bid)).unwrap_or(false))
            {
                serialize_markdown(&[found]).trim().to_string()
            } else {
                return Ok(None);
            }
        } else {
            let mut section_blocks = Vec::new();
            let mut active_level: Option<u8> = None;
            for b in blocks {
                if let Some(lvl) = active_level {
                    if let Block::Heading { level, .. } = &b {
                        if *level <= lvl {
                            break;
                        }
                    }
                    section_blocks.push(b);
                } else if let Block::Heading { level, content, .. } = &b {
                    if content.trim().eq_ignore_ascii_case(anchor) {
                        active_level = Some(*level);
                        section_blocks.push(b);
                    }
                }
            }
            if section_blocks.is_empty() {
                return Ok(None);
            }
            truncate_chars(serialize_markdown(&section_blocks).trim(), 4000)
        }
    } else {
        truncate_chars(raw_md.trim(), 4000)
    };

    Ok(Some(ResolvedBlockRef {
        rel_path: target_rel,
        title,
        anchor: anchor_opt,
        content,
    }))
}

fn is_external_or_asset_target(target: &str) -> bool {
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || lower.starts_with("data:")
    {
        return true;
    }
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// Builds the full note/wikilink graph across all `.md` files in the vault.
pub fn build_vault_graph(root: &Path) -> Result<VaultGraph, String> {
    let pages = list_pages(root)?;
    let mut nodes: Vec<GraphNode> = Vec::with_capacity(pages.len());
    let mut index_by_id: HashMap<String, usize> = HashMap::new();

    for page in &pages {
        let idx = nodes.len();
        index_by_id.insert(page.rel_path.clone(), idx);
        nodes.push(GraphNode {
            id: page.rel_path.clone(),
            rel_path: Some(page.rel_path.clone()),
            label: page.title.clone(),
            folder: page.folder.clone(),
            exists: true,
            degree: 0,
        });
    }

    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();

    for page in &pages {
        let Ok(raw_md) = read_note(root, &page.rel_path) else {
            continue;
        };
        let links = extract_links(&raw_md);
        for link in links {
            let base_target = link.target.split('#').next().unwrap_or(&link.target).trim();
            if base_target.is_empty() || is_external_or_asset_target(base_target) {
                continue;
            }

            let resolved = resolve_link(root, Some(&page.rel_path), base_target)?;
            let target_id = if let Some(target_rel) = resolved {
                target_rel
            } else {
                let clean_label = base_target
                    .trim_matches('/')
                    .strip_suffix(".md")
                    .unwrap_or(base_target.trim_matches('/'))
                    .trim();
                if clean_label.is_empty() {
                    continue;
                }
                let ghost_id = format!("unresolved:{}", clean_label.to_ascii_lowercase());
                if !index_by_id.contains_key(&ghost_id) {
                    let idx = nodes.len();
                    index_by_id.insert(ghost_id.clone(), idx);
                    nodes.push(GraphNode {
                        id: ghost_id.clone(),
                        rel_path: None,
                        label: clean_label.to_string(),
                        folder: String::new(),
                        exists: false,
                        degree: 0,
                    });
                }
                ghost_id
            };

            if target_id == page.rel_path {
                continue;
            }
            let edge_key = (page.rel_path.clone(), target_id.clone());
            if seen_edges.insert(edge_key) {
                if let Some(&src_idx) = index_by_id.get(&page.rel_path) {
                    nodes[src_idx].degree += 1;
                }
                if let Some(&dst_idx) = index_by_id.get(&target_id) {
                    nodes[dst_idx].degree += 1;
                }
                edges.push(GraphEdge {
                    source: page.rel_path.clone(),
                    target: target_id,
                });
            }
        }
    }

    Ok(VaultGraph { nodes, edges })
}

trait StrExt {
    fn if_empty_then<F: FnOnce() -> String>(self, f: F) -> String;
}

impl StrExt for String {
    fn if_empty_then<F: FnOnce() -> String>(self, f: F) -> String {
        if self.is_empty() {
            f()
        } else {
            self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_vault(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("skillweaver_vault_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn path_traversal_and_drive_prefixes_are_rejected() {
        let root = temp_vault("sec");
        assert!(normalize_rel_path("../evil.md").is_err());
        assert!(normalize_rel_path("folder/../../evil.md").is_err());
        assert!(normalize_rel_path("C:\\Windows\\system32").is_err());
        assert!(resolve_vault_path(&root, "../outside.md").is_err());
        assert!(resolve_vault_path(&root, "ok/note.md").is_ok());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn tree_sorting_ignores_hidden_and_picks_hero_md() {
        let root = temp_vault("tree");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git").join("ignored.md"), "skip").unwrap();
        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::write(root.join("alpha").join("plan.md"), "# Plan\n").unwrap();
        fs::write(root.join("zebra.md"), "# Zebra\n").unwrap();
        fs::write(root.join("hero.md"), "# Hero\n").unwrap();
        fs::write(root.join("readme.txt"), "not markdown").unwrap();

        let snap = snapshot_vault(&root, None).unwrap();
        assert_eq!(snap.initial_file.as_deref(), Some("hero.md"));
        assert_eq!(snap.tree.len(), 3);
        assert!(snap.tree[0].is_dir);
        assert_eq!(snap.tree[0].name, "alpha");
        assert_eq!(snap.tree[1].name, "hero.md");
        assert_eq!(snap.tree[2].name, "zebra.md");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn crud_rename_rewrites_wikilinks_and_finds_backlinks() {
        let root = temp_vault("links");
        create_note(&root, "hero").unwrap();
        create_note(&root, "notes/design").unwrap();
        create_note(&root, "notes/other").unwrap();

        write_note(
            &root,
            "hero.md",
            "# Hero\n\nCheck [[notes/design|Design Doc]] and [[other]].\n",
        )
        .unwrap();
        write_note(&root, "notes/design.md", "# Design\n\nBack to [[hero]].\n").unwrap();
        write_note(&root, "notes/other.md", "# Other\n\nAlso [[design]].\n").unwrap();

        // Backlinks to notes/design.md should include hero.md and notes/other.md
        let bl = find_backlinks(&root, "notes/design.md").unwrap();
        let sources: Vec<&str> = bl.iter().map(|b| b.source_rel_path.as_str()).collect();
        assert_eq!(sources, vec!["hero.md", "notes/other.md"]);

        // Rename notes/design.md -> notes/architecture.md
        let renamed = rename_entry(&root, "notes/design.md", "notes/architecture").unwrap();
        assert_eq!(renamed, "notes/architecture.md");

        let hero_after = read_note(&root, "hero.md").unwrap();
        assert!(hero_after.contains("[[notes/architecture|Design Doc]]"));
        let other_after = read_note(&root, "notes/other.md").unwrap();
        assert!(other_after.contains("[[notes/architecture]]"));

        // Resolve link relative and by basename
        assert_eq!(
            resolve_link(&root, Some("notes/other.md"), "architecture").unwrap(),
            Some("notes/architecture.md".to_string())
        );

        // Delete entry
        delete_entry(&root, "notes/other.md").unwrap();
        assert!(!root.join("notes/other.md").exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn base64_round_trip() {
        for sample in [b"".as_slice(), b"a", b"ab", b"abc", b"hello skillweaver!"] {
            let enc = base64_encode(sample);
            let dec = base64_decode(&enc).unwrap();
            assert_eq!(dec, sample);
        }
        assert!(base64_decode("abc").is_err());
        assert!(base64_decode("ab*=").is_err());
    }

    #[test]
    fn save_pasted_image_and_read_data_url_with_assets_tree_omission() {
        let root = temp_vault("images");
        create_note(&root, "hero").unwrap();
        create_note(&root, "notes/sub").unwrap();

        let png_bytes = vec![137u8, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4];
        let input_url = format!("data:image/png;base64,{}", base64_encode(&png_bytes));

        let (root_src, _) = save_pasted_image(&root, Some("hero.md"), &input_url).unwrap();
        assert!(root_src.starts_with("assets/pasted-") && root_src.ends_with(".png"));
        assert_eq!(
            read_image_data_url(&root, Some("hero.md"), &root_src).unwrap(),
            input_url
        );

        let (sub_src, _) = save_pasted_image(&root, Some("notes/sub.md"), &input_url).unwrap();
        assert!(sub_src.starts_with("../assets/pasted-") && sub_src.ends_with(".png"));
        assert_eq!(
            read_image_data_url(&root, Some("notes/sub.md"), &sub_src).unwrap(),
            input_url
        );

        // Traversal outside vault must fail
        assert!(read_image_data_url(&root, Some("notes/sub.md"), "../../secret.png").is_err());

        // Empty-of-markdown assets/ folder should be omitted from sidebar tree
        let tree = build_tree(&root).unwrap();
        assert!(!tree.iter().any(|n| n.name.eq_ignore_ascii_case("assets")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn search_vault_and_resolve_block_reference_find_exact_content() {
        let root = temp_vault("ai_search");
        create_note(&root, "hero").unwrap();
        create_note(&root, "notes/hop-server").unwrap();

        write_note(
            &root,
            "hero.md",
            "# Overview\n\nNothing relevant here.\n",
        )
        .unwrap();
        write_note(
            &root,
            "notes/hop-server.md",
            "# Architecture\n\nHop Server executes workflows safely. ^hop123\n\n## Next\n\nAnother section.\n",
        )
        .unwrap();

        let hits = search_vault(&root, "How does Hop Server execute workflows?", Some("hero.md"), 4).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel_path, "notes/hop-server.md");
        assert!(hits[0].excerpt.contains("Hop Server executes workflows safely"));

        let block_ref = resolve_block_reference(&root, Some("hero.md"), "hop-server#^hop123")
            .unwrap()
            .unwrap();
        assert_eq!(block_ref.rel_path, "notes/hop-server.md");
        assert!(block_ref.content.contains("Hop Server executes workflows safely."));

        let heading_ref = resolve_block_reference(&root, Some("hero.md"), "notes/hop-server#Architecture")
            .unwrap()
            .unwrap();
        assert!(heading_ref.content.contains("# Architecture"));
        assert!(heading_ref.content.contains("Hop Server executes workflows safely"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_note_between_root_and_folder_and_reject_folder_cycle() {
        let root = temp_vault("move_entry");
        create_folder(&root, "01 - Data").unwrap();
        create_folder(&root, "01 - Data/sub").unwrap();
        create_note(&root, "01 - Data Test").unwrap();
        create_note(&root, "index").unwrap();

        write_note(&root, "index.md", "See [[01 - Data Test]]\n").unwrap();

        // Move root note -> 01 - Data/01 - Data Test.md
        let moved = rename_entry(&root, "01 - Data Test.md", "01 - Data/01 - Data Test.md").unwrap();
        assert_eq!(moved, "01 - Data/01 - Data Test.md");
        assert!(read_note(&root, "index.md")
            .unwrap()
            .contains("[[01 - Data/01 - Data Test]]"));

        // Move subfolder note -> root
        let moved_back =
            rename_entry(&root, "01 - Data/01 - Data Test.md", "01 - Data Test.md").unwrap();
        assert_eq!(moved_back, "01 - Data Test.md");
        assert!(read_note(&root, "index.md")
            .unwrap()
            .contains("[[01 - Data Test]]"));

        // Reject moving folder into its own descendant
        assert!(rename_entry(&root, "01 - Data", "01 - Data/sub/01 - Data").is_err());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn build_vault_graph_links_existing_and_unresolved_notes() {
        let root = temp_vault("graph");
        create_folder(&root, "sub").unwrap();
        create_note(&root, "alpha").unwrap();
        create_note(&root, "sub/beta").unwrap();
        create_note(&root, "orphan").unwrap();

        write_note(
            &root,
            "alpha.md",
            "Links to [[sub/beta]], [[sub/beta#Heading]], and [[Missing Note]].\n",
        )
        .unwrap();
        write_note(&root, "sub/beta.md", "Back to [[alpha]].\n").unwrap();

        let graph = build_vault_graph(&root).unwrap();
        assert_eq!(graph.nodes.len(), 4);
        assert_eq!(graph.edges.len(), 3);

        let alpha = graph.nodes.iter().find(|n| n.id == "alpha.md").unwrap();
        assert!(alpha.exists);
        assert_eq!(alpha.degree, 3);

        let orphan = graph.nodes.iter().find(|n| n.id == "orphan.md").unwrap();
        assert_eq!(orphan.degree, 0);

        let ghost = graph
            .nodes
            .iter()
            .find(|n| !n.exists && n.label == "Missing Note")
            .unwrap();
        assert_eq!(ghost.degree, 1);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_block_reference_finds_table_block_id() {
        let root = temp_vault("table_ref");
        create_note(&root, "hero").unwrap();
        create_note(&root, "matrix").unwrap();

        write_note(
            &root,
            "matrix.md",
            "# Matrix\n\n| Col A | Col B |\n| --- | --- |\n| 1 | 2 |\n^tbl123\n",
        )
        .unwrap();

        let table_ref = resolve_block_reference(&root, Some("hero.md"), "matrix#^tbl123")
            .unwrap()
            .unwrap();
        assert_eq!(table_ref.rel_path, "matrix.md");
        assert!(table_ref.content.contains("| Col A | Col B |"));
        assert!(table_ref.content.contains("| 1 | 2 |"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn content_hash_is_deterministic_and_sensitive() {
        let h1 = content_hash("# Hello\n\nWorld\n");
        let h2 = content_hash("# Hello\n\nWorld\n");
        let h3 = content_hash("# Hello\n\nWorld!\n");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
        assert_eq!(h1.len(), 16);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn read_note_mtime_ms_returns_some_for_existing_and_none_for_missing() {
        let root = temp_vault("mtime");
        create_note(&root, "alpha").unwrap();
        write_note(&root, "alpha.md", "hello").unwrap();

        assert!(read_note_mtime_ms(&root, "alpha.md").is_some());
        assert!(read_note_mtime_ms(&root, "missing.md").is_none());

        let _ = fs::remove_dir_all(&root);
    }
}
