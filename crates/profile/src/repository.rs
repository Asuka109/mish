use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

use serde::de::DeserializeOwned;
use uuid::Uuid;

use crate::{
    NORMALIZED_ARTIFACT_SCHEMA_VERSION, PROFILE_SCHEMA_VERSION, ProfileId, ProfileMetadata,
    ProfileRecord, ProfileSource,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepositoryComponent {
    Metadata,
    SourceDescriptor,
    ImmutableRevision,
    NormalizedArtifact,
}

#[derive(Debug, thiserror::Error)]
pub enum RepositoryError {
    #[error("profile does not exist")]
    NotFound,
    #[error("profile already exists")]
    AlreadyExists,
    #[error("profile storage contains a symbolic link")]
    UnsafeStoragePath,
    #[error("profile storage schema {found} is unsupported; expected {expected}")]
    UnsupportedSchema { expected: u32, found: u32 },
    #[error("stored {component:?} data is corrupt")]
    CorruptData { component: RepositoryComponent },
    #[error("stored immutable profile content does not match its fingerprint")]
    IntegrityMismatch,
    #[error("profile storage could not be read")]
    ReadFailed,
    #[error("profile storage could not be written atomically")]
    AtomicWriteFailed,
}

pub trait AtomicWriter: Send + Sync {
    fn write(&self, destination: &Path, contents: &[u8]) -> io::Result<()>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct StdAtomicWriter;

impl AtomicWriter for StdAtomicWriter {
    fn write(&self, destination: &Path, contents: &[u8]) -> io::Result<()> {
        let parent = destination
            .parent()
            .ok_or_else(|| io::Error::other("destination has no parent"))?;
        fs::create_dir_all(parent)?;
        set_private_directory_permissions(parent)?;

        let temporary = parent.join(format!(".tmp-{}", Uuid::new_v4()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(contents)?;
            file.sync_all()?;
            fs::rename(&temporary, destination)?;
            sync_directory(parent)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

pub struct FileProfileRepository<W = StdAtomicWriter> {
    root: PathBuf,
    writer: W,
}

impl FileProfileRepository<StdAtomicWriter> {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            writer: StdAtomicWriter,
        }
    }
}

impl<W> FileProfileRepository<W>
where
    W: AtomicWriter,
{
    pub fn with_writer(root: PathBuf, writer: W) -> Self {
        Self { root, writer }
    }

    pub fn save(&self, record: &ProfileRecord) -> Result<(), RepositoryError> {
        validate_record(record)?;
        self.prepare_root()?;
        let profile_path = self.profile_path(&record.metadata.id);
        if profile_path.exists() {
            return Err(RepositoryError::AlreadyExists);
        }

        let staging = self
            .profiles_root()
            .join(format!(".staging-{}", Uuid::new_v4()));
        create_private_dir(&staging).map_err(|_| RepositoryError::AtomicWriteFailed)?;
        let result = self.write_record(&staging, record);
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }

        fs::rename(&staging, &profile_path).map_err(|_| RepositoryError::AtomicWriteFailed)?;
        sync_directory(&self.profiles_root()).map_err(|_| RepositoryError::AtomicWriteFailed)?;
        Ok(())
    }

    pub fn update(&self, record: &ProfileRecord) -> Result<(), RepositoryError> {
        validate_record(record)?;
        self.prepare_root()?;
        let profile_path = self.profile_path(&record.metadata.id);
        if !profile_path.exists() {
            return Err(RepositoryError::NotFound);
        }
        reject_symlinks_between(&self.root, &profile_path)?;
        let current = self.load(&record.metadata.id)?;
        if current.source != record.source {
            return Err(RepositoryError::IntegrityMismatch);
        }
        self.write_revision_artifact_and_metadata(&profile_path, record)
    }

    pub fn list_metadata(&self) -> Result<Vec<ProfileMetadata>, RepositoryError> {
        if !self.root.is_absolute() {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        if !self.root.exists() {
            return Ok(Vec::new());
        }
        reject_symlinks_between(&self.root, &self.profiles_root())?;
        if !self.profiles_root().exists() {
            return Ok(Vec::new());
        }

        let entries =
            fs::read_dir(self.profiles_root()).map_err(|_| RepositoryError::ReadFailed)?;
        let mut profiles = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| RepositoryError::ReadFailed)?;
            let name =
                entry
                    .file_name()
                    .into_string()
                    .map_err(|_| RepositoryError::CorruptData {
                        component: RepositoryComponent::Metadata,
                    })?;
            if name.starts_with(".staging-") || name.starts_with(".deleting-") {
                continue;
            }
            let id = ProfileId::parse(name).map_err(|_| RepositoryError::CorruptData {
                component: RepositoryComponent::Metadata,
            })?;
            reject_symlinks_between(&self.root, &entry.path())?;
            let metadata: ProfileMetadata = read_json(
                &entry.path().join("metadata.json"),
                RepositoryComponent::Metadata,
            )?;
            validate_persisted_metadata(&metadata, &id)?;
            profiles.push(metadata);
        }
        profiles.sort_by(|left, right| left.id.as_str().cmp(right.id.as_str()));
        Ok(profiles)
    }

    pub fn load(&self, id: &ProfileId) -> Result<ProfileRecord, RepositoryError> {
        if !self.root.is_absolute() {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        let profile_path = self.profile_path(id);
        if !profile_path.exists() {
            return Err(RepositoryError::NotFound);
        }
        reject_symlinks_between(&self.root, &profile_path)?;

        let metadata: ProfileMetadata = read_json(
            &profile_path.join("metadata.json"),
            RepositoryComponent::Metadata,
        )?;
        validate_persisted_metadata(&metadata, id)?;

        let source: ProfileSource = read_json(
            &profile_path.join("source/source.json"),
            RepositoryComponent::SourceDescriptor,
        )?;
        if !source.is_valid() {
            return Err(RepositoryError::CorruptData {
                component: RepositoryComponent::SourceDescriptor,
            });
        }
        let source_bytes = read_bytes(
            &profile_path.join(format!(
                "source/revisions/{}.yaml",
                metadata.revision.id.as_str()
            )),
            RepositoryComponent::ImmutableRevision,
        )?;
        let normalized_bytes = read_bytes(
            &profile_path.join(format!(
                "artifacts/{}.yaml",
                metadata.artifact.fingerprint.as_str()
            )),
            RepositoryComponent::NormalizedArtifact,
        )?;

        let record = ProfileRecord {
            metadata,
            normalized_bytes,
            source,
            source_bytes,
        };
        validate_record(&record)?;
        Ok(record)
    }

    pub fn delete(&self, id: &ProfileId) -> Result<(), RepositoryError> {
        if !self.root.is_absolute() {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        let profile_path = self.profile_path(id);
        if !profile_path.exists() {
            return Err(RepositoryError::NotFound);
        }
        reject_symlinks_between(&self.root, &profile_path)?;

        let deleting_path = self
            .profiles_root()
            .join(format!(".deleting-{}", Uuid::new_v4()));
        fs::rename(&profile_path, &deleting_path)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        sync_directory(&self.profiles_root()).map_err(|_| RepositoryError::AtomicWriteFailed)?;
        fs::remove_dir_all(&deleting_path).map_err(|_| RepositoryError::AtomicWriteFailed)?;
        sync_directory(&self.profiles_root()).map_err(|_| RepositoryError::AtomicWriteFailed)
    }

    fn write_record(
        &self,
        profile_path: &Path,
        record: &ProfileRecord,
    ) -> Result<(), RepositoryError> {
        let source_descriptor = serde_json::to_vec_pretty(&record.source).map_err(|_| {
            RepositoryError::CorruptData {
                component: RepositoryComponent::SourceDescriptor,
            }
        })?;
        self.write(&profile_path.join("source/source.json"), &source_descriptor)?;
        self.write_revision_artifact_and_metadata(profile_path, record)
    }

    fn write_revision_artifact_and_metadata(
        &self,
        profile_path: &Path,
        record: &ProfileRecord,
    ) -> Result<(), RepositoryError> {
        let metadata = serde_json::to_vec_pretty(&record.metadata).map_err(|_| {
            RepositoryError::CorruptData {
                component: RepositoryComponent::Metadata,
            }
        })?;
        self.write(
            &profile_path.join(format!(
                "source/revisions/{}.yaml",
                record.metadata.revision.id.as_str()
            )),
            &record.source_bytes,
        )?;
        self.write(
            &profile_path.join(format!(
                "artifacts/{}.yaml",
                record.metadata.artifact.fingerprint.as_str()
            )),
            &record.normalized_bytes,
        )?;
        self.write(&profile_path.join("metadata.json"), &metadata)?;
        Ok(())
    }

    fn write(&self, destination: &Path, contents: &[u8]) -> Result<(), RepositoryError> {
        reject_symlinks_between(&self.root, destination.parent().unwrap_or(destination))?;
        self.writer
            .write(destination, contents)
            .map_err(|_| RepositoryError::AtomicWriteFailed)
    }

    fn prepare_root(&self) -> Result<(), RepositoryError> {
        if !self.root.is_absolute() {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        create_private_dir(&self.root).map_err(|_| RepositoryError::AtomicWriteFailed)?;
        reject_symlinks_between(&self.root, &self.root)?;
        create_private_dir(&self.profiles_root())
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        reject_symlinks_between(&self.root, &self.profiles_root())
    }

    fn profiles_root(&self) -> PathBuf {
        self.root.join("profiles")
    }

    fn profile_path(&self, id: &ProfileId) -> PathBuf {
        self.profiles_root().join(id.as_str())
    }
}

fn validate_persisted_metadata(
    metadata: &ProfileMetadata,
    expected_id: &ProfileId,
) -> Result<(), RepositoryError> {
    if metadata.schema_version != PROFILE_SCHEMA_VERSION {
        return Err(RepositoryError::UnsupportedSchema {
            expected: PROFILE_SCHEMA_VERSION,
            found: metadata.schema_version,
        });
    }
    if metadata.id != *expected_id {
        return Err(RepositoryError::CorruptData {
            component: RepositoryComponent::Metadata,
        });
    }
    if metadata.artifact.schema_version != NORMALIZED_ARTIFACT_SCHEMA_VERSION {
        return Err(RepositoryError::UnsupportedSchema {
            expected: NORMALIZED_ARTIFACT_SCHEMA_VERSION,
            found: metadata.artifact.schema_version,
        });
    }
    if !metadata.revision.id.is_canonical()
        || !metadata.artifact.fingerprint.is_canonical()
        || !metadata.artifact.revision_id.is_canonical()
    {
        return Err(RepositoryError::CorruptData {
            component: RepositoryComponent::Metadata,
        });
    }
    Ok(())
}

fn validate_record(record: &ProfileRecord) -> Result<(), RepositoryError> {
    if record.metadata.schema_version != PROFILE_SCHEMA_VERSION {
        return Err(RepositoryError::UnsupportedSchema {
            expected: PROFILE_SCHEMA_VERSION,
            found: record.metadata.schema_version,
        });
    }
    if record.metadata.artifact.schema_version != NORMALIZED_ARTIFACT_SCHEMA_VERSION {
        return Err(RepositoryError::UnsupportedSchema {
            expected: NORMALIZED_ARTIFACT_SCHEMA_VERSION,
            found: record.metadata.artifact.schema_version,
        });
    }
    if !record.metadata.revision.id.is_canonical()
        || !record.metadata.artifact.fingerprint.is_canonical()
        || !record.metadata.artifact.revision_id.is_canonical()
        || !record.source.is_valid()
    {
        return Err(RepositoryError::IntegrityMismatch);
    }
    if crate::RevisionId::from_source(&record.source_bytes) != record.metadata.revision.id
        || crate::Fingerprint::from_normalized_artifact(&record.normalized_bytes)
            != record.metadata.artifact.fingerprint
        || record.metadata.artifact.revision_id != record.metadata.revision.id
    {
        return Err(RepositoryError::IntegrityMismatch);
    }
    Ok(())
}

fn read_json<T: DeserializeOwned>(
    path: &Path,
    component: RepositoryComponent,
) -> Result<T, RepositoryError> {
    let bytes = read_bytes(path, component)?;
    serde_json::from_slice(&bytes).map_err(|_| RepositoryError::CorruptData { component })
}

fn read_bytes(path: &Path, component: RepositoryComponent) -> Result<Vec<u8>, RepositoryError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            RepositoryError::CorruptData { component }
        } else {
            RepositoryError::ReadFailed
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(RepositoryError::UnsafeStoragePath);
    }
    fs::read(path).map_err(|_| RepositoryError::ReadFailed)
}

fn create_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    set_private_directory_permissions(path)
}

fn set_private_directory_permissions(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn reject_symlinks_between(root: &Path, target: &Path) -> Result<(), RepositoryError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(RepositoryError::ReadFailed),
    }
    let relative = target
        .strip_prefix(root)
        .map_err(|_| RepositoryError::UnsafeStoragePath)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(RepositoryError::UnsafeStoragePath);
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(_) => return Err(RepositoryError::ReadFailed),
        }
    }
    Ok(())
}
