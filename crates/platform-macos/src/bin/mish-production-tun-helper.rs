use mish_runtime::{TUN_HELPER_EXPECTED_VERSION, TUN_HELPER_PROTOCOL_VERSION};

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version") => println!("{TUN_HELPER_EXPECTED_VERSION}"),
        Some("--protocol-version") => println!("{TUN_HELPER_PROTOCOL_VERSION}"),
        _ => {
            eprintln!("The Mish production TUN XPC command transport is unavailable");
            std::process::exit(78);
        }
    }
}
