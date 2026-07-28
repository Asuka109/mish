use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

use crate::Correlation;

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoveryError {
    Invalid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryRecord<T> {
    pub admitted_revision: u64,
    pub machine_authority_sha256: String,
    pub operation_id_sha256: String,
    pub owner: String,
    pub payload: T,
    pub schema_version: u16,
    pub scope_epoch: u64,
}

pub struct AtomicRecoveryStore {
    max_bytes: usize,
    owner: String,
    owner_uid: u32,
    path: PathBuf,
    schema_version: u16,
}

impl AtomicRecoveryStore {
    pub fn new(
        path: PathBuf,
        owner_uid: u32,
        owner: impl Into<String>,
        schema_version: u16,
        max_bytes: usize,
    ) -> Result<Self, RecoveryError> {
        let owner = owner.into();
        if !path.is_absolute()
            || owner.is_empty()
            || owner.len() > 128
            || schema_version == 0
            || !(1..=1024 * 1024).contains(&max_bytes)
        {
            return Err(RecoveryError::Invalid);
        }
        validate_parent(&path, owner_uid).map_err(|()| RecoveryError::Invalid)?;
        Ok(Self {
            max_bytes,
            owner,
            owner_uid,
            path,
            schema_version,
        })
    }

    pub fn persist<T: Serialize>(
        &self,
        correlation: &Correlation,
        payload: &T,
    ) -> Result<(), RecoveryError> {
        self.persist_inner(correlation, payload)
            .map_err(|()| RecoveryError::Invalid)
    }

    fn persist_inner<T: Serialize>(
        &self,
        correlation: &Correlation,
        payload: &T,
    ) -> Result<(), ()> {
        validate_parent(&self.path, self.owner_uid)?;
        validate_existing_file(&self.path, self.owner_uid, self.max_bytes)?;
        let record = RecoveryRecord {
            admitted_revision: correlation.admitted_revision,
            machine_authority_sha256: digest(&correlation.machine_authority),
            operation_id_sha256: digest(&correlation.operation_id),
            owner: self.owner.clone(),
            payload,
            schema_version: self.schema_version,
            scope_epoch: correlation.scope_epoch,
        };
        let mut bytes = serde_json::to_vec(&record).map_err(|_| ())?;
        bytes.push(b'\n');
        if bytes.len() > self.max_bytes {
            return Err(());
        }
        let parent = self.path.parent().ok_or(())?;
        let name = self
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or(())?;
        let temporary = parent.join(format!(
            ".{name}.{}.{}",
            std::process::id(),
            TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut file = OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temporary)
                .map_err(|_| ())?;
            file.write_all(&bytes).map_err(|_| ())?;
            file.sync_all().map_err(|_| ())?;
            validate_file(&temporary, self.owner_uid, self.max_bytes)?;
            validate_existing_file(&self.path, self.owner_uid, self.max_bytes)?;
            fs::rename(&temporary, &self.path).map_err(|_| ())?;
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| ())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn load<T: DeserializeOwned>(
        &self,
        expected: &Correlation,
    ) -> Result<Option<RecoveryRecord<T>>, RecoveryError> {
        self.load_inner(expected)
            .map_err(|()| RecoveryError::Invalid)
    }

    fn load_inner<T: DeserializeOwned>(
        &self,
        expected: &Correlation,
    ) -> Result<Option<RecoveryRecord<T>>, ()> {
        validate_parent(&self.path, self.owner_uid)?;
        match fs::symlink_metadata(&self.path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
            Ok(_) => {}
        }
        validate_file(&self.path, self.owner_uid, self.max_bytes)?;
        let bytes = fs::read(&self.path).map_err(|_| ())?;
        let record: RecoveryRecord<T> = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if record.schema_version != self.schema_version
            || record.owner != self.owner
            || record.machine_authority_sha256 != digest(&expected.machine_authority)
            || record.operation_id_sha256 != digest(&expected.operation_id)
            || record.scope_epoch != expected.scope_epoch
            || record.admitted_revision != expected.admitted_revision
        {
            return Err(());
        }
        Ok(Some(record))
    }

    pub fn clear(&self) -> Result<(), RecoveryError> {
        self.clear_inner().map_err(|()| RecoveryError::Invalid)
    }

    fn clear_inner(&self) -> Result<(), ()> {
        validate_parent(&self.path, self.owner_uid)?;
        validate_existing_file(&self.path, self.owner_uid, self.max_bytes)?;
        match fs::remove_file(&self.path) {
            Ok(()) => fs::File::open(self.path.parent().ok_or(())?)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| ()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn validate_existing_file(path: &Path, owner_uid: u32, max_bytes: usize) -> Result<(), ()> {
    match fs::symlink_metadata(path) {
        Ok(_) => validate_file(path, owner_uid, max_bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(()),
    }
}

fn validate_parent(path: &Path, owner_uid: u32) -> Result<(), ()> {
    let parent = path.parent().ok_or(())?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| ())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != owner_uid
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(());
    }
    Ok(())
}

fn validate_file(path: &Path, owner_uid: u32, max_bytes: usize) -> Result<(), ()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != owner_uid
        || metadata.permissions().mode() & 0o777 != 0o600
        || metadata.nlink() != 1
        || metadata.len() == 0
        || metadata.len() > max_bytes as u64
    {
        return Err(());
    }
    Ok(())
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
    struct Payload {
        phase: String,
    }

    fn correlation() -> Correlation {
        Correlation {
            machine_authority: "authority".into(),
            scope_epoch: 4,
            operation_id: "operation".into(),
            admitted_revision: 9,
            effect_id: 1,
        }
    }

    #[test]
    fn atomic_record_survives_restart_and_rejects_wrong_owner_or_correlation() {
        let temporary = tempfile::tempdir().unwrap();
        std::fs::set_permissions(
            temporary.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();
        let path = temporary.path().join("recovery.json");
        // SAFETY: getuid has no preconditions.
        let uid = unsafe { libc::getuid() };
        let store = AtomicRecoveryStore::new(path.clone(), uid, "test-machine", 1, 4096).unwrap();
        let expected = correlation();
        store
            .persist(
                &expected,
                &Payload {
                    phase: "applying".into(),
                },
            )
            .unwrap();

        let restarted = AtomicRecoveryStore::new(path, uid, "test-machine", 1, 4096).unwrap();
        let record = restarted.load::<Payload>(&expected).unwrap().unwrap();
        assert_eq!(record.payload.phase, "applying");
        let mut stale = expected.clone();
        stale.scope_epoch += 1;
        assert_eq!(
            restarted.load::<Payload>(&stale),
            Err(RecoveryError::Invalid)
        );
        let wrong_owner = AtomicRecoveryStore::new(
            restarted.path().to_path_buf(),
            uid,
            "other-machine",
            1,
            4096,
        )
        .unwrap();
        assert_eq!(
            wrong_owner.load::<Payload>(&expected),
            Err(RecoveryError::Invalid)
        );
        std::fs::set_permissions(
            restarted.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o644),
        )
        .unwrap();
        assert_eq!(restarted.clear(), Err(RecoveryError::Invalid));
        std::fs::set_permissions(
            restarted.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();
        restarted.clear().unwrap();
        assert!(restarted.load::<Payload>(&expected).unwrap().is_none());
    }
}
