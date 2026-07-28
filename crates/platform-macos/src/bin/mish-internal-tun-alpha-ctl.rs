use std::{
    collections::BTreeSet,
    env, fs,
    fs::{File, OpenOptions},
    future::Future,
    io::{Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    pin::Pin,
    process::{Command, Output},
    sync::{Arc, Mutex},
    time::Duration,
};

use mish_platform_macos::{
    DEV_TUN_INSTALLATION_KEY_ALGORITHM, DEV_TUN_SERVICE_CORE_PATH, DEV_TUN_SERVICE_ENROLLMENT_PATH,
    DEV_TUN_SERVICE_HELPER_PATH, DEV_TUN_SERVICE_LABEL, DEV_TUN_SERVICE_PLIST_PATH,
    InstallationClientKeyStore, InstallationEnrollmentOperation, InstallationEnrollmentRecord,
    MacOsTunServiceClient, apply_installation_enrollment_operation,
    internal_tun_package_machine::{
        ObservedPackageState, PackageEffect, PackageEffectOutcome, PackageFailure, PackageInput,
        PackageMachine, PackageOperation, PackageOperationKind, PackageProjection, PackageState,
        PackageSuccess,
    },
    load_installation_enrollment_for_user, remove_installation_enrollment,
};
use mish_runtime::tun_observation_now;
use mish_state_machine::{Correlation, EffectExecutor, NoopObserver, RunnerConfig, spawn_runner};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const PROFILE: &str = "internal-tun-alpha";
const MANIFEST_NAME: &str = "internal-tun-alpha-manifest.json";
const MANIFEST_MAX_BYTES: u64 = 1024 * 1024;
const INSTALLER_FILE_MAX_BYTES: u64 = 64 * 1024;
const PACKAGE_FILE_MAX_BYTES: u64 = 256 * 1024 * 1024;
const SEALED_CONFIG_MAX_BYTES: u64 = 8 * 1024 * 1024;
const PROTOCOL_VERSION: u16 = 3;
const IDENTITY_SCHEME: &str = "sha256-helper-core-rendered-plist-v1";
const CONTROLLER_RELATIVE_PATH: &str = "Resources/mish-internal-tun-alpha-ctl";
const HELPER_RELATIVE_PATH: &str = "Resources/mish-tun-helper";
const CORE_RELATIVE_PATH: &str = "Resources/mihomo";
const PLIST_TEMPLATE_RELATIVE_PATH: &str =
    "Resources/com.asuka109.mish.tun-helper.dev.plist.template";
const ROOT_RECEIPT_DIRECTORY: &str =
    "/Library/Application Support/com.asuka109.mish/internal-tun-alpha";
const ROOT_RECEIPT_PATH: &str =
    "/Library/Application Support/com.asuka109.mish/internal-tun-alpha/receipt.json";
const INSTALLER_DIRECTORY_NAME: &str = "internal-tun-alpha-installer";
const PRIVILEGED_CONTROLLER_STAGE_NAME: &str = "privileged-controller";
const PRIVILEGED_CONTROLLER_ROOT_PREFIX: &str =
    "/private/var/tmp/com.asuka109.mish.internal-tun-alpha.";
const USER_RECEIPT_NAME: &str = "internal-tun-alpha-receipt.json";
const INSTALLATION_ID_PLACEHOLDER: &str = "__MISH_INSTALLATION_ID__";
const UID_PLACEHOLDER: &str = "__MISH_ALLOWED_UID__";
const RUNTIME_ROOT_PLACEHOLDER: &str = "__MISH_RUNTIME_ROOT_XML__";
const SOCKET_PLACEHOLDER: &str = "__MISH_SOCKET__";
const TART_TERMINAL_AUTHORIZATION: &str = "--tart-terminal-authorization";
const POST_INSTALL_HEALTH_ATTEMPTS: usize = 151;
const POST_INSTALL_HEALTH_RETRY_DELAY: Duration = Duration::from_millis(100);

const EXPECTED_PACKAGE_FILES: &[(&str, u32, &str)] = &[
    ("Health Internal TUN Alpha.command", 0o755, "health"),
    ("Install Internal TUN Alpha.command", 0o755, "install"),
    ("LICENSE", 0o644, "license"),
    ("README.txt", 0o644, "notice"),
    ("Repair Internal TUN Alpha.command", 0o755, "repair"),
    (CONTROLLER_RELATIVE_PATH, 0o755, "controller"),
    (
        PLIST_TEMPLATE_RELATIVE_PATH,
        0o644,
        "launch-daemon-template",
    ),
    (CORE_RELATIVE_PATH, 0o755, "core"),
    (HELPER_RELATIVE_PATH, 0o755, "helper"),
    ("Status Internal TUN Alpha.command", 0o755, "status"),
    ("THIRD_PARTY_NOTICES.md", 0o644, "notices"),
    ("Uninstall Internal TUN Alpha.command", 0o755, "uninstall"),
];

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageManifest {
    allow_tun: bool,
    architecture: String,
    core_version: String,
    developer_id_required: bool,
    files: Vec<PackageFile>,
    helper_version: String,
    installation_identity_scheme: String,
    minimum_macos_version: u16,
    network_mutation_enabled: bool,
    package_version: String,
    profile: String,
    protocol_version: u16,
    schema_version: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageFile {
    mode: u32,
    path: String,
    role: String,
    sha256: String,
    size: u64,
}

#[derive(Clone, Debug)]
struct VerifiedPackage {
    manifest: PackageManifest,
    manifest_digest: String,
    root: PathBuf,
}

#[derive(Clone, Debug)]
struct StagedPrivilegedController {
    path: PathBuf,
    sha256: String,
    size: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InstallationReceipt {
    core_sha256: String,
    core_version: String,
    generation: u64,
    helper_sha256: String,
    helper_version: String,
    installation_id: String,
    key_id: String,
    manifest_sha256: String,
    package_version: String,
    plist_sha256: String,
    profile: String,
    protocol_version: u16,
    schema_version: u16,
    installing_uid: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UserAction {
    Health,
    Install,
    Repair,
    Status,
    Uninstall,
}

fn main() {
    let result = run();
    match result {
        Ok(value) => println!("{value}"),
        Err(message) => {
            println!(
                "{}",
                json!({
                    "code": message,
                    "ok": false,
                    "profile": PROFILE,
                })
            );
            std::process::exit(1);
        }
    }
}

#[tokio::main]
async fn run() -> Result<serde_json::Value, String> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [action, package_root] if !action.starts_with("__") => {
            run_user_action(action, package_root, false).await
        }
        [action, package_root, option]
            if !action.starts_with("__") && option == TART_TERMINAL_AUTHORIZATION =>
        {
            run_user_action(action, package_root, true).await
        }
        [
            action,
            package_root,
            uid,
            gid,
            home,
            controller_sha256,
            controller_size,
        ] if action == "__privileged-install" || action == "__privileged-uninstall" => {
            if unsafe { libc::geteuid() } != 0 {
                return Err("administrator-authorization-required".into());
            }
            let controller_size = controller_size
                .parse::<u64>()
                .ok()
                .filter(|value| *value > 0 && *value <= PACKAGE_FILE_MAX_BYTES)
                .ok_or_else(|| "privileged-controller-size-invalid".to_string())?;
            validate_privileged_controller_runtime(controller_sha256, controller_size)?;
            let uid = parse_identity(uid, "uid")?;
            let gid = parse_identity(gid, "gid")?;
            let home = PathBuf::from(home);
            validate_user_home(&home, uid)?;
            let package = verify_package(Path::new(package_root), uid)?;
            validate_package_controller_binding(&package, controller_sha256, controller_size)?;
            if action == "__privileged-install" {
                privileged_install(&package, uid, gid, &home)
            } else {
                privileged_uninstall(&package, uid, gid, &home)
            }
        }
        _ => Err("usage-install-repair-health-status-uninstall-package-root".into()),
    }
}

async fn run_user_action(
    action: &str,
    package_root: &str,
    tart_terminal_authorization: bool,
) -> Result<serde_json::Value, String> {
    let action = parse_user_action(action)?;
    if tart_terminal_authorization && !terminal_authorization_allowed(action) {
        return Err("tart-terminal-authorization-action-rejected".into());
    }
    ensure_supported_target()?;
    let uid = current_uid()?;
    let gid = current_gid()?;
    let home = user_home(uid)?;
    let package = verify_package(Path::new(package_root), uid)?;
    match action {
        UserAction::Status => status(&package, uid),
        UserAction::Health => health(&package, uid, &home).await,
        UserAction::Install | UserAction::Repair => {
            install_or_repair(
                action,
                &package,
                uid,
                gid,
                &home,
                tart_terminal_authorization,
            )
            .await
        }
        UserAction::Uninstall => {
            uninstall(&package, uid, gid, &home, tart_terminal_authorization).await
        }
    }
}

fn parse_user_action(value: &str) -> Result<UserAction, String> {
    match value {
        "health" => Ok(UserAction::Health),
        "install" => Ok(UserAction::Install),
        "repair" => Ok(UserAction::Repair),
        "status" => Ok(UserAction::Status),
        "uninstall" => Ok(UserAction::Uninstall),
        _ => Err("unsupported-lifecycle-action".into()),
    }
}

fn terminal_authorization_allowed(action: UserAction) -> bool {
    matches!(
        action,
        UserAction::Install | UserAction::Repair | UserAction::Uninstall
    )
}

fn ensure_supported_target() -> Result<(), String> {
    if !cfg!(target_os = "macos") || env::consts::ARCH != "aarch64" {
        return Err("unsupported-internal-tun-alpha-target".into());
    }
    let output = Command::new("/usr/bin/sw_vers")
        .args(["-productVersion"])
        .output()
        .map_err(|_| "macos-version-unavailable")?;
    let major = String::from_utf8_lossy(&output.stdout)
        .split('.')
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    if !output.status.success() || major < 13 {
        return Err("unsupported-macos-version".into());
    }
    Ok(())
}

fn current_uid() -> Result<u32, String> {
    let uid = unsafe { libc::getuid() };
    if uid == 0 {
        return Err("internal-tun-alpha-must-run-as-user".into());
    }
    Ok(uid)
}

fn current_gid() -> Result<u32, String> {
    let gid = unsafe { libc::getgid() };
    if gid == 0 {
        return Err("internal-tun-alpha-must-run-as-user".into());
    }
    Ok(gid)
}

fn parse_identity(value: &str, kind: &str) -> Result<u32, String> {
    value
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("invalid-installing-{kind}"))
}

fn user_home(uid: u32) -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "installing-user-home-unavailable".to_string())?;
    validate_user_home(&home, uid)?;
    Ok(home)
}

