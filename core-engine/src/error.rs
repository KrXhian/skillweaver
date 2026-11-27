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

//! Typed error definitions for the Skillweaver core engine.

use std::fmt;

/// Convenience result alias using [`Error`].
pub type Result<T> = std::result::Result<T, Error>;

/// Domain errors produced by Skillweaver's core engine modules.
#[derive(Debug)]
pub enum Error {
    /// Requested note, skill, chat, or directory was not found.
    NotFound(String),
    /// Target path or identifier already exists.
    AlreadyExists(String),
    /// Path fails canonicalization, containment, or validation rules.
    InvalidPath(String),
    /// Caller supplied an invalid argument or malformed request.
    InvalidInput(String),
    /// Shared mutex or synchronization primitive was poisoned.
    LockPoisoned(String),
    /// External process (such as `curl` or `git`) failed.
    ExternalProcess(String),
    /// Underlying filesystem or I/O error.
    Io(std::io::Error),
    /// JSON serialization or deserialization error.
    Serialization(serde_json::Error),
    /// Fallback error carrying a descriptive message.
    Other(String),
}

impl Error {
    /// Returns `true` when this error represents a missing resource.
    #[must_use]
    pub fn is_not_found(&self) -> bool {
        match self {
            Self::NotFound(_) => true,
            Self::Io(err) => err.kind() == std::io::ErrorKind::NotFound,
            _ => false,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(msg)
            | Self::AlreadyExists(msg)
            | Self::InvalidPath(msg)
            | Self::InvalidInput(msg)
            | Self::LockPoisoned(msg)
            | Self::ExternalProcess(msg)
            | Self::Other(msg) => f.write_str(msg),
            Self::Io(err) => err.fmt(f),
            Self::Serialization(err) => err.fmt(f),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            Self::Serialization(err) => Some(err),
            _ => None,
        }
    }
}

impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            Self::NotFound(err.to_string())
        } else if err.kind() == std::io::ErrorKind::AlreadyExists {
            Self::AlreadyExists(err.to_string())
        } else {
            Self::Io(err)
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(err: serde_json::Error) -> Self {
        Self::Serialization(err)
    }
}

impl From<Error> for String {
    fn from(err: Error) -> Self {
        err.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error as StdError;

    #[test]
    fn display_and_string_conversion() {
        let err = Error::InvalidPath("bad path".to_string());
        assert_eq!(err.to_string(), "bad path");
        let as_str: String = err.into();
        assert_eq!(as_str, "bad path");
    }

    #[test]
    fn io_not_found_maps_to_not_found() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "missing file");
        let err: Error = io_err.into();
        assert!(err.is_not_found());
        assert!(matches!(err, Error::NotFound(_)));
    }

    #[test]
    fn io_other_preserves_source() {
        let io_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let err: Error = io_err.into();
        assert!(!err.is_not_found());
        assert!(err.source().is_some());
    }

    #[test]
    fn serde_error_preserves_source() {
        let serde_err = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        let err: Error = serde_err.into();
        assert!(matches!(err, Error::Serialization(_)));
        assert!(err.source().is_some());
    }
}
