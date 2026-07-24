fn main() {
    println!("cargo:rerun-if-env-changed=MISH_EXPECTED_APPLE_TEAM_IDENTIFIER");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "runtime_bootstrap",
            "reveal_main_window",
            "open_system_proxy_settings",
            "profile_preflight_local",
            "diagnostics_support_bundle_preview",
            "diagnostics_support_bundle_save",
            "local_backup_export_preview",
            "local_backup_export_save",
            "local_backup_restore_preview",
            "local_backup_restore_commit",
        ]),
    ))
    .expect("failed to prepare the Mish desktop shell");
}
