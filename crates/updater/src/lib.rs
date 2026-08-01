mod service;

use std::{cmp::Ordering, collections::BTreeMap, fmt, fs::File, io::Read, path::Path};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

pub use service::{
    UpdateCandidateIdentity, UpdateOperationError, UpdatePhase, UpdateProgress,
    UpdaterCheckTransitionEvidence, UpdaterLimits, UpdaterService, UpdaterSnapshot,
};

pub const DARWIN_AARCH64_TARGET: &str = "darwin-aarch64";
pub const UPDATER_SCHEMA_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdaterAvailability {
    ContractOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Alpha,
    Stable,
}

impl UpdateChannel {
    pub fn metadata_name(self) -> &'static str {
        match self {
            Self::Alpha => "mish-alpha.json",
            Self::Stable => "mish-stable.json",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledUpdate {
    pub channel: UpdateChannel,
    pub version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdatePolicy {
    pub installed: InstalledUpdate,
    pub selected_channel: UpdateChannel,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpdateSelection {
    pub channel_switch: bool,
    pub skipped_version: bool,
    pub version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedUpdate {
    pub artifact_name: String,
    pub artifact_sha256: String,
    pub channel: UpdateChannel,
    pub channel_switch: bool,
    pub metadata_sha256: String,
    pub skipped_version: bool,
    pub source_sha: String,
    pub version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedMetadata {
    pub artifact_name: String,
    pub artifact_sha256: String,
    pub artifact_signature: String,
    pub artifact_size: u64,
    pub artifact_url: String,
    pub channel: UpdateChannel,
    pub channel_switch: bool,
    pub metadata_sha256: String,
    pub skipped_version: bool,
    pub source_sha: String,
    pub version: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpdaterError {
    ArtifactDigestMismatch,
    ArtifactIdentityMismatch,
    ArtifactSignatureInvalid,
    ArtifactSignatureMismatch,
    ArtifactSizeMismatch,
    ChannelMismatch,
    DowngradeRejected,
    EqualVersionRejected,
    InvalidArtifactUrl,
    InvalidMetadata,
    InvalidPublicKey,
    InvalidSourceIdentity,
    MalformedInstalledVersion,
    MalformedUpdateVersion,
    MetadataReplay,
    MetadataSignatureInvalid,
    MissingArtifactSignature,
    MissingMetadataSignature,
    VersionDigestConflict,
    WrongChannelVersion,
}

impl UpdaterError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ArtifactDigestMismatch => "artifact-digest-mismatch",
            Self::ArtifactIdentityMismatch => "artifact-identity-mismatch",
            Self::ArtifactSignatureInvalid => "artifact-signature-invalid",
            Self::ArtifactSignatureMismatch => "artifact-signature-mismatch",
            Self::ArtifactSizeMismatch => "artifact-size-mismatch",
            Self::ChannelMismatch => "channel-mismatch",
            Self::DowngradeRejected => "downgrade-rejected",
            Self::EqualVersionRejected => "equal-version-rejected",
            Self::InvalidArtifactUrl => "invalid-artifact-url",
            Self::InvalidMetadata => "invalid-metadata",
            Self::InvalidPublicKey => "invalid-public-key",
            Self::InvalidSourceIdentity => "invalid-source-identity",
            Self::MalformedInstalledVersion => "malformed-installed-version",
            Self::MalformedUpdateVersion => "malformed-update-version",
            Self::MetadataReplay => "metadata-replay",
            Self::MetadataSignatureInvalid => "metadata-signature-invalid",
            Self::MissingArtifactSignature => "missing-artifact-signature",
            Self::MissingMetadataSignature => "missing-metadata-signature",
            Self::VersionDigestConflict => "version-digest-conflict",
            Self::WrongChannelVersion => "wrong-channel-version",
        }
    }
}

impl fmt::Display for UpdaterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for UpdaterError {}

#[derive(Debug)]
pub struct UpdaterAdapter {
    public_key: PublicKey,
}

impl UpdaterAdapter {
    pub fn new(tauri_public_key: &str) -> Result<Self, UpdaterError> {
        let public_key = decode_tauri_text(tauri_public_key, UpdaterError::InvalidPublicKey)
            .and_then(|decoded| {
                PublicKey::decode(&decoded).map_err(|_| UpdaterError::InvalidPublicKey)
            })?;
        Ok(Self { public_key })
    }

    pub fn availability(&self) -> UpdaterAvailability {
        UpdaterAvailability::ContractOnly
    }

    pub fn verify_candidate(
        &self,
        request: VerifyCandidateRequest<'_>,
    ) -> Result<VerifiedUpdate, UpdaterError> {
        let metadata = self.verify_metadata(VerifyMetadataRequest {
            accepted_metadata_sha256: request.accepted_metadata_sha256,
            metadata: request.metadata,
            metadata_signature: request.metadata_signature,
            policy: request.policy,
        })?;
        self.verify_payload_bytes(
            &metadata,
            request.artifact_name,
            request.artifact,
            request.artifact_signature,
        )?;

        Ok(VerifiedUpdate {
            artifact_name: metadata.artifact_name,
            artifact_sha256: metadata.artifact_sha256,
            channel: metadata.channel,
            channel_switch: metadata.channel_switch,
            metadata_sha256: metadata.metadata_sha256,
            skipped_version: metadata.skipped_version,
            source_sha: metadata.source_sha,
            version: metadata.version,
        })
    }

    pub fn verify_metadata(
        &self,
        request: VerifyMetadataRequest<'_>,
    ) -> Result<VerifiedMetadata, UpdaterError> {
        if request.metadata_signature.is_empty() {
            return Err(UpdaterError::MissingMetadataSignature);
        }
        self.verify_signature(
            request.metadata,
            request.metadata_signature,
            UpdaterError::MetadataSignatureInvalid,
        )?;
        let metadata_sha256 = sha256(request.metadata);
        if request
            .accepted_metadata_sha256
            .iter()
            .any(|digest| digest == &metadata_sha256)
        {
            return Err(UpdaterError::MetadataReplay);
        }

        let metadata: TauriStaticMetadata =
            serde_json::from_slice(request.metadata).map_err(|_| UpdaterError::InvalidMetadata)?;
        let selection = evaluate_update(&request.policy, &metadata.version, metadata.mish.channel)?;
        validate_metadata_contract(&metadata)?;
        let platform = metadata
            .platforms
            .get(DARWIN_AARCH64_TARGET)
            .ok_or(UpdaterError::ArtifactIdentityMismatch)?;
        if platform.signature.is_empty() {
            return Err(UpdaterError::MissingArtifactSignature);
        }

        Ok(VerifiedMetadata {
            artifact_name: metadata.mish.artifact_name,
            artifact_sha256: metadata.mish.artifact_sha256,
            artifact_signature: platform.signature.clone(),
            artifact_size: metadata.mish.artifact_size,
            artifact_url: platform.url.clone(),
            channel: metadata.mish.channel,
            channel_switch: selection.channel_switch,
            metadata_sha256,
            skipped_version: selection.skipped_version,
            source_sha: metadata.mish.source_sha,
            version: metadata.version,
        })
    }

    pub fn verify_payload_bytes(
        &self,
        metadata: &VerifiedMetadata,
        artifact_name: &str,
        artifact: &[u8],
        artifact_signature: &str,
    ) -> Result<(), UpdaterError> {
        validate_payload_identity(
            metadata,
            artifact_name,
            artifact.len() as u64,
            &sha256(artifact),
            artifact_signature,
        )?;
        self.verify_signature(
            artifact,
            artifact_signature,
            UpdaterError::ArtifactSignatureInvalid,
        )
    }

    pub fn verify_payload_file(
        &self,
        metadata: &VerifiedMetadata,
        artifact_name: &str,
        artifact_path: &Path,
        artifact_signature: &str,
    ) -> Result<(), UpdaterError> {
        if artifact_signature.is_empty() {
            return Err(UpdaterError::MissingArtifactSignature);
        }
        if metadata.artifact_signature != artifact_signature {
            return Err(UpdaterError::ArtifactSignatureMismatch);
        }
        let decoded =
            decode_tauri_text(artifact_signature, UpdaterError::ArtifactSignatureInvalid)?;
        let signature =
            Signature::decode(&decoded).map_err(|_| UpdaterError::ArtifactSignatureInvalid)?;
        let mut verifier = self
            .public_key
            .verify_stream(&signature)
            .map_err(|_| UpdaterError::ArtifactSignatureInvalid)?;
        let mut digest = Sha256::new();
        let mut artifact =
            File::open(artifact_path).map_err(|_| UpdaterError::ArtifactSizeMismatch)?;
        let mut size = 0_u64;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = artifact
                .read(&mut buffer)
                .map_err(|_| UpdaterError::ArtifactSizeMismatch)?;
            if read == 0 {
                break;
            }
            size = size
                .checked_add(read as u64)
                .ok_or(UpdaterError::ArtifactSizeMismatch)?;
            if size > metadata.artifact_size {
                return Err(UpdaterError::ArtifactSizeMismatch);
            }
            digest.update(&buffer[..read]);
            verifier.update(&buffer[..read]);
        }
        validate_payload_identity(
            metadata,
            artifact_name,
            size,
            &format!("{:x}", digest.finalize()),
            artifact_signature,
        )?;
        verifier
            .finalize()
            .map_err(|_| UpdaterError::ArtifactSignatureInvalid)
    }

    fn verify_signature(
        &self,
        content: &[u8],
        encoded_signature: &str,
        error: UpdaterError,
    ) -> Result<(), UpdaterError> {
        let decoded = decode_tauri_text(encoded_signature, error)?;
        let signature = Signature::decode(&decoded).map_err(|_| error)?;
        self.public_key
            .verify(content, &signature, true)
            .map_err(|_| error)
    }
}

pub struct VerifyCandidateRequest<'a> {
    pub accepted_metadata_sha256: &'a [String],
    pub artifact: &'a [u8],
    pub artifact_name: &'a str,
    pub artifact_signature: &'a str,
    pub metadata: &'a [u8],
    pub metadata_signature: &'a str,
    pub policy: UpdatePolicy,
}

pub struct VerifyMetadataRequest<'a> {
    pub accepted_metadata_sha256: &'a [String],
    pub metadata: &'a [u8],
    pub metadata_signature: &'a str,
    pub policy: UpdatePolicy,
}

pub fn evaluate_update(
    policy: &UpdatePolicy,
    candidate_version: &str,
    candidate_channel: UpdateChannel,
) -> Result<UpdateSelection, UpdaterError> {
    let installed = parse_version(&policy.installed.version)
        .map_err(|_| UpdaterError::MalformedInstalledVersion)?;
    validate_channel_version(&installed, policy.installed.channel)
        .map_err(|_| UpdaterError::MalformedInstalledVersion)?;
    let candidate =
        parse_version(candidate_version).map_err(|_| UpdaterError::MalformedUpdateVersion)?;
    validate_channel_version(&candidate, candidate_channel)?;
    if candidate_channel != policy.selected_channel {
        return Err(UpdaterError::ChannelMismatch);
    }

    match candidate.cmp(&installed) {
        Ordering::Less => return Err(UpdaterError::DowngradeRejected),
        Ordering::Equal => return Err(UpdaterError::EqualVersionRejected),
        Ordering::Greater => {}
    }

    let skipped_release_version = candidate.major > installed.major
        || candidate.minor > installed.minor.saturating_add(1)
        || (candidate.major == installed.major
            && candidate.minor == installed.minor
            && candidate.patch > installed.patch.saturating_add(1));
    let skipped_alpha_sequence = policy.installed.channel == UpdateChannel::Alpha
        && candidate_channel == UpdateChannel::Alpha
        && candidate.major == installed.major
        && candidate.minor == installed.minor
        && candidate.patch == installed.patch
        && alpha_sequence(&candidate).is_some_and(|candidate_sequence| {
            alpha_sequence(&installed).is_some_and(|installed_sequence| {
                candidate_sequence > installed_sequence.saturating_add(1)
            })
        });
    Ok(UpdateSelection {
        channel_switch: policy.installed.channel != policy.selected_channel,
        skipped_version: skipped_release_version || skipped_alpha_sequence,
        version: candidate.to_string(),
    })
}

fn parse_version(input: &str) -> Result<Version, ()> {
    let parsed = Version::parse(input).map_err(|_| ())?;
    if parsed.to_string() != input || !parsed.build.is_empty() {
        return Err(());
    }
    Ok(parsed)
}

fn validate_channel_version(version: &Version, channel: UpdateChannel) -> Result<(), UpdaterError> {
    match channel {
        UpdateChannel::Stable if version.pre.is_empty() => Ok(()),
        UpdateChannel::Alpha => {
            let mut identifiers = version.pre.as_str().split('.');
            let alpha = identifiers.next();
            let sequence = identifiers.next();
            if alpha == Some("alpha")
                && sequence.is_some_and(|value| value.parse::<u64>().is_ok())
                && identifiers.next().is_none()
            {
                Ok(())
            } else {
                Err(UpdaterError::WrongChannelVersion)
            }
        }
        UpdateChannel::Stable => Err(UpdaterError::WrongChannelVersion),
    }
}

fn alpha_sequence(version: &Version) -> Option<u64> {
    version.pre.as_str().strip_prefix("alpha.")?.parse().ok()
}

fn validate_metadata_contract(metadata: &TauriStaticMetadata) -> Result<(), UpdaterError> {
    if metadata.mish.schema_version != UPDATER_SCHEMA_VERSION
        || metadata.platforms.len() != 1
        || !valid_source_sha(&metadata.mish.source_sha)
    {
        return Err(if valid_source_sha(&metadata.mish.source_sha) {
            UpdaterError::InvalidMetadata
        } else {
            UpdaterError::InvalidSourceIdentity
        });
    }

    let expected_name = format!("Mish-{}-aarch64.app.tar.gz", metadata.version);
    if metadata.mish.artifact_name != expected_name {
        return Err(UpdaterError::ArtifactIdentityMismatch);
    }
    if metadata.mish.artifact_size == 0
        || metadata.mish.artifact_sha256.len() != 64
        || !metadata
            .mish
            .artifact_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(UpdaterError::InvalidMetadata);
    }