fn validate_user_home(home: &Path, uid: u32) -> Result<(), String> {
    if !home.is_absolute() || home.parent().is_none() {
        return Err("installing-user-home-invalid".into());
    }
    let metadata = fs::symlink_metadata(home).map_err(|_| "installing-user-home-unavailable")?;
    let canonical = fs::canonicalize(home).map_err(|_| "installing-user-home-unavailable")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != uid
        || canonical != home
    {
        return Err("installing-user-home-metadata-invalid".into());
    }
    Ok(())
}

fn runtime_root(home: &Path) -> PathBuf {
    home.join("Library/Application Support/com.asuka109.mish/runtime")
}

fn installer_root(home: &Path) -> PathBuf {
    runtime_root(home).join(INSTALLER_DIRECTORY_NAME)
}

fn user_receipt_path(home: &Path) -> PathBuf {
    runtime_root(home).join(USER_RECEIPT_NAME)
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_NAME)
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn verify_package(root: &Path, owner_uid: u32) -> Result<VerifiedPackage, String> {
    if !root.is_absolute() {
        return Err("package-root-must-be-absolute".into());
    }
    validate_directory(root, owner_uid, false)?;
    if fs::canonicalize(root).map_err(|_| "package-root-unavailable")? != root {
        return Err("package-root-must-be-canonical".into());
    }
    let resources = root.join("Resources");
    validate_directory(&resources, owner_uid, false)?;

    let manifest_file = manifest_path(root);
    validate_bounded_regular_file(&manifest_file, owner_uid, 0o644, MANIFEST_MAX_BYTES)?;
    let manifest_bytes = read_bounded_file(
        &manifest_file,
        MANIFEST_MAX_BYTES,
        "package-manifest-unavailable",
    )?;
    let manifest: PackageManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|_| "package-manifest-invalid")?;
    if manifest.schema_version != 1
        || manifest.profile != PROFILE
        || manifest.architecture != "arm64"
        || manifest.minimum_macos_version != 13
        || manifest.developer_id_required
        || !manifest.allow_tun
        || !manifest.network_mutation_enabled
        || manifest.protocol_version != PROTOCOL_VERSION
        || manifest.installation_identity_scheme != IDENTITY_SCHEME
        || manifest.package_version.is_empty()
        || manifest.package_version.len() > 64
        || manifest.helper_version.is_empty()
        || manifest.helper_version.len() > 64
        || !manifest.core_version.starts_with('v')
        || manifest.core_version.len() > 32
    {
        return Err("package-profile-contract-invalid".into());
    }

    let expected = EXPECTED_PACKAGE_FILES
        .iter()
        .map(|(path, mode, role)| ((*path).to_string(), *mode, (*role).to_string()))
        .collect::<BTreeSet<_>>();
    let declared = manifest
        .files
        .iter()
        .map(|file| (file.path.clone(), file.mode, file.role.clone()))
        .collect::<BTreeSet<_>>();
    let application_files = manifest
        .files
        .iter()
        .filter(|file| file.role == "application")
        .collect::<Vec<_>>();
    if declared.len() != manifest.files.len()
        || !expected.is_subset(&declared)
        || manifest.files.len() != expected.len() + application_files.len()
        || application_files.is_empty()
        || application_files
            .iter()
            .any(|file| !file.path.starts_with("Mish.app/"))
        || !application_files
            .iter()
            .any(|file| file.path == "Mish.app/Contents/Info.plist")
        || !application_files
            .iter()
            .any(|file| file.path == "Mish.app/Contents/MacOS/mish-desktop")
        || !application_files
            .iter()
            .any(|file| file.path == "Mish.app/Contents/Resources/mihomo-aarch64-apple-darwin")
    {
        return Err("package-file-contract-invalid".into());
    }

    for file in &manifest.files {
        if file.path.starts_with('/')
            || file
                .path
                .split('/')
                .any(|component| component.is_empty() || component == "." || component == "..")
            || !valid_digest(&file.sha256)
            || !matches!(file.mode, 0o644 | 0o755)
            || file.size == 0
            || file.size > PACKAGE_FILE_MAX_BYTES
        {
            return Err("package-file-entry-invalid".into());
        }
        let absolute = root.join(&file.path);
        validate_regular_file(&absolute, owner_uid, file.mode, Some(file.size))?;
        if sha256_file(&absolute)? != file.sha256 {
            return Err(format!("package-file-digest-mismatch:{}", file.path));
        }
    }

    let discovered = walk_package(root)?;
    for relative in &discovered {
        let path = root.join(relative);
        if fs::symlink_metadata(&path)
            .map_err(|_| "package-entry-unavailable")?
            .is_dir()
        {
            validate_directory(&path, owner_uid, false)?;
        }
    }
    let mut expected_paths = BTreeSet::from([MANIFEST_NAME.to_string()]);
    for file in &manifest.files {
        expected_paths.insert(file.path.clone());
        let mut parent = Path::new(&file.path).parent();
        while let Some(parent_path) = parent {
            if parent_path.as_os_str().is_empty() {
                break;
            }
            let path = parent_path
                .to_str()
                .ok_or_else(|| "package-path-invalid".to_string())?
                .replace('\\', "/");
            expected_paths.insert(path);
            parent = parent_path.parent();
        }
    }
    if discovered != expected_paths {
        return Err("package-contains-unexpected-or-missing-files".into());
    }

    Ok(VerifiedPackage {
        manifest,
        manifest_digest: sha256_bytes(&manifest_bytes),
        root: root.to_path_buf(),
    })
}

fn walk_package(root: &Path) -> Result<BTreeSet<String>, String> {
    fn visit(root: &Path, directory: &Path, output: &mut BTreeSet<String>) -> Result<(), String> {
        let entries = fs::read_dir(directory).map_err(|_| "package-directory-unavailable")?;
        for entry in entries {
            let entry = entry.map_err(|_| "package-directory-entry-unavailable")?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "package-path-invalid")?
                .to_str()
                .ok_or_else(|| "package-path-invalid".to_string())?
                .replace('\\', "/");
            if !output.insert(relative) {
                return Err("package-path-duplicate".into());
            }
            let metadata = fs::symlink_metadata(&path).map_err(|_| "package-entry-unavailable")?;
            if metadata.file_type().is_symlink() {
                return Err("package-symlink-rejected".into());
            }
            if metadata.is_dir() {
                visit(root, &path, output)?;
            } else if !metadata.is_file() {
                return Err("package-entry-type-rejected".into());
            }
        }
        Ok(())
    }
    let mut output = BTreeSet::new();
    visit(root, root, &mut output)?;
    Ok(output)
}

fn validate_directory(path: &Path, owner_uid: u32, private: bool) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "directory-unavailable")?;
    let forbidden_mode = if private { 0o077 } else { 0o022 };
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != owner_uid
        || metadata.permissions().mode() & forbidden_mode != 0
    {
        return Err(format!("directory-metadata-rejected:{}", path.display()));
    }
    Ok(())
}

fn validate_regular_file(
    path: &Path,
    owner_uid: u32,
    expected_mode: u32,
    expected_size: Option<u64>,
) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "file-unavailable")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != owner_uid
        || metadata.nlink() != 1
        || metadata.permissions().mode() & 0o777 != expected_mode
        || metadata.len() == 0
        || expected_size.is_some_and(|size| metadata.len() != size)
    {
        return Err(format!("file-metadata-rejected:{}", path.display()));
    }
    Ok(())
}

fn validate_bounded_regular_file(
    path: &Path,
    owner_uid: u32,
    expected_mode: u32,
    maximum_size: u64,
) -> Result<(), String> {
    validate_regular_file(path, owner_uid, expected_mode, None)?;
    if fs::symlink_metadata(path)
        .map_err(|_| "file-unavailable")?
        .len()
        > maximum_size
    {
        return Err(format!("file-size-rejected:{}", path.display()));
    }
    Ok(())
}

fn read_bounded_file(path: &Path, maximum_size: u64, error: &str) -> Result<Vec<u8>, String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(maximum_size + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error.to_string())?;
    if bytes.len() as u64 > maximum_size {
        return Err(format!("{error}-size-rejected"));
    }
    Ok(bytes)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "file-digest-unavailable")?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "file-digest-unavailable")?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn package_file<'a>(package: &'a VerifiedPackage, role: &str) -> Result<&'a PackageFile, String> {
    package
        .manifest
        .files
        .iter()
        .find(|file| file.role == role)
        .ok_or_else(|| format!("package-role-missing:{role}"))
}

fn validate_package_controller_binding(
    package: &VerifiedPackage,
    expected_sha256: &str,
    expected_size: u64,
) -> Result<(), String> {
    let controller = package_file(package, "controller")?;
    if !valid_digest(expected_sha256)
        || controller.path != CONTROLLER_RELATIVE_PATH
        || controller.sha256 != expected_sha256
        || controller.size != expected_size
    {
        return Err("package-controller-binding-mismatch".into());
    }
    Ok(())
}

