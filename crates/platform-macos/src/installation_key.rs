use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use p256::{
    ecdsa::{
        Signature, SigningKey, VerifyingKey,
        signature::{Signer, Verifier},
    },
    pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey},
};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DEV_TUN_CLIENT_KEY_FILE_NAME: &str = "tun-client-key.json";
pub const DEV_TUN_PENDING_CLIENT_KEY_FILE_NAME: &str = "tun-client-key.pending.json";
pub const DEV_TUN_INSTALLATION_KEY_ALGORITHM: &str = "p256-sha256";
pub const DEV_TUN_INSTALLATION_KEY_RECORD_VERSION: u16 = 1;
pub const DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION: u16 = 1;
pub const DEV_TUN_SERVICE_ENROLLMENT_PATH: &str =
    "/Library/Application Support/com.asuka109.mish/tun-helper-dev/enrollment.json";
const RECORD_MAX_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationEnrollmentRecord {
    pub algorithm: String,
    pub generation: u64,
    pub helper_installation_id: String,
    pub installing_uid: u32,
    pub key_id: String,
    pub public_key_spki: String,
    pub schema_version: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationPublicKeyCandidate {
    pub algorithm: String,
    pub helper_installation_id: String,
    pub installing_uid: u32,
    pub key_id: String,
    pub public_key_spki: String,
    pub schema_version: u16,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallationClientKeyRecord {
    algorithm: String,
    key_id: String,
    private_key_pkcs8: String,
    public_key_spki: String,
    schema_version: u16,
}

impl std::fmt::Debug for InstallationClientKeyRecord {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InstallationClientKeyRecord")
            .field("algorithm", &self.algorithm)
            .field("key_id", &self.key_id)
            .field("private_key_pkcs8", &"[redacted]")
            .field("public_key_spki", &self.public_key_spki)
            .field("schema_version", &self.schema_version)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallationKeyRotationRequest {
    pub algorithm: String,
    pub current_generation: u64,
    pub current_key_id: String,
    pub helper_installation_id: String,
    pub installing_uid: u32,
    pub new_signature: String,
    pub old_signature: String,
    pub replacement_key_id: String,
    pub replacement_public_key_spki: String,
    pub schema_version: u16,
    pub transcript_version: u16,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationEnrollmentReceipt {
    pub generation: u64,
    pub key_id: String,
    pub operation: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstallationEnrollmentOperation {
    Enroll,
    Reset,
    Rotate,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthenticationTranscript {
    pub client_nonce: [u8; 32],
    pub command_digest: [u8; 32],
    pub expires_at: u64,
    pub helper_installation_id: String,
    pub helper_nonce: [u8; 32],
    pub issued_at: u64,
    pub key_generation: u64,
    pub key_id: String,
    pub operation: String,
    pub peer_pid: u32,
    pub peer_uid: u32,
    pub protocol_version: u16,
    pub request_id: String,
}

impl AuthenticationTranscript {
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, &'static str> {
        let mut bytes = Vec::with_capacity(512);
        bytes.extend_from_slice(b"MISH-TUN-INSTALLATION-PROOF\0");
        push_u16(&mut bytes, DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION);
        push_u16(&mut bytes, self.protocol_version);
        push_string(&mut bytes, &self.helper_installation_id)?;
        push_u64(&mut bytes, self.key_generation);
        push_string(&mut bytes, &self.key_id)?;
        bytes.extend_from_slice(&self.helper_nonce);
        bytes.extend_from_slice(&self.client_nonce);
        push_u32(&mut bytes, self.peer_uid);
        push_u32(&mut bytes, self.peer_pid);
        push_string(&mut bytes, &self.operation)?;
        push_string(&mut bytes, &self.request_id)?;
        bytes.extend_from_slice(&self.command_digest);
        push_u64(&mut bytes, self.issued_at);
        push_u64(&mut bytes, self.expires_at);
        Ok(bytes)
    }
}

#[derive(Clone)]
pub struct InstallationClientKeyStore {
    active_path: PathBuf,
    allowed_uid: u32,
    pending_path: PathBuf,
}

impl std::fmt::Debug for InstallationClientKeyStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InstallationClientKeyStore")
            .field("active_path", &"[redacted]")
            .field("allowed_uid", &self.allowed_uid)
            .field("pending_path", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstallationClientKeySource {
    Active,
    Pending,
}

impl InstallationClientKeyStore {
    pub fn new(active_path: PathBuf, pending_path: PathBuf, allowed_uid: u32) -> Self {
        Self {
            active_path,
            allowed_uid,
            pending_path,
        }
    }

    pub fn for_runtime_root(runtime_root: &Path, allowed_uid: u32) -> Self {
        Self::new(
            runtime_root.join(DEV_TUN_CLIENT_KEY_FILE_NAME),
            runtime_root.join(DEV_TUN_PENDING_CLIENT_KEY_FILE_NAME),
            allowed_uid,
        )
    }

    pub fn ensure_public_candidate(
        &self,
        helper_installation_id: &str,
    ) -> Result<InstallationPublicKeyCandidate, &'static str> {
        if !valid_installation_id(helper_installation_id) {
            return Err("the installation candidate identity was rejected");
        }
        let record = match fs::symlink_metadata(&self.active_path) {
            Ok(_) => read_client_key(&self.active_path, self.allowed_uid)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let signing_key = SigningKey::random(&mut OsRng);
                let private_key = signing_key
                    .to_pkcs8_der()
                    .map_err(|_| "the client private key could not be encoded")?;
                let public_key = signing_key
                    .verifying_key()
                    .to_public_key_der()
                    .map_err(|_| "the client public key could not be encoded")?;
                let record = InstallationClientKeyRecord {
                    algorithm: DEV_TUN_INSTALLATION_KEY_ALGORITHM.into(),
                    key_id: format!("{:x}", Sha256::digest(public_key.as_bytes())),
                    private_key_pkcs8: BASE64.encode(private_key.as_bytes()),
                    public_key_spki: BASE64.encode(public_key.as_bytes()),
                    schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
                };
                write_atomic_private_record(&self.active_path, &record, self.allowed_uid)?;
                read_client_key(&self.active_path, self.allowed_uid)?
            }
            Err(_) => return Err("the client installation key was unavailable"),
        };
        Ok(InstallationPublicKeyCandidate {
            algorithm: record.algorithm,
            helper_installation_id: helper_installation_id.into(),
            installing_uid: self.allowed_uid,
            key_id: record.key_id,
            public_key_spki: record.public_key_spki,
            schema_version: record.schema_version,
        })
    }

    pub fn write_public_candidate(
        &self,
        path: &Path,
        helper_installation_id: &str,
    ) -> Result<InstallationPublicKeyCandidate, &'static str> {
        let candidate = self.ensure_public_candidate(helper_installation_id)?;
        let bytes = serde_json::to_vec(&candidate)
            .map_err(|_| "the installation public-key candidate was invalid")?;
        write_atomic_bytes(path, &bytes, self.allowed_uid)?;
        Ok(candidate)
    }

    pub fn sign(
        &self,
        key_id: &str,
        transcript: &[u8],
    ) -> Result<(Vec<u8>, InstallationClientKeySource), &'static str> {
        for (path, source) in [
            (&self.active_path, InstallationClientKeySource::Active),
            (&self.pending_path, InstallationClientKeySource::Pending),
        ] {
            let Ok(record) = read_client_key(path, self.allowed_uid) else {
                continue;
            };
            if record.key_id != key_id {
                continue;
            }
            let private_key = BASE64
                .decode(record.private_key_pkcs8)
                .map_err(|_| "client private key encoding was rejected")?;
            let signing_key = SigningKey::from_pkcs8_der(&private_key)
                .map_err(|_| "client private key was rejected")?;
            let signature: Signature = signing_key.sign(transcript);
            return Ok((signature.to_der().as_bytes().to_vec(), source));
        }
        Err("the enrolled installation key is unavailable")
    }

    pub fn finalize_pending(
        &self,
        source: InstallationClientKeySource,
    ) -> Result<(), &'static str> {
        if source == InstallationClientKeySource::Active {
            return Ok(());
        }
        let record = read_client_key(&self.pending_path, self.allowed_uid)?;
        write_atomic_private_record(&self.active_path, &record, self.allowed_uid)?;
        fs::remove_file(&self.pending_path)
            .map_err(|_| "the pending installation key could not be removed")?;
        sync_parent(&self.pending_path)?;
        Ok(())
    }
}

pub fn load_installation_enrollment(
    path: &Path,
    installing_uid: u32,
    require_root: bool,
    helper_installation_id: &str,
) -> Result<InstallationEnrollmentRecord, &'static str> {
    let record = load_installation_enrollment_for_user(path, installing_uid, require_root)?;
    if record.helper_installation_id != helper_installation_id {
        return Err("the installation enrollment identity was rejected");
    }
    Ok(record)
}

