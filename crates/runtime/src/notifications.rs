use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

pub const NOTIFICATION_RETENTION_LIMIT: usize = 128;
pub const NOTIFICATION_PARAMETER_BYTES_LIMIT: usize = 2_048;
pub const NOTIFICATION_PARAMETER_DEPTH_LIMIT: usize = 3;
pub const NOTIFICATION_PARAMETER_ENTRIES_LIMIT: usize = 32;
pub const NOTIFICATION_PARAMETER_STRING_LIMIT: usize = 160;
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
    #[serde(rename = "type")]
    pub notification_type: String,
    #[serde(default)]
    pub params: Value,
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
    #[serde(rename = "type")]
    pub notification_type: String,
    pub params: Value,
    pub read: bool,
    pub resolved: bool,
    pub revision: u64,
    pub severity: NotificationSeverity,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSnapshot {
    pub notifications: Vec<NotificationRecord>,
    pub revision: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotificationValidationError {
    InvalidDedupeKey,
    InvalidNotificationType,
    InvalidParameters,
    InvalidReplacement,
    TooManyReplacements,
}

#[derive(Default)]
struct NotificationState {
    next_id: u64,
    records: VecDeque<NotificationRecord>,
    revision: u64,
}

struct NotificationCenterInner {
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
        let (updates, _) = broadcast::channel(32);
        Self {
            inner: Arc::new(NotificationCenterInner {
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
        let existing_index = state
            .records
            .iter()
            .position(|record| record.dedupe_key == publication.dedupe_key);
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
                record.notification_type == publication.notification_type
                    && record.params == publication.params
                    && record.resolved == publication.resolved
                    && record.severity == publication.severity
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

        if let Some(index) = state
            .records
            .iter()
            .position(|record| record.dedupe_key == publication.dedupe_key)
        {
            let mut record = state.records.remove(index).expect("existing notification");
            record.notification_type = publication.notification_type;
            record.observed_at = now_unix_milliseconds();
            record.params = publication.params;
            record.resolved = publication.resolved;
            record.revision = revision;
            record.severity = publication.severity;
            state.records.push_back(record);
        } else {
            state.next_id = state.next_id.saturating_add(1);
            let id = format!("notification:{}", state.next_id);
            state.records.push_back(NotificationRecord {
                created_revision: revision,
                dedupe_key: publication.dedupe_key,
                id,
                notification_type: publication.notification_type,
                observed_at: now_unix_milliseconds(),
                params: publication.params,
                read: false,
                resolved: publication.resolved,
                revision,
                severity: publication.severity,
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
            .position(|record| record.dedupe_key == dedupe_key && !record.resolved)
        else {
            return snapshot(&state);
        };
        state.revision = state.revision.saturating_add(1);
        let revision = state.revision;
        let record = &mut state.records[index];
        record.resolved = true;
        record.revision = revision;
        record.severity = NotificationSeverity::Success;
        self.publish_snapshot(&state)
    }

    pub fn snapshot(&self) -> NotificationSnapshot {
        snapshot(
            &self
                .inner
                .state
                .lock()
                .expect("notification state poisoned"),
        )
    }

    /// Installs the receiver while the state lock is held, so a publication cannot land between
    /// the baseline snapshot and the live subscription.
    pub fn subscribe_with_snapshot(
        &self,
    ) -> (
        broadcast::Receiver<NotificationSnapshot>,
        NotificationSnapshot,
    ) {
        let state = self
            .inner
            .state
            .lock()
            .expect("notification state poisoned");
        let receiver = self.inner.updates.subscribe();
        (receiver, snapshot(&state))
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
}

fn snapshot(state: &NotificationState) -> NotificationSnapshot {
    NotificationSnapshot {
        notifications: state.records.iter().rev().cloned().collect(),
        revision: state.revision,
    }
}

fn validate_publication(
    publication: &NotificationPublication,
) -> Result<(), NotificationValidationError> {
    if !valid_identifier(&publication.dedupe_key, true) {
        return Err(NotificationValidationError::InvalidDedupeKey);
    }
    if !valid_identifier(&publication.notification_type, false) {
        return Err(NotificationValidationError::InvalidNotificationType);
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
    let serialized = serde_json::to_vec(&publication.params)
        .map_err(|_| NotificationValidationError::InvalidParameters)?;
    let mut entries = 0;
    if !publication.params.is_object()
        || serialized.len() > NOTIFICATION_PARAMETER_BYTES_LIMIT
        || !valid_parameter_value(&publication.params, 0, &mut entries)
    {
        return Err(NotificationValidationError::InvalidParameters);
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

fn valid_parameter_value(value: &Value, depth: usize, entries: &mut usize) -> bool {
    if depth > NOTIFICATION_PARAMETER_DEPTH_LIMIT {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::String(value) => valid_parameter_string(value),
        Value::Array(values) => {
            *entries = entries.saturating_add(values.len());
            *entries <= NOTIFICATION_PARAMETER_ENTRIES_LIMIT
                && values
                    .iter()
                    .all(|value| valid_parameter_value(value, depth + 1, entries))
        }
        Value::Object(values) => {
            *entries = entries.saturating_add(values.len());
            *entries <= NOTIFICATION_PARAMETER_ENTRIES_LIMIT
                && values.iter().all(|(key, value)| {
                    valid_parameter_key(key) && valid_parameter_value(value, depth + 1, entries)
                })
        }
    }
}

fn valid_parameter_key(key: &str) -> bool {
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

fn valid_parameter_string(value: &str) -> bool {
    if value.is_empty() || value.len() > NOTIFICATION_PARAMETER_STRING_LIMIT {
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
    use serde_json::json;

    use super::*;

    fn publication(key: &str, value: u64) -> NotificationPublication {
        NotificationPublication {
            dedupe_key: key.into(),
            notification_type: "test.notification".into(),
            params: json!({ "value": value }),
            replaces: Vec::new(),
            resolved: false,
            severity: NotificationSeverity::Info,
        }
    }

    #[test]
    fn publish_updates_stable_identity_and_monotonic_revision() {
        let center = NotificationCenter::new();
        let mut first_publication = publication("same", 1);
        first_publication.params = json!({ "camelCase": true, "value": 1 });
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
    fn read_and_resolution_publish_to_all_clients_without_deleting_history() {
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
            NotificationSeverity::Success
        );
        assert_eq!(first.try_recv().unwrap(), resolved);
        assert_eq!(second.try_recv().unwrap(), resolved);
        assert_eq!(
            center.snapshot().notifications[0].id,
            published.notifications[0].id
        );
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
    fn rejects_oversized_nested_and_sensitive_parameters() {
        let center = NotificationCenter::new();
        let mut oversized = publication("oversized", 1);
        oversized.params = json!({ "value": "x".repeat(NOTIFICATION_PARAMETER_STRING_LIMIT + 1) });
        assert_eq!(
            center.publish(oversized),
            Err(NotificationValidationError::InvalidParameters)
        );

        let mut nested = publication("nested", 1);
        nested.params = json!({ "a": { "b": { "c": { "d": true } } } });
        assert_eq!(
            center.publish(nested),
            Err(NotificationValidationError::InvalidParameters)
        );

        let mut sensitive = publication("sensitive", 1);
        sensitive.params = json!({ "errorMessage": "raw Mihomo failure" });
        assert_eq!(
            center.publish(sensitive),
            Err(NotificationValidationError::InvalidParameters)
        );

        let mut scalar = publication("scalar", 1);
        scalar.params = json!("not-an-object");
        assert_eq!(
            center.publish(scalar),
            Err(NotificationValidationError::InvalidParameters)
        );

        let mut token_like = publication("token-like", 1);
        token_like.params = json!({ "value": "a".repeat(64) });
        assert_eq!(
            center.publish(token_like),
            Err(NotificationValidationError::InvalidParameters)
        );
    }
}