fn validate_privileged_controller_runtime(
    expected_sha256: &str,
    expected_size: u64,
) -> Result<(), String> {
    if !valid_digest(expected_sha256)
        || expected_size == 0
        || expected_size > PACKAGE_FILE_MAX_BYTES
    {
        return Err("privileged-controller-binding-invalid".into());
    }
    let executable = env::current_exe().map_err(|_| "privileged-controller-path-unavailable")?;
    let executable =
        fs::canonicalize(&executable).map_err(|_| "privileged-controller-path-unavailable")?;
    let parent = executable
        .parent()
        .ok_or_else(|| "privileged-controller-parent-invalid".to_string())?;
    let parent_text = parent
        .to_str()
        .ok_or_else(|| "privileged-controller-parent-invalid".to_string())?;
    if !parent_text.starts_with(PRIVILEGED_CONTROLLER_ROOT_PREFIX)
        || executable.file_name().and_then(|value| value.to_str())
            != Some("mish-internal-tun-alpha-ctl")
    {
        return Err("privileged-controller-path-rejected".into());
    }
    validate_root_directory(parent, 0o700)?;
    validate_regular_file(&executable, 0, 0o500, Some(expected_size))?;
    if fs::symlink_metadata(&executable)
        .map_err(|_| "privileged-controller-metadata-unavailable")?
        .gid()
        != 0
        || sha256_file(&executable)? != expected_sha256
    {
        return Err("privileged-controller-binding-mismatch".into());
    }
    Ok(())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn replace_once(source: String, placeholder: &str, value: &str) -> Result<String, String> {
    if source.matches(placeholder).count() != 1 {
        return Err("launch-daemon-template-placeholder-invalid".into());
    }
    Ok(source.replacen(placeholder, value, 1))
}

fn render_plist_inputs(
    package: &VerifiedPackage,
    uid: u32,
    home: &Path,
) -> Result<(String, String), String> {
    let template = fs::read_to_string(package.root.join(PLIST_TEMPLATE_RELATIVE_PATH))
        .map_err(|_| "launch-daemon-template-unavailable")?;
    if !template.contains("<key>MISH_TUN_SERVICE_ALLOW_TUN</key><string>1</string>")
        || !template.contains(DEV_TUN_SERVICE_CORE_PATH)
        || !template.contains(DEV_TUN_SERVICE_HELPER_PATH)
        || !template.contains(DEV_TUN_SERVICE_ENROLLMENT_PATH)
        || !template.contains(DEV_TUN_SERVICE_LABEL)
    {
        return Err("launch-daemon-template-policy-invalid".into());
    }
    let runtime = runtime_root(home);
    let socket = format!("/var/run/com.asuka109.mish.tun-helper.{uid}.sock");
    let rendered = replace_once(template, UID_PLACEHOLDER, &uid.to_string())?;
    let rendered = replace_once(
        rendered,
        RUNTIME_ROOT_PLACEHOLDER,
        &xml_escape(
            runtime
                .to_str()
                .ok_or_else(|| "runtime-root-encoding-invalid".to_string())?,
        ),
    )?;
    let rendered = replace_once(rendered, SOCKET_PLACEHOLDER, &socket)?;
    if rendered.matches(INSTALLATION_ID_PLACEHOLDER).count() != 1 {
        return Err("launch-daemon-template-installation-id-invalid".into());
    }
    let mut digest = Sha256::new();
    digest.update(
        fs::read(package.root.join(HELPER_RELATIVE_PATH))
            .map_err(|_| "helper-artifact-unavailable")?,
    );
    digest.update(
        fs::read(package.root.join(CORE_RELATIVE_PATH)).map_err(|_| "core-artifact-unavailable")?,
    );
    digest.update(rendered.as_bytes());
    let installation_id = format!("{:x}", digest.finalize());
    let final_plist = replace_once(rendered, INSTALLATION_ID_PLACEHOLDER, &installation_id)?;
    if final_plist.contains("__MISH_") {
        return Err("launch-daemon-template-unresolved".into());
    }
    Ok((installation_id, final_plist))
}

fn ensure_private_directory(path: &Path, uid: u32) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => validate_directory(path, uid, true)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| "private-runtime-parent-invalid".to_string())?;
            validate_directory(parent, uid, true)?;
            fs::create_dir(path).map_err(|_| "private-runtime-create-failed")?;
        }
        Err(_) => return Err("private-runtime-unavailable".into()),
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|_| "private-runtime-permissions-failed")?;
    validate_directory(path, uid, true)
}

fn ensure_private_runtime(home: &Path, uid: u32) -> Result<PathBuf, String> {
    validate_user_home(home, uid)?;
    let mut current = home.to_path_buf();
    for component in [
        "Library",
        "Application Support",
        "com.asuka109.mish",
        "runtime",
    ] {
        current.push(component);
        ensure_private_directory(&current, uid)?;
    }
    Ok(current)
}

fn write_private_file(path: &Path, bytes: &[u8], uid: u32) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "private-file-parent-invalid".to_string())?;
    validate_directory(parent, uid, true)?;
    let temporary = parent.join(format!(
        ".{}.{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "private-file-name-invalid".to_string())?,
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|_| "private-file-create-failed")?;
        file.write_all(bytes)
            .map_err(|_| "private-file-write-failed")?;
        file.sync_all().map_err(|_| "private-file-sync-failed")?;
        fs::rename(&temporary, path).map_err(|_| "private-file-commit-failed")?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn stage_privileged_controller(
    package: &VerifiedPackage,
    installer: &Path,
    uid: u32,
) -> Result<StagedPrivilegedController, String> {
    let controller = package_file(package, "controller")?;
    let source = package.root.join(CONTROLLER_RELATIVE_PATH);
    let destination = installer.join(PRIVILEGED_CONTROLLER_STAGE_NAME);
    let temporary = installer.join(format!(
        ".{PRIVILEGED_CONTROLLER_STAGE_NAME}.{}",
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut input = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&source)
            .map_err(|_| "privileged-controller-source-unavailable")?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o500)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|_| "privileged-controller-stage-create-failed")?;
        let copied = std::io::copy(&mut input, &mut output)
            .map_err(|_| "privileged-controller-stage-copy-failed")?;
        if copied != controller.size {
            return Err("privileged-controller-stage-size-mismatch".into());
        }
        output
            .sync_all()
            .map_err(|_| "privileged-controller-stage-sync-failed")?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o500))
            .map_err(|_| "privileged-controller-stage-permissions-failed")?;
        validate_regular_file(&temporary, uid, 0o500, Some(controller.size))?;
        if sha256_file(&temporary)? != controller.sha256 {
            return Err("privileged-controller-stage-digest-mismatch".into());
        }
        fs::rename(&temporary, &destination)
            .map_err(|_| "privileged-controller-stage-commit-failed")?;
        sync_parent(&destination)?;
        let staged = StagedPrivilegedController {
            path: destination,
            sha256: controller.sha256.clone(),
            size: controller.size,
        };
        validate_staged_privileged_controller(&staged, uid)?;
        Ok(staged)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_staged_privileged_controller(
    controller: &StagedPrivilegedController,
    uid: u32,
) -> Result<(), String> {
    validate_regular_file(&controller.path, uid, 0o500, Some(controller.size))?;
    if !valid_digest(&controller.sha256) || sha256_file(&controller.path)? != controller.sha256 {
        return Err("privileged-controller-stage-digest-mismatch".into());
    }
    Ok(())
}

