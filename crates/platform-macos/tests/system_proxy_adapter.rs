use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use futures_util::{
    FutureExt,
    future::{BoxFuture, ready},
};
use mish_platform_macos::{
    FileCaptureJournalStore, MacOsCommand, MacOsCommandError, MacOsCommandOutput,
    MacOsCommandRunner, MacOsProxyKind, MacOsSystemProxyPlatform,
};
use mish_runtime::{
    CaptureAuditReason, CaptureJournal, CaptureJournalStore, CapturePlatform, CaptureReconciler,
    LoopbackProxyEndpoint, ManualProxyState, NetworkServiceProxyState, SystemProxyPhase,
};
use tokio::sync::Barrier;

struct FixtureRunner {
    commands: Mutex<Vec<MacOsCommand>>,
    omit_pac_url: bool,
    permission_denied: bool,
}

impl FixtureRunner {
    fn new() -> Self {
        Self {
            commands: Mutex::new(Vec::new()),
            omit_pac_url: false,
            permission_denied: false,
        }
    }

    fn without_pac_url() -> Self {
        Self {
            commands: Mutex::new(Vec::new()),
            omit_pac_url: true,
            permission_denied: false,
        }
    }

    fn permission_denied() -> Self {
        Self {
            commands: Mutex::new(Vec::new()),
            omit_pac_url: false,
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
                MacOsCommand::SetProxy { .. }
                    | MacOsCommand::SetProxyState { .. }
                    | MacOsCommand::SetAutoProxyState { .. }
                    | MacOsCommand::SetProxyAutoDiscovery { .. }
                    | MacOsCommand::SetProxyBypassDomains { .. }
            )
        {
            return Box::pin(ready(Err(MacOsCommandError {
                kind: mish_platform_macos::MacOsCommandErrorKind::PermissionDenied,
            })));
        }
        let stdout = match command {
            MacOsCommand::InterfaceConfiguration | MacOsCommand::RoutingTable => {
                panic!("TUN observation commands are outside the System Proxy fixture")
            }
            MacOsCommand::DefaultRoute => "route to: default\ninterface: en99\n",
            MacOsCommand::ListNetworkServiceOrder => {
                "An asterisk (*) denotes a disabled service.\n(1) Fixture Service\n(Hardware Port: Fixture Port, Device: en99)\n"
            }
            MacOsCommand::GetProxy { .. } => {
                "Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n"
            }
            MacOsCommand::GetAutoProxyUrl { .. } if self.omit_pac_url => "Enabled: No\n",
            MacOsCommand::GetAutoProxyUrl { .. } => "URL: (null)\nEnabled: No\n",
            MacOsCommand::GetProxyBypassDomains { .. } => {
                "There aren't any bypass domains set on Fixture Service.\n"
            }
            MacOsCommand::GetProxyAutoDiscovery { .. } => "Auto Proxy Discovery: Off\n",
            MacOsCommand::SetProxy { .. }
            | MacOsCommand::SetProxyState { .. }
            | MacOsCommand::SetAutoProxyState { .. }
            | MacOsCommand::SetProxyAutoDiscovery { .. }
            | MacOsCommand::SetProxyBypassDomains { .. } => "",
            MacOsCommand::DnsConfiguration
            | MacOsCommand::GetDnsServers { .. }
            | MacOsCommand::NetworkInformation
            | MacOsCommand::SetDnsServers { .. } => {
                panic!("Network and DNS commands do not belong to the System Proxy fixture")
            }
        };
        Box::pin(ready(Ok(MacOsCommandOutput {
            stdout: stdout.into(),
        })))
    }
}

struct StatefulCrashRunner {
    crash_after_write: Mutex<Option<usize>>,
    state: Mutex<NetworkServiceProxyState>,
    writes: Mutex<usize>,
}

struct ConcurrentObservationRunner {
    discovery: Barrier,
    getters: Barrier,
}

struct FailingObservationRunner;

struct SequentialObservationRunner {
    in_flight: AtomicBool,
}

