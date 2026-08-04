//! Shared Rust contract for installed-mobile outer-shell entry.
//!
//! This crate is deliberately not linked into a production application yet.
//! Android and Apple host adapters are the only intended callers: native
//! chrome selects a closed top-level destination, while a platform deep link
//! supplies a validated root-relative Web entry. Successful transitions emit
//! one directive toward the WebView. There is no React/Web intent source,
//! product-route stack, back state, `canGoBack`, sheet state, or focus token.

use std::collections::{BTreeSet, VecDeque};
use std::fmt;

pub const MAX_AUTHORITY_ID_BYTES: usize = 128;
pub const MAX_INTENT_ID_BYTES: usize = 128;
pub const MAX_RETIRED_INTENT_IDS: usize = 128;
pub const MAX_WEB_ENTRY_BYTES: usize = 2_048;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ShellDestination {
    Home,
    Routes,
    Profiles,
    Activity,
    Settings,
}

impl ShellDestination {
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
pub struct WebEntryPath {
    value: String,
    destination: ShellDestination,
}

impl WebEntryPath {
    pub fn parse(value: impl Into<String>) -> Result<Self, WebEntryPathError> {
        let value = value.into();
        validate_web_entry(&value)?;
        let destination =
            destination_for_path(&value).ok_or(WebEntryPathError::UnknownDestination)?;
        Ok(Self { value, destination })
    }

    pub fn as_str(&self) -> &str {
        &self.value
    }

    pub const fn destination(&self) -> ShellDestination {
        self.destination
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WebEntryPathError {
    Empty,
    TooLong,
    NotRootRelative,
    NetworkPath,
    ContainsFragment,
    ContainsBackslash,
    ContainsControlOrWhitespace,
    InvalidPercentEncoding,
    EncodedPathDelimiter,
    DotSegment,
    UnknownDestination,
}

impl fmt::Display for WebEntryPathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Empty => "Web entry is empty",
            Self::TooLong => "Web entry exceeds the bounded input size",
            Self::NotRootRelative => "Web entry is not root-relative",
            Self::NetworkPath => "Web entry must not contain an authority",
            Self::ContainsFragment => "Web entry fragments are not accepted",
            Self::ContainsBackslash => "Web entry contains a backslash",
            Self::ContainsControlOrWhitespace => {
                "Web entry contains control or whitespace characters"
            }
            Self::InvalidPercentEncoding => "Web entry contains invalid percent encoding",
            Self::EncodedPathDelimiter => "Web entry contains an encoded path delimiter",
            Self::DotSegment => "Web entry contains a dot segment",
            Self::UnknownDestination => "Web entry has no declared top-level destination",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for WebEntryPathError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShellIdentifierKind {
    Authority,
    Intent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShellIdentifierError {
    Empty(ShellIdentifierKind),
    TooLong(ShellIdentifierKind),
    InvalidCharacter(ShellIdentifierKind),
}

impl fmt::Display for ShellIdentifierError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (message, kind) = match self {
            Self::Empty(kind) => ("identifier is empty", kind),
            Self::TooLong(kind) => ("identifier exceeds the bounded input size", kind),
            Self::InvalidCharacter(kind) => ("identifier contains an invalid character", kind),
        };
        write!(formatter, "{kind:?} {message}")
    }
}

impl std::error::Error for ShellIdentifierError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellIntent {
    intent_id: String,
    expected_revision: u64,
    input: ShellInput,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ShellInput {
    AndroidChrome(ShellDestination),
    AppleChrome(ShellDestination),
    PlatformDeepLink(WebEntryPath),
}

impl ShellIntent {
    pub fn android_chrome(
        intent_id: impl Into<String>,
        expected_revision: u64,
        destination: ShellDestination,
    ) -> Result<Self, ShellIdentifierError> {
        Self::chrome(
            intent_id,
            expected_revision,
            ShellInput::AndroidChrome(destination),
        )
    }

    pub fn apple_chrome(
        intent_id: impl Into<String>,
        expected_revision: u64,
        destination: ShellDestination,
    ) -> Result<Self, ShellIdentifierError> {
        Self::chrome(
            intent_id,
            expected_revision,
            ShellInput::AppleChrome(destination),
        )
    }

