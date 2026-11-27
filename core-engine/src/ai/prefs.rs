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

use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

const DPAPI_PREFIX: &str = "dpapi:";

/// User-configured BYOK AI provider settings stored at `%USERPROFILE%\.skillweaver\ai.prefs`
/// (API keys are DPAPI-encrypted at rest on Windows).
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct AiPrefs {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

impl fmt::Debug for AiPrefs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let masked_key = if self.api_key.is_empty() {
            ""
        } else {
            "[REDACTED]"
        };
        f.debug_struct("AiPrefs")
            .field("provider", &self.provider)
            .field("api_key", &masked_key)
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .finish()
    }
}

impl Default for AiPrefs {
    fn default() -> Self {
        Self {
            provider: "openai".to_string(),
            api_key: String::new(),
            base_url: "https://api.openai.com/v1/chat/completions".to_string(),
            model: String::new(),
        }
    }
}

#[cfg(windows)]
mod dpapi {
    use crate::base64::{decode as base64_decode, encode as base64_encode};
    use std::ffi::c_void;
    use std::ptr;

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x01;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    /// RAII guard for buffers allocated by Windows DPAPI (`LocalAlloc`) and freed with `LocalFree`.
    struct LocalAllocBuf {
        ptr: *mut c_void,
        len: usize,
    }

    impl LocalAllocBuf {
        fn from_blob(blob: DataBlob) -> Self {
            Self {
                ptr: blob.pb_data.cast::<c_void>(),
                len: blob.cb_data as usize,
            }
        }

        fn as_slice(&self) -> &[u8] {
            if self.ptr.is_null() || self.len == 0 {
                &[]
            } else {
                // SAFETY: Windows DPAPI allocated `self.ptr` with `LocalAlloc` for `self.len` bytes
                // when returning success, and `self` owns it exclusively until `Drop`.
                unsafe { std::slice::from_raw_parts(self.ptr.cast::<u8>(), self.len) }
            }
        }
    }

    impl Drop for LocalAllocBuf {
        fn drop(&mut self) {
            if !self.ptr.is_null() {
                // SAFETY: `self.ptr` was returned by Windows DPAPI (`LocalAlloc`) and has not yet been freed.
                unsafe {
                    LocalFree(self.ptr);
                }
                self.ptr = ptr::null_mut();
            }
        }
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    pub fn protect(plaintext: &str) -> Result<String, String> {
        if plaintext.is_empty() {
            return Ok(String::new());
        }
        let mut bytes = plaintext.as_bytes().to_vec();
        let data_in = DataBlob {
            cb_data: u32::try_from(bytes.len()).map_err(|_| "API key is too large".to_string())?,
            pb_data: bytes.as_mut_ptr(),
        };
        let mut data_out = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };

        // SAFETY: `data_in` points to valid `bytes` for `cb_data` bytes and `data_out` is writable
        // stack memory; null optional pointers match Win32 DPAPI documentation.
        let ok = unsafe {
            CryptProtectData(
                &data_in,
                ptr::null(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut data_out,
            )
        };
        if ok == 0 {
            return Err("Failed to encrypt API key via Windows DPAPI".to_string());
        }
        let out_buf = LocalAllocBuf::from_blob(data_out);
        Ok(format!(
            "{}{}",
            super::DPAPI_PREFIX,
            base64_encode(out_buf.as_slice())
        ))
    }

    pub fn unprotect(stored: &str) -> Result<String, String> {
        let Some(b64) = stored.strip_prefix(super::DPAPI_PREFIX) else {
            return Ok(stored.to_string());
        };
        let mut cipher = base64_decode(b64)?;
        if cipher.is_empty() {
            return Ok(String::new());
        }
        let data_in = DataBlob {
            cb_data: u32::try_from(cipher.len())
                .map_err(|_| "Encrypted API key blob is too large".to_string())?,
            pb_data: cipher.as_mut_ptr(),
        };
        let mut data_out = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };

        // SAFETY: `data_in` points to valid `cipher` for `cb_data` bytes and `data_out` is writable
        // stack memory; null optional pointers match Win32 DPAPI documentation.
        let ok = unsafe {
            CryptUnprotectData(
                &data_in,
                ptr::null_mut(),
                ptr::null(),
                ptr::null_mut(),
                ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut data_out,
            )
        };
        if ok == 0 {
            return Err("Failed to decrypt API key via Windows DPAPI".to_string());
        }
        let out_buf = LocalAllocBuf::from_blob(data_out);
        String::from_utf8(out_buf.as_slice().to_vec())
            .map_err(|_| "Decrypted API key is not valid UTF-8".to_string())
    }
}

pub fn ai_prefs_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".skillweaver").join("ai.prefs"))
}

