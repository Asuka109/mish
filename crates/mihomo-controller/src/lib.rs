mod dto;
mod error;
mod transport;

use std::{
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use bytes::Bytes;
use futures_util::{Stream, StreamExt, stream};
use serde::de::DeserializeOwned;
use tokio_util::sync::CancellationToken;

pub use dto::*;
pub use error::{ControllerError, ControllerErrorKind, Endpoint};
pub use transport::{
    ControllerTransport, HttpTransport, HttpTransportConfig, RawMessageStream,
    shared_http_transport,
};

pub const PINNED_MIHOMO_VERSION: &str = "v1.19.29";

#[derive(Clone, Debug)]
pub struct ControllerLimits {
    pub max_body_bytes: usize,
    pub max_stream_message_bytes: usize,
    pub max_string_bytes: usize,
    pub max_proxies: usize,
    pub max_group_children: usize,
    pub max_history_entries: usize,
    pub max_connections: usize,
    pub max_chain_entries: usize,
    pub max_rules: usize,
    pub max_log_fields: usize,
}

impl Default for ControllerLimits {
    fn default() -> Self {
        Self {
            max_body_bytes: 8 * 1024 * 1024,
            max_stream_message_bytes: 4 * 1024 * 1024,
            max_string_bytes: 16 * 1024,
            max_proxies: 8_192,
            max_group_children: 8_192,
            max_history_entries: 64,
            max_connections: 20_000,
            max_chain_entries: 128,
            max_rules: 100_000,
            max_log_fields: 64,
        }
    }
}

impl ControllerLimits {
    fn validate(&self) -> Result<(), ControllerError> {
        if [
            self.max_body_bytes,
            self.max_stream_message_bytes,
            self.max_string_bytes,
            self.max_proxies,
            self.max_group_children,
            self.max_history_entries,
            self.max_connections,
            self.max_chain_entries,
            self.max_rules,
            self.max_log_fields,
        ]
        .contains(&0)
        {
            return Err(ControllerError::InvalidConfiguration {
                detail: "all controller bounds must be greater than zero".into(),
            });
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct ControllerClient {
    transport: Arc<dyn ControllerTransport>,
    limits: ControllerLimits,
    shutdown: CancellationToken,
}

impl ControllerClient {
    pub fn new(
        transport: Arc<dyn ControllerTransport>,
        limits: ControllerLimits,
    ) -> Result<Self, ControllerError> {
        limits.validate()?;
        Ok(Self {
            transport,
            limits,
            shutdown: CancellationToken::new(),
        })
    }

    pub fn shutdown(&self) {
        self.shutdown.cancel();
    }

    pub fn is_shutdown(&self) -> bool {
        self.shutdown.is_cancelled()
    }

    pub async fn version(&self) -> Result<VersionInfo, ControllerError> {
        self.read(Endpoint::Version).await
    }

    pub async fn verify_version(&self) -> Result<VersionInfo, ControllerError> {
        let version = self.version().await?;
        if version.version != PINNED_MIHOMO_VERSION {
            return Err(ControllerError::UnsupportedVersion {
                expected: PINNED_MIHOMO_VERSION,
                received: version.version,
            });
        }
        Ok(version)
    }

    pub async fn runtime_config(&self) -> Result<RuntimeConfig, ControllerError> {
        self.read(Endpoint::Configs).await
    }

    pub async fn proxies(&self) -> Result<ProxyCatalog, ControllerError> {
        self.read(Endpoint::Proxies).await
    }

    pub async fn connections(&self) -> Result<ConnectionSnapshot, ControllerError> {
        self.read(Endpoint::Connections).await
    }

    pub async fn rules(&self) -> Result<RuleList, ControllerError> {
        self.read(Endpoint::Rules).await
    }

    pub async fn traffic_stream(
        &self,
    ) -> Result<ControllerStream<TrafficSnapshot>, ControllerError> {
        self.open_stream(Endpoint::Traffic).await
    }

    pub async fn traffic_snapshot(&self) -> Result<TrafficSnapshot, ControllerError> {
        self.first_snapshot(Endpoint::Traffic).await
    }

    pub async fn memory_stream(&self) -> Result<ControllerStream<MemorySnapshot>, ControllerError> {
        self.open_stream(Endpoint::Memory).await
    }

    pub async fn memory_snapshot(&self) -> Result<MemorySnapshot, ControllerError> {
        self.first_snapshot(Endpoint::Memory).await
    }

    pub async fn logs_stream(&self) -> Result<ControllerStream<LogMessage>, ControllerError> {
        self.open_stream(Endpoint::Logs).await
    }

    pub async fn connection_stream(
        &self,
    ) -> Result<ControllerStream<ConnectionSnapshot>, ControllerError> {
        self.open_stream(Endpoint::Connections).await
    }

    pub async fn set_routing_mode(&self, mode: RoutingMode) -> Result<(), ControllerError> {
        self.mutate(
            Endpoint::Configs,
            None,
            serde_json::to_vec(&serde_json::json!({ "mode": mode }))
                .expect("routing mode command must serialize"),
        )
        .await
    }

    pub async fn select_group_child(
        &self,
        group: &str,
        child: &str,
    ) -> Result<(), ControllerError> {
        self.validate_command_label("group", group)?;
        self.validate_command_label("child", child)?;
        self.mutate(
            Endpoint::Proxies,
            Some(group.to_owned()),
            serde_json::to_vec(&serde_json::json!({ "name": child }))
                .expect("group selection command must serialize"),
        )
        .await
    }

    pub async fn close_connection(&self, connection_id: &str) -> Result<(), ControllerError> {
        self.validate_connection_id(connection_id)?;
        self.delete(Endpoint::Connections, Some(connection_id.to_owned()))
            .await
    }

    pub async fn close_all_connections(&self) -> Result<(), ControllerError> {
        self.delete(Endpoint::Connections, None).await
    }

    fn validate_connection_id(&self, connection_id: &str) -> Result<(), ControllerError> {
        if connection_id.is_empty() || connection_id.len() > self.limits.max_string_bytes {
            return Err(ControllerError::Validation {
                endpoint: Endpoint::Connections,
                field: "connectionId",
                detail: "connection ID must be non-empty and within the configured bound".into(),
            });
        }
        Ok(())
    }

    fn validate_command_label(
        &self,
        field: &'static str,
        value: &str,
    ) -> Result<(), ControllerError> {
        if value.is_empty() || value.len() > self.limits.max_string_bytes {
            return Err(ControllerError::Validation {
                endpoint: Endpoint::Proxies,
                field,
                detail: "command label must be non-empty and within the configured bound".into(),
            });
        }
        Ok(())
    }

    async fn mutate(
        &self,
        endpoint: Endpoint,
        path_segment: Option<String>,
        body: Vec<u8>,
    ) -> Result<(), ControllerError> {
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err(ControllerError::Shutdown { endpoint }),
            result = self.transport.put(endpoint, path_segment, Bytes::from(body), self.limits.max_body_bytes) => result,
        }
    }

    async fn delete(
        &self,
        endpoint: Endpoint,
        path_segment: Option<String>,
    ) -> Result<(), ControllerError> {
        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => Err(ControllerError::Shutdown { endpoint }),
            result = self.transport.delete(endpoint, path_segment) => result,
        }
    }

    async fn read<T>(&self, endpoint: Endpoint) -> Result<T, ControllerError>
    where
        T: DeserializeOwned + Validate,
    {
        let body = tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => return Err(ControllerError::Shutdown { endpoint }),
            result = self.transport.get(endpoint, self.limits.max_body_bytes) => result?,
        };
        decode(body, endpoint, &self.limits, false)
    }

    async fn open_stream<T>(
        &self,
        endpoint: Endpoint,
    ) -> Result<ControllerStream<T>, ControllerError>
    where
        T: DeserializeOwned + Validate + Send + 'static,
    {
        let raw = tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => return Err(ControllerError::Shutdown { endpoint }),
            result = self.transport.stream(endpoint, self.limits.max_stream_message_bytes) => result?,
        };
        let cancellation = CancellationToken::new();
        let state = StreamState {
            raw,
            endpoint,
            limits: self.limits.clone(),
            shutdown: self.shutdown.clone(),
            cancellation: cancellation.clone(),
        };
        let inner = stream::unfold(state, |mut state| async move {
            let message = tokio::select! {
                biased;
                _ = state.shutdown.cancelled() => return None,
                _ = state.cancellation.cancelled() => return None,
                message = state.raw.next() => message,
            }?;
            let item = message.and_then(|bytes| decode(bytes, state.endpoint, &state.limits, true));
            Some((item, state))
        });
        Ok(ControllerStream {
            inner: Box::pin(inner),
            cancellation,
        })
    }

    async fn first_snapshot<T>(&self, endpoint: Endpoint) -> Result<T, ControllerError>
    where
        T: DeserializeOwned + Validate + Send + 'static,
    {
        let mut stream = self.open_stream(endpoint).await?;
        match stream.next().await {
            Some(snapshot) => snapshot,
            None if self.shutdown.is_cancelled() => Err(ControllerError::Shutdown { endpoint }),
            None => Err(ControllerError::StreamEnded { endpoint }),
        }
    }
}

