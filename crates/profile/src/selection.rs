use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};

use crate::{AtomicWriter, ProfileListItem, RepositoryError, StdAtomicWriter};

const PROFILE_SELECTION_SCHEMA_VERSION: u8 = 1;
const PROFILE_SELECTION_MAX_BYTES: u64 = 4_096;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSelectionSnapshot {
    pub profile_id: Option<String>,
    pub revision: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProfileSelection {
    profile_id: Option<String>,
    revision: u64,
    schema_version: u8,
}

pub(crate) struct ProfileSelectionAuthority {
    path: PathBuf,
    state: Mutex<ProfileSelectionState>,
}

struct ProfileSelectionState {
    migration_pending: bool,
    snapshot: ProfileSelectionSnapshot,
}

impl ProfileSelectionAuthority {
    pub(crate) fn load(root: &Path) -> Self {
        let path = root.join("selected-profile.json");
        let stored = load_selection(&path);
        Self {
            path,
            state: Mutex::new(ProfileSelectionState {
                migration_pending: stored.is_none(),
                snapshot: stored.unwrap_or_default(),
            }),
        }
    }

    pub(crate) fn initialize(
        &self,
        profiles: &[ProfileListItem],
        preferred_profile_id: Option<&str>,
    ) -> Result<ProfileSelectionSnapshot, RepositoryError> {
        let mut state = self
            .state
            .lock()
            .expect("Profile selection state lock poisoned");
        if !state.migration_pending {
            return reconcile_selection(&self.path, &mut state, profiles);
        }
        let next = preferred_profile_id
            .filter(|profile_id| valid_profile(profiles, profile_id))
            .map(str::to_owned)
            .or_else(|| first_valid_profile_id(profiles));
        commit_selection(&self.path, &mut state.snapshot, next)?;
        state.migration_pending = false;
        Ok(state.snapshot.clone())
    }

    pub(crate) fn reconcile(
        &self,
        profiles: &[ProfileListItem],
    ) -> Result<ProfileSelectionSnapshot, RepositoryError> {
        let mut state = self
            .state
            .lock()
            .expect("Profile selection state lock poisoned");
        reconcile_selection(&self.path, &mut state, profiles)
    }

    pub(crate) fn select(
        &self,
        profiles: &[ProfileListItem],
        profile_id: &str,
        expected: Option<&ProfileSelectionSnapshot>,
    ) -> Result<ProfileSelectionSnapshot, RepositoryError> {
        if !valid_profile(profiles, profile_id) {
            return Err(RepositoryError::NotFound);
        }
        let mut state = self
            .state
            .lock()
            .expect("Profile selection state lock poisoned");
        if expected.is_some_and(|expected| expected != &state.snapshot) {
            return Ok(state.snapshot.clone());
        }
        if state.snapshot.profile_id.as_deref() == Some(profile_id) {
            return Ok(state.snapshot.clone());
        }
        commit_selection(&self.path, &mut state.snapshot, Some(profile_id.to_owned()))?;
        state.migration_pending = false;
        Ok(state.snapshot.clone())
    }
}

fn reconcile_selection(
    path: &Path,
    state: &mut ProfileSelectionState,
    profiles: &[ProfileListItem],
) -> Result<ProfileSelectionSnapshot, RepositoryError> {
    let next = state
        .snapshot
        .profile_id
        .as_ref()
        .filter(|profile_id| valid_profile(profiles, profile_id))
        .cloned()
        .or_else(|| first_valid_profile_id(profiles));
    if next == state.snapshot.profile_id {
        return Ok(state.snapshot.clone());
    }
    commit_selection(path, &mut state.snapshot, next)?;
    state.migration_pending = false;
    Ok(state.snapshot.clone())
}

fn valid_profile(profiles: &[ProfileListItem], profile_id: &str) -> bool {
    profiles
        .iter()
        .any(|profile| profile.id == profile_id && profile.status.valid)
}

fn first_valid_profile_id(profiles: &[ProfileListItem]) -> Option<String> {
    profiles
        .iter()
        .find(|profile| profile.status.valid)
        .map(|profile| profile.id.clone())
}

fn commit_selection(
    path: &Path,
    state: &mut ProfileSelectionSnapshot,
    profile_id: Option<String>,
) -> Result<(), RepositoryError> {
    let revision = state
        .revision
        .checked_add(1)
        .ok_or(RepositoryError::AtomicWriteFailed)?;
    let stored = StoredProfileSelection {
        profile_id: profile_id.clone(),
        revision,
        schema_version: PROFILE_SELECTION_SCHEMA_VERSION,
    };
    let contents =
        serde_json::to_vec_pretty(&stored).map_err(|_| RepositoryError::AtomicWriteFailed)?;
    StdAtomicWriter
        .write(path, &contents)
        .map_err(|_| RepositoryError::AtomicWriteFailed)?;
    state.profile_id = profile_id;
    state.revision = revision;
    Ok(())
}

fn load_selection(path: &Path) -> Option<ProfileSelectionSnapshot> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return None,
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > PROFILE_SELECTION_MAX_BYTES
    {
        return None;
    }
    let stored: StoredProfileSelection = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    if stored.schema_version != PROFILE_SELECTION_SCHEMA_VERSION
        || stored.revision == 0
        || stored
            .profile_id
            .as_deref()
            .is_some_and(|profile_id| crate::ProfileId::parse(profile_id.to_owned()).is_err())
    {
        return None;
    }
    Some(ProfileSelectionSnapshot {
        profile_id: stored.profile_id,
        revision: stored.revision,
    })
}
