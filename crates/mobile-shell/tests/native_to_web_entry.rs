use mish_mobile_shell::{
    MobileShellAuthority, ShellDestination, ShellIntent, ShellOutcome, WebEntryPath,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    contract_version: u8,
    authority_id: String,
    steps: Vec<FixtureStep>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureStep {
    source: FixtureSource,
    intent_id: String,
    expected_revision: u64,
    destination: Option<FixtureDestination>,
    web_entry_path: Option<String>,
    expected_destination: Option<FixtureDestination>,
    expected_web_entry_path: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum FixtureSource {
    AndroidChrome,
    AppleChrome,
    PlatformDeepLink,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum FixtureDestination {
    Home,
    Routes,
    Profiles,
    Activity,
    Settings,
}

impl From<FixtureDestination> for ShellDestination {
    fn from(value: FixtureDestination) -> Self {
        match value {
            FixtureDestination::Home => Self::Home,
            FixtureDestination::Routes => Self::Routes,
            FixtureDestination::Profiles => Self::Profiles,
            FixtureDestination::Activity => Self::Activity,
            FixtureDestination::Settings => Self::Settings,
        }
    }
}

#[test]
fn platform_neutral_fixture_traces_native_through_rust_to_web() {
    let fixture: Fixture = serde_json::from_str(include_str!("fixtures/native-to-web-entry.json"))
        .expect("fixture is valid");
    assert_eq!(fixture.contract_version, 1);

    let mut authority = MobileShellAuthority::new(fixture.authority_id).unwrap();
    for step in fixture.steps {
        let intent = match step.source {
            FixtureSource::AndroidChrome => ShellIntent::android_chrome(
                step.intent_id,
                step.expected_revision,
                step.destination.expect("chrome destination").into(),
            )
            .unwrap(),
            FixtureSource::AppleChrome => ShellIntent::apple_chrome(
                step.intent_id,
                step.expected_revision,
                step.destination.expect("chrome destination").into(),
            )
            .unwrap(),
            FixtureSource::PlatformDeepLink => ShellIntent::platform_deep_link(
                step.intent_id,
                step.expected_revision,
                WebEntryPath::parse(step.web_entry_path.expect("deep-link entry")).unwrap(),
            )
            .unwrap(),
        };

        let ShellOutcome::Applied {
            snapshot,
            directive,
        } = authority.apply(intent)
        else {
            panic!("fixture step was not applied");
        };
        assert_eq!(snapshot.revision(), step.expected_revision + 1);
        assert_eq!(directive.revision(), snapshot.revision());
        assert_eq!(directive.web_entry_path(), step.expected_web_entry_path);
        assert_eq!(snapshot.web_entry_path(), directive.web_entry_path());
        if let Some(expected) = step.expected_destination {
            assert_eq!(snapshot.selected_destination(), expected.into());
        }
    }
}
