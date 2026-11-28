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

//! Binary entry point for Skillweaver desktop GUI and `--mcp` stdio mode.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
struct McpCliArgs {
    folder: Option<String>,
    read_only: bool,
}

fn parse_mcp_cli_args<I, S>(args: I) -> Option<McpCliArgs>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let args: Vec<String> = args.into_iter().map(|s| s.as_ref().to_string()).collect();
    let mut mcp_mode = false;
    let mut read_only = false;
    let mut folder_arg: Option<String> = None;
    let mut i = 0usize;

    while i < args.len() {
        let arg = &args[i];
        if arg == "--read-only" {
            read_only = true;
        } else if arg == "--mcp" {
            mcp_mode = true;
            if i + 1 < args.len() && !args[i + 1].starts_with('-') && folder_arg.is_none() {
                folder_arg = Some(args[i + 1].clone());
                i += 1;
            }
        } else if let Some(val) = arg.strip_prefix("--mcp=") {
            mcp_mode = true;
            if !val.is_empty() {
                folder_arg = Some(val.to_string());
            }
        } else if mcp_mode && folder_arg.is_none() && !arg.starts_with('-') {
            folder_arg = Some(arg.clone());
        }
        i += 1;
    }

    mcp_mode.then_some(McpCliArgs {
        folder: folder_arg,
        read_only,
    })
}

fn main() {
    if let Some(mcp_args) = parse_mcp_cli_args(std::env::args().skip(1)) {
        let folder = mcp_args
            .folder
            .filter(|s| !s.trim().is_empty())
            .or_else(|| skillweaver_lib::prefs::load_prefs().last_folder);

        let Some(path_str) = folder else {
            eprintln!("Skillweaver MCP: pass a folder path (`skillweaver.exe --mcp <folder>`) or open a folder in the app first.");
            std::process::exit(1);
        };

        let opts = skillweaver_lib::mcp::McpOptions {
            read_only: mcp_args.read_only,
        };
        if let Err(err) = skillweaver_lib::mcp::run_stdio_with_options(Path::new(&path_str), opts) {
            eprintln!("Skillweaver MCP error: {err}");
            std::process::exit(1);
        }
        return;
    }

    skillweaver_lib::run();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_cli_parses_read_only_and_folder_in_any_order() {
        assert_eq!(parse_mcp_cli_args(["--help"]), None);
        assert_eq!(
            parse_mcp_cli_args(["--mcp"]),
            Some(McpCliArgs {
                folder: None,
                read_only: false
            })
        );
        assert_eq!(
            parse_mcp_cli_args(["--mcp", "--read-only"]),
            Some(McpCliArgs {
                folder: None,
                read_only: true
            })
        );
        assert_eq!(
            parse_mcp_cli_args(["--mcp", "--read-only", "C:\\vault"]),
            Some(McpCliArgs {
                folder: Some("C:\\vault".to_string()),
                read_only: true
            })
        );
        assert_eq!(
            parse_mcp_cli_args(["--read-only", "--mcp", "C:\\vault"]),
            Some(McpCliArgs {
                folder: Some("C:\\vault".to_string()),
                read_only: true
            })
        );
        assert_eq!(
            parse_mcp_cli_args(["--mcp=C:\\vault", "--read-only"]),
            Some(McpCliArgs {
                folder: Some("C:\\vault".to_string()),
                read_only: true
            })
        );
    }
}