pub fn load_ai_prefs_from(path: &Path) -> AiPrefs {
    let Ok(raw) = fs::read_to_string(path) else {
        return AiPrefs::default();
    };
    let mut prefs = serde_json::from_str::<AiPrefs>(&raw).unwrap_or_default();

    #[cfg(windows)]
    {
        if prefs.api_key.starts_with(DPAPI_PREFIX) {
            match dpapi::unprotect(&prefs.api_key) {
                Ok(plain) => prefs.api_key = plain,
                Err(_) => prefs.api_key.clear(),
            }
        } else if !prefs.api_key.is_empty() {
            // Transparently migrate legacy plaintext keys to DPAPI encryption on disk.
            let _ = save_ai_prefs_to(path, &prefs);
        }
    }

    prefs
}

pub fn load_ai_prefs() -> AiPrefs {
    match ai_prefs_path() {
        Some(path) => load_ai_prefs_from(&path),
        None => AiPrefs::default(),
    }
}

pub fn save_ai_prefs_to(path: &Path, prefs: &AiPrefs) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create prefs directory {}: {e}", parent.display()))?;
    }

    let mut to_store = prefs.clone();
    #[cfg(windows)]
    {
        if !to_store.api_key.is_empty() && !to_store.api_key.starts_with(DPAPI_PREFIX) {
            to_store.api_key = dpapi::protect(&to_store.api_key)?;
        }
    }

    let json = serde_json::to_string_pretty(&to_store)
        .map_err(|e| format!("Failed to serialize AI prefs: {e}"))?;
    crate::fs_util::write_atomic(path, json.as_bytes())
        .map_err(|e| format!("Failed to write AI prefs {}: {e}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

pub fn save_ai_prefs(prefs: &AiPrefs) -> Result<(), String> {
    let path =
        ai_prefs_path().ok_or_else(|| "Could not determine user home directory".to_string())?;
    save_ai_prefs_to(&path, prefs)
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
        let dir = std::env::temp_dir().join(format!("skillweaver_ai_{name}_{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ai_prefs_round_trip() {
        let dir = temp_dir("prefs");
        let path = dir.join("ai.prefs");
        let prefs = AiPrefs {
            provider: "gemini".to_string(),
            api_key: "sk-test-123".to_string(),
            base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
            model: "gemini-2.5-flash".to_string(),
        };
        save_ai_prefs_to(&path, &prefs).unwrap();

        #[cfg(windows)]
        {
            let disk_raw = fs::read_to_string(&path).unwrap();
            assert!(disk_raw.contains(DPAPI_PREFIX));
            assert!(!disk_raw.contains("sk-test-123"));
        }

        assert_eq!(load_ai_prefs_from(&path), prefs);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_plaintext_api_key_loads_and_migrates_to_dpapi() {
        let dir = temp_dir("legacy_migrate");
        let path = dir.join("ai.prefs");
        let legacy_json = serde_json::json!({
            "provider": "openai",
            "api_key": "sk-legacy-secret",
            "base_url": "https://api.openai.com/v1/chat/completions",
            "model": "gpt-4o-mini"
        });
        fs::write(&path, serde_json::to_string_pretty(&legacy_json).unwrap()).unwrap();

        let loaded = load_ai_prefs_from(&path);
        assert_eq!(loaded.api_key, "sk-legacy-secret");

        #[cfg(windows)]
        {
            let migrated_raw = fs::read_to_string(&path).unwrap();
            assert!(migrated_raw.contains(DPAPI_PREFIX));
            assert!(!migrated_raw.contains("sk-legacy-secret"));
            assert_eq!(load_ai_prefs_from(&path).api_key, "sk-legacy-secret");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_dpapi_blob_clears_key_safely() {
        let dir = temp_dir("corrupt_dpapi");
        let path = dir.join("ai.prefs");
        let bad_json = serde_json::json!({
            "provider": "openai",
            "api_key": "dpapi:AAAA",
            "base_url": "https://api.openai.com/v1/chat/completions",
            "model": "gpt-4o-mini"
        });
        fs::write(&path, serde_json::to_string_pretty(&bad_json).unwrap()).unwrap();

        let loaded = load_ai_prefs_from(&path);
        #[cfg(windows)]
        assert!(loaded.api_key.is_empty());
        #[cfg(not(windows))]
        assert_eq!(loaded.api_key, "dpapi:AAAA");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ai_prefs_debug_redacts_api_key() {
        let secret_prefs = AiPrefs {
            api_key: "sk-live-super-secret".to_string(),
            ..AiPrefs::default()
        };
        let dbg = format!("{secret_prefs:?}");
        assert!(dbg.contains("[REDACTED]"));
        assert!(!dbg.contains("sk-live-super-secret"));

        let empty_dbg = format!("{:?}", AiPrefs::default());
        assert!(!empty_dbg.contains("[REDACTED]"));
    }
}
