#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mcp_folder_opt = if arg == "--mcp" {
            Some(args.next())
        } else {
            arg.strip_prefix("--mcp=")
                .map(|val| if val.is_empty() { None } else { Some(val.to_string()) })
        };

        if let Some(folder_arg) = mcp_folder_opt {
            let folder = folder_arg
                .filter(|s| !s.trim().is_empty())
                .or_else(|| skillweaver_lib::prefs::load_prefs().last_folder);

            let Some(path_str) = folder else {
                eprintln!("Skillweaver MCP: pass a folder path (`skillweaver.exe --mcp <folder>`) or open a folder in the app first.");
                std::process::exit(1);
            };

            if let Err(err) = skillweaver_lib::mcp::run_stdio(&PathBuf::from(&path_str)) {
                eprintln!("Skillweaver MCP error: {err}");
                std::process::exit(1);
            }
            return;
        }
    }

    skillweaver_lib::run();
}
