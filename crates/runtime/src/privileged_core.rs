use std::{
    fmt,
    path::{Path, PathBuf},
};

use futures_util::future::BoxFuture;
use uuid::Uuid;

use crate::LoopbackProxyEndpoint;

/// Core version shared by runtime coordination, Controller validation, Settings projection, and
/// platform launch validation. Keeping the pin with the Core contract prevents low-level platform
/// adapters from depending on a transport crate only to discover the authoritative version.
pub const PINNED_MIHOMO_VERSION: &str = "v1.19.29";

/// A desktop coordinator request for the platform-owned privileged Core host.
///
/// Paths and the launch token stay private so transport and presentation adapters cannot
/// serialize this capability-bearing value accidentally.
#[derive(Clone, Eq, PartialEq)]
pub struct PrivilegedCoreLaunchRequest {
    binary: PathBuf,
    config_directory: PathBuf,
    config_file: PathBuf,
    expected_version: String,
    launch_token: String,
}

impl PrivilegedCoreLaunchRequest {
    pub fn new(
        binary: PathBuf,
        config_directory: PathBuf,
        config_file: PathBuf,
        expected_version: impl Into<String>,
    ) -> Self {
        Self {
            binary,
            config_directory,
            config_file,
            expected_version: expected_version.into(),
            launch_token: Uuid::new_v4().to_string(),
        }
    }

    pub fn binary(&self) -> &Path {
        &self.binary
    }

    pub fn config_directory(&self) -> &Path {
        &self.config_directory
    }

    pub fn config_file(&self) -> &Path {
        &self.config_file
    }

    pub fn expected_version(&self) -> &str {
        &self.expected_version
    }

    pub fn launch_token(&self) -> &str {
        &self.launch_token
    }
}

impl fmt::Debug for PrivilegedCoreLaunchRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrivilegedCoreLaunchRequest")
            .field("binary", &"[redacted]")
            .field("config_directory", &"[redacted]")
            .field("config_file", &"[redacted]")
            .field("expected_version", &self.expected_version)
            .field("launch_token", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq)]
pub struct PrivilegedCoreProcess {
    launch_token: String,
    pid: u32,
}

impl PrivilegedCoreProcess {
    pub fn new(pid: u32, launch_token: impl Into<String>) -> Self {
        Self {
            launch_token: launch_token.into(),
            pid,
        }
    }

    pub fn launch_token(&self) -> &str {
        &self.launch_token
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }
}

impl fmt::Debug for PrivilegedCoreProcess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrivilegedCoreProcess")
            .field("launch_token", &"[redacted]")
            .field("pid", &self.pid)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrivilegedCoreHostError {
    Unavailable,
    NetworkOwnershipConflict,
    Rejected,
    OperationFailed,
}

impl fmt::Display for PrivilegedCoreHostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "the privileged Core host is unavailable",
            Self::NetworkOwnershipConflict => {
                "the privileged Core host found externally owned TUN network state"
            }
            Self::Rejected => "the privileged Core host rejected the launch request",
            Self::OperationFailed => "the privileged Core host operation failed",
        })
    }
}

impl std::error::Error for PrivilegedCoreHostError {}

/// Platform effect port consumed by the coordinator-owned Core lifecycle adapter.
///
/// `stop` is the cleanup boundary for an exact launch token. `owns_listener` preserves the
/// pre-commit process/listener validation required before the coordinator can publish Running.
pub trait PrivilegedCoreHost: Send + Sync {
    fn start(
        &self,
        request: PrivilegedCoreLaunchRequest,
    ) -> BoxFuture<'_, Result<PrivilegedCoreProcess, PrivilegedCoreHostError>>;

    fn observe(
        &self,
        process: PrivilegedCoreProcess,
    ) -> BoxFuture<'_, Result<Option<PrivilegedCoreProcess>, PrivilegedCoreHostError>>;

    fn stop(
        &self,
        process: PrivilegedCoreProcess,
    ) -> BoxFuture<'_, Result<(), PrivilegedCoreHostError>>;

    fn owns_listener(
        &self,
        process: PrivilegedCoreProcess,
        endpoint: LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<bool, PrivilegedCoreHostError>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_values_redact_paths_and_launch_tokens() {
        let request = PrivilegedCoreLaunchRequest::new(
            PathBuf::from("/private/core"),
            PathBuf::from("/private/home"),
            PathBuf::from("/private/home/config.yaml"),
            "v1.19.29",
        );
        let request_debug = format!("{request:?}");
        assert!(!request_debug.contains("/private"));
        assert!(!request_debug.contains(request.launch_token()));

        let process = PrivilegedCoreProcess::new(42, request.launch_token());
        let process_debug = format!("{process:?}");
        assert!(!process_debug.contains(request.launch_token()));
        assert!(process_debug.contains("42"));
    }
}
