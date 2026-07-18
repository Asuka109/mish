use std::{env, net::SocketAddr, path::PathBuf};

use clap::Parser;
use mish_agent::{AgentConfig, CoreConfig, start_agent};

#[derive(Parser)]
#[command(version, about = "Loopback Mish agent for the Mihomo sidecar")]
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
    let auth_token = env::var("MISH_AGENT_TOKEN")
        .map_err(|_| "MISH_AGENT_TOKEN is required and must not be stored in the repository")?;
    let agent = start_agent(AgentConfig {
        allowed_origins: arguments.allow_origin,
        auth_token,
        bind: arguments.bind,
        core: CoreConfig {
            binary: arguments.mihomo_binary,
            config_directory: arguments.mihomo_config_directory,
            config_file: arguments.mihomo_config_file,
        },
        max_message_bytes: arguments.max_message_bytes,
    })
    .await?;
    println!("Mish agent listening on http://{}", agent.address);
    tokio::signal::ctrl_c()
        .await
        .map_err(|error| error.to_string())?;
    agent.shutdown().await;
    Ok(())
}
