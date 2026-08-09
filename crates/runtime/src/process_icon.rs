use std::{path::Path, sync::Arc};

pub const PROCESS_ICON_MAX_BYTES: usize = 262_144;
pub const PROCESS_ICON_PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

/// Bounded PNG bytes returned by a platform process-icon adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessIcon {
    bytes: Arc<[u8]>,
}

impl ProcessIcon {
    pub fn from_png(bytes: impl Into<Arc<[u8]>>) -> Option<Self> {
        let bytes = bytes.into();
        if bytes.len() > PROCESS_ICON_MAX_BYTES || !bytes.starts_with(PROCESS_ICON_PNG_SIGNATURE) {
            return None;
        }
        Some(Self { bytes })
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// Lower-level platform port for resolving an already-observed process path.
///
/// Implementations own filesystem validation, privacy, and cache policy. The returned value
/// enforces the shared PNG size/type bound before a transport can encode it.
pub trait ProcessIconResolver: Send + Sync {
    fn resolve(&self, process_path: &Path) -> Option<ProcessIcon>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_bounded_png_bytes() {
        assert!(ProcessIcon::from_png(PROCESS_ICON_PNG_SIGNATURE).is_some());
        assert!(ProcessIcon::from_png(b"not-a-png".as_slice()).is_none());

        let mut oversized = PROCESS_ICON_PNG_SIGNATURE.to_vec();
        oversized.resize(PROCESS_ICON_MAX_BYTES + 1, 0);
        assert!(ProcessIcon::from_png(oversized).is_none());
    }
}
