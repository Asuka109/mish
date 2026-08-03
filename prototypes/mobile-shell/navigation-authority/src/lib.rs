//! Research-only mobile shell authority used by the Issue #343 prototypes.
//!
//! This crate is not linked into a Mish application. It proves the outer-shell
//! contract only: native chrome selects a primary destination through Shared
//! Rust, and Rust emits one entry-route directive toward the WebView. React
//! Router remains the only owner of routes, history, back, and focus inside the
//! WebView. No Web-originated native intent exists in this API.

use std::collections::{BTreeSet, VecDeque};

const MAX_RETIRED_INTENTS: usize = 128;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum MobileTab {
    Home,
    Routes,
    Profiles,
    Activity,
    Settings,
}

impl MobileTab {
    pub const ALL: [Self; 5] = [
        Self::Home,
        Self::Routes,
        Self::Profiles,
        Self::Activity,
        Self::Settings,
    ];

    pub const fn root_path(self) -> &'static str {
        match self {
            Self::Home => "/status",
            Self::Routes => "/routes",
            Self::Profiles => "/profiles",
            Self::Activity => "/traffic",
            Self::Settings => "/settings",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShellIntentSource {
    AndroidChrome,
    AppleChrome,
    PlatformDeepLink,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShellAction {
    SelectTab(MobileTab),
    OpenExternalPath(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellIntent {
    pub intent_id: String,
    pub expected_revision: u64,
    pub source: ShellIntentSource,
    pub action: ShellAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellSnapshot {
    pub authority_id: String,
    pub revision: u64,
    pub selected_tab: MobileTab,
    /// One-way entry directive for the WebView. This is not a mirror of the
    /// current React Router location and is never updated by Web content.
    pub web_entry_path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShellOutcome {
    Applied(ShellSnapshot),
    Duplicate(ShellSnapshot),
    RejectedStale {
        expected_revision: u64,
        snapshot: ShellSnapshot,
    },
    RejectedPath {
        path: String,
        snapshot: ShellSnapshot,
    },
    RejectedSource {
        source: ShellIntentSource,
        action: ShellAction,
        snapshot: ShellSnapshot,
    },
}

#[derive(Debug)]
pub struct MobileShellAuthority {
    authority_id: String,
    revision: u64,
    selected_tab: MobileTab,
    web_entry_path: String,
    retired_intents: BTreeSet<String>,
    retired_intent_order: VecDeque<String>,
}

impl MobileShellAuthority {
    pub fn new(authority_id: impl Into<String>) -> Self {
        Self {
            authority_id: authority_id.into(),
            revision: 0,
            selected_tab: MobileTab::Home,
            web_entry_path: MobileTab::Home.root_path().to_owned(),
            retired_intents: BTreeSet::new(),
            retired_intent_order: VecDeque::new(),
        }
    }

    pub fn snapshot(&self) -> ShellSnapshot {
        ShellSnapshot {
            authority_id: self.authority_id.clone(),
            revision: self.revision,
            selected_tab: self.selected_tab,
            web_entry_path: self.web_entry_path.clone(),
        }
    }

    pub fn apply(&mut self, intent: ShellIntent) -> ShellOutcome {
        if self.retired_intents.contains(&intent.intent_id) {
            return ShellOutcome::Duplicate(self.snapshot());
        }
        if intent.expected_revision != self.revision {
            return ShellOutcome::RejectedStale {
                expected_revision: intent.expected_revision,
                snapshot: self.snapshot(),
            };
        }

        match (&intent.source, &intent.action) {
            (
                ShellIntentSource::AndroidChrome | ShellIntentSource::AppleChrome,
                ShellAction::SelectTab(tab),
            ) => {
                self.selected_tab = *tab;
                self.web_entry_path = tab.root_path().to_owned();
            }
            (ShellIntentSource::PlatformDeepLink, ShellAction::OpenExternalPath(path)) => {
                let Some(tab) = tab_for_path(path) else {
                    return ShellOutcome::RejectedPath {
                        path: path.clone(),
                        snapshot: self.snapshot(),
                    };
                };
                self.selected_tab = tab;
                self.web_entry_path = path.clone();
            }
            _ => {
                return ShellOutcome::RejectedSource {
                    source: intent.source,
                    action: intent.action,
                    snapshot: self.snapshot(),
                };
            }
        }

        self.revision += 1;
        self.retire_intent(intent.intent_id);
        ShellOutcome::Applied(self.snapshot())
    }

    fn retire_intent(&mut self, intent_id: String) {
        self.retired_intents.insert(intent_id.clone());
        self.retired_intent_order.push_back(intent_id);
        while self.retired_intents.len() > MAX_RETIRED_INTENTS {
            let oldest = self
                .retired_intent_order
                .pop_front()
                .expect("the retired intent set is non-empty");
            self.retired_intents.remove(&oldest);
        }
    }
}

pub fn tab_for_path(path: &str) -> Option<MobileTab> {
    let path_without_query = path.split('?').next()?;
    match path_without_query {
        "/status" => Some(MobileTab::Home),
        value if value.starts_with("/status/") => Some(MobileTab::Home),
        "/routes" => Some(MobileTab::Routes),
        value if value.starts_with("/routes/") => Some(MobileTab::Routes),
        "/profiles" => Some(MobileTab::Profiles),
        value if value.starts_with("/profiles/") => Some(MobileTab::Profiles),
        "/traffic" | "/events" => Some(MobileTab::Activity),
        "/settings" => Some(MobileTab::Settings),
        value if value.starts_with("/settings/") => Some(MobileTab::Settings),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(
        id: &str,
        revision: u64,
        source: ShellIntentSource,
        action: ShellAction,
    ) -> ShellIntent {
        ShellIntent {
            intent_id: id.to_owned(),
            expected_revision: revision,
            source,
            action,
        }
    }

    fn applied(outcome: ShellOutcome) -> ShellSnapshot {
        match outcome {
            ShellOutcome::Applied(snapshot) => snapshot,
            other => panic!("expected applied outcome, got {other:?}"),
        }
    }

    #[test]
    fn native_tab_selection_emits_one_root_entry_directive() {
        let mut authority = MobileShellAuthority::new("authority-a");
        let routes = applied(authority.apply(intent(
            "android-tab-routes",
            0,
            ShellIntentSource::AndroidChrome,
            ShellAction::SelectTab(MobileTab::Routes),
        )));

        assert_eq!(routes.selected_tab, MobileTab::Routes);
        assert_eq!(routes.web_entry_path, "/routes");
        assert_eq!(routes.revision, 1);
    }

    #[test]
    fn switching_shell_tabs_resets_only_the_one_way_web_entry() {
        let mut authority = MobileShellAuthority::new("authority-a");
        let deep_link = applied(authority.apply(intent(
            "settings-deep-link",
            0,
            ShellIntentSource::PlatformDeepLink,
            ShellAction::OpenExternalPath("/settings/network".to_owned()),
        )));
        let home = applied(authority.apply(intent(
            "apple-tab-home",
            deep_link.revision,
            ShellIntentSource::AppleChrome,
            ShellAction::SelectTab(MobileTab::Home),
        )));

        assert_eq!(home.selected_tab, MobileTab::Home);
        assert_eq!(home.web_entry_path, "/status");
    }

    #[test]
    fn platform_deep_link_selects_shell_and_forwards_the_full_entry_path() {
        let mut authority = MobileShellAuthority::new("authority-a");
        let settings = applied(authority.apply(intent(
            "settings-deep-link",
            0,
            ShellIntentSource::PlatformDeepLink,
            ShellAction::OpenExternalPath("/settings/network?source=notification".to_owned()),
        )));

        assert_eq!(settings.selected_tab, MobileTab::Settings);
        assert_eq!(
            settings.web_entry_path,
            "/settings/network?source=notification"
        );
    }

    #[test]
    fn chrome_cannot_open_arbitrary_web_paths() {
        let mut authority = MobileShellAuthority::new("authority-a");
        let baseline = authority.snapshot();
        let outcome = authority.apply(intent(
            "forbidden-chrome-path",
            0,
            ShellIntentSource::AndroidChrome,
            ShellAction::OpenExternalPath("/settings/network".to_owned()),
        ));

        assert!(matches!(
            outcome,
            ShellOutcome::RejectedSource { snapshot, .. } if snapshot == baseline
        ));
    }

    #[test]
    fn stale_and_duplicate_shell_intents_cannot_replace_the_projection() {
        let mut authority = MobileShellAuthority::new("authority-a");
        let first = intent(
            "select-settings",
            0,
            ShellIntentSource::AppleChrome,
            ShellAction::SelectTab(MobileTab::Settings),
        );
        let current = applied(authority.apply(first.clone()));

        assert!(
            matches!(authority.apply(first), ShellOutcome::Duplicate(snapshot) if snapshot == current)
        );
        assert!(matches!(
            authority.apply(intent(
                "stale-native-tab",
                0,
                ShellIntentSource::AndroidChrome,
                ShellAction::SelectTab(MobileTab::Routes),
            )),
            ShellOutcome::RejectedStale { snapshot, .. } if snapshot == current
        ));
    }

    #[test]
    fn invalid_platform_deep_link_does_not_mutate_the_shell() {
        let mut authority = MobileShellAuthority::new("authority-a");
        let baseline = authority.snapshot();
        let outcome = authority.apply(intent(
            "invalid-link",
            0,
            ShellIntentSource::PlatformDeepLink,
            ShellAction::OpenExternalPath("https://example.invalid/profile".to_owned()),
        ));

        assert!(matches!(
            outcome,
            ShellOutcome::RejectedPath { snapshot, .. } if snapshot == baseline
        ));
        assert_eq!(authority.snapshot(), baseline);
    }

    #[test]
    fn every_shell_section_accepts_an_external_child_entry() {
        let cases = [
            ("/status/session", MobileTab::Home),
            ("/routes/streaming", MobileTab::Routes),
            ("/profiles/import", MobileTab::Profiles),
            ("/events", MobileTab::Activity),
            ("/settings/network", MobileTab::Settings),
        ];

        for (path, expected_tab) in cases {
            assert_eq!(tab_for_path(path), Some(expected_tab), "path {path}");
        }
    }
}
