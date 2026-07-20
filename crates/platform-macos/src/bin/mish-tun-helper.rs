use mish_platform_macos::{TunServiceConfig, run_tun_service};

#[tokio::main]
async fn main() {
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
