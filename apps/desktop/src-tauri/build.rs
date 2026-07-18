fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["runtime_bootstrap"])),
    )
    .expect("failed to prepare the Mish desktop shell");
}
