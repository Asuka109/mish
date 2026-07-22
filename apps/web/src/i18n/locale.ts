import type { Locales } from "./i18n-types.js";
import { baseLocale, isLocale } from "./i18n-util.js";

function matchSupportedLocale(candidate: string | null | undefined): Locales | null {
  if (!candidate) return null;
  if (isLocale(candidate)) return candidate;

  const language = candidate.toLowerCase().split("-")[0];
  return isLocale(language) ? language : null;
}

export function resolveInitialLocale(): Locales {
  for (const language of globalThis.navigator?.languages ?? []) {
    const matchedLocale = matchSupportedLocale(language);
    if (matchedLocale) return matchedLocale;
  }

  return baseLocale;
}

export function projectLocale(locale: Locales) {
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
}