async fn retry_post_install_health<F, Fut>(
    mut health_probe: F,
    attempts: usize,
    retry_delay: Duration,
) -> Result<serde_json::Value, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<serde_json::Value, String>>,
{
    if attempts == 0 {
        return Err("post-install-health-attempts-invalid".into());
    }
    for attempt in 0..attempts {
        match health_probe().await {
            Ok(value) => return Ok(value),
            Err(error)
                if error == "core-host-unavailable" && attempt.saturating_add(1) < attempts =>
            {
                tokio::time::sleep(retry_delay).await;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("the bounded post-install health loop always returns")
}

async fn install_or_repair(
    action: UserAction,
    package: &VerifiedPackage,
    uid: u32,
    gid: u32,
    home: &Path,
    tart_terminal_authorization: bool,
) -> Result<serde_json::Value, String> {
    run_package_lifecycle(action, package, uid, gid, home, tart_terminal_authorization).await
}

#[derive(Clone)]
struct PreparedPackageLifecycle {
    installation_id: Option<String>,
    plist: Option<String>,
    privileged_controller: StagedPrivilegedController,
    runtime: PathBuf,
}

struct PackageLifecycleExecutor {
    action: UserAction,
    gid: u32,
    home: PathBuf,
    package: VerifiedPackage,
    prepared: Arc<Mutex<Option<PreparedPackageLifecycle>>>,
    tart_terminal_authorization: bool,
    uid: u32,
}

impl EffectExecutor<PackageMachine> for PackageLifecycleExecutor {
    fn execute(
        &self,
        effect: PackageEffect,
        _cancellation: tokio_util::sync::CancellationToken,
    ) -> Pin<Box<dyn Future<Output = PackageInput> + Send + 'static>> {
        let action = self.action;
        let gid = self.gid;
        let home = self.home.clone();
        let package = self.package.clone();
        let prepared = self.prepared.clone();
        let tart_terminal_authorization = self.tart_terminal_authorization;
        let uid = self.uid;
        Box::pin(async move {
            let correlation = mish_state_machine::CorrelatedEffect::correlation(&effect).clone();
            let outcome = match effect {
                PackageEffect::Stage { .. } => {
                    match prepare_package_lifecycle(action, &package, uid, &home) {
                        Ok(value) => {
                            *prepared.lock().expect("package preparation lock poisoned") =
                                Some(value);
                            PackageEffectOutcome::Staged
                        }
                        Err(error) => PackageEffectOutcome::Failed(package_failure(error)),
                    }
                }
                PackageEffect::Authorize { .. } => {
                    let prepared = prepared
                        .lock()
                        .expect("package preparation lock poisoned")
                        .clone();
                    match prepared {
                        Some(prepared) => {
                            let privileged_action = if action == UserAction::Uninstall {
                                "__privileged-uninstall"
                            } else {
                                "__privileged-install"
                            };
                            match run_authorized(
                                privileged_action,
                                &package,
                                &prepared.privileged_controller,
                                uid,
                                gid,
                                &home,
                                tart_terminal_authorization,
                            ) {
                                Ok(()) => PackageEffectOutcome::Authorized,
                                Err(error) => {
                                    let _ = cleanup_installer_files(&installer_root(&home), uid);
                                    PackageEffectOutcome::Failed(package_failure(error))
                                }
                            }
                        }
                        None => PackageEffectOutcome::Failed(PackageFailure::recovery_required(
                            "package-preparation-missing",
                        )),
                    }
                }
                PackageEffect::CommitReceipt { .. } => {
                    let prepared = prepared
                        .lock()
                        .expect("package preparation lock poisoned")
                        .clone();
                    match prepared
                        .ok_or_else(|| "package-preparation-missing".to_string())
                        .and_then(|prepared| {
                            commit_local_installation_receipt(&package, uid, &home, &prepared)
                        }) {
                        Ok(()) => PackageEffectOutcome::ReceiptCommitted,
                        Err(error) => PackageEffectOutcome::Failed(PackageFailure::clean(format!(
                            "post-install-receipt-failed:{error}"
                        ))),
                    }
                }
                PackageEffect::AwaitReady { .. } => {
                    match retry_post_install_health(
                        || health(&package, uid, &home),
                        POST_INSTALL_HEALTH_ATTEMPTS,
                        POST_INSTALL_HEALTH_RETRY_DELAY,
                    )
                    .await
                    {
                        Ok(value) => match package_success(&value) {
                            Ok(success) => PackageEffectOutcome::Ready(success),
                            Err(error) => {
                                PackageEffectOutcome::Failed(PackageFailure::clean(error))
                            }
                        },
                        Err(error) => PackageEffectOutcome::Failed(PackageFailure::clean(format!(
                            "post-install-health-failed:{error}"
                        ))),
                    }
                }
                PackageEffect::Verify { .. } => match health(&package, uid, &home).await {
                    Ok(value) => match package_success(&value) {
                        Ok(success) => {
                            let cleanup = cleanup_installer_files(&installer_root(&home), uid);
                            match cleanup {
                                Ok(()) => PackageEffectOutcome::Verified(success),
                                Err(error) => PackageEffectOutcome::Failed(
                                    PackageFailure::recovery_required(error),
                                ),
                            }
                        }
                        Err(error) => PackageEffectOutcome::Failed(PackageFailure::clean(error)),
                    },
                    Err(error) => PackageEffectOutcome::Failed(PackageFailure::clean(format!(
                        "post-install-verification-failed:{error}"
                    ))),
                },
                PackageEffect::Rollback { .. } => {
                    let prepared = prepared
                        .lock()
                        .expect("package preparation lock poisoned")
                        .clone();
                    match prepared {
                        Some(prepared)
                            if run_authorized(
                                "__privileged-uninstall",
                                &package,
                                &prepared.privileged_controller,
                                uid,
                                gid,
                                &home,
                                tart_terminal_authorization,
                            )
                            .is_ok()
                                && remove_user_installation_state(&home, uid).is_ok()
                                && cleanup_installer_files(&installer_root(&home), uid).is_ok() =>
                        {
                            PackageEffectOutcome::RolledBack
                        }
                        _ => PackageEffectOutcome::Failed(PackageFailure::recovery_required(
                            "cleanup-unconfirmed",
                        )),
                    }
                }
                PackageEffect::FinalizeUninstall { .. } => {
                    let prepared = prepared
                        .lock()
                        .expect("package preparation lock poisoned")
                        .clone();
                    match prepared {
                        Some(prepared)
                            if remove_user_installation_state(&home, uid).is_ok()
                                && cleanup_installer_files(&installer_root(&home), uid).is_ok()
                                && validate_directory(&prepared.runtime, uid, true).is_ok() =>
                        {
                            PackageEffectOutcome::UninstallFinalized
                        }
                        _ => PackageEffectOutcome::Failed(PackageFailure::recovery_required(
                            "uninstall-finalization-failed",
                        )),
                    }
                }
            };
            PackageInput::EffectCompleted {
                correlation,
                outcome,
            }
        })
    }
}

fn prepare_package_lifecycle(
    action: UserAction,
    package: &VerifiedPackage,
    uid: u32,
    home: &Path,
) -> Result<PreparedPackageLifecycle, String> {
    let runtime = ensure_private_runtime(home, uid)?;
    let installer = installer_root(home);
    ensure_private_directory(&installer, uid)?;
    let privileged_controller = stage_privileged_controller(package, &installer, uid)?;
    if action == UserAction::Uninstall {
        return Ok(PreparedPackageLifecycle {
            installation_id: None,
            plist: None,
            privileged_controller,
            runtime,
        });
    }
    let (installation_id, plist) = render_plist_inputs(package, uid, home)?;
    let candidate_path = installer.join("enrollment.json");
    let key_store = InstallationClientKeyStore::for_runtime_root(&runtime, uid);
    key_store
        .write_public_candidate(&candidate_path, &installation_id)
        .map_err(|_| "installation-key-preparation-failed")?;
    write_private_file(
        &installer.join("launch-daemon.plist"),
        plist.as_bytes(),
        uid,
    )?;
    Ok(PreparedPackageLifecycle {
        installation_id: Some(installation_id),
        plist: Some(plist),
        privileged_controller,
        runtime,
    })
}

fn commit_local_installation_receipt(
    package: &VerifiedPackage,
    uid: u32,
    home: &Path,
    prepared: &PreparedPackageLifecycle,
) -> Result<(), String> {
    let installation_id = prepared
        .installation_id
        .as_deref()
        .ok_or_else(|| "installation-id-missing".to_string())?;
    let plist = prepared
        .plist
        .as_deref()
        .ok_or_else(|| "installation-plist-missing".to_string())?;
    let root_receipt = read_receipt(Path::new(ROOT_RECEIPT_PATH), 0, 0o444)?;
    validate_receipt(
        &root_receipt,
        package,
        uid,
        installation_id,
        &sha256_bytes(plist.as_bytes()),
    )?;
    let receipt_bytes = serde_json::to_vec(&root_receipt).map_err(|_| "user-receipt-invalid")?;
    write_private_file(&user_receipt_path(home), &receipt_bytes, uid)
}

fn package_success(value: &serde_json::Value) -> Result<PackageSuccess, String> {
    Ok(PackageSuccess {
        generation: value["generation"]
            .as_u64()
            .filter(|value| *value > 0)
            .ok_or_else(|| "installed-health-generation-invalid".to_string())?,
        installation_id: value["installationId"]
            .as_str()
            .filter(|value| valid_digest(value))
            .ok_or_else(|| "installed-health-identity-invalid".to_string())?
            .to_owned(),
        key_id: value["keyId"]
            .as_str()
            .filter(|value| valid_digest(value))
            .ok_or_else(|| "installed-health-key-invalid".to_string())?
            .to_owned(),
    })
}

fn package_failure(error: String) -> PackageFailure {
    if error.contains("cleanup-unconfirmed")
        || error.contains("incomplete")
        || error.contains("authorization-rejected")
    {
        PackageFailure::recovery_required(error)
    } else {
        PackageFailure::clean(error)
    }
}

async fn run_package_lifecycle(
    action: UserAction,
    package: &VerifiedPackage,
    uid: u32,
    gid: u32,
    home: &Path,
    tart_terminal_authorization: bool,
) -> Result<serde_json::Value, String> {
    let observed = observed_package_state(package, uid)?;
    let kind = match action {
        UserAction::Install => PackageOperationKind::Install,
        UserAction::Repair => PackageOperationKind::Repair,
        UserAction::Uninstall => PackageOperationKind::Uninstall,
        UserAction::Health | UserAction::Status => {
            return Err("unsupported-lifecycle-action".into());
        }
    };
    let operation_name = match kind {
        PackageOperationKind::Install => "install",
        PackageOperationKind::Repair => "repair",
        PackageOperationKind::Uninstall => "uninstall",
    };
    let runner = spawn_runner(
        Arc::new(PackageMachine),
        PackageState::initial(observed),
        Arc::new(PackageLifecycleExecutor {
            action,
            gid,
            home: home.to_path_buf(),
            package: package.clone(),
            prepared: Arc::new(Mutex::new(None)),
            tart_terminal_authorization,
            uid,
        }),
        Arc::new(NoopObserver),
        RunnerConfig::default(),
    );
    let operation = PackageOperation {
        correlation: Correlation {
            machine_authority: format!("internal-tun-package:{}", package.manifest_digest),
            scope_epoch: 1,
            operation_id: Uuid::new_v4().to_string(),
            admitted_revision: 1,
            effect_id: 0,
        },
        initial: observed,
        kind,
    };
    runner
        .admit(PackageInput::Begin(operation))
        .await
        .map_err(|_| "package-lifecycle-busy".to_string())?;
    let projection = loop {
        match runner.snapshot().projection() {
            PackageProjection::InFlight { .. } => tokio::task::yield_now().await,
            projection => break projection,
        }
    };
    let result = match projection {
        PackageProjection::HealthyDisabled(success) => Ok(json!({
            "generation": success.generation,
            "installationId": success.installation_id,
            "keyId": success.key_id,
            "ok": true,
            "operation": operation_name,
            "profile": PROFILE,
            "state": "healthy-disabled",
        })),
        PackageProjection::Absent => Ok(json!({
            "ok": true,
            "profile": PROFILE,
            "service": "not-installed",
        })),
        PackageProjection::Failed(failure) => Err(failure.code),
        PackageProjection::Retired => Err("package-lifecycle-retired".into()),
        PackageProjection::InFlight { .. } => unreachable!("loop exits only for terminal states"),
    };
    let _ = runner.shutdown().await;
    result
}

fn observed_package_state(
    package: &VerifiedPackage,
    uid: u32,
) -> Result<ObservedPackageState, String> {
    let value = status(package, uid)?;
    match value["service"].as_str() {
        Some("not-installed") => Ok(ObservedPackageState::Absent),
        Some("installed") => Ok(ObservedPackageState::HealthyDisabled),
        Some("repair-required") => Ok(ObservedPackageState::RepairRequired),
        _ => Err("package-observation-invalid".into()),
    }
}

fn run_authorized(
    privileged_action: &str,
    package: &VerifiedPackage,
    controller: &StagedPrivilegedController,
    uid: u32,
    gid: u32,
    home: &Path,
    tart_terminal_authorization: bool,
) -> Result<(), String> {
    validate_staged_privileged_controller(controller, uid)?;
    validate_package_controller_binding(package, &controller.sha256, controller.size)?;
    let script =
        privileged_controller_script(privileged_action, package, controller, uid, gid, home)?;
    if tart_terminal_authorization {
        let status = Command::new("/usr/bin/sudo")
            .args(["/bin/sh", "-c", &script])
            .status()
            .map_err(|_| "terminal-administrator-authorization-unavailable")?;
        return status
            .success()
            .then_some(())
            .ok_or_else(|| "terminal-administrator-authorization-failed".into());
    }
    let output = Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "try",
            "-e",
            "set commandOutput to do shell script (item 1 of argv) with administrator privileges",
            "-e",
            "return \"ok:\" & commandOutput",
            "-e",
            "on error errorMessage number errorNumber",
            "-e",
            "return \"error:\" & (errorNumber as string)",
            "-e",
            "end try",
            "-e",
            "end run",
            "--",
            &script,
        ])
        .output()
        .map_err(|_| "administrator-authorization-unavailable")?;
    let response = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err("administrator-authorization-failed".into());
    }
    if response == "error:-128" {
        return Err("administrator-authorization-cancelled".into());
    }
    if response.starts_with("ok:") {
        return Ok(());
    }
    Err("privileged-lifecycle-failed".into())
}

