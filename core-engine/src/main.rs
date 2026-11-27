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

fn main() {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mcp_folder_opt = if arg == "--mcp" {
            Some(args.next())
        } else {
            arg.strip_prefix("--mcp=").map(|val| {
                if val.is_empty() {
                    None
                } else {
                    Some(val.to_string())
                }
            })
        };

        if let Some(folder_arg) = mcp_folder_opt {
            let folder = folder_arg
                .filter(|s| !s.trim().is_empty())
                .or_else(|| skillweaver_lib::prefs::load_prefs().last_folder);

            let Some(path_str) = folder else {
                eprintln!("Skillweaver MCP: pass a folder path (`skillweaver.exe --mcp <folder>`) or open a folder in the app first.");
                std::process::exit(1);
            };

            if let Err(err) = skillweaver_lib::mcp::run_stdio(Path::new(&path_str)) {
                eprintln!("Skillweaver MCP error: {err}");
                std::process::exit(1);
            }
            return;
        }
    }

    skillweaver_lib::run();
}
