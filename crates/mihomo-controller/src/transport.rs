use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use bytes::{Bytes, BytesMut};
use futures_util::{
    StreamExt, TryStreamExt,
    future::BoxFuture,
    stream::{self, BoxStream},
};
use reqwest::StatusCode;
use tokio::{
    sync::{Notify, mpsc},
    time::{sleep, timeout},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        self, client::IntoClientRequest, http::header::AUTHORIZATION, protocol::WebSocketConfig,
    },
};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{ControllerError, Endpoint};

pub type RawMessageStream = BoxStream<'static, Result<Bytes, ControllerError>>;

const WEBSOCKET_ABORT_SETTLE: Duration = Duration::from_millis(100);
const WEBSOCKET_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
const WEBSOCKET_MESSAGE_BUFFER: usize = 16;
const HTTP_POOL_ABORT_SETTLE: Duration = Duration::from_millis(250);
const HTTP_POOL_IDLE_TIMEOUT: Duration = Duration::from_millis(100);

pub trait ControllerTransport: Send + Sync {
    fn quiesce(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }

    fn delete(
        &self,
        endpoint: Endpoint,
        path_segment: Option<String>,
    ) -> BoxFuture<'_, Result<(), ControllerError>>;

    fn get(
        &self,
        endpoint: Endpoint,
        max_body_bytes: usize,
    ) -> BoxFuture<'_, Result<Bytes, ControllerError>>;

    fn patch(
        &self,
        endpoint: Endpoint,
        body: Bytes,
        max_body_bytes: usize,
    ) -> BoxFuture<'_, Result<(), ControllerError>>;

    fn stream(
        &self,
        endpoint: Endpoint,
        max_message_bytes: usize,
    ) -> BoxFuture<'_, Result<RawMessageStream, ControllerError>>;

    fn put(
        &self,
        endpoint: Endpoint,
        path_segment: Option<String>,
        body: Bytes,
        max_body_bytes: usize,
    ) -> BoxFuture<'_, Result<(), ControllerError>>;

    fn proxy_delay(
        &self,
        proxy: String,
        url: String,
        timeout_milliseconds: u16,
        expected_status: String,
        max_body_bytes: usize,
    ) -> BoxFuture<'_, Result<Bytes, ControllerError>> {
        let _ = (
            proxy,
            url,
            timeout_milliseconds,
            expected_status,
            max_body_bytes,
        );
        Box::pin(async {
            Err(ControllerError::InvalidConfiguration {
                detail: "the injected Controller transport does not support delay tests".into(),
            })
        })
    }
}

pub struct HttpTransportConfig {
    pub base_url: Url,
    pub secret: Option<String>,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
}

impl HttpTransportConfig {
    pub fn new(base_url: Url) -> Self {
        Self {
            base_url,
            secret: None,
            connect_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(10),
        }
    }
}

pub struct HttpTransport {
    base_url: Url,
    authorization: Option<String>,
    client: RwLock<reqwest::Client>,
    connect_timeout: Duration,
    request_timeout: Duration,
    websocket_sessions: Arc<WebSocketSessionRegistry>,
}

#[derive(Default)]
struct WebSocketSessionRegistry {
    drained: Notify,
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, CancellationToken>>,
}

impl WebSocketSessionRegistry {
    fn register(self: &Arc<Self>) -> (CancellationToken, WebSocketSessionRegistration) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let cancellation = CancellationToken::new();
        self.sessions
            .lock()
            .expect("Controller WebSocket session registry poisoned")
            .insert(id, cancellation.clone());
        (
            cancellation,
            WebSocketSessionRegistration {
                id,
                registry: self.clone(),
            },
        )
    }

    async fn quiesce(&self) {
        let sessions = self
            .sessions
            .lock()
            .expect("Controller WebSocket session registry poisoned")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for cancellation in sessions {
            cancellation.cancel();
        }
        let _ = timeout(WEBSOCKET_DRAIN_TIMEOUT, async {
            loop {
                let drained = self.drained.notified();
                if self
                    .sessions
                    .lock()
                    .expect("Controller WebSocket session registry poisoned")
                    .is_empty()
                {
                    return;
                }
                drained.await;
            }
        })
        .await;
    }
}

