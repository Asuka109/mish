use std::{env, net::SocketAddr, path::PathBuf, sync::Arc};

use clap::Parser;
use mish_bridge::{
    DesktopMihomoProcess, DesktopMihomoProcessConfig, LoopbackServerConfig, ServiceProbeConfig,
    compose_desktop_runtime, start_loopback_server,
};

#[derive(Parser)]
#[command(version, about = "Mish desktop bridge for the managed Mihomo process")]
struct Arguments {
    #[arg(long, default_value = "127.0.0.1:9099")]
    bind: SocketAddr,
    #[arg(long)]
    allow_origin: Vec<String>,
    #[arg(long)]
    mihomo_binary: Option<PathBuf>,
    #[arg(long, conflicts_with = "mihomo_config_file")]
    mihomo_config_directory: Option<PathBuf>,
    #[arg(long, conflicts_with = "mihomo_config_directory")]
    mihomo_config_file: Option<PathBuf>,
    #[arg(long, default_value_t = 1_048_576)]
    max_message_bytes: usize,
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let arguments = Arguments::parse();
    let auth_token = env::var("MISH_BRIDGE_TOKEN")
        .map_err(|_| "MISH_BRIDGE_TOKEN is required and must not be stored in the repository")?;
    let runtime = compose_desktop_runtime(
        Arc::new(DesktopMihomoProcess::new(DesktopMihomoProcessConfig {
            binary: arguments.mihomo_binary,
            config_directory: arguments.mihomo_config_directory,
            config_file: arguments.mihomo_config_file,
        })),
        None,
    )
    .await
    .map_err(|error| error.to_string())?;
    let bridge = start_loopback_server(
        LoopbackServerConfig {
            allowed_origins: arguments.allow_origin,
            auth_token,
            bind: arguments.bind,
            browser_assets: None,
            max_message_bytes: arguments.max_message_bytes,
            profile_activation: None,
            profile_file_actions: None,
            profile_service: None,
            service_probes: Some(ServiceProbeConfig { state_path: None }),
            settings_service: None,
        },
        runtime,
    )
    .await?;
    println!("Mish desktop bridge listening on http://{}", bridge.address);
    tokio::signal::ctrl_c()
        .await
        .map_err(|error| error.to_string())?;
    bridge.shutdown().await;
    Ok(())
}
