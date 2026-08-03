//! Research-only mobile navigation authority used by the Issue #343 prototypes.
//!
//! This crate is not linked into a Mish application. It proves the state and
//! ordering contract that native chrome and React Router would project after
//! an accepted implementation issue.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

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
pub enum IntentSource {
    AndroidChrome,
    AppleChrome,
    ReactLink,
    PlatformBack,
    DeepLink,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NavigationAction {
    OpenPath(String),
    SelectTab(MobileTab),
    Back,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NavigationIntent {
    pub intent_id: String,
    pub expected_revision: u64,
    pub source: IntentSource,
    pub action: NavigationAction,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NavigationSnapshot {
    pub authority_id: String,
    pub revision: u64,
    pub selected_tab: MobileTab,
    pub active_path: String,
    pub tab_stacks: BTreeMap<MobileTab, Vec<String>>,
    pub can_go_back: bool,
    pub focus_token: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NavigationOutcome {
    Applied(NavigationSnapshot),
    Duplicate(NavigationSnapshot),
    RejectedStale {
        expected_revision: u64,
        snapshot: NavigationSnapshot,
    },
    ExitRequested(NavigationSnapshot),
    RejectedPath {
        path: String,
        snapshot: NavigationSnapshot,
    },
}

#[derive(Debug)]
pub struct MobileNavigationAuthority {
    authority_id: String,
    revision: u64,
    focus_token: u64,
    selected_tab: MobileTab,
    tab_stacks: BTreeMap<MobileTab, Vec<String>>,
    retired_intents: BTreeSet<String>,
    retired_intent_order: VecDeque<String>,
}

impl MobileNavigationAuthority {
    pub fn new(authority_id: impl Into<String>) -> Self {
        let tab_stacks = MobileTab::ALL
            .into_iter()
            .map(|tab| (tab, vec![tab.root_path().to_owned()]))
            .collect();
        Self {
            authority_id: authority_id.into(),
            revision: 0,
            focus_token: 0,
            selected_tab: MobileTab::Home,
            tab_stacks,
            retired_intents: BTreeSet::new(),
            retired_intent_order: VecDeque::new(),
        }
    }

    pub fn snapshot(&self) -> NavigationSnapshot {
        let active_stack = self
            .tab_stacks
            .get(&self.selected_tab)
            .expect("all mobile tabs have one stack");
        NavigationSnapshot {
            authority_id: self.authority_id.clone(),
            revision: self.revision,
            selected_tab: self.selected_tab,
            active_path: active_stack
                .last()
                .expect("every tab stack retains its root")
                .clone(),
            tab_stacks: self.tab_stacks.clone(),
            can_go_back: active_stack.len() > 1,
            focus_token: self.focus_token,
        }
    }

    pub fn apply(&mut self, intent: NavigationIntent) -> NavigationOutcome {
        if self.retired_intents.contains(&intent.intent_id) {
            return NavigationOutcome::Duplicate(self.snapshot());
        }
        if intent.expected_revision != self.revision {
            return NavigationOutcome::RejectedStale {
                expected_revision: intent.expected_revision,
                snapshot: self.snapshot(),
            };
        }

        let outcome = match intent.action {
            NavigationAction::SelectTab(tab) => {
                self.selected_tab = tab;
                self.commit();
                NavigationOutcome::Applied(self.snapshot())
            }
            NavigationAction::OpenPath(path) => {
                let Some(tab) = tab_for_path(&path) else {
                    return NavigationOutcome::RejectedPath {
                        path,
                        snapshot: self.snapshot(),
                    };
                };
                self.selected_tab = tab;
                let stack = self
                    .tab_stacks
                    .get_mut(&tab)
                    .expect("all mobile tabs have one stack");
                if stack.last() != Some(&path) {
                    if path == tab.root_path() {
                        stack.truncate(1);
                    } else {
                        stack.push(path);
                    }
                }
                self.commit();
                NavigationOutcome::Applied(self.snapshot())
            }
            NavigationAction::Back => {
                let stack = self
                    .tab_stacks
                    .get_mut(&self.selected_tab)
                    .expect("all mobile tabs have one stack");
                if stack.len() == 1 {
                    NavigationOutcome::ExitRequested(self.snapshot())
                } else {
                    stack.pop();
                    self.commit();
                    NavigationOutcome::Applied(self.snapshot())
                }
            }
        };

        self.retire_intent(intent.intent_id);
        outcome
    }

    fn commit(&mut self) {
        self.revision += 1;
        self.focus_token += 1;
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
        source: IntentSource,
        action: NavigationAction,
    ) -> NavigationIntent {
        NavigationIntent {
            intent_id: id.to_owned(),
            expected_revision: revision,
            source,
            action,
        }
    }

    fn applied(outcome: NavigationOutcome) -> NavigationSnapshot {
        match outcome {
            NavigationOutcome::Applied(snapshot) => snapshot,
            other => panic!("expected applied outcome, got {other:?}"),
        }
    }

    #[test]
    fn native_and_react_intents_converge_on_one_snapshot() {
        let mut authority = MobileNavigationAuthority::new("authority-a");
        let routes = applied(authority.apply(intent(
            "native-tab-routes",
            0,
            IntentSource::AndroidChrome,
            NavigationAction::SelectTab(MobileTab::Routes),
        )));
        let child = applied(authority.apply(intent(
            "react-route-child",
            routes.revision,
            IntentSource::ReactLink,
            NavigationAction::OpenPath("/routes/streaming".to_owned()),
        )));

        assert_eq!(child.selected_tab, MobileTab::Routes);
        assert_eq!(child.active_path, "/routes/streaming");
        assert_eq!(
            child.tab_stacks[&MobileTab::Routes],
            ["/routes", "/routes/streaming"]
        );
        assert!(child.can_go_back);
        assert_eq!(child.focus_token, 2);
    }

    #[test]
    fn deep_links_select_the_canonical_mobile_tab_and_preserve_other_stacks() {
        let mut authority = MobileNavigationAuthority::new("authority-a");
        let events = applied(authority.apply(intent(
            "deep-link-events",
            0,
            IntentSource::DeepLink,
            NavigationAction::OpenPath("/events".to_owned()),
        )));
        let settings = applied(authority.apply(intent(
            "deep-link-settings",
            events.revision,
            IntentSource::DeepLink,
            NavigationAction::OpenPath("/settings/network".to_owned()),
        )));

        assert_eq!(events.selected_tab, MobileTab::Activity);
        assert_eq!(events.active_path, "/events");
        assert_eq!(settings.selected_tab, MobileTab::Settings);
        assert_eq!(settings.active_path, "/settings/network");
        assert_eq!(
            settings.tab_stacks[&MobileTab::Activity],
            ["/traffic", "/events"]
        );
    }

    #[test]
    fn platform_back_pops_the_selected_tab_before_requesting_exit() {
        let mut authority = MobileNavigationAuthority::new("authority-a");
        let child = applied(authority.apply(intent(
            "open-child",
            0,
            IntentSource::ReactLink,
            NavigationAction::OpenPath("/routes/streaming".to_owned()),
        )));
        let root = applied(authority.apply(intent(
            "back-child",
            child.revision,
            IntentSource::PlatformBack,
            NavigationAction::Back,
        )));
        let exit = authority.apply(intent(
            "back-root",
            root.revision,
            IntentSource::PlatformBack,
            NavigationAction::Back,
        ));

        assert_eq!(root.active_path, "/routes");
        assert!(!root.can_go_back);
        assert!(matches!(exit, NavigationOutcome::ExitRequested(_)));
    }

    #[test]
    fn stale_and_duplicate_intents_cannot_diverge_native_and_react_projections() {
        let mut authority = MobileNavigationAuthority::new("authority-a");
        let first = intent(
            "select-settings",
            0,
            IntentSource::AppleChrome,
            NavigationAction::SelectTab(MobileTab::Settings),
        );
        let current = applied(authority.apply(first.clone()));

        assert!(
            matches!(authority.apply(first), NavigationOutcome::Duplicate(snapshot) if snapshot == current)
        );
        assert!(matches!(
            authority.apply(intent(
                "stale-web-link",
                0,
                IntentSource::ReactLink,
                NavigationAction::OpenPath("/routes".to_owned()),
            )),
            NavigationOutcome::RejectedStale { snapshot, .. } if snapshot == current
        ));
    }

    #[test]
    fn invalid_deep_link_does_not_mutate_route_or_focus() {
        let mut authority = MobileNavigationAuthority::new("authority-a");
        let baseline = authority.snapshot();
        let outcome = authority.apply(intent(
            "invalid-link",
            0,
            IntentSource::DeepLink,
            NavigationAction::OpenPath("https://example.invalid/profile".to_owned()),
        ));

        assert!(matches!(
            outcome,
            NavigationOutcome::RejectedPath { snapshot, .. } if snapshot == baseline
        ));
        assert_eq!(authority.snapshot(), baseline);
    }

    #[test]
    fn every_prototype_tab_accepts_its_child_route() {
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