impl SequentialObservationRunner {
    fn new() -> Self {
        Self {
            in_flight: AtomicBool::new(false),
        }
    }
}

impl ConcurrentObservationRunner {
    fn new() -> Self {
        Self {
            discovery: Barrier::new(2),
            getters: Barrier::new(6),
        }
    }
}

impl MacOsCommandRunner for ConcurrentObservationRunner {
    fn run(
        &self,
        command: MacOsCommand,
    ) -> BoxFuture<'_, Result<MacOsCommandOutput, MacOsCommandError>> {
        Box::pin(async move {
            let stdout = match command {
                MacOsCommand::DefaultRoute => {
                    self.discovery.wait().await;
                    "route to: default\ninterface: en99\n"
                }
                MacOsCommand::ListNetworkServiceOrder => {
                    self.discovery.wait().await;
                    "(1) Fixture Service\n(Hardware Port: Fixture Port, Device: en99)\n"
                }
                MacOsCommand::GetProxy { .. } => {
                    self.getters.wait().await;
                    "Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n"
                }
                MacOsCommand::GetAutoProxyUrl { .. } => {
                    self.getters.wait().await;
                    "URL: (null)\nEnabled: No\n"
                }
                MacOsCommand::GetProxyBypassDomains { .. } => {
                    self.getters.wait().await;
                    "There aren't any bypass domains set on Fixture Service.\n"
                }
                MacOsCommand::GetProxyAutoDiscovery { .. } => {
                    self.getters.wait().await;
                    "Auto Proxy Discovery: Off\n"
                }
                _ => panic!("mutation command reached read-only observation fixture"),
            };
            Ok(MacOsCommandOutput {
                stdout: stdout.into(),
            })
        })
    }
}

impl MacOsCommandRunner for FailingObservationRunner {
    fn run(
        &self,
        command: MacOsCommand,
    ) -> BoxFuture<'_, Result<MacOsCommandOutput, MacOsCommandError>> {
        match command {
            MacOsCommand::DefaultRoute => Box::pin(ready(Ok(MacOsCommandOutput {
                stdout: "route to: default\ninterface: en99\n".into(),
            }))),
            MacOsCommand::ListNetworkServiceOrder => Box::pin(ready(Ok(MacOsCommandOutput {
                stdout: "(1) Fixture Service\n(Hardware Port: Fixture Port, Device: en99)\n".into(),
            }))),
            MacOsCommand::GetProxy {
                kind: MacOsProxyKind::Http,
                ..
            } => Box::pin(ready(Err(MacOsCommandError {
                kind: mish_platform_macos::MacOsCommandErrorKind::Failed,
            }))),
            MacOsCommand::GetProxy { .. }
            | MacOsCommand::GetAutoProxyUrl { .. }
            | MacOsCommand::GetProxyAutoDiscovery { .. }
            | MacOsCommand::GetProxyBypassDomains { .. } => Box::pin(std::future::pending()),
            _ => panic!("mutation command reached failing read-only observation fixture"),
        }
    }
}

impl MacOsCommandRunner for SequentialObservationRunner {
    fn run(
        &self,
        command: MacOsCommand,
    ) -> BoxFuture<'_, Result<MacOsCommandOutput, MacOsCommandError>> {
        Box::pin(async move {
            assert!(
                !self.in_flight.swap(true, Ordering::SeqCst),
                "authoritative System Proxy observation ran commands concurrently"
            );
            tokio::task::yield_now().await;
            let stdout = match command {
                MacOsCommand::DefaultRoute => "route to: default\ninterface: en99\n",
                MacOsCommand::ListNetworkServiceOrder => {
                    "(1) Fixture Service\n(Hardware Port: Fixture Port, Device: en99)\n"
                }
                MacOsCommand::GetProxy { .. } => {
                    "Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n"
                }
                MacOsCommand::GetAutoProxyUrl { .. } => "URL: (null)\nEnabled: No\n",
                MacOsCommand::GetProxyBypassDomains { .. } => {
                    "There aren't any bypass domains set on Fixture Service.\n"
                }
                MacOsCommand::GetProxyAutoDiscovery { .. } => "Auto Proxy Discovery: Off\n",
                _ => panic!("mutation command reached authoritative observation fixture"),
            };
            self.in_flight.store(false, Ordering::SeqCst);
            Ok(MacOsCommandOutput {
                stdout: stdout.into(),
            })
        })
    }
}

