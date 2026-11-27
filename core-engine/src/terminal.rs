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

use crate::fs_util::kill_process_tree;
#[cfg(windows)]
use crate::fs_util::CREATE_NO_WINDOW;
use crate::prefs;
use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const PROMPT_MARKER: &str = "__SW_PROMPT__";

#[cfg(windows)]
const WINDOWS_INIT_SCRIPT: &str = concat!(
    "try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}\r\n",
    "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}\r\n",
    "$OutputEncoding = [System.Text.Encoding]::UTF8\r\n",
    r#"function global:tree { $raw = $false; foreach ($a in $args) { if ($a -ieq '/a' -or $a -ieq '/?') { $raw = $true; break } }; $prev = $null; try { $prev = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::Default } catch {}; try { if ($raw) { $lines = & "$env:SystemRoot\System32\tree.com" @args } else { $lines = & "$env:SystemRoot\System32\tree.com" /a @args } } finally { if ($prev) { try { [Console]::OutputEncoding = $prev } catch {} } }; if ($raw) { $lines; return }; $v = [string][char]0x2502; $t = "$([char]0x251C)$([char]0x2500)$([char]0x2500)$([char]0x2500)"; $l = "$([char]0x2514)$([char]0x2500)$([char]0x2500)$([char]0x2500)"; $idx = 0; foreach ($line in $lines) { if ($idx -ge 3) { $line = [regex]::Replace([string]$line, '^((?:\|   |    )*)([+\\]---|\|$)?', { param($m); $p = $m.Groups[1].Value.Replace('|', $v); if ($m.Groups[2].Value -eq '+---') { return $p + $t }; if ($m.Groups[2].Value -eq '\---') { return $p + $l }; if ($m.Groups[2].Value -eq '|') { return $p + $v }; return $p }) }; $line; $idx++ } }"#,
    "\r\n",
);

#[cfg(windows)]
const WIN1252_80_9F: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

/// Decodes terminal bytes as UTF-8 when valid, falling back to Windows-1252 for legacy console output.
pub(crate) fn decode_terminal_bytes(bytes: &[u8]) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        if b < 0x80 {
            out.push(b as char);
        } else if b < 0xA0 {
            out.push(WIN1252_80_9F[(b - 0x80) as usize]);
        } else {
            out.push(b as char);
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalOutputEvent {
    pub stream: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalPromptEvent {
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalStartPayload {
    pub cwd: String,
    pub shell: String,
}

struct TerminalSession {
    child: Child,
    pid: u32,
    stdin: ChildStdin,
    cwd: Arc<Mutex<String>>,
    is_running: Arc<AtomicBool>,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        kill_process_tree(self.pid);
        let _ = self.child.kill();
    }
}

/// Shared managed state for the integrated PowerShell terminal session.
#[derive(Default)]
pub struct TerminalState {
    inner: Mutex<Option<TerminalSession>>,
}

fn parse_prompt_marker(line: &str) -> Option<String> {
    line.strip_prefix(PROMPT_MARKER)
        .map(|rest| prefs::clean_folder_path(rest.trim()))
}

#[cfg(any(windows, test))]
fn escape_ps_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(any(not(windows), test))]
fn escape_sh_single_quoted(value: &str) -> String {
    value.replace('\'', "'\"'\"'")
}

fn resolve_start_dir(fallback_dir: Option<&Path>) -> PathBuf {
    if let Some(dir) = fallback_dir {
        if dir.is_dir() {
            return dir.to_path_buf();
        }
    }
    if let Some(home) = dirs::home_dir() {
        if home.is_dir() {
            return home;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn spawn_session(app: &AppHandle, start_dir: &Path) -> Result<TerminalSession, String> {
    let clean_dir = prefs::clean_folder_path(&start_dir.to_string_lossy());
    let dir_path = PathBuf::from(&clean_dir);

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("powershell.exe");
        c.args([
            "-NoLogo",
            "-NoProfile",
            "-NoExit",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "-",
        ]);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };

    #[cfg(not(windows))]
    let mut cmd = Command::new("sh");

    cmd.current_dir(&dir_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start terminal shell: {e}"))?;
    let pid = child.id();

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to attach terminal stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to attach terminal stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to attach terminal stderr".to_string())?;

    #[cfg(windows)]
    {
        let _ = stdin.write_all(WINDOWS_INIT_SCRIPT.as_bytes());
        let _ = stdin.flush();
    }

    let cwd_shared = Arc::new(Mutex::new(clean_dir));
    let is_running = Arc::new(AtomicBool::new(false));

    let app_out = app.clone();
    let cwd_out = Arc::clone(&cwd_shared);
    let running_out = Arc::clone(&is_running);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let decoded = decode_terminal_bytes(&buf);
                    let line = decoded.trim_end_matches(['\r', '\n']);
                    if let Some(next_cwd) = parse_prompt_marker(line) {
                        if let Ok(mut guard) = cwd_out.lock() {
                            *guard = next_cwd.clone();
                        }
                        running_out.store(false, Ordering::SeqCst);
                        let _ =
                            app_out.emit("terminal-prompt", TerminalPromptEvent { cwd: next_cwd });
                    } else {
                        let _ = app_out.emit(
                            "terminal-output",
                            TerminalOutputEvent {
                                stream: "stdout".to_string(),
                                text: line.to_string(),
                            },
                        );
                    }
                }
            }
        }
        if running_out.swap(false, Ordering::SeqCst) {
            let cwd_now = cwd_out.lock().map(|g| g.clone()).unwrap_or_default();
            let _ = app_out.emit("terminal-prompt", TerminalPromptEvent { cwd: cwd_now });
        }
    });

    let app_err = app.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let decoded = decode_terminal_bytes(&buf);
                    let line = decoded.trim_end_matches(['\r', '\n']);
                    let _ = app_err.emit(
                        "terminal-output",
                        TerminalOutputEvent {
                            stream: "stderr".to_string(),
                            text: line.to_string(),
                        },
                    );
                }
            }
        }
    });

    Ok(TerminalSession {
        child,
        pid,
        stdin,
        cwd: cwd_shared,
        is_running,
    })
}

