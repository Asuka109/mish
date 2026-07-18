use std::{
    fmt::Write as _,
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
};

use mish_agent::{
    DesktopSidecar, DesktopSidecarConfig, LoopbackServerConfig, start_loopback_server,
};
use mish_runtime::MishRuntime;
use serde::Serialize;

const DEV_ORIGIN: &str = "http://127.0.0.1:4173";
const PRODUCTION_ORIGINS: [&str; 2] = ["tauri://localhost", "https://tauri.localhost"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBootstrap {
    auth_token: String,
    rpc_url: String,
}

#[tauri::command]
fn runtime_bootstrap(state: tauri::State<'_, RuntimeBootstrap>) -> RuntimeBootstrap {
    state.inner().clone()
}

pub fn run() -> Result<i32, String> {
    let auth_token = generate_auth_token()?;
    let runtime = MishRuntime::new(Arc::new(DesktopSidecar::new(DesktopSidecarConfig {
        binary: None,
        config_directory: None,
        config_file: None,
    })));
    let agent = tauri::async_runtime::block_on(start_loopback_server(
        LoopbackServerConfig {
            allowed_origins: allowed_origins(tauri::is_dev()),
            auth_token: auth_token.clone(),
            bind: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
            max_message_bytes: 1_048_576,
        },
        runtime,
    ))?;
    let bootstrap = RuntimeBootstrap {
        auth_token,
        rpc_url: format!("ws://{}/rpc", agent.address),
    };
    let app = tauri::Builder::default()
        .manage(bootstrap)
        .invoke_handler(tauri::generate_handler![runtime_bootstrap])
        .build(tauri::generate_context!())
        .map_err(|error| error.to_string())?;
    let exit_code = app.run_return(|_, _| {});
    tauri::async_runtime::block_on(agent.shutdown());
    Ok(exit_code)
}

fn allowed_origins(is_dev: bool) -> Vec<String> {
    if is_dev {
        return vec![DEV_ORIGIN.to_owned()];
    }
    PRODUCTION_ORIGINS.into_iter().map(str::to_owned).collect()
}

fn generate_auth_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "the operating system did not provide entropy")?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::{DEV_ORIGIN, PRODUCTION_ORIGINS, allowed_origins, generate_auth_token};

    #[test]
    fn authentication_tokens_are_fresh_256_bit_hex_values() {
        let first = generate_auth_token().expect("token generation should succeed");
        let second = generate_auth_token().expect("token generation should succeed");

        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn development_accepts_only_the_explicit_vite_origin() {
        assert_eq!(allowed_origins(true), [DEV_ORIGIN]);
    }

    #[test]
    fn production_accepts_only_bundled_tauri_origins() {
        assert_eq!(allowed_origins(false), PRODUCTION_ORIGINS);
    }
}
