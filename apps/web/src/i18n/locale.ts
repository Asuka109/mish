import type { Locales } from "./i18n-types.js";
import { baseLocale, isLocale } from "./i18n-util.js";

const localeStorageKey = "mish.locale";

function matchSupportedLocale(candidate: string | null | undefined): Locales | null {
  if (!candidate) return null;
  if (isLocale(candidate)) return candidate;

  const language = candidate.toLowerCase().split("-")[0];
  return isLocale(language) ? language : null;
}

export function resolveInitialLocale(): Locales {
  try {
    const storedLocale = matchSupportedLocale(globalThis.localStorage?.getItem(localeStorageKey));
    if (storedLocale) return storedLocale;
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }

  for (const language of globalThis.navigator?.languages ?? []) {
    const matchedLocale = matchSupportedLocale(language);
    if (matchedLocale) return matchedLocale;
  }

  return baseLocale;
}

export function persistLocale(locale: Locales) {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  try {
    globalThis.localStorage?.setItem(localeStorageKey, locale);
  } catch {
    // The in-memory locale still works when persistence is unavailable.
  }
}
