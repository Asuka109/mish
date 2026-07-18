use std::{
    fmt,
    sync::{Arc, Weak},
};

use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CorePhase {
    Stopped,
    Starting,
    Running,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    pub error: Option<String>,
    pub phase: CorePhase,
    pub pid: Option<u32>,
    pub version: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusAdapterKind {
    Native,
    Rpc,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CoreErrorKind {
    Unavailable,
    StartFailed,
    StopFailed,
}

#[derive(Clone, Debug)]
pub struct CoreError {
    pub kind: CoreErrorKind,
    message: String,
}

struct RuntimeStatusEvents {
    updates: broadcast::Sender<CoreStatus>,
}

#[derive(Clone)]
pub struct CoreStatusEventSink {
    events: Weak<RuntimeStatusEvents>,
}

impl CoreStatusEventSink {
    pub fn publish(&self, status: CoreStatus) {
        let Some(events) = self.events.upgrade() else {
            return;
        };
        let _ = events.updates.send(status);
    }
}

impl CoreError {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            kind: CoreErrorKind::Unavailable,
            message: message.into(),
        }
    }

    pub fn start_failed(message: impl Into<String>) -> Self {
        Self {
            kind: CoreErrorKind::StartFailed,
            message: message.into(),
        }
    }

    pub fn stop_failed(message: impl Into<String>) -> Self {
        Self {
            kind: CoreErrorKind::StopFailed,
            message: message.into(),
        }
    }
}

impl fmt::Display for CoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CoreError {}

pub trait CoreRuntime: Send + Sync {
    fn attach_status_event_sink(&self, _sink: CoreStatusEventSink) {}
    fn configured(&self) -> bool;
    fn status(&self) -> BoxFuture<'_, CoreStatus>;
    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>>;
    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>>;
}

#[derive(Clone)]
pub struct MishRuntime {
    core: Arc<dyn CoreRuntime>,
    events: Arc<RuntimeStatusEvents>,
}

impl MishRuntime {
    pub fn new(core: Arc<dyn CoreRuntime>) -> Self {
        let (updates, _) = broadcast::channel(32);
        let events = Arc::new(RuntimeStatusEvents { updates });
        core.attach_status_event_sink(CoreStatusEventSink {
            events: Arc::downgrade(&events),
        });
        Self { core, events }
    }

    pub fn core_configured(&self) -> bool {
        self.core.configured()
    }

    pub async fn core_status(&self) -> CoreStatus {
        self.core.status().await
    }

    pub async fn start_core(&self) -> Result<CoreStatus, CoreError> {
        let status = self.core.start().await?;
        self.publish_status(&status);
        Ok(status)
    }

    pub async fn stop_core(&self) -> Result<CoreStatus, CoreError> {
        let status = self.core.stop().await?;
        self.publish_status(&status);
        Ok(status)
    }

    pub async fn status_snapshot(&self, adapter_kind: StatusAdapterKind) -> Value {
        self.snapshot_from_status(&self.core.status().await, adapter_kind)
    }

    pub fn snapshot_from_status(
        &self,
        status: &CoreStatus,
        adapter_kind: StatusAdapterKind,
    ) -> Value {
        status_snapshot(status, adapter_kind)
    }

    pub fn subscribe_status(&self) -> broadcast::Receiver<CoreStatus> {
        self.events.updates.subscribe()
    }

    fn publish_status(&self, status: &CoreStatus) {
        let _ = self.events.updates.send(status.clone());
    }
}

fn status_snapshot(core: &CoreStatus, adapter_kind: StatusAdapterKind) -> Value {
    let (phase, message) = match core.phase {
        CorePhase::Stopped => ("inactive", "Mihomo is stopped"),
        CorePhase::Starting => ("connecting", "Mihomo is starting"),
        CorePhase::Running => ("healthy", "Mihomo is running"),
        CorePhase::Stopping => ("stopping", "Mihomo is stopping"),
        CorePhase::Failed => ("error", "Mihomo failed"),
    };
    json!({
        "activeProfileId": "local",
        "adapterKind": adapter_kind,
        "capabilities": {"systemProxy": "unavailable", "tun": "unavailable"},
        "groups": [], "groupUsage": [],
        "metrics": {"activeConnections": 0, "effectiveRules": 0, "memoryBytes": 0, "uptimeSeconds": 0},
        "nodes": [], "probeResults": [],
        "profiles": [{"id": "local", "label": "Local Mihomo"}],
        "routingMode": "rule",
        "runtime": {
            "captureSelection": {"systemProxy": true, "tun": false},
            "message": message,
            "phase": phase,
            "systemProxyEnabled": false,
            "tunEnabled": false
        },
        "services": default_services(),
        "traffic": {"downloadBytesPerSecond": 0, "downloadSeries": [], "downloadedBytes": 0, "uploadBytesPerSecond": 0, "uploadSeries": [], "uploadedBytes": 0}
    })
}

fn default_services() -> Value {
    json!([
        {
            "icon": "google",
            "id": "google",
            "label": "Google",
            "url": "https://www.google.com/generate_204"
        },
        {
            "icon": "github",
            "id": "github",
            "label": "GitHub",
            "url": "https://github.com"
        },
        {
            "icon": "cloudflare",
            "id": "cloudflare",
            "label": "Cloudflare",
            "url": "https://cp.cloudflare.com/generate_204"
        },
        {
            "icon": "baidu",
            "id": "baidu",
            "label": "Baidu",
            "url": "https://www.baidu.com"
        },
        {
            "icon": "apple",
            "id": "apple",
            "label": "Apple",
            "url": "https://www.apple.com/library/test/success.html"
        },
        {
            "icon": "microsoft",
            "id": "microsoft",
            "label": "Microsoft",
            "url": "https://www.msftconnecttest.com/connecttest.txt"
        }
    ])
}
