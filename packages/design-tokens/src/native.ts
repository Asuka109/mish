/**
 * Platform-neutral Mish tokens for native composition.
 *
 * Keep this map aligned with the canonical values in DESIGN.md and tokens.css.
 * Native clients own density, system typography, and platform presentation;
 * they consume these values only for shared brand and semantic meaning.
 */
export const mishNativeTokens = {
  color: {
    ink: "#111111",
    inkActive: "#242424",
    body: "#374151",
    muted: "#6B6F80",
    mutedSoft: "#898989",
    canvas: "#FFFFFF",
    surfaceSoft: "#F8F9FA",
    interactive: "#F3F4F6",
    hairline: "#E5E7EB",
    accent: "#3B82F6",
    brand: "#2F6FDC",
    brandForeground: "#F8FAFF",
    success: "#10B981",
    successText: "#047857",
    warning: "#B45309",
    error: "#DC2626",
  },
  radius: {
    sm: 6,
    md: 8,
    compact: 10,
    lg: 12,
    full: 999,
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    pageGutterMobile: 16,
  },
  typography: {
    title: {
      fontSize: 22,
      fontWeight: "600" as const,
      lineHeight: 1.3,
    },
    body: {
      fontSize: 14,
      fontWeight: "400" as const,
      lineHeight: 1.45,
    },
    metadata: {
      fontSize: 13,
      fontWeight: "400" as const,
      lineHeight: 1.4,
    },
    caption: {
      fontSize: 12,
      fontWeight: "400" as const,
      lineHeight: 1.4,
    },
  },
} as const;

export type MishNativeTokens = typeof mishNativeTokens;