struct WebSocketSessionRegistration {
    id: u64,
    registry: Arc<WebSocketSessionRegistry>,
}

impl Drop for WebSocketSessionRegistration {
    fn drop(&mut self) {
        self.registry
            .sessions
            .lock()
            .expect("Controller WebSocket session registry poisoned")
            .remove(&self.id);
        self.registry.drained.notify_waiters();
    }
}

struct WebSocketStreamCancellation(CancellationToken);

impl Drop for WebSocketStreamCancellation {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl std::fmt::Debug for HttpTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpTransport")
            .field("base_url", &"<redacted>")
            .field("authenticated", &self.authorization.is_some())
            .field("connect_timeout", &self.connect_timeout)
            .field("request_timeout", &self.request_timeout)
            .finish()
    }
}

impl HttpTransport {
    pub fn new(mut config: HttpTransportConfig) -> Result<Self, ControllerError> {
        if !matches!(config.base_url.scheme(), "http" | "https") {
            return Err(ControllerError::InvalidConfiguration {
                detail: "base URL scheme must be http or https".into(),
            });
        }
        if config.base_url.host_str().is_none()
            || !config.base_url.username().is_empty()
            || config.base_url.password().is_some()
            || config.base_url.query().is_some()
            || config.base_url.fragment().is_some()
        {
            return Err(ControllerError::InvalidConfiguration {
                detail: "base URL must contain an authority and no credentials, query, or fragment"
                    .into(),
            });
        }
        if config.connect_timeout.is_zero() || config.request_timeout.is_zero() {
            return Err(ControllerError::InvalidConfiguration {
                detail: "transport timeouts must be greater than zero".into(),
            });
        }
        if !config.base_url.path().ends_with('/') {
            let mut path = config.base_url.path().to_owned();
            path.push('/');
            config.base_url.set_path(&path);
        }

        let authorization = match config.secret {
            Some(secret) => {
                if secret.contains(['\r', '\n']) {
                    return Err(ControllerError::InvalidConfiguration {
                        detail: "controller secret contained invalid header characters".into(),
                    });
                }
                Some(format!("Bearer {secret}"))
            }
            None => None,
        };
        let client = Self::build_client(config.connect_timeout)?;

        Ok(Self {
            base_url: config.base_url,
            authorization,
            client: RwLock::new(client),
            connect_timeout: config.connect_timeout,
            request_timeout: config.request_timeout,
            websocket_sessions: Arc::new(WebSocketSessionRegistry::default()),
        })
    }

    fn build_client(connect_timeout: Duration) -> Result<reqwest::Client, ControllerError> {
        reqwest::Client::builder()
            .connect_timeout(connect_timeout)
            .pool_idle_timeout(HTTP_POOL_IDLE_TIMEOUT)
            .build()
            .map_err(|_| ControllerError::InvalidConfiguration {
                detail: "HTTP client could not be constructed".into(),
            })
    }

    fn client(&self) -> reqwest::Client {
        self.client
            .read()
            .expect("Controller HTTP client lock poisoned")
            .clone()
    }

    fn endpoint_url(&self, endpoint: Endpoint) -> Result<Url, ControllerError> {
        self.base_url
            .join(endpoint.path().trim_start_matches('/'))
            .map_err(|_| ControllerError::InvalidConfiguration {
                detail: "controller endpoint URL could not be constructed".into(),
            })
    }

    fn request(&self, endpoint: Endpoint) -> Result<reqwest::RequestBuilder, ControllerError> {
        let mut request = self.client().get(self.endpoint_url(endpoint)?);
        if let Some(authorization) = &self.authorization {
            request = request.header(reqwest::header::AUTHORIZATION, authorization);
        }
        Ok(request)
    }

