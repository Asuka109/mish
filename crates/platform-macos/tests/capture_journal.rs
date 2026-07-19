use std::{fs, os::unix::fs::PermissionsExt};

use mish_platform_macos::FileCaptureJournalStore;
use mish_runtime::{
    CaptureJournal, CaptureJournalStore, ManualProxyState, NetworkServiceProxyState,
};

#[test]
fn journal_is_private_bounded_and_contains_only_reversible_prior_state() {
    let root =
        std::env::temp_dir().join(format!("mish-system-proxy-journal-{}", std::process::id()));
    let path = root.join("system-proxy-journal.json");
    fs::create_dir_all(&root).unwrap();
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, b"stale").unwrap();
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o644)).unwrap();
    let store = FileCaptureJournalStore::new(path.clone());
    let journal = CaptureJournal {
        prior: NetworkServiceProxyState {
            auto_discovery_enabled: false,
            http: ManualProxyState {
                authenticated: false,
                enabled: true,
                host: Some("prior.proxy.example".into()),
                port: Some(3128),
            },
            https: ManualProxyState::disabled(),
            pac_enabled: false,
            service_id: "Fixture Service".into(),
            socks: ManualProxyState::disabled(),
        },
    };

    store.save(&journal).unwrap();

    assert_eq!(store.load().unwrap(), Some(journal));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let serialized = fs::read_to_string(&path).unwrap();
    assert!(!serialized.contains("authToken"));
    assert!(!serialized.contains("desired"));
    assert!(!serialized.contains("127.0.0.1"));

    store.clear().unwrap();
    assert!(!path.exists());
    let _ = fs::remove_dir_all(root);
}