impl StatefulCrashRunner {
    fn new(state: NetworkServiceProxyState) -> Self {
        Self {
            crash_after_write: Mutex::new(None),
            state: Mutex::new(state),
            writes: Mutex::new(0),
        }
    }

    fn crash_after_write(&self, write: usize) {
        *self.writes.lock().unwrap() = 0;
        *self.crash_after_write.lock().unwrap() = Some(write);
    }

    fn resume(&self) {
        *self.crash_after_write.lock().unwrap() = None;
        *self.writes.lock().unwrap() = 0;
    }

    fn state(&self) -> NetworkServiceProxyState {
        self.state.lock().unwrap().clone()
    }

    fn finish_write(&self) -> Result<MacOsCommandOutput, MacOsCommandError> {
        let mut writes = self.writes.lock().unwrap();
        *writes += 1;
        if *self.crash_after_write.lock().unwrap() == Some(*writes) {
            return Err(MacOsCommandError {
                kind: mish_platform_macos::MacOsCommandErrorKind::Failed,
            });
        }
        Ok(MacOsCommandOutput {
            stdout: String::new(),
        })
    }
}

impl MacOsCommandRunner for StatefulCrashRunner {
    fn run(
        &self,
        command: MacOsCommand,
    ) -> BoxFuture<'_, Result<MacOsCommandOutput, MacOsCommandError>> {
        let result = match command {
            MacOsCommand::DefaultRoute => Ok(MacOsCommandOutput {
                stdout: "route to: default\ninterface: en99\n".into(),
            }),
            MacOsCommand::ListNetworkServiceOrder => Ok(MacOsCommandOutput {
                stdout: "(1) Fixture Service\n(Hardware Port: Fixture Port, Device: en99)\n".into(),
            }),
            MacOsCommand::GetProxy { kind, .. } => {
                let state = self.state.lock().unwrap();
                let proxy = match kind {
                    MacOsProxyKind::Http => &state.http,
                    MacOsProxyKind::Https => &state.https,
                    MacOsProxyKind::Socks => &state.socks,
                };
                Ok(MacOsCommandOutput {
                    stdout: format!(
                        "Enabled: {}\nServer: {}\nPort: {}\nAuthenticated Proxy Enabled: {}\n",
                        if proxy.enabled { "Yes" } else { "No" },
                        proxy.host,
                        proxy.port,
                        u8::from(proxy.authenticated)
                    ),
                })
            }
            MacOsCommand::GetAutoProxyUrl { .. } => {
                let state = self.state.lock().unwrap();
                Ok(MacOsCommandOutput {
                    stdout: format!(
                        "URL: {}\nEnabled: {}\n",
                        state.pac_url,
                        if state.pac_enabled { "Yes" } else { "No" }
                    ),
                })
            }
            MacOsCommand::GetProxyBypassDomains { .. } => {
                let domains = self.state.lock().unwrap().bypass_domains.clone();
                Ok(MacOsCommandOutput {
                    stdout: if domains.is_empty() {
                        "There aren't any bypass domains set on Fixture Service.\n".into()
                    } else {
                        format!("{}\n", domains.join("\n"))
                    },
                })
            }
            MacOsCommand::GetProxyAutoDiscovery { .. } => {
                let enabled = self.state.lock().unwrap().auto_discovery_enabled;
                Ok(MacOsCommandOutput {
                    stdout: format!(
                        "Auto Proxy Discovery: {}\n",
                        if enabled { "On" } else { "Off" }
                    ),
                })
            }
            MacOsCommand::SetProxy {
                host, kind, port, ..
            } => {
                let mut state = self.state.lock().unwrap();
                let proxy = match kind {
                    MacOsProxyKind::Http => &mut state.http,
                    MacOsProxyKind::Https => &mut state.https,
                    MacOsProxyKind::Socks => &mut state.socks,
                };
                proxy.authenticated = false;
                proxy.host = host;
                proxy.port = port;
                drop(state);
                self.finish_write()
            }
            MacOsCommand::SetProxyState { enabled, kind, .. } => {
                let mut state = self.state.lock().unwrap();
                match kind {
                    MacOsProxyKind::Http => state.http.enabled = enabled,
                    MacOsProxyKind::Https => state.https.enabled = enabled,
                    MacOsProxyKind::Socks => state.socks.enabled = enabled,
                }
                drop(state);
                self.finish_write()
            }
            MacOsCommand::SetAutoProxyState { enabled, .. } => {
                self.state.lock().unwrap().pac_enabled = enabled;
                self.finish_write()
            }
            MacOsCommand::SetProxyAutoDiscovery { enabled, .. } => {
                self.state.lock().unwrap().auto_discovery_enabled = enabled;
                self.finish_write()
            }
            MacOsCommand::SetProxyBypassDomains { domains, .. } => {
                self.state.lock().unwrap().bypass_domains = domains;
                self.finish_write()
            }
            MacOsCommand::InterfaceConfiguration
            | MacOsCommand::RoutingTable
            | MacOsCommand::DnsConfiguration
            | MacOsCommand::GetDnsServers { .. }
            | MacOsCommand::SetDnsServers { .. }
            | MacOsCommand::NetworkInformation => {
                panic!("non-System-Proxy command reached crash fixture")
            }
        };
        Box::pin(ready(result))
    }
}

