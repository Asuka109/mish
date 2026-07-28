//! Repository-owned execution kernel for failure-sensitive internal lifecycles.
//!
//! Product machines keep their own data-bearing state, input, effect, projection,
//! and error vocabularies. This crate owns only bounded admission, effect
//! correlation and task ownership, finalization, stale retirement evidence, and
//! an optional durable recovery record.

use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use sha2::{Digest, Sha256};
use tokio::{
    sync::{mpsc, oneshot},
    task::{Id as TaskId, JoinHandle, JoinSet},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
pub mod recovery;

pub const DEFAULT_INBOX_CAPACITY: usize = 32;
pub const DEFAULT_EVIDENCE_LIMIT: usize = 64;
pub const DEFAULT_SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

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

    fn state_label(&self, state: &Self::State) -> &'static str;
    fn input_label(&self, input: &Self::Input) -> &'static str;
    fn input_correlation(&self, state: &Self::State, input: &Self::Input) -> Option<Correlation>;
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
pub struct TransitionEvidence {
    pub sequence: u64,
    pub machine_authority_sha256: Option<String>,
    pub scope_epoch: Option<u64>,
    pub operation_id_sha256: Option<String>,
    pub admitted_revision: Option<u64>,
    pub effect_id: Option<u64>,
    pub from: String,
    pub input: String,
    pub to: String,
    pub disposition: String,
}

#[derive(Clone, Debug)]
pub struct Admission<S> {
    pub state: S,
    pub disposition: Disposition,
}

pub struct RunnerConfig {
    pub inbox_capacity: usize,
    pub evidence_limit: usize,
    pub shutdown_grace: Duration,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            inbox_capacity: DEFAULT_INBOX_CAPACITY,
            evidence_limit: DEFAULT_EVIDENCE_LIMIT,
            shutdown_grace: DEFAULT_SHUTDOWN_GRACE,
        }
    }
}

enum Command<M: Machine> {
    Admit {
        input: M::Input,
        reply: oneshot::Sender<Result<Admission<M::State>, M::Error>>,
    },
    Shutdown {
        reply: oneshot::Sender<Admission<M::State>>,
    },
}

struct OwnedEffect {
    cancellation: CancellationToken,
    correlation: Correlation,
}

