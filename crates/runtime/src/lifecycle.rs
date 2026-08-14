use futures_util::future::BoxFuture;
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformLifecycleEventKind {
    NetworkChanged,
    Sleep,
    Wake,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlatformLifecycleEvent {
    pub kind: PlatformLifecycleEventKind,
    pub sequence: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformSleepState {
    Awake,
    Sleeping,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct PlatformSleepObservation {
    pub sequence: u64,
    pub state: PlatformSleepState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PlatformSleepObservationError {
    Unavailable,
}

pub trait PlatformLifecycleEventSource: Send + Sync {
    fn subscribe(&self) -> broadcast::Receiver<PlatformLifecycleEvent>;
    /// Returns the latest sleep fact retained by the same sequenced platform source.
    /// Implementations must not derive this from a coordinator-local event projection.
    fn observe_sleep_state(
        &self,
    ) -> BoxFuture<'_, Result<PlatformSleepObservation, PlatformSleepObservationError>>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeObservationPauseReason {
    CoreUnavailable,
    LifecycleGap,
    NetworkChanged,
    Sleep,
}
