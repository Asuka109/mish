#[cfg(target_os = "android")]
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "android")]
use std::time::{SystemTime, UNIX_EPOCH};

use mish_mobile_shell::{
    MobileShellAuthority, ShellDestination, ShellIntent, ShellOutcome, ShellSnapshot,
    WebEntryDirective, WebEntryPath,
};
use serde::Serialize;

const STATUS_APPLIED: &str = "applied";
const STATUS_DUPLICATE: &str = "duplicate";
const STATUS_REJECTED_INPUT: &str = "rejected-input";
const STATUS_REJECTED_STALE: &str = "rejected-stale";
const STATUS_REJECTED_AUTHORITY: &str = "rejected-authority";
const STATUS_REJECTED_REVISION_EXHAUSTED: &str = "rejected-revision-exhausted";

#[cfg(target_os = "android")]
static ANDROID_SHELL: OnceLock<Mutex<AndroidShellAdapter>> = OnceLock::new();

#[derive(Debug)]
struct AndroidShellAdapter {
    authority: MobileShellAuthority,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidShellEnvelope {
    status: &'static str,
    snapshot: AndroidShellSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    directive: Option<AndroidShellDirective>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidShellSnapshot {
    authority_id: String,
    revision: u64,
    selected_destination: &'static str,
    web_entry_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AndroidShellDirective {
    authority_id: String,
    revision: u64,
    web_entry_path: String,
}

impl AndroidShellAdapter {
    fn new(authority_id: impl Into<String>) -> Self {
        Self {
            authority: MobileShellAuthority::new(authority_id)
                .expect("the process-scoped Android shell authority id is valid"),
        }
    }

    #[cfg(target_os = "android")]
    fn snapshot_json(&self) -> String {
        serialize_envelope(AndroidShellEnvelope {
            status: "snapshot",
            snapshot: snapshot_dto(&self.authority.snapshot()),
            directive: None,
        })
    }

    fn select_destination_json(
        &mut self,
        destination: &str,
        expected_revision: i64,
        intent_id: &str,
    ) -> String {
        let Ok(expected_revision) = u64::try_from(expected_revision) else {
            return self.rejected_input_json();
        };
        let Some(destination) = parse_destination(destination) else {
            return self.rejected_input_json();
        };
        let Ok(intent) = ShellIntent::android_chrome(intent_id, expected_revision, destination)
        else {
            return self.rejected_input_json();
        };
        self.apply_json(intent)
    }

    fn open_deep_link_json(
        &mut self,
        web_entry_path: &str,
        expected_revision: i64,
        intent_id: &str,
    ) -> String {
        let Ok(expected_revision) = u64::try_from(expected_revision) else {
            return self.rejected_input_json();
        };
        let Ok(entry) = WebEntryPath::parse(web_entry_path) else {
            return self.rejected_input_json();
        };
        let Ok(intent) = ShellIntent::platform_deep_link(intent_id, expected_revision, entry)
        else {
            return self.rejected_input_json();
        };
        self.apply_json(intent)
    }

    fn apply_json(&mut self, intent: ShellIntent) -> String {
        let outcome = self.authority.apply(intent);
        let status = match &outcome {
            ShellOutcome::Applied { .. } => STATUS_APPLIED,
            ShellOutcome::Duplicate { .. } => STATUS_DUPLICATE,
            ShellOutcome::RejectedStale { .. } => STATUS_REJECTED_STALE,
            ShellOutcome::RejectedAuthority { .. } => STATUS_REJECTED_AUTHORITY,
            ShellOutcome::RejectedRevisionExhausted { .. } => STATUS_REJECTED_REVISION_EXHAUSTED,
        };
        serialize_envelope(AndroidShellEnvelope {
            status,
            snapshot: snapshot_dto(outcome.snapshot()),
            directive: outcome.directive().map(directive_dto),
        })
    }

    fn rejected_input_json(&self) -> String {
        serialize_envelope(AndroidShellEnvelope {
            status: STATUS_REJECTED_INPUT,
            snapshot: snapshot_dto(&self.authority.snapshot()),
            directive: None,
        })
    }
}

#[cfg(target_os = "android")]
fn android_shell() -> &'static Mutex<AndroidShellAdapter> {
    ANDROID_SHELL.get_or_init(|| Mutex::new(AndroidShellAdapter::new(process_authority_id())))
}

#[cfg(target_os = "android")]
fn process_authority_id() -> String {
    let started_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("android-{}-{started_at}", std::process::id())
}

fn parse_destination(value: &str) -> Option<ShellDestination> {
    match value {
        "home" => Some(ShellDestination::Home),
        "routes" => Some(ShellDestination::Routes),
        "profiles" => Some(ShellDestination::Profiles),
        "activity" => Some(ShellDestination::Activity),
        "settings" => Some(ShellDestination::Settings),
        _ => None,
    }
}

fn destination_name(destination: ShellDestination) -> &'static str {
    match destination {
        ShellDestination::Home => "home",
        ShellDestination::Routes => "routes",
        ShellDestination::Profiles => "profiles",
        ShellDestination::Activity => "activity",
        ShellDestination::Settings => "settings",
    }
}

fn snapshot_dto(snapshot: &ShellSnapshot) -> AndroidShellSnapshot {
    AndroidShellSnapshot {
        authority_id: snapshot.authority_id().to_owned(),
        revision: snapshot.revision(),
        selected_destination: destination_name(snapshot.selected_destination()),
        web_entry_path: snapshot.web_entry_path().to_owned(),
    }
}

fn directive_dto(directive: &WebEntryDirective) -> AndroidShellDirective {
    AndroidShellDirective {
        authority_id: directive.authority_id().to_owned(),
        revision: directive.revision(),
        web_entry_path: directive.web_entry_path().to_owned(),
    }
}

fn serialize_envelope(envelope: AndroidShellEnvelope) -> String {
    serde_json::to_string(&envelope).expect("the closed Android shell envelope serializes")
}

#[cfg(target_os = "android")]
mod jni_exports {
    use std::ptr;