fn privileged_controller_script(
    privileged_action: &str,
    package: &VerifiedPackage,
    controller: &StagedPrivilegedController,
    uid: u32,
    gid: u32,
    home: &Path,
) -> Result<String, String> {
    if privileged_action != "__privileged-install" && privileged_action != "__privileged-uninstall"
    {
        return Err("privileged-lifecycle-action-rejected".into());
    }
    if !valid_digest(&controller.sha256)
        || controller.size == 0
        || controller.size > PACKAGE_FILE_MAX_BYTES
    {
        return Err("privileged-controller-binding-invalid".into());
    }
    let staged_path = controller
        .path
        .to_str()
        .ok_or_else(|| "controller-path-invalid".to_string())?;
    let package_root = package
        .root
        .to_str()
        .ok_or_else(|| "package-root-invalid".to_string())?;
    let home = home
        .to_str()
        .ok_or_else(|| "installing-user-home-invalid".to_string())?;
    let invocation = [
        "\"$ROOT_CONTROLLER\"".to_string(),
        quote_shell(privileged_action),
        quote_shell(package_root),
        quote_shell(&uid.to_string()),
        quote_shell(&gid.to_string()),
        quote_shell(home),
        quote_shell(&controller.sha256),
        quote_shell(&controller.size.to_string()),
    ]
    .join(" ");
    Ok(format!(
        "set -eu\n\
umask 077\n\
PIN_SOURCE={}\n\
EXPECTED_SHA256={}\n\
EXPECTED_SIZE={}\n\
EXPECTED_UID={}\n\
EXPECTED_GID={}\n\
PIN_ROOT=''\n\
ROOT_CONTROLLER=''\n\
cleanup_pin() {{\n\
  if [ -n \"$ROOT_CONTROLLER\" ]; then /bin/rm -f \"$ROOT_CONTROLLER\"; fi\n\
  if [ -n \"$PIN_ROOT\" ]; then /bin/rmdir \"$PIN_ROOT\"; fi\n\
}}\n\
trap cleanup_pin EXIT HUP INT TERM\n\
PIN_ROOT=$(/usr/bin/mktemp -d '{}XXXXXX')\n\
ROOT_CONTROLLER=\"$PIN_ROOT/mish-internal-tun-alpha-ctl\"\n\
PIN_SOURCE_METADATA=$(/usr/bin/stat -f '%u:%g:%Lp:%l:%z' \"$PIN_SOURCE\")\n\
[ \"$PIN_SOURCE_METADATA\" = \"$EXPECTED_UID:$EXPECTED_GID:500:1:$EXPECTED_SIZE\" ] || exit 70\n\
/bin/cp -X \"$PIN_SOURCE\" \"$ROOT_CONTROLLER\"\n\
/bin/chmod 0500 \"$ROOT_CONTROLLER\"\n\
PIN_METADATA=$(/usr/bin/stat -f '%u:%g:%Lp:%l:%z' \"$ROOT_CONTROLLER\")\n\
[ \"$PIN_METADATA\" = \"0:0:500:1:$EXPECTED_SIZE\" ] || exit 71\n\
PIN_DIGEST=$(/usr/bin/shasum -a 256 \"$ROOT_CONTROLLER\" | /usr/bin/awk '{{print $1}}')\n\
[ \"$PIN_DIGEST\" = \"$EXPECTED_SHA256\" ] || exit 72\n\
{}\n",
        quote_shell(staged_path),
        quote_shell(&controller.sha256),
        quote_shell(&controller.size.to_string()),
        quote_shell(&uid.to_string()),
        quote_shell(&gid.to_string()),
        PRIVILEGED_CONTROLLER_ROOT_PREFIX,
        invocation
    ))
}

fn quote_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn privileged_install(
    package: &VerifiedPackage,
    uid: u32,
    _gid: u32,
    home: &Path,
) -> Result<serde_json::Value, String> {
    let runtime = runtime_root(home);
    validate_directory(&runtime, uid, true)?;
    let installer = installer_root(home);
    validate_directory(&installer, uid, true)?;
    let candidate_path = installer.join("enrollment.json");
    validate_bounded_regular_file(&candidate_path, uid, 0o600, INSTALLER_FILE_MAX_BYTES)?;
    let plist_source = installer.join("launch-daemon.plist");
    validate_bounded_regular_file(&plist_source, uid, 0o600, INSTALLER_FILE_MAX_BYTES)?;
    let (installation_id, expected_plist) = render_plist_inputs(package, uid, home)?;
    if read_bounded_file(
        &plist_source,
        INSTALLER_FILE_MAX_BYTES,
        "staged-plist-unavailable",
    )? != expected_plist.as_bytes()
    {
        return Err("staged-plist-mismatch".into());
    }
    validate_existing_installation_owner(uid)?;

    let _ = command_output(
        "/bin/launchctl",
        &["bootout", &format!("system/{DEV_TUN_SERVICE_LABEL}")],
    );
    ensure_root_directory(Path::new("/Library/PrivilegedHelperTools"), 0o755)?;
    ensure_root_directory(Path::new("/Library/LaunchDaemons"), 0o755)?;
    ensure_root_directory(
        Path::new("/Library/Application Support/com.asuka109.mish"),
        0o755,
    )?;
    ensure_root_directory(
        Path::new(
            DEV_TUN_SERVICE_ENROLLMENT_PATH
                .rsplit_once('/')
                .ok_or_else(|| "enrollment-parent-invalid".to_string())?
                .0,
        ),
        0o700,
    )?;
    ensure_root_directory(Path::new(ROOT_RECEIPT_DIRECTORY), 0o755)?;

    let install_result = (|| {
        install_atomic(
            &package.root.join(HELPER_RELATIVE_PATH),
            Path::new(DEV_TUN_SERVICE_HELPER_PATH),
            0o555,
            &package_file(package, "helper")?.sha256,
        )?;
        install_atomic(
            &package.root.join(CORE_RELATIVE_PATH),
            Path::new(DEV_TUN_SERVICE_CORE_PATH),
            0o555,
            &package_file(package, "core")?.sha256,
        )?;
        install_atomic(
            &plist_source,
            Path::new(DEV_TUN_SERVICE_PLIST_PATH),
            0o644,
            &sha256_bytes(expected_plist.as_bytes()),
        )?;
        verify_core_version(
            Path::new(DEV_TUN_SERVICE_CORE_PATH),
            &package.manifest.core_version,
        )?;
        let enrollment = apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Enroll,
            std::slice::from_ref(&candidate_path),
            Path::new(DEV_TUN_SERVICE_ENROLLMENT_PATH),
            &installation_id,
            uid,
            true,
        )
        .map_err(|_| "installation-enrollment-failed")?;
        let receipt = InstallationReceipt {
            core_sha256: package_file(package, "core")?.sha256.clone(),
            core_version: package.manifest.core_version.clone(),
            generation: enrollment.generation,
            helper_sha256: package_file(package, "helper")?.sha256.clone(),
            helper_version: package.manifest.helper_version.clone(),
            installation_id: installation_id.clone(),
            key_id: enrollment.key_id,
            manifest_sha256: package.manifest_digest.clone(),
            package_version: package.manifest.package_version.clone(),
            plist_sha256: sha256_bytes(expected_plist.as_bytes()),
            profile: PROFILE.into(),
            protocol_version: PROTOCOL_VERSION,
            schema_version: 1,
            installing_uid: uid,
        };
        write_root_receipt(&receipt)?;
        require_command_success(
            "/bin/launchctl",
            &["bootstrap", "system", DEV_TUN_SERVICE_PLIST_PATH],
            "launch-daemon-bootstrap-failed",
        )?;
        require_command_success(
            "/bin/launchctl",
            &["kickstart", &format!("system/{DEV_TUN_SERVICE_LABEL}")],
            "launch-daemon-start-failed",
        )?;
        Ok(receipt)
    })();

    let receipt = match install_result {
        Ok(receipt) => receipt,
        Err(error) => {
            if privileged_cleanup(uid).is_err() {
                return Err("failed-installation-cleanup-unconfirmed".into());
            }
            return Err(error);
        }
    };
    Ok(json!({
        "generation": receipt.generation,
        "installationId": receipt.installation_id,
        "keyId": receipt.key_id,
        "ok": true,
    }))
}

