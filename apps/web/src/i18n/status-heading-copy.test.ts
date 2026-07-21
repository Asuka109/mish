import { describe, expect, it } from "vitest";
import en from "./en";
import zh from "./zh";

const englishHeadingCopy = {
  actions: [en.status.openLiveTraffic, en.status.viewAll, en.services.manage],
  subtitles: [
    en.status.desktopActivity,
    en.status.deviceActivity,
    en.status.fixtureActivity,
    en.status.usedFirst,
  ],
  titles: [en.status.session, en.status.groups, en.status.services],
};

const chineseSubtitles = [
  zh.status.desktopActivity,
  zh.status.deviceActivity,
  zh.status.fixtureActivity,
  zh.status.usedFirst,
];

describe("compact status section-heading copy", () => {
  it("keeps English titles and actions within two words and subtitles within 30 characters", () => {
    for (const copy of [...englishHeadingCopy.titles, ...englishHeadingCopy.actions]) {
      expect(copy.trim().split(/\s+/).length, copy).toBeLessThanOrEqual(2);
    }

    for (const copy of englishHeadingCopy.subtitles) {
      expect(copy.length, copy).toBeLessThanOrEqual(30);
    }
  });

  it("omits terminal punctuation from compact Simplified Chinese subtitles", () => {
    for (const copy of chineseSubtitles) {
      expect(copy, copy).not.toMatch(/[。！？!?；;：:]$/u);
    }
  });
});
