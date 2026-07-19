mod activation;
mod controller_source;
mod controller_status;
mod diagnostics;
mod event_redaction;
mod lifecycle;
mod managed_process;
mod profile_activation;
mod profiles;
mod protocol;
mod runtime_host;
mod server;

pub use activation::{
    ActivationAttempt, ActivationCommit, ActivationFailureKind, ActivationOutcome,
    ActivationTiming, GeneratedRuntimeConfig, ManagedActivationState, ManagedMihomoResolver,
    ManagedRuntimePolicy, MihomoActivationError, MihomoActivationManager, MihomoResolveError,
    ResolvedManagedMihomo, RuntimeConfigGenerationError, RuntimeConfigGenerator,
};
pub use controller_source::{
    ControllerInitialObservation, ControllerObservationConfig, ControllerStatusSource,
    ControllerStatusSourceError,
};
pub use controller_status::{
    ControllerObservationBatch, ControllerStatusMapper, ProfileMappingContext,
    SelectionTargetError, StatusMappingError, StatusRetentionPolicy,
};
pub use diagnostics::{DiagnosticCoordinator, DiagnosticNetworkProbe};
pub use lifecycle::{
    DesktopLifecycleCoordinator, LifecycleCoordinationError, LifecycleEventDisposition,
};
pub use managed_process::{
    DesktopMihomoProcess, DesktopMihomoProcessConfig, ManagedProcessValidationError,
};
pub use profile_activation::{
    ManagedProfileSnapshot, ProfileActivationAvailability, ProfileActivationCoordinator,
    ProfileActivationCoordinatorError, ProfileActivationFailure, ProfileActivationOperation,
    ProfileActivationPhase, ProfileActivationSnapshot, ProfileStartupPolicy,
};
pub use profiles::{DesktopProfileService, ReqwestHttpsSourceReader};
pub use runtime_host::DesktopRuntimeHost;
pub use server::{
    LoopbackServerConfig, LoopbackServerHandle, start_loopback_server,
    start_loopback_server_with_runtime_host, start_loopback_server_with_runtime_host_and_lifecycle,
};

use std::sync::Arc;

use mish_runtime::CaptureReconciler;
use mish_runtime::{CoreRuntime, MishRuntime};

pub async fn compose_desktop_runtime(
    lifecycle: Arc<dyn CoreRuntime>,
    controller: Option<ControllerObservationConfig>,
) -> Result<MishRuntime, ControllerStatusSourceError> {
    compose_desktop_runtime_with_capture(lifecycle, controller, None).await
}

pub async fn compose_desktop_runtime_with_capture(
    lifecycle: Arc<dyn CoreRuntime>,
    controller: Option<ControllerObservationConfig>,
    capture: Option<Arc<CaptureReconciler>>,
) -> Result<MishRuntime, ControllerStatusSourceError> {
    let Some(controller) = controller else {
        return Ok(match capture {
            Some(capture) => MishRuntime::with_capture(lifecycle, capture),
            None => MishRuntime::new(lifecycle),
        });
    };
    let source = ControllerStatusSource::new(controller, lifecycle.clone())?;
    let runtime = MishRuntime::with_data_sources_events_and_capture(
        lifecycle,
        source.clone(),
        source.clone(),
        source.clone(),
        capture,
    );
    source.start().await;
    Ok(runtime)
}
