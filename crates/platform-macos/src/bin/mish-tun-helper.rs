use mish_platform_macos::{TunServiceConfig, run_core_watchdog, run_tun_service};

#[tokio::main]
async fn main() {
    let mut arguments = std::env::args();
    let _executable = arguments.next();
    match arguments.next().as_deref() {
        Some("--watch-parent") => {
            let parent_pid = arguments
                .next()
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(0);
            let core_pid = arguments
                .next()
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|_| arguments.next().is_none())
                .unwrap_or(0);
            if let Err(message) = run_core_watchdog(parent_pid, core_pid).await {
                eprintln!("Mish Core watchdog failed: {message}");
                std::process::exit(2);
            }
            return;
        }
        Some(_) => {
            eprintln!("Mish TUN service received an unsupported argument");
            std::process::exit(2);
        }
        None => {}
    }
    let config = match TunServiceConfig::from_environment() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("Mish TUN service configuration failed: {message}");
            std::process::exit(2);
        }
    };
    if let Err(message) = run_tun_service(config).await {
        eprintln!("Mish TUN service failed: {message}");
        std::process::exit(1);
    }
}
