mod activation;
#[doc(hidden)]
#[path = "generated/bridge_protocol.rs"]
pub mod bridge_protocol;
mod controller_source;
mod controller_status;
mod core_ownership;
mod event_redaction;
mod lifecycle;
mod local_backup;
mod managed_process;
mod profile_activation;
mod profile_file_actions;
mod profiles;
mod protocol;
mod runtime_host;
mod server;
mod service_probes;
mod snapshot_order;
mod support_bundle;
mod traffic_source_machine;

pub use activation::{
    ActivationAttempt, ActivationCommit, ActivationFailureKind, ActivationOutcome,
    ActivationTiming, GeneratedRuntimeConfig, ManagedActivationState, ManagedMihomoResolver,
    ManagedRuntimePolicy, MihomoActivationError, MihomoActivationManager, MihomoResolveError,
    ResolvedManagedMihomo, RuntimeConfigGenerationError, RuntimeConfigGenerator,
};
#[cfg(feature = "test-activation-host")]
pub use activation::{ManagedListenerCheckPhase, ManagedListenerHost, ManagedListenerOwnership};
pub use controller_source::{
    ControllerInitialObservation, ControllerObservationConfig, ControllerStatusSource,
    ControllerStatusSourceError,
};
pub use controller_status::{
    ControllerObservationBatch, ControllerStatusMapper, ProfileMappingContext,
    SelectionTargetError, StatusMappingError, StatusRetentionPolicy,
};
pub use core_ownership::{
    MANAGED_CORE_TOKEN_ENV, ManagedCoreLaunch, ManagedCoreLaunchSpec, ManagedCoreOwnership,
    ManagedCoreOwnershipError, ManagedCoreProcess, ManagedCoreRecoveryOutcome,
    ManagedProcessObservation, ManagedProcessPlatform, ManagedProcessPlatformError,
    ManagedRuntimeLease, RealManagedProcessPlatform,
};
pub use lifecycle::{
    DesktopLifecycleCoordinator, LifecycleCoordinationError, LifecycleEventDisposition,
};
pub use local_backup::{
    LOCAL_BACKUP_FORMAT_VERSION, LOCAL_BACKUP_MAX_BYTES, LocalBackupError,
    LocalBackupIncludedCounts, LocalBackupPreview, LocalBackupScope, LocalBackupSensitiveData,
    LocalBackupService, LocalRestoreActionCounts, LocalRestoreConflict, LocalRestoreConflictKind,
    LocalRestoreConflictResolution, LocalRestorePreview, LocalRestoreResult, PreparedLocalBackup,
    PreparedLocalRestore,
};
pub use managed_process::{
    DesktopMihomoProcess, DesktopMihomoProcessConfig, GeodataAsset, GeodataValidationEvent,
    GeodataValidationObserver, ManagedProcessValidationError, PrivilegedCoreHost,
    PrivilegedCoreHostError, PrivilegedCoreLaunchRequest, PrivilegedCoreProcess,
};
pub use profile_activation::{
    ManagedProfileSnapshot, ProfileActivationAvailability, ProfileActivationCoordinator,
    ProfileActivationCoordinatorError, ProfileActivationEffects, ProfileActivationEvidence,
    ProfileActivationEvidenceKind, ProfileActivationFailure, ProfileActivationOperation,
    ProfileActivationPhase, ProfileActivationProgress, ProfileActivationProgressObserver,
    ProfileActivationShutdownFailure, ProfileActivationSnapshot, ProfileStartupPolicy,
};
pub use profile_file_actions::{
    ProfileFileActionError, ProfileFileActionPlatform, ProfileFileActions,
};
pub use profiles::{DesktopProfileService, ReqwestHttpsSourceReader};
pub use runtime_host::DesktopRuntimeHost;
pub use server::{
    BridgeShutdownFailure, BridgeShutdownOutcome, BridgeShutdownReport, BrowserAsset,
    BrowserAssetSource, BrowserClientHandle, BrowserPairingPrompt, LoopbackPortSelection,
    LoopbackServerConfig, LoopbackServerHandle, ProcessIcon, ProcessIconResolver,
    initialize_onboarding_welcome_notification, start_loopback_server,
    start_loopback_server_with_runtime_host, start_loopback_server_with_runtime_host_and_lifecycle,
};
#[cfg(feature = "development-window-trigger")]
pub use server::{
    DevelopmentWindowTrigger, DevelopmentWindowTriggerConfig, DevelopmentWindowTriggerHandle,
    start_loopback_server_with_runtime_host_lifecycle_and_development_window_trigger,
};
pub use service_probes::ServiceProbeConfig;
pub use support_bundle::{
    PreparedSupportBundle, SUPPORT_BUNDLE_MAX_BYTES, SupportBundleError, SupportBundlePlatform,
    SupportBundlePreview, SupportBundleService, TerminationEvidenceStore,
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
