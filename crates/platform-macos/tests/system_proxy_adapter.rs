use std::sync::{Arc, Mutex};

use futures_util::future::{BoxFuture, ready};
use mish_platform_macos::{
    MacOsCommand, MacOsCommandError, MacOsCommandOutput, MacOsCommandRunner,
    MacOsSystemProxyPlatform,
};
use mish_runtime::{
    CapturePlatform, LoopbackProxyEndpoint, ManualProxyState, NetworkServiceProxyState,
};

struct FixtureRunner {
    commands: Mutex<Vec<MacOsCommand>>,
    permission_denied: bool,
}

impl FixtureRunner {
    fn new() -> Self {
        Self {
            commands: Mutex::new(Vec::new()),
            permission_denied: false,
        }
    }

    fn permission_denied() -> Self {
        Self {
            commands: Mutex::new(Vec::new()),
            permission_denied: true,
        }
    }
}

impl MacOsCommandRunner for FixtureRunner {
    fn run(
        &self,
        command: MacOsCommand,
    ) -> BoxFuture<'_, Result<MacOsCommandOutput, MacOsCommandError>> {
        self.commands.lock().unwrap().push(command.clone());
        if self.permission_denied
            && matches!(
                command,
                MacOsCommand::SetProxy { .. } | MacOsCommand::SetProxyState { .. }
            )
        {
            return Box::pin(ready(Err(MacOsCommandError {
                kind: mish_platform_macos::MacOsCommandErrorKind::PermissionDenied,
            })));
        }
        let stdout = match command {
            MacOsCommand::DefaultRoute => "route to: default\ninterface: en99\n",
            MacOsCommand::ListNetworkServiceOrder => {
                "An asterisk (*) denotes a disabled service.\n(1) Fixture Service\n(Hardware Port: Fixture Port, Device: en99)\n"
            }
            MacOsCommand::GetProxy { .. } => {
                "Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n"
            }
            MacOsCommand::GetAutoProxyUrl { .. } => "URL: (null)\nEnabled: No\n",
            MacOsCommand::GetProxyAutoDiscovery { .. } => "Auto Proxy Discovery: Off\n",
            MacOsCommand::SetProxy { .. } | MacOsCommand::SetProxyState { .. } => "",
        };
        Box::pin(ready(Ok(MacOsCommandOutput {
            stdout: stdout.into(),
        })))
    }
}

#[tokio::test]
async fn applies_only_structured_http_https_and_socks_commands() {
    let runner = Arc::new(FixtureRunner::new());
    let platform = MacOsSystemProxyPlatform::with_runner(runner.clone());
    let enabled = ManualProxyState {
        authenticated: false,
        enabled: true,
        host: Some("127.0.0.1".into()),
        port: Some(7890),
    };

    platform
        .apply_service(NetworkServiceProxyState {
            auto_discovery_enabled: false,
            http: enabled.clone(),
            https: ManualProxyState::disabled(),
            pac_enabled: false,
            service_id: "Fixture Service".into(),
            socks: enabled,
        })
        .await
        .unwrap();

    assert_eq!(
        *runner.commands.lock().unwrap(),
        [
            MacOsCommand::SetProxy {
                host: "127.0.0.1".into(),
                kind: mish_platform_macos::MacOsProxyKind::Http,
                port: 7890,
                service: "Fixture Service".into(),
            },
            MacOsCommand::SetProxyState {
                enabled: false,
                kind: mish_platform_macos::MacOsProxyKind::Https,
                service: "Fixture Service".into(),
            },
            MacOsCommand::SetProxy {
                host: "127.0.0.1".into(),
                kind: mish_platform_macos::MacOsProxyKind::Socks,
                port: 7890,
                service: "Fixture Service".into(),
            },
        ]
    );
}

#[test]
fn command_specs_use_fixed_programs_and_separate_arguments() {
    let spec = MacOsCommand::SetProxy {
        host: "127.0.0.1".into(),
        kind: mish_platform_macos::MacOsProxyKind::Http,
        port: 7890,
        service: "Fixture Service; ignored".into(),
    }
    .spec();

    assert_eq!(spec.program, "/usr/sbin/networksetup");
    assert_eq!(
        spec.arguments,
        [
            "-setwebproxy",
            "Fixture Service; ignored",
            "127.0.0.1",
            "7890",
            "off",
        ]
    );
    assert!(!spec.arguments.iter().any(|argument| argument == "-c"));
}

#[tokio::test]
async fn permission_failure_is_typed_without_reflecting_command_arguments() {
    let runner = Arc::new(FixtureRunner::permission_denied());
    let platform = MacOsSystemProxyPlatform::with_runner(runner);
    let private_host = "private.proxy.example";

    let error = platform
        .apply_service(NetworkServiceProxyState {
            auto_discovery_enabled: false,
            http: ManualProxyState {
                authenticated: false,
                enabled: true,
                host: Some(private_host.into()),
                port: Some(3128),
            },
            https: ManualProxyState::disabled(),
            pac_enabled: false,
            service_id: "Private Service".into(),
            socks: ManualProxyState::disabled(),
        })
        .await
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::PermissionDenied
    );
    assert!(!error.to_string().contains(private_host));
    assert!(!error.to_string().contains("Private Service"));
}

#[tokio::test]
async fn observes_only_the_active_service_manual_and_automatic_proxy_fields() {
    let runner = Arc::new(FixtureRunner::new());
    let platform = MacOsSystemProxyPlatform::with_runner(runner.clone());

    let observed = platform.observe_active().await.unwrap();

    assert_eq!(observed.service_id, "Fixture Service");
    assert_eq!(observed.http, ManualProxyState::disabled());
    assert_eq!(observed.https, ManualProxyState::disabled());
    assert_eq!(observed.socks, ManualProxyState::disabled());
    assert!(!observed.pac_enabled);
    assert!(!observed.auto_discovery_enabled);
    assert_eq!(runner.commands.lock().unwrap().len(), 7);
}

#[tokio::test]
async fn confirms_the_managed_listener_before_system_proxy_application() {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let platform = MacOsSystemProxyPlatform::with_runner(Arc::new(FixtureRunner::new()));
    let endpoint = LoopbackProxyEndpoint::new(&address.ip().to_string(), address.port()).unwrap();

    platform.confirm_proxy_listener(&endpoint).await.unwrap();
}
