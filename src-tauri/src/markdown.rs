use serde::{Deserialize, Serialize};

/// A single editable block inside a Skillweaver markdown document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Heading {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        level: u8,
        content: String,
    },
    Paragraph {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outdent: Option<u8>,
        content: String,
    },
    Code {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outdent: Option<u8>,
        language: String,
        content: String,
    },
    Image {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outdent: Option<u8>,
        src: String,
        alt: String,
    },
}

/// A link extracted from a markdown file outside of code blocks/spans.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedLink {
    pub target: String,
    pub label: Option<String>,
}

struct FenceStart {
    ch: char,
    len: usize,
    language: String,
}

fn next_id(counter: &mut usize) -> String {
    *counter += 1;
    format!("b-{}", *counter)
}

fn parse_fence_open(line: &str) -> Option<FenceStart> {
    let leading_spaces = line.bytes().take_while(|&b| b == b' ').count();
    if leading_spaces > 3 {
        return None;
    }
    let rest = &line[leading_spaces..];
    let first = rest.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let len = rest.chars().take_while(|&c| c == first).count();
    if len < 3 {
        return None;
    }
    let info = rest[len..].trim();
    // CommonMark forbids backticks in the info string of a backtick code fence.
    if first == '`' && info.contains('`') {
        return None;
    }
    let language = info.split_whitespace().next().unwrap_or("").to_string();
    Some(FenceStart {
        ch: first,
        len,
        language,
    })
}

fn is_fence_close(line: &str, fence_char: char, min_len: usize) -> bool {
    let leading_spaces = line.bytes().take_while(|&b| b == b' ').count();
    if leading_spaces > 3 {
        return false;
    }
    let rest = &line[leading_spaces..];
    let len = rest.chars().take_while(|&c| c == fence_char).count();
    if len < min_len {
        return false;
    }
    rest[len..].trim().is_empty()
}