    use jni::JNIEnv;
    use jni::objects::{JClass, JString};
    use jni::sys::{jlong, jstring};

    use super::android_shell;

    fn java_string(env: JNIEnv<'_>, value: String) -> jstring {
        env.new_string(value)
            .map(JString::into_raw)
            .unwrap_or_else(|_| ptr::null_mut())
    }

    fn rust_string(env: &mut JNIEnv<'_>, value: &JString<'_>) -> String {
        env.get_string(value)
            .map(|value| value.into())
            .unwrap_or_default()
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_com_asuka109_mish_NativeShellBridge_snapshot(
        env: JNIEnv<'_>,
        _class: JClass<'_>,
    ) -> jstring {
        let shell = android_shell()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        java_string(env, shell.snapshot_json())
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_com_asuka109_mish_NativeShellBridge_selectDestination(
        mut env: JNIEnv<'_>,
        _class: JClass<'_>,
        destination: JString<'_>,
        expected_revision: jlong,
        intent_id: JString<'_>,
    ) -> jstring {
        let destination = rust_string(&mut env, &destination);
        let intent_id = rust_string(&mut env, &intent_id);
        let result = android_shell()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .select_destination_json(&destination, expected_revision, &intent_id);
        java_string(env, result)
    }

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_com_asuka109_mish_NativeShellBridge_openDeepLink(
        mut env: JNIEnv<'_>,
        _class: JClass<'_>,
        web_entry_path: JString<'_>,
        expected_revision: jlong,
        intent_id: JString<'_>,
    ) -> jstring {
        let web_entry_path = rust_string(&mut env, &web_entry_path);
        let intent_id = rust_string(&mut env, &intent_id);
        let result = android_shell()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .open_deep_link_json(&web_entry_path, expected_revision, &intent_id);
        java_string(env, result)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn parsed(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn android_chrome_commits_only_closed_destinations() {
        let mut adapter = AndroidShellAdapter::new("android-test");
        let applied = parsed(&adapter.select_destination_json("settings", 0, "tap-settings"));

        assert_eq!(applied["status"], "applied");
        assert_eq!(applied["snapshot"]["revision"], 1);
        assert_eq!(applied["snapshot"]["selectedDestination"], "settings");
        assert_eq!(applied["directive"]["webEntryPath"], "/settings");

        let invalid = parsed(&adapter.select_destination_json("diagnostics", 1, "bad"));
        assert_eq!(invalid["status"], "rejected-input");
        assert_eq!(invalid["snapshot"]["revision"], 1);
        assert!(invalid.get("directive").is_none());
    }

    #[test]
    fn platform_deep_link_is_validated_before_the_commit_boundary() {
        let mut adapter = AndroidShellAdapter::new("android-deep-link");
        let invalid =
            parsed(&adapter.open_deep_link_json("/settings/%2e%2e/status", 0, "invalid-link"));
        assert_eq!(invalid["status"], "rejected-input");
        assert_eq!(invalid["snapshot"]["revision"], 0);

        let applied =
            parsed(&adapter.open_deep_link_json("/events?source=notification", 0, "valid-link"));
        assert_eq!(applied["status"], "applied");
        assert_eq!(applied["snapshot"]["selectedDestination"], "activity");
        assert_eq!(
            applied["directive"]["webEntryPath"],
            "/events?source=notification"
        );
    }

    #[test]
    fn duplicate_and_stale_results_reconcile_without_an_entry_directive() {
        let mut adapter = AndroidShellAdapter::new("android-idempotency");
        let first = parsed(&adapter.select_destination_json("routes", 0, "same-tap"));
        assert_eq!(first["status"], "applied");

        let duplicate = parsed(&adapter.select_destination_json("routes", 0, "same-tap"));
        assert_eq!(duplicate["status"], "duplicate");
        assert!(duplicate.get("directive").is_none());

        let stale = parsed(&adapter.select_destination_json("profiles", 0, "stale-tap"));
        assert_eq!(stale["status"], "rejected-stale");
        assert_eq!(stale["snapshot"]["selectedDestination"], "routes");
        assert!(stale.get("directive").is_none());
    }
}
