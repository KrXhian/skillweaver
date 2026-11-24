use serde::{Deserialize, Serialize};

/// A single editable block inside a Skillweaver markdown document.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Heading {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bg: Option<String>,
        level: u8,
        content: String,
    },
    Paragraph {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outdent: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bg: Option<String>,
        content: String,
    },
    Code {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outdent: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bg: Option<String>,
        language: String,
        content: String,
    },
    Image {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outdent: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bg: Option<String>,
        src: String,
        alt: String,
    },
    Table {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outdent: Option<u8>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        color: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bg: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        alignments: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        col_widths: Vec<u16>,
        rows: Vec<Vec<String>>,
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

fn parse_col_widths_comment(trimmed: &str) -> Option<Vec<u16>> {
    let inner = trimmed.strip_prefix("<!--")?.strip_suffix("-->")?.trim();
    let val = inner.strip_prefix("col-widths:")?.trim();
    if val.is_empty() {
        return None;
    }
    let mut widths = Vec::new();
    for part in val.split(',') {
        let w = part.trim().parse::<u16>().ok()?;
        if !(40..=2000).contains(&w) {
            return None;
        }
        widths.push(w);
    }
    if widths.is_empty() {
        None
    } else {
        Some(widths)
    }
}

fn is_valid_color_name(s: &str) -> bool {
    matches!(
        s,
        "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red"
    )
}

fn parse_style_comment(trimmed: &str) -> Option<(Option<String>, Option<String>)> {
    let inner = trimmed.strip_prefix("<!--")?.strip_suffix("-->")?.trim();
    let val = inner.strip_prefix("style:")?.trim();
    if val.is_empty() {
        return None;
    }
    let mut color: Option<String> = None;
    let mut bg: Option<String> = None;
    for part in val.split(';') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        let (k, v) = p.split_once('=')?;
        let key = k.trim();
        let name = v.trim();
        if !is_valid_color_name(name) {
            return None;
        }
        match key {
            "color" => color = Some(name.to_string()),
            "bg" => bg = Some(name.to_string()),
            _ => return None,
        }
    }
    if color.is_none() && bg.is_none() {
        None
    } else {
        Some((color, bg))
    }
}

fn format_style_comment(color: Option<&str>, bg: Option<&str>) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(c) = color.filter(|s| is_valid_color_name(s)) {
        parts.push(format!("color={c}"));
    }
    if let Some(b) = bg.filter(|s| is_valid_color_name(s)) {
        parts.push(format!("bg={b}"));
    }
    if parts.is_empty() {
        None
    } else {
        Some(format!("<!-- style:{} -->", parts.join(";")))
    }
}

fn find_closing_backticks(bytes: &[u8], start: usize, tick_len: usize) -> Option<usize> {
    let mut search = start;
    while search < bytes.len() {
        if bytes[search] == b'`' {
            let c_start = search;
            while search < bytes.len() && bytes[search] == b'`' {
                search += 1;
            }
            if search - c_start == tick_len {
                return Some(search);
            }
        } else {
            search += 1;
        }
    }
    None
}

fn contains_unescaped_pipe(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 2;
            continue;
        }
        if bytes[i] == b'`' {
            let tick_start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            if let Some(close_end) = find_closing_backticks(bytes, i, i - tick_start) {
                i = close_end;
            }
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(rel_end) = s[i + 2..].find("]]") {
                i += 2 + rel_end + 2;
                continue;
            }
        }
        if bytes[i] == b'|' {
            return true;
        }
        i += 1;
    }
    false
}

fn replace_br_outside_code(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let tick_start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            if let Some(close_end) = find_closing_backticks(bytes, i, i - tick_start) {
                out.push_str(&s[tick_start..close_end]);
                i = close_end;
            } else {
                out.push_str(&s[tick_start..i]);
            }
            continue;
        }
        if bytes[i] == b'<' {
            let rest = &s[i..];
            let rest_lower = rest.get(..6).map(|p| p.to_ascii_lowercase());
            if rest_lower
                .as_deref()
                .map(|p| p.starts_with("<br/>") || p.starts_with("<br />"))
                .unwrap_or(false)
            {
                let adv = if rest[..6].to_ascii_lowercase().starts_with("<br/>") {
                    5
                } else {
                    6
                };
                out.push('\n');
                i += adv;
                continue;
            }
            if rest
                .get(..4)
                .map(|p| p.eq_ignore_ascii_case("<br>"))
                .unwrap_or(false)
            {
                out.push('\n');
                i += 4;
                continue;
            }
        }
        if let Some(ch) = s[i..].chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

