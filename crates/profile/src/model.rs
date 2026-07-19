use std::{
    fmt,
    path::{Component, Path, PathBuf},
    str::FromStr,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

pub const PROFILE_SCHEMA_VERSION: u32 = 2;
pub const NORMALIZED_ARTIFACT_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProfileId(String);

impl ProfileId {
    pub fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn parse(value: impl Into<String>) -> Result<Self, ProfileIdError> {
        let value = value.into();
        let parsed = Uuid::parse_str(&value).map_err(|_| ProfileIdError)?;
        if parsed.to_string() != value {
            return Err(ProfileIdError);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ProfileId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("profile ID is not a canonical UUID")]
pub struct ProfileIdError;

#[derive(Clone, Debug, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RevisionId(String);

impl RevisionId {
    pub fn from_source(bytes: &[u8]) -> Self {
        Self(hash_bytes(bytes))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn is_canonical(&self) -> bool {
        is_sha256_hex(&self.0)
    }
}

#[derive(Clone, Debug, Default, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Fingerprint(String);

impl Fingerprint {
    pub fn from_normalized_artifact(bytes: &[u8]) -> Self {
        Self(hash_bytes(bytes))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn is_canonical(&self) -> bool {
        is_sha256_hex(&self.0)
    }
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Timestamp(u64);

impl Timestamp {
    pub const fn from_unix_milliseconds(value: u64) -> Self {
        Self(value)
    }

    pub fn now() -> Self {
        let milliseconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        Self(u64::try_from(milliseconds).unwrap_or(u64::MAX))
    }

    pub const fn as_unix_milliseconds(self) -> u64 {
        self.0
    }
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SensitivePath(PathBuf);

impl SensitivePath {
    pub fn new(path: PathBuf) -> Result<Self, SourceValidationError> {
        if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
            return Err(SourceValidationError::UnsafeLocalPath);
        }
        Ok(Self(path))
    }

    pub fn expose(&self) -> &Path {
        &self.0
    }

    fn display_name(&self) -> String {
        self.0
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("Local profile")
            .to_owned()
    }
}

impl fmt::Debug for SensitivePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SensitivePath([redacted])")
    }
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SensitiveUrl(String);

impl SensitiveUrl {
    pub fn parse(value: &str) -> Result<Self, SourceValidationError> {
        let url = Url::parse(value).map_err(|_| SourceValidationError::InvalidUrl)?;
        if url.scheme() != "https" {
            return Err(SourceValidationError::UnsupportedScheme);
        }
        if url.host_str().is_none() {
            return Err(SourceValidationError::InvalidUrl);
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(SourceValidationError::UrlCredentialsUnsupported);
        }
        if url.fragment().is_some() {
            return Err(SourceValidationError::UrlFragmentUnsupported);
        }
        Ok(Self(url.into()))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn host(&self) -> String {
        Url::parse(&self.0)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .unwrap_or_else(|| "remote source".to_owned())
    }

    pub fn has_sensitive_query(&self) -> bool {
        Url::parse(&self.0).is_ok_and(|url| url.query().is_some_and(|query| !query.is_empty()))
    }

    pub fn redacted(&self) -> String {
        Url::parse(&self.0)
            .ok()
            .and_then(|url| url.host_str().map(|host| format!("https://{host}/…")))
            .unwrap_or_else(|| "https://[redacted]/…".to_owned())
    }
}

impl fmt::Debug for SensitiveUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.redacted())
    }
}

impl fmt::Display for SensitiveUrl {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.redacted())
    }
}

impl FromStr for SensitiveUrl {
    type Err = SourceValidationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileSourceType {
    LocalFile,
    Https,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ProfileSource {
    LocalFile { path: SensitivePath },
    Https { url: SensitiveUrl },
}

impl ProfileSource {
    pub fn local_file(path: PathBuf) -> Result<Self, SourceValidationError> {
        Ok(Self::LocalFile {
            path: SensitivePath::new(path)?,
        })
    }

    pub fn https(value: &str) -> Result<Self, SourceValidationError> {
        Ok(Self::Https {
            url: SensitiveUrl::parse(value)?,
        })
    }

    pub const fn source_type(&self) -> ProfileSourceType {
        match self {
            Self::LocalFile { .. } => ProfileSourceType::LocalFile,
            Self::Https { .. } => ProfileSourceType::Https,
        }
    }

    pub fn safe_summary(&self) -> SourceSummary {
        match self {
            Self::LocalFile { path } => SourceSummary {
                display: path.display_name(),
                source_type: ProfileSourceType::LocalFile,
            },
            Self::Https { url } => SourceSummary {
                display: url.redacted(),
                source_type: ProfileSourceType::Https,
            },
        }
    }

    pub fn inferred_label(&self) -> String {
        match self {
            Self::LocalFile { path } => path.display_name(),
            Self::Https { url } => url.host(),
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        match self {
            Self::LocalFile { path } => SensitivePath::new(path.expose().to_path_buf()).is_ok(),
            Self::Https { url } => SensitiveUrl::parse(url.expose()).is_ok(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SourceValidationError {
    #[error("local source path must be absolute and normalized")]
    UnsafeLocalPath,
    #[error("profile source URL is invalid")]
    InvalidUrl,
    #[error("profile source must use HTTPS")]
    UnsupportedScheme,
    #[error("URL user-info credentials are not supported")]
    UrlCredentialsUnsupported,
    #[error("URL fragments are not supported")]
    UrlFragmentUnsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSummary {
    pub display: String,
    pub source_type: ProfileSourceType,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub imported_at: Timestamp,
    pub source: SourceSummary,
    pub source_revision: RevisionId,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImmutableRevision {
    pub byte_length: u64,
    pub created_at: Timestamp,
    pub id: RevisionId,
    pub media_type: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedArtifact {
    pub byte_length: u64,
    pub fingerprint: Fingerprint,
    pub revision_id: RevisionId,
    pub schema_version: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ValidationStatus {
    Valid,
    Invalid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ValidationIssueCode {
    SourceFormattingNotRoundTripped,
    UnknownKeysPreserved,
    ApplicationSettingsOverridden,
    PlatformSettingsDisabled,
    UnsafePathsRejected,
    SensitiveDataPresent,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: ValidationIssueCode,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub errors: Vec<ValidationIssue>,
    pub status: ValidationStatus,
    pub warnings: Vec<ValidationIssue>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttemptOutcome {
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAttempt {
    pub attempted_at: Timestamp,
    pub outcome: AttemptOutcome,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSuccess {
    pub fingerprint: Fingerprint,
    pub revision_id: RevisionId,
    pub succeeded_at: Timestamp,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStatus {
    pub active: bool,
    pub error: bool,
    pub stale: bool,
    pub updating: bool,
    pub valid: bool,
    pub warning: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileMetadata {
    pub artifact: NormalizedArtifact,
    pub id: ProfileId,
    pub label: String,
    pub last_attempt: Option<ProfileAttempt>,
    pub last_success: Option<ProfileSuccess>,
    pub provenance: Provenance,
    pub revision: ImmutableRevision,
    #[serde(default)]
    pub runtime_provenance: crate::RuntimeProvenanceReview,
    pub schema_version: u32,
    pub status: ProfileStatus,
    pub validation: ValidationResult,
}

pub struct ProfileRecord {
    pub metadata: ProfileMetadata,
    pub normalized_bytes: Vec<u8>,
    pub source: ProfileSource,
    pub source_bytes: Vec<u8>,
}

impl fmt::Debug for ProfileRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProfileRecord")
            .field("metadata", &self.metadata)
            .field("normalized_bytes", &"[redacted]")
            .field("source", &self.source.safe_summary())
            .field("source_bytes", &"[redacted]")
            .finish()
    }
}