    let platform = metadata
        .platforms
        .get(DARWIN_AARCH64_TARGET)
        .ok_or(UpdaterError::ArtifactIdentityMismatch)?;
    let expected_url = format!(
        "https://github.com/Asuka109/mish/releases/download/v{}/{}",
        metadata.version, expected_name
    );
    let parsed = Url::parse(&platform.url).map_err(|_| UpdaterError::InvalidArtifactUrl)?;
    if platform.url != expected_url
        || parsed.scheme() != "https"
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(UpdaterError::InvalidArtifactUrl);
    }
    Ok(())
}

fn validate_payload_identity(
    metadata: &VerifiedMetadata,
    artifact_name: &str,
    artifact_size: u64,
    artifact_sha256: &str,
    artifact_signature: &str,
) -> Result<(), UpdaterError> {
    if artifact_name != metadata.artifact_name {
        return Err(UpdaterError::ArtifactIdentityMismatch);
    }
    if artifact_size != metadata.artifact_size {
        return Err(UpdaterError::ArtifactSizeMismatch);
    }
    if artifact_sha256 != metadata.artifact_sha256 {
        return Err(UpdaterError::ArtifactDigestMismatch);
    }
    if artifact_signature.is_empty() {
        return Err(UpdaterError::MissingArtifactSignature);
    }
    if artifact_signature != metadata.artifact_signature {
        return Err(UpdaterError::ArtifactSignatureMismatch);
    }
    Ok(())
}