pub fn load_installation_enrollment_for_user(
    path: &Path,
    installing_uid: u32,
    require_root: bool,
) -> Result<InstallationEnrollmentRecord, &'static str> {
    let owner = if require_root { 0 } else { installing_uid };
    let record: InstallationEnrollmentRecord = read_private_json(path, owner)?;
    validate_enrollment_record(&record)?;
    if record.installing_uid != installing_uid {
        return Err("the installation enrollment identity was rejected");
    }
    Ok(record)
}

pub fn verify_installation_signature(
    enrollment: &InstallationEnrollmentRecord,
    transcript: &[u8],
    signature: &[u8],
) -> Result<(), &'static str> {
    let public_key = BASE64
        .decode(&enrollment.public_key_spki)
        .map_err(|_| "the enrolled public key encoding was rejected")?;
    let verifying_key = VerifyingKey::from_public_key_der(&public_key)
        .map_err(|_| "the enrolled public key was rejected")?;
    let signature =
        Signature::from_der(signature).map_err(|_| "the installation signature was malformed")?;
    verifying_key
        .verify(transcript, &signature)
        .map_err(|_| "the installation signature was rejected")
}

pub fn apply_installation_enrollment_operation(
    operation: InstallationEnrollmentOperation,
    candidate_paths: &[PathBuf],
    enrollment_path: &Path,
    helper_installation_id: &str,
    installing_uid: u32,
    require_root: bool,
) -> Result<InstallationEnrollmentReceipt, &'static str> {
    if !valid_installation_id(helper_installation_id) || candidate_paths.is_empty() {
        return Err("the enrollment operation identity was rejected");
    }
    let owner = if require_root { 0 } else { installing_uid };
    let existing = match fs::symlink_metadata(enrollment_path) {
        Ok(_) => Some(read_private_json::<InstallationEnrollmentRecord>(
            enrollment_path,
            owner,
        )?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("the existing enrollment record was unavailable"),
    };
    if let Some(existing) = &existing {
        validate_enrollment_record(existing)?;
        if existing.installing_uid != installing_uid {
            return Err("the existing enrollment user identity was rejected");
        }
    }

    let (next, operation_name) = match operation {
        InstallationEnrollmentOperation::Enroll => {
            let candidates = candidate_paths
                .iter()
                .map(|path| read_candidate(path, installing_uid, helper_installation_id))
                .collect::<Result<Vec<_>, _>>()?;
            let candidate = match &existing {
                Some(existing) => candidates
                    .iter()
                    .find(|candidate| {
                        candidate.key_id == existing.key_id
                            && candidate.public_key_spki == existing.public_key_spki
                    })
                    .ok_or("the enrolled key cannot be replaced by reinstall")?,
                None => candidates
                    .first()
                    .ok_or("the enrollment candidate was unavailable")?,
            };
            (
                InstallationEnrollmentRecord {
                    algorithm: candidate.algorithm.clone(),
                    generation: existing.as_ref().map_or(1, |record| record.generation),
                    helper_installation_id: helper_installation_id.to_owned(),
                    installing_uid,
                    key_id: candidate.key_id.clone(),
                    public_key_spki: candidate.public_key_spki.clone(),
                    schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
                },
                "enroll",
            )
        }
        InstallationEnrollmentOperation::Reset => {
            let candidate = read_candidate(
                candidate_paths
                    .first()
                    .ok_or("the reset candidate was unavailable")?,
                installing_uid,
                helper_installation_id,
            )?;
            if let Some(existing) = existing.as_ref()
                && existing.key_id == candidate.key_id
            {
                if existing.helper_installation_id == helper_installation_id
                    && existing.algorithm == candidate.algorithm
                    && existing.public_key_spki == candidate.public_key_spki
                {
                    return Ok(InstallationEnrollmentReceipt {
                        generation: existing.generation,
                        key_id: existing.key_id.clone(),
                        operation: "reset",
                    });
                }
                return Err("the committed reset identity was rejected");
            }
            (
                InstallationEnrollmentRecord {
                    algorithm: candidate.algorithm,
                    generation: existing
                        .as_ref()
                        .map_or(1, |record| record.generation.saturating_add(1)),
                    helper_installation_id: helper_installation_id.to_owned(),
                    installing_uid,
                    key_id: candidate.key_id,
                    public_key_spki: candidate.public_key_spki,
                    schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
                },
                "reset",
            )
        }
        InstallationEnrollmentOperation::Rotate => {
            let current = existing.ok_or("rotation requires an existing enrollment")?;
            if current.helper_installation_id != helper_installation_id {
                return Err("rotation requires the current helper installation identity");
            }
            let request: InstallationKeyRotationRequest = read_private_json(
                candidate_paths
                    .first()
                    .ok_or("the rotation request was unavailable")?,
                installing_uid,
            )?;
            let replacement = validate_rotation_request(&request, &current)?;
            (replacement, "rotate")
        }
    };
    write_atomic_enrollment(enrollment_path, &next, owner)?;
    Ok(InstallationEnrollmentReceipt {
        generation: next.generation,
        key_id: next.key_id,
        operation: operation_name,
    })
}

