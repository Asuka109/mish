use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Instant,
};

use serde::Serialize;
use uuid::Uuid;

pub const RECENT_TRAFFIC_CADENCE_MILLISECONDS: u64 = 1_000;
pub const RECENT_TRAFFIC_WINDOW_MILLISECONDS: u64 = 60_000;
pub const RECENT_TRAFFIC_SAMPLE_LIMIT: usize = 60;

pub trait RecentTrafficClock: Send + Sync {
    fn now_milliseconds(&self) -> u64;
}

#[derive(Debug)]
pub struct SystemRecentTrafficClock {
    started_at: Instant,
}

impl SystemRecentTrafficClock {
    pub fn new() -> Self {
        Self {
            started_at: Instant::now(),
        }
    }
}

impl Default for SystemRecentTrafficClock {
    fn default() -> Self {
        Self::new()
    }
}

impl RecentTrafficClock for SystemRecentTrafficClock {
    fn now_milliseconds(&self) -> u64 {
        u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecentTrafficPhase {
    Idle,
    Active,
    Suspended,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentTrafficSample {
    pub sequence: u64,
    pub offset_milliseconds: u64,
    pub download_bytes_per_second: u64,
    pub upload_bytes_per_second: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentTrafficSnapshot {
    pub authority_id: String,
    pub revision: u64,
    pub phase: RecentTrafficPhase,
    pub session_id: Option<String>,
    pub profile_id: Option<String>,
    pub cadence_milliseconds: u64,
    pub window_milliseconds: u64,
    pub downloaded_bytes: u64,
    pub uploaded_bytes: u64,
    pub download_bytes_per_second: u64,
    pub upload_bytes_per_second: u64,
    pub samples: Vec<RecentTrafficSample>,
}

impl RecentTrafficSnapshot {
    fn idle(authority_id: String) -> Self {
        Self {
            authority_id,
            revision: 0,
            phase: RecentTrafficPhase::Idle,
            session_id: None,
            profile_id: None,
            cadence_milliseconds: RECENT_TRAFFIC_CADENCE_MILLISECONDS,
            window_milliseconds: RECENT_TRAFFIC_WINDOW_MILLISECONDS,
            downloaded_bytes: 0,
            uploaded_bytes: 0,
            download_bytes_per_second: 0,
            upload_bytes_per_second: 0,
            samples: Vec::new(),
        }
    }

    pub(crate) fn detached() -> Self {
        Self::idle("detached-status-source".into())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecentTrafficObservation {
    pub source_generation: u64,
    pub source_sequence: u64,
    pub profile_id: String,
    pub downloaded_bytes: u64,
    pub uploaded_bytes: u64,
    pub download_bytes_per_second: u64,
    pub upload_bytes_per_second: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecentTrafficContinuity {
    Continue,
    Discontinue,
}

#[derive(Clone)]
pub struct RecentTraffic {
    clock: Arc<dyn RecentTrafficClock>,
    state: Arc<Mutex<RecentTrafficState>>,
}

struct RecentTrafficState {
    snapshot: RecentTrafficSnapshot,
    next_session_number: u64,
    session_started_at: u64,
    last_now: u64,
    source_generation: Option<u64>,
    source_sequence: u64,
    generation_baseline_downloaded: u64,
    generation_baseline_uploaded: u64,
    generation_offset_downloaded: u64,
    generation_offset_uploaded: u64,
    pending_sample: Option<PendingSample>,
    samples: VecDeque<RecentTrafficSample>,
    next_sample_sequence: u64,
}

#[derive(Clone, Copy)]
struct PendingSample {
    slot: u64,
    offset_milliseconds: u64,
    download_bytes_per_second: u64,
    upload_bytes_per_second: u64,
}

impl RecentTraffic {
    pub fn new() -> Self {
        Self::with_authority_and_clock(
            Uuid::new_v4().to_string(),
            Arc::new(SystemRecentTrafficClock::new()),
        )
    }

    pub fn with_authority_and_clock(
        authority_id: impl Into<String>,
        clock: Arc<dyn RecentTrafficClock>,
    ) -> Self {
        let snapshot = RecentTrafficSnapshot::idle(authority_id.into());
        Self {
            clock,
            state: Arc::new(Mutex::new(RecentTrafficState {
                snapshot,
                next_session_number: 0,
                session_started_at: 0,
                last_now: 0,
                source_generation: None,
                source_sequence: 0,
                generation_baseline_downloaded: 0,
                generation_baseline_uploaded: 0,
                generation_offset_downloaded: 0,
                generation_offset_uploaded: 0,
                pending_sample: None,
                samples: VecDeque::with_capacity(RECENT_TRAFFIC_SAMPLE_LIMIT),
                next_sample_sequence: 1,
            })),
        }
    }

    pub fn snapshot(&self) -> RecentTrafficSnapshot {
        self.state
            .lock()
            .expect("recent Traffic state poisoned")
            .snapshot
            .clone()
    }

    pub fn capture_applied(
        &self,
        profile_id: &str,
        observation: Option<RecentTrafficObservation>,
    ) -> RecentTrafficSnapshot {
        let now = self.now();
        let mut state = self.state.lock().expect("recent Traffic state poisoned");
        let same_profile = state.snapshot.profile_id.as_deref() == Some(profile_id);
        if state.snapshot.phase == RecentTrafficPhase::Idle || !same_profile {
            state.start_session(profile_id, now);
        } else if state.snapshot.phase == RecentTrafficPhase::Suspended {
            state.snapshot.phase = RecentTrafficPhase::Active;
            state.snapshot.download_bytes_per_second = 0;
            state.snapshot.upload_bytes_per_second = 0;
            state.reset_source_generation();
            state.advance_revision();
        }
        if let Some(observation) = observation {
            state.observe(observation, now);
        }
        state.snapshot.clone()
    }

    pub fn observe(&self, observation: RecentTrafficObservation) -> RecentTrafficSnapshot {
        let now = self.now();
        let mut state = self.state.lock().expect("recent Traffic state poisoned");
        state.observe(observation, now);
        state.snapshot.clone()
    }

    pub fn suspend(&self) -> RecentTrafficSnapshot {
        let mut state = self.state.lock().expect("recent Traffic state poisoned");
        if state.snapshot.phase == RecentTrafficPhase::Active {
            state.snapshot.phase = RecentTrafficPhase::Suspended;
            state.snapshot.download_bytes_per_second = 0;
            state.snapshot.upload_bytes_per_second = 0;
            state.pending_sample = None;
            state.advance_revision();
        }
        state.snapshot.clone()
    }

    pub fn resume(
        &self,
        continuity: RecentTrafficContinuity,
        profile_id: Option<&str>,
        observation: Option<RecentTrafficObservation>,
    ) -> RecentTrafficSnapshot {
        if continuity == RecentTrafficContinuity::Discontinue {
            return self.stop();
        }
        let Some(profile_id) = profile_id else {
            return self.snapshot();
        };
        self.capture_applied(profile_id, observation)
    }

    pub fn stop(&self) -> RecentTrafficSnapshot {
        let mut state = self.state.lock().expect("recent Traffic state poisoned");
        if state.snapshot.phase == RecentTrafficPhase::Idle {
            return state.snapshot.clone();
        }
        state.reset_idle();
        state.snapshot.clone()
    }

    fn now(&self) -> u64 {
        self.clock.now_milliseconds()
    }
}

impl Default for RecentTraffic {
    fn default() -> Self {
        Self::new()
    }
}

impl RecentTrafficState {
    fn start_session(&mut self, profile_id: &str, now: u64) {
        let now = now.max(self.last_now);
        self.last_now = now;
        self.next_session_number = self.next_session_number.saturating_add(1);
        self.session_started_at = now;
        self.snapshot.phase = RecentTrafficPhase::Active;
        self.snapshot.session_id = Some(format!(
            "{}-session-{}",
            self.snapshot.authority_id, self.next_session_number
        ));
        self.snapshot.profile_id = Some(profile_id.to_owned());
        self.snapshot.downloaded_bytes = 0;
        self.snapshot.uploaded_bytes = 0;
        self.snapshot.download_bytes_per_second = 0;
        self.snapshot.upload_bytes_per_second = 0;
        self.samples.clear();
        self.snapshot.samples.clear();
        self.next_sample_sequence = 1;
        self.reset_source_generation();
        self.advance_revision();
    }

    fn reset_idle(&mut self) {
        self.snapshot.phase = RecentTrafficPhase::Idle;
        self.snapshot.session_id = None;
        self.snapshot.profile_id = None;
        self.snapshot.downloaded_bytes = 0;
        self.snapshot.uploaded_bytes = 0;
        self.snapshot.download_bytes_per_second = 0;
        self.snapshot.upload_bytes_per_second = 0;
        self.samples.clear();
        self.snapshot.samples.clear();
        self.next_sample_sequence = 1;
        self.reset_source_generation();
        self.advance_revision();
    }

    fn reset_source_generation(&mut self) {
        self.source_generation = None;
        self.source_sequence = 0;
        self.generation_baseline_downloaded = 0;
        self.generation_baseline_uploaded = 0;
        self.generation_offset_downloaded = self.snapshot.downloaded_bytes;
        self.generation_offset_uploaded = self.snapshot.uploaded_bytes;
        self.pending_sample = None;
    }

    fn observe(&mut self, observation: RecentTrafficObservation, now: u64) {
        if self.snapshot.phase != RecentTrafficPhase::Active
            || self.snapshot.profile_id.as_deref() != Some(observation.profile_id.as_str())
        {
            return;
        }
        if self.source_generation.is_some_and(|generation| {
            observation.source_generation < generation
                || (observation.source_generation == generation
                    && observation.source_sequence <= self.source_sequence)
        }) {
            return;
        }

        let now = now.max(self.last_now);
        self.last_now = now;
        let generation_changed = self.source_generation != Some(observation.source_generation);
        let counters_decreased = !generation_changed
            && (observation.downloaded_bytes < self.generation_baseline_downloaded
                || observation.uploaded_bytes < self.generation_baseline_uploaded
                || observation.downloaded_bytes
                    < self.generation_baseline_downloaded.saturating_add(
                        self.snapshot
                            .downloaded_bytes
                            .saturating_sub(self.generation_offset_downloaded),
                    )
                || observation.uploaded_bytes
                    < self.generation_baseline_uploaded.saturating_add(
                        self.snapshot
                            .uploaded_bytes
                            .saturating_sub(self.generation_offset_uploaded),
                    ));
        let baseline_reset = generation_changed || counters_decreased;
        if baseline_reset {
            self.generation_offset_downloaded = self.snapshot.downloaded_bytes;
            self.generation_offset_uploaded = self.snapshot.uploaded_bytes;
            self.generation_baseline_downloaded = observation.downloaded_bytes;
            self.generation_baseline_uploaded = observation.uploaded_bytes;
            self.pending_sample = None;
        }
        self.source_generation = Some(observation.source_generation);
        self.source_sequence = observation.source_sequence;

        let next_downloaded = self.generation_offset_downloaded.saturating_add(
            observation
                .downloaded_bytes
                .saturating_sub(self.generation_baseline_downloaded),
        );
        let next_uploaded = self.generation_offset_uploaded.saturating_add(
            observation
                .uploaded_bytes
                .saturating_sub(self.generation_baseline_uploaded),
        );
        let offset = now.saturating_sub(self.session_started_at);
        let slot = offset / RECENT_TRAFFIC_CADENCE_MILLISECONDS;
        let mut changed = false;
        if let Some(pending) = self.pending_sample
            && pending.slot < slot
        {
            self.commit_sample(pending);
            changed = true;
        }
        if !baseline_reset {
            self.pending_sample = Some(PendingSample {
                slot,
                offset_milliseconds: slot.saturating_mul(RECENT_TRAFFIC_CADENCE_MILLISECONDS),
                download_bytes_per_second: observation.download_bytes_per_second,
                upload_bytes_per_second: observation.upload_bytes_per_second,
            });
        }
        if next_downloaded > self.snapshot.downloaded_bytes {
            self.snapshot.downloaded_bytes = next_downloaded;
            changed = true;
        }
        if next_uploaded > self.snapshot.uploaded_bytes {
            self.snapshot.uploaded_bytes = next_uploaded;
            changed = true;
        }
        if self.snapshot.download_bytes_per_second != observation.download_bytes_per_second {
            self.snapshot.download_bytes_per_second = observation.download_bytes_per_second;
            changed = true;
        }
        if self.snapshot.upload_bytes_per_second != observation.upload_bytes_per_second {
            self.snapshot.upload_bytes_per_second = observation.upload_bytes_per_second;
            changed = true;
        }
        if changed {
            self.advance_revision();
        }
    }

    fn commit_sample(&mut self, pending: PendingSample) {
        self.samples.push_back(RecentTrafficSample {
            sequence: self.next_sample_sequence,
            offset_milliseconds: pending.offset_milliseconds,
            download_bytes_per_second: pending.download_bytes_per_second,
            upload_bytes_per_second: pending.upload_bytes_per_second,
        });
        self.next_sample_sequence = self.next_sample_sequence.saturating_add(1);
        while self.samples.len() > RECENT_TRAFFIC_SAMPLE_LIMIT {
            self.samples.pop_front();
        }
        while self.samples.front().is_some_and(|sample| {
            pending
                .offset_milliseconds
                .saturating_sub(sample.offset_milliseconds)
                >= RECENT_TRAFFIC_WINDOW_MILLISECONDS
        }) {
            self.samples.pop_front();
        }
        self.snapshot.samples = self.samples.iter().cloned().collect();
    }

    fn advance_revision(&mut self) {
        self.snapshot.revision = self.snapshot.revision.saturating_add(1);
    }
}

impl PartialEq for PendingSample {
    fn eq(&self, other: &Self) -> bool {
        self.slot == other.slot
            && self.offset_milliseconds == other.offset_milliseconds
            && self.download_bytes_per_second == other.download_bytes_per_second
            && self.upload_bytes_per_second == other.upload_bytes_per_second
    }
}

impl Eq for PendingSample {}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    };

    use super::*;

    #[derive(Default)]
    struct ManualClock(AtomicU64);

    impl ManualClock {
        fn set(&self, milliseconds: u64) {
            self.0.store(milliseconds, Ordering::Release);
        }
    }

    impl RecentTrafficClock for ManualClock {
        fn now_milliseconds(&self) -> u64 {
            self.0.load(Ordering::Acquire)
        }
    }

    fn module(authority: &str) -> (RecentTraffic, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::default());
        (
            RecentTraffic::with_authority_and_clock(authority, clock.clone()),
            clock,
        )
    }

    fn observation(
        generation: u64,
        sequence: u64,
        downloaded: u64,
        uploaded: u64,
        down_rate: u64,
        up_rate: u64,
    ) -> RecentTrafficObservation {
        RecentTrafficObservation {
            source_generation: generation,
            source_sequence: sequence,
            profile_id: "profile-a".into(),
            downloaded_bytes: downloaded,
            uploaded_bytes: uploaded,
            download_bytes_per_second: down_rate,
            upload_bytes_per_second: up_rate,
        }
    }

    #[test]
    fn cadence_uses_latest_observation_per_slot_and_preserves_gaps() {
        let (recent, clock) = module("process-a");
        recent.capture_applied("profile-a", Some(observation(1, 1, 100, 200, 1, 2)));

        clock.set(1_100);
        recent.observe(observation(1, 2, 110, 220, 10, 20));
        clock.set(1_900);
        recent.observe(observation(1, 3, 120, 240, 12, 24));
        assert!(recent.snapshot().samples.is_empty());

        clock.set(3_100);
        recent.observe(observation(1, 4, 130, 260, 13, 26));
        clock.set(4_100);
        let snapshot = recent.observe(observation(1, 5, 140, 280, 14, 28));

        assert_eq!(
            snapshot.samples,
            vec![
                RecentTrafficSample {
                    sequence: 1,
                    offset_milliseconds: 1_000,
                    download_bytes_per_second: 12,
                    upload_bytes_per_second: 24,
                },
                RecentTrafficSample {
                    sequence: 2,
                    offset_milliseconds: 3_000,
                    download_bytes_per_second: 13,
                    upload_bytes_per_second: 26,
                },
            ]
        );
    }

    #[test]
    fn duplicate_and_out_of_order_observations_do_not_advance_revision() {
        let (recent, clock) = module("process-a");
        recent.capture_applied("profile-a", Some(observation(2, 10, 100, 200, 1, 2)));
        clock.set(1_100);
        let accepted = recent.observe(observation(2, 11, 110, 220, 10, 20));
        let duplicate = recent.observe(observation(2, 11, 999, 999, 99, 99));
        let old_generation = recent.observe(observation(1, 999, 999, 999, 99, 99));

        assert_eq!(duplicate, accepted);
        assert_eq!(old_generation, accepted);
    }

    #[test]
    fn counter_decrease_and_new_generation_preserve_saturating_monotonic_totals() {
        let (recent, _) = module("process-a");
        recent.capture_applied(
            "profile-a",
            Some(observation(1, 1, u64::MAX - 20, u64::MAX - 20, 1, 1)),
        );
        let before_reset = recent.observe(observation(1, 2, u64::MAX - 10, u64::MAX - 5, 2, 2));
        assert_eq!(before_reset.downloaded_bytes, 10);
        assert_eq!(before_reset.uploaded_bytes, 15);

        let decreased = recent.observe(observation(1, 3, 5, 4, 3, 3));
        assert_eq!(decreased.downloaded_bytes, 10);
        assert_eq!(decreased.uploaded_bytes, 15);
        let saturated = recent.observe(observation(1, 4, u64::MAX, u64::MAX, 4, 4));
        assert_eq!(saturated.downloaded_bytes, u64::MAX);
        assert_eq!(saturated.uploaded_bytes, u64::MAX);
        let next_generation = recent.observe(observation(2, 1, 100, 100, 4, 4));
        assert_eq!(next_generation.downloaded_bytes, u64::MAX);
        assert_eq!(next_generation.uploaded_bytes, u64::MAX);
    }

    #[test]
    fn retention_is_bounded_by_sample_count_and_sixty_second_window() {
        let (recent, clock) = module("process-a");
        recent.capture_applied("profile-a", Some(observation(1, 1, 0, 0, 0, 0)));
        for sequence in 2..=63 {
            let offset = (sequence - 1) * 1_000;
            clock.set(offset);
            recent.observe(observation(1, sequence, offset, offset, sequence, sequence));
        }
        let snapshot = recent.snapshot();
        assert_eq!(snapshot.samples.len(), RECENT_TRAFFIC_SAMPLE_LIMIT);
        assert_eq!(
            snapshot
                .samples
                .first()
                .map(|sample| sample.offset_milliseconds),
            Some(2_000)
        );
        assert_eq!(
            snapshot
                .samples
                .last()
                .map(|sample| sample.offset_milliseconds),
            Some(61_000)
        );
        assert_eq!(
            snapshot.samples.first().map(|sample| sample.sequence),
            Some(2)
        );
        assert_eq!(
            snapshot.samples.last().map(|sample| sample.sequence),
            Some(61)
        );
    }

    #[test]
    fn explicit_stop_is_an_idle_barrier_and_restart_creates_a_new_session() {
        let (recent, _) = module("process-a");
        let first = recent.capture_applied("profile-a", Some(observation(1, 1, 100, 200, 1, 2)));
        let idle = recent.stop();
        let second = recent.capture_applied("profile-a", Some(observation(1, 2, 120, 240, 3, 4)));

        assert_eq!(idle.phase, RecentTrafficPhase::Idle);
        assert_eq!(idle.session_id, None);
        assert!(idle.samples.is_empty());
        assert_ne!(first.session_id, second.session_id);
        assert!(first.revision < idle.revision && idle.revision < second.revision);
    }

    #[test]
    fn one_mode_continuation_and_suspend_resume_keep_session_and_sequence() {
        let (recent, clock) = module("process-a");
        let started = recent.capture_applied("profile-a", Some(observation(1, 1, 100, 200, 1, 2)));
        clock.set(1_100);
        recent.observe(observation(1, 2, 110, 220, 10, 20));
        let continued = recent.capture_applied("profile-a", None);
        assert_eq!(continued.session_id, started.session_id);

        let suspended = recent.suspend();
        assert_eq!(suspended.phase, RecentTrafficPhase::Suspended);
        assert_eq!(suspended.download_bytes_per_second, 0);
        let ignored = recent.observe(observation(1, 3, 999, 999, 99, 99));
        assert_eq!(ignored, suspended);
        let resumed = recent.resume(
            RecentTrafficContinuity::Continue,
            Some("profile-a"),
            Some(observation(2, 1, 5, 5, 3, 4)),
        );
        assert_eq!(resumed.session_id, started.session_id);
        assert_eq!(resumed.phase, RecentTrafficPhase::Active);
        assert_eq!(resumed.downloaded_bytes, 10);
    }

    #[test]
    fn discontinuity_and_profile_replacement_end_the_old_session() {
        let (recent, _) = module("process-a");
        let started = recent.capture_applied("profile-a", Some(observation(1, 1, 100, 200, 1, 2)));
        recent.suspend();
        let idle = recent.resume(RecentTrafficContinuity::Discontinue, None, None);
        assert_eq!(idle.phase, RecentTrafficPhase::Idle);

        let restarted = recent.capture_applied("profile-a", Some(observation(2, 1, 0, 0, 1, 1)));
        let replacement = recent.capture_applied("profile-b", None);
        assert_ne!(started.session_id, restarted.session_id);
        assert_ne!(restarted.session_id, replacement.session_id);
        assert_eq!(replacement.profile_id.as_deref(), Some("profile-b"));
        assert_eq!(replacement.downloaded_bytes, 0);
    }

    #[test]
    fn process_restart_has_new_authority_and_no_persisted_session() {
        let (first, _) = module("process-a");
        first.capture_applied("profile-a", Some(observation(1, 1, 100, 200, 1, 2)));
        let (restarted, _) = module("process-b");
        let snapshot = restarted.snapshot();

        assert_eq!(snapshot.authority_id, "process-b");
        assert_ne!(snapshot.authority_id, first.snapshot().authority_id);
        assert_eq!(snapshot.revision, 0);
        assert_eq!(snapshot.phase, RecentTrafficPhase::Idle);
    }
}
