use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

#[derive(Clone)]
pub struct ProfileFileActions {
    platform: Arc<dyn ProfileFileActionPlatform>,
    root: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ProfileFileActionError {
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
        fs::create_dir_all(&self.root).map_err(|_| ProfileFileActionError::Unavailable)?;
        self.platform.open_directory(&self.root)
    }
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
}