fn write_command_with_prompt(session: &mut TerminalSession, input: &str) -> Result<(), String> {
    let trimmed = input.trim_end_matches(['\r', '\n']);
    let running = session.is_running.load(Ordering::SeqCst);

    if running {
        let payload = format!("{trimmed}\r\n");
        session
            .stdin
            .write_all(payload.as_bytes())
            .and_then(|_| session.stdin.flush())
            .map_err(|e| format!("Failed to write to terminal: {e}"))?;
        return Ok(());
    }

    session.is_running.store(true, Ordering::SeqCst);

    #[cfg(windows)]
    let script = format!(
        "{trimmed}\r\n[Console]::Out.WriteLine(\"{PROMPT_MARKER}$((Get-Location).Path)\")\r\n"
    );
    #[cfg(not(windows))]
    let script = format!("{trimmed}\nprintf '{PROMPT_MARKER}%s\\n' \"$PWD\"\n");

    if let Err(e) = session
        .stdin
        .write_all(script.as_bytes())
        .and_then(|_| session.stdin.flush())
    {
        session.is_running.store(false, Ordering::SeqCst);
        return Err(format!("Failed to run terminal command: {e}"));
    }

    Ok(())
}

impl TerminalState {
    fn shell_name() -> String {
        #[cfg(windows)]
        {
            "PowerShell".to_string()
        }
        #[cfg(not(windows))]
        {
            "sh".to_string()
        }
    }

    pub fn ensure_started(
        &self,
        app: &AppHandle,
        fallback_dir: Option<&Path>,
    ) -> Result<TerminalStartPayload, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Terminal state lock poisoned".to_string())?;

        if let Some(session) = guard.as_mut() {
            if matches!(session.child.try_wait(), Ok(None)) {
                let cwd = session.cwd.lock().map(|g| g.clone()).unwrap_or_default();
                return Ok(TerminalStartPayload {
                    cwd,
                    shell: Self::shell_name(),
                });
            }
            *guard = None;
        }

        let start_dir = resolve_start_dir(fallback_dir);
        let session = spawn_session(app, &start_dir)?;
        let cwd = session.cwd.lock().map(|g| g.clone()).unwrap_or_default();
        *guard = Some(session);

