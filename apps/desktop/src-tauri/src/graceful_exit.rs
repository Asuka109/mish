use std::sync::{
    Mutex,
    atomic::{AtomicU8, Ordering},
};

use mish_bridge::BridgeShutdownFailure;

const IDLE: u8 = 0;
const PENDING: u8 = 1;
const FAILED: u8 = 2;
const EXIT_AUTHORIZED: u8 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GracefulExitRequest {
    Started,
    AlreadyPending,
    AlreadyAuthorized,
}

pub(crate) struct GracefulExitCoordinator {
    failure: Mutex<Option<BridgeShutdownFailure>>,
    phase: AtomicU8,
}

impl GracefulExitCoordinator {
    pub(crate) fn new() -> Self {
        Self {
            failure: Mutex::new(None),
            phase: AtomicU8::new(IDLE),
        }
    }

    pub(crate) fn begin(&self) -> GracefulExitRequest {
        loop {
            let phase = self.phase.load(Ordering::Acquire);
            match phase {
                PENDING => return GracefulExitRequest::AlreadyPending,
                EXIT_AUTHORIZED => return GracefulExitRequest::AlreadyAuthorized,
                IDLE | FAILED => {
                    if self
                        .phase
                        .compare_exchange(phase, PENDING, Ordering::AcqRel, Ordering::Acquire)
                        .is_ok()
                    {
                        *self.failure.lock().expect("graceful exit lock poisoned") = None;
                        return GracefulExitRequest::Started;
                    }
                }
                _ => unreachable!("invalid graceful exit phase"),
            }
        }
    }

    pub(crate) fn authorize_exit(&self) {
        self.phase.store(EXIT_AUTHORIZED, Ordering::Release);
    }

    pub(crate) fn record_failure(&self, failure: BridgeShutdownFailure) {
        *self.failure.lock().expect("graceful exit lock poisoned") = Some(failure);
        self.phase.store(FAILED, Ordering::Release);
    }

    pub(crate) fn exit_is_authorized(&self) -> bool {
        self.phase.load(Ordering::Acquire) == EXIT_AUTHORIZED
    }

    #[cfg(test)]
    fn failure(&self) -> Option<BridgeShutdownFailure> {
        *self.failure.lock().expect("graceful exit lock poisoned")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};

    use super::*;

    #[test]
    fn racing_quit_sources_claim_cleanup_once() {
        let coordinator = Arc::new(GracefulExitCoordinator::new());
        let barrier = Arc::new(Barrier::new(4));
        let workers = (0..3)
            .map(|_| {
                let coordinator = coordinator.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    coordinator.begin()
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(
            results
                .iter()
                .filter(|result| **result == GracefulExitRequest::Started)
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == GracefulExitRequest::AlreadyPending)
                .count(),
            2
        );
    }

    #[test]
    fn final_exit_requires_confirmed_cleanup() {
        let coordinator = GracefulExitCoordinator::new();
        assert_eq!(coordinator.begin(), GracefulExitRequest::Started);
        assert!(!coordinator.exit_is_authorized());

        coordinator.authorize_exit();

        assert!(coordinator.exit_is_authorized());
        assert_eq!(coordinator.begin(), GracefulExitRequest::AlreadyAuthorized);
    }

    #[test]
    fn failure_remains_actionable_and_can_be_retried() {
        let failures = [
            BridgeShutdownFailure::AuditJoin,
            BridgeShutdownFailure::ProfileBackgroundTask,
            BridgeShutdownFailure::ProfileMutationBusy,
            BridgeShutdownFailure::CaptureRestoration,
            BridgeShutdownFailure::CoreStop,
            BridgeShutdownFailure::StateCommit,
            BridgeShutdownFailure::RuntimeCaptureRestoration,
            BridgeShutdownFailure::RuntimeCoreStop,
            BridgeShutdownFailure::RpcServe,
            BridgeShutdownFailure::RpcJoin,
            BridgeShutdownFailure::RpcJoinTimeout,
        ];
        for failure in failures {
            let coordinator = GracefulExitCoordinator::new();
            assert_eq!(coordinator.begin(), GracefulExitRequest::Started);
            coordinator.record_failure(failure);

            assert!(!coordinator.exit_is_authorized());
            assert_eq!(coordinator.failure(), Some(failure));
            assert_eq!(coordinator.begin(), GracefulExitRequest::Started);
        }
    }
}
