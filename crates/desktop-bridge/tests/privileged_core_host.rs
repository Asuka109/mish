use std::{
    os::unix::fs::PermissionsExt,
    sync::{Arc, Mutex},
};

use futures_util::future::BoxFuture;
use mish_bridge::{
    DesktopMihomoProcess, DesktopMihomoProcessConfig, PrivilegedCoreHost, PrivilegedCoreHostError,
    PrivilegedCoreLaunchRequest, PrivilegedCoreProcess,
};
use mish_runtime::{CorePhase, CoreRuntime, LoopbackProxyEndpoint};

#[derive(Default)]
struct FakePrivilegedHost {
    process: Mutex<Option<PrivilegedCoreProcess>>,
}

impl PrivilegedCoreHost for FakePrivilegedHost {
    fn start(
        &self,
        request: PrivilegedCoreLaunchRequest,
    ) -> BoxFuture<'_, Result<PrivilegedCoreProcess, PrivilegedCoreHostError>> {
        let process = PrivilegedCoreProcess::new(4242, request.launch_token(), true);
        *self.process.lock().unwrap() = Some(process.clone());
        Box::pin(async move { Ok(process) })
    }

    fn observe(
        &self,
        process: PrivilegedCoreProcess,
    ) -> BoxFuture<'_, Result<Option<PrivilegedCoreProcess>, PrivilegedCoreHostError>> {
        let observed = self.process.lock().unwrap().clone();
        Box::pin(async move { Ok(observed.filter(|current| current == &process)) })
    }

    fn stop(
        &self,
        process: PrivilegedCoreProcess,
    ) -> BoxFuture<'_, Result<(), PrivilegedCoreHostError>> {
        let mut current = self.process.lock().unwrap();
        if current.as_ref() != Some(&process) {
            return Box::pin(async { Err(PrivilegedCoreHostError::Rejected) });
        }
        *current = None;
        Box::pin(async { Ok(()) })
    }

    fn owns_listener(
        &self,
        process: PrivilegedCoreProcess,
        _endpoint: LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<bool, PrivilegedCoreHostError>> {
        let owns = self.process.lock().unwrap().as_ref() == Some(&process);
        Box::pin(async move { Ok(owns) })
    }
}

#[tokio::test]
async fn desktop_process_uses_the_privileged_host_for_the_full_lifecycle() {
    let temporary = tempfile::tempdir().unwrap();
    let binary = temporary.path().join("mihomo-fixture");
    std::fs::write(
        &binary,
        "#!/bin/sh\nif [ \"$1\" = \"-v\" ]; then echo 'Mihomo Meta v1.19.29'; fi\n",
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config_directory = temporary.path().join("home");
    let config_file = temporary.path().join("config.yaml");
    std::fs::create_dir(&config_directory).unwrap();
    std::fs::write(&config_file, "tun:\n  enable: true\n").unwrap();
    let host = Arc::new(FakePrivilegedHost::default());
    let process = DesktopMihomoProcess::new_pinned_privileged(
        DesktopMihomoProcessConfig {
            binary: Some(binary),
            config_directory: Some(config_directory),
            config_file: Some(config_file),
        },
        "v1.19.29",
        host,
    );

    let started = process.start().await.unwrap();
    assert!(matches!(started.phase, CorePhase::Running));
    assert_eq!(started.pid, Some(4242));
    assert!(
        process
            .owns_local_proxy(&LoopbackProxyEndpoint::managed())
            .await
    );
    let stopped = process.stop().await.unwrap();
    assert!(matches!(stopped.phase, CorePhase::Stopped));
    assert_eq!(stopped.pid, None);
}
