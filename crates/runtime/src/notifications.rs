use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use mish_presentation_contract::ApplicationNotification;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

pub const NOTIFICATION_RETENTION_LIMIT: usize = 128;
pub const NOTIFICATION_PRESENTATION_BYTES_LIMIT: usize = 2_048;
pub const NOTIFICATION_PRESENTATION_DEPTH_LIMIT: usize = 3;
pub const NOTIFICATION_PRESENTATION_ENTRIES_LIMIT: usize = 32;
pub const NOTIFICATION_PRESENTATION_STRING_LIMIT: usize = 160;
pub const NOTIFICATION_PRESENTATION_LEASE_MILLISECONDS: u64 = 30_000;
pub const NOTIFICATION_REPLACEMENT_LIMIT: usize = 8;

const IDENTIFIER_LIMIT: usize = 96;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationSeverity {
    Debug,
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationPublication {
    pub dedupe_key: String,
    #[serde(default)]
    pub pinned: bool,
    pub presentation: ApplicationNotification,
    #[serde(default)]
    pub replaces: Vec<String>,
    #[serde(default)]
    pub resolved: bool,
    pub severity: NotificationSeverity,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub created_revision: u64,
    pub dedupe_key: String,
    pub id: String,
    pub observed_at: u64,
    pub pinned: bool,
    pub presentation: ApplicationNotification,
    pub presentation_state: NotificationPresentationState,
    pub read: bool,
    pub resolved: bool,
    pub revision: u64,
    pub severity: NotificationSeverity,
    #[serde(skip)]
    presentation_generation: u64,
    #[serde(skip)]
    presentation_lease: Option<NotificationPresentationLease>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSnapshot {
    pub notifications: Vec<NotificationRecord>,
    pub revision: u64,
}

/// Identifies one client instance and one connection session. The session is deliberately
/// short-lived: reconnecting clients receive a fresh one and cannot complete an old lease.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationPresentationIdentity {
    pub client_id: String,
    pub session_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationPresentationPhase {
    Folded,
    Presenting,
    Unpresented,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NotificationPresentationFoldReason {
    Dismissed,
    Suppressed,
    TimedOut,
}

/// The public, redacted projection of the toast lifecycle. Lease owner identity stays private
/// to Rust; a client receives it only through its own claim acknowledgement.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPresentationState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fold_reason: Option<NotificationPresentationFoldReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folded_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease_generation: Option<u64>,
    pub phase: NotificationPresentationPhase,
}

impl NotificationPresentationState {
    fn folded(reason: NotificationPresentationFoldReason, now: u64) -> Self {
        Self {
            fold_reason: Some(reason),
            folded_at: Some(now),
            lease_expires_at: None,
            lease_generation: None,
            phase: NotificationPresentationPhase::Folded,
        }
    }

    fn presenting(generation: u64, expires_at: u64) -> Self {
        Self {
            fold_reason: None,
            folded_at: None,
            lease_expires_at: Some(expires_at),
            lease_generation: Some(generation),
            phase: NotificationPresentationPhase::Presenting,
        }
    }

    fn unpresented() -> Self {
        Self {
            fold_reason: None,
            folded_at: None,
            lease_expires_at: None,
            lease_generation: None,
            phase: NotificationPresentationPhase::Unpresented,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
struct NotificationPresentationLease {
    expires_at: u64,
    generation: u64,
    identity: NotificationPresentationIdentity,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPresentationClaim {
    pub id: String,
    pub lease_expires_at: u64,
    pub lease_generation: u64,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPresentationClaimResult {
    pub claim: Option<NotificationPresentationClaim>,
    pub snapshot: NotificationSnapshot,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationPresentationCompletion {
    pub client_id: String,
    pub id: String,
    pub lease_generation: u64,
    pub outcome: NotificationPresentationFoldReason,
    pub revision: u64,
    pub session_id: String,
}

impl NotificationPresentationCompletion {
    pub fn identity(&self) -> NotificationPresentationIdentity {
        NotificationPresentationIdentity {
            client_id: self.client_id.clone(),
            session_id: self.session_id.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPresentationCompletionResult {
    pub accepted: bool,
    pub snapshot: NotificationSnapshot,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotificationValidationError {
    InvalidDedupeKey,
    InvalidPresentation,
    InvalidReplacement,
    TooManyReplacements,
}

#[derive(Default)]
struct NotificationState {
    next_id: u64,
    records: VecDeque<NotificationRecord>,
    revision: u64,
}

pub trait NotificationClock: Send + Sync {
    fn now_unix_milliseconds(&self) -> u64;
}

struct SystemNotificationClock;

impl NotificationClock for SystemNotificationClock {
    fn now_unix_milliseconds(&self) -> u64 {
        now_unix_milliseconds()
    }
}

struct NotificationCenterInner {
    clock: Arc<dyn NotificationClock>,
    state: Mutex<NotificationState>,
    updates: broadcast::Sender<NotificationSnapshot>,
}

/// The authoritative in-process Module for notification identity, ordering, retention, and
/// lifecycle. Its Interface accepts semantic references only; localized copy stays in clients.
#[derive(Clone)]
pub struct NotificationCenter {
    inner: Arc<NotificationCenterInner>,
}

impl Default for NotificationCenter {
    fn default() -> Self {
        Self::new()
    }
}

impl NotificationCenter {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemNotificationClock))
    }

    pub fn with_clock(clock: Arc<dyn NotificationClock>) -> Self {
        let (updates, _) = broadcast::channel(32);
        Self {
            inner: Arc::new(NotificationCenterInner {
                clock,
                state: Mutex::new(NotificationState::default()),
                updates,
            }),
        }
    }

    pub fn publish(
        &self,
        publication: NotificationPublication,
    ) -> Result<NotificationSnapshot, NotificationValidationError> {
        validate_publication(&publication)?;
        let mut state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        let existing_index = state.records.iter().rposition(|record| {
            record.dedupe_key == publication.dedupe_key
                && (!record.resolved || publication.resolved)
        });
        let replacements_remove_something = state.records.iter().any(|record| {
            publication
                .replaces
                .iter()
                .any(|dedupe_key| dedupe_key == &record.dedupe_key)
                && record.dedupe_key != publication.dedupe_key
        });
        if !replacements_remove_something
            && existing_index.is_some_and(|index| {
                let record = &state.records[index];
                let effective_severity =
                    if resolution_preserves_occurrence_severity(record, &publication) {
                        record.severity
                    } else {
                        publication.severity
                    };
                record.presentation == publication.presentation
                    && record.pinned == publication.pinned
                    && record.resolved == publication.resolved
                    && record.severity == effective_severity
            })
        {
            return Ok(snapshot(&state));
        }

        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        state.records.retain(|record| {
            record.dedupe_key == publication.dedupe_key
                || !publication
                    .replaces
                    .iter()
                    .any(|dedupe_key| dedupe_key == &record.dedupe_key)
        });

        if let Some(index) = state.records.iter().rposition(|record| {
            record.dedupe_key == publication.dedupe_key
                && (!record.resolved || publication.resolved)
        }) {
            let mut record = state.records.remove(index).expect("existing notification");
            let preserves_occurrence_severity =
                resolution_preserves_occurrence_severity(&record, &publication);
            record.observed_at = self.now();
            record.pinned = publication.pinned;
            record.presentation = publication.presentation;
            record.resolved = publication.resolved;
            record.revision = revision;
            if !preserves_occurrence_severity {
                record.severity = publication.severity;
            }
            state.records.push_back(record);
        } else {
            state.next_id = state.next_id.saturating_add(1);
            let id = format!("notification:{}", state.next_id);
            state.records.push_back(NotificationRecord {
                created_revision: revision,
                dedupe_key: publication.dedupe_key,
                id,
                observed_at: self.now(),
                pinned: publication.pinned,
                presentation: publication.presentation,
                presentation_state: NotificationPresentationState::unpresented(),
                read: false,
                resolved: publication.resolved,
                revision,
                severity: publication.severity,
                presentation_generation: 0,
                presentation_lease: None,
            });
        }
        while state.records.len() > NOTIFICATION_RETENTION_LIMIT {
            state.records.pop_front();
        }
        Ok(self.publish_snapshot(&state))
    }

    pub fn mark_read(&self, ids: &[String]) -> NotificationSnapshot {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        if !state
            .records
            .iter()
            .any(|record| !record.read && ids.contains(&record.id))
        {
            return snapshot(&state);
        }
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        for record in &mut state.records {
            if !record.read && ids.contains(&record.id) {
                record.read = true;
                record.revision = revision;
            }
        }
        self.publish_snapshot(&state)
    }

    pub fn remove(&self, id: &str) -> NotificationSnapshot {
        self.remove_matching(|record| record.id == id && !record.pinned)
    }

    pub fn remove_by_dedupe_key(&self, dedupe_key: &str) -> NotificationSnapshot {
        self.remove_matching(|record| record.dedupe_key == dedupe_key)
    }

    pub fn resolve_by_dedupe_key(&self, dedupe_key: &str) -> NotificationSnapshot {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        let Some(index) = state
            .records
            .iter()
            .rposition(|record| record.dedupe_key == dedupe_key && !record.resolved)
        else {
            return snapshot(&state);
        };
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        let record = &mut state.records[index];
        record.pinned = false;
        record.resolved = true;
        record.revision = revision;
        self.publish_snapshot(&state)
    }

    pub fn snapshot(&self) -> NotificationSnapshot {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        self.requeue_expired_locked(&mut state, self.now());
        snapshot(&state)
    }

    /// Installs the receiver while the state lock is held, so a publication cannot land between
    /// the baseline snapshot and the live subscription.
    pub fn subscribe_with_snapshot(
        &self,
    ) -> (
        broadcast::Receiver<NotificationSnapshot>,
        NotificationSnapshot,
    ) {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        let receiver = self.inner.updates.subscribe();
        self.requeue_expired_locked(&mut state, self.now());
        (receiver, snapshot(&state))
    }

    /// Atomically installs a snapshot receiver and claims the next eligible record. This is the
    /// only startup/reconnect path that may create a toast lease.
    pub fn subscribe_with_presentation_claim(
        &self,
        identity: NotificationPresentationIdentity,
    ) -> (
        broadcast::Receiver<NotificationSnapshot>,
        NotificationPresentationClaimResult,
    ) {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        let receiver = self.inner.updates.subscribe();
        let result = self.claim_next_locked(&mut state, identity, self.now());
        (receiver, result)
    }

    pub fn claim_next_presentation(
        &self,
        identity: NotificationPresentationIdentity,
    ) -> NotificationPresentationClaimResult {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        self.claim_next_locked(&mut state, identity, self.now())
    }

    pub fn complete_presentation(
        &self,
        completion: NotificationPresentationCompletion,
    ) -> NotificationPresentationCompletionResult {
        let now = self.now();
        let mut state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        let mut changed_indices = self.expire_locked(&mut state, now);
        let identity = completion.identity();
        let accepted = state
            .records
            .iter()
            .position(|record| record.id == completion.id)
            .is_some_and(|index| {
                let record = &state.records[index];
                record.revision == completion.revision
                    && record.presentation_state.phase == NotificationPresentationPhase::Presenting
                    && record.presentation_lease.as_ref().is_some_and(|lease| {
                        lease.identity == identity
                            && lease.generation == completion.lease_generation
                            && lease.expires_at > now
                    })
            });
        if accepted {
            let index = state
                .records
                .iter()
                .position(|record| record.id == completion.id)
                .expect("accepted presentation record");
            let record = &mut state.records[index];
            record.presentation_lease = None;
            record.presentation_state =
                NotificationPresentationState::folded(completion.outcome, now);
            changed_indices.push(index);
        }
        let snapshot = self.commit_indices_locked(&mut state, changed_indices);
        NotificationPresentationCompletionResult { accepted, snapshot }
    }

    /// Releases every live lease held by a disconnected client session. A later client must make
    /// a fresh atomic claim; it cannot infer presentation from a retained snapshot.
    pub fn release_presentation_leases(
        &self,
        identity: &NotificationPresentationIdentity,
    ) -> NotificationSnapshot {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        let mut changed_indices = self.expire_locked(&mut state, self.now());
        for (index, record) in state.records.iter_mut().enumerate() {
            if record
                .presentation_lease
                .as_ref()
                .is_some_and(|lease| &lease.identity == identity)
            {
                record.presentation_lease = None;
                record.presentation_state = NotificationPresentationState::unpresented();
                changed_indices.push(index);
            }
        }
        self.commit_indices_locked(&mut state, changed_indices)
    }

    fn publish_snapshot(&self, state: &NotificationState) -> NotificationSnapshot {
        let snapshot = snapshot(state);
        let _ = self.inner.updates.send(snapshot.clone());
        snapshot
    }

    fn remove_matching(
        &self,
        predicate: impl Fn(&NotificationRecord) -> bool,
    ) -> NotificationSnapshot {
        let mut state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        let before = state.records.len();
        state.records.retain(|record| !predicate(record));
        if before == state.records.len() {
            return snapshot(&state);
        }
        state.revision = state.revision.saturating_add(1);
        self.publish_snapshot(&state)
    }

    fn claim_next_locked(
        &self,
        state: &mut NotificationState,
        identity: NotificationPresentationIdentity,
        now: u64,
    ) -> NotificationPresentationClaimResult {
        let mut changed_indices = self.expire_locked(state, now);
        if let Some(index) = state.records.iter().position(|record| {
            record
                .presentation_lease
                .as_ref()
                .is_some_and(|lease| lease.identity == identity)
        }) {
            let snapshot = self.commit_indices_locked(state, changed_indices);
            return NotificationPresentationClaimResult {
                claim: presentation_claim(&state.records[index]),
                snapshot,
            };
        }

        // This is a single bounded presentation queue, not one independent queue per client.
        // A different client cannot skip the current lease and start presenting a later record.
        if state.records.iter().any(|record| {
            record.presentation_state.phase == NotificationPresentationPhase::Presenting
        }) {
            let snapshot = self.commit_indices_locked(state, changed_indices);
            return NotificationPresentationClaimResult {
                claim: None,
                snapshot,
            };
        }

        if let Some(index) = state.records.iter().position(|record| {
            record.presentation_state.phase == NotificationPresentationPhase::Unpresented
        }) {
            let next_generation = state.records[index]
                .presentation_generation
                .saturating_add(1)
                .max(1);
            let expires_at = now.saturating_add(NOTIFICATION_PRESENTATION_LEASE_MILLISECONDS);
            let record = &mut state.records[index];
            record.presentation_generation = next_generation;
            record.presentation_lease = Some(NotificationPresentationLease {
                expires_at,
                generation: next_generation,
                identity: identity.clone(),
            });
            record.presentation_state =
                NotificationPresentationState::presenting(next_generation, expires_at);
            changed_indices.push(index);
        }

        let snapshot = self.commit_indices_locked(state, changed_indices);
        let claim = state
            .records
            .iter()
            .find(|record| {
                record
                    .presentation_lease
                    .as_ref()
                    .is_some_and(|lease| lease.identity == identity)
            })
            .and_then(presentation_claim);
        NotificationPresentationClaimResult { claim, snapshot }
    }

    fn commit_indices_locked(
        &self,
        state: &mut NotificationState,
        mut changed_indices: Vec<usize>,
    ) -> NotificationSnapshot {
        changed_indices.sort_unstable();
        changed_indices.dedup();
        if changed_indices.is_empty() {
            return snapshot(state);
        }
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        for index in changed_indices {
            if let Some(record) = state.records.get_mut(index) {
                record.revision = revision;
            }
        }
        self.publish_snapshot(state)
    }

    fn expire_locked(&self, state: &mut NotificationState, now: u64) -> Vec<usize> {
        let mut expired = Vec::new();
        for (index, record) in state.records.iter_mut().enumerate() {
            if record
                .presentation_lease
                .as_ref()
                .is_some_and(|lease| lease.expires_at <= now)
            {
                record.presentation_lease = None;
                record.presentation_state = NotificationPresentationState::unpresented();
                expired.push(index);
            }
        }
        expired
    }

    fn requeue_expired_locked(&self, state: &mut NotificationState, now: u64) -> bool {
        let expired = self.expire_locked(state, now);
        if expired.is_empty() {
            return false;
        }
        self.commit_indices_locked(state, expired);
        true
    }

    fn now(&self) -> u64 {
        self.inner.clock.now_unix_milliseconds()
    }
}

fn presentation_claim(record: &NotificationRecord) -> Option<NotificationPresentationClaim> {
    let lease = record.presentation_lease.as_ref()?;
    Some(NotificationPresentationClaim {
        id: record.id.clone(),
        lease_expires_at: lease.expires_at,
        lease_generation: lease.generation,
        revision: record.revision,
    })
}

pub fn valid_notification_presentation_identity(
    identity: &NotificationPresentationIdentity,
) -> bool {
    valid_identifier(&identity.client_id, false) && valid_identifier(&identity.session_id, false)
}

pub fn valid_notification_presentation_completion(
    completion: &NotificationPresentationCompletion,
) -> bool {
    valid_notification_presentation_identity(&completion.identity())
        && valid_identifier(&completion.id, true)
        && completion.lease_generation > 0
}

fn snapshot(state: &NotificationState) -> NotificationSnapshot {
    NotificationSnapshot {
        notifications: state.records.iter().rev().cloned().collect(),
        revision: state.revision,
    }
}

/// Resolution may retire recovery actions or pinning, but it is not a semantic success outcome.
/// A producer must change the typed semantic content (or publish a new occurrence) before it can
/// change the severity of an existing resolved record.
fn resolution_preserves_occurrence_severity(
    record: &NotificationRecord,
    publication: &NotificationPublication,
) -> bool {
    publication.resolved && record.presentation.content == publication.presentation.content
}

fn validate_publication(
    publication: &NotificationPublication,
) -> Result<(), NotificationValidationError> {
    if !valid_identifier(&publication.dedupe_key, true) {
        return Err(NotificationValidationError::InvalidDedupeKey);
    }
    if publication.replaces.len() > NOTIFICATION_REPLACEMENT_LIMIT {
        return Err(NotificationValidationError::TooManyReplacements);
    }
    if publication
        .replaces
        .iter()
        .any(|dedupe_key| !valid_identifier(dedupe_key, true))
    {
        return Err(NotificationValidationError::InvalidReplacement);
    }
    if !publication.presentation.actions_valid() {
        return Err(NotificationValidationError::InvalidPresentation);
    }
    let presentation = serde_json::to_value(&publication.presentation)
        .map_err(|_| NotificationValidationError::InvalidPresentation)?;
    let serialized = serde_json::to_vec(&presentation)
        .map_err(|_| NotificationValidationError::InvalidPresentation)?;
    let mut entries = 0;
    if !presentation.is_object()
        || serialized.len() > NOTIFICATION_PRESENTATION_BYTES_LIMIT
        || !valid_presentation_value(&presentation, 0, &mut entries)
    {
        return Err(NotificationValidationError::InvalidPresentation);
    }
    Ok(())
}

fn valid_identifier(value: &str, allow_colon: bool) -> bool {
    !value.is_empty()
        && value.len() <= IDENTIFIER_LIMIT
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'-' | b'_')
                || (allow_colon && byte == b':')
        })
}

fn valid_presentation_value(value: &Value, depth: usize, entries: &mut usize) -> bool {
    if depth > NOTIFICATION_PRESENTATION_DEPTH_LIMIT {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::String(value) => valid_presentation_string(value),
        Value::Array(values) => {
            *entries = entries.saturating_add(values.len());
            *entries <= NOTIFICATION_PRESENTATION_ENTRIES_LIMIT
                && values
                    .iter()
                    .all(|value| valid_presentation_value(value, depth + 1, entries))
        }
        Value::Object(values) => {
            *entries = entries.saturating_add(values.len());
            *entries <= NOTIFICATION_PRESENTATION_ENTRIES_LIMIT
                && values.iter().all(|(key, value)| {
                    valid_presentation_key(key)
                        && valid_presentation_value(value, depth + 1, entries)
                })
        }
    }
}

fn valid_presentation_key(key: &str) -> bool {
    if key.is_empty()
        || key.len() > IDENTIFIER_LIMIT
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return false;
    }
    let lower = key.to_ascii_lowercase();
    ![
        "diagnostic",
        "detail",
        "error",
        "message",
        "password",
        "path",
        "secret",
        "token",
        "url",
    ]
    .iter()
    .any(|forbidden| lower.contains(forbidden))
}

fn valid_presentation_string(value: &str) -> bool {
    if value.is_empty() || value.len() > NOTIFICATION_PRESENTATION_STRING_LIMIT {
        return false;
    }
    let lower = value.to_ascii_lowercase();
    let token_like = value.len() >= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'='));
    !value.contains("://")
        && !value.contains('/')
        && !value.contains('\\')
        && !lower.contains("bearer ")
        && !lower.contains("token=")
        && !token_like
}

fn now_unix_milliseconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use mish_presentation_contract::{
        ApplicationActionId, ApplicationNotificationContent,
        OnboardingWelcomeApplicationNotificationData, ProfileCreatedApplicationNotificationData,
        ProfileSavedApplicationNotificationData,
    };

    use super::*;

    fn publication(key: &str, value: u64) -> NotificationPublication {
        let content = if value % 2 == 0 {
            ApplicationNotificationContent::ProfileCreated(
                ProfileCreatedApplicationNotificationData {},
            )
        } else {
            ApplicationNotificationContent::ProfileSaved(ProfileSavedApplicationNotificationData {})
        };
        NotificationPublication {
            dedupe_key: key.into(),
            pinned: false,
            presentation: ApplicationNotification::new(content, Vec::new()),
            replaces: Vec::new(),
            resolved: false,
            severity: NotificationSeverity::Info,
        }
    }

    #[derive(Default)]
    struct TestClock(Mutex<u64>);

    impl TestClock {
        fn advance(&self, milliseconds: u64) {
            let mut now = self.0.lock().unwrap();
            *now = now.saturating_add(milliseconds);
        }
    }

    impl NotificationClock for TestClock {
        fn now_unix_milliseconds(&self) -> u64 {
            *self.0.lock().unwrap()
        }
    }

    fn center_with_clock() -> (NotificationCenter, Arc<TestClock>) {
        let clock = Arc::new(TestClock(Mutex::new(1_000)));
        (NotificationCenter::with_clock(clock.clone()), clock)
    }

    fn identity(client_id: &str, session_id: &str) -> NotificationPresentationIdentity {
        NotificationPresentationIdentity {
            client_id: client_id.into(),
            session_id: session_id.into(),
        }
    }

    fn completion(
        identity: &NotificationPresentationIdentity,
        claim: &NotificationPresentationClaim,
        outcome: NotificationPresentationFoldReason,
    ) -> NotificationPresentationCompletion {
        NotificationPresentationCompletion {
            client_id: identity.client_id.clone(),
            id: claim.id.clone(),
            lease_generation: claim.lease_generation,
            outcome,
            revision: claim.revision,
            session_id: identity.session_id.clone(),
        }
    }

    #[test]
    fn publish_updates_stable_identity_and_monotonic_revision() {
        let center = NotificationCenter::new();
        let first_publication = publication("same", 1);
        let first = center.publish(first_publication.clone()).unwrap();
        let id = first.notifications[0].id.clone();
        let unchanged = center.publish(first_publication).unwrap();
        let updated = center.publish(publication("same", 2)).unwrap();

        assert_eq!(unchanged.revision, first.revision);
        assert_eq!(updated.revision, first.revision + 1);
        assert_eq!(updated.notifications[0].id, id);
        assert_eq!(updated.notifications[0].created_revision, first.revision);
    }

    #[test]
    fn generated_semantic_presentation_is_stored_without_localized_copy() {
        let center = NotificationCenter::new();
        let snapshot = center.publish(publication("typed", 7)).unwrap();
        let record = &snapshot.notifications[0];

        assert_eq!(record.presentation.kind(), "profile.saved");
        let serialized = serde_json::to_value(record).unwrap();
        assert!(serialized.get("message").is_none());
        assert!(serialized.get("detail").is_none());
    }

    #[test]
    fn publishing_after_resolution_creates_a_new_instance() {
        let center = NotificationCenter::new();
        let first = center.publish(publication("shared", 1)).unwrap();
        let first_id = first.notifications[0].id.clone();
        center.resolve_by_dedupe_key("shared");

        let second = center.publish(publication("shared", 2)).unwrap();

        assert_eq!(second.notifications.len(), 2);
        assert_ne!(second.notifications[0].id, first_id);
        assert!(!second.notifications[0].resolved);
        assert!(second.notifications[1].resolved);
    }

    #[test]
    fn pinned_lifecycle_blocks_removal_until_resolution() {
        let center = NotificationCenter::new();
        let mut progress = publication("progress", 1);
        progress.pinned = true;
        let published = center.publish(progress).unwrap();
        let id = published.notifications[0].id.clone();

        let retained = center.remove(&id);
        assert_eq!(retained.notifications.len(), 1);
        assert!(retained.notifications[0].pinned);

        let resolved = center.resolve_by_dedupe_key("progress");
        assert_eq!(resolved.notifications[0].id, id);
        assert!(resolved.notifications[0].resolved);
        assert!(!resolved.notifications[0].pinned);

        let removed = center.remove(&id);
        assert!(removed.notifications.is_empty());
    }

    #[test]
    fn replacement_and_retention_are_authoritative() {
        let center = NotificationCenter::new();
        center.publish(publication("obsolete", 0)).unwrap();
        let mut replacement = publication("replacement", 1);
        replacement.replaces.push("obsolete".into());
        let snapshot = center.publish(replacement).unwrap();
        assert_eq!(snapshot.notifications.len(), 1);
        assert_eq!(snapshot.notifications[0].dedupe_key, "replacement");

        for index in 0..=NOTIFICATION_RETENTION_LIMIT {
            center
                .publish(publication(&format!("retained-{index}"), index as u64))
                .unwrap();
        }
        let snapshot = center.snapshot();
        assert_eq!(snapshot.notifications.len(), NOTIFICATION_RETENTION_LIMIT);
        assert_eq!(snapshot.notifications[0].dedupe_key, "retained-128");
    }

    #[test]
    fn read_remove_and_resolution_publish_to_all_clients() {
        let center = NotificationCenter::new();
        let (mut first, baseline) = center.subscribe_with_snapshot();
        let (mut second, _) = center.subscribe_with_snapshot();
        assert_eq!(baseline.revision, 0);
        let published = center.publish(publication("shared", 1)).unwrap();
        assert_eq!(first.try_recv().unwrap(), published);
        assert_eq!(second.try_recv().unwrap(), published);

        let read = center.mark_read(&[published.notifications[0].id.clone()]);
        assert!(read.notifications[0].read);
        assert_eq!(first.try_recv().unwrap(), read);
        assert_eq!(second.try_recv().unwrap(), read);

        let resolved = center.resolve_by_dedupe_key("shared");
        assert!(resolved.notifications[0].resolved);
        assert_eq!(
            resolved.notifications[0].severity,
            NotificationSeverity::Info
        );
        assert_eq!(first.try_recv().unwrap(), resolved);
        assert_eq!(second.try_recv().unwrap(), resolved);
        assert_eq!(
            center.snapshot().notifications[0].id,
            published.notifications[0].id
        );

        let removed = center.remove(&published.notifications[0].id);
        assert!(removed.notifications.is_empty());
        assert_eq!(first.try_recv().unwrap(), removed);
        assert_eq!(second.try_recv().unwrap(), removed);
    }

    #[test]
    fn resolution_only_publication_cannot_rewrite_occurrence_severity() {
        let center = NotificationCenter::new();
        let mut failure = publication("resolution-only", 1);
        failure.severity = NotificationSeverity::Error;
        let created = center.publish(failure.clone()).unwrap();
        let id = created.notifications[0].id.clone();

        let mut resolution = failure;
        resolution.resolved = true;
        resolution.severity = NotificationSeverity::Success;
        let resolved = center.publish(resolution.clone()).unwrap();
        let record = &resolved.notifications[0];
        assert_eq!(record.id, id);
        assert!(record.resolved);
        assert_eq!(record.severity, NotificationSeverity::Error);

        let repeated = center.publish(resolution).unwrap();
        assert_eq!(repeated.revision, resolved.revision);
        assert_eq!(
            repeated.notifications[0].severity,
            NotificationSeverity::Error
        );
    }

    #[test]
    fn resolution_preserves_all_occurrence_severities_across_read_fold_reconnect_and_retention() {
        let (center, _) = center_with_clock();
        let severities = [
            NotificationSeverity::Error,
            NotificationSeverity::Warning,
            NotificationSeverity::Info,
            NotificationSeverity::Success,
        ];
        let mut retained = Vec::new();

        for (index, severity) in severities.into_iter().enumerate() {
            let key = format!("severity-{index}");
            let mut publication = publication(&key, index as u64);
            publication.pinned = true;
            publication.severity = severity;
            let created = center.publish(publication).unwrap();
            let id = created.notifications[0].id.clone();

            let read = center.mark_read(&[id.clone()]);
            assert!(
                read.notifications
                    .iter()
                    .find(|record| record.id == id)
                    .is_some_and(|record| record.read && record.severity == severity)
            );

            let owner = identity(&format!("owner-{index}"), &format!("session-{index}"));
            let claim = center
                .claim_next_presentation(owner.clone())
                .claim
                .expect("the retained occurrence is eligible for presentation");
            let resolved = center.resolve_by_dedupe_key(&key);
            assert!(
                resolved
                    .notifications
                    .iter()
                    .find(|record| record.id == id)
                    .is_some_and(|record| {
                        record.read
                            && record.resolved
                            && !record.pinned
                            && record.severity == severity
                            && record.presentation_state.phase
                                == NotificationPresentationPhase::Presenting
                    })
            );

            let requeued = center.release_presentation_leases(&owner);
            assert!(
                requeued
                    .notifications
                    .iter()
                    .find(|record| record.id == id)
                    .is_some_and(|record| {
                        record.severity == severity
                            && record.presentation_state.phase
                                == NotificationPresentationPhase::Unpresented
                    })
            );

            let reconnect = identity(
                &format!("reconnected-owner-{index}"),
                &format!("reconnected-session-{index}"),
            );
            let reconnect_claim = center
                .claim_next_presentation(reconnect.clone())
                .claim
                .expect("a reconnect receives a fresh lease for the retained occurrence");
            assert_eq!(reconnect_claim.id, claim.id);
            let folded = center.complete_presentation(completion(
                &reconnect,
                &reconnect_claim,
                NotificationPresentationFoldReason::Dismissed,
            ));
            assert!(folded.accepted);
            assert!(
                folded
                    .snapshot
                    .notifications
                    .iter()
                    .find(|record| record.id == id)
                    .is_some_and(|record| {
                        record.read
                            && record.resolved
                            && record.severity == severity
                            && record.presentation_state.phase
                                == NotificationPresentationPhase::Folded
                    })
            );
            retained.push((id, severity));
        }

        for index in 0..(NOTIFICATION_RETENTION_LIMIT - retained.len()) {
            center
                .publish(publication(&format!("retention-{index}"), index as u64))
                .unwrap();
        }
        let within_bound = center.snapshot();
        assert_eq!(
            within_bound.notifications.len(),
            NOTIFICATION_RETENTION_LIMIT
        );
        for (id, severity) in &retained {
            assert!(
                within_bound
                    .notifications
                    .iter()
                    .find(|record| &record.id == id)
                    .is_some_and(|record| record.severity == *severity)
            );
        }

        let overflow = center
            .publish(publication("retention-overflow", 0))
            .unwrap();
        assert_eq!(overflow.notifications.len(), NOTIFICATION_RETENTION_LIMIT);
        assert!(
            overflow
                .notifications
                .iter()
                .all(|record| record.id != retained[0].0)
        );
        for (id, severity) in retained.iter().skip(1) {
            assert!(
                overflow
                    .notifications
                    .iter()
                    .find(|record| &record.id == id)
                    .is_some_and(|record| record.severity == *severity)
            );
        }
    }

    #[test]
    fn subscribe_baseline_cannot_miss_a_later_publication() {
        let center = NotificationCenter::new();
        center.publish(publication("baseline", 1)).unwrap();
        let (mut updates, baseline) = center.subscribe_with_snapshot();
        let next = center.publish(publication("next", 2)).unwrap();
        assert_eq!(baseline.notifications.len(), 1);
        assert_eq!(updates.try_recv().unwrap(), next);
    }

    #[test]
    fn pre_gui_onboarding_creation_claims_atomically_and_never_implies_presentation() {
        let (center, _) = center_with_clock();
        let created = center
            .publish(NotificationPublication {
                dedupe_key: "onboarding.welcome".into(),
                pinned: false,
                presentation: ApplicationNotification::new(
                    ApplicationNotificationContent::OnboardingWelcome(
                        OnboardingWelcomeApplicationNotificationData { prompt: true },
                    ),
                    vec![ApplicationActionId::OpenWelcome],
                ),
                replaces: Vec::new(),
                resolved: false,
                severity: NotificationSeverity::Info,
            })
            .unwrap();
        assert_eq!(
            created.notifications[0].presentation_state.phase,
            NotificationPresentationPhase::Unpresented
        );

        let owner = identity("desktop-webview", "session-1");
        let (_updates, subscribed) = center.subscribe_with_presentation_claim(owner);
        let claim = subscribed
            .claim
            .expect("first eligible client claims onboarding");
        assert_eq!(claim.id, created.notifications[0].id);
        assert_eq!(
            claim.revision,
            subscribed.snapshot.notifications[0].revision
        );
        assert_eq!(
            subscribed.snapshot.notifications[0]
                .presentation_state
                .phase,
            NotificationPresentationPhase::Presenting
        );
        assert_eq!(
            subscribed.snapshot.notifications[0]
                .presentation_state
                .lease_generation,
            Some(claim.lease_generation)
        );
    }

    #[test]
    fn only_one_client_can_hold_a_current_lease_and_stale_ack_cannot_fold_a_replacement() {
        let (center, _) = center_with_clock();
        let created = center.publish(publication("lease", 1)).unwrap();
        let queued = center.publish(publication("queued", 2)).unwrap();
        let first = identity("browser-a", "session-a");
        let second = identity("browser-b", "session-b");
        let first_claim = center
            .claim_next_presentation(first.clone())
            .claim
            .expect("first client claims");
        assert_eq!(first_claim.id, created.notifications[0].id);
        assert!(
            center
                .claim_next_presentation(second.clone())
                .claim
                .is_none()
        );
        assert_eq!(
            center
                .snapshot()
                .notifications
                .iter()
                .filter(|record| {
                    record.presentation_state.phase == NotificationPresentationPhase::Presenting
                })
                .count(),
            1,
            "a later queued record cannot be claimed by a concurrent client"
        );

        let read = center.mark_read(&[first_claim.id.clone()]);
        let refreshed_claim = center
            .claim_next_presentation(first.clone())
            .claim
            .expect("same owner gets its current lease");
        assert_eq!(
            refreshed_claim.lease_generation,
            first_claim.lease_generation
        );
        assert_eq!(
            refreshed_claim.revision,
            read.notifications
                .iter()
                .find(|record| record.id == first_claim.id)
                .expect("claimed record remains retained")
                .revision
        );
        assert!(
            !center
                .complete_presentation(completion(
                    &first,
                    &first_claim,
                    NotificationPresentationFoldReason::Dismissed,
                ))
                .accepted
        );

        center.release_presentation_leases(&first);
        let replacement_claim = center
            .claim_next_presentation(second.clone())
            .claim
            .expect("replacement client claims requeued record");
        assert!(replacement_claim.lease_generation > first_claim.lease_generation);
        assert!(
            !center
                .complete_presentation(completion(
                    &first,
                    &refreshed_claim,
                    NotificationPresentationFoldReason::Dismissed,
                ))
                .accepted
        );
        let folded = center.complete_presentation(completion(
            &second,
            &replacement_claim,
            NotificationPresentationFoldReason::Dismissed,
        ));
        assert!(folded.accepted);
        let folded_record = folded
            .snapshot
            .notifications
            .iter()
            .find(|record| record.id == first_claim.id)
            .expect("folded record stays in the center");
        assert_eq!(
            folded_record.presentation_state.phase,
            NotificationPresentationPhase::Folded
        );
        assert_eq!(
            folded_record.presentation_state.fold_reason,
            Some(NotificationPresentationFoldReason::Dismissed)
        );
        let next = center
            .claim_next_presentation(second)
            .claim
            .expect("folding the active toast advances the global queue");
        assert_eq!(next.id, queued.notifications[0].id);
    }

    #[test]
    fn disconnect_and_expiry_requeue_while_completion_persists_the_folded_record() {
        let (center, clock) = center_with_clock();
        center.publish(publication("requeue", 1)).unwrap();
        let crashed = identity("browser-a", "session-a");
        let recovery = identity("desktop-webview", "session-b");
        let claimed = center
            .claim_next_presentation(crashed.clone())
            .claim
            .expect("client claims before crashing");
        let requeued = center.release_presentation_leases(&crashed);
        assert_eq!(
            requeued.notifications[0].presentation_state.phase,
            NotificationPresentationPhase::Unpresented
        );
        let recovered = center
            .claim_next_presentation(recovery.clone())
            .claim
            .expect("disconnected lease requeues");
        assert!(recovered.lease_generation > claimed.lease_generation);

        clock.advance(NOTIFICATION_PRESENTATION_LEASE_MILLISECONDS);
        let expired = center.snapshot();
        assert_eq!(
            expired.notifications[0].presentation_state.phase,
            NotificationPresentationPhase::Unpresented,
            "the authoritative expiry sweep requeues without a client claim"
        );
        let after_expiry = center
            .claim_next_presentation(crashed.clone())
            .claim
            .expect("expired lease requeues for another client");
        assert!(after_expiry.lease_generation > recovered.lease_generation);
        let folded = center.complete_presentation(completion(
            &crashed,
            &after_expiry,
            NotificationPresentationFoldReason::TimedOut,
        ));
        assert!(folded.accepted);
        assert_eq!(folded.snapshot.notifications.len(), 1);
        assert_eq!(
            folded.snapshot.notifications[0]
                .presentation_state
                .fold_reason,
            Some(NotificationPresentationFoldReason::TimedOut)
        );
        assert!(center.claim_next_presentation(recovery).claim.is_none());
    }

    #[test]
    fn read_resolution_and_removal_do_not_implicitly_consume_a_presentation_lease() {
        let (center, _) = center_with_clock();
        let created = center.publish(publication("independent", 1)).unwrap();
        let id = created.notifications[0].id.clone();
        let read = center.mark_read(&[id.clone()]);
        assert!(read.notifications[0].read);
        assert_eq!(
            read.notifications[0].presentation_state.phase,
            NotificationPresentationPhase::Unpresented
        );
        let resolved = center.resolve_by_dedupe_key("independent");
        assert!(resolved.notifications[0].resolved);
        assert_eq!(
            resolved.notifications[0].presentation_state.phase,
            NotificationPresentationPhase::Unpresented
        );

        let owner = identity("desktop-webview", "session-1");
        let claim = center
            .claim_next_presentation(owner.clone())
            .claim
            .expect("resolution does not consume the pending presentation");
        let resolved_while_presenting = center.resolve_by_dedupe_key("independent");
        assert_eq!(
            resolved_while_presenting.notifications[0]
                .presentation_state
                .phase,
            NotificationPresentationPhase::Presenting
        );
        center.remove(&id);
        assert!(
            !center
                .complete_presentation(completion(
                    &owner,
                    &claim,
                    NotificationPresentationFoldReason::Dismissed,
                ))
                .accepted
        );
    }

    #[test]
    fn rejects_invalid_actions_sensitive_data_and_missing_typed_arguments() {
        let center = NotificationCenter::new();
        let mut oversized = publication("oversized", 1);
        oversized.presentation = ApplicationNotification::new(
            ApplicationNotificationContent::RouteSelectionFailed(
                mish_presentation_contract::RouteSelectionFailedApplicationNotificationData {
                    child: "x".repeat(NOTIFICATION_PRESENTATION_STRING_LIMIT + 1),
                },
            ),
            Vec::new(),
        );
        assert_eq!(
            center.publish(oversized),
            Err(NotificationValidationError::InvalidPresentation)
        );

        let mut invalid_action = publication("invalid-action", 1);
        invalid_action.presentation.action_ids = vec![ApplicationActionId::RetryProfileActivation];
        assert_eq!(
            center.publish(invalid_action),
            Err(NotificationValidationError::InvalidPresentation)
        );

        let mut sensitive = publication("sensitive", 1);
        sensitive.presentation = ApplicationNotification::new(
            ApplicationNotificationContent::RouteSelectionFailed(
                mish_presentation_contract::RouteSelectionFailedApplicationNotificationData {
                    child: "https://private.invalid/token=secret".into(),
                },
            ),
            Vec::new(),
        );
        assert_eq!(
            center.publish(sensitive),
            Err(NotificationValidationError::InvalidPresentation)
        );

        let missing = serde_json::from_value::<NotificationPublication>(serde_json::json!({
            "dedupeKey": "missing",
            "pinned": false,
            "presentation": {
                "actionIds": [],
                "data": {},
                "kind": "traffic.connections-closed"
            },
            "replaces": [],
            "resolved": false,
            "severity": "success"
        }));
        assert!(missing.is_err());
    }
}
