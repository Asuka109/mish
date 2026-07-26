use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use mish_runtime::{ApplicationSnapshotOrder, EventsSnapshot, StatusSnapshot, TrafficDataSnapshot};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::ManagedProfileSnapshot;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum SnapshotStream {
    Events,
    Profiles,
    Status,
    Traffic,
}

#[derive(Debug)]
struct StreamState {
    latest: Option<(Value, u64)>,
    next_order: u64,
}

#[derive(Debug)]
struct AuthorityState {
    epoch: u64,
    streams: HashMap<SnapshotStream, StreamState>,
}

#[derive(Clone, Debug)]
pub(crate) struct ApplicationSnapshotAuthority {
    authority_id: Arc<str>,
    state: Arc<Mutex<AuthorityState>>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SnapshotTicket {
    epoch: u64,
    order: u64,
    stream: SnapshotStream,
}

impl Default for ApplicationSnapshotAuthority {
    fn default() -> Self {
        Self::new()
    }
}

impl ApplicationSnapshotAuthority {
    pub(crate) fn new() -> Self {
        Self {
            authority_id: Uuid::new_v4().to_string().into(),
            state: Arc::new(Mutex::new(AuthorityState {
                epoch: 1,
                streams: HashMap::new(),
            })),
        }
    }

    pub(crate) fn retire_runtime(&self) {
        let mut state = self.state.lock().expect("snapshot authority poisoned");
        state.epoch = state.epoch.saturating_add(1);
        state.streams.clear();
    }

    pub(crate) fn begin(&self, stream: SnapshotStream) -> SnapshotTicket {
        let mut state = self.state.lock().expect("snapshot authority poisoned");
        let epoch = state.epoch;
        let stream_state = state.streams.entry(stream).or_insert_with(|| StreamState {
            latest: None,
            next_order: 1,
        });
        let order = stream_state.next_order;
        stream_state.next_order = stream_state.next_order.saturating_add(1);
        SnapshotTicket {
            epoch,
            order,
            stream,
        }
    }

    pub(crate) fn stamp_events(&self, ticket: SnapshotTicket, snapshot: &mut EventsSnapshot) {
        snapshot.application_order = ApplicationSnapshotOrder::detached();
        snapshot.application_order = self.stamp(ticket, snapshot);
    }

    pub(crate) fn stamp_profiles(
        &self,
        ticket: SnapshotTicket,
        snapshot: &mut ManagedProfileSnapshot,
    ) {
        snapshot.application_order = ApplicationSnapshotOrder::detached();
        snapshot.application_order = self.stamp(ticket, snapshot);
    }

    pub(crate) fn stamp_status(&self, ticket: SnapshotTicket, snapshot: &mut StatusSnapshot) {
        snapshot.application_order = ApplicationSnapshotOrder::detached();
        snapshot.application_order = self.stamp(ticket, snapshot);
    }

    pub(crate) fn stamp_traffic(&self, ticket: SnapshotTicket, snapshot: &mut TrafficDataSnapshot) {
        snapshot.application_order = ApplicationSnapshotOrder::detached();
        snapshot.application_order = self.stamp(ticket, snapshot);
    }

    fn stamp<T: Serialize>(
        &self,
        ticket: SnapshotTicket,
        snapshot: &T,
    ) -> ApplicationSnapshotOrder {
        let content = serde_json::to_value(snapshot).expect("application snapshot must serialize");
        let mut state = self.state.lock().expect("snapshot authority poisoned");
        let order = if state.epoch == ticket.epoch {
            let stream_state = state
                .streams
                .entry(ticket.stream)
                .or_insert_with(|| StreamState {
                    latest: None,
                    next_order: ticket.order.saturating_add(1),
                });
            match &stream_state.latest {
                Some((previous, order)) if previous == &content => *order,
                Some((_, order)) if *order > ticket.order => ticket.order,
                _ => {
                    stream_state.latest = Some((content, ticket.order));
                    ticket.order
                }
            }
        } else {
            ticket.order
        };
        ApplicationSnapshotOrder {
            authority_id: self.authority_id.to_string(),
            epoch: ticket.epoch,
            order,
        }
    }
}

#[cfg(test)]
mod tests {
    use mish_runtime::{CorePhase, CoreStatus, StatusAdapterKind, StatusSnapshot};

    use super::*;

    #[test]
    fn duplicates_reuse_order_and_replacement_advances_epoch() {
        let authority = ApplicationSnapshotAuthority::new();
        let core = CoreStatus {
            error: None,
            phase: CorePhase::Stopped,
            pid: None,
            version: None,
        };
        let mut first = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        let first_ticket = authority.begin(SnapshotStream::Status);
        let mut duplicate = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        let duplicate_ticket = authority.begin(SnapshotStream::Status);
        authority.stamp_status(duplicate_ticket, &mut duplicate);
        authority.stamp_status(first_ticket, &mut first);
        assert_eq!(duplicate.application_order, first.application_order);

        let mut changed = duplicate.clone();
        changed.active_profile_id = "next".into();
        let changed_ticket = authority.begin(SnapshotStream::Status);
        authority.stamp_status(changed_ticket, &mut changed);
        assert!(changed.application_order.order > first.application_order.order);

        let mut reverted = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        let reverted_ticket = authority.begin(SnapshotStream::Status);
        authority.stamp_status(reverted_ticket, &mut reverted);
        assert!(reverted.application_order.order > changed.application_order.order);

        authority.retire_runtime();
        let mut replacement = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        let replacement_ticket = authority.begin(SnapshotStream::Status);
        authority.stamp_status(replacement_ticket, &mut replacement);
        assert!(replacement.application_order.epoch > reverted.application_order.epoch);
        assert_eq!(replacement.application_order.order, 1);
    }

    #[test]
    fn delayed_ticket_keeps_its_original_order_and_epoch() {
        let authority = ApplicationSnapshotAuthority::new();
        let core = CoreStatus {
            error: None,
            phase: CorePhase::Stopped,
            pid: None,
            version: None,
        };
        let first_ticket = authority.begin(SnapshotStream::Status);
        let second_ticket = authority.begin(SnapshotStream::Status);

        let mut second = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        second.active_profile_id = "second".into();
        authority.stamp_status(second_ticket, &mut second);
        let mut delayed_first = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        authority.stamp_status(first_ticket, &mut delayed_first);
        assert!(second.application_order.order > delayed_first.application_order.order);

        let retired_ticket = authority.begin(SnapshotStream::Status);
        authority.retire_runtime();
        let mut replacement = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        let replacement_ticket = authority.begin(SnapshotStream::Status);
        authority.stamp_status(replacement_ticket, &mut replacement);
        let mut delayed_retired = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        authority.stamp_status(retired_ticket, &mut delayed_retired);
        assert!(replacement.application_order.epoch > delayed_retired.application_order.epoch);
    }
}
