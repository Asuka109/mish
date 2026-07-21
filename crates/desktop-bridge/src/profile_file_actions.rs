use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

const BASIC_PROFILE: &[u8] =
    b"mode: rule\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n";

#[derive(Clone)]
pub struct ProfileFileActions {
    platform: Arc<dyn ProfileFileActionPlatform>,
    root: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ProfileFileActionError {
    #[error("profile file already exists")]
    AlreadyExists,
    #[error("profile file name is invalid")]
    InvalidFileName,
    #[error("profile file action is unavailable")]
    Unavailable,
}

pub trait ProfileFileActionPlatform: Send + Sync {
    fn open_directory(&self, path: &Path) -> Result<(), ProfileFileActionError>;
}

impl ProfileFileActions {
    pub fn system(root: PathBuf) -> Self {
        Self::new(root, Arc::new(SystemProfileFileActionPlatform))
    }

    pub fn new(root: PathBuf, platform: Arc<dyn ProfileFileActionPlatform>) -> Self {
        Self { platform, root }
    }

    pub fn open_profiles_directory(&self) -> Result<(), ProfileFileActionError> {
        self.prepare_root()?;
        self.platform.open_directory(&self.root)
    }

    pub fn create_basic_profile(&self, file_name: &str) -> Result<(), ProfileFileActionError> {
        let path = validated_profile_path(&self.root, file_name)?;
        self.prepare_root()?;

        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                ProfileFileActionError::AlreadyExists
            } else {
                ProfileFileActionError::Unavailable
            }
        })?;
        if file
            .write_all(BASIC_PROFILE)
            .and_then(|()| file.sync_all())
            .is_err()
        {
            drop(file);
            let _ = fs::remove_file(path);
            return Err(ProfileFileActionError::Unavailable);
        }
        Ok(())
    }

    fn prepare_root(&self) -> Result<(), ProfileFileActionError> {
        fs::create_dir_all(&self.root).map_err(|_| ProfileFileActionError::Unavailable)?;
        let metadata =
            fs::symlink_metadata(&self.root).map_err(|_| ProfileFileActionError::Unavailable)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(ProfileFileActionError::Unavailable);
        }
        Ok(())
    }
}

fn validated_profile_path(root: &Path, file_name: &str) -> Result<PathBuf, ProfileFileActionError> {
    let path = Path::new(file_name);
    let valid_component = path.components().count() == 1
        && matches!(
            path.components().next(),
            Some(std::path::Component::Normal(_))
        );
    let valid_extension = matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("yaml" | "yml")
    );
    let valid_stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(|value| !value.is_empty());
    if file_name.chars().count() > 120
        || file_name.chars().any(char::is_control)
        || !valid_component
        || !valid_extension
        || !valid_stem
    {
        return Err(ProfileFileActionError::InvalidFileName);
    }
    Ok(root.join(path))
}

struct SystemProfileFileActionPlatform;

impl ProfileFileActionPlatform for SystemProfileFileActionPlatform {
    fn open_directory(&self, path: &Path) -> Result<(), ProfileFileActionError> {
        let status = if cfg!(target_os = "windows") {
            Command::new("explorer").arg(path).status()
        } else if cfg!(target_os = "macos") {
            Command::new("open").arg(path).status()
        } else {
            Command::new("xdg-open").arg(path).status()
        };
        match status {
            Ok(status) if status.success() => Ok(()),
            _ => Err(ProfileFileActionError::Unavailable),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tempfile::tempdir;

    use super::*;

    #[derive(Default)]
    struct RecordingPlatform {
        opened: Mutex<Vec<PathBuf>>,
    }

    impl ProfileFileActionPlatform for RecordingPlatform {
        fn open_directory(&self, path: &Path) -> Result<(), ProfileFileActionError> {
            self.opened.lock().unwrap().push(path.to_owned());
            Ok(())
        }
    }

    #[test]
    fn opens_the_configured_profiles_directory() {
        let root = tempdir().unwrap();
        let directory = root.path().join("profiles");
        let platform = Arc::new(RecordingPlatform::default());
        let actions = ProfileFileActions::new(directory.clone(), platform.clone());
        actions.open_profiles_directory().unwrap();

        assert_eq!(platform.opened.lock().unwrap().as_slice(), &[directory]);
    }

    #[test]
    fn creates_a_basic_profile_without_overwriting_existing_files() {
        let root = tempdir().unwrap();
        let directory = root.path().join("profiles");
        let actions =
            ProfileFileActions::new(directory.clone(), Arc::new(RecordingPlatform::default()));

        actions.create_basic_profile("home.yaml").unwrap();
        assert_eq!(
            fs::read(directory.join("home.yaml")).unwrap(),
            BASIC_PROFILE
        );
        assert_eq!(
            actions.create_basic_profile("home.yaml").unwrap_err(),
            ProfileFileActionError::AlreadyExists
        );
    }

    #[test]
    fn rejects_unsafe_or_non_yaml_profile_names() {
        let root = tempdir().unwrap();
        let actions = ProfileFileActions::new(
            root.path().join("profiles"),
            Arc::new(RecordingPlatform::default()),
        );

        for file_name in ["../home.yaml", "/tmp/home.yaml", "home.txt", ".yaml"] {
            assert_eq!(
                actions.create_basic_profile(file_name).unwrap_err(),
                ProfileFileActionError::InvalidFileName
            );
        }
    }
}
