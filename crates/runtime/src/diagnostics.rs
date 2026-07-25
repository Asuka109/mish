use futures_util::future::BoxFuture;
use serde::Serialize;

pub const DIAGNOSTIC_HISTORY_LIMIT: usize = 8;
pub const DIAGNOSTIC_CHECK_LIMIT: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticRunStatus {
    Running,
    Completed,
    Cancelled,
    Invalidated,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticCheckKind {
    DesktopBridge,
    Core,
    Profile,
    Capture,
    Dns,
    DirectReachability,
    ProxyReachability,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticCheckStatus {
    Passed,
    Failed,
    Unavailable,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiagnosticFailure {
    Cancelled,
    CaptureDrift,
    ControllerDisconnected,
    CoreUnhealthy,
    DnsFailed,
    EndpointUnreachable,
    NoActiveProfile,
    PermissionDenied,
    ProfileInvalid,
    RuntimeReplaced,
    Timeout,
    Unavailable,
    VersionDrift,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DiagnosticRouteTarget {
    LocalBridge,
    ManagedCore,
    ActiveProfile,
    CaptureState,
    FixedEndpoint { route: &'static str },
    PolicyGroupUnavailable,
    PolicyGroup { child_id: String, group_id: String },
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum DiagnosticObservedFact {
    Bridge {
        authenticated: bool,
    },
    Core {
        phase: crate::CorePhase,
        version: Option<String>,
    },
    Profile {
        present: bool,
        valid: bool,
    },
    Capture {
        desired: bool,
        drift: bool,
        observed: crate::SystemProxyObservedState,
    },
    Dns {
        address_count: usize,
    },
    Reachability {
        http_status: u16,
        latency_milliseconds: u64,
    },
    Unavailable {
        reason: &'static str,
    },
    Failure {
        reason: &'static str,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCheck {
    pub failure: Option<DiagnosticFailure>,
    pub finished_at: u64,
    pub id: String,
    pub interpretation: &'static str,
    pub kind: DiagnosticCheckKind,
    pub observed_fact: DiagnosticObservedFact,
    pub route_target: DiagnosticRouteTarget,
    pub scope: &'static str,
    pub started_at: u64,
    pub status: DiagnosticCheckStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticProbePolicy {
    pub endpoint_label: &'static str,
    pub expected_http_status: u16,
    pub id: &'static str,
    pub timeout_milliseconds: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticRun {
    pub adapter_kind: crate::StatusAdapterKind,
    pub checks: Vec<DiagnosticCheck>,
    pub finished_at: Option<u64>,
    pub id: String,
    pub policy: DiagnosticProbePolicy,
    pub profile_id: Option<String>,
    pub started_at: u64,
    pub status: DiagnosticRunStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticHistory {
    pub active_run_id: Option<String>,
    pub adapter_kind: crate::StatusAdapterKind,
    pub runs: Vec<DiagnosticRun>,
}

#[derive(Clone, Debug)]
pub struct ProxyDiagnosticObservation {
    pub child_id: String,
    pub group_id: String,
    pub latency_milliseconds: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProxyDiagnosticFailure {
    Cancelled,
    Disconnected,
    InconsistentObservation,
    NoScopedTarget,
    Timeout,
    Unavailable,
    VersionDrift,
}

pub fn unavailable_proxy_diagnostic()
-> BoxFuture<'static, Result<ProxyDiagnosticObservation, ProxyDiagnosticFailure>> {
    Box::pin(std::future::ready(Err(
        ProxyDiagnosticFailure::NoScopedTarget,
    )))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{DiagnosticObservedFact, DiagnosticRouteTarget};

    #[test]
    fn diagnostic_variant_fields_serialize_for_the_web_contract() {
        assert_eq!(
            serde_json::to_value(DiagnosticObservedFact::Dns { address_count: 1 }).unwrap(),
            json!({"addressCount": 1, "kind": "dns"})
        );
        assert_eq!(
            serde_json::to_value(DiagnosticObservedFact::Reachability {
                http_status: 204,
                latency_milliseconds: 37,
            })
            .unwrap(),
            json!({
                "httpStatus": 204,
                "kind": "reachability",
                "latencyMilliseconds": 37,
            })
        );
        assert_eq!(
            serde_json::to_value(DiagnosticRouteTarget::PolicyGroup {
                child_id: "child".into(),
                group_id: "group".into(),
            })
            .unwrap(),
            json!({
                "childId": "child",
                "groupId": "group",
                "kind": "policy-group",
            })
        );
    }
}
