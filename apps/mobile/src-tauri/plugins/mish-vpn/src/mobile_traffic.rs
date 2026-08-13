#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::collections::{HashSet, VecDeque};

use mish_runtime::{
    ApplicationSnapshotOrder, EffectiveRule, StatusAdapterKind, TrafficCommandFailureKind,
    TrafficCommandOperation, TrafficCommandStatus, TrafficConnection, TrafficDataPhase,
    TrafficDataSnapshot, TrafficMatchedRule,
};
use serde::{Deserialize, Serialize};

const MAX_CONNECTIONS: usize = 512;
const MAX_CHAIN_ITEMS: usize = 64;
const MAX_TEXT_BYTES: usize = 1_024;
const TERMINAL_LEDGER_LIMIT: usize = 32;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeTrafficSnapshot {
    pub connections: Vec<NativeTrafficConnection>,
    pub event_sequence: String,
    pub running: bool,
    pub session_id: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeTrafficCloseResult {
    pub failure: Option<NativeTrafficFailure>,
    pub snapshot: NativeTrafficSnapshot,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum NativeTrafficFailure {
    InvalidRequest,
    StaleConnection,
    CoreFailure,
}

impl NativeTrafficFailure {
    pub(crate) fn command_failure(self) -> TrafficCommandFailureKind {
        match self {
            Self::InvalidRequest => TrafficCommandFailureKind::InvalidRequest,
            Self::StaleConnection => TrafficCommandFailureKind::StaleConnection,
            Self::CoreFailure => TrafficCommandFailureKind::ControllerRejected,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeTrafficConnection {
    pub destination_host: Option<String>,
    pub destination_ip: Option<String>,
    pub destination_port: u16,
    pub download_bytes: String,
    pub id: String,
    pub matched_rule_payload: String,
    pub matched_rule_type: String,
    pub network: String,
    pub process_name: Option<String>,
    pub protocol: String,
    pub provider_chain: Vec<String>,
    pub remote_destination: Option<String>,
    pub route_chain: Vec<String>,
    pub sniff_host: Option<String>,
    pub source_port: u16,
    pub started_at: String,
    pub upload_bytes: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileTrafficCloseRequest {
    pub connection_id: String,
    pub operation_id: String,
    pub profile_id: String,
    pub runtime_authority_id: String,
    pub sequence: u64,
    pub session_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileTrafficCommandResult {
    pub failure: Option<TrafficCommandFailureKind>,
    pub operation: TrafficCommandOperation,
    pub operation_id: String,
    pub remaining_connection_ids: Vec<String>,
    pub snapshot: TrafficDataSnapshot,
    pub status: TrafficCommandStatus,
    pub target_count: usize,
}

impl MobileTrafficCommandResult {
    fn failure(
        operation_id: String,
        failure: TrafficCommandFailureKind,
        snapshot: TrafficDataSnapshot,
        connection_id: Option<String>,
    ) -> Self {
        Self {
            failure: Some(failure),
            operation: TrafficCommandOperation::CloseConnection,
            operation_id,
            remaining_connection_ids: connection_id.into_iter().collect(),
            snapshot,
            status: TrafficCommandStatus::Failure,
            target_count: 1,
        }
    }

    pub(crate) fn success(operation_id: String, snapshot: TrafficDataSnapshot) -> Self {
        Self {
            failure: None,
            operation: TrafficCommandOperation::CloseConnection,
            operation_id,
            remaining_connection_ids: Vec::new(),
            snapshot,
            status: TrafficCommandStatus::Success,
            target_count: 1,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TerminalRecord {
    request: MobileTrafficCloseRequest,
    result: MobileTrafficCommandResult,
}

pub(crate) struct MobileTrafficAuthority {
    application_order: u64,
    current: TrafficDataSnapshot,
    reconnect_count: u64,
    terminal: VecDeque<TerminalRecord>,
}

impl Default for MobileTrafficAuthority {
    fn default() -> Self {
        Self {
            application_order: 0,
            current: TrafficDataSnapshot::unavailable(StatusAdapterKind::Native),
            reconnect_count: 0,
            terminal: VecDeque::with_capacity(TERMINAL_LEDGER_LIMIT),
        }
    }
}

impl MobileTrafficAuthority {
    pub(crate) fn unavailable(
        &mut self,
        runtime_authority_id: &str,
        runtime_epoch: u64,
        profile_id: &str,
    ) -> TrafficDataSnapshot {
        if self.current.session_id.is_some() {
            self.reconnect_count = self.reconnect_count.saturating_add(1);
        }
        self.application_order = self.application_order.saturating_add(1);
        self.current = TrafficDataSnapshot {
            active_connections: Vec::new(),
            adapter_kind: StatusAdapterKind::Native,
            application_order: ApplicationSnapshotOrder {
                authority_id: runtime_authority_id.into(),
                epoch: runtime_epoch,
                order: self.application_order,
            },
            phase: TrafficDataPhase::Unavailable,
            profile_id: profile_id.into(),
            reconnect_count: self.reconnect_count,
            rules: Vec::<EffectiveRule>::new(),
            sequence: 0,
            session_id: None,
        };
        self.current.clone()
    }

    pub(crate) fn project(
        &mut self,
        runtime_authority_id: &str,
        runtime_epoch: u64,
        profile_id: &str,
        native: NativeTrafficSnapshot,
    ) -> Result<TrafficDataSnapshot, TrafficCommandFailureKind> {
        validate_native_snapshot(&native)?;
        if !native.running {
            return Err(TrafficCommandFailureKind::InconsistentObservation);
        }
        let replacing = self.current.application_order.authority_id != runtime_authority_id
            || self.current.application_order.epoch != runtime_epoch
            || self.current.profile_id != profile_id
            || self.current.session_id.as_deref() != Some(native.session_id.as_str());
        if replacing && self.current.session_id.is_some() {
            self.reconnect_count = self.reconnect_count.saturating_add(1);
        }
        self.application_order = self.application_order.saturating_add(1);
        let sequence = if replacing {
            1
        } else {
            self.current.sequence.saturating_add(1)
        };
        let mut connections = native
            .connections
            .into_iter()
            .map(project_connection)
            .collect::<Vec<_>>();
        connections.sort_by(|left, right| {
            left.started_at
                .cmp(&right.started_at)
                .then_with(|| left.id.cmp(&right.id))
        });
        self.current = TrafficDataSnapshot {
            active_connections: connections,
            adapter_kind: StatusAdapterKind::Native,
            application_order: ApplicationSnapshotOrder {
                authority_id: runtime_authority_id.into(),
                epoch: runtime_epoch,
                order: self.application_order,
            },
            phase: TrafficDataPhase::Ready,
            profile_id: profile_id.into(),
            reconnect_count: self.reconnect_count,
            rules: Vec::new(),
            sequence,
            session_id: Some(native.session_id),
        };
        Ok(self.current.clone())
    }

    pub(crate) fn current(&self) -> TrafficDataSnapshot {
        self.current.clone()
    }

    pub(crate) fn duplicate(
        &self,
        request: &MobileTrafficCloseRequest,
    ) -> Option<MobileTrafficCommandResult> {
        self.terminal
            .iter()
            .find(|record| record.request.operation_id == request.operation_id)
            .map(|record| {
                if record.request == *request {
                    record.result.clone()
                } else {
                    MobileTrafficCommandResult::failure(
                        request.operation_id.clone(),
                        TrafficCommandFailureKind::Conflict,
                        self.current(),
                        Some(request.connection_id.clone()),
                    )
                }
            })
    }

    pub(crate) fn validate_request(
        &self,
        request: &MobileTrafficCloseRequest,
    ) -> Result<(), TrafficCommandFailureKind> {
        if !valid_identifier(&request.operation_id)
            || !valid_identifier(&request.connection_id)
            || !valid_identifier(&request.profile_id)
            || !valid_identifier(&request.runtime_authority_id)
        {
            return Err(TrafficCommandFailureKind::InvalidRequest);
        }
        if self.current.phase != TrafficDataPhase::Ready
            || self.current.application_order.authority_id != request.runtime_authority_id
            || self.current.profile_id != request.profile_id
            || self.current.session_id.as_deref() != Some(request.session_id.as_str())
            || self.current.sequence != request.sequence
        {
            return Err(TrafficCommandFailureKind::StaleSnapshot);
        }
        Ok(())
    }

    pub(crate) fn has_connection(&self, connection_id: &str) -> bool {
        self.current
            .active_connections
            .iter()
            .any(|connection| connection.id == connection_id)
    }

    pub(crate) fn same_scope(&self, request: &MobileTrafficCloseRequest) -> bool {
        self.current.phase == TrafficDataPhase::Ready
            && self.current.application_order.authority_id == request.runtime_authority_id
            && self.current.profile_id == request.profile_id
            && self.current.session_id.as_deref() == Some(request.session_id.as_str())
    }

    pub(crate) fn remember(
        &mut self,
        request: MobileTrafficCloseRequest,
        result: MobileTrafficCommandResult,
    ) -> MobileTrafficCommandResult {
        self.terminal.push_back(TerminalRecord {
            request,
            result: result.clone(),
        });
        while self.terminal.len() > TERMINAL_LEDGER_LIMIT {
            self.terminal.pop_front();
        }
        result
    }

    pub(crate) fn failure(
        &mut self,
        request: MobileTrafficCloseRequest,
        failure: TrafficCommandFailureKind,
        connection_remains: bool,
    ) -> MobileTrafficCommandResult {
        let remaining = connection_remains.then(|| request.connection_id.clone());
        let result = MobileTrafficCommandResult::failure(
            request.operation_id.clone(),
            failure,
            self.current(),
            remaining,
        );
        self.remember(request, result)
    }
}

pub(crate) fn runtime_allows_close_dispatch(
    current_authority_id: &str,
    current_epoch: u64,
    current_running: bool,
    expected_authority_id: &str,
    expected_epoch: u64,
) -> bool {
    current_running
        && current_authority_id == expected_authority_id
        && current_epoch == expected_epoch
}

fn validate_native_snapshot(
    snapshot: &NativeTrafficSnapshot,
) -> Result<(), TrafficCommandFailureKind> {
    if snapshot.truncated
        || snapshot.connections.len() > MAX_CONNECTIONS
        || !valid_identifier(&snapshot.session_id)
        || snapshot.event_sequence.parse::<u64>().is_err()
    {
        return Err(TrafficCommandFailureKind::InconsistentObservation);
    }
    let mut ids = HashSet::with_capacity(snapshot.connections.len());
    for connection in &snapshot.connections {
        if !valid_identifier(&connection.id)
            || !ids.insert(connection.id.as_str())
            || connection.route_chain.len() > MAX_CHAIN_ITEMS
            || connection.provider_chain.len() > MAX_CHAIN_ITEMS
            || !valid_decimal(&connection.download_bytes)
            || !valid_decimal(&connection.upload_bytes)
            || !valid_texts(connection)
        {
            return Err(TrafficCommandFailureKind::InconsistentObservation);
        }
    }
    Ok(())
}

fn valid_texts(connection: &NativeTrafficConnection) -> bool {
    let required = [
        &connection.matched_rule_payload,
        &connection.matched_rule_type,
        &connection.network,
        &connection.protocol,
        &connection.started_at,
    ];
    required.iter().all(|value| value.len() <= MAX_TEXT_BYTES)
        && connection
            .route_chain
            .iter()
            .chain(connection.provider_chain.iter())
            .all(|value| value.len() <= MAX_TEXT_BYTES)
        && [
            connection.destination_host.as_ref(),
            connection.destination_ip.as_ref(),
            connection.process_name.as_ref(),
            connection.remote_destination.as_ref(),
            connection.sniff_host.as_ref(),
        ]
        .into_iter()
        .flatten()
        .all(|value| value.len() <= MAX_TEXT_BYTES)
}

fn valid_decimal(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn project_connection(connection: NativeTrafficConnection) -> TrafficConnection {
    TrafficConnection {
        destination_host: connection.destination_host,
        destination_ip: connection.destination_ip,
        destination_port: connection.destination_port,
        download_bytes: connection.download_bytes,
        id: connection.id,
        matched_rule: TrafficMatchedRule {
            payload: connection.matched_rule_payload,
            kind: connection.matched_rule_type,
        },
        network: connection.network,
        process_name: connection.process_name,
        process_path: None,
        protocol: connection.protocol,
        provider_chain: connection.provider_chain,
        remote_destination: connection.remote_destination,
        route_chain: connection.route_chain,
        sniff_host: connection.sniff_host,
        source_ip: None,
        source_port: connection.source_port,
        started_at: connection.started_at,
        upload_bytes: connection.upload_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Eq, PartialEq)]
    enum TrafficTranscriptEvent {
        Baseline,
        FreshPreflight,
        RuntimeRevalidated,
        RuntimeReplacedBeforeDispatch,
        CloseNotDispatched,
        RuntimeStoppedAfterClose,
        UnavailableReconciled,
        CloseSucceeded,
        DuplicateReplayed,
        ReplacementRejected,
    }

    fn native(session: &str, ids: &[&str]) -> NativeTrafficSnapshot {
        NativeTrafficSnapshot {
            connections: ids
                .iter()
                .map(|id| NativeTrafficConnection {
                    destination_host: Some("service.fixture.invalid".into()),
                    destination_ip: Some("192.0.2.1".into()),
                    destination_port: 443,
                    download_bytes: "2".into(),
                    id: (*id).into(),
                    matched_rule_payload: "fixture.invalid".into(),
                    matched_rule_type: "DomainSuffix".into(),
                    network: "tcp".into(),
                    process_name: Some("Fixture app".into()),
                    protocol: "Tun".into(),
                    provider_chain: vec!["Fixture provider".into()],
                    remote_destination: None,
                    route_chain: vec!["Fixture group".into(), "Fixture exit".into()],
                    sniff_host: None,
                    source_port: 40000,
                    started_at: format!("2026-08-13T00:00:0{}Z", id.len()),
                    upload_bytes: "1".into(),
                })
                .collect(),
            event_sequence: "7".into(),
            running: true,
            session_id: session.into(),
            truncated: false,
        }
    }

    fn request(
        snapshot: &TrafficDataSnapshot,
        operation_id: &str,
        connection_id: &str,
    ) -> MobileTrafficCloseRequest {
        MobileTrafficCloseRequest {
            connection_id: connection_id.into(),
            operation_id: operation_id.into(),
            profile_id: snapshot.profile_id.clone(),
            runtime_authority_id: snapshot.application_order.authority_id.clone(),
            sequence: snapshot.sequence,
            session_id: snapshot.session_id.clone().unwrap(),
        }
    }

    #[test]
    fn orders_rows_and_resets_sequence_on_runtime_replacement() {
        let mut authority = MobileTrafficAuthority::default();
        let first = authority
            .project(
                "runtime-a",
                1,
                "profile-a",
                native("traffic-a", &["b", "a"]),
            )
            .unwrap();
        assert_eq!(
            first
                .active_connections
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        let next = authority
            .project("runtime-a", 1, "profile-a", native("traffic-a", &["a"]))
            .unwrap();
        assert_eq!(next.sequence, 2);
        let replaced = authority
            .project("runtime-b", 2, "profile-b", native("traffic-b", &["a"]))
            .unwrap();
        assert_eq!(replaced.sequence, 1);
        assert_eq!(replaced.reconnect_count, 1);
    }

    #[test]
    fn unavailable_boundary_counts_one_reconnect_before_the_next_baseline() {
        let mut authority = MobileTrafficAuthority::default();
        authority
            .project("runtime-a", 1, "profile-a", native("traffic-a", &["a"]))
            .unwrap();
        let unavailable = authority.unavailable("runtime-a", 1, "profile-a");
        assert_eq!(unavailable.reconnect_count, 1);
        assert_eq!(
            authority
                .unavailable("runtime-a", 1, "profile-a")
                .reconnect_count,
            1
        );
        let reconnected = authority
            .project("runtime-a", 1, "profile-a", native("traffic-b", &["b"]))
            .unwrap();
        assert_eq!(reconnected.reconnect_count, 1);
        assert_eq!(reconnected.sequence, 1);
    }

    #[test]
    fn duplicate_operation_is_idempotent_and_conflicting_reuse_fails() {
        let mut authority = MobileTrafficAuthority::default();
        let snapshot = authority
            .project("runtime-a", 1, "profile-a", native("traffic-a", &["a"]))
            .unwrap();
        let request = request(&snapshot, "operation-a", "a");
        let result = MobileTrafficCommandResult::success(request.operation_id.clone(), snapshot);
        authority.remember(request.clone(), result.clone());
        assert_eq!(authority.duplicate(&request), Some(result));
        let mut conflict = request;
        conflict.connection_id = "b".into();
        assert_eq!(
            authority.duplicate(&conflict).unwrap().failure,
            Some(TrafficCommandFailureKind::Conflict)
        );
    }

    #[test]
    fn closed_transcript_orders_exact_close_duplicate_and_replacement() {
        let mut authority = MobileTrafficAuthority::default();
        let baseline = authority
            .project("runtime-a", 1, "profile-a", native("traffic-a", &["a"]))
            .unwrap();
        let close = request(&baseline, "operation-a", "a");
        let mut transcript = vec![TrafficTranscriptEvent::Baseline];
        let fresh = authority
            .project("runtime-a", 1, "profile-a", native("traffic-a", &["a"]))
            .unwrap();
        transcript.push(TrafficTranscriptEvent::FreshPreflight);
        assert!(authority.same_scope(&close));
        assert!(authority.has_connection("a"));
        let closed = authority
            .project("runtime-a", 1, "profile-a", native("traffic-a", &[]))
            .unwrap();
        let success = MobileTrafficCommandResult::success("operation-a".into(), closed);
        authority.remember(close.clone(), success.clone());
        transcript.push(TrafficTranscriptEvent::CloseSucceeded);
        assert_eq!(authority.duplicate(&close), Some(success));
        transcript.push(TrafficTranscriptEvent::DuplicateReplayed);
        authority
            .project("runtime-b", 2, "profile-b", native("traffic-b", &["a"]))
            .unwrap();
        assert!(!authority.same_scope(&close));
        transcript.push(TrafficTranscriptEvent::ReplacementRejected);
        assert_eq!(fresh.sequence, baseline.sequence + 1);
        assert_eq!(
            transcript,
            vec![
                TrafficTranscriptEvent::Baseline,
                TrafficTranscriptEvent::FreshPreflight,
                TrafficTranscriptEvent::CloseSucceeded,
                TrafficTranscriptEvent::DuplicateReplayed,
                TrafficTranscriptEvent::ReplacementRejected,
            ]
        );
    }

    #[test]
    fn replacement_after_preflight_is_rejected_before_the_close_effect() {
        let mut transcript = vec![
            TrafficTranscriptEvent::Baseline,
            TrafficTranscriptEvent::FreshPreflight,
        ];
        assert!(runtime_allows_close_dispatch(
            "runtime-a",
            1,
            true,
            "runtime-a",
            1,
        ));
        transcript.push(TrafficTranscriptEvent::RuntimeRevalidated);

        assert!(!runtime_allows_close_dispatch(
            "runtime-b",
            2,
            true,
            "runtime-a",
            1,
        ));
        transcript.push(TrafficTranscriptEvent::RuntimeReplacedBeforeDispatch);
        transcript.push(TrafficTranscriptEvent::CloseNotDispatched);

        assert_eq!(
            transcript,
            vec![
                TrafficTranscriptEvent::Baseline,
                TrafficTranscriptEvent::FreshPreflight,
                TrafficTranscriptEvent::RuntimeRevalidated,
                TrafficTranscriptEvent::RuntimeReplacedBeforeDispatch,
                TrafficTranscriptEvent::CloseNotDispatched,
            ]
        );
    }

    #[test]
    fn same_authority_stop_after_close_reconciles_unavailable() {
        let mut transcript = vec![TrafficTranscriptEvent::CloseSucceeded];
        assert!(!runtime_allows_close_dispatch(
            "runtime-a",
            1,
            false,
            "runtime-a",
            1,
        ));
        transcript.push(TrafficTranscriptEvent::RuntimeStoppedAfterClose);
        transcript.push(TrafficTranscriptEvent::UnavailableReconciled);
        assert_eq!(
            transcript,
            vec![
                TrafficTranscriptEvent::CloseSucceeded,
                TrafficTranscriptEvent::RuntimeStoppedAfterClose,
                TrafficTranscriptEvent::UnavailableReconciled,
            ]
        );
    }

    #[test]
    fn bounds_redaction_and_stale_authority_fail_closed() {
        let mut authority = MobileTrafficAuthority::default();
        let snapshot = authority
            .project("runtime-a", 1, "profile-a", native("traffic-a", &["a"]))
            .unwrap();
        assert!(snapshot.active_connections[0].process_path.is_none());
        assert!(snapshot.active_connections[0].source_ip.is_none());
        let mut stale = request(&snapshot, "operation-a", "a");
        stale.sequence += 1;
        assert_eq!(
            authority.validate_request(&stale),
            Err(TrafficCommandFailureKind::StaleSnapshot)
        );
        assert!(authority.same_scope(&request(&snapshot, "operation-b", "a")));
        let replacement = authority
            .project("runtime-a", 1, "profile-a", native("traffic-b", &["a"]))
            .unwrap();
        assert!(!authority.same_scope(&request(&snapshot, "operation-c", "a")));
        assert_eq!(replacement.sequence, 1);
        let mut overflow = native("traffic-a", &["a"]);
        overflow.truncated = true;
        assert_eq!(
            authority.project("runtime-a", 1, "profile-a", overflow),
            Err(TrafficCommandFailureKind::InconsistentObservation)
        );
        let mut duplicate = native("traffic-c", &["a", "a"]);
        assert_eq!(
            authority.project("runtime-a", 1, "profile-a", duplicate.clone()),
            Err(TrafficCommandFailureKind::InconsistentObservation)
        );
        duplicate.connections[1].id = "b".into();
        duplicate.connections[1].download_bytes = "-1".into();
        assert_eq!(
            authority.project("runtime-a", 1, "profile-a", duplicate),
            Err(TrafficCommandFailureKind::InconsistentObservation)
        );
    }
}