fn validate_existing_installation_owner(uid: u32) -> Result<(), String> {
    let enrollment = read_optional_enrollment(uid)?;
    let receipt = read_optional_root_receipt()?;
    if let Some(enrollment) = enrollment.as_ref()
        && enrollment.installing_uid != uid
    {
        return Err("existing-installation-owner-rejected".into());
    }
    if let Some(receipt) = receipt.as_ref()
        && (receipt.schema_version != 1
            || receipt.profile != PROFILE
            || receipt.installing_uid != uid)
    {
        return Err("existing-installation-owner-rejected".into());
    }
    if let (Some(enrollment), Some(receipt)) = (enrollment.as_ref(), receipt.as_ref()) {
        validate_enrollment_receipt_identity(uid, enrollment, receipt)?;
    }
    Ok(())
}

fn read_optional_enrollment(uid: u32) -> Result<Option<InstallationEnrollmentRecord>, String> {
    match fs::symlink_metadata(DEV_TUN_SERVICE_ENROLLMENT_PATH) {
        Ok(_) => load_installation_enrollment_for_user(
            Path::new(DEV_TUN_SERVICE_ENROLLMENT_PATH),
            uid,
            true,
        )
        .map(Some)
        .map_err(|_| "existing-installation-owner-rejected".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("existing-installation-owner-unavailable".into()),
    }
}

fn read_optional_root_receipt() -> Result<Option<InstallationReceipt>, String> {
    match fs::symlink_metadata(ROOT_RECEIPT_PATH) {
        Ok(_) => read_receipt(Path::new(ROOT_RECEIPT_PATH), 0, 0o444).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("existing-installation-owner-unavailable".into()),
    }
}

fn validate_enrollment_receipt_identity(
    uid: u32,
    enrollment: &InstallationEnrollmentRecord,
    receipt: &InstallationReceipt,
) -> Result<(), String> {
    if enrollment.installing_uid != uid
        || receipt.installing_uid != uid
        || receipt.schema_version != 1
        || receipt.profile != PROFILE
        || enrollment.helper_installation_id != receipt.installation_id
        || enrollment.key_id != receipt.key_id
        || enrollment.generation != receipt.generation
    {
        return Err("existing-installation-owner-rejected".into());
    }
    Ok(())
}

fn ensure_root_directory(path: &Path, mode: u32) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => validate_root_directory(path, mode)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| "root-directory-parent-invalid".to_string())?;
            let parent_metadata =
                fs::symlink_metadata(parent).map_err(|_| "root-directory-parent-unavailable")?;
            if parent_metadata.file_type().is_symlink()
                || !parent_metadata.is_dir()
                || parent_metadata.uid() != 0
                || parent_metadata.permissions().mode() & 0o022 != 0
                || fs::canonicalize(parent).map_err(|_| "root-directory-parent-unavailable")?
                    != parent
            {
                return Err("root-directory-parent-metadata-rejected".into());
            }
            fs::create_dir(path).map_err(|_| "root-directory-create-failed")?;
        }
        Err(_) => return Err("root-directory-unavailable".into()),
    }
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|_| "root-directory-permissions-failed")?;
    chown_root(path)?;
    validate_root_directory(path, mode)
}

fn validate_root_directory(path: &Path, mode: u32) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "root-directory-unavailable")?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != 0
        || metadata.gid() != 0
        || metadata.permissions().mode() & 0o777 != mode
        || fs::canonicalize(path).map_err(|_| "root-directory-unavailable")? != path
    {
        return Err(format!(
            "root-directory-metadata-rejected:{}",
            path.display()
        ));
    }
    Ok(())
}

fn chown_root(path: &Path) -> Result<(), String> {
    let path =
        std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| "root-path-invalid")?;
    if unsafe { libc::chown(path.as_ptr(), 0, 0) } != 0 {
        return Err("root-ownership-update-failed".into());
    }
    Ok(())
}

fn install_atomic(source: &Path, target: &Path, mode: u32, digest: &str) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| "installed-target-parent-invalid".to_string())?;
    let temporary = parent.join(format!(
        ".{}.{}",
        target
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "installed-target-name-invalid".to_string())?,
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut input = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(source)
            .map_err(|_| "package-artifact-open-failed")?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(mode)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|_| "installed-candidate-create-failed")?;
        std::io::copy(&mut input, &mut output).map_err(|_| "installed-candidate-copy-failed")?;
        output
            .sync_all()
            .map_err(|_| "installed-candidate-sync-failed")?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))
            .map_err(|_| "installed-candidate-permissions-failed")?;
        chown_root(&temporary)?;
        validate_regular_file(&temporary, 0, mode, None)?;
        if sha256_file(&temporary)? != digest {
            return Err("installed-candidate-digest-mismatch".into());
        }
        fs::rename(&temporary, target).map_err(|_| "installed-target-commit-failed")?;
        sync_parent(target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sync_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "sync-parent-invalid".to_string())?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "sync-parent-failed".into())
}

fn verify_core_version(core: &Path, expected: &str) -> Result<(), String> {
    let output = Command::new(core)
        .arg("-v")
        .output()
        .map_err(|_| "installed-core-version-unavailable")?;
    if !output.status.success()
        || !String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .any(|value| value == expected)
    {
        return Err("installed-core-version-mismatch".into());
    }
    Ok(())
}

fn write_root_receipt(receipt: &InstallationReceipt) -> Result<(), String> {
    let bytes = serde_json::to_vec(receipt).map_err(|_| "root-receipt-invalid")?;
    let temporary = Path::new(ROOT_RECEIPT_DIRECTORY).join(format!(".receipt.{}", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o444)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&temporary)
            .map_err(|_| "root-receipt-create-failed")?;
        file.write_all(&bytes)
            .map_err(|_| "root-receipt-write-failed")?;
        file.write_all(b"\n")
            .map_err(|_| "root-receipt-write-failed")?;
        file.sync_all().map_err(|_| "root-receipt-sync-failed")?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o444))
            .map_err(|_| "root-receipt-permissions-failed")?;
        chown_root(&temporary)?;
        fs::rename(&temporary, ROOT_RECEIPT_PATH).map_err(|_| "root-receipt-commit-failed")?;
        sync_parent(Path::new(ROOT_RECEIPT_PATH))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_receipt(path: &Path, uid: u32, mode: u32) -> Result<InstallationReceipt, String> {
    const RECEIPT_MAX_BYTES: u64 = 16 * 1024;
    validate_bounded_regular_file(path, uid, mode, RECEIPT_MAX_BYTES)?;
    let bytes = read_bounded_file(path, RECEIPT_MAX_BYTES, "installation-receipt-unavailable")?;
    serde_json::from_slice(&bytes).map_err(|_| "installation-receipt-invalid".into())
}

fn validate_receipt(
    receipt: &InstallationReceipt,
    package: &VerifiedPackage,
    uid: u32,
    installation_id: &str,
    plist_digest: &str,
) -> Result<(), String> {
    if receipt.schema_version != 1
        || receipt.profile != PROFILE
        || receipt.package_version != package.manifest.package_version
        || receipt.manifest_sha256 != package.manifest_digest
        || receipt.helper_sha256 != package_file(package, "helper")?.sha256
        || receipt.core_sha256 != package_file(package, "core")?.sha256
        || receipt.plist_sha256 != plist_digest
        || receipt.helper_version != package.manifest.helper_version
        || receipt.core_version != package.manifest.core_version
        || receipt.protocol_version != PROTOCOL_VERSION
        || receipt.installing_uid != uid
        || receipt.installation_id != installation_id
        || receipt.generation == 0
        || !valid_digest(&receipt.key_id)
    {
        return Err("installation-receipt-mismatch".into());
    }
    Ok(())
}

fn verify_installed_files(
    package: &VerifiedPackage,
    uid: u32,
    home: &Path,
) -> Result<(InstallationReceipt, String), String> {
    let (installation_id, plist) = render_plist_inputs(package, uid, home)?;
    let plist_digest = sha256_bytes(plist.as_bytes());
    validate_regular_file(Path::new(DEV_TUN_SERVICE_HELPER_PATH), 0, 0o555, None)?;
    validate_regular_file(Path::new(DEV_TUN_SERVICE_CORE_PATH), 0, 0o555, None)?;
    validate_regular_file(Path::new(DEV_TUN_SERVICE_PLIST_PATH), 0, 0o644, None)?;
    if sha256_file(Path::new(DEV_TUN_SERVICE_HELPER_PATH))?
        != package_file(package, "helper")?.sha256
        || sha256_file(Path::new(DEV_TUN_SERVICE_CORE_PATH))?
            != package_file(package, "core")?.sha256
        || sha256_file(Path::new(DEV_TUN_SERVICE_PLIST_PATH))? != plist_digest
        || fs::read(Path::new(DEV_TUN_SERVICE_PLIST_PATH))
            .map_err(|_| "installed-plist-unavailable")?
            != plist.as_bytes()
    {
        return Err("installed-artifact-mismatch".into());
    }
    verify_core_version(
        Path::new(DEV_TUN_SERVICE_CORE_PATH),
        &package.manifest.core_version,
    )?;
    let root_receipt = read_receipt(Path::new(ROOT_RECEIPT_PATH), 0, 0o444)?;
    validate_receipt(&root_receipt, package, uid, &installation_id, &plist_digest)?;
    let user_receipt = read_receipt(&user_receipt_path(home), uid, 0o600)?;
    if user_receipt != root_receipt {
        return Err("user-and-root-receipts-differ".into());
    }
    Ok((root_receipt, installation_id))
}

