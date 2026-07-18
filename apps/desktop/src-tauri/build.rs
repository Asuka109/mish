fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["runtime_bootstrap", "profile_preflight_local"]),
    ))
    .expect("failed to prepare the Mish desktop shell");
}