#[cfg(test)]
fn validate_metadata_identity(
    metadata: &TauriStaticMetadata,
    artifact_name: &str,
    artifact: &[u8],
) -> Result<(), UpdaterError> {
    validate_metadata_contract(metadata)?;
    let platform = metadata
        .platforms
        .get(DARWIN_AARCH64_TARGET)
        .ok_or(UpdaterError::ArtifactIdentityMismatch)?;
    validate_payload_identity(
        &VerifiedMetadata {
            artifact_name: metadata.mish.artifact_name.clone(),
            artifact_sha256: metadata.mish.artifact_sha256.clone(),
            artifact_signature: platform.signature.clone(),
            artifact_size: metadata.mish.artifact_size,
            artifact_url: platform.url.clone(),
            channel: metadata.mish.channel,
            channel_switch: false,
            metadata_sha256: String::new(),
            skipped_version: false,
            source_sha: metadata.mish.source_sha.clone(),
            version: metadata.version.clone(),
        },
        artifact_name,
        artifact.len() as u64,
        &sha256(artifact),
        &platform.signature,
    )
}

fn valid_source_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn decode_tauri_text(value: &str, error: UpdaterError) -> Result<String, UpdaterError> {
    if value.trim() != value || value.is_empty() {
        return Err(error);
    }
    let decoded = STANDARD.decode(value).map_err(|_| error)?;
    String::from_utf8(decoded).map_err(|_| error)
}