async fn health(
    package: &VerifiedPackage,
    uid: u32,
    home: &Path,
) -> Result<serde_json::Value, String> {
    let (receipt, installation_id) = verify_installed_files(package, uid, home)?;
    let launchd = command_output(
        "/bin/launchctl",
        &["print", &format!("system/{DEV_TUN_SERVICE_LABEL}")],
    )?;
    if !launchd.status.success() {
        return Err("launch-daemon-not-running".into());
    }
    let client = MacOsTunServiceClient::development();
    let discovery = client
        .installation_discovery()
        .await
        .map_err(str::to_string)?;
    let status = client.core_host_status().await.map_err(str::to_string)?;
    if discovery.algorithm != DEV_TUN_INSTALLATION_KEY_ALGORITHM
        || discovery.protocol_version != PROTOCOL_VERSION
    {
        return Err("installed-health-protocol-mismatch".into());
    }
    if discovery.installation_id != installation_id || status.installation_id != installation_id {
        return Err("installed-health-identity-mismatch".into());
    }
    if discovery.key_id != receipt.key_id || discovery.generation != receipt.generation {
        return Err("installed-health-enrollment-mismatch".into());
    }
    if status.helper_version != package.manifest.helper_version {
        return Err("installed-health-helper-version-mismatch".into());
    }
    if status.core.is_some() {
        return Err("installed-health-core-running".into());
    }
    if !status
        .observation
        .confirms_disabled_at(tun_observation_now())
    {
        return Err("installed-health-observation-mismatch".into());
    }
    Ok(json!({
        "generation": discovery.generation,
        "helperVersion": status.helper_version,
        "installationId": installation_id,
        "keyId": discovery.key_id,
        "ok": true,
        "packageVersion": package.manifest.package_version,
        "profile": PROFILE,
        "protocolVersion": discovery.protocol_version,
        "state": "healthy-disabled",
    }))
}

fn status(package: &VerifiedPackage, uid: u32) -> Result<serde_json::Value, String> {
    let launchd = command_output(
        "/bin/launchctl",
        &["print", &format!("system/{DEV_TUN_SERVICE_LABEL}")],
    )?;
    let receipt = Path::new(ROOT_RECEIPT_PATH).exists();
    let artifacts = [
        DEV_TUN_SERVICE_HELPER_PATH,
        DEV_TUN_SERVICE_CORE_PATH,
        DEV_TUN_SERVICE_PLIST_PATH,
    ]
    .iter()
    .filter(|path| Path::new(path).exists())
    .count();
    let service = if !launchd.status.success() && !receipt && artifacts == 0 {
        "not-installed"
    } else if launchd.status.success() && receipt && artifacts == 3 {
        "installed"
    } else {
        "repair-required"
    };
    Ok(json!({
        "helperVersion": package.manifest.helper_version,
        "manifestSha256": package.manifest_digest,
        "ok": true,
        "packageVersion": package.manifest.package_version,
        "profile": PROFILE,
        "protocolVersion": package.manifest.protocol_version,
        "service": service,
        "uid": uid,
    }))
}

async fn uninstall(
    package: &VerifiedPackage,
    uid: u32,
    gid: u32,
    home: &Path,
    tart_terminal_authorization: bool,
) -> Result<serde_json::Value, String> {
    run_package_lifecycle(
        UserAction::Uninstall,
        package,
        uid,
        gid,
        home,
        tart_terminal_authorization,
    )
    .await
}

fn privileged_uninstall(
    _package: &VerifiedPackage,
    uid: u32,
    _gid: u32,
    _home: &Path,
) -> Result<serde_json::Value, String> {
    validate_uninstall_authorization(uid)?;
    privileged_cleanup(uid)?;
    let mut retained = [
        DEV_TUN_SERVICE_HELPER_PATH,
        DEV_TUN_SERVICE_CORE_PATH,
        DEV_TUN_SERVICE_PLIST_PATH,
        DEV_TUN_SERVICE_ENROLLMENT_PATH,
        ROOT_RECEIPT_PATH,
    ]
    .iter()
    .any(|path| Path::new(path).exists());
    let socket = format!("/var/run/com.asuka109.mish.tun-helper.{uid}.sock");
    retained |= Path::new(&socket).exists() || Path::new(&format!("{socket}.state")).exists();
    if retained {
        return Err("privileged-uninstall-incomplete".into());
    }
    Ok(json!({ "ok": true }))
}

fn validate_uninstall_authorization(uid: u32) -> Result<(), String> {
    let enrollment = read_optional_enrollment(uid)?;
    let receipt = read_optional_root_receipt()?;
    let global_artifacts_present = global_installation_artifacts_present(uid)?;
    validate_uninstall_authorization_state(
        uid,
        enrollment.as_ref(),
        receipt.as_ref(),
        global_artifacts_present,
    )
}

fn validate_uninstall_authorization_state(
    uid: u32,
    enrollment: Option<&InstallationEnrollmentRecord>,
    receipt: Option<&InstallationReceipt>,
    global_artifacts_present: bool,
) -> Result<(), String> {
    match (enrollment, receipt) {
        (Some(enrollment), Some(receipt)) => {
            validate_enrollment_receipt_identity(uid, enrollment, receipt)
        }
        (None, None) if !global_artifacts_present => Ok(()),
        _ => Err("uninstall-authorization-rejected".into()),
    }
}

fn global_installation_artifacts_present(uid: u32) -> Result<bool, String> {
    if [
        DEV_TUN_SERVICE_HELPER_PATH,
        DEV_TUN_SERVICE_CORE_PATH,
        DEV_TUN_SERVICE_PLIST_PATH,
        ROOT_RECEIPT_DIRECTORY,
    ]
    .iter()
    .any(|path| fs::symlink_metadata(path).is_ok())
    {
        return Ok(true);
    }
    let socket = format!("/var/run/com.asuka109.mish.tun-helper.{uid}.sock");
    if fs::symlink_metadata(&socket).is_ok()
        || fs::symlink_metadata(format!("{socket}.state")).is_ok()
    {
        return Ok(true);
    }
    let launchd = command_output(
        "/bin/launchctl",
        &["print", &format!("system/{DEV_TUN_SERVICE_LABEL}")],
    )?;
    Ok(launchd.status.success())
}

fn privileged_cleanup(uid: u32) -> Result<(), String> {
    let _ = command_output(
        "/bin/launchctl",
        &["bootout", &format!("system/{DEV_TUN_SERVICE_LABEL}")],
    );
    remove_installation_enrollment(Path::new(DEV_TUN_SERVICE_ENROLLMENT_PATH), uid, true)
        .map_err(|_| "installation-enrollment-remove-failed")?;
    for path in [
        DEV_TUN_SERVICE_PLIST_PATH,
        DEV_TUN_SERVICE_HELPER_PATH,
        DEV_TUN_SERVICE_CORE_PATH,
        ROOT_RECEIPT_PATH,
    ] {
        remove_fixed_file(Path::new(path))?;
    }
    let socket = format!("/var/run/com.asuka109.mish.tun-helper.{uid}.sock");
    remove_service_socket(Path::new(&socket), uid)?;
    remove_sealed_state_directory(Path::new(&format!("{socket}.state")))?;
    match fs::remove_dir(ROOT_RECEIPT_DIRECTORY) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) if error.kind() == std::io::ErrorKind::DirectoryNotEmpty => {
            return Err("root-receipt-directory-not-empty".into());
        }
        Err(_) => return Err("root-receipt-directory-remove-failed".into()),
    }
    Ok(())
}

fn remove_fixed_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(path).map_err(|_| "fixed-artifact-remove-failed".into())
        }
        Ok(_) => Err("fixed-artifact-type-rejected".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("fixed-artifact-unavailable".into()),
    }
}

fn remove_service_socket(path: &Path, uid: u32) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata)
            if metadata.file_type().is_socket()
                && metadata.uid() == uid
                && metadata.permissions().mode() & 0o777 == 0o600 =>
        {
            fs::remove_file(path).map_err(|_| "service-socket-remove-failed".into())
        }
        Ok(_) => Err("service-socket-metadata-rejected".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("service-socket-unavailable".into()),
    }
}

fn remove_sealed_state_directory(path: &Path) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("sealed-state-unavailable".into()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != 0
        || metadata.permissions().mode() & 0o777 != 0o700
    {
        return Err("sealed-state-metadata-rejected".into());
    }
    let entries = fs::read_dir(path).map_err(|_| "sealed-state-unavailable")?;
    for (index, entry) in entries.enumerate() {
        if index >= 64 {
            return Err("sealed-state-entry-limit-exceeded".into());
        }
        let entry = entry.map_err(|_| "sealed-state-entry-unavailable")?;
        let candidate = entry.path();
        let name = candidate
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(|value| value.strip_suffix(".yaml"))
            .ok_or("sealed-state-entry-name-rejected")?;
        if Uuid::parse_str(name).is_err() {
            return Err("sealed-state-entry-name-rejected".into());
        }
        validate_bounded_regular_file(&candidate, 0, 0o600, SEALED_CONFIG_MAX_BYTES)?;
        fs::remove_file(&candidate).map_err(|_| "sealed-state-entry-remove-failed")?;
    }
    fs::remove_dir(path).map_err(|_| "sealed-state-remove-failed".into())
}

fn remove_private_file(path: &Path, uid: u32, mode: u32) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            validate_regular_file(path, uid, mode, None)?;
            fs::remove_file(path).map_err(|_| "private-artifact-remove-failed".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("private-artifact-unavailable".into()),
    }
}

fn remove_user_installation_state(home: &Path, uid: u32) -> Result<(), String> {
    remove_private_file(&user_receipt_path(home), uid, 0o600)?;
    remove_private_file(&runtime_root(home).join("tun-client-key.json"), uid, 0o600)?;
    remove_private_file(
        &runtime_root(home).join("tun-client-key.pending.json"),
        uid,
        0o600,
    )
}

