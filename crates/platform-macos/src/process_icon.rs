use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use mish_runtime::{PROCESS_ICON_MAX_BYTES, ProcessIcon, ProcessIconResolver};

const CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
const CACHE_MAX_ENTRIES: usize = 256;
const PROCESS_PATH_MAX_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub struct MacOsProcessIconResolver {
    cache: Mutex<ProcessIconCache>,
}

impl ProcessIconResolver for MacOsProcessIconResolver {
    fn resolve(&self, process_path: &Path) -> Option<ProcessIcon> {
        let target = icon_target(process_path)?;
        let mut cache = self.cache.lock().ok()?;
        if let Some(icon) = cache.get(&target) {
            return icon;
        }
        let icon = load_png_icon(&target);
        cache.insert(target, icon.clone());
        icon
    }
}

#[derive(Default)]
struct ProcessIconCache {
    bytes: usize,
    entries: HashMap<PathBuf, Option<ProcessIcon>>,
    order: VecDeque<PathBuf>,
}

impl ProcessIconCache {
    fn get(&mut self, path: &Path) -> Option<Option<ProcessIcon>> {
        let icon = self.entries.get(path)?.clone();
        self.order.retain(|candidate| candidate != path);
        self.order.push_back(path.to_path_buf());
        Some(icon)
    }

    fn insert(&mut self, path: PathBuf, icon: Option<ProcessIcon>) {
        if let Some(previous) = self.entries.remove(&path).flatten() {
            self.bytes = self.bytes.saturating_sub(previous.bytes().len());
        }
        self.order.retain(|candidate| candidate != &path);
        self.bytes = self
            .bytes
            .saturating_add(icon.as_ref().map_or(0, |icon| icon.bytes().len()));
        self.entries.insert(path.clone(), icon);
        self.order.push_back(path);
        while self.entries.len() > CACHE_MAX_ENTRIES || self.bytes > CACHE_MAX_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(icon) = self.entries.remove(&oldest).flatten() {
                self.bytes = self.bytes.saturating_sub(icon.bytes().len());
            }
        }
    }
}

fn icon_target(process_path: &Path) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;

    if !process_path.is_absolute()
        || process_path.as_os_str().as_bytes().len() > PROCESS_PATH_MAX_BYTES
        || !fs::metadata(process_path).ok()?.is_file()
    {
        return None;
    }
    process_path
        .ancestors()
        .find(|ancestor| {
            ancestor
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
        })
        .unwrap_or(process_path)
        .canonicalize()
        .ok()
}

#[cfg(target_os = "macos")]
fn load_png_icon(path: &Path) -> Option<ProcessIcon> {
    use block2::RcBlock;
    use objc2::runtime::{AnyObject, Bool};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage, NSWorkspace,
    };
    use objc2_foundation::{NSDictionary, NSSize, NSString};

    let path = NSString::from_str(path.to_str()?);
    let image = NSWorkspace::sharedWorkspace().iconForFile(&path);
    let size = NSSize::new(64.0, 64.0);
    let drawing = RcBlock::new(move |rect| {
        image.drawInRect(rect);
        Bool::YES
    });
    let resized = NSImage::imageWithSize_flipped_drawingHandler(size, false, &drawing);
    let tiff = resized.TIFFRepresentation()?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
    // SAFETY: The empty dictionary contains no values with an incompatible Objective-C type.
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
    }?
    .to_vec();
    if png.is_empty() || png.len() > PROCESS_ICON_MAX_BYTES {
        return None;
    }
    ProcessIcon::from_png(png)
}

#[cfg(not(target_os = "macos"))]
fn load_png_icon(_path: &Path) -> Option<ProcessIcon> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn resolves_and_caches_a_bounded_png_for_an_application_executable() {
        let finder = Path::new("/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder");
        let resolver = MacOsProcessIconResolver::default();
        let first = resolver.resolve(finder).expect("Finder icon");
        let second = resolver.resolve(finder).expect("cached Finder icon");

        assert!(first.bytes().starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(first.bytes().len() <= PROCESS_ICON_MAX_BYTES);
        assert_eq!(first, second);
        assert_eq!(resolver.cache.lock().unwrap().entries.len(), 1);
    }

    #[test]
    fn rejects_relative_missing_and_oversized_process_paths() {
        let resolver = MacOsProcessIconResolver::default();
        assert!(resolver.resolve(Path::new("relative-process")).is_none());
        assert!(
            resolver
                .resolve(Path::new("/missing/mish/process"))
                .is_none()
        );
        assert!(
            resolver
                .resolve(Path::new(&format!(
                    "/{}",
                    "x".repeat(PROCESS_PATH_MAX_BYTES)
                )))
                .is_none()
        );
    }
}