fn unescape_table_cell(raw: &str) -> String {
    let trimmed = raw.trim();
    let mut unescaped = String::with_capacity(trimmed.len());
    let bytes = trimmed.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() && bytes[i + 1] == b'|' {
            unescaped.push('|');
            i += 2;
            continue;
        }
        if let Some(ch) = trimmed[i..].chars().next() {
            unescaped.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    replace_br_outside_code(&unescaped)
}

fn split_table_row(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    if trimmed.is_empty() || !contains_unescaped_pipe(trimmed) {
        return None;
    }

    let mut inner = trimmed.strip_prefix('|').unwrap_or(trimmed);
    if inner.ends_with('|') {
        let before = &inner[..inner.len() - 1];
        let backslashes = before.bytes().rev().take_while(|&b| b == b'\\').count();
        if backslashes % 2 == 0 {
            inner = before;
        }
    }

    let mut cells = Vec::new();
    let bytes = inner.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;

    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 2;
            continue;
        }
        if bytes[i] == b'`' {
            let tick_start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            if let Some(close_end) = find_closing_backticks(bytes, i, i - tick_start) {
                i = close_end;
            }
            continue;
        }
        if i + 1 < bytes.len() && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(rel_end) = inner[i + 2..].find("]]") {
                i += 2 + rel_end + 2;
                continue;
            }
        }
        if bytes[i] == b'|' {
            cells.push(unescape_table_cell(&inner[start..i]));
            start = i + 1;
        }
        i += 1;
    }
    cells.push(unescape_table_cell(&inner[start..]));

    if cells.is_empty() {
        None
    } else {
        Some(cells)
    }
}

fn parse_table_delimiter_row(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    if trimmed.is_empty() || !trimmed.contains('|') {
        return None;
    }
    let mut inner = trimmed.strip_prefix('|').unwrap_or(trimmed);
    inner = inner.strip_suffix('|').unwrap_or(inner);
    if inner.trim().is_empty() {
        return None;
    }

    let mut alignments = Vec::new();
    for part in inner.split('|') {
        let cell = part.trim();
        if cell.is_empty() {
            return None;
        }
        let left_colon = cell.starts_with(':');
        let right_colon = cell.ends_with(':');
        let dashes = cell
            .strip_prefix(':')
            .unwrap_or(cell)
            .strip_suffix(':')
            .unwrap_or_else(|| cell.strip_prefix(':').unwrap_or(cell));
        if dashes.is_empty() || !dashes.bytes().all(|b| b == b'-') {
            return None;
        }
        let align = match (left_colon, right_colon) {
            (true, true) => "center",
            (true, false) => "left",
            (false, true) => "right",
            (false, false) => "",
        };
        alignments.push(align.to_string());
    }

    if alignments.is_empty() {
        None
    } else {
        Some(alignments)
    }
}

fn escape_table_cell(cell: &str) -> String {
    let normalized = cell.replace("\r\n", "\n").replace('\r', "\n");
    let single_line = normalized.replace('\n', "<br>");
    let bytes = single_line.as_bytes();
    let mut out = String::with_capacity(single_line.len());
    let mut i = 0usize;

    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(rel_end) = single_line[i + 2..].find("]]") {
                let end = i + 2 + rel_end + 2;
                out.push_str(&single_line[i..end]);
                i = end;
                continue;
            }
        }
        if bytes[i] == b'|' {
            out.push_str("\\|");
            i += 1;
            continue;
        }
        if let Some(ch) = single_line[i..].chars().next() {
            out.push(ch);
            i += ch.len_utf8();
        } else {
            break;
        }
    }
    out
}