fn crash_fixture_prior() -> NetworkServiceProxyState {
    NetworkServiceProxyState {
        auto_discovery_enabled: false,
        bypass_domains: vec!["intranet.fixture.invalid".into(), "*.LOCAL".into()],
        http: ManualProxyState {
            authenticated: false,
            enabled: false,
            host: "prior-http.proxy.example".into(),
            port: 3128,
        },
        https: ManualProxyState {
            authenticated: false,
            enabled: true,
            host: "prior-https.proxy.example".into(),
            port: 4443,
        },
        pac_enabled: false,
        pac_url: "http://pac.example/original.pac".into(),
        service_id: "Fixture Service".into(),
        socks: ManualProxyState {
            authenticated: false,
            enabled: false,
            host: "prior-socks.proxy.example".into(),
            port: 1080,
        },
    }
}

fn crash_fixture_target(prior: &NetworkServiceProxyState) -> NetworkServiceProxyState {
    let proxy = ManualProxyState {
        authenticated: false,
        enabled: true,
        host: "127.0.0.1".into(),
        port: 7890,
    };
    NetworkServiceProxyState {
        bypass_domains: vec![
            "intranet.fixture.invalid".into(),
            "*.LOCAL".into(),
            "localhost".into(),
            "*.localhost".into(),
            "*.local.".into(),
            "*.home.arpa".into(),
            "*.home.arpa.".into(),
        ],
        http: proxy.clone(),
        https: proxy.clone(),
        socks: proxy,
        ..prior.clone()
    }
}

async fn assert_restart_recovers_after_write(
    initial: NetworkServiceProxyState,
    write_target: NetworkServiceProxyState,
    prior: NetworkServiceProxyState,
    crash_after_write: usize,
) {
    let root = tempfile::tempdir().unwrap();
    let journal = Arc::new(FileCaptureJournalStore::new(
        root.path().join("system-proxy-journal.json"),
    ));
    journal
        .save(&CaptureJournal {
            prior: prior.clone(),
        })
        .unwrap();
    let runner = Arc::new(StatefulCrashRunner::new(initial));
    let platform = Arc::new(MacOsSystemProxyPlatform::with_runner(runner.clone()));
    runner.crash_after_write(crash_after_write);

    platform.apply_service(write_target).await.unwrap_err();
    runner.resume();
    let restarted =
        CaptureReconciler::new(platform, journal.clone(), LoopbackProxyEndpoint::managed());
    let status = restarted
        .audit(CaptureAuditReason::Restart, false)
        .await
        .unwrap();

    assert_eq!(status.system_proxy.phase, SystemProxyPhase::Off);
    assert_eq!(runner.state(), prior);
    assert!(journal.load().unwrap().is_none());
}

