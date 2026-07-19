use std::path::PathBuf;

use bytes::Bytes;
use futures_util::{FutureExt, Stream, StreamExt, future::BoxFuture};
use mish_profile::{
    HttpsSourceReader, ProfileService, RedirectTarget, SensitiveUrl, SourceContent,
    SourceReadError, SourceReadPolicy, StdLocalSourceReader,
};
use mish_state_authority::StateMutationAuthority;
use reqwest::{Client, Url, header};

pub type DesktopProfileService = ProfileService<StdLocalSourceReader, ReqwestHttpsSourceReader>;

#[derive(Clone, Debug)]
pub struct ReqwestHttpsSourceReader {
    client: Client,
}

impl ReqwestHttpsSourceReader {
    pub fn new() -> Result<Self, SourceReadError> {
        let client = Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| SourceReadError::Unavailable)?;
        Ok(Self { client })
    }

    pub fn profile_service(root: PathBuf) -> Result<DesktopProfileService, SourceReadError> {
        Self::profile_service_with_authority(root, StateMutationAuthority::new())
    }

    pub fn profile_service_with_authority(
        root: PathBuf,
        authority: StateMutationAuthority,
    ) -> Result<DesktopProfileService, SourceReadError> {
        Ok(ProfileService::with_authority(
            root,
            StdLocalSourceReader,
            Self::new()?,
            SourceReadPolicy::default(),
            authority,
        ))
    }

    async fn read_response(
        &self,
        source: &SensitiveUrl,
        policy: &SourceReadPolicy,
    ) -> Result<SourceContent, SourceReadError> {
        let mut current = Url::parse(source.expose()).map_err(|_| SourceReadError::Unavailable)?;
        let mut redirects = 0_u8;

        loop {
            let response = self
                .client
                .get(current.clone())
                .header(
                    header::ACCEPT,
                    "application/yaml, application/x-yaml, text/yaml, text/plain, application/octet-stream",
                )
                .timeout(policy.timeout)
                .send()
                .await
                .map_err(map_reqwest_error)?;

            if response.status().is_redirection() {
                if redirects >= policy.max_redirects {
                    return Err(SourceReadError::TooManyRedirects);
                }
                current = redirect_target(&current, response.headers())?;
                redirects += 1;
                continue;
            }
            if !response.status().is_success() {
                return Err(SourceReadError::Unavailable);
            }

            let content_type = response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            validate_content_type(content_type.as_deref(), policy)?;
            if response
                .content_length()
                .is_some_and(|length| length > u64::try_from(policy.max_bytes).unwrap_or(u64::MAX))
            {
                return Err(SourceReadError::Oversize);
            }
            let final_url = RedirectTarget::parse(current.as_str())
                .map_err(|_| SourceReadError::Unavailable)?;
            let bytes = collect_bounded(response.bytes_stream(), policy.max_bytes).await?;
            return Ok(SourceContent {
                bytes,
                content_type,
                final_url: Some(final_url),
                redirects,
            });
        }
    }
}

impl HttpsSourceReader for ReqwestHttpsSourceReader {
    fn read<'a>(
        &'a self,
        url: &'a SensitiveUrl,
        policy: &'a SourceReadPolicy,
    ) -> BoxFuture<'a, Result<SourceContent, SourceReadError>> {
        self.read_response(url, policy).boxed()
    }
}

fn redirect_target(current: &Url, headers: &header::HeaderMap) -> Result<Url, SourceReadError> {
    let location = headers
        .get(header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(SourceReadError::Unavailable)?;
    let target = current
        .join(location)
        .map_err(|_| SourceReadError::Unavailable)?;
    if target.scheme() != "https"
        || target.host_str().is_none()
        || !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
    {
        return Err(SourceReadError::InsecureRedirect);
    }
    Ok(target)
}

fn validate_content_type(
    content_type: Option<&str>,
    policy: &SourceReadPolicy,
) -> Result<(), SourceReadError> {
    let Some(content_type) = content_type else {
        return Ok(());
    };
    let base = content_type
        .split(';')
        .next()
        .unwrap_or(content_type)
        .trim();
    if policy
        .allowed_content_types
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(base))
    {
        return Ok(());
    }
    Err(SourceReadError::UnsupportedContentType)
}

async fn collect_bounded<S, E>(stream: S, max_bytes: usize) -> Result<Vec<u8>, SourceReadError>
where
    S: Stream<Item = Result<Bytes, E>>,
{
    futures_util::pin_mut!(stream);
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| SourceReadError::Unavailable)?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(SourceReadError::Oversize);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn map_reqwest_error(error: reqwest::Error) -> SourceReadError {
    if error.is_timeout() {
        SourceReadError::Timeout
    } else {
        SourceReadError::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use futures_util::stream;
    use reqwest::{Url, header::HeaderMap};

    use super::{collect_bounded, redirect_target};
    use mish_profile::SourceReadError;

    #[tokio::test]
    async fn response_body_is_streamed_into_a_hard_byte_bound() {
        let stream = stream::iter([
            Ok::<_, ()>(Bytes::from_static(b"1234")),
            Ok(Bytes::from_static(b"5678")),
            Ok(Bytes::from_static(b"9")),
        ]);

        assert_eq!(
            collect_bounded(stream, 8).await.unwrap_err(),
            SourceReadError::Oversize
        );
    }

    #[test]
    fn redirects_must_remain_https_and_credential_free() {
        let current = Url::parse("https://profiles.example/source.yaml").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "location",
            "https://cdn.example/profile.yaml".parse().unwrap(),
        );
        assert_eq!(
            redirect_target(&current, &headers).unwrap().as_str(),
            "https://cdn.example/profile.yaml"
        );

        for location in [
            "http://cdn.example/profile.yaml",
            "https://user:secret@cdn.example/profile.yaml",
            "https://cdn.example/profile.yaml#private",
        ] {
            headers.insert("location", location.parse().unwrap());
            assert_eq!(
                redirect_target(&current, &headers).unwrap_err(),
                SourceReadError::InsecureRedirect
            );
        }
    }
}