pub fn remove_installation_enrollment(
    enrollment_path: &Path,
    installing_uid: u32,
    require_root: bool,
) -> Result<(), &'static str> {
    let owner = if require_root { 0 } else { installing_uid };
    match fs::symlink_metadata(enrollment_path) {
        Ok(_) => {
            let record: InstallationEnrollmentRecord = read_private_json(enrollment_path, owner)?;
            validate_enrollment_record(&record)?;
            if record.installing_uid != installing_uid {
                return Err("the existing enrollment user identity was rejected");
            }
            fs::remove_file(enrollment_path)
                .map_err(|_| "the enrollment record could not be removed")?;
            sync_parent(enrollment_path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("the existing enrollment record was unavailable"),
    }

    let enrollment_directory = enrollment_path
        .parent()
        .ok_or("the installation key record parent was invalid")?;
    match fs::symlink_metadata(enrollment_directory) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || !metadata.is_dir()
                || metadata.uid() != owner
                || metadata.permissions().mode() & 0o077 != 0
            {
                return Err("the installation key record parent metadata was rejected");
            }
            fs::remove_dir(enrollment_directory)
                .map_err(|_| "the enrollment directory could not be removed")?;
            sync_directory_parent(enrollment_directory)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("the enrollment directory was unavailable"),
    }
    Ok(())
}

