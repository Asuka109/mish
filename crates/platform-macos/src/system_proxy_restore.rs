use std::process::Stdio;

use futures_util::future::BoxFuture;
use mish_runtime::{ManualProxyState, NetworkServiceProxyState};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time::{Duration, timeout},
};
use tokio_util::sync::CancellationToken;

pub const EXACT_PROXY_RESTORE_TIMEOUT: Duration = Duration::from_secs(30);
pub const EXACT_PROXY_RESTORE_MAX_OUTPUT_BYTES: usize = 65_536;
pub const EXACT_PROXY_RESTORE_MAX_SCRIPT_BYTES: usize = 65_536;

const EXACT_PROXY_KEY_HTTP_ENABLE: &str = "HTTPEnable";
const EXACT_PROXY_KEY_HTTP_PROXY: &str = "HTTPProxy";
const EXACT_PROXY_KEY_HTTP_PORT: &str = "HTTPPort";
const EXACT_PROXY_KEY_HTTPS_ENABLE: &str = "HTTPSEnable";
const EXACT_PROXY_KEY_HTTPS_PROXY: &str = "HTTPSProxy";
const EXACT_PROXY_KEY_HTTPS_PORT: &str = "HTTPSPort";
const EXACT_PROXY_KEY_SOCKS_ENABLE: &str = "SOCKSEnable";
const EXACT_PROXY_KEY_SOCKS_PROXY: &str = "SOCKSProxy";
const EXACT_PROXY_KEY_SOCKS_PORT: &str = "SOCKSPort";
const EXACT_PROXY_KEY_PAC_ENABLE: &str = "ProxyAutoConfigEnable";
const EXACT_PROXY_KEY_PAC_URL: &str = "ProxyAutoConfigURL";
const EXACT_PROXY_KEY_AUTO_DISCOVERY_ENABLE: &str = "ProxyAutoDiscoveryEnable";

const PREFERENCES_COMPLETE_MARKER: &str = "mish-system-proxy-restore:preferences-complete";
const PREFERENCES_FAILED_MARKER: &str = "mish-system-proxy-restore:preferences-failed";
const DYNAMIC_STORE_COMPLETE_MARKER: &str = "mish-system-proxy-restore:dynamic-store-complete";
const DYNAMIC_STORE_FAILED_MARKER: &str = "mish-system-proxy-restore:dynamic-store-failed";

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MacOsSystemProxyRestoreField {
    AutoDiscoveryEnable,
    HttpEnable,
    HttpPort,
    HttpProxy,
    HttpsEnable,
    HttpsPort,
    HttpsProxy,
    PacEnable,
    PacUrl,
    SocksEnable,
    SocksPort,
    SocksProxy,
}

