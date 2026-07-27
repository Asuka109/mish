use futures_util::future::BoxFuture;

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