fn read_candidate(
    path: &Path,
    installing_uid: u32,
    helper_installation_id: &str,
) -> Result<InstallationPublicKeyCandidate, &'static str> {
    let candidate: InstallationPublicKeyCandidate = read_private_json(path, installing_uid)?;
    validate_public_candidate(&candidate)?;
    if candidate.installing_uid != installing_uid
        || candidate.helper_installation_id != helper_installation_id
    {
        return Err("the enrollment candidate identity was rejected");
    }
    Ok(candidate)
}

fn validate_rotation_request(
    request: &InstallationKeyRotationRequest,
    current: &InstallationEnrollmentRecord,
) -> Result<InstallationEnrollmentRecord, &'static str> {
    if request.schema_version != DEV_TUN_INSTALLATION_KEY_RECORD_VERSION
        || request.transcript_version != DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION
        || request.algorithm != DEV_TUN_INSTALLATION_KEY_ALGORITHM
        || request.current_generation != current.generation
        || request.current_key_id != current.key_id
        || request.helper_installation_id != current.helper_installation_id
        || request.installing_uid != current.installing_uid
        || request.replacement_key_id == current.key_id
    {
        return Err("the rotation request identity was rejected");
    }
    validate_public_key(
        &request.replacement_key_id,
        &request.replacement_public_key_spki,
    )?;
    let transcript = canonical_rotation_transcript(request)?;
    let old_signature = BASE64
        .decode(&request.old_signature)
        .map_err(|_| "the current-key rotation signature was malformed")?;
    verify_installation_signature(current, &transcript, &old_signature)?;
    let replacement = InstallationEnrollmentRecord {
        algorithm: request.algorithm.clone(),
        generation: current
            .generation
            .checked_add(1)
            .ok_or("the enrollment generation was exhausted")?,
        helper_installation_id: request.helper_installation_id.clone(),
        installing_uid: request.installing_uid,
        key_id: request.replacement_key_id.clone(),
        public_key_spki: request.replacement_public_key_spki.clone(),
        schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
    };
    let new_signature = BASE64
        .decode(&request.new_signature)
        .map_err(|_| "the replacement-key rotation signature was malformed")?;
    verify_installation_signature(&replacement, &transcript, &new_signature)?;
    Ok(replacement)
}

pub fn canonical_rotation_transcript(
    request: &InstallationKeyRotationRequest,
) -> Result<Vec<u8>, &'static str> {
    let replacement_key = BASE64
        .decode(&request.replacement_public_key_spki)
        .map_err(|_| "the replacement public key encoding was rejected")?;
    let mut bytes = Vec::with_capacity(384);
    bytes.extend_from_slice(b"MISH-TUN-INSTALLATION-ROTATION\0");
    push_u16(&mut bytes, request.transcript_version);
    push_string(&mut bytes, &request.algorithm)?;
    push_string(&mut bytes, &request.helper_installation_id)?;
    push_u32(&mut bytes, request.installing_uid);
    push_u64(&mut bytes, request.current_generation);
    push_string(&mut bytes, &request.current_key_id)?;
    push_u64(
        &mut bytes,
        request
            .current_generation
            .checked_add(1)
            .ok_or("the enrollment generation was exhausted")?,
    );
    push_string(&mut bytes, &request.replacement_key_id)?;
    bytes.extend_from_slice(&Sha256::digest(replacement_key));
    Ok(bytes)
}

fn read_client_key(
    path: &Path,
    allowed_uid: u32,
) -> Result<InstallationClientKeyRecord, &'static str> {
    let record: InstallationClientKeyRecord = read_private_json(path, allowed_uid)?;
    if record.schema_version != DEV_TUN_INSTALLATION_KEY_RECORD_VERSION
        || record.algorithm != DEV_TUN_INSTALLATION_KEY_ALGORITHM
    {
        return Err("the client installation key metadata was rejected");
    }
    validate_public_key(&record.key_id, &record.public_key_spki)?;
    let private_key = BASE64
        .decode(&record.private_key_pkcs8)
        .map_err(|_| "the client private key encoding was rejected")?;
    let signing_key = SigningKey::from_pkcs8_der(&private_key)
        .map_err(|_| "the client private key was rejected")?;
    let public_key = BASE64
        .decode(&record.public_key_spki)
        .map_err(|_| "the client public key encoding was rejected")?;
    let verifying_key = VerifyingKey::from_public_key_der(&public_key)
        .map_err(|_| "the client public key was rejected")?;
    if signing_key.verifying_key() != &verifying_key {
        return Err("the client installation key pair did not match");
    }
    Ok(record)
}