struct Shared<M: Machine> {
    actor: Mutex<Option<JoinHandle<()>>>,
    closed: AtomicBool,
    evidence: Arc<Mutex<VecDeque<TransitionEvidence>>>,
    unavailable: M::Error,
    sender: mpsc::Sender<Command<M>>,
    shutdown: CancellationToken,
    state: Arc<Mutex<M::State>>,
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
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(self.shared.unavailable.clone());
        }
        let (reply, response) = oneshot::channel();
        self.shared
            .sender
            .try_send(Command::Admit { input, reply })
            .map_err(|_| self.shared.unavailable.clone())?;
        response
            .await
            .map_err(|_| self.shared.unavailable.clone())?
    }

    pub async fn shutdown(&self) -> Admission<M::State> {
        if self.shared.closed.swap(true, Ordering::AcqRel) {
            return Admission {
                state: self.snapshot(),
                disposition: Disposition::Unchanged,
            };
        }
        let (reply, response) = oneshot::channel();
        self.shared
            .sender
            .send(Command::Shutdown { reply })
            .await
            .expect("machine runner retired before shutdown");
        let admission = response
            .await
            .expect("machine runner retired before shutdown reply");
        let actor = self
            .shared
            .actor
            .lock()
            .expect("machine actor lock poisoned")
            .take();
        if let Some(actor) = actor {
            let _ = actor.await;
        }
        admission
    }

    pub fn evidence(&self) -> Vec<TransitionEvidence> {
        self.shared
            .evidence
            .lock()
            .expect("machine evidence lock poisoned")
            .iter()
            .cloned()
            .collect()
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
        self.shutdown.cancel();
        if let Some(actor) = self
            .actor
            .lock()
            .expect("machine actor lock poisoned")
            .take()
        {
            actor.abort();
        }
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
    assert!(
        config.evidence_limit > 0,
        "machine evidence must be bounded"
    );
    let (sender, receiver) = mpsc::channel(config.inbox_capacity);
    let evidence = Arc::new(Mutex::new(VecDeque::new()));
    let state = Arc::new(Mutex::new(initial.clone()));
    let shutdown = CancellationToken::new();
    let unavailable = machine.unavailable();
    let actor = tokio::spawn(run_actor(
        machine,
        initial,
        executor,
        observer,
        receiver,
        evidence.clone(),
        state.clone(),
        shutdown.clone(),
        config,
    ));
    RunnerHandle {
        shared: Arc::new(Shared {
            actor: Mutex::new(Some(actor)),
            closed: AtomicBool::new(false),
            evidence,
            unavailable,
            sender,
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
    evidence: Arc<Mutex<VecDeque<TransitionEvidence>>>,
    snapshot: Arc<Mutex<M::State>>,
    shutdown: CancellationToken,
    config: RunnerConfig,
) {
    let mut tasks = JoinSet::new();
    let mut owned = HashMap::<TaskId, OwnedEffect>::new();
    loop {
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => {
                apply_shutdown(
                    machine.as_ref(), &mut state, executor.as_ref(), observer.as_ref(),
                    &evidence, config.evidence_limit, &mut tasks, &mut owned,
                );
                drain(
                    machine.as_ref(), &mut state, executor.as_ref(), observer.as_ref(),
                    &evidence, config.evidence_limit, config.shutdown_grace,
                    &mut tasks, &mut owned,
                ).await;
                *snapshot.lock().expect("machine snapshot lock poisoned") = state.clone();
                return;
            }
            joined = tasks.join_next_with_id(), if !owned.is_empty() => {
                if let Some(joined) = joined {
                    finish_effect(
                        joined, machine.as_ref(), &mut state, executor.as_ref(),
                        observer.as_ref(), &evidence, config.evidence_limit,
                        &mut tasks, &mut owned,
                    );
                    *snapshot.lock().expect("machine snapshot lock poisoned") = state.clone();
                }
            }
            command = receiver.recv() => {
                let Some(command) = command else {
                    apply_shutdown(
                        machine.as_ref(), &mut state, executor.as_ref(), observer.as_ref(),
                        &evidence, config.evidence_limit, &mut tasks, &mut owned,
                    );
                    drain(
                        machine.as_ref(), &mut state, executor.as_ref(), observer.as_ref(),
                        &evidence, config.evidence_limit, config.shutdown_grace,
                        &mut tasks, &mut owned,
                    ).await;
                    *snapshot.lock().expect("machine snapshot lock poisoned") = state.clone();
                    return;
                };
                match command {
                    Command::Admit { input, reply } => {
                        let result = apply_input(
                            machine.as_ref(), &mut state, input, executor.as_ref(),
                            observer.as_ref(), &evidence, config.evidence_limit,
                            &mut tasks, &mut owned,
                        );
                        *snapshot.lock().expect("machine snapshot lock poisoned") = state.clone();
                        let _ = reply.send(result);
                    }
                    Command::Shutdown { reply } => {
                        let disposition = apply_shutdown(
                            machine.as_ref(), &mut state, executor.as_ref(), observer.as_ref(),
                            &evidence, config.evidence_limit, &mut tasks, &mut owned,
                        );
                        drain(
                            machine.as_ref(), &mut state, executor.as_ref(), observer.as_ref(),
                            &evidence, config.evidence_limit, config.shutdown_grace,
                            &mut tasks, &mut owned,
                        ).await;
                        *snapshot.lock().expect("machine snapshot lock poisoned") = state.clone();
                        let _ = reply.send(Admission { state, disposition });
                        return;
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_input<M: Machine>(
    machine: &M,
    state: &mut M::State,
    input: M::Input,
    executor: &dyn EffectExecutor<M>,
    observer: &dyn TransitionObserver<M>,
    evidence: &Arc<Mutex<VecDeque<TransitionEvidence>>>,
    evidence_limit: usize,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
) -> Result<Admission<M::State>, M::Error> {
    let previous = state.clone();
    let from = machine.state_label(&previous);
    let input_label = machine.input_label(&input);
    let correlation = machine.input_correlation(&previous, &input);
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
            record_evidence(
                evidence,
                evidence_limit,
                from,
                input_label,
                machine.state_label(state),
                disposition,
                correlation.as_ref(),
            );
            observer.transitioned(&previous, &input, state, disposition);
            return Err(error);
        }
        Transition::Unchanged | Transition::Retired => None,
    };
    record_evidence(
        evidence,
        evidence_limit,
        from,
        input_label,
        machine.state_label(state),
        disposition,
        correlation.as_ref(),
    );
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
    evidence: &Arc<Mutex<VecDeque<TransitionEvidence>>>,
    evidence_limit: usize,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
) {
    let task_id = match &joined {
        Ok((task_id, _)) => *task_id,
        Err(error) => error.id(),
    };
    let Some(task) = owned.remove(&task_id) else {
        return;
    };
    match joined {
        Ok((_, input)) => {
            let completion = machine.input_correlation(state, &input);
            if completion.as_ref() != Some(&task.correlation) {
                let _ = apply_input(
                    machine,
                    state,
                    input,
                    executor,
                    observer,
                    evidence,
                    evidence_limit,
                    tasks,
                    owned,
                );
                let finalizer =
                    machine.task_failed(task.correlation, TaskFailure::CompletionConflict);
                let _ = apply_input(
                    machine,
                    state,
                    finalizer,
                    executor,
                    observer,
                    evidence,
                    evidence_limit,
                    tasks,
                    owned,
                );
            } else {
                let _ = apply_input(
                    machine,
                    state,
                    input,
                    executor,
                    observer,
                    evidence,
                    evidence_limit,
                    tasks,
                    owned,
                );
            }
        }
        Err(error) => {
            let failure = if error.is_panic() {
                TaskFailure::Panicked
            } else {
                TaskFailure::Aborted
            };
            let input = machine.task_failed(task.correlation, failure);
            let _ = apply_input(
                machine,
                state,
                input,
                executor,
                observer,
                evidence,
                evidence_limit,
                tasks,
                owned,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn apply_shutdown<M: Machine>(
    machine: &M,
    state: &mut M::State,
    executor: &dyn EffectExecutor<M>,
    observer: &dyn TransitionObserver<M>,
    evidence: &Arc<Mutex<VecDeque<TransitionEvidence>>>,
    evidence_limit: usize,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
) -> Disposition {
    let input = machine.shutdown();
    match apply_input(
        machine,
        state,
        input,
        executor,
        observer,
        evidence,
        evidence_limit,
        tasks,
        owned,
    ) {
        Ok(admission) => admission.disposition,
        Err(_) => panic!("machine shutdown transition must be infallible"),
    }
}

#[allow(clippy::too_many_arguments)]
async fn drain<M: Machine>(
    machine: &M,
    state: &mut M::State,
    executor: &dyn EffectExecutor<M>,
    observer: &dyn TransitionObserver<M>,
    evidence: &Arc<Mutex<VecDeque<TransitionEvidence>>>,
    evidence_limit: usize,
    grace: Duration,
    tasks: &mut JoinSet<M::Input>,
    owned: &mut HashMap<TaskId, OwnedEffect>,
) {
    let graceful = async {
        while let Some(joined) = tasks.join_next_with_id().await {
            finish_effect(
                joined,
                machine,
                state,
                executor,
                observer,
                evidence,
                evidence_limit,
                tasks,
                owned,
            );
        }
    };
    if timeout(grace, graceful).await.is_err() {
        tasks.abort_all();
        while let Some(joined) = tasks.join_next_with_id().await {
            finish_effect(
                joined,
                machine,
                state,
                executor,
                observer,
                evidence,
                evidence_limit,
                tasks,
                owned,
            );
        }
    }
}

fn record_evidence(
    evidence: &Arc<Mutex<VecDeque<TransitionEvidence>>>,
    limit: usize,
    from: &str,
    input: &str,
    to: &str,
    disposition: Disposition,
    correlation: Option<&Correlation>,
) {
    let mut evidence = evidence.lock().expect("machine evidence lock poisoned");
    let sequence = evidence
        .back()
        .map_or(1, |entry| entry.sequence.saturating_add(1));
    if evidence.len() == limit {
        evidence.pop_front();
    }
    evidence.push_back(TransitionEvidence {
        sequence,
        machine_authority_sha256: correlation.map(|value| digest(&value.machine_authority)),
        scope_epoch: correlation.map(|value| value.scope_epoch),
        operation_id_sha256: correlation.map(|value| digest(&value.operation_id)),
        admitted_revision: correlation.map(|value| value.admitted_revision),
        effect_id: correlation.map(|value| value.effect_id),
        from: from.to_owned(),
        input: input.to_owned(),
        to: to.to_owned(),
        disposition: disposition.label().to_owned(),
    });
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

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

        fn state_label(&self, state: &Self::State) -> &'static str {
            match state {
                TestState::Idle => "idle",
                TestState::Running(_) => "running",
                TestState::Done => "done",
                TestState::Retired => "retired",
            }
        }

        fn input_label(&self, input: &Self::Input) -> &'static str {
            match input {
                TestInput::Start(_) => "start",
                TestInput::Cancel => "cancel",
                TestInput::Complete(_) => "complete",
                TestInput::Shutdown => "shutdown",
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
    async fn barrier_duplicate_replacement_cancel_and_redacted_evidence_are_bounded() {
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
            RunnerConfig {
                evidence_limit: 3,
                ..RunnerConfig::default()
            },
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
        let evidence = runner.evidence();
        assert_eq!(evidence.len(), 3);
        let rendered = format!("{evidence:?}");
        assert!(!rendered.contains("secret-authority"));
        assert!(!rendered.contains("secret-operation"));
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
            assert_ne!(runner.snapshot(), TestState::Done);
            assert!(
                runner
                    .evidence()
                    .iter()
                    .any(|entry| { entry.input == "complete" || entry.input == "shutdown" })
            );
            if !matches!(runner.snapshot(), TestState::Retired) {
                let _ = runner.shutdown().await;
            }
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
        assert_eq!(shutdown.await.unwrap().state, TestState::Retired);
        assert_eq!(runner.shutdown().await.disposition, Disposition::Unchanged);
        assert!(matches!(
            runner.admit(TestInput::Start(correlation("late"))).await,
            Err("busy")
        ));
    }
}