        Ok(TerminalStartPayload {
            cwd,
            shell: Self::shell_name(),
        })
    }

    pub fn run_input(
        &self,
        app: &AppHandle,
        fallback_dir: Option<&Path>,
        input: &str,
    ) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Terminal state lock poisoned".to_string())?;

        let need_spawn = match guard.as_mut() {
            Some(session) => !matches!(session.child.try_wait(), Ok(None)),
            None => true,
        };
        if need_spawn {
            let start_dir = resolve_start_dir(fallback_dir);
            *guard = Some(spawn_session(app, &start_dir)?);
        }

        let session = guard
            .as_mut()
            .ok_or_else(|| "Terminal session unavailable".to_string())?;
        write_command_with_prompt(session, input)
    }

    pub fn interrupt(
        &self,
        app: &AppHandle,
        fallback_dir: Option<&Path>,
    ) -> Result<TerminalStartPayload, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Terminal state lock poisoned".to_string())?;

        let prev_cwd = guard
            .as_ref()
            .and_then(|s| s.cwd.lock().ok().map(|g| PathBuf::from(g.as_str())));

        // Dropping the old session invokes kill_process_tree(pid) + child.kill().
        *guard = None;

        let _ = app.emit(
            "terminal-output",
            TerminalOutputEvent {
                stream: "system".to_string(),
                text: "^C".to_string(),
            },
        );

        let restart_dir = prev_cwd
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| resolve_start_dir(fallback_dir));
        let session = spawn_session(app, &restart_dir)?;
        let cwd = session.cwd.lock().map(|g| g.clone()).unwrap_or_default();
        *guard = Some(session);

        let _ = app.emit("terminal-prompt", TerminalPromptEvent { cwd: cwd.clone() });

        Ok(TerminalStartPayload {
            cwd,
            shell: Self::shell_name(),
        })
    }

    pub fn sync_cwd(&self, _app: &AppHandle, folder: &Path) -> Result<Option<String>, String> {
        if !folder.is_dir() {
            return Ok(None);
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "Terminal state lock poisoned".to_string())?;

        let Some(session) = guard.as_mut() else {
            return Ok(None);
        };
        if !matches!(session.child.try_wait(), Ok(None)) {
            *guard = None;
            return Ok(None);
        }
        if session.is_running.load(Ordering::SeqCst) {
            return Ok(None);
        }

        let clean = prefs::clean_folder_path(&folder.to_string_lossy());
        #[cfg(windows)]
        let cd_cmd = format!(
            "Set-Location -LiteralPath '{}'",
            escape_ps_single_quoted(&clean)
        );
        #[cfg(not(windows))]
        let cd_cmd = format!("cd '{}'", escape_sh_single_quoted(&clean));

        write_command_with_prompt(session, &cd_cmd)?;
        Ok(Some(clean))
    }

    pub fn complete_path(&self, partial: &str) -> Result<Vec<String>, String> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| "Terminal state lock poisoned".to_string())?;

        let cwd = guard
            .as_ref()
            .and_then(|s| s.cwd.lock().ok().map(|g| PathBuf::from(g.as_str())))
            .unwrap_or_else(|| resolve_start_dir(None));

        Ok(complete_path_in_dir(&cwd, partial))
    }
}