impl MacOsSystemProxyRestoreField {
    const fn key(self) -> &'static str {
        match self {
            Self::AutoDiscoveryEnable => EXACT_PROXY_KEY_AUTO_DISCOVERY_ENABLE,
            Self::HttpEnable => EXACT_PROXY_KEY_HTTP_ENABLE,
            Self::HttpPort => EXACT_PROXY_KEY_HTTP_PORT,
            Self::HttpProxy => EXACT_PROXY_KEY_HTTP_PROXY,
            Self::HttpsEnable => EXACT_PROXY_KEY_HTTPS_ENABLE,
            Self::HttpsPort => EXACT_PROXY_KEY_HTTPS_PORT,
            Self::HttpsProxy => EXACT_PROXY_KEY_HTTPS_PROXY,
            Self::PacEnable => EXACT_PROXY_KEY_PAC_ENABLE,
            Self::PacUrl => EXACT_PROXY_KEY_PAC_URL,
            Self::SocksEnable => EXACT_PROXY_KEY_SOCKS_ENABLE,
            Self::SocksPort => EXACT_PROXY_KEY_SOCKS_PORT,
            Self::SocksProxy => EXACT_PROXY_KEY_SOCKS_PROXY,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MacOsSystemProxyRestoreStep {
    Preferences,
    DynamicStore,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MacOsSystemProxyRestoreFailureKind {
    InvalidRequest,
    Failed,
    OutputTooLarge,
    PermissionDenied,
    TimedOut,
    Cancelled,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MacOsSystemProxyRestoreOutcome {
    Restored {
        completed_steps: Vec<MacOsSystemProxyRestoreStep>,
    },
    PartiallyRestored {
        completed_steps: Vec<MacOsSystemProxyRestoreStep>,
        failed_step: Option<MacOsSystemProxyRestoreStep>,
        failure: MacOsSystemProxyRestoreFailureKind,
    },
    Failed {
        failed_step: Option<MacOsSystemProxyRestoreStep>,
        failure: MacOsSystemProxyRestoreFailureKind,
    },
}

impl MacOsSystemProxyRestoreOutcome {
    pub const fn failure_kind(&self) -> Option<MacOsSystemProxyRestoreFailureKind> {
        match self {
            Self::Restored { .. } => None,
            Self::PartiallyRestored { failure, .. } | Self::Failed { failure, .. } => {
                Some(*failure)
            }
        }
    }

    pub const fn is_restored(&self) -> bool {
        matches!(self, Self::Restored { .. })
    }
}

pub trait MacOsSystemProxyRestoreAdapter: Send + Sync {
    fn restore_exact_fields(
        &self,
        service: String,
        fields: Vec<MacOsSystemProxyRestoreField>,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, MacOsSystemProxyRestoreOutcome>;
}

pub(super) struct NoopMacOsSystemProxyRestoreAdapter;

impl MacOsSystemProxyRestoreAdapter for NoopMacOsSystemProxyRestoreAdapter {
    fn restore_exact_fields(
        &self,
        _service: String,
        _fields: Vec<MacOsSystemProxyRestoreField>,
        _cancellation: CancellationToken,
    ) -> BoxFuture<'_, MacOsSystemProxyRestoreOutcome> {
        Box::pin(std::future::ready(
            MacOsSystemProxyRestoreOutcome::Restored {
                completed_steps: vec![],
            },
        ))
    }
}

pub(super) struct NativeMacOsSystemProxyRestoreAdapter;

impl MacOsSystemProxyRestoreAdapter for NativeMacOsSystemProxyRestoreAdapter {
    fn restore_exact_fields(
        &self,
        service: String,
        fields: Vec<MacOsSystemProxyRestoreField>,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, MacOsSystemProxyRestoreOutcome> {
        Box::pin(async move { restore_exact_fields(service, fields, cancellation).await })
    }
}

pub(super) fn native_adapter() -> NativeMacOsSystemProxyRestoreAdapter {
    NativeMacOsSystemProxyRestoreAdapter
}

pub(super) fn exact_restore_fields(
    target: &NetworkServiceProxyState,
) -> Vec<MacOsSystemProxyRestoreField> {
    let mut fields = Vec::new();
    for (proxy, enable, host, port) in [
        (
            &target.http,
            MacOsSystemProxyRestoreField::HttpEnable,
            MacOsSystemProxyRestoreField::HttpProxy,
            MacOsSystemProxyRestoreField::HttpPort,
        ),
        (
            &target.https,
            MacOsSystemProxyRestoreField::HttpsEnable,
            MacOsSystemProxyRestoreField::HttpsProxy,
            MacOsSystemProxyRestoreField::HttpsPort,
        ),
        (
            &target.socks,
            MacOsSystemProxyRestoreField::SocksEnable,
            MacOsSystemProxyRestoreField::SocksProxy,
            MacOsSystemProxyRestoreField::SocksPort,
        ),
    ] {
        if is_blank_disabled(proxy) {
            fields.extend([enable, host, port]);
        }
    }
    if !target.pac_enabled && target.pac_url == "(null)" {
        fields.extend([
            MacOsSystemProxyRestoreField::PacEnable,
            MacOsSystemProxyRestoreField::PacUrl,
        ]);
    }
    if !target.auto_discovery_enabled {
        fields.push(MacOsSystemProxyRestoreField::AutoDiscoveryEnable);
    }
    fields.sort_unstable();
    fields.dedup();
    fields
}

fn is_blank_disabled(proxy: &ManualProxyState) -> bool {
    !proxy.enabled && !proxy.authenticated && proxy.host.is_empty() && proxy.port == 0
}

async fn restore_exact_fields(
    service: String,
    fields: Vec<MacOsSystemProxyRestoreField>,
    cancellation: CancellationToken,
) -> MacOsSystemProxyRestoreOutcome {
    let fields = normalize_fields(fields);
    if fields.is_empty() {
        return MacOsSystemProxyRestoreOutcome::Restored {
            completed_steps: vec![],
        };
    }
    if cancellation.is_cancelled() {
        return MacOsSystemProxyRestoreOutcome::Failed {
            failed_step: None,
            failure: MacOsSystemProxyRestoreFailureKind::Cancelled,
        };
    }
    if !valid_service_name(&service) {
        return MacOsSystemProxyRestoreOutcome::Failed {
            failed_step: None,
            failure: MacOsSystemProxyRestoreFailureKind::InvalidRequest,
        };
    }
    let service_uuid = match service_uuid_for_name(&service) {
        Ok(uuid) => uuid,
        Err(failure) => {
            return MacOsSystemProxyRestoreOutcome::Failed {
                failed_step: None,
                failure,
            };
        }
    };
    let Some(script) = exact_proxy_restore_script(&service_uuid, &fields) else {
        return MacOsSystemProxyRestoreOutcome::Failed {
            failed_step: None,
            failure: MacOsSystemProxyRestoreFailureKind::InvalidRequest,
        };
    };
    run_authorized_shell_script(&script, cancellation).await
}

fn normalize_fields(
    mut fields: Vec<MacOsSystemProxyRestoreField>,
) -> Vec<MacOsSystemProxyRestoreField> {
    fields.sort_unstable();
    fields.dedup();
    fields
}

fn valid_service_name(value: &str) -> bool {
    !value.is_empty() && value.len() <= 253 && !value.chars().any(char::is_control)
}

#[derive(Clone, Debug)]
struct RestoreProgress {
    completed_steps: Vec<MacOsSystemProxyRestoreStep>,
    failed_step: Option<MacOsSystemProxyRestoreStep>,
}

impl RestoreProgress {
    fn from_stdout(stdout: &str) -> Self {
        let mut completed_steps = Vec::new();
        let mut failed_step = None;
        for line in stdout
            .lines()
            .map(str::trim)
            .map(|line| line.strip_prefix("ok:").unwrap_or(line))
        {
            let (completed, failed) = match line {
                PREFERENCES_COMPLETE_MARKER => {
                    (Some(MacOsSystemProxyRestoreStep::Preferences), None)
                }
                DYNAMIC_STORE_COMPLETE_MARKER => {
                    (Some(MacOsSystemProxyRestoreStep::DynamicStore), None)
                }
                PREFERENCES_FAILED_MARKER => (None, Some(MacOsSystemProxyRestoreStep::Preferences)),
                DYNAMIC_STORE_FAILED_MARKER => {
                    (None, Some(MacOsSystemProxyRestoreStep::DynamicStore))
                }
                _ => (None, None),
            };
            if let Some(step) = completed
                && !completed_steps.contains(&step)
            {
                completed_steps.push(step);
            }
            if failed_step.is_none() {
                failed_step = failed;
            }
        }
        completed_steps.sort_unstable();
        Self {
            completed_steps,
            failed_step,
        }
    }
}

fn outcome_for_failure(
    failure: MacOsSystemProxyRestoreFailureKind,
    progress: RestoreProgress,
    may_have_mutated: bool,
) -> MacOsSystemProxyRestoreOutcome {
    if may_have_mutated || !progress.completed_steps.is_empty() {
        MacOsSystemProxyRestoreOutcome::PartiallyRestored {
            completed_steps: progress.completed_steps,
            failed_step: progress.failed_step,
            failure,
        }
    } else {
        MacOsSystemProxyRestoreOutcome::Failed {
            failed_step: progress.failed_step,
            failure,
        }
    }
}

async fn run_authorized_shell_script(
    script: &str,
    cancellation: CancellationToken,
) -> MacOsSystemProxyRestoreOutcome {
    if script.len() > EXACT_PROXY_RESTORE_MAX_SCRIPT_BYTES {
        return MacOsSystemProxyRestoreOutcome::Failed {
            failed_step: None,
            failure: MacOsSystemProxyRestoreFailureKind::InvalidRequest,
        };
    }
    let mut process = Command::new("/usr/bin/osascript");
    process
        .args([
            "-e",
            "on run argv",
            "-e",
            "try",
            "-e",
            "set commandOutput to do shell script (item 1 of argv) with administrator privileges",
            "-e",
            "return \"ok:\" & commandOutput",
            "-e",
            "on error errorMessage number errorNumber",
            "-e",
            "return \"error:\" & (errorNumber as string) & \":\" & errorMessage",
            "-e",
            "end try",
            "-e",
            "end run",
            "--",
            script,
        ])
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => {
            return MacOsSystemProxyRestoreOutcome::Failed {
                failed_step: None,
                failure: if error.kind() == std::io::ErrorKind::NotFound {
                    MacOsSystemProxyRestoreFailureKind::Unavailable
                } else {
                    MacOsSystemProxyRestoreFailureKind::Failed
                },
            };
        }
    };
    let Some(stdout) = child.stdout.take() else {
        terminate_child(&mut child).await;
        return MacOsSystemProxyRestoreOutcome::Failed {
            failed_step: None,
            failure: MacOsSystemProxyRestoreFailureKind::Failed,
        };
    };
    let Some(stderr) = child.stderr.take() else {
        terminate_child(&mut child).await;
        return MacOsSystemProxyRestoreOutcome::Failed {
            failed_step: None,
            failure: MacOsSystemProxyRestoreFailureKind::Failed,
        };
    };

    let collected = tokio::select! {
        _ = cancellation.cancelled() => {
            terminate_child(&mut child).await;
            return outcome_for_failure(
                MacOsSystemProxyRestoreFailureKind::Cancelled,
                RestoreProgress { completed_steps: vec![], failed_step: None },
                true,
            );
        }
        result = timeout(EXACT_PROXY_RESTORE_TIMEOUT, async {
            tokio::try_join!(
                read_bounded(stdout),
                read_bounded(stderr),
                async {
                    child.wait().await.map_err(|_| {
                        MacOsSystemProxyRestoreFailureKind::Failed
                    })
                },
            )
        }) => result,
    };
    let (stdout, stderr, status) = match collected {
        Ok(Ok(output)) => output,
        Ok(Err(failure)) => {
            terminate_child(&mut child).await;
            return outcome_for_failure(
                failure,
                RestoreProgress {
                    completed_steps: vec![],
                    failed_step: None,
                },
                true,
            );
        }
        Err(_) => {
            terminate_child(&mut child).await;
            return outcome_for_failure(
                MacOsSystemProxyRestoreFailureKind::TimedOut,
                RestoreProgress {
                    completed_steps: vec![],
                    failed_step: None,
                },
                true,
            );
        }
    };
    let stdout = String::from_utf8_lossy(&stdout);
    let progress = RestoreProgress::from_stdout(&stdout);
    if status.success()
        && progress.failed_step.is_none()
        && progress
            .completed_steps
            .contains(&MacOsSystemProxyRestoreStep::Preferences)
        && progress
            .completed_steps
            .contains(&MacOsSystemProxyRestoreStep::DynamicStore)
    {
        return MacOsSystemProxyRestoreOutcome::Restored {
            completed_steps: progress.completed_steps,
        };
    }
    let stderr = String::from_utf8_lossy(&stderr).to_ascii_lowercase();
    let failure = if stderr.contains("permission")
        || stderr.contains("not authorized")
        || stdout.to_ascii_lowercase().contains("error:-128")
    {
        MacOsSystemProxyRestoreFailureKind::PermissionDenied
    } else {
        MacOsSystemProxyRestoreFailureKind::Failed
    };
    outcome_for_failure(failure, progress, false)
}

async fn terminate_child(child: &mut tokio::process::Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn read_bounded(
    reader: impl AsyncRead + Unpin,
) -> Result<Vec<u8>, MacOsSystemProxyRestoreFailureKind> {
    let mut bytes = Vec::with_capacity(EXACT_PROXY_RESTORE_MAX_OUTPUT_BYTES.min(8_192));
    reader
        .take((EXACT_PROXY_RESTORE_MAX_OUTPUT_BYTES.saturating_add(1)) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| MacOsSystemProxyRestoreFailureKind::Failed)?;
    if bytes.len() > EXACT_PROXY_RESTORE_MAX_OUTPUT_BYTES {
        return Err(MacOsSystemProxyRestoreFailureKind::OutputTooLarge);
    }
    Ok(bytes)
}

fn exact_proxy_restore_script(
    service_uuid: &str,
    fields: &[MacOsSystemProxyRestoreField],
) -> Option<String> {
    if !valid_service_uuid(service_uuid) || fields.is_empty() {
        return None;
    }
    let fields = normalize_fields(fields.to_vec());
    let service_path = format!("/NetworkServices/{service_uuid}/Proxies");
    let mut preference_commands = vec!["d.init".to_owned(), format!("get {service_path}")];
    preference_commands.extend(
        fields
            .iter()
            .map(|field| format!("d.remove {}", field.key())),
    );
    preference_commands.extend([
        format!("set {service_path}"),
        "commit".to_owned(),
        "apply".to_owned(),
        "quit".to_owned(),
    ]);
    let mut dynamic_commands = vec![
        "open".to_owned(),
        "d.init".to_owned(),
        "get State:/Network/Global/Proxies".to_owned(),
    ];
    dynamic_commands.extend(
        fields
            .iter()
            .map(|field| format!("d.remove {}", field.key())),
    );
    dynamic_commands.extend([
        "set State:/Network/Global/Proxies".to_owned(),
        "quit".to_owned(),
    ]);

    let preference_input = preference_commands
        .iter()
        .map(|command| shell_quote(command))
        .collect::<Vec<_>>()
        .join(" ");
    let dynamic_input = dynamic_commands
        .iter()
        .map(|command| shell_quote(command))
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!(
        "set -eu\nif /usr/bin/printf '%s\\n' {preference_input} | /usr/sbin/scutil --prefs >/dev/null; then\n  /usr/bin/printf '%s\\n' '{PREFERENCES_COMPLETE_MARKER}'\nelse\n  /usr/bin/printf '%s\\n' '{PREFERENCES_FAILED_MARKER}'\n  exit 0\nfi\nif /usr/bin/printf '%s\\n' {dynamic_input} | /usr/sbin/scutil >/dev/null; then\n  /usr/bin/printf '%s\\n' '{DYNAMIC_STORE_COMPLETE_MARKER}'\nelse\n  /usr/bin/printf '%s\\n' '{DYNAMIC_STORE_FAILED_MARKER}'\n  exit 0\nfi"
    ))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn valid_service_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(target_os = "macos")]
fn service_uuid_for_name(service_name: &str) -> Result<String, MacOsSystemProxyRestoreFailureKind> {
    use system_configuration::{
        core_foundation::{base::TCFType, string::CFString},
        network_configuration::SCNetworkService,
        preferences::SCPreferences,
        sys::network_configuration::SCNetworkServiceGetName,
    };

    let preferences = SCPreferences::default(&CFString::new("io.mish.proxy.restore"));
    for service in SCNetworkService::get_services(&preferences).into_iter() {
        // SAFETY: the service reference is owned by the live SCPreferences service array.
        let name = unsafe {
            let value = SCNetworkServiceGetName(service.as_concrete_TypeRef());
            (!value.is_null()).then(|| CFString::wrap_under_get_rule(value).to_string())
        };
        if name.as_deref() != Some(service_name) {
            continue;
        }
        return service
            .id()
            .map(|value| value.to_string())
            .filter(|value| valid_service_uuid(value))
            .ok_or(MacOsSystemProxyRestoreFailureKind::Failed);
    }
    Err(MacOsSystemProxyRestoreFailureKind::Failed)
}

#[cfg(not(target_os = "macos"))]
fn service_uuid_for_name(
    _service_name: &str,
) -> Result<String, MacOsSystemProxyRestoreFailureKind> {
    Err(MacOsSystemProxyRestoreFailureKind::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_fields_cover_only_blank_disabled_proxy_values() {
        let target = NetworkServiceProxyState {
            auto_discovery_enabled: false,
            bypass_domains: Vec::new(),
            http: ManualProxyState::disabled(),
            https: ManualProxyState {
                authenticated: false,
                enabled: false,
                host: "cached.proxy.example".into(),
                port: 8080,
            },
            pac_enabled: false,
            pac_url: "(null)".into(),
            service_id: "Fixture Service".into(),
            socks: ManualProxyState::disabled(),
        };
        let fields = exact_restore_fields(&target);
        assert!(fields.contains(&MacOsSystemProxyRestoreField::HttpEnable));
        assert!(fields.contains(&MacOsSystemProxyRestoreField::HttpProxy));
        assert!(fields.contains(&MacOsSystemProxyRestoreField::HttpPort));
        assert!(fields.contains(&MacOsSystemProxyRestoreField::SocksEnable));
        assert!(fields.contains(&MacOsSystemProxyRestoreField::PacEnable));
        assert!(fields.contains(&MacOsSystemProxyRestoreField::PacUrl));
        assert!(fields.contains(&MacOsSystemProxyRestoreField::AutoDiscoveryEnable));
        assert!(!fields.contains(&MacOsSystemProxyRestoreField::HttpsEnable));
        assert!(!fields.contains(&MacOsSystemProxyRestoreField::HttpsProxy));
        assert!(!fields.contains(&MacOsSystemProxyRestoreField::HttpsPort));
    }

    #[test]
    fn exact_restore_script_is_closed_and_marks_both_storage_steps() {
        let script = exact_proxy_restore_script(
            "11111111-1111-4111-8111-111111111111",
            &[
                MacOsSystemProxyRestoreField::HttpEnable,
                MacOsSystemProxyRestoreField::HttpEnable,
            ],
        )
        .expect("valid fixed restore script");
        assert!(script.contains("/usr/sbin/scutil --prefs"));
        assert!(
            script.contains("get /NetworkServices/11111111-1111-4111-8111-111111111111/Proxies")
        );
        assert!(script.contains(PREFERENCES_COMPLETE_MARKER));
        assert!(script.contains(DYNAMIC_STORE_COMPLETE_MARKER));
        assert!(script.contains(PREFERENCES_FAILED_MARKER));
        assert!(script.contains(DYNAMIC_STORE_FAILED_MARKER));
        assert!(!script.contains("rm "));
    }

    #[test]
    fn progress_is_bounded_and_distinguishes_partial_storage_restore() {
        let progress = RestoreProgress::from_stdout(&format!(
            "ok:{PREFERENCES_COMPLETE_MARKER}\n{DYNAMIC_STORE_FAILED_MARKER}\n"
        ));
        assert_eq!(
            progress.completed_steps,
            vec![MacOsSystemProxyRestoreStep::Preferences]
        );
        assert_eq!(
            progress.failed_step,
            Some(MacOsSystemProxyRestoreStep::DynamicStore)
        );
        assert_eq!(
            outcome_for_failure(
                MacOsSystemProxyRestoreFailureKind::OutputTooLarge,
                progress,
                false,
            ),
            MacOsSystemProxyRestoreOutcome::PartiallyRestored {
                completed_steps: vec![MacOsSystemProxyRestoreStep::Preferences],
                failed_step: Some(MacOsSystemProxyRestoreStep::DynamicStore),
                failure: MacOsSystemProxyRestoreFailureKind::OutputTooLarge,
            }
        );
    }

    #[test]
    fn invalid_service_uuid_never_builds_a_restore_script() {
        assert!(
            exact_proxy_restore_script(
                "not-a-service-uuid",
                &[MacOsSystemProxyRestoreField::HttpEnable]
            )
            .is_none()
        );
    }

    #[tokio::test]
    async fn pre_cancelled_restore_never_starts_the_authorized_process() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert_eq!(
            restore_exact_fields(
                "Fixture Service".into(),
                vec![MacOsSystemProxyRestoreField::HttpEnable],
                cancellation,
            )
            .await,
            MacOsSystemProxyRestoreOutcome::Failed {
                failed_step: None,
                failure: MacOsSystemProxyRestoreFailureKind::Cancelled,
            }
        );
    }
}
