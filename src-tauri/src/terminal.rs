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

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const PROMPT_MARKER: &str = "__SW_PROMPT__";

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

fn kill_process_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

fn parse_prompt_marker(line: &str) -> Option<String> {
    line.strip_prefix(PROMPT_MARKER)
        .map(|rest| prefs::clean_folder_path(rest.trim()))
}

fn escape_ps_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
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
        let init_script = "[Console]::InputEncoding = [System.Text.Encoding]::UTF8\r\n\
                           [Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n\
                           $OutputEncoding = [System.Text.Encoding]::UTF8\r\n";
        let _ = stdin.write_all(init_script.as_bytes());
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
                    let line_lossy = String::from_utf8_lossy(&buf);
                    let line = line_lossy.trim_end_matches(['\r', '\n']);
                    if let Some(next_cwd) = parse_prompt_marker(line) {
                        if let Ok(mut guard) = cwd_out.lock() {
                            *guard = next_cwd.clone();
                        }
                        running_out.store(false, Ordering::SeqCst);
                        let _ = app_out.emit("terminal-prompt", TerminalPromptEvent { cwd: next_cwd });
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
                    let line_lossy = String::from_utf8_lossy(&buf);
                    let line = line_lossy.trim_end_matches(['\r', '\n']);
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
        let cd_cmd = format!("Set-Location -LiteralPath '{}'", escape_ps_single_quoted(&clean));
        #[cfg(not(windows))]
        let cd_cmd = format!("cd '{}'", escape_ps_single_quoted(&clean));

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
            parse_prompt_marker(r"__SW_PROMPT__\\?\C:\Users\Krist\vault"),
            Some(r"C:\Users\Krist\vault".to_string())
        );
        assert_eq!(parse_prompt_marker("normal output line"), None);
    }

    #[test]
    fn escape_ps_single_quoted_doubles_quotes() {
        assert_eq!(
            escape_ps_single_quoted(r"C:\Krist's Notes\md"),
            r"C:\Krist''s Notes\md"
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
}
