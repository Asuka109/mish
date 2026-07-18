use std::{
    fs::File,
    io::{self, Read},
    time::Duration,
};

use futures_util::{FutureExt, future::BoxFuture};

use crate::{ProfileSource, SensitivePath, SensitiveUrl, SourceValidationError};

#[derive(Clone, Eq, PartialEq)]
pub struct RedirectTarget(String);

impl RedirectTarget {
    pub fn parse(value: &str) -> Result<Self, SourceValidationError> {
        let parsed = url::Url::parse(value).map_err(|_| SourceValidationError::InvalidUrl)?;
        if parsed.host_str().is_none() {
            return Err(SourceValidationError::InvalidUrl);
        }
        Ok(Self(parsed.into()))
    }

    pub fn is_https(&self) -> bool {
        url::Url::parse(&self.0).is_ok_and(|url| url.scheme() == "https")
    }

    fn redacted(&self) -> String {
        url::Url::parse(&self.0)
            .ok()
            .and_then(|url| {
                url.host_str()
                    .map(|host| format!("{}://{host}/…", url.scheme()))
            })
            .unwrap_or_else(|| "[redacted redirect target]".to_owned())
    }
}

impl std::fmt::Debug for RedirectTarget {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.redacted())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceReadPolicy {
    pub allowed_content_types: Vec<String>,
    pub max_bytes: usize,
    pub max_redirects: u8,
    pub timeout: Duration,
}

impl Default for SourceReadPolicy {
    fn default() -> Self {
        Self {
            allowed_content_types: vec![
                "application/yaml".to_owned(),
                "application/x-yaml".to_owned(),
                "text/plain".to_owned(),
                "text/yaml".to_owned(),
                "application/octet-stream".to_owned(),
            ],
            max_bytes: 4 * 1024 * 1024,
            max_redirects: 3,
            timeout: Duration::from_secs(15),
        }
    }
}

pub struct SourceContent {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
    pub final_url: Option<RedirectTarget>,
    pub redirects: u8,
}

impl std::fmt::Debug for SourceContent {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SourceContent")
            .field("bytes", &"[redacted]")
            .field("content_type", &self.content_type)
            .field("final_url", &self.final_url)
            .field("redirects", &self.redirects)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SourceReadError {
    #[error("profile source could not be read")]
    Unavailable,
    #[error("profile source exceeded the byte limit")]
    Oversize,
    #[error("profile source request timed out")]
    Timeout,
    #[error("profile source exceeded the redirect limit")]
    TooManyRedirects,
    #[error("profile source redirected to an unsupported scheme")]
    InsecureRedirect,
    #[error("profile source returned an unsupported content type")]
    UnsupportedContentType,
}

pub trait LocalSourceReader: Send + Sync {
    fn read<'a>(
        &'a self,
        path: &'a SensitivePath,
        policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>>;
}

pub trait HttpsSourceReader: Send + Sync {
    fn read<'a>(
        &'a self,
        url: &'a SensitiveUrl,
        policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StdLocalSourceReader;

impl LocalSourceReader for StdLocalSourceReader {
    fn read<'a>(
        &'a self,
        path: &'a SensitivePath,
        policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        async move {
            let file = File::open(path.expose()).map_err(map_read_error)?;
            if file.metadata().map_err(map_read_error)?.len()
                > u64::try_from(policy.max_bytes).unwrap_or(u64::MAX)
            {
                return Err(SourceReadError::Oversize);
            }

            let read_limit = u64::try_from(policy.max_bytes)
                .unwrap_or(u64::MAX)
                .saturating_add(1);
            let mut bytes = Vec::new();
            file.take(read_limit)
                .read_to_end(&mut bytes)
                .map_err(map_read_error)?;
            if bytes.len() > policy.max_bytes {
                return Err(SourceReadError::Oversize);
            }

            Ok(SourceContent {
                bytes,
                content_type: None,
                final_url: None,
                redirects: 0,
            })
        }
        .boxed()
    }
}

fn map_read_error(error: io::Error) -> SourceReadError {
    if error.kind() == io::ErrorKind::TimedOut {
        SourceReadError::Timeout
    } else {
        SourceReadError::Unavailable
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RejectingHttpsSourceReader;

impl HttpsSourceReader for RejectingHttpsSourceReader {
    fn read<'a>(
        &'a self,
        _url: &'a SensitiveUrl,
        _policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        futures_util::future::ready(Err(SourceReadError::Unavailable)).boxed()
    }
}

pub(crate) async fn read_source<L, H>(
    source: &ProfileSource,
    local_reader: &L,
    https_reader: &H,
    policy: &SourceReadPolicy,
) -> Result<SourceContent, SourceReadError>
where
    L: LocalSourceReader,
    H: HttpsSourceReader,
{
    let operation = async {
        match source {
            ProfileSource::LocalFile { path } => local_reader.read(path, policy).await,
            ProfileSource::Https { url } => https_reader.read(url, policy).await,
        }
    };

    tokio::time::timeout(policy.timeout, operation)
        .await
        .map_err(|_| SourceReadError::Timeout)?
}
