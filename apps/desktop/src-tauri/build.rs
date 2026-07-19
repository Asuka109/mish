fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "runtime_bootstrap",
            "reveal_main_window",
            "profile_preflight_local",
            "diagnostics_support_bundle_preview",
            "diagnostics_support_bundle_save",
        ]),
    ))
    .expect("failed to prepare the Mish desktop shell");
}
