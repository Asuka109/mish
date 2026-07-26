use mish_platform_macos::{
    TunServiceConfig, parse_watchdog_dns, run_core_watchdog, run_tun_service,
};

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
                .unwrap_or(0);
            let managed_dns = match arguments.next().as_deref() {
                Some("--restore-tart-dns") => match arguments.next() {
                    Some(value) if arguments.next().is_none() => match parse_watchdog_dns(&value) {
                        Ok(state) => Some(state),
                        Err(message) => {
                            eprintln!("Mish Core watchdog failed: {message}");
                            std::process::exit(2);
                        }
                    },
                    _ => {
                        eprintln!("Mish Core watchdog received invalid DNS restoration state");
                        std::process::exit(2);
                    }
                },
                None => None,
                Some(_) => {
                    eprintln!("Mish Core watchdog received an unsupported argument");
                    std::process::exit(2);
                }
            };
            if let Err(message) = run_core_watchdog(parent_pid, core_pid, managed_dns).await {
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
