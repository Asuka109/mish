import { afterEach, describe, expect, test } from "vitest";
import "./styles.css";

const WCAG_NORMAL_TEXT_RATIO = 4.5;

function parseRgb(color: string): [number, number, number] {
  const channels = color.match(/rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/);
  if (!channels) throw new Error(`Expected an RGB computed color, received ${color}`);
  return [Number(channels[1]), Number(channels[2]), Number(channels[3])];
}

function relativeLuminance(color: string): number {
  return parseRgb(color)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    .reduce(
      (luminance, channel, index) => luminance + channel * [0.2126, 0.7152, 0.0722][index],
      0,
    );
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (left, right) => right - left,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function mountMutedText(theme: "light" | "dark", backgroundToken: string) {
  document.documentElement.dataset.theme = theme;
  const background = document.createElement("div");
  background.className = `bg-${backgroundToken}`;
  const text = document.createElement("p");
  text.className = "text-body text-muted-foreground";
  text.textContent = "Readable supporting content";
  background.append(text);
  document.body.append(background);
  return { background, text };
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
});

describe("muted normal-text contrast", () => {
  test.each([
    ["light", "canvas"],
    ["light", "surface-soft"],
    ["light", "accent"],
    ["dark", "canvas"],
    ["dark", "surface-soft"],
    ["dark", "accent"],
  ] as const)("meets WCAG AA on %s %s", (theme, backgroundToken) => {
    const { background, text } = mountMutedText(theme, backgroundToken);
    const foregroundColor = getComputedStyle(text).color;
    const backgroundColor = getComputedStyle(background).backgroundColor;
    const ratio = contrastRatio(foregroundColor, backgroundColor);

    expect(ratio, `${theme} ${backgroundToken} muted text contrast`).toBeGreaterThanOrEqual(
      WCAG_NORMAL_TEXT_RATIO,
    );
  });
});
