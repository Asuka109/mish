use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use crate::{
    Fingerprint, NORMALIZED_ARTIFACT_SCHEMA_VERSION, PROFILE_PATCH_SCHEMA_VERSION,
    PROFILE_SCHEMA_VERSION, ProfileId, ProfileMetadata, ProfilePatchSet, ProfileRecord,
    ProfileSource,
};

pub const PROFILE_GENERATION_SCHEMA_VERSION: u32 = 1;
pub const PROFILE_GENERATIONS_DIRECTORY: &str = "generations";
pub const PROFILE_CURRENT_GENERATION_FILE: &str = "current.json";
const MAX_GENERATION_PROFILES: usize = 1024;
const MAX_GENERATION_MANIFEST_BYTES: u64 = 128 * 1024;
const MAX_PERSISTED_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepositoryComponent {
    Metadata,
    SourceDescriptor,
    ImmutableRevision,
    NormalizedArtifact,
    Patches,
    GenerationPointer,
    GenerationManifest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepositoryStorageOperation {
    CreatePrivateDirectory,
    AtomicFileWrite,
    Rename,
    SyncDirectory,
    RemoveDirectory,
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
    #[error("the current profile generation changed while it was being read")]
    StaleGeneration,
}

pub trait AtomicWriter: Send + Sync {
    fn write(&self, destination: &Path, contents: &[u8]) -> io::Result<()>;

    fn create_private_dir(&self, path: &Path) -> io::Result<()> {
        fs::create_dir_all(path)?;
        set_private_directory_permissions(path)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }

    fn sync_directory(&self, path: &Path) -> io::Result<()> {
        sync_directory(path)
    }

    fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
        fs::remove_dir_all(path)
    }
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

        match fs::symlink_metadata(destination) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(io::Error::other("destination is a symbolic link"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }

        let temporary = parent.join(format!(".tmp-{}", Uuid::new_v4()));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
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

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchSetPointer {
    fingerprint: Fingerprint,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ProfileGenerationId(String);

impl ProfileGenerationId {
    fn new() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StagedProfileGeneration {
    id: ProfileGenerationId,
}

impl StagedProfileGeneration {
    pub fn id(&self) -> &ProfileGenerationId {
        &self.id
    }
}

#[derive(Debug)]
pub struct ProfileGeneration {
    pub id: ProfileGenerationId,
    pub profiles: Vec<ProfileRecord>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerationPointer {
    generation_id: ProfileGenerationId,
    schema_version: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerationManifest {
    generation_id: ProfileGenerationId,
    profile_ids: Vec<ProfileId>,
    schema_version: u32,
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

    /// Stage a complete, private Profile set without changing the published
    /// generation pointer. The returned token is the only value accepted by
    /// `publish_generation`, so an incomplete directory cannot become current
    /// through this API.
    pub fn stage_generation(
        &self,
        records: &[ProfileRecord],
    ) -> Result<StagedProfileGeneration, RepositoryError> {
        self.prepare_generation_root()?;
        if records.len() > MAX_GENERATION_PROFILES {
            return Err(RepositoryError::CorruptData {
                component: RepositoryComponent::GenerationManifest,
            });
        }

        let mut ordered = records.iter().collect::<Vec<_>>();
        ordered.sort_by(|left, right| left.metadata.id.as_str().cmp(right.metadata.id.as_str()));
        if ordered
            .windows(2)
            .any(|pair| pair[0].metadata.id == pair[1].metadata.id)
        {
            return Err(RepositoryError::CorruptData {
                component: RepositoryComponent::GenerationManifest,
            });
        }

        for record in &ordered {
            validate_record(record)?;
        }

        let id = ProfileGenerationId::new();
        let staging = self
            .generations_root()
            .join(format!(".staging-{}", id.as_str()));
        let result = (|| {
            self.writer
                .create_private_dir(&staging)
                .map_err(|_| RepositoryError::AtomicWriteFailed)?;
            let profiles_root = staging.join("profiles");
            self.writer
                .create_private_dir(&profiles_root)
                .map_err(|_| RepositoryError::AtomicWriteFailed)?;

            for record in &ordered {
                self.write_record(&profiles_root.join(record.metadata.id.as_str()), record)?;
            }

            let manifest = GenerationManifest {
                generation_id: id.clone(),
                profile_ids: ordered
                    .iter()
                    .map(|record| record.metadata.id.clone())
                    .collect(),
                schema_version: PROFILE_GENERATION_SCHEMA_VERSION,
            };
            let contents =
                serde_json::to_vec_pretty(&manifest).map_err(|_| RepositoryError::CorruptData {
                    component: RepositoryComponent::GenerationManifest,
                })?;
            self.write(&staging.join("manifest.json"), &contents)?;
            self.writer
                .sync_directory(&profiles_root)
                .map_err(|_| RepositoryError::AtomicWriteFailed)?;
            self.writer
                .sync_directory(&staging)
                .map_err(|_| RepositoryError::AtomicWriteFailed)?;
            Ok::<(), RepositoryError>(())
        })();

        if let Err(error) = result {
            let _ = self.writer.remove_dir_all(&staging);
            return Err(error);
        }
        Ok(StagedProfileGeneration { id })
    }

    /// Publish one previously staged generation. The generation directory is
    /// made durable before the pointer is replaced; the pointer replacement is
    /// the sole publication point. A failed pointer write therefore leaves the
    /// prior current generation untouched.
    pub fn publish_generation(
        &self,
        staged: StagedProfileGeneration,
    ) -> Result<ProfileGenerationId, RepositoryError> {
        self.prepare_generation_root()?;
        let staging = self
            .generations_root()
            .join(format!(".staging-{}", staged.id.as_str()));
        let generation = self.generations_root().join(staged.id.as_str());
        ensure_directory(&staging, RepositoryComponent::GenerationManifest)?;
        if path_exists_no_follow(&generation)? {
            return Err(RepositoryError::AtomicWriteFailed);
        }
        self.read_generation_at(&staging, &staged.id)?;

        self.writer
            .rename(&staging, &generation)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        self.writer
            .sync_directory(&self.generations_root())
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;

        let pointer = GenerationPointer {
            generation_id: staged.id.clone(),
            schema_version: PROFILE_GENERATION_SCHEMA_VERSION,
        };
        let contents =
            serde_json::to_vec_pretty(&pointer).map_err(|_| RepositoryError::CorruptData {
                component: RepositoryComponent::GenerationPointer,
            })?;
        self.write(&self.current_generation_path(), &contents)?;
        Ok(staged.id)
    }

    /// Read the complete generation named by the current pointer. The pointer
    /// is the only publication authority; it is re-read after the generation
    /// so a replacement during this bounded read fails closed.
    pub fn read_current_generation(&self) -> Result<Option<ProfileGeneration>, RepositoryError> {
        self.read_current_generation_inner(|| {})
    }

    fn read_current_generation_inner(
        &self,
        mut after_pointer_read: impl FnMut(),
    ) -> Result<Option<ProfileGeneration>, RepositoryError> {
        if !self.root.is_absolute() {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        if !path_exists_no_follow(&self.root)? {
            return Ok(None);
        }
        reject_symlinks_between(&self.root, &self.root)?;
        reject_symlinks_between(&self.root, &self.generations_root())?;
        let pointer = self.read_generation_pointer()?;
        after_pointer_read();
        let generation = self.read_generation(&pointer.generation_id)?;
        let current_pointer = self.read_generation_pointer()?;
        if current_pointer != pointer {
            return Err(RepositoryError::StaleGeneration);
        }
        Ok(Some(generation))
    }

    fn read_generation_pointer(&self) -> Result<GenerationPointer, RepositoryError> {
        let pointer_path = self.current_generation_path();
        if !path_exists_no_follow(&pointer_path)? {
            return Err(RepositoryError::CorruptData {
                component: RepositoryComponent::GenerationPointer,
            });
        }
        let pointer: GenerationPointer = read_json_bounded(
            &pointer_path,
            RepositoryComponent::GenerationPointer,
            MAX_GENERATION_MANIFEST_BYTES,
        )?;
        if pointer.schema_version != PROFILE_GENERATION_SCHEMA_VERSION {
            return Err(RepositoryError::UnsupportedSchema {
                expected: PROFILE_GENERATION_SCHEMA_VERSION,
                found: pointer.schema_version,
            });
        }
        validate_generation_id(
            &pointer.generation_id,
            RepositoryComponent::GenerationPointer,
        )?;
        Ok(pointer)
    }

    fn current_records_for_write(&self) -> Result<Vec<ProfileRecord>, RepositoryError> {
        Ok(self
            .read_current_generation()?
            .map(|generation| generation.profiles)
            .unwrap_or_default())
    }

    fn publish_records(&self, records: &[ProfileRecord]) -> Result<(), RepositoryError> {
        let staged = self.stage_generation(records)?;
        self.publish_generation(staged).map(|_| ())
    }

    fn read_generation(
        &self,
        id: &ProfileGenerationId,
    ) -> Result<ProfileGeneration, RepositoryError> {
        let generation = self.generations_root().join(id.as_str());
        reject_symlinks_between(&self.root, &generation)?;
        self.read_generation_at(&generation, id)
    }

    fn read_generation_at(
        &self,
        generation: &Path,
        id: &ProfileGenerationId,
    ) -> Result<ProfileGeneration, RepositoryError> {
        reject_symlinks_between(&self.root, generation)?;
        ensure_directory(generation, RepositoryComponent::GenerationManifest)?;
        validate_generation_manifest(generation, id)?;
        let manifest: GenerationManifest = read_json_bounded(
            &generation.join("manifest.json"),
            RepositoryComponent::GenerationManifest,
            MAX_GENERATION_MANIFEST_BYTES,
        )?;
        let profiles_root = generation.join("profiles");
        ensure_directory(&profiles_root, RepositoryComponent::GenerationManifest)?;
        validate_generation_entries(&profiles_root, &manifest.profile_ids)?;
        let profiles = manifest
            .profile_ids
            .iter()
            .map(|profile_id| {
                self.load_from_profile_path(profile_id, &profiles_root.join(profile_id.as_str()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ProfileGeneration {
            id: id.clone(),
            profiles,
        })
    }

    pub fn save(&self, record: &ProfileRecord) -> Result<(), RepositoryError> {
        validate_record(record)?;
        let mut current = self.current_records_for_write()?;
        if current
            .iter()
            .any(|existing| existing.metadata.id == record.metadata.id)
        {
            return Err(RepositoryError::AlreadyExists);
        }
        self.prepare_root()?;
        let profile_path = self.profile_path(&record.metadata.id);
        if path_exists_no_follow(&profile_path)? {
            return Err(RepositoryError::AlreadyExists);
        }

        let staging = self
            .profiles_root()
            .join(format!(".staging-{}", Uuid::new_v4()));
        self.writer
            .create_private_dir(&staging)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        let result = self.write_record(&staging, record);
        if let Err(error) = result {
            let _ = self.writer.remove_dir_all(&staging);
            return Err(error);
        }

        self.writer
            .rename(&staging, &profile_path)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        self.writer
            .sync_directory(&self.profiles_root())
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        current.push(record.clone());
        self.publish_records(&current)
    }

    pub fn update(&self, record: &ProfileRecord) -> Result<(), RepositoryError> {
        validate_record(record)?;
        let mut current = self.current_records_for_write()?;
        let index = current
            .iter()
            .position(|existing| existing.metadata.id == record.metadata.id)
            .ok_or(RepositoryError::NotFound)?;
        if current[index].source != record.source {
            return Err(RepositoryError::IntegrityMismatch);
        }
        self.prepare_root()?;
        let profile_path = self.profile_path(&record.metadata.id);
        self.write_profile_mirror(&profile_path, record)?;
        current[index] = record.clone();
        self.publish_records(&current)
    }

    pub fn replace_source(&self, record: &ProfileRecord) -> Result<(), RepositoryError> {
        validate_record(record)?;
        let mut current = self.current_records_for_write()?;
        let index = current
            .iter()
            .position(|existing| existing.metadata.id == record.metadata.id)
            .ok_or(RepositoryError::NotFound)?;
        self.prepare_root()?;
        let profile_path = self.profile_path(&record.metadata.id);
        self.write_profile_mirror(&profile_path, record)?;
        current[index] = record.clone();
        self.publish_records(&current)
    }

    pub fn list_metadata(&self) -> Result<Vec<ProfileMetadata>, RepositoryError> {
        if !self.root.is_absolute() {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        if !path_exists_no_follow(&self.root)? {
            return Ok(Vec::new());
        }
        reject_symlinks_between(&self.root, &self.profiles_root())?;
        if !path_exists_no_follow(&self.profiles_root())? {
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
            let mut metadata: ProfileMetadata = read_json(
                &entry.path().join("metadata.json"),
                RepositoryComponent::Metadata,
            )?;
            migrate_legacy_metadata(&mut metadata);
            validate_persisted_metadata(&metadata, &id)?;
            profiles.push(metadata);
        }
        profiles.sort_by(|left, right| left.id.as_str().cmp(right.id.as_str()));
        Ok(profiles)
    }

    pub fn list_metadata_with_effective_fingerprints(
        &self,
    ) -> Result<Vec<(ProfileMetadata, Fingerprint)>, RepositoryError> {
        self.list_metadata()?
            .into_iter()
            .map(|metadata| {
                let patches = load_patch_set(&self.profile_path(&metadata.id), &metadata)?;
                if patches.schema_version != PROFILE_PATCH_SCHEMA_VERSION
                    || crate::validate_patch_set_shape(&patches).is_err()
                    || (metadata.status.valid
                        && !patches
                            .is_bound_to(&metadata.revision.id, &metadata.artifact.fingerprint))
                {
                    return Err(RepositoryError::CorruptData {
                        component: RepositoryComponent::Patches,
                    });
                }
                let effective_fingerprint = patches.effective_fingerprint;
                Ok((metadata, effective_fingerprint))
            })
            .collect()
    }

    pub fn load(&self, id: &ProfileId) -> Result<ProfileRecord, RepositoryError> {
        if !self.root.is_absolute() {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        let profile_path = self.profile_path(id);
        if !path_exists_no_follow(&profile_path)? {
            return Err(RepositoryError::NotFound);
        }
        reject_symlinks_between(&self.root, &profile_path)?;
        self.load_from_profile_path(id, &profile_path)
    }

    fn load_from_profile_path(
        &self,
        id: &ProfileId,
        profile_path: &Path,
    ) -> Result<ProfileRecord, RepositoryError> {
        reject_symlinks_between(&self.root, profile_path)?;
        ensure_directory(profile_path, RepositoryComponent::Metadata)?;
        let metadata_path = profile_path.join("metadata.json");
        let source_root = profile_path.join("source");
        let source_descriptor_path = source_root.join("source.json");
        let revisions_root = source_root.join("revisions");
        let artifacts_root = profile_path.join("artifacts");
        let patches_root = profile_path.join("patches");
        let patch_sets_root = patches_root.join("sets");
        for path in [
            &metadata_path,
            &source_root,
            &source_descriptor_path,
            &revisions_root,
            &artifacts_root,
            &patches_root,
            &patch_sets_root,
        ] {
            reject_symlinks_between(&self.root, path)?;
        }

        let mut metadata: ProfileMetadata =
            read_json(&metadata_path, RepositoryComponent::Metadata)?;
        migrate_legacy_metadata(&mut metadata);
        validate_persisted_metadata(&metadata, id)?;

        let source: ProfileSource = read_json(
            &source_descriptor_path,
            RepositoryComponent::SourceDescriptor,
        )?;
        if !source.is_valid() {
            return Err(RepositoryError::CorruptData {
                component: RepositoryComponent::SourceDescriptor,
            });
        }
        let source_revision_path =
            revisions_root.join(format!("{}.yaml", metadata.revision.id.as_str()));
        let artifact_path =
            artifacts_root.join(format!("{}.yaml", metadata.artifact.fingerprint.as_str()));
        reject_symlinks_between(&self.root, &source_revision_path)?;
        reject_symlinks_between(&self.root, &artifact_path)?;
        let source_bytes = read_bytes(
            &source_revision_path,
            RepositoryComponent::ImmutableRevision,
        )?;
        let normalized_bytes = read_bytes(&artifact_path, RepositoryComponent::NormalizedArtifact)?;
        let patches = load_patch_set(profile_path, &metadata)?;

        let record = ProfileRecord {
            metadata,
            normalized_bytes,
            patches,
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
        let mut current = self.current_records_for_write()?;
        let index = current
            .iter()
            .position(|record| record.metadata.id == *id)
            .ok_or(RepositoryError::NotFound)?;
        let profile_path = self.profile_path(id);
        if path_exists_no_follow(&profile_path)? {
            reject_symlinks_between(&self.root, &profile_path)?;

            let deleting_path = self
                .profiles_root()
                .join(format!(".deleting-{}", Uuid::new_v4()));
            self.writer
                .rename(&profile_path, &deleting_path)
                .map_err(|_| RepositoryError::AtomicWriteFailed)?;
            self.writer
                .sync_directory(&self.profiles_root())
                .map_err(|_| RepositoryError::AtomicWriteFailed)?;
            self.writer
                .remove_dir_all(&deleting_path)
                .map_err(|_| RepositoryError::AtomicWriteFailed)?;
            self.writer
                .sync_directory(&self.profiles_root())
                .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        }
        current.remove(index);
        self.publish_records(&current)
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

    fn write_profile_mirror(
        &self,
        profile_path: &Path,
        record: &ProfileRecord,
    ) -> Result<(), RepositoryError> {
        if path_exists_no_follow(profile_path)? {
            reject_symlinks_between(&self.root, profile_path)?;
            return self.write_record(profile_path, record);
        }

        let staging = self
            .profiles_root()
            .join(format!(".staging-{}", Uuid::new_v4()));
        self.writer
            .create_private_dir(&staging)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        if let Err(error) = self.write_record(&staging, record) {
            let _ = self.writer.remove_dir_all(&staging);
            return Err(error);
        }
        self.writer
            .rename(&staging, profile_path)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        self.writer
            .sync_directory(&self.profiles_root())
            .map_err(|_| RepositoryError::AtomicWriteFailed)
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
        let patches = serde_json::to_vec_pretty(&record.patches).map_err(|_| {
            RepositoryError::CorruptData {
                component: RepositoryComponent::Patches,
            }
        })?;
        let patch_fingerprint = Fingerprint::from_normalized_artifact(&patches);
        let patch_pointer = serde_json::to_vec_pretty(&PatchSetPointer {
            fingerprint: patch_fingerprint.clone(),
        })
        .map_err(|_| RepositoryError::CorruptData {
            component: RepositoryComponent::Patches,
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
        self.write(
            &profile_path.join(format!("patches/sets/{}.json", patch_fingerprint.as_str())),
            &patches,
        )?;
        self.write(&profile_path.join("metadata.json"), &metadata)?;
        self.write(&profile_path.join("patches/index.json"), &patch_pointer)?;
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
        reject_symlinks_between(&self.root, &self.root)?;
        self.writer
            .create_private_dir(&self.root)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        reject_symlinks_between(&self.root, &self.root)?;
        self.writer
            .create_private_dir(&self.profiles_root())
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        reject_symlinks_between(&self.root, &self.profiles_root())
    }

    fn prepare_generation_root(&self) -> Result<(), RepositoryError> {
        if !self.root.is_absolute() {
            return Err(RepositoryError::UnsafeStoragePath);
        }
        reject_symlinks_between(&self.root, &self.root)?;
        self.writer
            .create_private_dir(&self.root)
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        reject_symlinks_between(&self.root, &self.root)?;
        self.writer
            .create_private_dir(&self.generations_root())
            .map_err(|_| RepositoryError::AtomicWriteFailed)?;
        reject_symlinks_between(&self.root, &self.generations_root())
    }

    fn profiles_root(&self) -> PathBuf {
        self.root.join("profiles")
    }

    fn generations_root(&self) -> PathBuf {
        self.root.join(PROFILE_GENERATIONS_DIRECTORY)
    }

    fn current_generation_path(&self) -> PathBuf {
        self.root.join(PROFILE_CURRENT_GENERATION_FILE)
    }

    fn profile_path(&self, id: &ProfileId) -> PathBuf {
        self.profiles_root().join(id.as_str())
    }
}

fn load_patch_set(
    profile_path: &Path,
    metadata: &ProfileMetadata,
) -> Result<ProfilePatchSet, RepositoryError> {
    let pointer_path = profile_path.join("patches/index.json");
    if path_exists_no_follow(&pointer_path)? {
        let pointer: PatchSetPointer = read_json(&pointer_path, RepositoryComponent::Patches)?;
        let bytes = read_bytes(
            &profile_path.join(format!(
                "patches/sets/{}.json",
                pointer.fingerprint.as_str()
            )),
            RepositoryComponent::Patches,
        )?;
        if Fingerprint::from_normalized_artifact(&bytes) != pointer.fingerprint {
            return Err(RepositoryError::IntegrityMismatch);
        }
        return serde_json::from_slice(&bytes).map_err(|_| RepositoryError::CorruptData {
            component: RepositoryComponent::Patches,
        });
    }

    let legacy_path = profile_path.join("patches/patches.json");
    if path_exists_no_follow(&legacy_path)? {
        return read_json(&legacy_path, RepositoryComponent::Patches);
    }
    Ok(ProfilePatchSet::empty(
        &metadata.revision.id,
        &metadata.artifact.fingerprint,
    ))
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
    if !metadata
        .runtime_provenance
        .is_bound_to(&metadata.revision.id, &metadata.artifact.fingerprint)
    {
        return Err(RepositoryError::IntegrityMismatch);
    }
    Ok(())
}

fn migrate_legacy_metadata(metadata: &mut ProfileMetadata) {
    if metadata.schema_version != 1 {
        return;
    }
    metadata.runtime_provenance =
        crate::migrated_runtime_provenance(&metadata.revision.id, &metadata.artifact.fingerprint);
    metadata.schema_version = PROFILE_SCHEMA_VERSION;
}

fn validate_record(record: &ProfileRecord) -> Result<(), RepositoryError> {
    if ProfileId::parse(record.metadata.id.as_str().to_owned()).is_err() {
        return Err(RepositoryError::CorruptData {
            component: RepositoryComponent::Metadata,
        });
    }
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
        || !record.metadata.runtime_provenance.is_bound_to(
            &record.metadata.revision.id,
            &record.metadata.artifact.fingerprint,
        )
    {
        return Err(RepositoryError::IntegrityMismatch);
    }
    if record.patches.schema_version != crate::PROFILE_PATCH_SCHEMA_VERSION {
        return Err(RepositoryError::UnsupportedSchema {
            expected: crate::PROFILE_PATCH_SCHEMA_VERSION,
            found: record.patches.schema_version,
        });
    }
    if !record.patches.source_revision.is_canonical()
        || !record.patches.source_fingerprint.is_canonical()
        || !record.patches.effective_fingerprint.is_canonical()
    {
        return Err(RepositoryError::IntegrityMismatch);
    }
    if crate::validate_patch_set_shape(&record.patches).is_err() {
        return Err(RepositoryError::CorruptData {
            component: RepositoryComponent::Patches,
        });
    }
    if record.metadata.status.valid
        && (!record.patches.is_bound_to(
            &record.metadata.revision.id,
            &record.metadata.artifact.fingerprint,
        ) || crate::apply_profile_patches(
            &record.normalized_bytes,
            &record.metadata.revision.id,
            &record.metadata.artifact.fingerprint,
            &record.patches,
        )
        .is_err())
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

fn read_json_bounded<T: DeserializeOwned>(
    path: &Path,
    component: RepositoryComponent,
    max_bytes: u64,
) -> Result<T, RepositoryError> {
    let bytes = read_bytes_bounded(path, component, max_bytes)?;
    serde_json::from_slice(&bytes).map_err(|_| RepositoryError::CorruptData { component })
}

fn read_bytes(path: &Path, component: RepositoryComponent) -> Result<Vec<u8>, RepositoryError> {
    read_bytes_bounded(path, component, MAX_PERSISTED_FILE_BYTES)
}

fn read_bytes_bounded(
    path: &Path,
    component: RepositoryComponent,
    max_bytes: u64,
) -> Result<Vec<u8>, RepositoryError> {
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
    if metadata.len() > max_bytes {
        return Err(RepositoryError::CorruptData { component });
    }
    let mut file = open_read_no_follow(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            RepositoryError::CorruptData { component }
        } else if error.kind() == io::ErrorKind::TooManyLinks {
            RepositoryError::UnsafeStoragePath
        } else {
            RepositoryError::ReadFailed
        }
    })?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| RepositoryError::ReadFailed)?;
    if bytes.len() as u64 > max_bytes {
        return Err(RepositoryError::CorruptData { component });
    }
    Ok(bytes)
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
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW);
    }
    options.open(path)?.sync_all()
}

fn open_read_no_follow(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

fn path_exists_no_follow(path: &Path) -> Result<bool, RepositoryError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(RepositoryError::UnsafeStoragePath)
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(RepositoryError::ReadFailed),
    }
}

fn ensure_directory(path: &Path, component: RepositoryComponent) -> Result<(), RepositoryError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            RepositoryError::CorruptData { component }
        } else {
            RepositoryError::ReadFailed
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err(RepositoryError::UnsafeStoragePath);
    }
    if !metadata.is_dir() {
        return Err(RepositoryError::CorruptData { component });
    }
    Ok(())
}

fn validate_generation_manifest(
    generation: &Path,
    expected_id: &ProfileGenerationId,
) -> Result<(), RepositoryError> {
    let manifest: GenerationManifest = read_json_bounded(
        &generation.join("manifest.json"),
        RepositoryComponent::GenerationManifest,
        MAX_GENERATION_MANIFEST_BYTES,
    )?;
    if manifest.schema_version != PROFILE_GENERATION_SCHEMA_VERSION {
        return Err(RepositoryError::UnsupportedSchema {
            expected: PROFILE_GENERATION_SCHEMA_VERSION,
            found: manifest.schema_version,
        });
    }
    if manifest.generation_id != *expected_id
        || manifest.profile_ids.len() > MAX_GENERATION_PROFILES
        || manifest
            .profile_ids
            .windows(2)
            .any(|pair| pair[0].as_str() >= pair[1].as_str())
    {
        return Err(RepositoryError::CorruptData {
            component: RepositoryComponent::GenerationManifest,
        });
    }
    validate_generation_id(
        &manifest.generation_id,
        RepositoryComponent::GenerationManifest,
    )?;
    for profile_id in &manifest.profile_ids {
        if ProfileId::parse(profile_id.as_str().to_owned()).is_err() {
            return Err(RepositoryError::CorruptData {
                component: RepositoryComponent::GenerationManifest,
            });
        }
        let profile_path = generation.join("profiles").join(profile_id.as_str());
        reject_symlinks_between(generation, &profile_path)?;
    }
    ensure_directory(
        &generation.join("profiles"),
        RepositoryComponent::GenerationManifest,
    )?;
    Ok(())
}

fn validate_generation_entries(
    profiles_root: &Path,
    expected: &[ProfileId],
) -> Result<(), RepositoryError> {
    let mut actual = Vec::new();
    for entry in fs::read_dir(profiles_root).map_err(|_| RepositoryError::ReadFailed)? {
        let entry = entry.map_err(|_| RepositoryError::ReadFailed)?;
        if actual.len() >= MAX_GENERATION_PROFILES {
            return Err(RepositoryError::CorruptData {
                component: RepositoryComponent::GenerationManifest,
            });
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| RepositoryError::CorruptData {
                component: RepositoryComponent::GenerationManifest,
            })?;
        let profile_id =
            ProfileId::parse(name.clone()).map_err(|_| RepositoryError::CorruptData {
                component: RepositoryComponent::GenerationManifest,
            })?;
        let path = entry.path();
        reject_symlinks_between(profiles_root, &path)?;
        ensure_directory(&path, RepositoryComponent::GenerationManifest)?;
        actual.push((name, profile_id));
    }
    actual.sort_by(|left, right| left.0.cmp(&right.0));
    if actual.len() != expected.len()
        || actual
            .iter()
            .zip(expected)
            .any(|((actual, _), expected)| actual != expected.as_str())
    {
        return Err(RepositoryError::CorruptData {
            component: RepositoryComponent::GenerationManifest,
        });
    }
    Ok(())
}

fn validate_generation_id(
    id: &ProfileGenerationId,
    component: RepositoryComponent,
) -> Result<(), RepositoryError> {
    let uuid =
        Uuid::parse_str(id.as_str()).map_err(|_| RepositoryError::CorruptData { component })?;
    if uuid.to_string() != id.as_str() {
        return Err(RepositoryError::CorruptData { component });
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("mish-profile-generation-read-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("create private test root");
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn pointer_replacement_at_the_read_barrier_is_rejected_as_stale() {
        let root = TestRoot::new();
        let repository = FileProfileRepository::new(root.0.join("profile-store"));

        let first = repository
            .stage_generation(&[])
            .expect("stage first empty generation");
        let first_id = repository
            .publish_generation(first)
            .expect("publish first empty generation");

        let second = repository
            .stage_generation(&[])
            .expect("stage second empty generation");
        let second_id = second.id.clone();
        let second_staging = repository
            .generations_root()
            .join(format!(".staging-{}", second_id.as_str()));
        let second_generation = repository.generations_root().join(second_id.as_str());
        StdAtomicWriter
            .rename(&second_staging, &second_generation)
            .expect("seal second generation directory");
        StdAtomicWriter
            .sync_directory(&repository.generations_root())
            .expect("sync second generation directory");

        let result = repository.read_current_generation_inner(|| {
            let pointer = GenerationPointer {
                generation_id: second_id.clone(),
                schema_version: PROFILE_GENERATION_SCHEMA_VERSION,
            };
            let contents = serde_json::to_vec(&pointer).expect("serialize synthetic pointer");
            StdAtomicWriter
                .write(&repository.current_generation_path(), &contents)
                .expect("replace pointer at deterministic read barrier");
        });

        assert!(matches!(result, Err(RepositoryError::StaleGeneration)));

        let current = repository
            .read_current_generation()
            .expect("read the replacement generation")
            .expect("replacement pointer remains complete");
        assert_eq!(current.id, second_id);
        assert_ne!(current.id, first_id);
    }
}
