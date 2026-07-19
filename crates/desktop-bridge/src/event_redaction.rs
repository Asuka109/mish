use std::{net::Ipv6Addr, sync::OnceLock};

use regex::Regex;

const REDACTED: &str = "[redacted]";

pub(crate) fn redact_event_text(value: &str) -> String {
    let mut redacted = url_pattern()
        .replace_all(value, "[redacted-url]")
        .into_owned();
    redacted = secret_pattern()
        .replace_all(&redacted, "$1$2[redacted]")
        .into_owned();
    redacted = path_pattern()
        .replace_all(&redacted, "[redacted-path]")
        .into_owned();
    redacted = ipv4_pattern()
        .replace_all(&redacted, "[redacted-address]")
        .into_owned();
    redacted = redact_ipv6(&redacted);
    redacted = email_pattern()
        .replace_all(&redacted, "[redacted-email]")
        .into_owned();
    let redacted = long_token_pattern()
        .replace_all(&redacted, REDACTED)
        .into_owned();
    truncate_utf8(redacted, 8_192)
}

fn truncate_utf8(mut value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }
    let mut boundary = limit;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    value
}

fn url_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"(?i)\b(?:https?|socks5?|ws|wss)://[^\s<>"']+"#)
            .expect("event URL redaction pattern must compile")
    })
}

fn secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)\b(authorization|bearer|credential|password|passwd|secret|subscription|token)(\s*[:=]\s*)([^\s,;]+)",
        )
        .expect("event secret redaction pattern must compile")
    })
}

fn path_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?:/[A-Za-z0-9._~@%+\-]+){2,}|[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s]*")
            .expect("event path redaction pattern must compile")
    })
}

fn ipv4_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
            .expect("event address redaction pattern must compile")
    })
}

fn ipv6_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}")
            .expect("event IPv6 redaction pattern must compile")
    })
}

fn redact_ipv6(value: &str) -> String {
    ipv6_pattern()
        .replace_all(value, |captures: &regex::Captures<'_>| {
            let candidate = &captures[0];
            if candidate.parse::<Ipv6Addr>().is_ok() {
                "[redacted-address]".to_owned()
            } else {
                candidate.to_owned()
            }
        })
        .into_owned()
}

fn email_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
            .expect("event email redaction pattern must compile")
    })
}

fn long_token_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\b[A-Za-z0-9_-]{32,}\b").expect("event token redaction pattern must compile")
    })
}

#[cfg(test)]
mod tests {
    use super::redact_event_text;

    #[test]
    fn removes_urls_credentials_tokens_paths_addresses_and_email() {
        let input = "open https://user:pass@subscription.example.invalid/list?token=secret from /synthetic/private/config.yaml at 192.0.2.44 or 2001:db8::24 for operator@example.invalid token=abcdefghijklmnopqrstuvwxyz123456";
        let redacted = redact_event_text(input);

        assert!(!redacted.contains("user:pass"));
        assert!(!redacted.contains("subscription.example.invalid"));
        assert!(!redacted.contains("/synthetic/private"));
        assert!(!redacted.contains("192.0.2.44"));
        assert!(!redacted.contains("2001:db8::24"));
        assert!(!redacted.contains("operator@example.invalid"));
        assert!(!redacted.contains("abcdefghijklmnopqrstuvwxyz123456"));
        assert!(redacted.contains("[redacted-url]"));
        assert!(redacted.contains("[redacted-path]"));
        assert!(redacted.contains("[redacted-address]"));
        assert!(redacted.contains("[redacted-email]"));
        assert_eq!(
            redact_event_text("observed at 08:00:00"),
            "observed at 08:00:00"
        );
    }
}