fn parse_atx_heading(line: &str) -> Option<(u8, String)> {
    let leading_spaces = line.bytes().take_while(|&b| b == b' ').count();
    if leading_spaces > 3 {
        return None;
    }
    let rest = &line[leading_spaces..];
    let level = rest.bytes().take_while(|&b| b == b'#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let after_hashes = &rest[level..];
    if !after_hashes.is_empty()
        && !after_hashes.starts_with(' ')
        && !after_hashes.starts_with('\t')
    {
        return None;
    }
    let mut text = after_hashes.trim();
    // Strip optional closing sequence of `#` preceded by whitespace.
    let trimmed_end = text.trim_end_matches('#');
    if trimmed_end.len() < text.len()
        && (trimmed_end.is_empty() || trimmed_end.ends_with(' ') || trimmed_end.ends_with('\t'))
    {
        text = trimmed_end.trim_end();
    }
    Some((level as u8, text.to_string()))
}

fn parse_legacy_summary(trimmed: &str) -> Option<String> {
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("<summary") {
        return None;
    }
    let open_end = trimmed.find('>')?;
    let close_start = lower.rfind("</summary>")?;
    if close_start <= open_end {
        return None;
    }
    let inner = trimmed[open_end + 1..close_start].trim();
    Some(inner.to_string())
}

fn has_image_extension(path: &str) -> bool {
    let clean = path.split('#').next().unwrap_or(path).split('?').next().unwrap_or(path).trim();
    let lower = clean.to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn parse_image_line(trimmed: &str) -> Option<(String, String)> {
    if trimmed.starts_with("![[") && trimmed.ends_with("]]") && !trimmed[3..trimmed.len() - 2].contains("]]") {
        let inner = trimmed[3..trimmed.len() - 2].trim();
        let (target, alt) = match inner.split_once('|') {
            Some((t, a)) => (t.trim(), a.trim().to_string()),
            None => (inner, String::new()),
        };
        if !target.is_empty() && has_image_extension(target) {
            return Some((target.to_string(), alt));
        }
        return None;
    }

    if trimmed.starts_with("![") && trimmed.ends_with(')') {
        let after_bang = &trimmed[2..trimmed.len() - 1];
        // Find the `](` boundary (handling escaped `\]` in alt text)
        let bytes = after_bang.as_bytes();
        let mut idx = 0usize;
        while idx + 1 < bytes.len() {
            if bytes[idx] == b'\\' {
                idx += 2;
                continue;
            }
            if bytes[idx] == b']' && bytes[idx + 1] == b'(' {
                let raw_alt = &after_bang[..idx];
                let raw_src = after_bang[idx + 2..].trim();
                let src = raw_src
                    .strip_prefix('<')
                    .and_then(|s| s.strip_suffix('>'))
                    .unwrap_or(raw_src)
                    .trim();
                if !src.is_empty() && !src.contains('\n') {
                    let alt = raw_alt.replace("\\]", "]");
                    return Some((src.to_string(), alt));
                }
                return None;
            }
            if bytes[idx] == b']' {
                return None;
            }
            idx += 1;
        }
    }

    None
}

fn is_valid_block_id(s: &str) -> bool {
    (4..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn strip_trailing_block_id(text: &str) -> (&str, Option<String>) {
    let trimmed = text.trim_end();
    let Some(caret_pos) = trimmed.rfind('^') else {
        return (text, None);
    };
    let candidate = &trimmed[caret_pos + 1..];
    if !is_valid_block_id(candidate) {
        return (text, None);
    }
    if caret_pos == 0 {
        return ("", Some(candidate.to_string()));
    }
    let prev = trimmed.as_bytes()[caret_pos - 1];
    if prev == b' ' || prev == b'\t' || prev == b'\n' {
        let head = trimmed[..caret_pos].trim_end_matches([' ', '\t']);
        return (head, Some(candidate.to_string()));
    }
    (text, None)
}

fn parse_standalone_block_id_line(trimmed: &str) -> Option<String> {
    let rest = trimmed.strip_prefix('^')?;
    if is_valid_block_id(rest) {
        Some(rest.to_string())
    } else {
        None
    }
}

fn parse_outdent_comment(trimmed: &str) -> Option<u8> {
    let inner = trimmed.strip_prefix("<!--")?.strip_suffix("-->")?.trim();
    let val = inner.strip_prefix("outdent:")?.trim();
    let n = val.parse::<u8>().ok()?;
    if (1..=4).contains(&n) {
        Some(n)
    } else {
        None
    }
}

/// Parses a Markdown string into Skillweaver editor blocks.
pub fn parse_markdown(input: &str) -> Vec<Block> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks = Vec::new();
    let mut counter = 0usize;
    let mut para_lines: Vec<&str> = Vec::new();
    let mut pending_outdent: Option<u8> = None;

    let flush_para = |para_lines: &mut Vec<&str>,
                      blocks: &mut Vec<Block>,
                      counter: &mut usize,
                      pending_outdent: &mut Option<u8>| {
        if !para_lines.is_empty() {
            let joined = para_lines.join("\n");
            para_lines.clear();
            let (clean, block_id) = strip_trailing_block_id(&joined);
            blocks.push(Block::Paragraph {
                id: next_id(counter),
                block_id,
                outdent: pending_outdent.take(),
                content: clean.to_string(),
            });
        }
    };

    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];

        if let Some(fence) = parse_fence_open(line) {
            flush_para(&mut para_lines, &mut blocks, &mut counter, &mut pending_outdent);
            let mut code_lines = Vec::new();
            i += 1;
            while i < lines.len() {
                if is_fence_close(lines[i], fence.ch, fence.len) {
                    i += 1;
                    break;
                }
                code_lines.push(lines[i]);
                i += 1;
            }
            blocks.push(Block::Code {
                id: next_id(&mut counter),
                block_id: None,
                outdent: pending_outdent.take(),
                language: fence.language,
                content: code_lines.join("\n"),
            });
            continue;
        }

        let trimmed = line.trim();
        let lower_trimmed = trimmed.to_ascii_lowercase();

        if lower_trimmed.starts_with("<details") || lower_trimmed == "</details>" {
            flush_para(&mut para_lines, &mut blocks, &mut counter, &mut pending_outdent);
            i += 1;
            continue;
        }

        if let Some(outdent_val) = parse_outdent_comment(trimmed) {
            flush_para(&mut para_lines, &mut blocks, &mut counter, &mut pending_outdent);
            pending_outdent = Some(outdent_val);
            i += 1;
            continue;
        }

        if let Some(summary) = parse_legacy_summary(trimmed) {
            flush_para(&mut para_lines, &mut blocks, &mut counter, &mut pending_outdent);
            pending_outdent = None;
            let (clean, block_id) = strip_trailing_block_id(&summary);
            blocks.push(Block::Heading {
                id: next_id(&mut counter),
                block_id,
                level: 2,
                content: clean.to_string(),
            });
            i += 1;
            continue;
        }

        if let Some((level, content)) = parse_atx_heading(line) {
            flush_para(&mut para_lines, &mut blocks, &mut counter, &mut pending_outdent);
            pending_outdent = None;
            let (clean, block_id) = strip_trailing_block_id(&content);
            blocks.push(Block::Heading {
                id: next_id(&mut counter),
                block_id,
                level,
                content: clean.to_string(),
            });
            i += 1;
            continue;
        }

        if let Some((src, alt)) = parse_image_line(trimmed) {
            flush_para(&mut para_lines, &mut blocks, &mut counter, &mut pending_outdent);
            blocks.push(Block::Image {
                id: next_id(&mut counter),
                block_id: None,
                outdent: pending_outdent.take(),
                src,
                alt,
            });
            i += 1;
            continue;
        }

        if para_lines.is_empty() {
            if let Some(bid) = parse_standalone_block_id_line(trimmed) {
                let attached = match blocks.last_mut() {
                    Some(Block::Code { block_id, .. }) if block_id.is_none() => {
                        *block_id = Some(bid);
                        true
                    }
                    Some(Block::Image { block_id, .. }) if block_id.is_none() => {
                        *block_id = Some(bid);
                        true
                    }
                    _ => false,
                };
                if attached {
                    i += 1;
                    continue;
                }
            }
        }

        if trimmed.is_empty() {
            flush_para(&mut para_lines, &mut blocks, &mut counter, &mut pending_outdent);
            i += 1;
            continue;
        }

        para_lines.push(line);
        i += 1;
    }

    flush_para(&mut para_lines, &mut blocks, &mut counter, &mut pending_outdent);

    if blocks.is_empty() {
        blocks.push(Block::Paragraph {
            id: next_id(&mut counter),
            block_id: None,
            outdent: None,
            content: String::new(),
        });
    }

    blocks
}

fn max_backtick_run(text: &str) -> usize {
    let mut max_run = 0usize;
    let mut current = 0usize;
    for ch in text.chars() {
        if ch == '`' {
            current += 1;
            if current > max_run {
                max_run = current;
            }
        } else {
            current = 0;
        }
    }
    max_run
}

/// Serializes editor blocks back into clean standard Markdown.
pub fn serialize_markdown(blocks: &[Block]) -> String {
    if blocks.is_empty() {
        return String::new();
    }
    if blocks.len() == 1 {
        if let Block::Paragraph { content, .. } = &blocks[0] {
            if content.is_empty() {
                return String::new();
            }
        }
    }

    let mut parts = Vec::with_capacity(blocks.len());
    for block in blocks {
        match block {
            Block::Heading {
                block_id,
                level,
                content,
                ..
            } => {
                let hashes = "#".repeat((*level).clamp(1, 6) as usize);
                let text = content.trim_end();
                let mut line = if text.is_empty() {
                    hashes
                } else {
                    format!("{hashes} {text}")
                };
                if let Some(bid) = block_id.as_deref().filter(|s| !s.is_empty()) {
                    line.push_str(&format!(" ^{bid}"));
                }
                parts.push(line);
            }
            Block::Paragraph {
                block_id,
                outdent,
                content,
                ..
            } => {
                let mut out = String::new();
                if let Some(d) = (*outdent).filter(|&v| v > 0) {
                    out.push_str(&format!("<!-- outdent:{d} -->\n"));
                }
                out.push_str(content);
                if let Some(bid) = block_id.as_deref().filter(|s| !s.is_empty()) {
                    if !content.is_empty() {
                        out.push(' ');
                    }
                    out.push_str(&format!("^{bid}"));
                }
                parts.push(out);
            }
            Block::Code {
                block_id,
                outdent,
                language,
                content,
                ..
            } => {
                let fence_len = max_backtick_run(content).max(2) + 1;
                let fence = "`".repeat(fence_len);
                let lang = language.trim();
                let mut s = String::new();
                if let Some(d) = (*outdent).filter(|&v| v > 0) {
                    s.push_str(&format!("<!-- outdent:{d} -->\n"));
                }
                if content.is_empty() {
                    s.push_str(&format!("{fence}{lang}\n{fence}"));
                } else {
                    s.push_str(&format!("{fence}{lang}\n{content}\n{fence}"));
                }
                if let Some(bid) = block_id.as_deref().filter(|s| !s.is_empty()) {
                    s.push_str(&format!("\n^{bid}"));
                }
                parts.push(s);
            }
            Block::Image {
                block_id,
                outdent,
                src,
                alt,
                ..
            } => {
                let safe_alt = alt.replace(']', "\\]");
                let formatted_src = if src.chars().any(char::is_whitespace) {
                    format!("<{src}>")
                } else {
                    src.clone()
                };
                let mut s = String::new();
                if let Some(d) = (*outdent).filter(|&v| v > 0) {
                    s.push_str(&format!("<!-- outdent:{d} -->\n"));
                }
                s.push_str(&format!("![{safe_alt}]({formatted_src})"));
                if let Some(bid) = block_id.as_deref().filter(|s| !s.is_empty()) {
                    s.push_str(&format!("\n^{bid}"));
                }
                parts.push(s);
            }
        }
    }

    let mut out = parts.join("\n\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Iterates over non-code-block lines and non-inline-code segments of a markdown string.
fn process_non_code_segments<F>(markdown: &str, mut on_segment: F) -> String
where
    F: FnMut(&str) -> String,
{
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let had_trailing_nl = normalized.ends_with('\n');
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut out_lines: Vec<String> = Vec::with_capacity(lines.len());
    let mut active_fence: Option<(char, usize)> = None;

    for (idx, line) in lines.iter().enumerate() {
        // Avoid duplicating trailing empty line from split('\n')
        if had_trailing_nl && idx == lines.len() - 1 && line.is_empty() {
            continue;
        }

        if let Some((f_ch, f_len)) = active_fence {
            out_lines.push((*line).to_string());
            if is_fence_close(line, f_ch, f_len) {
                active_fence = None;
            }
            continue;
        }

        if let Some(fence) = parse_fence_open(line) {
            active_fence = Some((fence.ch, fence.len));
            out_lines.push((*line).to_string());
            continue;
        }

        // Split line by inline backtick spans so inline code stays untouched.
        let mut line_out = String::with_capacity(line.len());
        let bytes = line.as_bytes();
        let mut pos = 0usize;
        let mut text_start = 0usize;

        while pos < bytes.len() {
            if bytes[pos] == b'`' {
                let tick_start = pos;
                while pos < bytes.len() && bytes[pos] == b'`' {
                    pos += 1;
                }
                let tick_len = pos - tick_start;
                // Find matching closing backtick run of exact length
                let mut search = pos;
                let mut found_close = None;
                while search < bytes.len() {
                    if bytes[search] == b'`' {
                        let c_start = search;
                        while search < bytes.len() && bytes[search] == b'`' {
                            search += 1;
                        }
                        if search - c_start == tick_len {
                            found_close = Some(search);
                            break;
                        }
                    } else {
                        search += 1;
                    }
                }
                if let Some(close_end) = found_close {
                    if tick_start > text_start {
                        line_out.push_str(&on_segment(&line[text_start..tick_start]));
                    }
                    line_out.push_str(&line[tick_start..close_end]);
                    pos = close_end;
                    text_start = pos;
                }
            } else {
                pos += 1;
            }
        }
        if text_start < line.len() {
            line_out.push_str(&on_segment(&line[text_start..]));
        }
        out_lines.push(line_out);
    }

    let mut result = out_lines.join("\n");
    if had_trailing_nl {
        result.push('\n');
    }
    result
}

fn extract_links_from_segment(seg: &str, out: &mut Vec<ExtractedLink>) {
    let mut i = 0usize;
    let bytes = seg.as_bytes();
    while i < bytes.len() {
        // Wikilink: [[target]] or [[target|label]] (skip image embeds ![[pic.png]])
        if i + 1 < bytes.len() && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            let is_embed = i > 0 && bytes[i - 1] == b'!';
            if let Some(rel_end) = seg[i + 2..].find("]]") {
                let inner = &seg[i + 2..i + 2 + rel_end];
                if !inner.contains('\n') && !inner.trim().is_empty() {
                    let (target_part, label_part) = match inner.split_once('|') {
                        Some((t, l)) => (t.trim(), Some(l.trim().to_string())),
                        None => (inner.trim(), None),
                    };
                    if !target_part.is_empty() && !(is_embed && has_image_extension(target_part)) {
                        out.push(ExtractedLink {
                            target: target_part.to_string(),
                            label: label_part,
                        });
                    }
                }
                i += 2 + rel_end + 2;
                continue;
            }
        }

        // Standard Markdown link: [label](target.md) (skip image ![...])
        if bytes[i] == b'[' && (i == 0 || bytes[i - 1] != b'!') {
            if let Some(close_bracket) = seg[i + 1..].find(']') {
                let label_end = i + 1 + close_bracket;
                if label_end + 1 < bytes.len() && bytes[label_end + 1] == b'(' {
                    if let Some(close_paren) = seg[label_end + 2..].find(')') {
                        let raw_href = seg[label_end + 2..label_end + 2 + close_paren].trim();
                        let href = raw_href
                            .strip_prefix('<')
                            .and_then(|s| s.strip_suffix('>'))
                            .unwrap_or(raw_href);
                        let lower = href.to_ascii_lowercase();
                        if !href.is_empty()
                            && !lower.starts_with("http://")
                            && !lower.starts_with("https://")
                            && !lower.starts_with("mailto:")
                            && !href.starts_with('#')
                        {
                            let label = seg[i + 1..label_end].trim();
                            out.push(ExtractedLink {
                                target: href.to_string(),
                                label: if label.is_empty() {
                                    None
                                } else {
                                    Some(label.to_string())
                                },
                            });
                        }
                        i = label_end + 2 + close_paren + 1;
                        continue;
                    }
                }
            }
        }

        i += 1;
    }
}

/// Extracts all `[[wikilinks]]` and local `[md](links)` outside of code blocks and inline code.
pub fn extract_links(markdown: &str) -> Vec<ExtractedLink> {
    let mut links = Vec::new();
    process_non_code_segments(markdown, |seg| {
        extract_links_from_segment(seg, &mut links);
        String::new()
    });
    links
}

fn normalize_link_cmp(s: &str) -> String {
    let no_anchor = s.split('#').next().unwrap_or(s).trim();
    let slashed = no_anchor.replace('\\', "/");
    let stripped = slashed.strip_prefix("./").unwrap_or(&slashed);
    stripped
        .strip_suffix(".md")
        .or_else(|| stripped.strip_suffix(".MD"))
        .unwrap_or(stripped)
        .to_ascii_lowercase()
}

/// Rewrites `[[old_target]]` (and unique `[[old_basename]]`) wikilinks to `[[new_target]]`
/// outside code blocks and inline code spans.
pub fn rewrite_wikilinks(
    markdown: &str,
    old_target: &str,
    old_basename: &str,
    new_target: &str,
    is_old_basename_unique: bool,
) -> (String, bool) {
    let old_norm = normalize_link_cmp(old_target);
    let base_norm = normalize_link_cmp(old_basename);
    let mut changed = false;

    let updated = process_non_code_segments(markdown, |seg| {
        let mut out = String::with_capacity(seg.len());
        let bytes = seg.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() {
            if i + 1 < bytes.len() && bytes[i] == b'[' && bytes[i + 1] == b'[' {
                if let Some(rel_end) = seg[i + 2..].find("]]") {
                    let inner = &seg[i + 2..i + 2 + rel_end];
                    if !inner.contains('\n') {
                        let (target_part, label_suffix) = match inner.split_once('|') {
                            Some((t, l)) => (t.trim(), Some(l)),
                            None => (inner.trim(), None),
                        };
                        let (path_part, anchor_part) = match target_part.split_once('#') {
                            Some((p, a)) => (p.trim(), Some(a)),
                            None => (target_part, None),
                        };
                        let cmp = normalize_link_cmp(path_part);
                        let matches = cmp == old_norm
                            || (is_old_basename_unique && !cmp.contains('/') && cmp == base_norm);
                        if matches {
                            changed = true;
                            out.push_str("[[");
                            out.push_str(new_target);
                            if let Some(anchor) = anchor_part {
                                out.push('#');
                                out.push_str(anchor);
                            }
                            if let Some(label) = label_suffix {
                                out.push('|');
                                out.push_str(label);
                            }
                            out.push_str("]]");
                            i += 2 + rel_end + 2;
                            continue;
                        }
                    }
                    out.push_str(&seg[i..i + 2 + rel_end + 2]);
                    i += 2 + rel_end + 2;
                    continue;
                }
            }
            if let Some(ch) = seg[i..].chars().next() {
                out.push(ch);
                i += ch.len_utf8();
            } else {
                break;
            }
        }
        out
    });

    (updated, changed)
}

/// Extracts a concise single-line snippet around the first line mentioning `target_needle`.
pub fn extract_snippet(markdown: &str, target_needle: &str) -> String {
    let needle_lower = normalize_link_cmp(target_needle);
    let base_needle = needle_lower
        .rsplit('/')
        .next()
        .unwrap_or(&needle_lower)
        .to_string();

    let mut chosen: Option<String> = None;
    let mut active_fence: Option<(char, usize)> = None;

    for raw_line in markdown.replace("\r\n", "\n").lines() {
        if let Some((f_ch, f_len)) = active_fence {
            if is_fence_close(raw_line, f_ch, f_len) {
                active_fence = None;
            }
            continue;
        }
        if let Some(fence) = parse_fence_open(raw_line) {
            active_fence = Some((fence.ch, fence.len));
            continue;
        }

        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        if (!needle_lower.is_empty() && lower.contains(&needle_lower))
            || (!base_needle.is_empty() && lower.contains(&base_needle))
        {
            chosen = Some(trimmed.to_string());
            break;
        }
    }

    let raw = chosen.unwrap_or_default();
    let cleaned = raw.trim_start_matches('#').trim();
    const MAX_CHARS: usize = 120;
    if cleaned.chars().count() <= MAX_CHARS {
        cleaned.to_string()
    } else {
        let truncated: String = cleaned.chars().take(MAX_CHARS - 1).collect();
        format!("{truncated}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_headings_paragraphs_code_and_links() {
        let md = "\
# Project Overview

This has **bold text**, `inline code`, and a [[notes/plan|Plan]] link.

## Architecture

```rust
fn main() {
    println!(\"hello\");
}
```

### Next Steps

Line one
Line two
";

        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 6);
        assert!(matches!(
            &blocks[0],
            Block::Heading { level: 1, content, .. } if content == "Project Overview"
        ));
        assert!(matches!(
            &blocks[1],
            Block::Paragraph { content, .. }
                if content == "This has **bold text**, `inline code`, and a [[notes/plan|Plan]] link."
        ));
        assert!(matches!(
            &blocks[3],
            Block::Code { language, content, .. }
                if language == "rust" && content.contains("println!")
        ));
        assert!(matches!(
            &blocks[5],
            Block::Paragraph { content, .. } if content == "Line one\nLine two"
        ));

        let serialized = serialize_markdown(&blocks);
        assert_eq!(serialized, md);
    }

    #[test]
    fn code_block_containing_triple_backticks_uses_longer_fence() {
        let blocks = vec![Block::Code {
            id: "b-1".into(),
            block_id: None,
            outdent: None,
            language: "markdown".into(),
            content: "```js\nconsole.log(1)\n```".into(),
        }];
        let md = serialize_markdown(&blocks);
        assert!(md.starts_with("````markdown\n"));
        assert!(md.trim_end().ends_with("````"));

        let reparsed = parse_markdown(&md);
        assert_eq!(reparsed.len(), 1);
        assert_eq!(
            reparsed[0],
            Block::Code {
                id: "b-1".into(),
                block_id: None,
                outdent: None,
                language: "markdown".into(),
                content: "```js\nconsole.log(1)\n```".into(),
            }
        );
    }

    #[test]
    fn empty_markdown_parses_to_single_empty_paragraph_and_serializes_empty() {
        let blocks = parse_markdown("");
        assert_eq!(blocks.len(), 1);
        assert!(matches!(
            &blocks[0],
            Block::Paragraph { content, .. } if content.is_empty()
        ));
        assert_eq!(serialize_markdown(&blocks), "");
    }

    #[test]
    fn legacy_details_summary_maps_to_heading() {
        let md = "<details>\n<summary>Legacy Section</summary>\n\nBody text\n\n</details>\n";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 2);
        assert!(matches!(
            &blocks[0],
            Block::Heading { level: 2, content, .. } if content == "Legacy Section"
        ));
        assert!(matches!(
            &blocks[1],
            Block::Paragraph { content, .. } if content == "Body text"
        ));
    }

    #[test]
    fn extract_links_skips_code_blocks_and_inline_code() {
        let md = "\
See [[hero]] and [[folder/plan|My Plan]] and [Guide](docs/guide.md).
Ignore `[[in_inline_code]]` and [ext](https://example.com).

```md
[[inside_code_block]]
```
";
        let links = extract_links(md);
        assert_eq!(
            links,
            vec![
                ExtractedLink {
                    target: "hero".into(),
                    label: None
                },
                ExtractedLink {
                    target: "folder/plan".into(),
                    label: Some("My Plan".into())
                },
                ExtractedLink {
                    target: "docs/guide.md".into(),
                    label: Some("Guide".into())
                },
            ]
        );
    }

    #[test]
    fn rewrite_wikilinks_updates_outside_code_only() {
        let md = "\
Link [[notes/old]] and [[old|Custom]] and `[[notes/old]]`.

```
[[notes/old]]
```
";
        let (updated, changed) =
            rewrite_wikilinks(md, "notes/old", "old", "notes/new_name", true);
        assert!(changed);
        assert!(updated.contains("Link [[notes/new_name]] and [[notes/new_name|Custom]]"));
        assert!(updated.contains("`[[notes/old]]`"));
        assert!(updated.contains("```\n[[notes/old]]\n```"));
    }

    #[test]
    fn image_blocks_parse_and_round_trip() {
        let md = "\
# Screenshots

![caption](assets/shot.png)

![](<assets/my shot.png>)
";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 3);
        assert!(matches!(
            &blocks[1],
            Block::Image { src, alt, .. } if src == "assets/shot.png" && alt == "caption"
        ));
        assert!(matches!(
            &blocks[2],
            Block::Image { src, alt, .. } if src == "assets/my shot.png" && alt.is_empty()
        ));
        assert_eq!(serialize_markdown(&blocks), md);

        let obsidian_blocks = parse_markdown("![[assets/pic.png|Diagram]]\n");
        assert!(matches!(
            &obsidian_blocks[0],
            Block::Image { src, alt, .. } if src == "assets/pic.png" && alt == "Diagram"
        ));
        assert!(extract_links("See ![[assets/pic.png|Diagram]] and [[hero]].").len() == 1);
    }

    #[test]
    fn lazy_block_ids_round_trip_without_polluting_normal_blocks() {
        let md = "\
# Architecture ^head1a

Plain block without id

Tagged paragraph ^para9z

```sql
SELECT * FROM test;
```
^code7k

![Shot](assets/shot.png)
^img2m4
";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 5);
        assert!(matches!(
            &blocks[0],
            Block::Heading { block_id: Some(bid), content, .. } if bid == "head1a" && content == "Architecture"
        ));
        assert!(matches!(
            &blocks[1],
            Block::Paragraph { block_id: None, content, .. } if content == "Plain block without id"
        ));
        assert!(matches!(
            &blocks[2],
            Block::Paragraph { block_id: Some(bid), content, .. } if bid == "para9z" && content == "Tagged paragraph"
        ));
        assert!(matches!(
            &blocks[3],
            Block::Code { block_id: Some(bid), language, .. } if bid == "code7k" && language == "sql"
        ));
        assert!(matches!(
            &blocks[4],
            Block::Image { block_id: Some(bid), src, .. } if bid == "img2m4" && src == "assets/shot.png"
        ));

        assert_eq!(serialize_markdown(&blocks), md);
    }

    #[test]
    fn outdent_comments_round_trip_cleanly() {
        let md = "\
# Section

Normal indented text

<!-- outdent:1 -->
Top-level text

<!-- outdent:1 -->
```sql
SELECT 1;
```

<!-- outdent:1 -->
![Pic](assets/pic.png)
";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 5);
        assert!(matches!(
            &blocks[1],
            Block::Paragraph { outdent: None, content, .. } if content == "Normal indented text"
        ));
        assert!(matches!(
            &blocks[2],
            Block::Paragraph { outdent: Some(1), content, .. } if content == "Top-level text"
        ));
        assert!(matches!(
            &blocks[3],
            Block::Code { outdent: Some(1), language, .. } if language == "sql"
        ));
        assert!(matches!(
            &blocks[4],
            Block::Image { outdent: Some(1), src, .. } if src == "assets/pic.png"
        ));

        assert_eq!(serialize_markdown(&blocks), md);
    }
}
