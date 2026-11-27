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

//! Filesystem atomicity and OS process helpers shared across modules.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

/// Windows creation flag that suppresses spawning a visible console window.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Terminates a process (and on Windows its process tree) best-effort.
pub fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Removes a temporary file if `write_atomic` exits early before renaming it.
struct TempCleanupGuard<'a> {
    path: &'a Path,
    armed: bool,
}

impl Drop for TempCleanupGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(self.path);
        }
    }
}

/// Atomically writes `bytes` to `path` via a dot-prefixed sibling temporary
/// file and `rename`, retrying transient Windows `PermissionDenied` lock errors.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent)?;
    }

    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .unwrap_or("file");
    let tmp_path = path.with_file_name(format!(".{file_name}.swtmp-{pid}-{seq}"));

    let mut guard = TempCleanupGuard {
        path: &tmp_path,
        armed: true,
    };

    {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(bytes)?;
        file.flush()?;
    }

    const MAX_RENAME_RETRIES: usize = 5;
    let mut attempt = 0usize;
    loop {
        match fs::rename(&tmp_path, path) {
            Ok(()) => {
                guard.armed = false;
                return Ok(());
            }
            Err(err)
                if err.kind() == std::io::ErrorKind::PermissionDenied
                    && attempt < MAX_RENAME_RETRIES =>
            {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(10 * attempt as u64));
            }
            Err(err) => return Err(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "skillweaver_fs_util_{tag}_{}_{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn write_atomic_creates_overwrites_and_cleans_temp() {
        let dir = unique_test_dir("atomic");
        let target = dir.join("nested").join("note.md");

        write_atomic(&target, b"first version").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "first version");

        write_atomic(&target, b"second version").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "second version");

        let leftovers: Vec<_> = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".swtmp-"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn temp_cleanup_guard_removes_file_when_armed() {
        let dir = unique_test_dir("guard");
        fs::create_dir_all(&dir).unwrap();
        let tmp = dir.join(".orphan.swtmp-0");
        fs::write(&tmp, b"partial").unwrap();

        {
            let _guard = TempCleanupGuard {
                path: &tmp,
                armed: true,
            };
        }
        assert!(!tmp.exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