    pub fn platform_deep_link(
        intent_id: impl Into<String>,
        expected_revision: u64,
        entry: WebEntryPath,
    ) -> Result<Self, ShellIdentifierError> {
        let intent_id = validate_identifier(
            intent_id.into(),
            ShellIdentifierKind::Intent,
            MAX_INTENT_ID_BYTES,
        )?;
        Ok(Self {
            intent_id,
            expected_revision,
            input: ShellInput::PlatformDeepLink(entry),
        })
    }

    fn chrome(
        intent_id: impl Into<String>,
        expected_revision: u64,
        input: ShellInput,
    ) -> Result<Self, ShellIdentifierError> {
        let intent_id = validate_identifier(
            intent_id.into(),
            ShellIdentifierKind::Intent,
            MAX_INTENT_ID_BYTES,
        )?;
        Ok(Self {
            intent_id,
            expected_revision,
            input,
        })
    }

    pub fn source(&self) -> ShellIntentSource {
        match self.input {
            ShellInput::AndroidChrome(_) => ShellIntentSource::AndroidChrome,
            ShellInput::AppleChrome(_) => ShellIntentSource::AppleChrome,
            ShellInput::PlatformDeepLink(_) => ShellIntentSource::PlatformDeepLink,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellSnapshot {
    authority_id: String,
    revision: u64,
    selected_destination: ShellDestination,
    web_entry_path: String,
}

impl ShellSnapshot {
    pub fn authority_id(&self) -> &str {
        &self.authority_id
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub const fn selected_destination(&self) -> ShellDestination {
        self.selected_destination
    }

    pub fn web_entry_path(&self) -> &str {
        &self.web_entry_path
    }

    pub fn web_entry_directive(&self) -> WebEntryDirective {
        WebEntryDirective {
            authority_id: self.authority_id.clone(),
            revision: self.revision,
            web_entry_path: self.web_entry_path.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebEntryDirective {
    authority_id: String,
    revision: u64,
    web_entry_path: String,
}

impl WebEntryDirective {
    pub fn authority_id(&self) -> &str {
        &self.authority_id
    }

    pub const fn revision(&self) -> u64 {
        self.revision
    }

    pub fn web_entry_path(&self) -> &str {
        &self.web_entry_path
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShellOutcome {
    Applied {
        snapshot: ShellSnapshot,
        directive: WebEntryDirective,
    },
    Duplicate {
        snapshot: ShellSnapshot,
    },
    RejectedStale {
        expected_revision: u64,
        snapshot: ShellSnapshot,
    },
    RejectedAuthority {
        snapshot: ShellSnapshot,
    },
    RejectedRevisionExhausted {
        snapshot: ShellSnapshot,
    },
}

impl ShellOutcome {
    pub fn snapshot(&self) -> &ShellSnapshot {
        match self {
            Self::Applied { snapshot, .. }
            | Self::Duplicate { snapshot }
            | Self::RejectedStale { snapshot, .. }
            | Self::RejectedAuthority { snapshot }
            | Self::RejectedRevisionExhausted { snapshot } => snapshot,
        }
    }

    pub fn directive(&self) -> Option<&WebEntryDirective> {
        match self {
            Self::Applied { directive, .. } => Some(directive),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedShellIntent {
    authority_id: String,
    intent_id: String,
    expected_revision: u64,
    destination: ShellDestination,
    web_entry_path: String,
}

#[derive(Debug)]
pub struct MobileShellAuthority {
    authority_id: String,
    revision: u64,
    selected_destination: ShellDestination,
    web_entry_path: String,
    retired_intents: BTreeSet<String>,
    retired_intent_order: VecDeque<String>,
}

impl MobileShellAuthority {
    pub fn new(authority_id: impl Into<String>) -> Result<Self, ShellIdentifierError> {
        let authority_id = validate_identifier(
            authority_id.into(),
            ShellIdentifierKind::Authority,
            MAX_AUTHORITY_ID_BYTES,
        )?;
        Ok(Self {
            authority_id,
            revision: 0,
            selected_destination: ShellDestination::Home,
            web_entry_path: ShellDestination::Home.root_path().to_owned(),
            retired_intents: BTreeSet::new(),
            retired_intent_order: VecDeque::new(),
        })
    }

    pub fn snapshot(&self) -> ShellSnapshot {
        ShellSnapshot {
            authority_id: self.authority_id.clone(),
            revision: self.revision,
            selected_destination: self.selected_destination,
            web_entry_path: self.web_entry_path.clone(),
        }
    }

    /// Performs low-cost, side-effect-free validation and freezes the proposed
    /// transition. `commit` repeats the revision/duplicate checks at the actual
    /// mutation boundary so a prepared intent cannot win after another commit.
    pub fn prepare(&self, intent: ShellIntent) -> Result<PreparedShellIntent, ShellOutcome> {
        if self.retired_intents.contains(&intent.intent_id) {
            return Err(ShellOutcome::Duplicate {
                snapshot: self.snapshot(),
            });
        }
        if intent.expected_revision != self.revision {
            return Err(ShellOutcome::RejectedStale {
                expected_revision: intent.expected_revision,
                snapshot: self.snapshot(),
            });
        }

        let (destination, web_entry_path) = match intent.input {
            ShellInput::AndroidChrome(destination) | ShellInput::AppleChrome(destination) => {
                (destination, destination.root_path().to_owned())
            }
            ShellInput::PlatformDeepLink(entry) => (entry.destination(), entry.as_str().to_owned()),
        };

        Ok(PreparedShellIntent {
            authority_id: self.authority_id.clone(),
            intent_id: intent.intent_id,
            expected_revision: intent.expected_revision,
            destination,
            web_entry_path,
        })
    }

    /// Commits one previously prepared transition. Only `Applied` mutates the
    /// authority and only `Applied` emits a Web entry directive.
    pub fn commit(&mut self, prepared: PreparedShellIntent) -> ShellOutcome {
        if prepared.authority_id != self.authority_id {
            return ShellOutcome::RejectedAuthority {
                snapshot: self.snapshot(),
            };
        }
        if self.retired_intents.contains(&prepared.intent_id) {
            return ShellOutcome::Duplicate {
                snapshot: self.snapshot(),
            };
        }
        if prepared.expected_revision != self.revision {
            return ShellOutcome::RejectedStale {
                expected_revision: prepared.expected_revision,
                snapshot: self.snapshot(),
            };
        }
        let Some(revision) = self.revision.checked_add(1) else {
            return ShellOutcome::RejectedRevisionExhausted {
                snapshot: self.snapshot(),
            };
        };

        self.revision = revision;
        self.selected_destination = prepared.destination;
        self.web_entry_path = prepared.web_entry_path;
        self.retire_intent(prepared.intent_id);

        let snapshot = self.snapshot();
        let directive = snapshot.web_entry_directive();
        ShellOutcome::Applied {
            snapshot,
            directive,
        }
    }

    pub fn apply(&mut self, intent: ShellIntent) -> ShellOutcome {
        match self.prepare(intent) {
            Ok(prepared) => self.commit(prepared),
            Err(outcome) => outcome,
        }
    }

    fn retire_intent(&mut self, intent_id: String) {
        self.retired_intents.insert(intent_id.clone());
        self.retired_intent_order.push_back(intent_id);
        while self.retired_intents.len() > MAX_RETIRED_INTENT_IDS {
            let oldest = self
                .retired_intent_order
                .pop_front()
                .expect("the retired intent set is non-empty");
            self.retired_intents.remove(&oldest);
        }
    }
}

fn validate_identifier(
    value: String,
    kind: ShellIdentifierKind,
    limit: usize,
) -> Result<String, ShellIdentifierError> {
    if value.is_empty() {
        return Err(ShellIdentifierError::Empty(kind));
    }
    if value.len() > limit {
        return Err(ShellIdentifierError::TooLong(kind));
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(ShellIdentifierError::InvalidCharacter(kind));
    }
    Ok(value)
}

fn validate_web_entry(value: &str) -> Result<(), WebEntryPathError> {
    if value.is_empty() {
        return Err(WebEntryPathError::Empty);
    }
    if value.len() > MAX_WEB_ENTRY_BYTES {
        return Err(WebEntryPathError::TooLong);
    }
    if !value.starts_with('/') {
        return Err(WebEntryPathError::NotRootRelative);
    }
    if value.starts_with("//") {
        return Err(WebEntryPathError::NetworkPath);
    }
    if value.contains('#') {
        return Err(WebEntryPathError::ContainsFragment);
    }
    if value.contains('\\') {
        return Err(WebEntryPathError::ContainsBackslash);
    }
    if value.chars().any(char::is_whitespace) || value.bytes().any(|byte| byte.is_ascii_control()) {
        return Err(WebEntryPathError::ContainsControlOrWhitespace);
    }

    validate_percent_encoding(value)?;
    let path = value.split_once('?').map_or(value, |(path, _)| path);
    for segment in path.split('/') {
        if segment == "." || segment == ".." || is_percent_encoded_dot_segment(segment) {
            return Err(WebEntryPathError::DotSegment);
        }
    }
    Ok(())
}

fn validate_percent_encoding(value: &str) -> Result<(), WebEntryPathError> {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        let Some(high) = bytes.get(index + 1).and_then(|byte| hex_value(*byte)) else {
            return Err(WebEntryPathError::InvalidPercentEncoding);
        };
        let Some(low) = bytes.get(index + 2).and_then(|byte| hex_value(*byte)) else {
            return Err(WebEntryPathError::InvalidPercentEncoding);
        };
        let decoded = high * 16 + low;
        if matches!(decoded, b'/' | b'\\' | b'?' | b'#') || decoded.is_ascii_control() {
            return Err(WebEntryPathError::EncodedPathDelimiter);
        }
        index += 3;
    }
    Ok(())
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn is_percent_encoded_dot_segment(segment: &str) -> bool {
    let mut decoded = String::with_capacity(segment.len());
    let bytes = segment.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_value(bytes[index + 1]).expect("percent encoding was validated");
            let low = hex_value(bytes[index + 2]).expect("percent encoding was validated");
            decoded.push((high * 16 + low) as char);
            index += 3;
        } else {
            decoded.push(bytes[index] as char);
            index += 1;
        }
    }
    decoded == "." || decoded == ".."
}

fn destination_for_path(value: &str) -> Option<ShellDestination> {
    let path = value.split_once('?').map_or(value, |(path, _)| path);
    let first_segment = path.strip_prefix('/')?.split('/').next()?;
    match first_segment {
        "status" => Some(ShellDestination::Home),
        "routes" => Some(ShellDestination::Routes),
        "profiles" => Some(ShellDestination::Profiles),
        "traffic" | "events" => Some(ShellDestination::Activity),
        "settings" => Some(ShellDestination::Settings),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority() -> MobileShellAuthority {
        MobileShellAuthority::new("test-authority").unwrap()
    }

    fn applied(outcome: ShellOutcome) -> (ShellSnapshot, WebEntryDirective) {
        match outcome {
            ShellOutcome::Applied {
                snapshot,
                directive,
            } => (snapshot, directive),
            other => panic!("expected applied outcome, got {other:?}"),
        }
    }

    #[test]
    fn every_android_and_apple_chrome_destination_emits_only_its_root() {
        for source in [
            ShellIntentSource::AndroidChrome,
            ShellIntentSource::AppleChrome,
        ] {
            for destination in ShellDestination::ALL {
                let mut authority = authority();
                let intent = match source {
                    ShellIntentSource::AndroidChrome => {
                        ShellIntent::android_chrome("chrome-intent", 0, destination)
                    }
                    ShellIntentSource::AppleChrome => {
                        ShellIntent::apple_chrome("chrome-intent", 0, destination)
                    }
                    ShellIntentSource::PlatformDeepLink => unreachable!(),
                }
                .unwrap();
                let (snapshot, directive) = applied(authority.apply(intent));

                assert_eq!(snapshot.selected_destination, destination);
                assert_eq!(snapshot.web_entry_path, destination.root_path());
                assert_eq!(directive.web_entry_path, destination.root_path());
                assert_eq!(snapshot.revision, 1);
            }
        }
    }

    #[test]
    fn native_chrome_has_no_arbitrary_path_constructor() {
        let intent =
            ShellIntent::android_chrome("settings", 0, ShellDestination::Settings).unwrap();
        assert_eq!(intent.source(), ShellIntentSource::AndroidChrome);
        let (_, directive) = applied(authority().apply(intent));
        assert_eq!(directive.web_entry_path, "/settings");
    }

    #[test]
    fn platform_deep_link_preserves_the_validated_entry_exactly() {
        let entry = WebEntryPath::parse("/settings/network?source=notification&mode=dns").unwrap();
        let intent = ShellIntent::platform_deep_link("deep-link", 0, entry).unwrap();
        let (snapshot, directive) = applied(authority().apply(intent));

        assert_eq!(snapshot.selected_destination, ShellDestination::Settings);
        assert_eq!(
            directive.web_entry_path,
            "/settings/network?source=notification&mode=dns"
        );
    }

    #[test]
    fn every_declared_top_level_entry_maps_once() {
        let cases = [
            ("/status/session", ShellDestination::Home),
            ("/routes/streaming", ShellDestination::Routes),
            ("/profiles/import", ShellDestination::Profiles),
            ("/traffic?tab=rules", ShellDestination::Activity),
            ("/events", ShellDestination::Activity),
            ("/settings/network", ShellDestination::Settings),
        ];

        for (path, destination) in cases {
            let entry = WebEntryPath::parse(path).unwrap();
            assert_eq!(entry.destination(), destination, "path {path}");
            assert_eq!(entry.as_str(), path);
        }
    }

    #[test]
    fn invalid_entries_never_mutate_authority() {
        let authority = authority();
        let baseline = authority.snapshot();
        let invalid = [
            ("".to_owned(), WebEntryPathError::Empty),
            (
                format!("/settings?{}", "a".repeat(MAX_WEB_ENTRY_BYTES)),
                WebEntryPathError::TooLong,
            ),
            (
                "settings/network".to_owned(),
                WebEntryPathError::NotRootRelative,
            ),
            (
                "//example.invalid/settings".to_owned(),
                WebEntryPathError::NetworkPath,
            ),
            (
                "https://example.invalid/settings".to_owned(),
                WebEntryPathError::NotRootRelative,
            ),
            (
                "/settings#native-command".to_owned(),
                WebEntryPathError::ContainsFragment,
            ),
            (
                "/settings\\network".to_owned(),
                WebEntryPathError::ContainsBackslash,
            ),
            (
                "/settings/network name".to_owned(),
                WebEntryPathError::ContainsControlOrWhitespace,
            ),
            (
                "/settings/%zz".to_owned(),
                WebEntryPathError::InvalidPercentEncoding,
            ),
            (
                "/settings/%2fnetwork".to_owned(),
                WebEntryPathError::EncodedPathDelimiter,
            ),
            (
                "/settings/%2e%2e/status".to_owned(),
                WebEntryPathError::DotSegment,
            ),
            (
                "/unknown/path".to_owned(),
                WebEntryPathError::UnknownDestination,
            ),
        ];

        for (path, expected_error) in invalid {
            assert_eq!(
                WebEntryPath::parse(&path),
                Err(expected_error),
                "path {path}"
            );
            assert_eq!(authority.snapshot(), baseline);
        }
    }

    #[test]
    fn duplicate_and_stale_intents_are_idempotent_and_emit_no_directive() {
        let mut authority = authority();
        let first =
            ShellIntent::apple_chrome("select-settings", 0, ShellDestination::Settings).unwrap();
        let (current, _) = applied(authority.apply(first.clone()));

        let duplicate = authority.apply(first);
        assert!(matches!(
            duplicate,
            ShellOutcome::Duplicate { ref snapshot } if snapshot == &current
        ));
        assert!(duplicate.directive().is_none());

        let stale = authority.apply(
            ShellIntent::android_chrome("stale-routes", 0, ShellDestination::Routes).unwrap(),
        );
        assert!(matches!(
            stale,
            ShellOutcome::RejectedStale { ref snapshot, .. } if snapshot == &current
        ));
        assert!(stale.directive().is_none());
        assert_eq!(authority.snapshot(), current);
    }

    #[test]
    fn commit_rechecks_revision_after_prepare_to_close_toctou() {
        let mut authority = authority();
        let prepared = authority
            .prepare(
                ShellIntent::android_chrome("prepared-routes", 0, ShellDestination::Routes)
                    .unwrap(),
            )
            .unwrap();
        let (current, _) = applied(authority.apply(
            ShellIntent::apple_chrome("winning-settings", 0, ShellDestination::Settings).unwrap(),
        ));

        let stale = authority.commit(prepared);
        assert!(matches!(
            stale,
            ShellOutcome::RejectedStale { ref snapshot, .. } if snapshot == &current
        ));
        assert!(stale.directive().is_none());
        assert_eq!(authority.snapshot(), current);
    }

    #[test]
    fn commit_rechecks_duplicate_after_prepare() {
        let mut authority = authority();
        let intent =
            ShellIntent::android_chrome("same-intent", 0, ShellDestination::Routes).unwrap();
        let first = authority.prepare(intent.clone()).unwrap();
        let second = authority.prepare(intent).unwrap();
        let (current, _) = applied(authority.commit(first));

        let duplicate = authority.commit(second);
        assert!(matches!(
            duplicate,
            ShellOutcome::Duplicate { ref snapshot } if snapshot == &current
        ));
        assert!(duplicate.directive().is_none());
    }

    #[test]
    fn retired_intent_memory_is_bounded_and_evicted_ids_stay_stale() {
        let mut authority = authority();
        for revision in 0..(MAX_RETIRED_INTENT_IDS as u64 + 16) {
            let intent = ShellIntent::android_chrome(
                format!("intent-{revision}"),
                revision,
                ShellDestination::Routes,
            )
            .unwrap();
            assert!(matches!(
                authority.apply(intent),
                ShellOutcome::Applied { .. }
            ));
            assert!(authority.retired_intents.len() <= MAX_RETIRED_INTENT_IDS);
        }

        let current = authority.snapshot();
        let evicted = authority
            .apply(ShellIntent::android_chrome("intent-0", 0, ShellDestination::Home).unwrap());
        assert!(matches!(evicted, ShellOutcome::RejectedStale { .. }));
        assert_eq!(authority.snapshot(), current);
    }

    #[test]
    fn revisions_are_strictly_monotonic_for_applied_transitions() {
        let mut authority = authority();
        for expected in 0..512_u64 {
            let outcome = authority.apply(
                ShellIntent::apple_chrome(
                    format!("monotonic-{expected}"),
                    expected,
                    ShellDestination::ALL[expected as usize % ShellDestination::ALL.len()],
                )
                .unwrap(),
            );
            assert_eq!(outcome.snapshot().revision, expected + 1);
            assert!(outcome.directive().is_some());
        }
    }

    #[test]
    fn revision_exhaustion_fails_closed_without_retiring_the_intent() {
        let mut authority = authority();
        authority.revision = u64::MAX;
        let baseline = authority.snapshot();
        let outcome = authority.apply(
            ShellIntent::android_chrome("at-limit", u64::MAX, ShellDestination::Settings).unwrap(),
        );

        assert!(matches!(
            outcome,
            ShellOutcome::RejectedRevisionExhausted { .. }
        ));
        assert!(outcome.directive().is_none());
        assert_eq!(authority.snapshot(), baseline);
        assert!(authority.retired_intents.is_empty());
    }

    #[test]
    fn prepared_intent_cannot_cross_authorities() {
        let first = authority();
        let prepared = first
            .prepare(ShellIntent::android_chrome("foreign", 0, ShellDestination::Settings).unwrap())
            .unwrap();
        let mut second = MobileShellAuthority::new("other-authority").unwrap();
        let baseline = second.snapshot();

        assert!(matches!(
            second.commit(prepared),
            ShellOutcome::RejectedAuthority { .. }
        ));
        assert_eq!(second.snapshot(), baseline);
    }

    #[test]
    fn identifiers_are_bounded_and_log_safe() {
        assert!(MobileShellAuthority::new("").is_err());
        assert!(MobileShellAuthority::new("authority with spaces").is_err());
        assert!(ShellIntent::android_chrome("", 0, ShellDestination::Home).is_err());
        assert!(ShellIntent::android_chrome("bad/id", 0, ShellDestination::Home).is_err());
    }
}