/// Parses a Markdown string into Skillweaver editor blocks.
pub fn parse_markdown(input: &str) -> Vec<Block> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks = Vec::new();
    let mut counter = 0usize;
    let mut para_lines: Vec<&str> = Vec::new();
    let mut pending_outdent: Option<u8> = None;
    let mut pending_col_widths: Vec<u16> = Vec::new();
    let mut pending_color: Option<String> = None;
    let mut pending_bg: Option<String> = None;

    let flush_para = |para_lines: &mut Vec<&str>,
                      blocks: &mut Vec<Block>,
                      counter: &mut usize,
                      pending_outdent: &mut Option<u8>,
                      pending_col_widths: &mut Vec<u16>,
                      pending_color: &mut Option<String>,
                      pending_bg: &mut Option<String>| {
        if !para_lines.is_empty() {
            let joined = para_lines.join("\n");
            para_lines.clear();
            pending_col_widths.clear();
            let (clean, block_id) = strip_trailing_block_id(&joined);
            blocks.push(Block::Paragraph {
                id: next_id(counter),
                block_id,
                outdent: pending_outdent.take(),
                color: pending_color.take(),
                bg: pending_bg.take(),
                content: clean.to_string(),
            });
        }
    };

    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];

        if let Some(fence) = parse_fence_open(line) {
            flush_para(
                &mut para_lines,
                &mut blocks,
                &mut counter,
                &mut pending_outdent,
                &mut pending_col_widths,
                &mut pending_color,
                &mut pending_bg,
            );
            pending_col_widths.clear();
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
                color: pending_color.take(),
                bg: pending_bg.take(),
                language: fence.language,
                content: code_lines.join("\n"),
            });
            continue;
        }

        let trimmed = line.trim();
        let lower_trimmed = trimmed.to_ascii_lowercase();

        if lower_trimmed.starts_with("<details") || lower_trimmed == "</details>" {
            flush_para(
                &mut para_lines,
                &mut blocks,
                &mut counter,
                &mut pending_outdent,
                &mut pending_col_widths,
                &mut pending_color,
                &mut pending_bg,
            );
            i += 1;
            continue;
        }

        if let Some(outdent_val) = parse_outdent_comment(trimmed) {
            flush_para(
                &mut para_lines,
                &mut blocks,
                &mut counter,
                &mut pending_outdent,
                &mut pending_col_widths,
                &mut pending_color,
                &mut pending_bg,
            );
            pending_outdent = Some(outdent_val);
            i += 1;
            continue;
        }

        if let Some((c, b)) = parse_style_comment(trimmed) {
            flush_para(
                &mut para_lines,
                &mut blocks,
                &mut counter,
                &mut pending_outdent,
                &mut pending_col_widths,
                &mut pending_color,
                &mut pending_bg,
            );
            pending_color = c;
            pending_bg = b;
            i += 1;
            continue;
        }

        if let Some(widths) = parse_col_widths_comment(trimmed) {
            flush_para(
                &mut para_lines,
                &mut blocks,
                &mut counter,
                &mut pending_outdent,
                &mut pending_col_widths,
                &mut pending_color,
                &mut pending_bg,
            );
            pending_col_widths = widths;
            i += 1;
            continue;
        }

        if let Some(summary) = parse_legacy_summary(trimmed) {
            flush_para(
                &mut para_lines,
                &mut blocks,
                &mut counter,
                &mut pending_outdent,
                &mut pending_col_widths,
                &mut pending_color,
                &mut pending_bg,
            );
            pending_outdent = None;
            pending_col_widths.clear();
            let (clean, block_id) = strip_trailing_block_id(&summary);
            blocks.push(Block::Heading {
                id: next_id(&mut counter),
                block_id,
                color: pending_color.take(),
                bg: pending_bg.take(),
                level: 2,
                content: clean.to_string(),
            });
            i += 1;
            continue;
        }

        if let Some((level, content)) = parse_atx_heading(line) {
            flush_para(
                &mut para_lines,
                &mut blocks,
                &mut counter,
                &mut pending_outdent,
                &mut pending_col_widths,
                &mut pending_color,
                &mut pending_bg,
            );
            pending_outdent = None;
            pending_col_widths.clear();
            let (clean, block_id) = strip_trailing_block_id(&content);
            blocks.push(Block::Heading {
                id: next_id(&mut counter),
                block_id,
                color: pending_color.take(),
                bg: pending_bg.take(),
                level,
                content: clean.to_string(),
            });
            i += 1;
            continue;
        }

        if let Some((src, alt)) = parse_image_line(trimmed) {
            flush_para(
                &mut para_lines,
                &mut blocks,
                &mut counter,
                &mut pending_outdent,
                &mut pending_col_widths,
                &mut pending_color,
                &mut pending_bg,
            );
            pending_col_widths.clear();
            blocks.push(Block::Image {
                id: next_id(&mut counter),
                block_id: None,
                outdent: pending_outdent.take(),
                color: pending_color.take(),
                bg: pending_bg.take(),
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
                    Some(Block::Table { block_id, .. }) if block_id.is_none() => {
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

        if i + 1 < lines.len() {
            if let (Some(header_cells), Some(alignments)) = (
                split_table_row(lines[i]),
                parse_table_delimiter_row(lines[i + 1]),
            ) {
                if !header_cells.is_empty() && header_cells.len() == alignments.len() {
                    flush_para(
                        &mut para_lines,
                        &mut blocks,
                        &mut counter,
                        &mut pending_outdent,
                        &mut pending_col_widths,
                        &mut pending_color,
                        &mut pending_bg,
                    );
                    let col_count = header_cells.len();
                    let mut col_widths = std::mem::take(&mut pending_col_widths);
                    if !col_widths.is_empty() {
                        col_widths.resize(col_count, 160);
                    }
                    let mut rows = vec![header_cells];
                    i += 2;
                    while i < lines.len() {
                        let body_line = lines[i];
                        let body_trimmed = body_line.trim();
                        if body_trimmed.is_empty()
                            || parse_fence_open(body_line).is_some()
                            || parse_atx_heading(body_line).is_some()
                            || parse_outdent_comment(body_trimmed).is_some()
                            || parse_style_comment(body_trimmed).is_some()
                            || parse_col_widths_comment(body_trimmed).is_some()
                            || parse_standalone_block_id_line(body_trimmed).is_some()
                        {
                            break;
                        }
                        let Some(mut cells) = split_table_row(body_line) else {
                            break;
                        };
                        cells.resize(col_count, String::new());
                        rows.push(cells);
                        i += 1;
                    }
                    blocks.push(Block::Table {
                        id: next_id(&mut counter),
                        block_id: None,
                        outdent: pending_outdent.take(),
                        color: pending_color.take(),
                        bg: pending_bg.take(),
                        alignments,
                        col_widths,
                        rows,
                    });
                    continue;
                }
            }
        }

        if trimmed.is_empty() {
            flush_para(
                &mut para_lines,
                &mut blocks,
                &mut counter,
                &mut pending_outdent,
                &mut pending_col_widths,
                &mut pending_color,
                &mut pending_bg,
            );
            i += 1;
            continue;
        }

        para_lines.push(line);
        i += 1;
    }

    flush_para(
        &mut para_lines,
        &mut blocks,
        &mut counter,
        &mut pending_outdent,
        &mut pending_col_widths,
        &mut pending_color,
        &mut pending_bg,
    );

    if blocks.is_empty() {
        blocks.push(Block::Paragraph {
            id: next_id(&mut counter),
            block_id: None,
            outdent: None,
            color: None,
            bg: None,
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
                color,
                bg,
                level,
                content,
                ..
            } => {
                let hashes = "#".repeat((*level).clamp(1, 6) as usize);
                let text = content.trim_end();
                let mut out = String::new();
                if let Some(style) = format_style_comment(color.as_deref(), bg.as_deref()) {
                    out.push_str(&style);
                    out.push('\n');
                }
                if text.is_empty() {
                    out.push_str(&hashes);
                } else {
                    out.push_str(&format!("{hashes} {text}"));
                }
                if let Some(bid) = block_id.as_deref().filter(|s| !s.is_empty()) {
                    out.push_str(&format!(" ^{bid}"));
                }
                parts.push(out);
            }
            Block::Paragraph {
                block_id,
                outdent,
                color,
                bg,
                content,
                ..
            } => {
                let mut out = String::new();
                if let Some(d) = (*outdent).filter(|&v| v > 0) {
                    out.push_str(&format!("<!-- outdent:{d} -->\n"));
                }
                if let Some(style) = format_style_comment(color.as_deref(), bg.as_deref()) {
                    out.push_str(&style);
                    out.push('\n');
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
                color,
                bg,
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
                if let Some(style) = format_style_comment(color.as_deref(), bg.as_deref()) {
                    s.push_str(&style);
                    s.push('\n');
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
                color,
                bg,
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
                if let Some(style) = format_style_comment(color.as_deref(), bg.as_deref()) {
                    s.push_str(&style);
                    s.push('\n');
                }
                s.push_str(&format!("![{safe_alt}]({formatted_src})"));
                if let Some(bid) = block_id.as_deref().filter(|s| !s.is_empty()) {
                    s.push_str(&format!("\n^{bid}"));
                }
                parts.push(s);
            }
            Block::Table {
                block_id,
                outdent,
                color,
                bg,
                alignments,
                col_widths,
                rows,
                ..
            } => {
                let col_count = rows
                    .iter()
                    .map(|r| r.len())
                    .max()
                    .unwrap_or(0)
                    .max(alignments.len())
                    .max(1);
                let mut lines_out = Vec::new();
                if let Some(d) = (*outdent).filter(|&v| v > 0) {
                    lines_out.push(format!("<!-- outdent:{d} -->"));
                }
                if let Some(style) = format_style_comment(color.as_deref(), bg.as_deref()) {
                    lines_out.push(style);
                }
                if !col_widths.is_empty() {
                    let mut widths_str = Vec::with_capacity(col_count);
                    for c in 0..col_count {
                        let w = col_widths.get(c).copied().unwrap_or(160).clamp(40, 2000);
                        widths_str.push(w.to_string());
                    }
                    lines_out.push(format!("<!-- col-widths:{} -->", widths_str.join(",")));
                }

                let format_row = |cells: &[String]| -> String {
                    let mut padded = Vec::with_capacity(col_count);
                    for c in 0..col_count {
                        let raw = cells.get(c).map(String::as_str).unwrap_or("");
                        padded.push(escape_table_cell(raw));
                    }
                    format!("| {} |", padded.join(" | "))
                };

                let header = rows.first().map(Vec::as_slice).unwrap_or(&[]);
                lines_out.push(format_row(header));

                let mut delims = Vec::with_capacity(col_count);
                for c in 0..col_count {
                    let align = alignments.get(c).map(String::as_str).unwrap_or("");
                    let sep = match align {
                        "left" => ":---",
                        "center" => ":---:",
                        "right" => "---:",
                        _ => "---",
                    };
                    delims.push(sep);
                }
                lines_out.push(format!("| {} |", delims.join(" | ")));

                for body_row in rows.iter().skip(1) {
                    lines_out.push(format_row(body_row));
                }

                if let Some(bid) = block_id.as_deref().filter(|s| !s.is_empty()) {
                    lines_out.push(format!("^{bid}"));
                }
                parts.push(lines_out.join("\n"));
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
            color: None,
            bg: None,
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
                color: None,
                bg: None,
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

    #[test]
    fn table_blocks_parse_and_round_trip() {
        let md = "\
# Data

| Feature | Status | Link | Notes |
| --- | :---: | :--- | ---: |
| **Tables** | `ready` | [[notes/plan|Plan]] | a \\| b<br>line2 |
| ==Highlights== | done | [[hero]] | 100 |
";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 2);
        match &blocks[1] {
            Block::Table {
                alignments, rows, ..
            } => {
                assert_eq!(alignments, &vec!["", "center", "left", "right"]);
                assert_eq!(rows.len(), 3);
                assert_eq!(rows[0], vec!["Feature", "Status", "Link", "Notes"]);
                assert_eq!(
                    rows[1],
                    vec!["**Tables**", "`ready`", "[[notes/plan|Plan]]", "a | b\nline2"]
                );
                assert_eq!(rows[2], vec!["==Highlights==", "done", "[[hero]]", "100"]);
            }
            other => panic!("expected table block, got {other:?}"),
        }

        assert_eq!(serialize_markdown(&blocks), md);
    }

    #[test]
    fn table_with_block_id_and_outdent_round_trips() {
        let md = "\
# Section

<!-- outdent:1 -->
| Key | Value |
| --- | --- |
| A | 1 |
^tbl9a2
";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 2);
        assert!(matches!(
            &blocks[1],
            Block::Table {
                block_id: Some(bid),
                outdent: Some(1),
                rows,
                ..
            } if bid == "tbl9a2" && rows.len() == 2
        ));
        assert_eq!(serialize_markdown(&blocks), md);
    }

    #[test]
    fn table_normalizes_ragged_rows_and_ignores_setext_heading() {
        let md = "\
Not A Table
---

| Only |
| --- |
| Val |

| A | B |
| --- | --- |
| 1 |
| 2 | 3 | extra |
";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 3);
        assert!(matches!(&blocks[0], Block::Paragraph { .. }));
        assert!(matches!(
            &blocks[1],
            Block::Table { rows, .. } if rows == &vec![vec!["Only"], vec!["Val"]]
        ));
        assert!(matches!(
            &blocks[2],
            Block::Table { rows, .. } if rows == &vec![
                vec!["A", "B"],
                vec!["1", ""],
                vec!["2", "3"]
            ]
        ));
    }

    #[test]
    fn table_wikilinks_extract_and_rewrite() {
        let md = "\
| Item | Ref |
| --- | --- |
| Spec | [[notes/old|Old Spec]] |
";
        let links = extract_links(md);
        assert_eq!(
            links,
            vec![ExtractedLink {
                target: "notes/old".into(),
                label: Some("Old Spec".into()),
            }]
        );

        let (updated, changed) =
            rewrite_wikilinks(md, "notes/old", "old", "notes/new_spec", true);
        assert!(changed);
        assert!(updated.contains("| Spec | [[notes/new_spec|Old Spec]] |"));
    }

    #[test]
    fn table_col_widths_and_outdent_round_trip() {
        let md = "\
# Section

<!-- outdent:1 -->
<!-- col-widths:180,460 -->
| Topic | Confirmed direction |
| --- | --- |
| Architecture | Reusable Rust engine library |
";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 2);
        assert!(matches!(
            &blocks[1],
            Block::Table {
                outdent: Some(1),
                col_widths,
                rows,
                ..
            } if col_widths == &vec![180, 460] && rows.len() == 2
        ));
        assert_eq!(serialize_markdown(&blocks), md);

        let plain_md = "\
| A | B |
| --- | --- |
| 1 | 2 |
";
        let plain_blocks = parse_markdown(plain_md);
        assert!(matches!(
            &plain_blocks[0],
            Block::Table { col_widths, .. } if col_widths.is_empty()
        ));
        assert!(!serialize_markdown(&plain_blocks).contains("col-widths"));
    }

    #[test]
    fn block_colors_round_trip_across_block_types() {
        let md = "\
<!-- style:bg=blue -->
# Colored Heading

<!-- style:color=red;bg=yellow -->
Highlighted warning text

<!-- outdent:1 -->
<!-- style:color=green -->
Top-level green note

<!-- style:bg=gray -->
<!-- col-widths:140,320 -->
| Key | Value |
| --- | --- |
| A | 1 |
^tblc1

Plain uncolored block
";
        let blocks = parse_markdown(md);
        assert_eq!(blocks.len(), 5);
        assert!(matches!(
            &blocks[0],
            Block::Heading { color: None, bg: Some(b), content, .. } if b == "blue" && content == "Colored Heading"
        ));
        assert!(matches!(
            &blocks[1],
            Block::Paragraph { color: Some(c), bg: Some(b), content, .. } if c == "red" && b == "yellow" && content == "Highlighted warning text"
        ));
        assert!(matches!(
            &blocks[2],
            Block::Paragraph { outdent: Some(1), color: Some(c), bg: None, .. } if c == "green"
        ));
        assert!(matches!(
            &blocks[3],
            Block::Table { block_id: Some(bid), bg: Some(b), col_widths, .. } if bid == "tblc1" && b == "gray" && col_widths == &vec![140, 320]
        ));
        assert!(matches!(
            &blocks[4],
            Block::Paragraph { color: None, bg: None, content, .. } if content == "Plain uncolored block"
        ));

        let serialized = serialize_markdown(&blocks);
        assert_eq!(serialized, md);
        assert!(!serialize_markdown(&[blocks[4].clone()]).contains("<!-- style:"));
    }
}
