//! Shared serialization authority for durable Profile and Settings mutations.

use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};

use thiserror::Error;
use tokio::sync::{Mutex, OwnedMutexGuard};

static NEXT_AUTHORITY_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct StateMutationAuthority {
    id: u64,
    lock: Arc<Mutex<()>>,
    unavailable: Arc<AtomicBool>,
}

pub struct StateMutationPermit {
    authority_id: u64,
    _guard: OwnedMutexGuard<()>,
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum StateMutationError {
    #[error("another Profile or Settings mutation is in progress")]
    Busy,
    #[error("the mutation permit belongs to a different authority")]
    WrongAuthority,
    #[error("the mutation authority is unavailable until startup recovery")]
    Unavailable,
}

impl Default for StateMutationAuthority {
    fn default() -> Self {
        Self::new()
    }
}

impl StateMutationAuthority {
    pub fn new() -> Self {
        Self {
            id: NEXT_AUTHORITY_ID.fetch_add(1, Ordering::Relaxed),
            lock: Arc::new(Mutex::new(())),
            unavailable: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn try_acquire(&self) -> Result<StateMutationPermit, StateMutationError> {
        if self.unavailable.load(Ordering::Acquire) {
            return Err(StateMutationError::Unavailable);
        }
        let guard = self
            .lock
            .clone()
            .try_lock_owned()
            .map_err(|_| StateMutationError::Busy)?;
        Ok(StateMutationPermit {
            authority_id: self.id,
            _guard: guard,
        })
    }

    pub async fn acquire(&self) -> Result<StateMutationPermit, StateMutationError> {
        if self.unavailable.load(Ordering::Acquire) {
            return Err(StateMutationError::Unavailable);
        }
        let guard = self.lock.clone().lock_owned().await;
        if self.unavailable.load(Ordering::Acquire) {
            drop(guard);
            return Err(StateMutationError::Unavailable);
        }
        Ok(StateMutationPermit {
            authority_id: self.id,
            _guard: guard,
        })
    }

    pub fn validate(&self, permit: &StateMutationPermit) -> Result<(), StateMutationError> {
        if permit.authority_id == self.id {
            Ok(())
        } else {
            Err(StateMutationError::WrongAuthority)
        }
    }

    pub fn is_same_authority(&self, other: &Self) -> bool {
        self.id == other.id
    }

    pub fn make_unavailable_until_restart(&self) {
        self.unavailable.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_are_exclusive_and_bound_to_their_authority() {
        let authority = StateMutationAuthority::new();
        let other = StateMutationAuthority::new();
        let permit = authority.try_acquire().unwrap();

        assert!(matches!(
            authority.try_acquire(),
            Err(StateMutationError::Busy)
        ));
        assert_eq!(
            other.validate(&permit).unwrap_err(),
            StateMutationError::WrongAuthority
        );
        drop(permit);
        assert!(authority.try_acquire().is_ok());
    }

    #[tokio::test]
    async fn queued_permits_are_acquired_in_order() {
        let authority = StateMutationAuthority::new();
        let first = authority.acquire().await.unwrap();
        let queued_authority = authority.clone();
        let queued = tokio::spawn(async move { queued_authority.acquire().await.unwrap() });

        assert!(!queued.is_finished());
        drop(first);
        let second = queued.await.unwrap();
        assert!(authority.validate(&second).is_ok());
    }
}