/// Resolves relative filename/directory completions inside `cwd` for Tab completion.
pub fn complete_path_in_dir(cwd: &Path, partial: &str) -> Vec<String> {
    let trimmed = partial.trim_matches('"').trim_matches('\'');
    let sep = if trimmed.contains('/') { '/' } else { '\\' };

    let (dir_prefix, name_prefix) = match trimmed.rfind(['/', '\\']) {
        Some(idx) => (&trimmed[..=idx], &trimmed[idx + 1..]),
        None => ("", trimmed),
    };

    let search_dir = if dir_prefix.is_empty() {
        cwd.to_path_buf()
    } else {
        let rel = dir_prefix.replace('\\', "/");
        let p = Path::new(&rel);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        }
    };

    let Ok(entries) = fs::read_dir(&search_dir) else {
        return Vec::new();
    };

    let needle = name_prefix.to_ascii_lowercase();
    let mut dirs = Vec::new();
    let mut files = Vec::new();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !needle.is_empty() && !name.to_ascii_lowercase().starts_with(&needle) {
            continue;
        }
        let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let completion = if is_dir {
            format!("{dir_prefix}{name}{sep}")
        } else {
            format!("{dir_prefix}{name}")
        };
        if is_dir {
            dirs.push(completion);
        } else {
            files.push(completion);
        }
    }

    dirs.sort_by_key(|a| a.to_ascii_lowercase());
    files.sort_by_key(|a| a.to_ascii_lowercase());
    dirs.extend(files);
    dirs.truncate(30);
    dirs
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
        let dir = std::env::temp_dir().join(format!("skillweaver_term_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parse_prompt_marker_extracts_clean_cwd() {
        assert_eq!(
            parse_prompt_marker(r"__SW_PROMPT__\\?\C:\Users\alice\vault"),
            Some(r"C:\Users\alice\vault".to_string())
        );
        assert_eq!(parse_prompt_marker("normal output line"), None);
    }

    #[test]
    fn escape_ps_single_quoted_doubles_quotes() {
        assert_eq!(
            escape_ps_single_quoted(r"C:\Alice's Notes\md"),
            r"C:\Alice''s Notes\md"
        );
    }

    #[test]
    fn escape_sh_single_quoted_wraps_apostrophes() {
        assert_eq!(
            escape_sh_single_quoted("/tmp/Alice's Notes/md"),
            r#"/tmp/Alice'"'"'s Notes/md"#
        );
    }

    #[test]
    fn complete_path_in_dir_matches_case_insensitively_and_subfolders() {
        let root = temp_dir("complete");
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("hero.md"), "# Hero").unwrap();
        fs::write(root.join("notes").join("alpha.md"), "# A").unwrap();
        fs::write(root.join("notes").join("beta.md"), "# B").unwrap();

        let root_matches = complete_path_in_dir(&root, "H");
        assert_eq!(root_matches, vec!["hero.md"]);

        let dir_matches = complete_path_in_dir(&root, "n");
        assert_eq!(dir_matches, vec![r"notes\"]);

        let sub_matches = complete_path_in_dir(&root, "notes/a");
        assert_eq!(sub_matches, vec!["notes/alpha.md"]);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn decode_terminal_bytes_preserves_utf8_and_decodes_cp1252() {
        let utf8 = "├───01 - Data\n│   test.md\n└───assets\n";
        assert_eq!(decode_terminal_bytes(utf8.as_bytes()), utf8);
        // Legacy CP1252 bytes (0x80 = Euro, 0x97 = em-dash, 0xA6 = broken bar)
        assert_eq!(
            decode_terminal_bytes(&[0x80, b' ', 0x97, b' ', 0xA6]),
            "\u{20AC} \u{2014} \u{00A6}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn powershell_tree_wrapper_renders_unicode_box_drawing_without_replacement_char() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};

        let root = temp_dir("tree_box");
        fs::create_dir_all(root.join("01 - Data")).unwrap();
        fs::create_dir_all(root.join("02 - Data")).unwrap();
        fs::write(root.join("01 - Data").join("01 - Data Test.md"), "# 1").unwrap();
        fs::write(root.join("02 - Data").join("test.md"), "# 2").unwrap();

        let mut child = Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NoExit",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "-",
            ])
            .current_dir(&root)
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();

        let pid = child.id();
        let mut stdin = child.stdin.take().unwrap();
        let stdout_pipe = child.stdout.take().unwrap();
        let stderr_pipe = child.stderr.take().unwrap();

        let (tx, rx) = mpsc::channel::<String>();
        let reader_handle = thread::spawn(move || {
            let mut reader = BufReader::new(stdout_pipe);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let decoded = decode_terminal_bytes(&buf);
                        let line = decoded.trim_end_matches(['\r', '\n']).to_string();
                        if tx.send(line).is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let stderr_handle = thread::spawn(move || {
            let mut reader = BufReader::new(stderr_pipe);
            let mut buf = Vec::new();
            let mut err_lines = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let decoded = decode_terminal_bytes(&buf);
                        err_lines.push(decoded.trim_end_matches(['\r', '\n']).to_string());
                    }
                }
            }
            err_lines
        });

        // Mimic spawn_session + write_command_with_prompt without closing stdin or adding blank lines.
        stdin.write_all(WINDOWS_INIT_SCRIPT.as_bytes()).unwrap();
        stdin.flush().unwrap();
        let cmd_script = format!(
            "tree /f\r\n[Console]::Out.WriteLine(\"{PROMPT_MARKER}$((Get-Location).Path)\")\r\n"
        );
        stdin.write_all(cmd_script.as_bytes()).unwrap();
        stdin.flush().unwrap();

        let deadline = Instant::now() + Duration::from_secs(25);
        let mut lines = Vec::new();
        let mut saw_prompt = false;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(remaining) {
                Ok(line) => {
                    if parse_prompt_marker(&line).is_some() {
                        saw_prompt = true;
                        break;
                    }
                    lines.push(line);
                }
                Err(_) => break,
            }
        }

        drop(stdin);
        kill_process_tree(pid);
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader_handle.join();
        let stderr_text = stderr_handle.join().unwrap_or_default().join("\n");

        let stdout = lines.join("\n");
        assert!(
            saw_prompt,
            "Timed out waiting for prompt marker (PowerShell entered continuation mode?).\nstdout:\n{stdout}\nstderr:\n{stderr_text}"
        );
        assert!(
            stdout.contains("\u{251C}\u{2500}\u{2500}\u{2500}01 - Data"),
            "Expected Unicode tee branch, got:\n{stdout}"
        );
        assert!(
            stdout.contains("\u{2502}"),
            "Expected Unicode vertical bar, got:\n{stdout}"
        );
        assert!(
            stdout.contains("\u{2514}\u{2500}\u{2500}\u{2500}02 - Data"),
            "Expected Unicode corner branch, got:\n{stdout}"
        );
        assert!(
            !stdout.contains('\u{FFFD}'),
            "Unexpected U+FFFD in:\n{stdout}"
        );

        let _ = fs::remove_dir_all(&root);
    }
}
