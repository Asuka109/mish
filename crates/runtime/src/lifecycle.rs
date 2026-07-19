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

pub trait PlatformLifecycleEventSource: Send + Sync {
    fn subscribe(&self) -> broadcast::Receiver<PlatformLifecycleEvent>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeObservationPauseReason {
    CoreUnavailable,
    NetworkChanged,
    Sleep,
}
