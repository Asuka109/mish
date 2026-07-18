use std::{collections::BTreeSet, path::Path};

use serde_norway::{Mapping, Value};

use crate::{
    AttemptOutcome, Fingerprint, HttpsSourceReader, ImmutableRevision, LocalSourceReader,
    NORMALIZED_ARTIFACT_SCHEMA_VERSION, NormalizedArtifact, PROFILE_SCHEMA_VERSION, ProfileAttempt,
    ProfileId, ProfileMetadata, ProfileRecord, ProfileSource, ProfileSourceType, ProfileStatus,
    ProfileSuccess, Provenance, RevisionId, SourceReadError, SourceReadPolicy, Timestamp,
    ValidationIssue, ValidationIssueCode, ValidationResult, ValidationStatus, read_source,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportRequest {
    pub label: Option<String>,
    pub source: ProfileSource,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyOwner {
    Source,
    Application,
    Platform,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyDisposition {
    Preserved,
    Overridden,
    Disabled,
    Rejected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyClassification {
    pub disposition: PolicyDisposition,
    pub key_path: String,
    pub owner: PolicyOwner,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SensitiveDataNotice {
    None,
    SourceUrlContainsSensitiveData,
    ConfigurationContainsSensitiveData,
    SourceAndConfigurationContainSensitiveData,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportSummary {
    pub group_count: usize,
    pub label: String,
    pub proxy_count: usize,
    pub rule_count: usize,
    pub sensitive_data_notice: SensitiveDataNotice,
    pub source_type: ProfileSourceType,
    pub warnings: Vec<ValidationIssue>,
}

pub struct PreflightReport {
    pub artifact: NormalizedArtifact,
    pub classifications: Vec<PolicyClassification>,
    pub normalized_bytes: Vec<u8>,
    pub revision: ImmutableRevision,
    pub source: ProfileSource,
    pub source_bytes: Vec<u8>,
    pub summary: ImportSummary,
    pub validation: ValidationResult,
}

impl std::fmt::Debug for PreflightReport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreflightReport")
            .field("artifact", &self.artifact)
            .field("classifications", &self.classifications)
            .field("normalized_bytes", &"[redacted]")
            .field("revision", &self.revision)
            .field("source", &self.source.safe_summary())
            .field("source_bytes", &"[redacted]")
            .field("summary", &self.summary)
            .field("validation", &self.validation)
            .finish()
    }
}

impl PreflightReport {
    pub fn into_record(self, id: ProfileId, imported_at: Timestamp) -> ProfileRecord {
        let warning = !self.validation.warnings.is_empty();
        let metadata = ProfileMetadata {
            artifact: self.artifact.clone(),
            id,
            label: self.summary.label,
            last_attempt: Some(ProfileAttempt {
                attempted_at: imported_at,
                outcome: AttemptOutcome::Succeeded,
            }),
            last_success: Some(ProfileSuccess {
                fingerprint: self.artifact.fingerprint.clone(),
                revision_id: self.revision.id.clone(),
                succeeded_at: imported_at,
            }),
            provenance: Provenance {
                imported_at,
                source: self.source.safe_summary(),
                source_revision: self.revision.id.clone(),
            },
            revision: self.revision,
            schema_version: PROFILE_SCHEMA_VERSION,
            status: ProfileStatus {
                active: false,
                error: false,
                stale: false,
                updating: false,
                valid: true,
                warning,
            },
            validation: self.validation,
        };

        ProfileRecord {
            metadata,
            normalized_bytes: self.normalized_bytes,
            source: self.source,
            source_bytes: self.source_bytes,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ImportError {
    #[error(transparent)]
    Source(#[from] SourceReadError),
    #[error("profile source is empty")]
    Empty,
    #[error("profile source is not valid UTF-8")]
    InvalidEncoding,
    #[error("profile source contains malformed YAML")]
    MalformedYaml,
    #[error("profile YAML must contain a top-level mapping")]
    InvalidRoot,
    #[error("profile field {key_path} must be a {expected}")]
    InvalidFieldShape {
        expected: &'static str,
        key_path: &'static str,
    },
    #[error("profile label is empty or exceeds 120 characters")]
    InvalidLabel,
    #[error("normalized profile could not be generated")]
    NormalizationFailed,
}

pub struct ImportPreflight<L, H> {
    https_reader: H,
    local_reader: L,
    policy: SourceReadPolicy,
}

impl<L, H> ImportPreflight<L, H>
where
    L: LocalSourceReader,
    H: HttpsSourceReader,
{
    pub fn new(local_reader: L, https_reader: H, policy: SourceReadPolicy) -> Self {
        Self {
            https_reader,
            local_reader,
            policy,
        }
    }

    pub async fn run(&self, request: ImportRequest) -> Result<PreflightReport, ImportError> {
        let content = read_source(
            &request.source,
            &self.local_reader,
            &self.https_reader,
            &self.policy,
        )
        .await?;
        validate_transport_boundaries(&request.source, &content, &self.policy)?;

        if content.bytes.is_empty() {
            return Err(ImportError::Empty);
        }
        let source_text =
            std::str::from_utf8(&content.bytes).map_err(|_| ImportError::InvalidEncoding)?;
        let mut document: Value =
            serde_norway::from_str(source_text).map_err(|_| ImportError::MalformedYaml)?;
        let mapping = document.as_mapping_mut().ok_or(ImportError::InvalidRoot)?;
        validate_collection_shapes(mapping)?;

        let label = resolve_label(request.label, &request.source)?;
        let proxy_count = sequence_len(mapping, "proxies");
        let group_count = sequence_len(mapping, "proxy-groups");
        let rule_count = sequence_len(mapping, "rules");
        let config_has_secrets = contains_sensitive_key(&document);
        let source_has_secrets = matches!(
            &request.source,
            ProfileSource::Https { url } if url.has_sensitive_query()
        );

        let mut classifications = Vec::new();
        classify_and_normalize(&mut document, &mut classifications);
        let unknown_count = classify_unknown_keys(&document, &mut classifications);

        let mut warnings = vec![ValidationIssue {
            code: ValidationIssueCode::SourceFormattingNotRoundTripped,
            message: "The normalized artifact preserves configuration semantics, not source formatting or comments; the immutable source is retained.".to_owned(),
        }];
        if unknown_count > 0 {
            warnings.push(ValidationIssue {
                code: ValidationIssueCode::UnknownKeysPreserved,
                message: format!(
                    "{unknown_count} unrecognized top-level configuration key(s) were preserved in the normalized artifact."
                ),
            });
        }
        if classifications.iter().any(|item| {
            item.owner == PolicyOwner::Application
                && item.disposition == PolicyDisposition::Overridden
        }) {
            warnings.push(ValidationIssue {
                code: ValidationIssueCode::ApplicationSettingsOverridden,
                message: "Application-owned settings are excluded from the source layer and must be supplied by application policy before activation.".to_owned(),
            });
        }
        if classifications.iter().any(|item| {
            item.owner == PolicyOwner::Platform
                && matches!(
                    item.disposition,
                    PolicyDisposition::Disabled | PolicyDisposition::Rejected
                )
        }) {
            warnings.push(ValidationIssue {
                code: ValidationIssueCode::PlatformSettingsDisabled,
                message: "Platform capture or listener settings were disabled or rejected and cannot be activated from an imported source.".to_owned(),
            });
        }
        if classifications.iter().any(|item| {
            item.disposition == PolicyDisposition::Rejected && item.key_path.ends_with(".path")
        }) {
            warnings.push(ValidationIssue {
                code: ValidationIssueCode::UnsafePathsRejected,
                message: "Device-specific absolute provider paths were rejected from the normalized artifact.".to_owned(),
            });
        }
        if config_has_secrets || source_has_secrets {
            warnings.push(ValidationIssue {
                code: ValidationIssueCode::SensitiveDataPresent,
                message: "Sensitive source or configuration data is retained locally and must remain redacted in ordinary displays and diagnostics.".to_owned(),
            });
        }

        let normalized = serde_norway::to_string(&document)
            .map_err(|_| ImportError::NormalizationFailed)?
            .into_bytes();
        let source_type = request.source.source_type();
        let revision_id = RevisionId::from_source(&content.bytes);
        let fingerprint = Fingerprint::from_normalized_artifact(&normalized);
        let now = Timestamp::now();
        let validation = ValidationResult {
            errors: Vec::new(),
            status: ValidationStatus::Valid,
            warnings: warnings.clone(),
        };

        Ok(PreflightReport {
            artifact: NormalizedArtifact {
                byte_length: normalized.len() as u64,
                fingerprint,
                revision_id: revision_id.clone(),
                schema_version: NORMALIZED_ARTIFACT_SCHEMA_VERSION,
            },
            classifications,
            normalized_bytes: normalized,
            revision: ImmutableRevision {
                byte_length: content.bytes.len() as u64,
                created_at: now,
                id: revision_id,
                media_type: content.content_type.clone(),
            },
            source: request.source,
            source_bytes: content.bytes,
            summary: ImportSummary {
                group_count,
                label,
                proxy_count,
                rule_count,
                sensitive_data_notice: sensitive_notice(source_has_secrets, config_has_secrets),
                source_type,
                warnings,
            },
            validation,
        })
    }
}

fn validate_transport_boundaries(
    source: &ProfileSource,
    content: &crate::SourceContent,
    policy: &SourceReadPolicy,
) -> Result<(), SourceReadError> {
    if content.bytes.len() > policy.max_bytes {
        return Err(SourceReadError::Oversize);
    }
    if content.redirects > policy.max_redirects {
        return Err(SourceReadError::TooManyRedirects);
    }
    if matches!(source, ProfileSource::Https { .. }) {
        if content
            .final_url
            .as_ref()
            .is_some_and(|url| !url.is_https())
        {
            return Err(SourceReadError::InsecureRedirect);
        }
        if let Some(content_type) = content.content_type.as_deref() {
            let base = content_type
                .split(';')
                .next()
                .unwrap_or(content_type)
                .trim();
            if !policy
                .allowed_content_types
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(base))
            {
                return Err(SourceReadError::UnsupportedContentType);
            }
        }
    }
    Ok(())
}

fn resolve_label(requested: Option<String>, source: &ProfileSource) -> Result<String, ImportError> {
    let label = requested.unwrap_or_else(|| source.inferred_label());
    let label = label.trim();
    if label.is_empty() || label.chars().count() > 120 {
        return Err(ImportError::InvalidLabel);
    }
    Ok(label.to_owned())
}

fn validate_collection_shapes(mapping: &Mapping) -> Result<(), ImportError> {
    for (key, path) in [
        ("proxies", "proxies"),
        ("proxy-groups", "proxy-groups"),
        ("rules", "rules"),
    ] {
        if mapping
            .get(Value::String(key.to_owned()))
            .is_some_and(|value| !value.is_sequence())
        {
            return Err(ImportError::InvalidFieldShape {
                expected: "sequence",
                key_path: path,
            });
        }
    }
    for (key, path) in [
        ("proxy-providers", "proxy-providers"),
        ("rule-providers", "rule-providers"),
    ] {
        if mapping
            .get(Value::String(key.to_owned()))
            .is_some_and(|value| !value.is_mapping())
        {
            return Err(ImportError::InvalidFieldShape {
                expected: "mapping",
                key_path: path,
            });
        }
    }
    Ok(())
}

fn sequence_len(mapping: &Mapping, key: &str) -> usize {
    mapping
        .get(Value::String(key.to_owned()))
        .and_then(Value::as_sequence)
        .map_or(0, Vec::len)
}

fn classify_and_normalize(document: &mut Value, output: &mut Vec<PolicyClassification>) {
    let Some(mapping) = document.as_mapping_mut() else {
        return;
    };

    const APPLICATION_KEYS: &[&str] = &[
        "port",
        "socks-port",
        "redir-port",
        "tproxy-port",
        "mixed-port",
        "authentication",
        "skip-auth-prefixes",
        "lan-allowed-ips",
        "lan-disallowed-ips",
        "allow-lan",
        "bind-address",
        "external-controller",
        "external-controller-tls",
        "external-ui",
        "external-ui-name",
        "external-ui-url",
        "external-doh-server",
        "secret",
        "log-level",
        "mode",
    ];
    for key in APPLICATION_KEYS {
        if mapping.remove(Value::String((*key).to_owned())).is_some() {
            output.push(PolicyClassification {
                disposition: PolicyDisposition::Overridden,
                key_path: (*key).to_owned(),
                owner: PolicyOwner::Application,
            });
        }
    }

    for key in ["listeners", "interface-name", "routing-mark"] {
        if mapping.remove(Value::String(key.to_owned())).is_some() {
            output.push(PolicyClassification {
                disposition: PolicyDisposition::Rejected,
                key_path: key.to_owned(),
                owner: PolicyOwner::Platform,
            });
        }
    }

    if let Some(tun) = mapping.get_mut(Value::String("tun".to_owned()))
        && let Some(tun_mapping) = tun.as_mapping_mut()
    {
        let enable_key = Value::String("enable".to_owned());
        if tun_mapping.contains_key(&enable_key) {
            tun_mapping.insert(enable_key, Value::Bool(false));
            output.push(PolicyClassification {
                disposition: PolicyDisposition::Disabled,
                key_path: "tun.enable".to_owned(),
                owner: PolicyOwner::Platform,
            });
        }
    }

    reject_absolute_provider_paths(mapping, "proxy-providers", output);
    reject_absolute_provider_paths(mapping, "rule-providers", output);
}

fn reject_absolute_provider_paths(
    mapping: &mut Mapping,
    provider_key: &str,
    output: &mut Vec<PolicyClassification>,
) {
    let Some(providers) = mapping
        .get_mut(Value::String(provider_key.to_owned()))
        .and_then(Value::as_mapping_mut)
    else {
        return;
    };
    for (name, provider) in providers {
        let Some(provider_mapping) = provider.as_mapping_mut() else {
            continue;
        };
        let path_key = Value::String("path".to_owned());
        let is_absolute = provider_mapping
            .get(&path_key)
            .and_then(Value::as_str)
            .is_some_and(|path| Path::new(path).is_absolute());
        if is_absolute {
            provider_mapping.remove(&path_key);
            let safe_name = name.as_str().unwrap_or("[non-string-name]");
            output.push(PolicyClassification {
                disposition: PolicyDisposition::Rejected,
                key_path: format!("{provider_key}.{safe_name}.path"),
                owner: PolicyOwner::Platform,
            });
        }
    }
}

fn classify_unknown_keys(document: &Value, output: &mut Vec<PolicyClassification>) -> usize {
    const KNOWN_KEYS: &[&str] = &[
        "proxies",
        "proxy-groups",
        "proxy-providers",
        "rules",
        "rule-providers",
        "sub-rules",
        "dns",
        "hosts",
        "sniffer",
        "tun",
        "profile",
        "geodata-mode",
        "geodata-loader",
        "geo-auto-update",
        "geo-update-interval",
        "geox-url",
        "find-process-mode",
        "unified-delay",
        "tcp-concurrent",
        "global-client-fingerprint",
        "global-ua",
        "ntp",
        "keep-alive-interval",
        "keep-alive-idle",
        "disable-keep-alive",
    ];
    let known: BTreeSet<&str> = KNOWN_KEYS.iter().copied().collect();
    let Some(mapping) = document.as_mapping() else {
        return 0;
    };
    let mut count = 0;
    for (key, _) in mapping {
        let Some(key) = key.as_str() else {
            count += 1;
            continue;
        };
        if !known.contains(key) {
            count += 1;
            output.push(PolicyClassification {
                disposition: PolicyDisposition::Preserved,
                key_path: key.to_owned(),
                owner: PolicyOwner::Source,
            });
        }
    }
    count
}

fn contains_sensitive_key(value: &Value) -> bool {
    const SENSITIVE_KEYS: &[&str] = &[
        "password",
        "passwd",
        "username",
        "token",
        "secret",
        "authorization",
        "private-key",
    ];
    match value {
        Value::Mapping(mapping) => mapping.iter().any(|(key, value)| {
            key.as_str()
                .is_some_and(|key| SENSITIVE_KEYS.contains(&key.to_ascii_lowercase().as_str()))
                || contains_sensitive_key(value)
        }),
        Value::Sequence(sequence) => sequence.iter().any(contains_sensitive_key),
        Value::Tagged(tagged) => contains_sensitive_key(&tagged.value),
        _ => false,
    }
}

const fn sensitive_notice(source: bool, configuration: bool) -> SensitiveDataNotice {
    match (source, configuration) {
        (false, false) => SensitiveDataNotice::None,
        (true, false) => SensitiveDataNotice::SourceUrlContainsSensitiveData,
        (false, true) => SensitiveDataNotice::ConfigurationContainsSensitiveData,
        (true, true) => SensitiveDataNotice::SourceAndConfigurationContainSensitiveData,
    }
}
