//! Mish-owned native presentation translations. Every lookup receives the locale explicitly.
pub use mish_presentation_contract::{Locale, NativeMessage, NativeMessageId};
use rust_i18n::t;

rust_i18n::i18n!("locales", fallback = "en");

pub fn translate(locale: Locale, message: NativeMessage<'_>) -> String {
    let locale = locale.as_str();
    match message {
        NativeMessage::StatusLiveMostActiveNode { label } => t!(
            "status.live.most-active-node",
            locale = locale,
            label = label
        )
        .to_string(),
        NativeMessage::StatusLiveRate {
            direction,
            rate,
            total,
        } => t!(
            "status.live.rate",
            locale = locale,
            direction = direction,
            rate = rate,
            total = total
        )
        .to_string(),
        message => t!(message.id().as_str(), locale = locale).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_every_native_static_message_for_every_supported_locale() {
        let messages = [
            NativeMessage::StatusOpenMish,
            NativeMessage::StatusOpenBrowser,
            NativeMessage::StatusOpenRoutes,
            NativeMessage::StatusOpenProfiles,
            NativeMessage::StatusOpenTraffic,
            NativeMessage::StatusOpenEvents,
            NativeMessage::StatusOpenSettings,
            NativeMessage::StatusLaunchProxy,
            NativeMessage::StatusLaunchProxyPending,
            NativeMessage::StatusLaunchProxyFailed,
            NativeMessage::StatusStopProxy,
            NativeMessage::StatusAutoStartProxy,
            NativeMessage::StatusQuit,
            NativeMessage::StatusLiveIdle,
            NativeMessage::StatusLiveUnavailable,
            NativeMessage::ApplicationSettings,
            NativeMessage::ApplicationFind,
            NativeMessage::ApplicationQuit,
        ];
        for locale in Locale::ALL {
            for message in messages {
                let translated = translate(locale, message);
                assert!(
                    !translated.is_empty() && !translated.contains('.'),
                    "missing translation for {message:?} in {}",
                    locale.as_str()
                );
            }
        }
    }

    #[test]
    fn typed_arguments_are_interpolated_without_a_global_locale() {
        assert_eq!(
            translate(
                Locale::ZhCn,
                NativeMessage::StatusLiveMostActiveNode { label: "Tokyo" }
            ),
            ">> Tokyo"
        );
        assert!(
            translate(
                Locale::En,
                NativeMessage::StatusLiveRate {
                    direction: "⬇️",
                    rate: "1KB",
                    total: "2KB"
                }
            )
            .contains("1KB/s")
        );
    }

    #[test]
    fn unavailable_resource_uses_the_embedded_english_corruption_fallback() {
        assert_eq!(
            t!("status.open-mish", locale = "corrupted-resource"),
            "Open Mish"
        );
    }
}