fn validate_enrollment_record(record: &InstallationEnrollmentRecord) -> Result<(), &'static str> {
    if record.schema_version != DEV_TUN_INSTALLATION_KEY_RECORD_VERSION
        || record.algorithm != DEV_TUN_INSTALLATION_KEY_ALGORITHM
        || record.generation == 0
        || !valid_installation_id(&record.helper_installation_id)
    {
        return Err("the installation enrollment record was rejected");
    }
    validate_public_key(&record.key_id, &record.public_key_spki)
}

fn validate_public_candidate(
    candidate: &InstallationPublicKeyCandidate,
) -> Result<(), &'static str> {
    if candidate.schema_version != DEV_TUN_INSTALLATION_KEY_RECORD_VERSION
        || candidate.algorithm != DEV_TUN_INSTALLATION_KEY_ALGORITHM
        || !valid_installation_id(&candidate.helper_installation_id)
    {
        return Err("the installation public-key candidate was rejected");
    }
    validate_public_key(&candidate.key_id, &candidate.public_key_spki)
}

fn validate_public_key(key_id: &str, public_key_spki: &str) -> Result<(), &'static str> {
    if !valid_key_id(key_id) {
        return Err("the installation key identifier was rejected");
    }
    let public_key = BASE64
        .decode(public_key_spki)
        .map_err(|_| "the installation public key encoding was rejected")?;
    VerifyingKey::from_public_key_der(&public_key)
        .map_err(|_| "the installation public key was rejected")?;
    let expected = format!("{:x}", Sha256::digest(&public_key));
    if expected != key_id {
        return Err("the installation public key identifier did not match");
    }
    Ok(())
}

fn read_private_json<T: for<'de> Deserialize<'de>>(
    path: &Path,
    owner_uid: u32,
) -> Result<T, &'static str> {
    validate_private_parent(path, owner_uid)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "the installation key record was unavailable")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != owner_uid
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
        || metadata.len() == 0
        || metadata.len() > RECORD_MAX_BYTES
    {
        return Err("the installation key record metadata was rejected");
    }
    let bytes = fs::read(path).map_err(|_| "the installation key record could not be read")?;
    serde_json::from_slice(&bytes).map_err(|_| "the installation key record was malformed")
}

fn write_atomic_enrollment(
    path: &Path,
    record: &InstallationEnrollmentRecord,
    owner_uid: u32,
) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(record).map_err(|_| "the enrollment record was invalid")?;
    write_atomic_bytes(path, &bytes, owner_uid)
}

fn write_atomic_private_record(
    path: &Path,
    record: &InstallationClientKeyRecord,
    owner_uid: u32,
) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(record).map_err(|_| "the client key record was invalid")?;
    write_atomic_bytes(path, &bytes, owner_uid)
}

fn write_atomic_bytes(path: &Path, bytes: &[u8], owner_uid: u32) -> Result<(), &'static str> {
    if bytes.is_empty() || bytes.len() as u64 > RECORD_MAX_BYTES {
        return Err("the installation key record size was rejected");
    }
    let parent = path
        .parent()
        .ok_or("the installation key record parent was invalid")?;
    validate_private_parent(path, owner_uid)?;
    let temporary = parent.join(format!(
        ".{}.{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .ok_or("the installation key record name was invalid")?,
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .map_err(|_| "the installation key temporary record could not be created")?;
        file.write_all(bytes)
            .map_err(|_| "the installation key record could not be written")?;
        file.write_all(b"\n")
            .map_err(|_| "the installation key record could not be written")?;
        file.sync_all()
            .map_err(|_| "the installation key record could not be synchronized")?;
        let metadata = file
            .metadata()
            .map_err(|_| "the installation key temporary metadata was unavailable")?;
        if metadata.uid() != owner_uid || metadata.permissions().mode() & 0o777 != 0o600 {
            return Err("the installation key temporary metadata was rejected");
        }
        fs::rename(&temporary, path)
            .map_err(|_| "the installation key record could not be committed")?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_private_parent(path: &Path, owner_uid: u32) -> Result<(), &'static str> {
    let parent = path
        .parent()
        .ok_or("the installation key record parent was invalid")?;
    let metadata = fs::symlink_metadata(parent)
        .map_err(|_| "the installation key record parent was unavailable")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != owner_uid
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err("the installation key record parent metadata was rejected");
    }
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), &'static str> {
    let parent = path
        .parent()
        .ok_or("the installation key record parent was invalid")?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "the installation key record parent could not be synchronized")
}

fn sync_directory_parent(path: &Path) -> Result<(), &'static str> {
    let parent = path
        .parent()
        .ok_or("the enrollment directory parent was invalid")?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "the enrollment directory parent could not be synchronized")
}

fn push_u16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_be_bytes());
}

fn push_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_be_bytes());
}

