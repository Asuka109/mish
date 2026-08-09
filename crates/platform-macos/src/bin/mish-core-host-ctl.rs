use std::path::PathBuf;

use mish_platform_macos::{
    DEV_TUN_SERVICE_CORE_PATH, MacOsTunServiceClient, development_pinned_core_version,
};
use mish_runtime::{PrivilegedCoreHost, PrivilegedCoreLaunchRequest};
use serde_json::json;

fn print_result(value: serde_json::Value) {
    println!("{value}");
}

fn fail(code: &str) -> ! {
    print_result(json!({ "code": code, "ok": false }));
    std::process::exit(1);
}

#[tokio::main]
async fn main() {
    let mut arguments = std::env::args().skip(1);
    let Some(command) = arguments.next() else {
        fail("usage-status-disable-run");
    };
    let client = MacOsTunServiceClient::development();
    match command.as_str() {
        "status" if arguments.next().is_none() => match client.core_host_status().await {
            Ok(status) => print_result(json!({
                "core": status.core.map(|core| json!({
                    "launchToken": core.launch_token(),
                    "pid": core.pid(),
                })),
                "helperVersion": status.helper_version,
                "installationId": status.installation_id,
                "observation": status.observation,
                "ok": true,
            })),
            Err(code) => fail(code),
        },
        "disable" if arguments.next().is_none() => match client.disable_core_host().await {
            Ok(()) => print_result(json!({ "ok": true, "status": "disabled" })),
            Err(code) => fail(code),
        },
        "run" => {
            let Some(config_directory) = arguments.next().map(PathBuf::from) else {
                fail("usage-run-config-directory-config-file");
            };
            let Some(config_file) = arguments.next().map(PathBuf::from) else {
                fail("usage-run-config-directory-config-file");
            };
            if arguments.next().is_some() {
                fail("usage-run-config-directory-config-file");
            }
            let version = development_pinned_core_version().unwrap_or_else(|code| fail(code));
            let request = PrivilegedCoreLaunchRequest::new(
                PathBuf::from(DEV_TUN_SERVICE_CORE_PATH),
                config_directory,
                config_file,
                version,
            );
            let process = client
                .start(request)
                .await
                .unwrap_or_else(|_| fail("core-host-start-rejected"));
            print_result(json!({
                "core": {
                    "launchToken": process.launch_token(),
                    "pid": process.pid(),
                },
                "ok": true,
                "status": "running",
            }));
            if tokio::signal::ctrl_c().await.is_err() {
                fail("core-host-signal-failed");
            }
            client
                .stop(process)
                .await
                .unwrap_or_else(|_| fail("core-host-stop-failed"));
            print_result(json!({ "ok": true, "status": "stopped" }));
        }
        _ => fail("usage-status-disable-run"),
    }
}
