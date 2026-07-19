use serde_norway::{Mapping, Value};

use crate::{
    AttemptOutcome, Fingerprint, HttpsSourceReader, ImmutableRevision, LocalSourceReader,
    NORMALIZED_ARTIFACT_SCHEMA_VERSION, NormalizedArtifact, PROFILE_SCHEMA_VERSION,
    PolicyClassification, PolicyDisposition, PolicyOwner, PolicyViolationKind, ProfileAttempt,
    ProfileId, ProfileMetadata, ProfileRecord, ProfileSource, ProfileSourceType, ProfileStatus,
    ProfileSuccess, Provenance, ProvenanceReviewAuthority, RevisionId, RuntimeProvenanceReview,
    SourceReadError, SourceReadPolicy, Timestamp, ValidationIssue, ValidationIssueCode,
    ValidationResult, ValidationStatus, normalize_source_policy, read_source, runtime_layers,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportRequest {
    pub label: Option<String>,
    pub source: ProfileSource,
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
    pub provenance_review: RuntimeProvenanceReview,
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
            .field("provenance_review", &self.provenance_review)
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
            runtime_provenance: self.provenance_review,
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
    #[error(transparent)]
    SourceValidation(#[from] crate::SourceValidationError),
    #[error("normalized profile could not be generated")]
    NormalizationFailed,
    #[error("profile field {field_identity} requests unsafe device integration")]
    UnsafeDeviceIntegration { field_identity: &'static str },
    #[error("profile field {field_identity} contains an unsafe provider path")]
    UnsafeProviderPath { field_identity: &'static str },
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

        let (classifications, unknown_count) =
            normalize_source_policy(&mut document).map_err(|violation| match violation.kind {
                PolicyViolationKind::InvalidManagedShape => ImportError::NormalizationFailed,
                PolicyViolationKind::UnsafeDeviceIntegration => {
                    ImportError::UnsafeDeviceIntegration {
                        field_identity: violation.field_identity,
                    }
                }
                PolicyViolationKind::UnsafeProviderPath => ImportError::UnsafeProviderPath {
                    field_identity: violation.field_identity,
                },
            })?;

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
            item.owner == PolicyOwner::ApplicationPolicy
                && item.disposition == PolicyDisposition::ApplicationOverridden
                && item.source_present
        }) {
            warnings.push(ValidationIssue {
                code: ValidationIssueCode::ApplicationSettingsOverridden,
                message: "Application-owned settings are excluded from the source layer and must be supplied by application policy before activation.".to_owned(),
            });
        }
        if classifications.iter().any(|item| {
            item.owner == PolicyOwner::PlatformIntegration
                && item.source_present
                && matches!(
                    item.disposition,
                    PolicyDisposition::Disabled
                        | PolicyDisposition::PlatformOverridden
                        | PolicyDisposition::Rejected
                )
        }) {
            warnings.push(ValidationIssue {
                code: ValidationIssueCode::PlatformSettingsDisabled,
                message: "Platform capture or listener settings were disabled or rejected and cannot be activated from an imported source.".to_owned(),
            });
        }
        if classifications.iter().any(|item| {
            item.disposition == PolicyDisposition::Rejected
                && item.source_present
                && item.field_identity.ends_with(".path")
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
        let provenance_review = RuntimeProvenanceReview {
            artifact_fingerprint: fingerprint.clone(),
            authority: ProvenanceReviewAuthority::DesktopPolicy,
            items: classifications.clone(),
            layers: runtime_layers(),
            source_revision: revision_id.clone(),
            unknown_key_count: unknown_count,
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
            provenance_review,
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
        ("dns", "dns"),
        ("profile", "profile"),
        ("sniffer", "sniffer"),
        ("tun", "tun"),
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
