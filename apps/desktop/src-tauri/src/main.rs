#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    match mish_desktop::run() {
        Ok(exit_code) => std::process::exit(exit_code),
        Err(error) => {
            eprintln!("Mish desktop failed to start: {error}");
            std::process::exit(1);
        }
    }
}