fn sha256(content: &[u8]) -> String {
    format!("{:x}", Sha256::digest(content))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TauriStaticMetadata {
    version: String,
    platforms: BTreeMap<String, TauriPlatform>,
    mish: MishMetadata,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TauriPlatform {
    url: String,
    signature: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MishMetadata {
    schema_version: u8,
    channel: UpdateChannel,
    source_sha: String,
    artifact_name: String,
    artifact_sha256: String,
    artifact_size: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const PUBLIC_KEY: &str =
        include_str!("../../../scripts/fixtures/macos-updater/updater-fixture.key.pub");
    const METADATA: &[u8] =
        include_bytes!("../../../scripts/fixtures/macos-updater/mish-alpha.json");
    const METADATA_SIGNATURE: &str =
        include_str!("../../../scripts/fixtures/macos-updater/mish-alpha.json.sig");
    const ARTIFACT: &[u8] = include_bytes!(
        "../../../scripts/fixtures/macos-updater/Mish-0.1.1-alpha.2-aarch64.app.tar.gz"
    );
    const ARTIFACT_SIGNATURE: &str = include_str!(
        "../../../scripts/fixtures/macos-updater/Mish-0.1.1-alpha.2-aarch64.app.tar.gz.sig"
    );
    const ARTIFACT_NAME: &str = "Mish-0.1.1-alpha.2-aarch64.app.tar.gz";

    fn policy(
        installed_version: &str,
        installed_channel: UpdateChannel,
        selected_channel: UpdateChannel,
    ) -> UpdatePolicy {
        UpdatePolicy {
            installed: InstalledUpdate {
                channel: installed_channel,
                version: installed_version.into(),
            },
            selected_channel,
        }
    }

    fn adapter() -> UpdaterAdapter {
        UpdaterAdapter::new(PUBLIC_KEY.trim()).expect("fixture public key must be valid")
    }

    fn verify(
        accepted_metadata_sha256: &[String],
        artifact: &[u8],
        artifact_name: &str,
        artifact_signature: &str,
        metadata: &[u8],
        metadata_signature: &str,
    ) -> Result<VerifiedUpdate, UpdaterError> {
        adapter().verify_candidate(VerifyCandidateRequest {
            accepted_metadata_sha256,
            artifact,
            artifact_name,
            artifact_signature: artifact_signature.trim(),
            metadata,
            metadata_signature: metadata_signature.trim(),
            policy: policy("0.1.1-alpha.1", UpdateChannel::Alpha, UpdateChannel::Alpha),
        })
    }

    #[test]
    fn verifies_the_exact_tauri_metadata_and_payload_before_installation() {
        let verified = verify(
            &[],
            ARTIFACT,
            ARTIFACT_NAME,
            ARTIFACT_SIGNATURE,
            METADATA,
            METADATA_SIGNATURE,
        )
        .expect("fixture candidate must verify");
        assert_eq!(adapter().availability(), UpdaterAvailability::ContractOnly);
        assert_eq!(verified.channel, UpdateChannel::Alpha);
        assert_eq!(verified.version, "0.1.1-alpha.2");
        assert_eq!(verified.source_sha, "1".repeat(40));
        assert!(!verified.channel_switch);
    }

    #[test]
    fn compares_strict_semver_for_newer_equal_older_skipped_and_lexical_traps() {
        let cases = [
            ("0.1.9", "0.1.10", Ok(false)),
            ("0.1.1", "0.1.1", Err(UpdaterError::EqualVersionRejected)),
            ("0.1.2", "0.1.1", Err(UpdaterError::DowngradeRejected)),
            ("0.1.1", "0.1.3", Ok(true)),
        ];
        for (installed, candidate, expected) in cases {
            let result = evaluate_update(
                &policy(installed, UpdateChannel::Stable, UpdateChannel::Stable),
                candidate,
                UpdateChannel::Stable,
            )
            .map(|selection| selection.skipped_version);
            assert_eq!(result, expected, "{installed} -> {candidate}");
        }
        for (installed, candidate, skipped) in [
            ("0.1.1-alpha.1", "0.1.1-alpha.2", false),
            ("0.1.1-alpha.1", "0.1.1-alpha.3", true),
        ] {
            assert_eq!(
                evaluate_update(
                    &policy(installed, UpdateChannel::Alpha, UpdateChannel::Alpha),
                    candidate,
                    UpdateChannel::Alpha,
                )
                .expect("newer Alpha must be selected")
                .skipped_version,
                skipped,
                "{installed} -> {candidate}",
            );
        }
        for malformed in ["v0.1.2", "0.1", "0.1.2+build.1", "0.1.02", "latest"] {
            assert_eq!(
                evaluate_update(
                    &policy("0.1.1", UpdateChannel::Stable, UpdateChannel::Stable),
                    malformed,
                    UpdateChannel::Stable,
                ),
                Err(UpdaterError::MalformedUpdateVersion),
            );
        }
    }

    #[test]
    fn keeps_alpha_and_stable_channels_explicit_across_switches() {
        assert_eq!(
            evaluate_update(
                &policy("0.1.0", UpdateChannel::Stable, UpdateChannel::Stable),
                "9.0.0-alpha.1",
                UpdateChannel::Alpha,
            ),
            Err(UpdaterError::ChannelMismatch),
        );
        assert_eq!(
            evaluate_update(
                &policy("0.1.0", UpdateChannel::Stable, UpdateChannel::Stable),
                "0.2.0-alpha.1",
                UpdateChannel::Stable,
            ),
            Err(UpdaterError::WrongChannelVersion),
        );
        assert!(
            evaluate_update(
                &policy("0.1.0", UpdateChannel::Stable, UpdateChannel::Alpha),
                "0.2.0-alpha.1",
                UpdateChannel::Alpha,
            )
            .expect("explicit switch to a newer Alpha is allowed")
            .channel_switch
        );
        assert!(
            evaluate_update(
                &policy("0.2.0-alpha.9", UpdateChannel::Alpha, UpdateChannel::Stable,),
                "0.2.0",
                UpdateChannel::Stable,
            )
            .expect("explicit switch to the matching stable release is allowed")
            .channel_switch
        );
        assert_eq!(
            evaluate_update(
                &policy("1.0.0", UpdateChannel::Stable, UpdateChannel::Alpha),
                "0.9.0-alpha.9",
                UpdateChannel::Alpha,
            ),
            Err(UpdaterError::DowngradeRejected),
        );
    }

    #[test]
    fn fails_closed_for_missing_invalid_mismatched_replayed_or_substituted_inputs() {
        assert_eq!(
            verify(
                &[],
                ARTIFACT,
                ARTIFACT_NAME,
                ARTIFACT_SIGNATURE,
                METADATA,
                "",
            ),
            Err(UpdaterError::MissingMetadataSignature),
        );
        let mut changed_metadata = METADATA.to_vec();
        changed_metadata[10] ^= 1;
        assert_eq!(
            verify(
                &[],
                ARTIFACT,
                ARTIFACT_NAME,
                ARTIFACT_SIGNATURE,
                &changed_metadata,
                METADATA_SIGNATURE,
            ),
            Err(UpdaterError::MetadataSignatureInvalid),
        );
        assert_eq!(
            verify(
                &[],
                ARTIFACT,
                ARTIFACT_NAME,
                "",
                METADATA,
                METADATA_SIGNATURE,
            ),
            Err(UpdaterError::MissingArtifactSignature),
        );
        assert_eq!(
            verify(
                &[],
                ARTIFACT,
                ARTIFACT_NAME,
                METADATA_SIGNATURE,
                METADATA,
                METADATA_SIGNATURE,
            ),
            Err(UpdaterError::ArtifactSignatureMismatch),
        );
        assert_eq!(
            adapter().verify_signature(
                ARTIFACT,
                METADATA_SIGNATURE.trim(),
                UpdaterError::ArtifactSignatureInvalid,
            ),
            Err(UpdaterError::ArtifactSignatureInvalid),
        );
        let mut substituted = ARTIFACT.to_vec();
        substituted[0] ^= 1;
        assert_eq!(
            verify(
                &[],
                &substituted,
                ARTIFACT_NAME,
                ARTIFACT_SIGNATURE,
                METADATA,
                METADATA_SIGNATURE,
            ),
            Err(UpdaterError::ArtifactDigestMismatch),
        );
        assert_eq!(
            verify(
                &[],
                ARTIFACT,
                "Mish-0.1.1-alpha.2-aarch64.app.tar.gz.substituted",
                ARTIFACT_SIGNATURE,
                METADATA,
                METADATA_SIGNATURE,
            ),
            Err(UpdaterError::ArtifactIdentityMismatch),
        );

        let verified = verify(
            &[],
            ARTIFACT,
            ARTIFACT_NAME,
            ARTIFACT_SIGNATURE,
            METADATA,
            METADATA_SIGNATURE,
        )
        .expect("first observation must verify");
        assert_eq!(
            verify(
                &[verified.metadata_sha256],
                ARTIFACT,
                ARTIFACT_NAME,
                ARTIFACT_SIGNATURE,
                METADATA,
                METADATA_SIGNATURE,
            ),
            Err(UpdaterError::MetadataReplay),
        );

        let mut authenticated =
            serde_json::from_slice::<TauriStaticMetadata>(METADATA).expect("fixture metadata");
        authenticated.mish.source_sha = "A".repeat(40);
        assert_eq!(
            validate_metadata_identity(&authenticated, ARTIFACT_NAME, ARTIFACT),
            Err(UpdaterError::InvalidSourceIdentity),
        );
        authenticated.mish.source_sha = "1".repeat(40);
        authenticated
            .platforms
            .get_mut(DARWIN_AARCH64_TARGET)
            .expect("fixture platform")
            .url = format!(
            "https://token@example.invalid/{}?credential=secret",
            ARTIFACT_NAME
        );
        assert_eq!(
            validate_metadata_identity(&authenticated, ARTIFACT_NAME, ARTIFACT),
            Err(UpdaterError::InvalidArtifactUrl),
        );
    }

    #[test]
    fn diagnostics_are_typed_and_do_not_echo_sensitive_inputs() {
        for error in [
            UpdaterError::InvalidArtifactUrl,
            UpdaterError::MetadataSignatureInvalid,
            UpdaterError::ArtifactSignatureInvalid,
            UpdaterError::InvalidSourceIdentity,
        ] {
            let rendered = error.to_string();
            assert_eq!(rendered, error.code());
            assert!(!rendered.contains("https://"));
            assert!(!rendered.contains("111111"));
            assert!(!rendered.contains("dW50cnVzdGVk"));
        }
    }
}