#[tokio::test]
async fn applies_structured_manual_automatic_and_bypass_proxy_commands() {
    let runner = Arc::new(FixtureRunner::new());
    let platform = MacOsSystemProxyPlatform::with_runner(runner.clone());
    let enabled = ManualProxyState {
        authenticated: false,
        enabled: true,
        host: "127.0.0.1".into(),
        port: 7890,
    };

    platform
        .apply_service(NetworkServiceProxyState {
            auto_discovery_enabled: false,
            bypass_domains: Vec::new(),
            http: enabled.clone(),
            https: ManualProxyState::disabled(),
            pac_enabled: false,
            pac_url: "(null)".into(),
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
                enabled: true,
                kind: mish_platform_macos::MacOsProxyKind::Http,
                service: "Fixture Service".into(),
            },
            MacOsCommand::SetProxy {
                host: String::new(),
                kind: mish_platform_macos::MacOsProxyKind::Https,
                port: 0,
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
            MacOsCommand::SetProxyState {
                enabled: true,
                kind: mish_platform_macos::MacOsProxyKind::Socks,
                service: "Fixture Service".into(),
            },
            MacOsCommand::SetAutoProxyState {
                enabled: false,
                service: "Fixture Service".into(),
            },
            MacOsCommand::SetProxyAutoDiscovery {
                enabled: false,
                service: "Fixture Service".into(),
            },
            MacOsCommand::SetProxyBypassDomains {
                domains: Vec::new(),
                service: "Fixture Service".into(),
            },
        ]
    );
}

#[tokio::test]
async fn active_service_discovery_and_proxy_getters_run_in_independent_parallel_groups() {
    let platform =
        MacOsSystemProxyPlatform::with_runner(Arc::new(ConcurrentObservationRunner::new()));

    let observed = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        platform.preflight_observe_active(),
    )
    .await
    .expect("independent read-only macOS commands ran serially")
    .unwrap();

    assert_eq!(
        observed,
        NetworkServiceProxyState {
            auto_discovery_enabled: false,
            bypass_domains: Vec::new(),
            http: ManualProxyState::disabled(),
            https: ManualProxyState::disabled(),
            pac_enabled: false,
            pac_url: "(null)".into(),
            service_id: "Fixture Service".into(),
            socks: ManualProxyState::disabled(),
        }
    );
}

#[tokio::test]
async fn active_service_observation_returns_the_first_parallel_getter_failure() {
    let platform = MacOsSystemProxyPlatform::with_runner(Arc::new(FailingObservationRunner));

    let error = platform
        .preflight_observe_active()
        .now_or_never()
        .expect("parallel System Proxy observation waited for unrelated pending getters")
        .unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::ObservationFailed
    );
}

#[tokio::test]
async fn authoritative_active_service_observation_reads_one_coherent_snapshot_serially() {
    let platform =
        MacOsSystemProxyPlatform::with_runner(Arc::new(SequentialObservationRunner::new()));

    let observed = platform.observe_active().await.unwrap();

    assert_eq!(observed.service_id, "Fixture Service");
    assert_eq!(observed.http, ManualProxyState::disabled());
    assert_eq!(observed.https, ManualProxyState::disabled());
    assert_eq!(observed.socks, ManualProxyState::disabled());
}

#[tokio::test]
async fn every_apply_and_restore_write_is_restart_recoverable() {
    let prior = crash_fixture_prior();
    let target = crash_fixture_target(&prior);

    for crash_after_write in 1..=9 {
        assert_restart_recovers_after_write(
            prior.clone(),
            target.clone(),
            prior.clone(),
            crash_after_write,
        )
        .await;
    }

    for crash_after_write in 1..=9 {
        assert_restart_recovers_after_write(
            target.clone(),
            prior.clone(),
            prior.clone(),
            crash_after_write,
        )
        .await;
    }
}