fn push_u64(bytes: &mut Vec<u8>, value: u64) {
    bytes.extend_from_slice(&value.to_be_bytes());
}

fn push_string(bytes: &mut Vec<u8>, value: &str) -> Result<(), &'static str> {
    let length = u32::try_from(value.len()).map_err(|_| "canonical field was too large")?;
    push_u32(bytes, length);
    bytes.extend_from_slice(value.as_bytes());
    Ok(())
}

fn valid_key_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_installation_id(value: &str) -> bool {
    valid_key_id(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn key_pair() -> (InstallationClientKeyRecord, InstallationPublicKeyCandidate) {
        let signing = SigningKey::random(&mut OsRng);
        let private_key = signing.to_pkcs8_der().unwrap();
        let public_key = signing.verifying_key().to_public_key_der().unwrap();
        let public_key_spki = BASE64.encode(public_key.as_bytes());
        let key_id = format!("{:x}", Sha256::digest(public_key.as_bytes()));
        (
            InstallationClientKeyRecord {
                algorithm: DEV_TUN_INSTALLATION_KEY_ALGORITHM.into(),
                key_id: key_id.clone(),
                private_key_pkcs8: BASE64.encode(private_key.as_bytes()),
                public_key_spki: public_key_spki.clone(),
                schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
            },
            InstallationPublicKeyCandidate {
                algorithm: DEV_TUN_INSTALLATION_KEY_ALGORITHM.into(),
                helper_installation_id: "a".repeat(64),
                installing_uid: unsafe { libc::getuid() },
                key_id,
                public_key_spki,
                schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
            },
        )
    }

    fn write_private(path: &Path, value: &impl Serialize) {
        fs::set_permissions(
            path.parent().expect("private record parent"),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }

    #[test]
    fn canonical_authentication_transcript_has_a_stable_vector() {
        let transcript = AuthenticationTranscript {
            client_nonce: [0x22; 32],
            command_digest: [0x33; 32],
            expires_at: 1_010,
            helper_installation_id: "a".repeat(64),
            helper_nonce: [0x11; 32],
            issued_at: 1_000,
            key_generation: 7,
            key_id: "b".repeat(64),
            operation: "disable".into(),
            peer_pid: 42,
            peer_uid: 501,
            protocol_version: 3,
            request_id: "11111111-1111-4111-8111-111111111111".into(),
        };
        let bytes = transcript.canonical_bytes().unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            "bdfede6d18365b21f20d146ee0a2cd9354928c50d9cd24d64d3ee3a971f0fe76"
        );
    }

    #[test]
    fn canonical_rotation_transcript_matches_the_installer_vector() {
        let request = InstallationKeyRotationRequest {
            algorithm: DEV_TUN_INSTALLATION_KEY_ALGORITHM.into(),
            current_generation: 7,
            current_key_id: "b".repeat(64),
            helper_installation_id: "a".repeat(64),
            installing_uid: 501,
            new_signature: String::new(),
            old_signature: String::new(),
            replacement_key_id: "c".repeat(64),
            replacement_public_key_spki: BASE64.encode([1_u8, 2, 3]),
            schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
            transcript_version: DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION,
        };
        assert_eq!(
            format!(
                "{:x}",
                Sha256::digest(canonical_rotation_transcript(&request).unwrap())
            ),
            "dc0e227c96271cf1f957732e703b489bea0d41c3318284fb332aa23b45ebfd57"
        );
    }

    #[test]
    fn possession_proof_binds_installation_generation_peer_command_and_time() {
        let (client, candidate) = key_pair();
        let enrollment = InstallationEnrollmentRecord {
            algorithm: candidate.algorithm,
            generation: 3,
            helper_installation_id: candidate.helper_installation_id,
            installing_uid: candidate.installing_uid,
            key_id: candidate.key_id,
            public_key_spki: candidate.public_key_spki,
            schema_version: candidate.schema_version,
        };
        let transcript = AuthenticationTranscript {
            client_nonce: [0x22; 32],
            command_digest: [0x33; 32],
            expires_at: 1_010,
            helper_installation_id: enrollment.helper_installation_id.clone(),
            helper_nonce: [0x11; 32],
            issued_at: 1_000,
            key_generation: enrollment.generation,
            key_id: enrollment.key_id.clone(),
            operation: "start".into(),
            peer_pid: 42,
            peer_uid: enrollment.installing_uid,
            protocol_version: 3,
            request_id: "11111111-1111-4111-8111-111111111111".into(),
        };
        let key =
            SigningKey::from_pkcs8_der(&BASE64.decode(&client.private_key_pkcs8).unwrap()).unwrap();
        let bytes = transcript.canonical_bytes().unwrap();
        let signature: Signature = key.sign(&bytes);
        let signature = signature.to_der();
        verify_installation_signature(&enrollment, &bytes, signature.as_bytes()).unwrap();

        let mutations = [
            {
                let mut value = transcript.clone();
                value.helper_installation_id = "f".repeat(64);
                value
            },
            {
                let mut value = transcript.clone();
                value.key_generation += 1;
                value
            },
            {
                let mut value = transcript.clone();
                value.peer_uid += 1;
                value
            },
            {
                let mut value = transcript.clone();
                value.peer_pid += 1;
                value
            },
            {
                let mut value = transcript.clone();
                value.operation = "disable".into();
                value
            },
            {
                let mut value = transcript.clone();
                value.command_digest[0] ^= 1;
                value
            },
            {
                let mut value = transcript.clone();
                value.helper_nonce[0] ^= 1;
                value
            },
            {
                let mut value = transcript.clone();
                value.client_nonce[0] ^= 1;
                value
            },
            {
                let mut value = transcript.clone();
                value.issued_at += 1;
                value
            },
            {
                let mut value = transcript.clone();
                value.expires_at += 1;
                value
            },
        ];
        for mutation in mutations {
            assert!(
                verify_installation_signature(
                    &enrollment,
                    &mutation.canonical_bytes().unwrap(),
                    signature.as_bytes(),
                )
                .is_err()
            );
        }
        let (_, wrong_key) = key_pair();
        let wrong_enrollment = InstallationEnrollmentRecord {
            public_key_spki: wrong_key.public_key_spki,
            key_id: wrong_key.key_id,
            ..enrollment
        };
        assert!(
            verify_installation_signature(&wrong_enrollment, &bytes, signature.as_bytes()).is_err()
        );
        assert!(verify_installation_signature(&wrong_enrollment, &bytes, b"malformed").is_err());
    }

    #[test]
    fn key_store_requires_private_mode_and_never_exposes_private_material_in_debug() {
        let temporary = tempfile::tempdir().unwrap();
        let (record, _) = key_pair();
        let active = temporary.path().join(DEV_TUN_CLIENT_KEY_FILE_NAME);
        write_private(&active, &record);
        let store = InstallationClientKeyStore::new(
            active.clone(),
            temporary.path().join(DEV_TUN_PENDING_CLIENT_KEY_FILE_NAME),
            unsafe { libc::getuid() },
        );
        let (signature, source) = store.sign(&record.key_id, b"transcript").unwrap();
        assert_eq!(source, InstallationClientKeySource::Active);
        assert!(!signature.is_empty());
        assert!(!format!("{store:?}").contains(&record.private_key_pkcs8));

        fs::set_permissions(&active, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(store.sign(&record.key_id, b"transcript").is_err());
    }

    #[test]
    fn key_store_creates_one_private_key_and_only_exports_its_public_candidate() {
        let temporary = tempfile::tempdir().unwrap();
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let uid = unsafe { libc::getuid() };
        let store = InstallationClientKeyStore::for_runtime_root(temporary.path(), uid);
        let candidate_path = temporary.path().join("enrollment.json");
        let first = store
            .write_public_candidate(&candidate_path, &"a".repeat(64))
            .unwrap();
        let second = store
            .write_public_candidate(&candidate_path, &"a".repeat(64))
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(
            fs::symlink_metadata(temporary.path().join(DEV_TUN_CLIENT_KEY_FILE_NAME))
                .unwrap()
                .mode()
                & 0o777,
            0o600
        );
        let candidate = fs::read_to_string(candidate_path).unwrap();
        assert!(!candidate.contains("privateKey"));
        assert!(candidate.contains(&first.public_key_spki));
    }

    #[test]
    fn enrollment_reinstall_preserves_generation_and_changed_key_requires_reset() {
        let temporary = tempfile::tempdir().unwrap();
        let (_, candidate) = key_pair();
        let candidate_path = temporary.path().join("candidate.json");
        let enrollment = temporary.path().join("enrollment.json");
        write_private(&candidate_path, &candidate);
        let uid = unsafe { libc::getuid() };
        let first = apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Enroll,
            std::slice::from_ref(&candidate_path),
            &enrollment,
            &candidate.helper_installation_id,
            uid,
            false,
        )
        .unwrap();
        let second = apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Enroll,
            std::slice::from_ref(&candidate_path),
            &enrollment,
            &candidate.helper_installation_id,
            uid,
            false,
        )
        .unwrap();
        assert_eq!(first.generation, 1);
        assert_eq!(second.generation, 1);
        assert_eq!(
            load_installation_enrollment_for_user(&enrollment, uid, false)
                .unwrap()
                .installing_uid,
            uid
        );
        assert!(
            load_installation_enrollment_for_user(&enrollment, uid.saturating_add(1), false)
                .is_err()
        );

        let (_, replacement) = key_pair();
        let replacement_path = temporary.path().join("replacement.json");
        write_private(&replacement_path, &replacement);
        assert!(
            apply_installation_enrollment_operation(
                InstallationEnrollmentOperation::Enroll,
                &[replacement_path],
                &enrollment,
                &candidate.helper_installation_id,
                uid,
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn explicit_uninstall_removes_the_enrollment_and_its_private_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let enrollment_directory = temporary.path().join("enrollment");
        fs::create_dir(&enrollment_directory).unwrap();
        fs::set_permissions(&enrollment_directory, fs::Permissions::from_mode(0o700)).unwrap();
        let enrollment_path = enrollment_directory.join("enrollment.json");
        let (_client, candidate) = key_pair();
        let candidate_path = temporary.path().join("candidate.json");
        write_private(&candidate_path, &candidate);
        apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Enroll,
            &[candidate_path],
            &enrollment_path,
            &candidate.helper_installation_id,
            candidate.installing_uid,
            false,
        )
        .unwrap();

        remove_installation_enrollment(&enrollment_path, candidate.installing_uid, false).unwrap();
        assert!(!enrollment_path.exists());
        assert!(!enrollment_directory.exists());
        remove_installation_enrollment(&enrollment_path, candidate.installing_uid, false).unwrap();
    }

    #[test]
    fn rotation_requires_both_keys_and_advances_without_an_overlap() {
        let temporary = tempfile::tempdir().unwrap();
        let (current_key, candidate) = key_pair();
        let (replacement_key, replacement) = key_pair();
        let candidate_path = temporary.path().join("candidate.json");
        let enrollment_path = temporary.path().join("enrollment.json");
        write_private(&candidate_path, &candidate);
        let uid = unsafe { libc::getuid() };
        apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Enroll,
            &[candidate_path],
            &enrollment_path,
            &candidate.helper_installation_id,
            uid,
            false,
        )
        .unwrap();
        let mut request = InstallationKeyRotationRequest {
            algorithm: DEV_TUN_INSTALLATION_KEY_ALGORITHM.into(),
            current_generation: 1,
            current_key_id: candidate.key_id.clone(),
            helper_installation_id: candidate.helper_installation_id.clone(),
            installing_uid: uid,
            new_signature: String::new(),
            old_signature: String::new(),
            replacement_key_id: replacement.key_id.clone(),
            replacement_public_key_spki: replacement.public_key_spki.clone(),
            schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
            transcript_version: DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION,
        };
        let transcript = canonical_rotation_transcript(&request).unwrap();
        let sign_rotation = |record: &InstallationClientKeyRecord| {
            let key =
                SigningKey::from_pkcs8_der(&BASE64.decode(&record.private_key_pkcs8).unwrap())
                    .unwrap();
            let signature: Signature = key.sign(&transcript);
            BASE64.encode(signature.to_der().as_bytes())
        };
        request.old_signature = sign_rotation(&current_key);
        request.new_signature = sign_rotation(&replacement_key);
        let request_path = temporary.path().join("rotation.json");
        write_private(&request_path, &request);
        let receipt = apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Rotate,
            std::slice::from_ref(&request_path),
            &enrollment_path,
            &candidate.helper_installation_id,
            uid,
            false,
        )
        .unwrap();
        assert_eq!(receipt.generation, 2);
        assert_eq!(receipt.key_id, replacement.key_id);
        let retired = load_installation_enrollment(
            &enrollment_path,
            uid,
            false,
            &candidate.helper_installation_id,
        )
        .unwrap();
        assert!(verify_installation_signature(&retired, b"proof", b"invalid").is_err());

        request.new_signature = BASE64.encode([0_u8; 8]);
        write_private(&request_path, &request);
        assert!(
            apply_installation_enrollment_operation(
                InstallationEnrollmentOperation::Rotate,
                &[request_path],
                &enrollment_path,
                &candidate.helper_installation_id,
                uid,
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn administrator_reset_replaces_a_lost_key_and_advances_generation() {
        let temporary = tempfile::tempdir().unwrap();
        let (_, candidate) = key_pair();
        let (_, replacement) = key_pair();
        let current_path = temporary.path().join("current.json");
        let replacement_path = temporary.path().join("replacement.json");
        let enrollment_path = temporary.path().join("enrollment.json");
        write_private(&current_path, &candidate);
        write_private(&replacement_path, &replacement);
        let uid = unsafe { libc::getuid() };
        apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Enroll,
            &[current_path],
            &enrollment_path,
            &candidate.helper_installation_id,
            uid,
            false,
        )
        .unwrap();
        let receipt = apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Reset,
            std::slice::from_ref(&replacement_path),
            &enrollment_path,
            &candidate.helper_installation_id,
            uid,
            false,
        )
        .unwrap();
        assert_eq!(receipt.generation, 2);
        assert_eq!(receipt.key_id, replacement.key_id);
        let replay = apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Reset,
            std::slice::from_ref(&replacement_path),
            &enrollment_path,
            &candidate.helper_installation_id,
            uid,
            false,
        )
        .unwrap();
        assert_eq!(
            replay, receipt,
            "a committed reset retry must be idempotent"
        );
        let enrolled = load_installation_enrollment(
            &enrollment_path,
            uid,
            false,
            &candidate.helper_installation_id,
        )
        .unwrap();
        assert_eq!(enrolled.key_id, replacement.key_id);
        assert_eq!(enrolled.generation, 2);
    }
}