    fn mutation_url(
        &self,
        endpoint: Endpoint,
        path_segment: Option<&str>,
    ) -> Result<Url, ControllerError> {
        let mut url = self.endpoint_url(endpoint)?;
        if let Some(segment) = path_segment {
            url.path_segments_mut()
                .map_err(|_| ControllerError::InvalidConfiguration {
                    detail: "controller mutation URL could not be constructed".into(),
                })?
                .push(segment);
        }
        Ok(url)
    }

    fn authorize(&self, mut request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        if let Some(authorization) = &self.authorization {
            request = request.header(reqwest::header::AUTHORIZATION, authorization);
        }
        request
    }

    fn proxy_delay_request(
        &self,
        proxy: &str,
        test_url: &str,
        timeout_milliseconds: u16,
        expected_status: &str,
    ) -> Result<reqwest::RequestBuilder, ControllerError> {
        let mut url = self.endpoint_url(Endpoint::Proxies)?;
        url.path_segments_mut()
            .map_err(|_| ControllerError::InvalidConfiguration {
                detail: "controller delay URL could not be constructed".into(),
            })?
            .push(proxy)
            .push("delay");
        url.query_pairs_mut()
            .append_pair("url", test_url)
            .append_pair("timeout", &timeout_milliseconds.to_string())
            .append_pair("expected", expected_status);
        let mut request = self.client().get(url);
        if let Some(authorization) = &self.authorization {
            request = request.header(reqwest::header::AUTHORIZATION, authorization);
        }
        Ok(request)
    }

    fn websocket_request(
        &self,
        endpoint: Endpoint,
    ) -> Result<tungstenite::http::Request<()>, ControllerError> {
        let mut url = self.endpoint_url(endpoint)?;
        let websocket_scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(websocket_scheme)
            .map_err(|_| ControllerError::InvalidConfiguration {
                detail: "controller WebSocket URL could not be constructed".into(),
            })?;
        let mut request = url.as_str().into_client_request().map_err(|_| {
            ControllerError::InvalidConfiguration {
                detail: "controller WebSocket request could not be constructed".into(),
            }
        })?;
        if let Some(authorization) = &self.authorization {
            let value =
                authorization
                    .parse()
                    .map_err(|_| ControllerError::InvalidConfiguration {
                        detail: "controller authorization header was invalid".into(),
                    })?;
            request.headers_mut().insert(AUTHORIZATION, value);
        }
        Ok(request)
    }
}

