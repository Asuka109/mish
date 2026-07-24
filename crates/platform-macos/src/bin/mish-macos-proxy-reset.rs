use std::{env, path::PathBuf, process::ExitCode, sync::Arc};

use mish_platform_macos::{FileCaptureJournalStore, MacOsSystemProxyPlatform};
use mish_runtime::{CaptureReconciler, LoopbackProxyEndpoint};

#[tokio::main]
async fn main() -> ExitCode {
    if !cfg!(target_os = "macos") {
        eprintln!("System Proxy restoration is available only on macOS");
        return ExitCode::FAILURE;
    }
    let mut arguments = env::args_os().skip(1);
    let Some(journal) = arguments.next().map(PathBuf::from) else {
        eprintln!("System Proxy restoration requires one journal path and managed proxy port");
        return ExitCode::FAILURE;
    };
    let Some(port) = arguments
        .next()
        .and_then(|value| value.to_str().and_then(|value| value.parse::<u16>().ok()))
    else {
        eprintln!("System Proxy restoration requires one valid managed proxy port");
        return ExitCode::FAILURE;
    };
    if arguments.next().is_some() || !journal.is_absolute() || port == 0 {
        eprintln!("System Proxy restoration arguments are invalid");
        return ExitCode::FAILURE;
    }
    let Ok(endpoint) = LoopbackProxyEndpoint::new("127.0.0.1", port) else {
        eprintln!("The managed proxy endpoint is invalid");
        return ExitCode::FAILURE;
    };
    let reconciler = CaptureReconciler::new(
        Arc::new(MacOsSystemProxyPlatform::new()),
        Arc::new(FileCaptureJournalStore::new(journal.clone())),
        endpoint,
    );
    if reconciler.reconcile_for_shutdown().await.is_err() || journal.exists() {
        eprintln!("The journaled System Proxy state could not be restored exactly");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
