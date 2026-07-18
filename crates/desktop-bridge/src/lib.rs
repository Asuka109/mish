mod controller_source;
mod controller_status;
mod managed_process;
mod protocol;
mod server;

pub use controller_source::{
    ControllerObservationConfig, ControllerStatusSource, ControllerStatusSourceError,
};
pub use controller_status::{
    ControllerObservationBatch, ControllerStatusMapper, ProfileMappingContext, StatusMappingError,
    StatusRetentionPolicy,
};
pub use managed_process::{DesktopMihomoProcess, DesktopMihomoProcessConfig};
pub use server::{LoopbackServerConfig, LoopbackServerHandle, start_loopback_server};

use std::sync::Arc;

use mish_runtime::{CoreRuntime, MishRuntime};

pub async fn compose_desktop_runtime(
    lifecycle: Arc<dyn CoreRuntime>,
    controller: Option<ControllerObservationConfig>,
) -> Result<MishRuntime, ControllerStatusSourceError> {
    let Some(controller) = controller else {
        return Ok(MishRuntime::new(lifecycle));
    };
    let source = ControllerStatusSource::new(controller, lifecycle.clone())?;
    let runtime = MishRuntime::with_data_sources(lifecycle, source.clone(), source.clone());
    source.start().await;
    Ok(runtime)
}