#[tokio::test]
async fn restores_populated_disabled_fields_before_the_final_disabled_state() {
    let runner = Arc::new(FixtureRunner::new());
    let platform = MacOsSystemProxyPlatform::with_runner(runner.clone());
    let populated_disabled = ManualProxyState {
        authenticated: false,
        enabled: false,
        host: "prior.proxy.example".into(),
        port: 3128,
    };

    platform
        .apply_service(NetworkServiceProxyState {
            auto_discovery_enabled: false,
            bypass_domains: Vec::new(),
            http: populated_disabled.clone(),
            https: populated_disabled.clone(),
            pac_enabled: false,
            pac_url: "http://pac.example/proxy.pac".into(),
            service_id: "Fixture Service".into(),
            socks: populated_disabled,
        })
        .await
        .unwrap();

    let commands = runner.commands.lock().unwrap();
    assert_eq!(commands.len(), 9);
    for pair in commands[..6].chunks_exact(2) {
        assert!(matches!(
            &pair[0],
            MacOsCommand::SetProxy { host, port: 3128, .. } if host == "prior.proxy.example"
        ));
        assert!(matches!(
            pair[1],
            MacOsCommand::SetProxyState { enabled: false, .. }
        ));
    }
    assert!(matches!(
        commands[6],
        MacOsCommand::SetAutoProxyState { enabled: false, .. }
    ));
    assert!(matches!(
        commands[7],
        MacOsCommand::SetProxyAutoDiscovery { enabled: false, .. }
    ));
    assert!(matches!(
        commands[8],
        MacOsCommand::SetProxyBypassDomains { .. }
    ));
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

#[test]
fn proxy_bypass_command_preserves_order_and_uses_empty_only_for_an_empty_list() {
    let populated = MacOsCommand::SetProxyBypassDomains {
        domains: vec!["intranet.fixture.invalid".into(), "*.local".into()],
        service: "Fixture Service; ignored".into(),
    }
    .spec();
    assert_eq!(
        populated.arguments,
        [
            "-setproxybypassdomains",
            "Fixture Service; ignored",
            "intranet.fixture.invalid",
            "*.local",
        ]
    );

    let empty = MacOsCommand::SetProxyBypassDomains {
        domains: Vec::new(),
        service: "Fixture Service".into(),
    }
    .spec();
    assert_eq!(
        empty.arguments,
        ["-setproxybypassdomains", "Fixture Service", "Empty"]
    );
}

#[tokio::test]
async fn permission_failure_is_typed_without_reflecting_command_arguments() {
    let runner = Arc::new(FixtureRunner::permission_denied());
    let platform = MacOsSystemProxyPlatform::with_runner(runner);
    let private_host = "private.proxy.example";

    let error = platform
        .apply_service(NetworkServiceProxyState {
            auto_discovery_enabled: false,
            bypass_domains: Vec::new(),
            http: ManualProxyState {
                authenticated: false,
                enabled: true,
                host: private_host.into(),
                port: 3128,
            },
            https: ManualProxyState::disabled(),
            pac_enabled: false,
            pac_url: "(null)".into(),
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
    assert_eq!(observed.pac_url, "(null)");
    assert!(!observed.auto_discovery_enabled);
    assert_eq!(observed.bypass_domains, Vec::<String>::new());
    assert_eq!(runner.commands.lock().unwrap().len(), 8);
}

#[tokio::test]
async fn observation_rejects_a_missing_pac_url_without_mutation() {
    let runner = Arc::new(FixtureRunner::without_pac_url());
    let platform = MacOsSystemProxyPlatform::with_runner(runner.clone());

    let error = platform.observe_active().await.unwrap_err();

    assert_eq!(
        error.kind,
        mish_runtime::CaptureFailureKind::ObservationFailed
    );
    assert!(
        !runner
            .commands
            .lock()
            .unwrap()
            .iter()
            .any(|command| matches!(
                command,
                MacOsCommand::SetProxy { .. } | MacOsCommand::SetProxyState { .. }
            ))
    );
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
