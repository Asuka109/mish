#![cfg_attr(not(target_os = "android"), allow(dead_code))]

use std::collections::{HashMap, HashSet, VecDeque};

use mish_profile::{
    ProfileRouteCatalog, ProfileRouteGroupKind, profile_route_catalog_from_effective_bytes,
};
use mish_runtime::{
    ApplicationSnapshotOrder, CorePhase, CoreStatus, GroupSelectionAvailability,
    GroupSelectionCleanupMode, GroupSelectionCleanupPhase, GroupSelectionOperation, PolicyGroup,
    PolicyGroupKind, ProfileSummary, ProxyNode, RoutingMode, StatusAdapterKind, StatusSnapshot,
};
use serde::{Deserialize, Serialize};

const CONTRACT_VERSION: u8 = 1;
const MAX_IDENTITIES: usize = 128;
const MAX_NATIVE_GROUPS: usize = 512;
const MAX_NATIVE_CHILDREN: usize = 512;
const MAX_RECENT_OPERATIONS: usize = 32;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileRouteCommandRequest {
    pub child_id: String,
    pub current_child_id: String,
    pub group_id: String,
    pub operation_id: String,
    pub profile_id: String,
    pub profile_revision: String,
    pub runtime_authority: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileRouteCancelRequest {
    pub operation_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileRouteCancelResult {
    pub accepted: bool,
    pub contract_version: u8,
    pub operation_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileRouteFailure {
    Cancelled,
    DuplicateConflict,
    InvalidInput,
    InvalidRelation,
    MalformedNativeResponse,
    NativeRejected,
    NativeResponseTooLarge,
    RuntimeReplaced,
    StaleAuthority,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileRouteCommandResult {
    pub contract_version: u8,
    pub failure: Option<MobileRouteFailure>,
    pub operation_id: String,
    pub snapshot: MobileRouteSnapshot,
    pub status: MobileRouteCommandStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MobileRouteCommandStatus {
    Success,
    Failure,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileRouteSnapshot {
    pub contract_version: u8,
    pub profile_id: String,
    pub profile_revision: String,
    pub runtime_authority: String,
    pub status: StatusSnapshot,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeRouteResult {
    pub contract_version: u8,
    pub failure: Option<NativeRouteFailure>,
    pub operation_id: Option<String>,
    pub routes: NativeRoutes,
    pub status: NativeStatus,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum NativeRouteFailure {
    Conflict,
    InvalidRequest,
    MalformedResponse,
    NativeFailure,
    ResponseTooLarge,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeStatus {
    pub config_sha256: Option<String>,
    pub event_sequence: String,
    pub loaded: bool,
    pub mode: RoutingMode,
    pub phase: NativeCorePhase,
    pub session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum NativeCorePhase {
    Inactive,
    Running,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeRoutes {
    pub groups: Vec<NativeRouteGroup>,
    pub mode: RoutingMode,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativeRouteGroup {
    pub candidates: Vec<String>,
    pub name: String,
    pub selected: String,
}

#[derive(Clone)]
pub(crate) struct MobileRouteAuthority {
    catalog: ProfileRouteCatalog,
    completed: HashMap<String, CompletedRouteCommand>,
    completed_order: VecDeque<String>,
    config_digest: String,
    order: u64,
    profile_revision: String,
    runtime_authority: String,
    runtime_epoch: u64,
    cancelled: HashSet<String>,
    cancelled_order: VecDeque<String>,
}

#[derive(Clone)]
struct CompletedRouteCommand {
    request: MobileRouteCommandRequest,
    result: MobileRouteCommandResult,
}

impl MobileRouteAuthority {
    pub(crate) fn from_committed_profile(
        profile_id: &str,
        profile_revision: &str,
        config_digest: &str,
        config_bytes: &[u8],
        runtime_authority: String,
        runtime_epoch: u64,
    ) -> Option<Self> {
        if !identifier(profile_id)
            || !identifier(profile_revision)
            || !digest(config_digest)
            || !identifier(&runtime_authority)
        {
            return None;
        }
        let catalog =
            profile_route_catalog_from_effective_bytes(profile_id, config_digest, config_bytes)
                .ok()?;
        Some(Self {
            catalog,
            completed: HashMap::new(),
            completed_order: VecDeque::new(),
            config_digest: config_digest.into(),
            order: 0,
            profile_revision: profile_revision.into(),
            runtime_authority,
            runtime_epoch,
            cancelled: HashSet::new(),
            cancelled_order: VecDeque::new(),
        })
    }

    pub(crate) fn cancel(&mut self, operation_id: &str) -> bool {
        if !identifier(operation_id) || self.completed.contains_key(operation_id) {
            return false;
        }
        if !self.cancelled.insert(operation_id.into()) {
            return true;
        }
        self.cancelled_order.push_back(operation_id.into());
        while self.cancelled_order.len() > MAX_RECENT_OPERATIONS {
            if let Some(retired) = self.cancelled_order.pop_front() {
                self.cancelled.remove(&retired);
            }
        }
        true
    }

    pub(crate) fn runtime_authority(&self) -> &str {
        &self.runtime_authority
    }

    pub(crate) fn rebind_inactive_runtime(
        &mut self,
        runtime_authority: String,
        runtime_epoch: u64,
    ) {
        self.runtime_authority = runtime_authority;
        self.runtime_epoch = runtime_epoch;
        self.completed.clear();
        self.completed_order.clear();
        self.cancelled.clear();
        self.cancelled_order.clear();
        self.order = 0;
    }

    pub(crate) fn duplicate(
        &self,
        request: &MobileRouteCommandRequest,
    ) -> Result<Option<MobileRouteCommandResult>, MobileRouteFailure> {
        let Some(completed) = self.completed.get(&request.operation_id) else {
            return Ok(None);
        };
        if completed.request == *request {
            Ok(Some(completed.result.clone()))
        } else {
            Err(MobileRouteFailure::DuplicateConflict)
        }
    }

    pub(crate) fn preflight(
        &self,
        request: &MobileRouteCommandRequest,
    ) -> Result<(String, String, String), MobileRouteFailure> {
        if ![
            request.child_id.as_str(),
            request.current_child_id.as_str(),
            request.group_id.as_str(),
            request.operation_id.as_str(),
            request.profile_id.as_str(),
            request.profile_revision.as_str(),
            request.runtime_authority.as_str(),
        ]
        .into_iter()
        .all(identifier)
        {
            return Err(MobileRouteFailure::InvalidInput);
        }
        if self.cancelled.contains(&request.operation_id) {
            return Err(MobileRouteFailure::Cancelled);
        }
        if request.runtime_authority != self.runtime_authority
            || request.profile_id != self.catalog.profile_id
            || request.profile_revision != self.profile_revision
        {
            return Err(MobileRouteFailure::StaleAuthority);
        }
        let group = self
            .catalog
            .groups
            .iter()
            .find(|group| group.id == request.group_id)
            .filter(|group| group.kind == ProfileRouteGroupKind::Selector)
            .ok_or(MobileRouteFailure::InvalidRelation)?;
        if group.selected_child_id.as_deref() != Some(request.current_child_id.as_str())
            || !group.child_ids.contains(&request.child_id)
        {
            return Err(MobileRouteFailure::InvalidRelation);
        }
        let group_label = group.label.clone();
        let current_child_label = self
            .label_for_id(&request.current_child_id)
            .ok_or(MobileRouteFailure::InvalidRelation)?;
        let child_label = self
            .catalog
            .groups
            .iter()
            .find(|candidate| candidate.id == request.child_id)
            .map(|candidate| candidate.label.clone())
            .or_else(|| {
                self.catalog
                    .nodes
                    .iter()
                    .find(|candidate| candidate.id == request.child_id)
                    .map(|candidate| candidate.label.clone())
            })
            .ok_or(MobileRouteFailure::InvalidRelation)?;
        Ok((group_label, current_child_label, child_label))
    }

    pub(crate) fn project(
        &mut self,
        native: NativeRouteResult,
        operation_id: Option<&str>,
    ) -> Result<MobileRouteSnapshot, MobileRouteFailure> {
        if native.contract_version != CONTRACT_VERSION
            || native.operation_id.as_deref() != operation_id
        {
            return Err(MobileRouteFailure::MalformedNativeResponse);
        }
        if let Some(failure) = native.failure {
            return Err(match failure {
                NativeRouteFailure::ResponseTooLarge => MobileRouteFailure::NativeResponseTooLarge,
                NativeRouteFailure::MalformedResponse => {
                    MobileRouteFailure::MalformedNativeResponse
                }
                NativeRouteFailure::Conflict
                | NativeRouteFailure::InvalidRequest
                | NativeRouteFailure::NativeFailure => MobileRouteFailure::NativeRejected,
            });
        }
        if native.routes.truncated
            || native.routes.groups.len() > MAX_NATIVE_GROUPS
            || native.routes.mode != native.status.mode
            || native.status.config_sha256.as_deref() != Some(self.config_digest.as_str())
            || !native.status.loaded
            || native.status.event_sequence.parse::<u64>().is_err()
            || native
                .status
                .session_id
                .as_deref()
                .is_some_and(|value| !identifier(value))
            || (native.status.phase == NativeCorePhase::Running
                && native.status.session_id.is_none())
            || native.routes.groups.iter().any(|group| {
                group.name.is_empty()
                    || group.name.len() > 256
                    || group.selected.is_empty()
                    || group.selected.len() > 256
                    || group.candidates.len() > MAX_NATIVE_CHILDREN
                    || group
                        .candidates
                        .iter()
                        .any(|child| child.is_empty() || child.len() > 256)
            })
        {
            return Err(MobileRouteFailure::MalformedNativeResponse);
        }
        let native_by_label: HashMap<_, _> = native
            .routes
            .groups
            .iter()
            .map(|group| (group.name.as_str(), group))
            .collect();
        if native_by_label.len() != native.routes.groups.len() {
            return Err(MobileRouteFailure::MalformedNativeResponse);
        }
        let mut groups = Vec::with_capacity(self.catalog.groups.len());
        let mut selections = HashMap::new();
        for configured in &self.catalog.groups {
            let observed = native_by_label
                .get(configured.label.as_str())
                .ok_or(MobileRouteFailure::MalformedNativeResponse)?;
            let configured_labels: Vec<_> = configured
                .child_ids
                .iter()
                .map(|child_id| self.label_for_id(child_id))
                .collect::<Option<_>>()
                .ok_or(MobileRouteFailure::MalformedNativeResponse)?;
            if observed.candidates != configured_labels
                || !observed.candidates.contains(&observed.selected)
            {
                return Err(MobileRouteFailure::MalformedNativeResponse);
            }
            let selected = configured
                .child_ids
                .iter()
                .zip(&configured_labels)
                .find_map(|(id, label)| (label == &observed.selected).then(|| id.clone()))
                .ok_or(MobileRouteFailure::MalformedNativeResponse)?;
            selections.insert(configured.id.clone(), selected.clone());
            groups.push(PolicyGroup {
                child_ids: configured.child_ids.clone(),
                id: configured.id.clone(),
                label: configured.label.clone(),
                selected_child_id: Some(selected),
                kind: map_group_kind(configured.kind),
                unsupported_type: configured.unsupported_type.clone(),
            });
        }
        for configured in &mut self.catalog.groups {
            configured.selected_child_id = selections.remove(&configured.id);
        }
        self.order = self.order.saturating_add(1);
        let core = CoreStatus {
            error: None,
            phase: match native.status.phase {
                NativeCorePhase::Inactive => CorePhase::Stopped,
                NativeCorePhase::Running => CorePhase::Running,
            },
            pid: None,
            version: None,
        };
        let mut status = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Native);
        status.active_profile_id = self.catalog.profile_id.clone();
        status.application_order = ApplicationSnapshotOrder {
            authority_id: self.runtime_authority.clone(),
            epoch: self.runtime_epoch,
            order: self.order,
        };
        status.group_selection_availability = if native.status.phase == NativeCorePhase::Running {
            GroupSelectionAvailability::Available
        } else {
            GroupSelectionAvailability::CoreNotRunning
        };
        status.groups = groups;
        status.nodes = self
            .catalog
            .nodes
            .iter()
            .map(|node| ProxyNode {
                id: node.id.clone(),
                label: node.label.clone(),
                latency_milliseconds: node.latency_milliseconds,
                protocol: node.protocol.clone(),
            })
            .collect();
        status.profiles = vec![ProfileSummary {
            id: self.catalog.profile_id.clone(),
            label: "Active Profile".into(),
        }];
        status.routing_mode = native.routes.mode;
        if let Some(operation_id) = operation_id {
            status.group_selection_operation = GroupSelectionOperation {
                catalog_revision: self.config_digest.clone(),
                cleanup_failure: None,
                cleanup_mode: GroupSelectionCleanupMode::Off,
                cleanup_phase: GroupSelectionCleanupPhase::Skipped,
                closed_count: 0,
                controller_session_revision: native.status.event_sequence.parse().unwrap_or(0),
                failed_count: 0,
                membership_revision: self.config_digest.clone(),
                operation_id: Some(operation_id.into()),
                scan_count: 0,
                selection_confirmed: true,
                target_count: 0,
            };
        }
        Ok(MobileRouteSnapshot {
            contract_version: CONTRACT_VERSION,
            profile_id: self.catalog.profile_id.clone(),
            profile_revision: self.profile_revision.clone(),
            runtime_authority: self.runtime_authority.clone(),
            status,
        })
    }

    pub(crate) fn remember(
        &mut self,
        request: MobileRouteCommandRequest,
        result: MobileRouteCommandResult,
    ) {
        let id = result.operation_id.clone();
        self.cancelled.remove(&id);
        self.cancelled_order.retain(|cancelled| cancelled != &id);
        if self
            .completed
            .insert(id.clone(), CompletedRouteCommand { request, result })
            .is_none()
        {
            self.completed_order.push_back(id);
        }
        while self.completed_order.len() > MAX_RECENT_OPERATIONS {
            if let Some(retired) = self.completed_order.pop_front() {
                self.completed.remove(&retired);
            }
        }
    }

    pub(crate) fn failure_result(
        &mut self,
        operation_id: String,
        failure: MobileRouteFailure,
        baseline: MobileRouteSnapshot,
    ) -> MobileRouteCommandResult {
        MobileRouteCommandResult {
            contract_version: CONTRACT_VERSION,
            failure: Some(failure),
            operation_id,
            snapshot: baseline,
            status: if failure == MobileRouteFailure::Cancelled {
                MobileRouteCommandStatus::Cancelled
            } else {
                MobileRouteCommandStatus::Failure
            },
        }
    }

    fn label_for_id(&self, id: &str) -> Option<String> {
        self.catalog
            .groups
            .iter()
            .find(|entity| entity.id == id)
            .map(|entity| entity.label.clone())
            .or_else(|| {
                self.catalog
                    .nodes
                    .iter()
                    .find(|entity| entity.id == id)
                    .map(|entity| entity.label.clone())
            })
    }
}

fn map_group_kind(kind: ProfileRouteGroupKind) -> PolicyGroupKind {
    match kind {
        ProfileRouteGroupKind::Selector => PolicyGroupKind::Selector,
        ProfileRouteGroupKind::UrlTest => PolicyGroupKind::UrlTest,
        ProfileRouteGroupKind::Fallback => PolicyGroupKind::Fallback,
        ProfileRouteGroupKind::LoadBalance => PolicyGroupKind::LoadBalance,
        ProfileRouteGroupKind::Relay => PolicyGroupKind::Relay,
        ProfileRouteGroupKind::Direct => PolicyGroupKind::Direct,
        ProfileRouteGroupKind::Reject => PolicyGroupKind::Reject,
        ProfileRouteGroupKind::Unsupported => PolicyGroupKind::Unsupported,
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTITIES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Feature-gated semantic transcripts for the repository SimulatedHost.
/// Events contain only bounded synthetic identities, logical order, and
/// mutation counts; config bytes, native labels, endpoints, and credentials
/// are deliberately outside this schema.
#[cfg(feature = "simulated-host")]
pub mod simulated_host {
    use serde::{Deserialize, Serialize};

    const SCHEMA_VERSION: u8 = 1;
    pub const TRANSCRIPT_LIMIT: usize = 16;

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum Scenario {
        Success,
        Duplicate,
        InvalidRelation,
        Replacement,
        Cancellation,
        MalformedResponse,
        Ordering,
        Recreation,
        DelayedStaleCommand,
    }

    #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum ResultKind {
        Admitted,
        Applied,
        Cancelled,
        Duplicate,
        Rejected,
        Replaced,
        Retired,
        Snapshot,
    }

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct Event {
        pub logical_time: u8,
        pub operation_id: u8,
        pub runtime_authority: u8,
        pub profile_revision: u8,
        pub result: ResultKind,
        pub mutation_count: u8,
        pub snapshot_order: u8,
    }

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct Transcript {
        pub schema_version: u8,
        pub scenario: Scenario,
        pub events: Vec<Event>,
        pub final_child: u8,
        pub mutation_count: u8,
        pub full_baseline: bool,
    }

    impl Transcript {
        pub fn parse(encoded: &str) -> Result<Self, &'static str> {
            let transcript: Self =
                serde_json::from_str(encoded).map_err(|_| "mobile Route transcript rejected")?;
            if transcript.schema_version != SCHEMA_VERSION
                || transcript.events.is_empty()
                || transcript.events.len() > TRANSCRIPT_LIMIT
                || transcript.events.iter().enumerate().any(|(index, event)| {
                    event.logical_time as usize != index + 1
                        || event.operation_id == 0
                        || event.runtime_authority == 0
                        || event.profile_revision == 0
                })
            {
                return Err("mobile Route transcript bounds rejected");
            }
            Ok(transcript)
        }
    }

    pub fn run(scenario: Scenario) -> Transcript {
        let mut events = Vec::new();
        let mut child = 1;
        let mut mutations = 0;
        let mut order = 1;
        let mut runtime = 1;
        let mut record =
            |operation_id, result, mutation_count, snapshot_order, runtime_authority| {
                events.push(Event {
                    logical_time: events.len() as u8 + 1,
                    operation_id,
                    runtime_authority,
                    profile_revision: 1,
                    result,
                    mutation_count,
                    snapshot_order,
                });
            };
        record(1, ResultKind::Snapshot, mutations, order, runtime);
        match scenario {
            Scenario::Success | Scenario::Ordering => {
                record(2, ResultKind::Admitted, mutations, order, runtime);
                child = 2;
                mutations = 1;
                order = 2;
                record(2, ResultKind::Applied, mutations, order, runtime);
            }
            Scenario::Duplicate => {
                child = 2;
                mutations = 1;
                order = 2;
                record(2, ResultKind::Applied, mutations, order, runtime);
                record(2, ResultKind::Duplicate, mutations, order, runtime);
            }
            Scenario::InvalidRelation | Scenario::MalformedResponse => {
                record(2, ResultKind::Rejected, mutations, order, runtime);
            }
            Scenario::Cancellation => {
                record(2, ResultKind::Cancelled, mutations, order, runtime);
            }
            Scenario::Replacement | Scenario::DelayedStaleCommand => {
                runtime = 2;
                order = 1;
                record(3, ResultKind::Replaced, mutations, order, runtime);
                record(2, ResultKind::Retired, mutations, order, runtime);
            }
            Scenario::Recreation => {
                record(2, ResultKind::Snapshot, mutations, order, runtime);
            }
        }
        Transcript {
            schema_version: SCHEMA_VERSION,
            scenario,
            events,
            final_child: child,
            mutation_count: mutations,
            full_baseline: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    const CONFIG: &[u8] = br#"
mode: rule
proxies:
  - name: Alpha
    type: socks5
    server: secret.example.invalid
    port: 1080
    password: never-project-this-secret
  - name: Beta
    type: socks5
    server: beta.example.invalid
    port: 1080
proxy-groups:
  - name: Proxy
    type: select
    proxies: [Alpha, Beta]
"#;

    fn digest() -> String {
        format!("{:x}", Sha256::digest(CONFIG))
    }

    fn authority(runtime: &str, epoch: u64) -> MobileRouteAuthority {
        MobileRouteAuthority::from_committed_profile(
            "profile-a",
            "revision-a",
            &digest(),
            CONFIG,
            runtime.into(),
            epoch,
        )
        .expect("valid committed profile")
    }

    fn request(
        authority: &MobileRouteAuthority,
        operation_id: &str,
        child_index: usize,
    ) -> MobileRouteCommandRequest {
        let group = authority.catalog.groups.first().expect("selector group");
        MobileRouteCommandRequest {
            child_id: group.child_ids[child_index].clone(),
            current_child_id: group.child_ids[0].clone(),
            group_id: group.id.clone(),
            operation_id: operation_id.into(),
            profile_id: "profile-a".into(),
            profile_revision: "revision-a".into(),
            runtime_authority: authority.runtime_authority.clone(),
        }
    }

    fn native(selected: &str, operation_id: Option<&str>) -> NativeRouteResult {
        NativeRouteResult {
            contract_version: 1,
            failure: None,
            operation_id: operation_id.map(str::to_owned),
            routes: NativeRoutes {
                groups: vec![NativeRouteGroup {
                    candidates: vec!["Alpha".into(), "Beta".into()],
                    name: "Proxy".into(),
                    selected: selected.into(),
                }],
                mode: RoutingMode::Rule,
                truncated: false,
            },
            status: NativeStatus {
                config_sha256: Some(digest()),
                event_sequence: "7".into(),
                loaded: true,
                mode: RoutingMode::Rule,
                phase: NativeCorePhase::Running,
                session_id: Some("session-a".into()),
            },
        }
    }

    #[test]
    fn validates_relation_then_projects_authoritative_ordered_success() {
        let mut authority = authority("runtime-a", 4);
        let request = request(&authority, "route-1", 1);
        assert_eq!(
            authority.preflight(&request),
            Ok(("Proxy".into(), "Alpha".into(), "Beta".into()))
        );

        let snapshot = authority
            .project(native("Beta", Some("route-1")), Some("route-1"))
            .expect("authoritative projection");

        assert_eq!(
            snapshot.status.groups[0].child_ids,
            authority.catalog.groups[0].child_ids
        );
        assert_eq!(
            snapshot.status.groups[0].selected_child_id,
            Some(request.child_id)
        );
        assert_eq!(snapshot.status.application_order.authority_id, "runtime-a");
        assert_eq!(snapshot.status.application_order.epoch, 4);
        assert_eq!(snapshot.status.application_order.order, 1);
        assert!(
            snapshot
                .status
                .group_selection_operation
                .selection_confirmed
        );
    }

    #[test]
    fn duplicate_is_idempotent_but_reused_identity_with_changed_payload_conflicts() {
        let mut authority = authority("runtime-a", 1);
        let request = request(&authority, "route-duplicate", 1);
        let snapshot = authority.project(native("Alpha", None), None).unwrap();
        let result = MobileRouteCommandResult {
            contract_version: 1,
            failure: None,
            operation_id: request.operation_id.clone(),
            snapshot,
            status: MobileRouteCommandStatus::Success,
        };
        authority.remember(request.clone(), result.clone());

        assert_eq!(
            authority.duplicate(&request).unwrap().unwrap().operation_id,
            "route-duplicate"
        );
        let mut changed = request;
        changed.child_id = changed.current_child_id.clone();
        assert!(matches!(
            authority.duplicate(&changed),
            Err(MobileRouteFailure::DuplicateConflict)
        ));
    }

    #[test]
    fn invalid_cancelled_and_replaced_commands_are_rejected_before_mutation() {
        let mut authority = authority("runtime-new", 2);
        let original_selection = authority.catalog.groups[0].selected_child_id.clone();

        let mut invalid = request(&authority, "route-invalid", 1);
        invalid.group_id = "group-not-configured".into();
        assert_eq!(
            authority.preflight(&invalid),
            Err(MobileRouteFailure::InvalidRelation)
        );

        let cancelled = request(&authority, "route-cancelled", 1);
        assert!(authority.cancel(&cancelled.operation_id));
        assert_eq!(
            authority.preflight(&cancelled),
            Err(MobileRouteFailure::Cancelled)
        );

        let mut delayed = request(&authority, "route-delayed", 1);
        delayed.runtime_authority = "runtime-old".into();
        assert_eq!(
            authority.preflight(&delayed),
            Err(MobileRouteFailure::StaleAuthority)
        );
        assert_eq!(
            authority.catalog.groups[0].selected_child_id,
            original_selection
        );
    }

    #[test]
    fn malformed_native_order_is_closed_and_profile_secrets_are_redacted() {
        let mut authority = authority("runtime-a", 1);
        let mut malformed = native("Beta", Some("route-malformed"));
        malformed.routes.groups[0].candidates.reverse();
        assert!(matches!(
            authority.project(malformed, Some("route-malformed")),
            Err(MobileRouteFailure::MalformedNativeResponse)
        ));

        let snapshot = authority.project(native("Alpha", None), None).unwrap();
        let encoded = serde_json::to_string(&snapshot).unwrap();
        assert!(!encoded.contains("never-project-this-secret"));
        assert!(!encoded.contains("secret.example.invalid"));
        assert!(encoded.contains("Alpha"));
    }
}