fn cleanup_installer_files(installer: &Path, uid: u32) -> Result<(), String> {
    match fs::symlink_metadata(installer) {
        Ok(_) => {
            validate_directory(installer, uid, true)?;
            for (name, mode) in [
                ("enrollment.json", 0o600),
                ("launch-daemon.plist", 0o600),
                (PRIVILEGED_CONTROLLER_STAGE_NAME, 0o500),
            ] {
                remove_private_file(&installer.join(name), uid, mode)?;
            }
            let mut entries =
                fs::read_dir(installer).map_err(|_| "installer-directory-unavailable")?;
            if entries.next().is_some() {
                return Err("installer-directory-contains-unexpected-files".into());
            }
            fs::remove_dir(installer).map_err(|_| "installer-directory-remove-failed".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("installer-directory-unavailable".into()),
    }
}

fn command_output(executable: &str, arguments: &[&str]) -> Result<Output, String> {
    Command::new(executable)
        .args(arguments)
        .output()
        .map_err(|_| "system-command-unavailable".into())
}

fn require_command_success(
    executable: &str,
    arguments: &[&str],
    error: &str,
) -> Result<(), String> {
    let output = command_output(executable, arguments)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(error.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn controller_package(root: &Path, bytes: &[u8]) -> VerifiedPackage {
        let resources = root.join("Resources");
        fs::create_dir_all(&resources).unwrap();
        let controller = resources.join("mish-internal-tun-alpha-ctl");
        fs::write(&controller, bytes).unwrap();
        fs::set_permissions(&controller, fs::Permissions::from_mode(0o755)).unwrap();
        VerifiedPackage {
            manifest: PackageManifest {
                allow_tun: true,
                architecture: "arm64".into(),
                core_version: "v1.19.29".into(),
                developer_id_required: false,
                files: vec![PackageFile {
                    mode: 0o755,
                    path: CONTROLLER_RELATIVE_PATH.into(),
                    role: "controller".into(),
                    sha256: sha256_bytes(bytes),
                    size: bytes.len() as u64,
                }],
                helper_version: "3".into(),
                installation_identity_scheme: IDENTITY_SCHEME.into(),
                minimum_macos_version: 13,
                network_mutation_enabled: true,
                package_version: "fixture".into(),
                profile: PROFILE.into(),
                protocol_version: PROTOCOL_VERSION,
                schema_version: 1,
            },
            manifest_digest: "0".repeat(64),
            root: root.to_path_buf(),
        }
    }

    fn matching_installation_records(
        uid: u32,
    ) -> (InstallationEnrollmentRecord, InstallationReceipt) {
        let installation_id = "a".repeat(64);
        let key_id = "b".repeat(64);
        (
            InstallationEnrollmentRecord {
                algorithm: DEV_TUN_INSTALLATION_KEY_ALGORITHM.into(),
                generation: 1,
                helper_installation_id: installation_id.clone(),
                installing_uid: uid,
                key_id: key_id.clone(),
                public_key_spki: "fixture".into(),
                schema_version: 1,
            },
            InstallationReceipt {
                core_sha256: "c".repeat(64),
                core_version: "v1.19.29".into(),
                generation: 1,
                helper_sha256: "d".repeat(64),
                helper_version: "3".into(),
                installation_id,
                key_id,
                manifest_sha256: "e".repeat(64),
                package_version: "fixture".into(),
                plist_sha256: "f".repeat(64),
                profile: PROFILE.into(),
                protocol_version: PROTOCOL_VERSION,
                schema_version: 1,
                installing_uid: uid,
            },
        )
    }

    #[tokio::test]
    async fn post_install_health_retries_only_startup_unavailable() {
        let mut startup_calls = 0;
        let health = retry_post_install_health(
            || {
                startup_calls += 1;
                let attempt = startup_calls;
                async move {
                    if attempt < 3 {
                        Err("core-host-unavailable".into())
                    } else {
                        Ok(json!({ "state": "healthy-disabled" }))
                    }
                }
            },
            3,
            std::time::Duration::ZERO,
        )
        .await
        .unwrap();
        assert_eq!(startup_calls, 3);
        assert_eq!(health["state"], "healthy-disabled");

        let mut fatal_calls = 0;
        let error = retry_post_install_health(
            || {
                fatal_calls += 1;
                async { Err::<serde_json::Value, String>("core-host-protocol-mismatch".into()) }
            },
            3,
            std::time::Duration::ZERO,
        )
        .await
        .unwrap_err();
        assert_eq!(fatal_calls, 1);
        assert_eq!(error, "core-host-protocol-mismatch");
    }

    #[test]
    fn lifecycle_parser_is_closed() {
        assert_eq!(parse_user_action("install").unwrap(), UserAction::Install);
        assert_eq!(parse_user_action("repair").unwrap(), UserAction::Repair);
        assert_eq!(parse_user_action("health").unwrap(), UserAction::Health);
        assert_eq!(parse_user_action("status").unwrap(), UserAction::Status);
        assert_eq!(
            parse_user_action("uninstall").unwrap(),
            UserAction::Uninstall
        );
        for rejected in ["enable", "disable", "run", "../install", "", "production"] {
            assert!(parse_user_action(rejected).is_err());
        }
        assert!(terminal_authorization_allowed(UserAction::Install));
        assert!(terminal_authorization_allowed(UserAction::Repair));
        assert!(terminal_authorization_allowed(UserAction::Uninstall));
        assert!(!terminal_authorization_allowed(UserAction::Health));
        assert!(!terminal_authorization_allowed(UserAction::Status));
    }

    #[test]
    fn shell_quoting_does_not_expand_package_paths() {
        assert_eq!(
            quote_shell("/tmp/Mish's $package"),
            "'/tmp/Mish'\"'\"'s $package'"
        );
    }

    #[test]
    fn privileged_controller_is_pinned_and_reverified_before_root_execution() {
        let temporary = tempfile::tempdir().unwrap();
        let package_root = temporary.path().join("package");
        let installer = temporary.path().join("installer");
        fs::create_dir(&package_root).unwrap();
        fs::create_dir(&installer).unwrap();
        fs::set_permissions(&installer, fs::Permissions::from_mode(0o700)).unwrap();
        let uid = unsafe { libc::getuid() };
        let package = controller_package(&package_root, b"trusted-controller");
        let staged = stage_privileged_controller(&package, &installer, uid).unwrap();

        fs::write(
            package.root.join(CONTROLLER_RELATIVE_PATH),
            b"replacement-controller",
        )
        .unwrap();
        validate_staged_privileged_controller(&staged, uid).unwrap();
        assert_eq!(fs::read(&staged.path).unwrap(), b"trusted-controller");

        fs::set_permissions(&staged.path, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(&staged.path, b"same-user-replacement").unwrap();
        fs::set_permissions(&staged.path, fs::Permissions::from_mode(0o500)).unwrap();
        assert!(validate_staged_privileged_controller(&staged, uid).is_err());

        let staged = StagedPrivilegedController {
            path: installer.join("controller with ' quotes"),
            sha256: "a".repeat(64),
            size: 123,
        };
        let script = privileged_controller_script(
            "__privileged-install",
            &package,
            &staged,
            uid,
            20,
            Path::new("/Users/fixture"),
        )
        .unwrap();
        let copy = script.find("/bin/cp -X").unwrap();
        let digest = script.find("PIN_DIGEST=").unwrap();
        let execution = script.rfind("\"$ROOT_CONTROLLER\"").unwrap();
        assert!(copy < digest && digest < execution);
        assert!(script.contains("0:0:500:1:$EXPECTED_SIZE"));
        assert!(script.contains("exit 72"));
        assert!(!script.contains(CONTROLLER_RELATIVE_PATH));
        assert!(
            privileged_controller_script(
                "__privileged-arbitrary",
                &package,
                &staged,
                uid,
                20,
                Path::new("/Users/fixture"),
            )
            .is_err()
        );
    }

    #[test]
    fn uninstall_authorization_rejects_foreign_partial_and_unowned_global_state() {
        let uid = 501;
        let (enrollment, receipt) = matching_installation_records(uid);
        validate_uninstall_authorization_state(uid, Some(&enrollment), Some(&receipt), true)
            .unwrap();
        validate_uninstall_authorization_state(uid, None, None, false).unwrap();

        let mut foreign_enrollment = enrollment.clone();
        foreign_enrollment.installing_uid = 502;
        assert!(
            validate_uninstall_authorization_state(
                uid,
                Some(&foreign_enrollment),
                Some(&receipt),
                true,
            )
            .is_err()
        );
        assert!(
            validate_uninstall_authorization_state(uid, Some(&enrollment), None, true).is_err()
        );
        assert!(validate_uninstall_authorization_state(uid, None, Some(&receipt), true).is_err());
        assert!(validate_uninstall_authorization_state(uid, None, None, true).is_err());
    }

    #[test]
    fn failed_install_cleanup_removes_private_receipt_and_keys() {
        let temporary = tempfile::tempdir().unwrap();
        let runtime = runtime_root(temporary.path());
        fs::create_dir_all(&runtime).unwrap();
        let uid = unsafe { libc::getuid() };
        for path in [
            user_receipt_path(temporary.path()),
            runtime.join("tun-client-key.json"),
            runtime.join("tun-client-key.pending.json"),
        ] {
            fs::write(&path, b"private").unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        remove_user_installation_state(temporary.path(), uid).unwrap();
        assert!(!user_receipt_path(temporary.path()).exists());
        assert!(!runtime.join("tun-client-key.json").exists());
        assert!(!runtime.join("tun-client-key.pending.json").exists());
    }

    #[test]
    fn plist_replacement_requires_one_bounded_placeholder() {
        assert_eq!(
            replace_once("before __VALUE__ after".into(), "__VALUE__", "fixed").unwrap(),
            "before fixed after"
        );
        assert!(replace_once("missing".into(), "__VALUE__", "fixed").is_err());
        assert!(replace_once("__VALUE____VALUE__".into(), "__VALUE__", "fixed").is_err());
    }

    #[test]
    fn bounded_file_validation_accepts_smaller_records_and_rejects_oversize() {
        let temporary = tempfile::tempdir().unwrap();
        let record = temporary.path().join("record.json");
        fs::write(&record, b"bounded").unwrap();
        fs::set_permissions(&record, fs::Permissions::from_mode(0o600)).unwrap();
        let uid = unsafe { libc::getuid() };
        validate_bounded_regular_file(&record, uid, 0o600, 64).unwrap();
        assert!(validate_bounded_regular_file(&record, uid, 0o600, 6).is_err());
    }
}
