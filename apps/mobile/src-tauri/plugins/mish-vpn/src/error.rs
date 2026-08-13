use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[cfg(target_os = "android")]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[cfg(target_os = "android")]
    #[error("Android platform facts failed the checked wire schema")]
    PlatformFactsSchemaRejected,
    #[cfg(target_os = "android")]
    #[error("Android VPN lifecycle cleanup is still pending before replacement")]
    LifecycleRetirementPending,
    #[cfg(target_os = "android")]
    #[error("Android Traffic observation failed the checked wire schema")]
    TrafficObservationRejected,
    #[error("Android Routes authority is unavailable until a committed Profile is loaded")]
    RoutesUnavailable,
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
