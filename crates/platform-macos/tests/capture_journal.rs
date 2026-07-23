use std::{fs, os::unix::fs::PermissionsExt};

use mish_platform_macos::FileCaptureJournalStore;
use mish_runtime::{
    CaptureJournal, CaptureJournalStore, ManualProxyState, NetworkServiceProxyState,
};

#[test]
fn journal_is_private_bounded_and_contains_only_reversible_prior_state() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("system-proxy-journal.json");
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, b"stale").unwrap();
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o644)).unwrap();
    let store = FileCaptureJournalStore::new(path.clone());
    let journal = CaptureJournal {
        prior: NetworkServiceProxyState {
            auto_discovery_enabled: false,
            bypass_domains: Vec::new(),
            http: ManualProxyState {
                authenticated: false,
                enabled: true,
                host: "prior.proxy.example".into(),
                port: 3128,
            },
            https: ManualProxyState::disabled(),
            pac_enabled: false,
            pac_url: "(null)".into(),
            service_id: "Fixture Service".into(),
            socks: ManualProxyState::disabled(),
        },
    };

    fs::write(&path, b"not a recovery record").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        store.load().unwrap_err().kind,
        mish_runtime::CaptureFailureKind::InvalidRecovery
    );
    store.clear().unwrap();

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
}

#[test]
fn journal_rejects_stale_or_foreign_envelopes_and_non_private_files() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("system-proxy-journal.json");
    let store = FileCaptureJournalStore::new(path.clone());
    let journal = CaptureJournal {
        prior: NetworkServiceProxyState {
            auto_discovery_enabled: false,
            bypass_domains: Vec::new(),
            http: ManualProxyState::disabled(),
            https: ManualProxyState::disabled(),
            pac_enabled: false,
            pac_url: "(null)".into(),
            service_id: "Fixture Service".into(),
            socks: ManualProxyState::disabled(),
        },
    };
    store.save(&journal).unwrap();

    let mut stored: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    stored["version"] = 0.into();
    fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(store.load().is_err());
    assert!(store.save(&journal).is_err());
    fs::remove_file(&path).unwrap();

    store.save(&journal).unwrap();
    let mut stored: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    stored["owner"] = "foreign.application".into();
    fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(store.load().is_err());
    assert!(store.save(&journal).is_err());
    fs::remove_file(&path).unwrap();

    store.save(&journal).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(store.load().is_err());
    assert!(store.clear().is_err());
}

#[test]
fn corrupt_and_oversized_private_journals_fail_closed_but_can_be_discarded() {
    for bytes in [b"{".to_vec(), vec![b'x'; 65_537]] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("system-proxy-journal.json");
        fs::write(&path, bytes).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let store = FileCaptureJournalStore::new(path.clone());

        assert!(store.load().is_err());
        store.clear().unwrap();
        assert!(!path.exists());
    }
}

#[test]
fn journal_rejects_incomplete_or_unsafe_recovery_state() {
    for mutate in [
        |value: &mut serde_json::Value| {
            value["journal"]["prior"]
                .as_object_mut()
                .unwrap()
                .remove("pacUrl");
        },
        |value: &mut serde_json::Value| {
            value["journal"]["prior"]["http"]
                .as_object_mut()
                .unwrap()
                .remove("host");
        },
        |value: &mut serde_json::Value| {
            value["journal"]["prior"]["http"]["authenticated"] = true.into();
        },
        |value: &mut serde_json::Value| {
            value["journal"]["prior"]["http"]["enabled"] = true.into();
        },
        |value: &mut serde_json::Value| {
            value["journal"]["prior"]["bypassDomains"] = serde_json::json!([""]);
        },
        |value: &mut serde_json::Value| {
            value["journal"]["prior"]["serviceId"] = "".into();
        },
    ] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("system-proxy-journal.json");
        let store = FileCaptureJournalStore::new(path.clone());
        let journal = CaptureJournal {
            prior: NetworkServiceProxyState {
                auto_discovery_enabled: false,
                bypass_domains: Vec::new(),
                http: ManualProxyState::disabled(),
                https: ManualProxyState::disabled(),
                pac_enabled: false,
                pac_url: "http://pac.example/proxy.pac".into(),
                service_id: "Fixture Service".into(),
                socks: ManualProxyState::disabled(),
            },
        };
        store.save(&journal).unwrap();
        let mut stored: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        mutate(&mut stored);
        fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

        assert_eq!(
            store.load().unwrap_err().kind,
            mish_runtime::CaptureFailureKind::InvalidRecovery
        );
    }
}

#[cfg(unix)]
#[test]
fn journal_never_follows_or_clears_a_symlink() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target.json");
    let path = root.path().join("system-proxy-journal.json");
    fs::write(&target, b"foreign").unwrap();
    symlink(&target, &path).unwrap();
    let store = FileCaptureJournalStore::new(path);

    assert!(store.load().is_err());
    assert!(store.clear().is_err());
    assert_eq!(fs::read(&target).unwrap(), b"foreign");
}