struct StreamState {
    raw: RawMessageStream,
    endpoint: Endpoint,
    limits: ControllerLimits,
    shutdown: CancellationToken,
    cancellation: CancellationToken,
}

pub struct ControllerStream<T> {
    inner: Pin<Box<dyn Stream<Item = Result<T, ControllerError>> + Send>>,
    cancellation: CancellationToken,
}

impl<T> ControllerStream<T> {
    pub fn cancel(&self) {
        self.cancellation.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }
}

impl<T> Stream for ControllerStream<T> {
    type Item = Result<T, ControllerError>;

    fn poll_next(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(context)
    }
}

impl<T> Drop for ControllerStream<T> {
    fn drop(&mut self) {
        self.cancellation.cancel();
    }
}

fn decode<T>(
    bytes: Bytes,
    endpoint: Endpoint,
    limits: &ControllerLimits,
    stream_message: bool,
) -> Result<T, ControllerError>
where
    T: DeserializeOwned + Validate,
{
    let limit = if stream_message {
        limits.max_stream_message_bytes
    } else {
        limits.max_body_bytes
    };
    if bytes.len() > limit {
        return Err(if stream_message {
            ControllerError::MessageTooLarge { endpoint, limit }
        } else {
            ControllerError::BodyTooLarge { endpoint, limit }
        });
    }
    let value: T = serde_json::from_slice(&bytes).map_err(|error| ControllerError::Decode {
        endpoint,
        detail: error.to_string(),
    })?;
    value.validate(endpoint, limits)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use bytes::Bytes;
    use futures_util::{FutureExt, stream};

    use super::*;

    struct FixedTransport {
        unary: Bytes,
        streamed: Bytes,
    }

    impl ControllerTransport for FixedTransport {
        fn delete(
            &self,
            _endpoint: Endpoint,
            _path_segment: Option<String>,
        ) -> futures_util::future::BoxFuture<'_, Result<(), ControllerError>> {
            std::future::ready(Ok(())).boxed()
        }

        fn get(
            &self,
            _endpoint: Endpoint,
            _max_body_bytes: usize,
        ) -> futures_util::future::BoxFuture<'_, Result<Bytes, ControllerError>> {
            std::future::ready(Ok(self.unary.clone())).boxed()
        }

        fn stream(
            &self,
            _endpoint: Endpoint,
            _max_message_bytes: usize,
        ) -> futures_util::future::BoxFuture<'_, Result<RawMessageStream, ControllerError>>
        {
            let item = self.streamed.clone();
            async move { Ok(Box::pin(stream::iter([Ok(item)])) as RawMessageStream) }.boxed()
        }

        fn put(
            &self,
            _endpoint: Endpoint,
            _path_segment: Option<String>,
            _body: Bytes,
            _max_body_bytes: usize,
        ) -> futures_util::future::BoxFuture<'_, Result<(), ControllerError>> {
            std::future::ready(Ok(())).boxed()
        }
    }

    #[tokio::test]
    async fn validates_even_when_a_custom_transport_ignores_body_limits() {
        let transport = Arc::new(FixedTransport {
            unary: Bytes::from_static(br#"{"meta":true,"version":"v1.19.29"}"#),
            streamed: Bytes::new(),
        });
        let limits = ControllerLimits {
            max_body_bytes: 8,
            ..ControllerLimits::default()
        };
        let client = ControllerClient::new(transport, limits).unwrap();

        let error = client.version().await.unwrap_err();

        assert_eq!(error.kind(), ControllerErrorKind::BodyTooLarge);
    }

    #[tokio::test]
    async fn stream_cancel_ends_a_subscription_without_affecting_the_client() {
        let transport = Arc::new(FixedTransport {
            unary: Bytes::from_static(br#"{"meta":true,"version":"v1.19.29"}"#),
            streamed: Bytes::from_static(br#"{"up":1,"down":2,"upTotal":3,"downTotal":4}"#),
        });
        let client = ControllerClient::new(transport, ControllerLimits::default()).unwrap();
        let mut traffic = client.traffic_stream().await.unwrap();
        traffic.cancel();

        assert!(traffic.next().await.is_none());
        assert_eq!(client.version().await.unwrap().version, "v1.19.29");
    }

    #[tokio::test]
    async fn validates_stream_limits_even_for_custom_transports() {
        let transport = Arc::new(FixedTransport {
            unary: Bytes::new(),
            streamed: Bytes::from_static(br#"{"up":1,"down":2,"upTotal":3,"downTotal":4}"#),
        });
        let limits = ControllerLimits {
            max_stream_message_bytes: 8,
            ..ControllerLimits::default()
        };
        let client = ControllerClient::new(transport, limits).unwrap();
        let mut traffic = client.traffic_stream().await.unwrap();

        assert_eq!(
            traffic.next().await.unwrap().unwrap_err().kind(),
            ControllerErrorKind::MessageTooLarge
        );
    }

    #[tokio::test]
    async fn shutdown_rejects_new_reads() {
        let transport = Arc::new(FixedTransport {
            unary: Bytes::from_static(br#"{"meta":true,"version":"v1.19.29"}"#),
            streamed: Bytes::new(),
        });
        let client = ControllerClient::new(transport, ControllerLimits::default()).unwrap();
        client.shutdown();

        assert_eq!(
            client.version().await.unwrap_err().kind(),
            ControllerErrorKind::Shutdown
        );
    }

    #[tokio::test]
    async fn reports_a_version_outside_the_pinned_contract() {
        let transport = Arc::new(FixedTransport {
            unary: Bytes::from_static(br#"{"meta":true,"version":"v1.20.0"}"#),
            streamed: Bytes::new(),
        });
        let client = ControllerClient::new(transport, ControllerLimits::default()).unwrap();

        assert_eq!(
            client.verify_version().await.unwrap_err().kind(),
            ControllerErrorKind::UnsupportedVersion
        );
    }
}
