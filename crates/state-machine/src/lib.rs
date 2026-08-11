//! Repository-owned execution kernel for failure-sensitive internal lifecycles.
//!
//! Product machines keep their own data-bearing state, input, effect, projection,
//! and error vocabularies. This crate owns only bounded admission, effect
//! correlation and task ownership, finalization, and stale retirement.

use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use tokio::{
    sync::{mpsc, oneshot},
    task::{Id as TaskId, JoinHandle, JoinSet},
    time::{Instant, timeout},
};
use tokio_util::sync::CancellationToken;

pub const DEFAULT_INBOX_CAPACITY: usize = 32;
pub const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
pub const DEFAULT_FINALIZER_GRACE: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct Correlation {
    pub machine_authority: String,
    pub scope_epoch: u64,
    pub operation_id: String,
    pub admitted_revision: u64,
    pub effect_id: u64,
}

impl Correlation {
    pub fn same_operation(&self, other: &Self) -> bool {
        self.machine_authority == other.machine_authority
            && self.scope_epoch == other.scope_epoch
            && self.operation_id == other.operation_id
            && self.admitted_revision == other.admitted_revision
    }

    pub fn with_effect(&self, effect_id: u64) -> Self {
        let mut correlation = self.clone();
        correlation.effect_id = effect_id;
        correlation
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EffectMode {
    Spawn,
    Cancel,
}

pub trait CorrelatedEffect {
    fn correlation(&self) -> &Correlation;

    fn mode(&self) -> EffectMode {
        EffectMode::Spawn
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskFailure {
    Aborted,
    CompletionConflict,
    Panicked,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Disposition {
    Accepted,
    Rejected,
    Unchanged,
    EffectEmitting,
    Committed,
    Cancelled,
    Failed,
    Retired,
    RecoveryRequired,
}

impl Disposition {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::Unchanged => "unchanged",
            Self::EffectEmitting => "effect-emitting",
            Self::Committed => "committed",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
            Self::Retired => "retired",
            Self::RecoveryRequired => "recovery-required",
        }
    }
}

#[derive(Debug)]
pub struct EffectBatch<E> {
    first: E,
    rest: Vec<E>,
}

impl<E> EffectBatch<E> {
    pub fn one(effect: E) -> Self {
        Self {
            first: effect,
            rest: Vec::new(),
        }
    }

    pub fn from_first(first: E, rest: Vec<E>) -> Self {
        Self { first, rest }
    }

    fn into_iter(self) -> impl Iterator<Item = E> {
        std::iter::once(self.first).chain(self.rest)
    }
}

#[derive(Debug)]
pub enum Transition<S, E, Error> {
    Accepted(S),
    Rejected(Error),
    Unchanged,
    EffectEmitting { state: S, effects: EffectBatch<E> },
    Committed(S),
    Cancelled(S),
    Failed(S),
    Retired,
    RecoveryRequired(S),
}

impl<S, E, Error> Transition<S, E, Error> {
    pub const fn disposition(&self) -> Disposition {
        match self {
            Self::Accepted(_) => Disposition::Accepted,
            Self::Rejected(_) => Disposition::Rejected,
            Self::Unchanged => Disposition::Unchanged,
            Self::EffectEmitting { .. } => Disposition::EffectEmitting,
            Self::Committed(_) => Disposition::Committed,
            Self::Cancelled(_) => Disposition::Cancelled,
            Self::Failed(_) => Disposition::Failed,
            Self::Retired => Disposition::Retired,
            Self::RecoveryRequired(_) => Disposition::RecoveryRequired,
        }
    }
}

pub trait Machine: Send + Sync + 'static {
    type State: Clone + Send + Sync + 'static;
    type Input: Send + 'static;
    type Effect: CorrelatedEffect + Send + 'static;
    type Error: Clone + Send + Sync + 'static;

    fn reduce(
        &self,
        state: &Self::State,
        input: &Self::Input,
    ) -> Transition<Self::State, Self::Effect, Self::Error>;

    fn input_correlation(&self, state: &Self::State, input: &Self::Input) -> Option<Correlation>;
    /// Returns whether an effect owned by the runner may still complete for the current state.
    /// Implementations must reject replaced operations and superseded effect stages even when
    /// the supplied correlation is otherwise well formed.
    fn effect_is_current(&self, state: &Self::State, correlation: &Correlation) -> bool;
    fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input;
    fn shutdown(&self) -> Self::Input;
    fn unavailable(&self) -> Self::Error;
}

pub trait EffectExecutor<M: Machine>: Send + Sync + 'static {
    fn execute(
        &self,
        effect: M::Effect,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = M::Input> + Send + 'static>>;
}

pub trait TransitionObserver<M: Machine>: Send + Sync + 'static {
    fn transitioned(
        &self,
        previous: &M::State,
        input: &M::Input,
        current: &M::State,
        disposition: Disposition,
    );
}

pub struct NoopObserver;

impl<M: Machine> TransitionObserver<M> for NoopObserver {
    fn transitioned(
        &self,
        _previous: &M::State,
        _input: &M::Input,
        _current: &M::State,
        _disposition: Disposition,
    ) {
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Admission<S> {
    pub state: S,
    pub disposition: Disposition,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdmissionError<Error> {
    Rejected(Error),
    InboxSaturated,
    Retired,
}

impl<Error> AdmissionError<Error> {
    fn into_unavailable(self, unavailable: Error) -> Error {
        match self {
            Self::Rejected(error) => error,
            Self::InboxSaturated | Self::Retired => unavailable,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActorFailure {
    Cancelled,
    Panicked,
    RetiredBeforeReply,
}

/// The bounded reason why the runner had to stop waiting for owned work.
///
/// A forced retirement is not a successful cleanup. The final snapshot remains
/// useful evidence, but callers must treat the terminal reason as authoritative
/// and reconcile any external effect before admitting a successor operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ForcedRetirementReason {
    ShutdownDeadlineExceeded,
    FinalizerDeadlineExceeded,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RetirementTerminal<Error> {
    Applied,
    AlreadyRetired,
    ShutdownRejected(Error),
    CleanupFailed(Disposition),
    Forced(ForcedRetirementReason),
    ActorFailed(ActorFailure),
}

#[derive(Clone, Debug)]
pub struct Retirement<S, Error> {
    pub state: S,
    pub disposition: Disposition,
    pub terminal: RetirementTerminal<Error>,
}

#[derive(Clone, Copy, Debug)]
pub struct RunnerConfig {
    pub inbox_capacity: usize,
    pub shutdown_grace: Duration,
    /// The bounded window in which task-failure finalizers may complete after
    /// the normal shutdown deadline forces the owned tasks to abort.
    pub finalizer_grace: Duration,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            inbox_capacity: DEFAULT_INBOX_CAPACITY,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
            finalizer_grace: DEFAULT_FINALIZER_GRACE,
        }
    }
}

struct ShutdownReply<M: Machine> {
    result: Result<Admission<M::State>, M::Error>,
    drain: DrainOutcome,
}

enum Command<M: Machine> {
    Admit {
        input: M::Input,
        reply: oneshot::Sender<Result<Admission<M::State>, M::Error>>,
    },
}

struct OwnedEffect {
    cancellation: CancellationToken,
    correlation: Correlation,
    role: EffectRole,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EffectRole {
    Operation,
    Finalizer,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DrainTerminal {
    Completed,
    Forced(ForcedRetirementReason),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DrainOutcome {
    terminal: DrainTerminal,
    last_disposition: Option<Disposition>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct EffectSettlement {
    disposition: Disposition,
}

struct Shared<M: Machine> {
    actor: Mutex<Option<JoinHandle<()>>>,
    closed: AtomicBool,
    unavailable: M::Error,
    sender: mpsc::Sender<Command<M>>,
    retirement_reply: Arc<Mutex<Option<oneshot::Sender<ShutdownReply<M>>>>>,
    shutdown: CancellationToken,
    state: Arc<Mutex<M::State>>,
}

struct ShutdownReplyGuard<M: Machine> {
    retirement_reply: Arc<Mutex<Option<oneshot::Sender<ShutdownReply<M>>>>>,
}

impl<M: Machine> Drop for ShutdownReplyGuard<M> {
    fn drop(&mut self) {
        // An actor panic or process-style abort must release a waiting shutdown
        // caller instead of leaving its reply channel alive in Shared forever.
        let _ = self
            .retirement_reply
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
}

pub struct RunnerHandle<M: Machine> {
    shared: Arc<Shared<M>>,
}

impl<M: Machine> Clone for RunnerHandle<M> {
    fn clone(&self) -> Self {
        Self {
            shared: self.shared.clone(),
        }
    }
}

impl<M: Machine> RunnerHandle<M> {
    pub async fn admit(&self, input: M::Input) -> Result<Admission<M::State>, M::Error> {
        self.try_admit(input)
            .await
            .map_err(|error| error.into_unavailable(self.shared.unavailable.clone()))
    }

    pub async fn try_admit(
        &self,
        input: M::Input,
    ) -> Result<Admission<M::State>, AdmissionError<M::Error>> {
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(AdmissionError::Retired);
        }
        let (reply, response) = oneshot::channel();
        match self.shared.sender.try_send(Command::Admit { input, reply }) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                return Err(AdmissionError::InboxSaturated);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(AdmissionError::Retired);
            }
        }
        response
            .await
            .map_err(|_| AdmissionError::Retired)?
            .map_err(AdmissionError::Rejected)
    }

    pub async fn shutdown(&self) -> Retirement<M::State, M::Error> {
        if self.shared.closed.swap(true, Ordering::AcqRel) {
            return Retirement {
                state: self.snapshot_unpoisoned(),
                disposition: Disposition::Unchanged,
                terminal: RetirementTerminal::AlreadyRetired,
            };
        }
        let (reply, response) = oneshot::channel();
        *self
            .shared
            .retirement_reply
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(reply);
        // Shutdown is out-of-band from the bounded admission inbox. This keeps
        // retirement from waiting behind ordinary commands and makes the
        // kernel's deadline the only owner of in-flight cleanup.
        self.shared.shutdown.cancel();
        let actor_finished = self
            .shared
            .actor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .is_none_or(JoinHandle::is_finished);
        if actor_finished {
            // The actor may have failed before this shutdown request installed
            // its reply slot. Drop the slot so the caller observes the typed
            // actor failure instead of waiting for a sender owned by a dead
            // task.
            let _ = self
                .shared
                .retirement_reply
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
        }
        let result = response.await;
        let actor_failure = self.join_actor().await.and_then(Result::err).map(|error| {
            if error.is_panic() {
                ActorFailure::Panicked
            } else {
                ActorFailure::Cancelled
            }
        });
        if let Some(failure) = actor_failure {
            return Retirement {
                state: self.snapshot_unpoisoned(),
                disposition: Disposition::Retired,
                terminal: RetirementTerminal::ActorFailed(failure),
            };
        }
        match result {
            Ok(reply) => {
                let disposition = reply
                    .result
                    .as_ref()
                    .map(|admission| admission.disposition)
                    .unwrap_or(Disposition::Rejected);
                let state = reply
                    .result
                    .as_ref()
                    .map(|admission| admission.state.clone())
                    .unwrap_or_else(|_| self.snapshot_unpoisoned());
                let terminal = match reply.drain.terminal {
                    DrainTerminal::Forced(reason) => RetirementTerminal::Forced(reason),
                    DrainTerminal::Completed => match reply.result {
                        Ok(_) => match reply.drain.last_disposition.unwrap_or(disposition) {
                            disposition @ (Disposition::Rejected
                            | Disposition::Failed
                            | Disposition::RecoveryRequired) => {
                                RetirementTerminal::CleanupFailed(disposition)
                            }
                            _ => RetirementTerminal::Applied,
                        },
                        Err(error) => RetirementTerminal::ShutdownRejected(error),
                    },
                };
                Retirement {
                    state,
                    disposition,
                    terminal,
                }
            }
            Err(_) => Retirement {
                state: self.snapshot_unpoisoned(),
                disposition: Disposition::Retired,
                terminal: RetirementTerminal::ActorFailed(ActorFailure::RetiredBeforeReply),
            },
        }
    }

    /// Aborts the actor without running shutdown or owned finalizers.
    ///
    /// This models destruction of the containing process or async runtime. Product owners that
    /// require compensation must use and await [`Self::shutdown`] instead.
    pub fn abort_for_process_termination(&self) {
        if let Some(actor) = self
            .shared
            .actor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            actor.abort();
        }
    }

    async fn join_actor(&self) -> Option<Result<(), tokio::task::JoinError>> {
        let actor = self
            .shared
            .actor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        match actor {
            Some(actor) => Some(actor.await),
            None => None,
        }
    }

    fn snapshot_unpoisoned(&self) -> M::State {
        self.shared
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub fn snapshot(&self) -> M::State {
        self.shared
            .state
            .lock()
            .expect("machine snapshot lock poisoned")
            .clone()
    }
}

impl<M: Machine> Drop for Shared<M> {
    fn drop(&mut self) {
        // The last owner requests the same bounded retirement path as explicit shutdown. Dropping
        // the JoinHandle detaches the actor; aborting it here would bypass domain shutdown and
        // owned effect finalizers for compensation-sensitive machines.
        self.closed.store(true, Ordering::Release);
        self.shutdown.cancel();
        let _ = self
            .actor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
}

pub fn spawn_runner<M>(
    machine: Arc<M>,
    initial: M::State,
    executor: Arc<dyn EffectExecutor<M>>,
    observer: Arc<dyn TransitionObserver<M>>,
    config: RunnerConfig,
) -> RunnerHandle<M>
where
    M: Machine,
{
    assert!(config.inbox_capacity > 0, "machine inbox must be bounded");
    let (sender, receiver) = mpsc::channel(config.inbox_capacity);
    let state = Arc::new(Mutex::new(initial.clone()));
    let shutdown = CancellationToken::new();
    let retirement_reply = Arc::new(Mutex::new(None));
    let unavailable = machine.unavailable();
    let actor = tokio::spawn(run_actor(
        machine,
        initial,
        executor,
        observer,
        receiver,
        state.clone(),
        shutdown.clone(),
        retirement_reply.clone(),
        config,
    ));
    RunnerHandle {
        shared: Arc::new(Shared {
            actor: Mutex::new(Some(actor)),
            closed: AtomicBool::new(false),
            unavailable,
            sender,
            retirement_reply,
            shutdown,
            state,
        }),
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_actor<M: Machine>(
    machine: Arc<M>,
    mut state: M::State,
    executor: Arc<dyn EffectExecutor<M>>,
    observer: Arc<dyn TransitionObserver<M>>,
    mut receiver: mpsc::Receiver<Command<M>>,
    snapshot: Arc<Mutex<M::State>>,
    shutdown: CancellationToken,
    retirement_reply: Arc<Mutex<Option<oneshot::Sender<ShutdownReply<M>>>>>,
    config: RunnerConfig,
) {
    let _reply_guard = ShutdownReplyGuard {
        retirement_reply: retirement_reply.clone(),
    };
    let mut tasks = JoinSet::new();
    let mut owned = HashMap::<TaskId, OwnedEffect>::new();
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => {
                complete_shutdown(
                    machine.as_ref(), &mut state, executor.as_ref(), observer.as_ref(),
                    config, &snapshot, &mut tasks, &mut owned, &retirement_reply,
                ).await;
                return;
            }
            joined = tasks.join_next_with_id(), if !owned.is_empty() => {
                if let Some(joined) = joined {
                    finish_effect(
                        joined, machine.as_ref(), &mut state, executor.as_ref(),
                        observer.as_ref(), false, &snapshot, &mut tasks, &mut owned,
                    );
                    *snapshot.lock().expect("machine snapshot lock poisoned") = state.clone();
                }
            }
            command = receiver.recv() => {
                let Some(command) = command else {
                    complete_shutdown(
                        machine.as_ref(), &mut state, executor.as_ref(), observer.as_ref(),
                        config, &snapshot, &mut tasks, &mut owned, &retirement_reply,
                    ).await;
                    return;
                };
                let Command::Admit { input, reply } = command;
                let result = apply_input(
                    machine.as_ref(), &mut state, input, executor.as_ref(),
                    observer.as_ref(), &snapshot, &mut tasks, &mut owned,
                );
                *snapshot.lock().expect("machine snapshot lock poisoned") = state.clone();
                let _ = reply.send(result);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn complete_shutdown<M: Machine>(
    machine: &M,
    state: &mut M::State,
    executor: &dyn EffectExecutor<M>,
    observer: &dyn TransitionObserver<M>,
    config: RunnerConfig,
    snapshot: &Arc<Mutex<M::State>>,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
    retirement_reply: &Arc<Mutex<Option<oneshot::Sender<ShutdownReply<M>>>>>,
) {
    let shutdown = apply_shutdown(machine, state, executor, observer, snapshot, tasks, owned);
    let drain = drain(
        machine, state, executor, observer, config, snapshot, tasks, owned,
    )
    .await;
    *snapshot.lock().expect("machine snapshot lock poisoned") = state.clone();
    let result = shutdown.map(|admission| Admission {
        state: state.clone(),
        disposition: admission.disposition,
    });
    if let Some(reply) = retirement_reply
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
    {
        let _ = reply.send(ShutdownReply { result, drain });
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_input<M: Machine>(
    machine: &M,
    state: &mut M::State,
    input: M::Input,
    executor: &dyn EffectExecutor<M>,
    observer: &dyn TransitionObserver<M>,
    snapshot: &Arc<Mutex<M::State>>,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
) -> Result<Admission<M::State>, M::Error> {
    apply_input_with_role(
        machine,
        state,
        input,
        executor,
        observer,
        snapshot,
        tasks,
        owned,
        EffectRole::Operation,
    )
}

#[allow(clippy::too_many_arguments)]
fn apply_input_with_role<M: Machine>(
    machine: &M,
    state: &mut M::State,
    input: M::Input,
    executor: &dyn EffectExecutor<M>,
    observer: &dyn TransitionObserver<M>,
    snapshot: &Arc<Mutex<M::State>>,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
    role: EffectRole,
) -> Result<Admission<M::State>, M::Error> {
    let previous = state.clone();
    let transition = machine.reduce(&previous, &input);
    let disposition = transition.disposition();
    let effects = match transition {
        Transition::Accepted(next)
        | Transition::Committed(next)
        | Transition::Cancelled(next)
        | Transition::Failed(next)
        | Transition::RecoveryRequired(next) => {
            *state = next;
            None
        }
        Transition::EffectEmitting {
            state: next,
            effects,
        } => {
            *state = next;
            Some(effects)
        }
        Transition::Rejected(error) => {
            *snapshot.lock().expect("machine snapshot lock poisoned") = state.clone();
            observer.transitioned(&previous, &input, state, disposition);
            return Err(error);
        }
        Transition::Unchanged | Transition::Retired => None,
    };
    // Publish the state before notifying observers. Consumers commonly use an observer signal
    // as the readiness edge for `snapshot()`: reversing this order can strand them on an old
    // pending snapshot with no later notification.
    *snapshot.lock().expect("machine snapshot lock poisoned") = state.clone();
    observer.transitioned(&previous, &input, state, disposition);
    if let Some(effects) = effects {
        for effect in effects.into_iter() {
            let correlation = effect.correlation().clone();
            match effect.mode() {
                EffectMode::Cancel => {
                    for task in owned
                        .values()
                        .filter(|task| task.correlation == correlation)
                    {
                        task.cancellation.cancel();
                    }
                }
                EffectMode::Spawn => {
                    let cancellation = CancellationToken::new();
                    let task = tasks.spawn(executor.execute(effect, cancellation.clone()));
                    owned.insert(
                        task.id(),
                        OwnedEffect {
                            cancellation,
                            correlation,
                            role,
                        },
                    );
                }
            }
        }
    }
    Ok(Admission {
        state: state.clone(),
        disposition,
    })
}

#[allow(clippy::too_many_arguments)]
fn finish_effect<M: Machine>(
    joined: Result<(TaskId, M::Input), tokio::task::JoinError>,
    machine: &M,
    state: &mut M::State,
    executor: &dyn EffectExecutor<M>,
    observer: &dyn TransitionObserver<M>,
    force_stale_completion: bool,
    snapshot: &Arc<Mutex<M::State>>,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
) -> EffectSettlement {
    let task_id = match &joined {
        Ok((task_id, _)) => *task_id,
        Err(error) => error.id(),
    };
    let Some(task) = owned.remove(&task_id) else {
        return EffectSettlement {
            disposition: Disposition::Retired,
        };
    };
    let role = task.role;
    let result = match joined {
        Ok((_, input)) => {
            let completion = machine.input_correlation(state, &input);
            if completion.as_ref() != Some(&task.correlation)
                || !machine.effect_is_current(state, &task.correlation)
                || (force_stale_completion && role == EffectRole::Operation)
            {
                let finalizer =
                    machine.task_failed(task.correlation, TaskFailure::CompletionConflict);
                apply_input_with_role(
                    machine,
                    state,
                    finalizer,
                    executor,
                    observer,
                    snapshot,
                    tasks,
                    owned,
                    EffectRole::Finalizer,
                )
            } else {
                apply_input_with_role(
                    machine, state, input, executor, observer, snapshot, tasks, owned, role,
                )
            }
        }
        Err(error) => {
            let failure = if error.is_panic() {
                TaskFailure::Panicked
            } else {
                TaskFailure::Aborted
            };
            let input = machine.task_failed(task.correlation, failure);
            apply_input_with_role(
                machine,
                state,
                input,
                executor,
                observer,
                snapshot,
                tasks,
                owned,
                EffectRole::Finalizer,
            )
        }
    };
    EffectSettlement {
        disposition: result
            .map(|admission| admission.disposition)
            .unwrap_or(Disposition::Rejected),
    }
}

fn apply_shutdown<M: Machine>(
    machine: &M,
    state: &mut M::State,
    executor: &dyn EffectExecutor<M>,
    observer: &dyn TransitionObserver<M>,
    snapshot: &Arc<Mutex<M::State>>,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
) -> Result<Admission<M::State>, M::Error> {
    let input = machine.shutdown();
    apply_input(
        machine, state, input, executor, observer, snapshot, tasks, owned,
    )
}

#[allow(clippy::too_many_arguments)]
async fn drain<M: Machine>(
    machine: &M,
    state: &mut M::State,
    executor: &dyn EffectExecutor<M>,
    observer: &dyn TransitionObserver<M>,
    config: RunnerConfig,
    snapshot: &Arc<Mutex<M::State>>,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
) -> DrainOutcome {
    let mut outcome = DrainOutcome {
        terminal: DrainTerminal::Completed,
        last_disposition: None,
    };
    if !drain_until(
        machine,
        state,
        executor,
        observer,
        config.shutdown_grace,
        snapshot,
        tasks,
        owned,
        false,
        &mut outcome,
    )
    .await
    {
        return outcome;
    }

    // The normal shutdown deadline is a hard boundary. All still-owned work is
    // cancelled and aborted by this one retirement owner. Aborted joins are
    // still fed through the machine so a domain can run its one owned
    // task_failed finalizer during the separate finalizer window.
    outcome.terminal = DrainTerminal::Forced(ForcedRetirementReason::ShutdownDeadlineExceeded);
    abort_owned(tasks, owned);
    if drain_until(
        machine,
        state,
        executor,
        observer,
        config.finalizer_grace,
        snapshot,
        tasks,
        owned,
        true,
        &mut outcome,
    )
    .await
    {
        // A finalizer that misses its own deadline is not allowed to publish a
        // late state transition. Detaching here is intentional: the actor and
        // its owned correlation table disappear together, so no stale result
        // can mutate reducer state after forced retirement.
        abort_owned(tasks, owned);
        tasks.detach_all();
        owned.clear();
        outcome.terminal = DrainTerminal::Forced(ForcedRetirementReason::FinalizerDeadlineExceeded);
    }
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn drain_until<M: Machine>(
    machine: &M,
    state: &mut M::State,
    executor: &dyn EffectExecutor<M>,
    observer: &dyn TransitionObserver<M>,
    grace: Duration,
    snapshot: &Arc<Mutex<M::State>>,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
    force_stale_completion: bool,
    outcome: &mut DrainOutcome,
) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        if tasks.is_empty() {
            return false;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return true;
        }
        match timeout(remaining, tasks.join_next_with_id()).await {
            Ok(Some(joined)) => {
                outcome.last_disposition = Some(
                    finish_effect(
                        joined,
                        machine,
                        state,
                        executor,
                        observer,
                        force_stale_completion,
                        snapshot,
                        tasks,
                        owned,
                    )
                    .disposition,
                );
            }
            Ok(None) => return false,
            Err(_) => return true,
        }
    }
}

fn abort_owned<E: 'static>(tasks: &mut JoinSet<E>, owned: &HashMap<TaskId, OwnedEffect>) {
    for task in owned.values() {
        task.cancellation.cancel();
    }
    tasks.abort_all();
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Barrier,
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        mpsc as std_mpsc,
    };

    use tokio::sync::Notify;

    use super::*;

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum TestState {
        Idle,
        Running(Correlation),
        Done,
        Retired,
    }

    #[derive(Clone, Debug)]
    enum TestInput {
        Start(Correlation),
        Cancel,
        Complete(Correlation),
        Shutdown,
    }

    #[derive(Debug)]
    enum TestEffect {
        Work(Correlation),
        Cancel(Correlation),
    }

    impl CorrelatedEffect for TestEffect {
        fn correlation(&self) -> &Correlation {
            match self {
                Self::Work(correlation) | Self::Cancel(correlation) => correlation,
            }
        }

        fn mode(&self) -> EffectMode {
            if matches!(self, Self::Cancel(_)) {
                EffectMode::Cancel
            } else {
                EffectMode::Spawn
            }
        }
    }

    #[derive(Clone, Copy)]
    struct TestMachine;

    impl Machine for TestMachine {
        type State = TestState;
        type Input = TestInput;
        type Effect = TestEffect;
        type Error = &'static str;

        fn reduce(
            &self,
            state: &Self::State,
            input: &Self::Input,
        ) -> Transition<Self::State, Self::Effect, Self::Error> {
            match (state, input) {
                (TestState::Idle, TestInput::Start(correlation)) => Transition::EffectEmitting {
                    state: TestState::Running(correlation.clone()),
                    effects: EffectBatch::one(TestEffect::Work(correlation.clone())),
                },
                (TestState::Running(current), TestInput::Start(candidate))
                    if current.same_operation(candidate) =>
                {
                    Transition::Unchanged
                }
                (TestState::Running(_), TestInput::Start(_)) => Transition::Rejected("busy"),
                (TestState::Running(current), TestInput::Cancel) => Transition::EffectEmitting {
                    state: state.clone(),
                    effects: EffectBatch::one(TestEffect::Cancel(current.clone())),
                },
                (TestState::Running(current), TestInput::Complete(completion))
                    if current == completion =>
                {
                    Transition::Committed(TestState::Done)
                }
                (TestState::Running(_), TestInput::Complete(_))
                | (TestState::Done, TestInput::Complete(_)) => Transition::Retired,
                (TestState::Running(_), TestInput::Shutdown) => {
                    Transition::Cancelled(TestState::Retired)
                }
                (_, TestInput::Shutdown) => Transition::Accepted(TestState::Retired),
                _ => Transition::Rejected("invalid"),
            }
        }

        fn input_correlation(
            &self,
            state: &Self::State,
            input: &Self::Input,
        ) -> Option<Correlation> {
            match input {
                TestInput::Start(correlation) | TestInput::Complete(correlation) => {
                    Some(correlation.clone())
                }
                TestInput::Cancel | TestInput::Shutdown => match state {
                    TestState::Running(correlation) => Some(correlation.clone()),
                    _ => None,
                },
            }
        }

        fn effect_is_current(&self, state: &Self::State, correlation: &Correlation) -> bool {
            matches!(state, TestState::Running(current) if current == correlation)
        }

        fn task_failed(&self, _correlation: Correlation, failure: TaskFailure) -> Self::Input {
            let _ = failure;
            TestInput::Shutdown
        }

        fn shutdown(&self) -> Self::Input {
            TestInput::Shutdown
        }

        fn unavailable(&self) -> Self::Error {
            "busy"
        }
    }

    enum ExecutorMode {
        Barrier {
            release: Arc<Notify>,
            started: Arc<Notify>,
        },
        Conflict,
        Panic,
        Pending,
    }

    struct TestExecutor {
        mode: ExecutorMode,
        executions: Arc<AtomicUsize>,
    }

    struct SnapshotObserver {
        published_before_notification: Arc<AtomicBool>,
        runner: Arc<Mutex<Option<RunnerHandle<TestMachine>>>>,
    }

    impl TransitionObserver<TestMachine> for SnapshotObserver {
        fn transitioned(
            &self,
            _previous: &TestState,
            _input: &TestInput,
            current: &TestState,
            _disposition: Disposition,
        ) {
            let runner = self
                .runner
                .lock()
                .expect("test runner lock poisoned")
                .clone()
                .expect("runner must be published before admitting input");
            if runner.snapshot() != *current {
                self.published_before_notification
                    .store(false, AtomicOrdering::Release);
            }
        }
    }

    impl EffectExecutor<TestMachine> for TestExecutor {
        fn execute(
            &self,
            effect: TestEffect,
            cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = TestInput> + Send + 'static>> {
            self.executions.fetch_add(1, AtomicOrdering::Relaxed);
            let correlation = effect.correlation().clone();
            match &self.mode {
                ExecutorMode::Barrier { release, started } => {
                    let release = release.clone();
                    let started = started.clone();
                    Box::pin(async move {
                        started.notify_one();
                        tokio::select! {
                            _ = release.notified() => TestInput::Complete(correlation),
                            _ = cancellation.cancelled() => TestInput::Complete(correlation),
                        }
                    })
                }
                ExecutorMode::Conflict => Box::pin(async move {
                    let mut conflict = correlation;
                    conflict.scope_epoch += 1;
                    TestInput::Complete(conflict)
                }),
                ExecutorMode::Panic => Box::pin(async move {
                    panic!("injected effect panic");
                }),
                ExecutorMode::Pending => Box::pin(async move { std::future::pending().await }),
            }
        }
    }

    struct BlockingObserver {
        entered: std_mpsc::Sender<()>,
        first: AtomicBool,
        release: Arc<Barrier>,
    }

    impl TransitionObserver<TestMachine> for BlockingObserver {
        fn transitioned(
            &self,
            _previous: &TestState,
            _input: &TestInput,
            _current: &TestState,
            _disposition: Disposition,
        ) {
            if self.first.swap(false, AtomicOrdering::AcqRel) {
                let _ = self.entered.send(());
                self.release.wait();
            }
        }
    }

    struct PanickingObserver;

    impl TransitionObserver<TestMachine> for PanickingObserver {
        fn transitioned(
            &self,
            _previous: &TestState,
            _input: &TestInput,
            _current: &TestState,
            _disposition: Disposition,
        ) {
            panic!("injected observer panic");
        }
    }

    struct PanickingReducer;

    impl Machine for PanickingReducer {
        type State = TestState;
        type Input = TestInput;
        type Effect = TestEffect;
        type Error = &'static str;

        fn reduce(
            &self,
            _state: &Self::State,
            _input: &Self::Input,
        ) -> Transition<Self::State, Self::Effect, Self::Error> {
            panic!("injected reducer panic");
        }

        fn input_correlation(
            &self,
            state: &Self::State,
            input: &Self::Input,
        ) -> Option<Correlation> {
            TestMachine.input_correlation(state, input)
        }

        fn effect_is_current(&self, state: &Self::State, correlation: &Correlation) -> bool {
            TestMachine.effect_is_current(state, correlation)
        }

        fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input {
            TestMachine.task_failed(correlation, failure)
        }

        fn shutdown(&self) -> Self::Input {
            TestMachine.shutdown()
        }

        fn unavailable(&self) -> Self::Error {
            "busy"
        }
    }

    struct RejectingShutdown;

    impl Machine for RejectingShutdown {
        type State = TestState;
        type Input = TestInput;
        type Effect = TestEffect;
        type Error = &'static str;

        fn reduce(
            &self,
            state: &Self::State,
            input: &Self::Input,
        ) -> Transition<Self::State, Self::Effect, Self::Error> {
            if matches!(input, TestInput::Shutdown) {
                Transition::Rejected("shutdown-rejected")
            } else {
                TestMachine.reduce(state, input)
            }
        }

        fn input_correlation(
            &self,
            state: &Self::State,
            input: &Self::Input,
        ) -> Option<Correlation> {
            TestMachine.input_correlation(state, input)
        }

        fn effect_is_current(&self, state: &Self::State, correlation: &Correlation) -> bool {
            TestMachine.effect_is_current(state, correlation)
        }

        fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input {
            TestMachine.task_failed(correlation, failure)
        }

        fn shutdown(&self) -> Self::Input {
            TestMachine.shutdown()
        }

        fn unavailable(&self) -> Self::Error {
            "busy"
        }
    }

    struct NeverTestExecutor;

    impl EffectExecutor<PanickingReducer> for NeverTestExecutor {
        fn execute(
            &self,
            _effect: TestEffect,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = TestInput> + Send + 'static>> {
            Box::pin(std::future::pending())
        }
    }

    impl EffectExecutor<RejectingShutdown> for NeverTestExecutor {
        fn execute(
            &self,
            _effect: TestEffect,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = TestInput> + Send + 'static>> {
            Box::pin(std::future::pending())
        }
    }

    struct FailedShutdown;

    impl Machine for FailedShutdown {
        type State = TestState;
        type Input = TestInput;
        type Effect = TestEffect;
        type Error = &'static str;

        fn reduce(
            &self,
            state: &Self::State,
            input: &Self::Input,
        ) -> Transition<Self::State, Self::Effect, Self::Error> {
            if matches!(input, TestInput::Shutdown) {
                Transition::Failed(TestState::Retired)
            } else {
                TestMachine.reduce(state, input)
            }
        }

        fn input_correlation(
            &self,
            state: &Self::State,
            input: &Self::Input,
        ) -> Option<Correlation> {
            TestMachine.input_correlation(state, input)
        }

        fn effect_is_current(&self, state: &Self::State, correlation: &Correlation) -> bool {
            TestMachine.effect_is_current(state, correlation)
        }

        fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input {
            TestMachine.task_failed(correlation, failure)
        }

        fn shutdown(&self) -> Self::Input {
            TestMachine.shutdown()
        }

        fn unavailable(&self) -> Self::Error {
            "busy"
        }
    }

    impl EffectExecutor<FailedShutdown> for NeverTestExecutor {
        fn execute(
            &self,
            _effect: TestEffect,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = TestInput> + Send + 'static>> {
            Box::pin(std::future::pending())
        }
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum FinalizerState {
        Idle,
        Running(Correlation),
        Retiring(Correlation),
        Finalizing(Correlation),
        Retired,
    }

    #[derive(Clone, Debug)]
    enum FinalizerInput {
        Start(Correlation),
        TaskFailed(Correlation),
        Finalized(Correlation),
        Shutdown,
    }

    #[derive(Debug)]
    enum FinalizerEffect {
        Work(Correlation),
        Finalize(Correlation),
    }

    impl CorrelatedEffect for FinalizerEffect {
        fn correlation(&self) -> &Correlation {
            match self {
                Self::Work(correlation) | Self::Finalize(correlation) => correlation,
            }
        }
    }

    struct FinalizerMachine;

    impl Machine for FinalizerMachine {
        type State = FinalizerState;
        type Input = FinalizerInput;
        type Effect = FinalizerEffect;
        type Error = &'static str;

        fn reduce(
            &self,
            state: &Self::State,
            input: &Self::Input,
        ) -> Transition<Self::State, Self::Effect, Self::Error> {
            match (state, input) {
                (FinalizerState::Idle, FinalizerInput::Start(correlation)) => {
                    Transition::EffectEmitting {
                        state: FinalizerState::Running(correlation.clone()),
                        effects: EffectBatch::one(FinalizerEffect::Work(correlation.clone())),
                    }
                }
                (FinalizerState::Running(current), FinalizerInput::Shutdown) => {
                    Transition::Accepted(FinalizerState::Retiring(current.clone()))
                }
                (FinalizerState::Retiring(current), FinalizerInput::TaskFailed(correlation))
                    if current.same_operation(correlation) =>
                {
                    Transition::EffectEmitting {
                        state: FinalizerState::Finalizing(current.clone()),
                        effects: EffectBatch::one(FinalizerEffect::Finalize(
                            current.with_effect(2),
                        )),
                    }
                }
                (FinalizerState::Finalizing(current), FinalizerInput::Finalized(correlation))
                    if current.with_effect(2) == *correlation =>
                {
                    Transition::Cancelled(FinalizerState::Retired)
                }
                (FinalizerState::Finalizing(_), FinalizerInput::TaskFailed(_)) => {
                    Transition::Failed(FinalizerState::Retired)
                }
                (FinalizerState::Retired, _) => Transition::Retired,
                _ => Transition::Rejected("invalid"),
            }
        }

        fn input_correlation(
            &self,
            _state: &Self::State,
            input: &Self::Input,
        ) -> Option<Correlation> {
            match input {
                FinalizerInput::Start(correlation)
                | FinalizerInput::TaskFailed(correlation)
                | FinalizerInput::Finalized(correlation) => Some(correlation.clone()),
                FinalizerInput::Shutdown => None,
            }
        }

        fn effect_is_current(&self, state: &Self::State, correlation: &Correlation) -> bool {
            match state {
                FinalizerState::Running(current) => {
                    current == correlation && correlation.effect_id == 1
                }
                FinalizerState::Finalizing(current) => {
                    current.same_operation(correlation) && correlation.effect_id == 2
                }
                FinalizerState::Idle | FinalizerState::Retiring(_) | FinalizerState::Retired => {
                    false
                }
            }
        }

        fn task_failed(&self, correlation: Correlation, _failure: TaskFailure) -> Self::Input {
            FinalizerInput::TaskFailed(correlation)
        }

        fn shutdown(&self) -> Self::Input {
            FinalizerInput::Shutdown
        }

        fn unavailable(&self) -> Self::Error {
            "unavailable"
        }
    }

    struct FinalizerExecutor {
        work_started: Arc<Notify>,
        finalizer_started: Arc<Notify>,
        release_finalizer: Arc<Notify>,
        finalizer_completions: Arc<AtomicUsize>,
    }

    impl EffectExecutor<FinalizerMachine> for FinalizerExecutor {
        fn execute(
            &self,
            effect: FinalizerEffect,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = FinalizerInput> + Send + 'static>> {
            match effect {
                FinalizerEffect::Work(_) => {
                    self.work_started.notify_one();
                    Box::pin(async { std::future::pending::<FinalizerInput>().await })
                }
                FinalizerEffect::Finalize(correlation) => {
                    let started = self.finalizer_started.clone();
                    let release = self.release_finalizer.clone();
                    let completions = self.finalizer_completions.clone();
                    Box::pin(async move {
                        started.notify_one();
                        release.notified().await;
                        completions.fetch_add(1, AtomicOrdering::Relaxed);
                        FinalizerInput::Finalized(correlation)
                    })
                }
            }
        }
    }

    fn correlation(operation_id: &str) -> Correlation {
        Correlation {
            machine_authority: "secret-authority".into(),
            scope_epoch: 7,
            operation_id: operation_id.into(),
            admitted_revision: 11,
            effect_id: 1,
        }
    }

    #[tokio::test]
    async fn snapshot_is_published_before_transition_observers_are_notified() {
        let release = Arc::new(Notify::new());
        let started = Arc::new(Notify::new());
        let published_before_notification = Arc::new(AtomicBool::new(true));
        let runner_slot = Arc::new(Mutex::new(None));
        let runner = spawn_runner(
            Arc::new(TestMachine),
            TestState::Idle,
            Arc::new(TestExecutor {
                mode: ExecutorMode::Barrier {
                    release: release.clone(),
                    started: started.clone(),
                },
                executions: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(SnapshotObserver {
                published_before_notification: published_before_notification.clone(),
                runner: runner_slot.clone(),
            }),
            RunnerConfig::default(),
        );
        *runner_slot.lock().expect("test runner lock poisoned") = Some(runner.clone());

        runner
            .admit(TestInput::Start(correlation("snapshot-order")))
            .await
            .unwrap();
        started.notified().await;
        release.notify_one();
        for _ in 0..100 {
            if runner.snapshot() == TestState::Done {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(runner.snapshot(), TestState::Done);
        assert!(published_before_notification.load(AtomicOrdering::Acquire));
        let _ = runner.shutdown().await;
    }

    #[tokio::test]
    async fn barrier_duplicate_replacement_and_cancel_are_ordered() {
        let release = Arc::new(Notify::new());
        let started = Arc::new(Notify::new());
        let executions = Arc::new(AtomicUsize::new(0));
        let runner = spawn_runner(
            Arc::new(TestMachine),
            TestState::Idle,
            Arc::new(TestExecutor {
                mode: ExecutorMode::Barrier {
                    release: release.clone(),
                    started: started.clone(),
                },
                executions: executions.clone(),
            }),
            Arc::new(NoopObserver),
            RunnerConfig::default(),
        );
        let operation = correlation("secret-operation");
        runner
            .admit(TestInput::Start(operation.clone()))
            .await
            .unwrap();
        started.notified().await;
        assert_eq!(
            runner
                .admit(TestInput::Start(operation.clone()))
                .await
                .unwrap()
                .disposition,
            Disposition::Unchanged
        );
        assert!(matches!(
            runner
                .admit(TestInput::Start(correlation("replacement")))
                .await,
            Err("busy")
        ));
        runner.admit(TestInput::Cancel).await.unwrap();
        tokio::task::yield_now().await;
        assert_eq!(runner.snapshot(), TestState::Done);
        assert_eq!(executions.load(AtomicOrdering::Relaxed), 1);
        let _ = runner.shutdown().await;
    }

    #[tokio::test]
    async fn completion_conflict_and_panic_are_finalized_without_stale_commit() {
        for mode in [ExecutorMode::Conflict, ExecutorMode::Panic] {
            let runner = spawn_runner(
                Arc::new(TestMachine),
                TestState::Idle,
                Arc::new(TestExecutor {
                    mode,
                    executions: Arc::new(AtomicUsize::new(0)),
                }),
                Arc::new(NoopObserver),
                RunnerConfig::default(),
            );
            runner
                .admit(TestInput::Start(correlation("operation")))
                .await
                .unwrap();
            for _ in 0..100 {
                if matches!(runner.snapshot(), TestState::Retired) {
                    break;
                }
                tokio::task::yield_now().await;
            }
            assert_eq!(runner.snapshot(), TestState::Retired);
            let _ = runner.shutdown().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn paused_shutdown_aborts_and_joins_an_uncooperative_effect() {
        let runner = spawn_runner(
            Arc::new(TestMachine),
            TestState::Idle,
            Arc::new(TestExecutor {
                mode: ExecutorMode::Pending,
                executions: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(NoopObserver),
            RunnerConfig {
                shutdown_grace: Duration::from_secs(1),
                ..RunnerConfig::default()
            },
        );
        runner
            .admit(TestInput::Start(correlation("pending")))
            .await
            .unwrap();
        let shutdown = {
            let runner = runner.clone();
            tokio::spawn(async move { runner.shutdown().await })
        };
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(2)).await;
        let retirement = shutdown.await.unwrap();
        assert_eq!(retirement.state, TestState::Retired);
        assert_eq!(
            retirement.terminal,
            RetirementTerminal::Forced(ForcedRetirementReason::ShutdownDeadlineExceeded)
        );
        assert_eq!(runner.shutdown().await.disposition, Disposition::Unchanged);
        assert!(matches!(
            runner.admit(TestInput::Start(correlation("late"))).await,
            Err("busy")
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn finalizer_deadline_forces_retirement_without_late_owner_mutation() {
        let work_started = Arc::new(Notify::new());
        let finalizer_started = Arc::new(Notify::new());
        let release_finalizer = Arc::new(Notify::new());
        let finalizer_completions = Arc::new(AtomicUsize::new(0));
        let runner = spawn_runner(
            Arc::new(FinalizerMachine),
            FinalizerState::Idle,
            Arc::new(FinalizerExecutor {
                work_started: work_started.clone(),
                finalizer_started: finalizer_started.clone(),
                release_finalizer: release_finalizer.clone(),
                finalizer_completions: finalizer_completions.clone(),
            }),
            Arc::new(NoopObserver),
            RunnerConfig {
                shutdown_grace: Duration::from_secs(1),
                finalizer_grace: Duration::from_secs(1),
                ..RunnerConfig::default()
            },
        );
        let operation = correlation("finalizer-deadline");
        runner
            .admit(FinalizerInput::Start(operation))
            .await
            .unwrap();
        work_started.notified().await;

        let shutdown = {
            let runner = runner.clone();
            tokio::spawn(async move { runner.shutdown().await })
        };
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        finalizer_started.notified().await;
        let before_forced_retirement = runner.snapshot();
        tokio::time::advance(Duration::from_secs(2)).await;

        let retirement = shutdown.await.unwrap();
        assert_eq!(
            retirement.terminal,
            RetirementTerminal::Forced(ForcedRetirementReason::FinalizerDeadlineExceeded)
        );
        assert_eq!(retirement.state, before_forced_retirement);
        assert!(matches!(retirement.state, FinalizerState::Finalizing(_)));

        // The finalizer's release is deliberately late. Its completion cannot
        // re-enter the retired runner or mutate the last owned snapshot.
        release_finalizer.notify_one();
        tokio::task::yield_now().await;
        assert_eq!(finalizer_completions.load(AtomicOrdering::Relaxed), 0);
        assert_eq!(runner.snapshot(), before_forced_retirement);
        assert_eq!(
            runner
                .try_admit(FinalizerInput::Shutdown)
                .await
                .unwrap_err(),
            AdmissionError::Retired
        );
    }

    #[tokio::test(start_paused = true)]
    async fn finalizer_completion_within_deadline_preserves_forced_shutdown_terminal() {
        let work_started = Arc::new(Notify::new());
        let finalizer_started = Arc::new(Notify::new());
        let release_finalizer = Arc::new(Notify::new());
        let finalizer_completions = Arc::new(AtomicUsize::new(0));
        let runner = spawn_runner(
            Arc::new(FinalizerMachine),
            FinalizerState::Idle,
            Arc::new(FinalizerExecutor {
                work_started: work_started.clone(),
                finalizer_started: finalizer_started.clone(),
                release_finalizer: release_finalizer.clone(),
                finalizer_completions: finalizer_completions.clone(),
            }),
            Arc::new(NoopObserver),
            RunnerConfig {
                shutdown_grace: Duration::from_secs(1),
                finalizer_grace: Duration::from_secs(1),
                ..RunnerConfig::default()
            },
        );
        runner
            .admit(FinalizerInput::Start(correlation("finalizer-completes")))
            .await
            .unwrap();
        work_started.notified().await;

        let shutdown = {
            let runner = runner.clone();
            tokio::spawn(async move { runner.shutdown().await })
        };
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(1)).await;
        finalizer_started.notified().await;
        release_finalizer.notify_one();

        let retirement = shutdown.await.unwrap();
        assert_eq!(retirement.state, FinalizerState::Retired);
        assert_eq!(retirement.disposition, Disposition::Accepted);
        assert_eq!(
            retirement.terminal,
            RetirementTerminal::Forced(ForcedRetirementReason::ShutdownDeadlineExceeded)
        );
        assert_eq!(finalizer_completions.load(AtomicOrdering::Relaxed), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn saturated_inbox_and_retired_runner_have_distinct_admission_errors() {
        let actor_release = Arc::new(Barrier::new(2));
        let effect_release = Arc::new(Notify::new());
        let effect_started = Arc::new(Notify::new());
        let (entered, actor_entered) = std_mpsc::channel();
        let runner = spawn_runner(
            Arc::new(TestMachine),
            TestState::Idle,
            Arc::new(TestExecutor {
                mode: ExecutorMode::Barrier {
                    release: effect_release.clone(),
                    started: effect_started,
                },
                executions: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(BlockingObserver {
                entered,
                first: AtomicBool::new(true),
                release: actor_release.clone(),
            }),
            RunnerConfig {
                inbox_capacity: 1,
                ..RunnerConfig::default()
            },
        );
        let first_runner = runner.clone();
        let operation = correlation("saturation");
        let first_operation = operation.clone();
        let first = tokio::spawn(async move {
            first_runner
                .try_admit(TestInput::Start(first_operation))
                .await
        });
        actor_entered
            .recv_timeout(Duration::from_secs(1))
            .expect("actor must enter the blocking observer");
        let (queued_reply, queued_response) = oneshot::channel();
        runner
            .shared
            .sender
            .try_send(Command::Admit {
                input: TestInput::Start(operation),
                reply: queued_reply,
            })
            .expect("one command must fit the bounded inbox");

        assert_eq!(
            runner.try_admit(TestInput::Cancel).await,
            Err(AdmissionError::InboxSaturated)
        );
        actor_release.wait();
        first.await.unwrap().unwrap();
        queued_response.await.unwrap().unwrap();
        effect_release.notify_one();
        for _ in 0..100 {
            if runner.snapshot() == TestState::Done {
                break;
            }
            tokio::task::yield_now().await;
        }
        let retirement = runner.shutdown().await;
        assert_eq!(retirement.terminal, RetirementTerminal::Applied);
        assert_eq!(
            runner.try_admit(TestInput::Cancel).await,
            Err(AdmissionError::Retired)
        );
    }

    #[tokio::test]
    async fn reducer_observer_and_actor_failures_return_typed_retirement() {
        let reducer_runner = spawn_runner(
            Arc::new(PanickingReducer),
            TestState::Idle,
            Arc::new(NeverTestExecutor),
            Arc::new(NoopObserver),
            RunnerConfig::default(),
        );
        assert!(
            reducer_runner
                .try_admit(TestInput::Start(correlation("reducer-panic")))
                .await
                .is_err()
        );
        assert_eq!(
            reducer_runner.shutdown().await.terminal,
            RetirementTerminal::ActorFailed(ActorFailure::Panicked)
        );

        let observer_runner = spawn_runner(
            Arc::new(TestMachine),
            TestState::Idle,
            Arc::new(TestExecutor {
                mode: ExecutorMode::Conflict,
                executions: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(PanickingObserver),
            RunnerConfig::default(),
        );
        assert!(
            observer_runner
                .try_admit(TestInput::Start(correlation("observer-panic")))
                .await
                .is_err()
        );
        assert_eq!(
            observer_runner.shutdown().await.terminal,
            RetirementTerminal::ActorFailed(ActorFailure::Panicked)
        );

        let aborted_runner = spawn_runner(
            Arc::new(TestMachine),
            TestState::Idle,
            Arc::new(TestExecutor {
                mode: ExecutorMode::Conflict,
                executions: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(NoopObserver),
            RunnerConfig::default(),
        );
        aborted_runner.abort_for_process_termination();
        while !aborted_runner.shared.sender.is_closed() {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            aborted_runner.shutdown().await.terminal,
            RetirementTerminal::ActorFailed(ActorFailure::Cancelled)
        );
    }

    #[tokio::test]
    async fn executor_panic_is_finalized_before_typed_shutdown() {
        let runner = spawn_runner(
            Arc::new(TestMachine),
            TestState::Idle,
            Arc::new(TestExecutor {
                mode: ExecutorMode::Panic,
                executions: Arc::new(AtomicUsize::new(0)),
            }),
            Arc::new(NoopObserver),
            RunnerConfig::default(),
        );
        runner
            .admit(TestInput::Start(correlation("executor-panic")))
            .await
            .unwrap();
        for _ in 0..100 {
            if runner.snapshot() == TestState::Retired {
                break;
            }
            tokio::task::yield_now().await;
        }
        let retirement = runner.shutdown().await;
        assert_eq!(retirement.state, TestState::Retired);
        assert_eq!(retirement.terminal, RetirementTerminal::Applied);
    }

    #[tokio::test]
    async fn rejected_shutdown_is_a_typed_terminal_result() {
        let runner = spawn_runner(
            Arc::new(RejectingShutdown),
            TestState::Idle,
            Arc::new(NeverTestExecutor),
            Arc::new(NoopObserver),
            RunnerConfig::default(),
        );

        let retirement = runner.shutdown().await;
        assert_eq!(retirement.state, TestState::Idle);
        assert_eq!(retirement.disposition, Disposition::Rejected);
        assert_eq!(
            retirement.terminal,
            RetirementTerminal::ShutdownRejected("shutdown-rejected")
        );
    }

    #[tokio::test]
    async fn cleanup_failure_is_not_reported_as_successful_retirement() {
        let runner = spawn_runner(
            Arc::new(FailedShutdown),
            TestState::Idle,
            Arc::new(NeverTestExecutor),
            Arc::new(NoopObserver),
            RunnerConfig::default(),
        );

        let retirement = runner.shutdown().await;
        assert_eq!(retirement.state, TestState::Retired);
        assert_eq!(retirement.disposition, Disposition::Failed);
        assert_eq!(
            retirement.terminal,
            RetirementTerminal::CleanupFailed(Disposition::Failed)
        );
    }

    #[derive(Clone, Debug, Eq, PartialEq)]
    enum AdversarialState {
        Idle,
        Running(Correlation),
        ForeignCommitted,
        Retired,
    }

    #[derive(Clone, Debug)]
    enum AdversarialInput {
        Start(Correlation),
        Replace(Correlation),
        Complete(Correlation),
        TaskFailed(Correlation),
        Shutdown,
    }

    #[derive(Debug)]
    enum AdversarialEffect {
        Owned(Correlation),
        Business(Correlation),
    }

    impl CorrelatedEffect for AdversarialEffect {
        fn correlation(&self) -> &Correlation {
            match self {
                Self::Owned(correlation) | Self::Business(correlation) => correlation,
            }
        }
    }

    struct AdversarialMachine {
        finalized: Arc<Mutex<Vec<(Correlation, TaskFailure)>>>,
    }

    impl Machine for AdversarialMachine {
        type State = AdversarialState;
        type Input = AdversarialInput;
        type Effect = AdversarialEffect;
        type Error = &'static str;

        fn reduce(
            &self,
            state: &Self::State,
            input: &Self::Input,
        ) -> Transition<Self::State, Self::Effect, Self::Error> {
            match (state, input) {
                (AdversarialState::Idle, AdversarialInput::Start(correlation)) => {
                    Transition::EffectEmitting {
                        state: AdversarialState::Running(correlation.clone()),
                        effects: EffectBatch::one(AdversarialEffect::Owned(correlation.clone())),
                    }
                }
                (AdversarialState::Running(_), AdversarialInput::Replace(correlation)) => {
                    Transition::Accepted(AdversarialState::Running(correlation.clone()))
                }
                // Deliberately unsafe: this reducer accepts every completion and would run a
                // business effect if the Kernel ever offered it a foreign correlation.
                (AdversarialState::Running(_), AdversarialInput::Complete(correlation)) => {
                    Transition::EffectEmitting {
                        state: AdversarialState::ForeignCommitted,
                        effects: EffectBatch::one(AdversarialEffect::Business(correlation.clone())),
                    }
                }
                (
                    AdversarialState::Running(_) | AdversarialState::ForeignCommitted,
                    AdversarialInput::TaskFailed(_),
                )
                | (_, AdversarialInput::Shutdown) => {
                    Transition::Accepted(AdversarialState::Retired)
                }
                _ => Transition::Retired,
            }
        }

        fn input_correlation(
            &self,
            _state: &Self::State,
            input: &Self::Input,
        ) -> Option<Correlation> {
            match input {
                AdversarialInput::Start(correlation)
                | AdversarialInput::Replace(correlation)
                | AdversarialInput::Complete(correlation)
                | AdversarialInput::TaskFailed(correlation) => Some(correlation.clone()),
                AdversarialInput::Shutdown => None,
            }
        }

        fn effect_is_current(&self, state: &Self::State, correlation: &Correlation) -> bool {
            matches!(state, AdversarialState::Running(current) if current == correlation)
        }

        fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input {
            self.finalized
                .lock()
                .expect("adversarial finalizer lock poisoned")
                .push((correlation.clone(), failure));
            AdversarialInput::TaskFailed(correlation)
        }

        fn shutdown(&self) -> Self::Input {
            AdversarialInput::Shutdown
        }

        fn unavailable(&self) -> Self::Error {
            "unavailable"
        }
    }

    struct AdversarialExecutor {
        business_effects: Arc<AtomicUsize>,
    }

    impl EffectExecutor<AdversarialMachine> for AdversarialExecutor {
        fn execute(
            &self,
            effect: AdversarialEffect,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = AdversarialInput> + Send + 'static>> {
            match effect {
                AdversarialEffect::Owned(mut correlation) => {
                    correlation.scope_epoch = correlation.scope_epoch.saturating_add(1);
                    Box::pin(async move { AdversarialInput::Complete(correlation) })
                }
                AdversarialEffect::Business(correlation) => {
                    self.business_effects.fetch_add(1, AtomicOrdering::Relaxed);
                    Box::pin(async move { AdversarialInput::Complete(correlation) })
                }
            }
        }
    }

    struct ReplacementAdversarialExecutor {
        business_effects: Arc<AtomicUsize>,
        release: Arc<Notify>,
        started: Arc<Notify>,
    }

    impl EffectExecutor<AdversarialMachine> for ReplacementAdversarialExecutor {
        fn execute(
            &self,
            effect: AdversarialEffect,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = AdversarialInput> + Send + 'static>> {
            match effect {
                AdversarialEffect::Owned(correlation) => {
                    let release = self.release.clone();
                    let started = self.started.clone();
                    Box::pin(async move {
                        started.notify_one();
                        release.notified().await;
                        AdversarialInput::Complete(correlation)
                    })
                }
                AdversarialEffect::Business(correlation) => {
                    self.business_effects.fetch_add(1, AtomicOrdering::Relaxed);
                    Box::pin(async move { AdversarialInput::Complete(correlation) })
                }
            }
        }
    }

    struct PendingAdversarialExecutor;

    impl EffectExecutor<AdversarialMachine> for PendingAdversarialExecutor {
        fn execute(
            &self,
            _effect: AdversarialEffect,
            _cancellation: CancellationToken,
        ) -> Pin<Box<dyn Future<Output = AdversarialInput> + Send + 'static>> {
            Box::pin(std::future::pending())
        }
    }

    struct AdversarialObserver {
        foreign_commits: Arc<AtomicUsize>,
        retirements: Arc<AtomicUsize>,
    }

    impl TransitionObserver<AdversarialMachine> for AdversarialObserver {
        fn transitioned(
            &self,
            _previous: &AdversarialState,
            _input: &AdversarialInput,
            current: &AdversarialState,
            _disposition: Disposition,
        ) {
            if *current == AdversarialState::ForeignCommitted {
                self.foreign_commits.fetch_add(1, AtomicOrdering::Relaxed);
            }
            if *current == AdversarialState::Retired {
                self.retirements.fetch_add(1, AtomicOrdering::Relaxed);
            }
        }
    }

    #[tokio::test]
    async fn foreign_completion_never_reaches_an_adversarial_reducer() {
        let finalized = Arc::new(Mutex::new(Vec::new()));
        let business_effects = Arc::new(AtomicUsize::new(0));
        let foreign_commits = Arc::new(AtomicUsize::new(0));
        let retirements = Arc::new(AtomicUsize::new(0));
        let runner = spawn_runner(
            Arc::new(AdversarialMachine {
                finalized: finalized.clone(),
            }),
            AdversarialState::Idle,
            Arc::new(AdversarialExecutor {
                business_effects: business_effects.clone(),
            }),
            Arc::new(AdversarialObserver {
                foreign_commits: foreign_commits.clone(),
                retirements: retirements.clone(),
            }),
            RunnerConfig::default(),
        );
        let owned = correlation("owned-operation");

        runner
            .admit(AdversarialInput::Start(owned.clone()))
            .await
            .unwrap();
        for _ in 0..100 {
            if runner.snapshot() == AdversarialState::Retired {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(runner.snapshot(), AdversarialState::Retired);
        assert_eq!(foreign_commits.load(AtomicOrdering::Relaxed), 0);
        assert_eq!(business_effects.load(AtomicOrdering::Relaxed), 0);
        assert_eq!(retirements.load(AtomicOrdering::Relaxed), 1);
        assert_eq!(
            *finalized
                .lock()
                .expect("adversarial finalizer lock poisoned"),
            vec![(owned, TaskFailure::CompletionConflict)]
        );
        let _ = runner.shutdown().await;
    }

    #[tokio::test]
    async fn replaced_effect_completion_never_reaches_an_adversarial_reducer() {
        let finalized = Arc::new(Mutex::new(Vec::new()));
        let business_effects = Arc::new(AtomicUsize::new(0));
        let foreign_commits = Arc::new(AtomicUsize::new(0));
        let retirements = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(Notify::new());
        let started = Arc::new(Notify::new());
        let runner = spawn_runner(
            Arc::new(AdversarialMachine {
                finalized: finalized.clone(),
            }),
            AdversarialState::Idle,
            Arc::new(ReplacementAdversarialExecutor {
                business_effects: business_effects.clone(),
                release: release.clone(),
                started: started.clone(),
            }),
            Arc::new(AdversarialObserver {
                foreign_commits: foreign_commits.clone(),
                retirements: retirements.clone(),
            }),
            RunnerConfig::default(),
        );
        let owned = correlation("replaced-operation");
        let replacement = correlation("replacement-operation");

        runner
            .admit(AdversarialInput::Start(owned.clone()))
            .await
            .unwrap();
        started.notified().await;
        runner
            .admit(AdversarialInput::Replace(replacement))
            .await
            .unwrap();
        release.notify_one();
        for _ in 0..100 {
            if runner.snapshot() == AdversarialState::Retired {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(runner.snapshot(), AdversarialState::Retired);
        assert_eq!(foreign_commits.load(AtomicOrdering::Relaxed), 0);
        assert_eq!(business_effects.load(AtomicOrdering::Relaxed), 0);
        assert_eq!(retirements.load(AtomicOrdering::Relaxed), 1);
        assert_eq!(
            *finalized
                .lock()
                .expect("adversarial finalizer lock poisoned"),
            vec![(owned, TaskFailure::CompletionConflict)]
        );
        let _ = runner.shutdown().await;
    }

    #[tokio::test(start_paused = true)]
    async fn last_owner_drop_runs_bounded_shutdown_and_owned_finalization() {
        let finalized = Arc::new(Mutex::new(Vec::new()));
        let runner = spawn_runner(
            Arc::new(AdversarialMachine {
                finalized: finalized.clone(),
            }),
            AdversarialState::Idle,
            Arc::new(PendingAdversarialExecutor),
            Arc::new(NoopObserver),
            RunnerConfig {
                shutdown_grace: Duration::from_secs(1),
                ..RunnerConfig::default()
            },
        );
        let owned = correlation("last-owner-drop");
        runner
            .admit(AdversarialInput::Start(owned.clone()))
            .await
            .unwrap();

        drop(runner);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(2)).await;
        for _ in 0..100 {
            if !finalized
                .lock()
                .expect("adversarial finalizer lock poisoned")
                .is_empty()
            {
                break;
            }
            tokio::task::yield_now().await;
        }

        assert_eq!(
            *finalized
                .lock()
                .expect("adversarial finalizer lock poisoned"),
            vec![(owned, TaskFailure::Aborted)]
        );
    }
}