impl ControllerTransport for HttpTransport {
    fn quiesce(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if let Ok(replacement) = Self::build_client(self.connect_timeout) {
                let retired = std::mem::replace(
                    &mut *self
                        .client
                        .write()
                        .expect("Controller HTTP client lock poisoned"),
                    replacement,
                );
                drop(retired);
            }
            self.websocket_sessions.quiesce().await;
            sleep(HTTP_POOL_ABORT_SETTLE).await;
        })
    }

    fn delete(
        &self,
        endpoint: Endpoint,
        path_segment: Option<String>,
    ) -> BoxFuture<'_, Result<(), ControllerError>> {
        Box::pin(async move {
            let operation = async {
                let request = self
                    .client()
                    .delete(self.mutation_url(endpoint, path_segment.as_deref())?);
                let response = self.authorize(request).send().await.map_err(|error| {
                    ControllerError::transport(endpoint, error.without_url().to_string())
                })?;
                ensure_success(endpoint, response.status())
            };
            timeout(self.request_timeout, operation)
                .await
                .map_err(|_| ControllerError::Timeout { endpoint })?
        })
    }

    fn get(
        &self,
        endpoint: Endpoint,
        max_body_bytes: usize,
    ) -> BoxFuture<'_, Result<Bytes, ControllerError>> {
        Box::pin(async move {
            let operation = async {
                let response = self.request(endpoint)?.send().await.map_err(|error| {
                    ControllerError::transport(endpoint, error.without_url().to_string())
                })?;
                ensure_success(endpoint, response.status())?;
                if response
                    .content_length()
                    .is_some_and(|length| length > max_body_bytes as u64)
                {
                    return Err(ControllerError::BodyTooLarge {
                        endpoint,
                        limit: max_body_bytes,
                    });
                }

                let mut body = BytesMut::new();
                let mut chunks = response.bytes_stream();
                while let Some(chunk) = chunks.try_next().await.map_err(|error| {
                    ControllerError::transport(endpoint, error.without_url().to_string())
                })? {
                    if body.len().saturating_add(chunk.len()) > max_body_bytes {
                        return Err(ControllerError::BodyTooLarge {
                            endpoint,
                            limit: max_body_bytes,
                        });
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(body.freeze())
            };

            timeout(self.request_timeout, operation)
                .await
                .map_err(|_| ControllerError::Timeout { endpoint })?
        })
    }

    fn stream(
        &self,
        endpoint: Endpoint,
        max_message_bytes: usize,
    ) -> BoxFuture<'_, Result<RawMessageStream, ControllerError>> {
        Box::pin(async move {
            let request = self.websocket_request(endpoint)?;
            let mut websocket_config = WebSocketConfig::default();
            websocket_config.max_message_size = Some(max_message_bytes);
            websocket_config.max_frame_size = Some(max_message_bytes);
            let (mut socket, _) = timeout(
                self.connect_timeout,
                connect_async_with_config(request, Some(websocket_config), false),
            )
            .await
            .map_err(|_| ControllerError::Timeout { endpoint })?
            .map_err(|error| websocket_error(endpoint, error))?;
            let (session_cancellation, registration) = self.websocket_sessions.register();
            let stream_cancellation = session_cancellation.clone();
            let (sender, receiver) = mpsc::channel(WEBSOCKET_MESSAGE_BUFFER);
            tokio::spawn(async move {
                let _registration = registration;
                'messages: loop {
                    tokio::select! {
                        biased;
                        _ = session_cancellation.cancelled() => {
                            let _ = socket.get_mut().get_ref().set_zero_linger();
                            drop(socket);
                            sleep(WEBSOCKET_ABORT_SETTLE).await;
                            break;
                        }
                        message = socket.next() => {
                            let item = match message {
                                Some(Ok(tungstenite::Message::Text(text))) => {
                                    Some(check_message_size(
                                        endpoint,
                                        Bytes::copy_from_slice(text.as_bytes()),
                                        max_message_bytes,
                                    ))
                                }
                                Some(Ok(tungstenite::Message::Binary(bytes))) => {
                                    Some(check_message_size(endpoint, bytes, max_message_bytes))
                                }
                                Some(Ok(tungstenite::Message::Close(_))) | None => break,
                                Some(Ok(_)) => None,
                                Some(Err(error)) => Some(Err(websocket_error(endpoint, error))),
                            };
                            if let Some(item) = item {
                                tokio::select! {
                                    biased;
                                    _ = session_cancellation.cancelled() => {
                                        let _ = socket.get_mut().get_ref().set_zero_linger();
                                        drop(socket);
                                        sleep(WEBSOCKET_ABORT_SETTLE).await;
                                        break 'messages;
                                    }
                                    sent = sender.send(item) => {
                                        if sent.is_err() {
                                            let _ = socket.get_mut().get_ref().set_zero_linger();
                                            drop(socket);
                                            sleep(WEBSOCKET_ABORT_SETTLE).await;
                                            break 'messages;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });
            let messages = stream::unfold(
                (receiver, WebSocketStreamCancellation(stream_cancellation)),
                |(mut receiver, cancellation)| async move {
                    receiver
                        .recv()
                        .await
                        .map(|message| (message, (receiver, cancellation)))
                },
            );
            Ok(Box::pin(messages) as RawMessageStream)
        })
    }

    fn patch(
        &self,
        endpoint: Endpoint,
        body: Bytes,
        max_body_bytes: usize,
    ) -> BoxFuture<'_, Result<(), ControllerError>> {
        Box::pin(async move {
            let operation = async {
                if body.len() > max_body_bytes {
                    return Err(ControllerError::BodyTooLarge {
                        endpoint,
                        limit: max_body_bytes,
                    });
                }
                let request = self
                    .client()
                    .patch(self.mutation_url(endpoint, None)?)
                    .body(body)
                    .header(reqwest::header::CONTENT_TYPE, "application/json");
                let response = self.authorize(request).send().await.map_err(|error| {
                    ControllerError::transport(endpoint, error.without_url().to_string())
                })?;
                ensure_success(endpoint, response.status())
            };
            timeout(self.request_timeout, operation)
                .await
                .map_err(|_| ControllerError::Timeout { endpoint })?
        })
    }

    fn put(
        &self,
        endpoint: Endpoint,
        path_segment: Option<String>,
        body: Bytes,
        max_body_bytes: usize,
    ) -> BoxFuture<'_, Result<(), ControllerError>> {
        Box::pin(async move {
            let operation = async {
                if body.len() > max_body_bytes {
                    return Err(ControllerError::BodyTooLarge {
                        endpoint,
                        limit: max_body_bytes,
                    });
                }
                let request = self
                    .client()
                    .put(self.mutation_url(endpoint, path_segment.as_deref())?)
                    .body(body)
                    .header(reqwest::header::CONTENT_TYPE, "application/json");
                let response = self.authorize(request).send().await.map_err(|error| {
                    ControllerError::transport(endpoint, error.without_url().to_string())
                })?;
                ensure_success(endpoint, response.status())
            };
            timeout(self.request_timeout, operation)
                .await
                .map_err(|_| ControllerError::Timeout { endpoint })?
        })
    }

    fn proxy_delay(
        &self,
        proxy: String,
        url: String,
        timeout_milliseconds: u16,
        expected_status: String,
        max_body_bytes: usize,
    ) -> BoxFuture<'_, Result<Bytes, ControllerError>> {
        Box::pin(async move {
            let operation = async {
                let response = self
                    .proxy_delay_request(&proxy, &url, timeout_milliseconds, &expected_status)?
                    .send()
                    .await
                    .map_err(|error| {
                        ControllerError::transport(
                            Endpoint::Proxies,
                            error.without_url().to_string(),
                        )
                    })?;
                ensure_success(Endpoint::Proxies, response.status())?;
                if response
                    .content_length()
                    .is_some_and(|length| length > max_body_bytes as u64)
                {
                    return Err(ControllerError::BodyTooLarge {
                        endpoint: Endpoint::Proxies,
                        limit: max_body_bytes,
                    });
                }
                let mut body = BytesMut::new();
                let mut chunks = response.bytes_stream();
                while let Some(chunk) = chunks.try_next().await.map_err(|error| {
                    ControllerError::transport(Endpoint::Proxies, error.without_url().to_string())
                })? {
                    if body.len().saturating_add(chunk.len()) > max_body_bytes {
                        return Err(ControllerError::BodyTooLarge {
                            endpoint: Endpoint::Proxies,
                            limit: max_body_bytes,
                        });
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(body.freeze())
            };
            timeout(self.request_timeout, operation)
                .await
                .map_err(|_| ControllerError::Timeout {
                    endpoint: Endpoint::Proxies,
                })?
        })
    }
}

fn ensure_success(endpoint: Endpoint, status: StatusCode) -> Result<(), ControllerError> {
    if status.is_success() {
        Ok(())
    } else {
        Err(ControllerError::HttpStatus {
            endpoint,
            status: status.as_u16(),
        })
    }
}

fn check_message_size(
    endpoint: Endpoint,
    bytes: Bytes,
    max_message_bytes: usize,
) -> Result<Bytes, ControllerError> {
    if bytes.len() > max_message_bytes {
        Err(ControllerError::MessageTooLarge {
            endpoint,
            limit: max_message_bytes,
        })
    } else {
        Ok(bytes)
    }
}

fn websocket_error(endpoint: Endpoint, error: tungstenite::Error) -> ControllerError {
    if let tungstenite::Error::Http(response) = &error {
        return ControllerError::HttpStatus {
            endpoint,
            status: response.status().as_u16(),
        };
    }
    ControllerError::transport(endpoint, error.to_string())
}

pub fn shared_http_transport(
    config: HttpTransportConfig,
) -> Result<Arc<dyn ControllerTransport>, ControllerError> {
    Ok(Arc::new(HttpTransport::new(config)?))
}
