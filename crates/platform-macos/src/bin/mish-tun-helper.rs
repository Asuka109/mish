use mish_platform_macos::{
    DEV_TUN_SERVICE_ENROLLMENT_PATH, InstallationEnrollmentOperation, TunServiceConfig,
    apply_installation_enrollment_operation,
    internal_tun_maintenance::complete_internal_tun_maintenance_on_helper_startup,
    parse_watchdog_dns, recover_managed_network_record, remove_installation_enrollment,
    run_core_watchdog, run_tun_service,
};
use std::path::{Path, PathBuf};

#[tokio::main]
async fn main() {
    let mut arguments = std::env::args();
    let _executable = arguments.next();
    match arguments.next().as_deref() {
        Some(operation @ ("--enroll" | "--reset" | "--rotate" | "--remove-enrollment")) => {
            // SAFETY: geteuid has no preconditions and only returns the effective user ID.
            if unsafe { libc::geteuid() } != 0 {
                eprintln!("Mish installation-key lifecycle requires administrator authorization");
                std::process::exit(2);
            }
            let candidates = arguments.map(PathBuf::from).collect::<Vec<_>>();
            let allowed_uid = std::env::var("MISH_TUN_SERVICE_ALLOWED_UID")
                .ok()
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(0);
            let enrollment_path = std::env::var_os("MISH_TUN_SERVICE_ENROLLMENT_RECORD")
                .map(PathBuf::from)
                .unwrap_or_default();
            if allowed_uid == 0
                || enrollment_path.as_path() != Path::new(DEV_TUN_SERVICE_ENROLLMENT_PATH)
                || (operation == "--remove-enrollment" && !candidates.is_empty())
                || (operation != "--remove-enrollment"
                    && (candidates.is_empty()
                        || (operation != "--enroll" && candidates.len() != 1)
                        || candidates.len() > 2))
            {
                eprintln!("Mish installation-key lifecycle configuration was rejected");
                std::process::exit(2);
            }
            if operation == "--remove-enrollment" {
                if let Err(message) = recover_managed_network_record(&enrollment_path, 0).await {
                    eprintln!("Mish managed network recovery failed: {message}");
                    std::process::exit(2);
                }
                match remove_installation_enrollment(&enrollment_path, allowed_uid, true) {
                    Ok(()) => println!("{{\"operation\":\"remove\"}}"),
                    Err(message) => {
                        eprintln!("Mish installation-key lifecycle failed: {message}");
                        std::process::exit(2);
                    }
                }
                return;
            }
            let installation_id =
                std::env::var("MISH_TUN_SERVICE_INSTALLATION_ID").unwrap_or_default();
            let operation = match operation {
                "--enroll" => InstallationEnrollmentOperation::Enroll,
                "--reset" => InstallationEnrollmentOperation::Reset,
                "--rotate" => InstallationEnrollmentOperation::Rotate,
                _ => unreachable!(),
            };
            match apply_installation_enrollment_operation(
                operation,
                &candidates,
                &enrollment_path,
                &installation_id,
                allowed_uid,
                true,
            ) {
                Ok(receipt) => println!(
                    "{}",
                    serde_json::to_string(&receipt)
                        .expect("the bounded enrollment receipt must serialize")
                ),
                Err(message) => {
                    eprintln!("Mish installation-key lifecycle failed: {message}");
                    std::process::exit(2);
                }
            }
            return;
        }
        Some("--watch-parent") => {
            let parent_pid = arguments
                .next()
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(0);
            let core_pid = arguments
                .next()
                .and_then(|value| value.parse::<u32>().ok())
                .unwrap_or(0);
            let managed_dns = match arguments.next().as_deref() {
                Some("--restore-managed-network") => match arguments.next() {
                    Some(value) if arguments.next().is_none() => match parse_watchdog_dns(&value) {
                        Ok(state) => Some(state),
                        Err(message) => {
                            eprintln!("Mish Core watchdog failed: {message}");
                            std::process::exit(2);
                        }
                    },
                    _ => {
                        eprintln!("Mish Core watchdog received invalid network restoration state");
                        std::process::exit(2);
                    }
                },
                None => None,
                Some(_) => {
                    eprintln!("Mish Core watchdog received an unsupported argument");
                    std::process::exit(2);
                }
            };
            if let Err(message) = run_core_watchdog(parent_pid, core_pid, managed_dns).await {
                eprintln!("Mish Core watchdog failed: {message}");
                std::process::exit(2);
            }
            return;
        }
        Some(_) => {
            eprintln!("Mish TUN service received an unsupported argument");
            std::process::exit(2);
        }
        None => {}
    }
    if let Err(message) = complete_internal_tun_maintenance_on_helper_startup() {
        eprintln!("Mish Internal TUN maintenance recovery required: {message}");
        std::process::exit(3);
    }
    let config = match TunServiceConfig::from_environment() {
        Ok(config) => config,
        Err(message) => {
            eprintln!("Mish TUN service configuration failed: {message}");
            std::process::exit(2);
        }
    };
    if let Err(message) = run_tun_service(config).await {
        eprintln!("Mish TUN service failed: {message}");
        std::process::exit(1);
    }
}
