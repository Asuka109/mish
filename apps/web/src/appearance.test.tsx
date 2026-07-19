import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  applyInitialAppearance,
  applyInitialWindowSurface,
  AppearanceProvider,
  resolveWindowSurface,
  useAppearance,
} from "./appearance";

function AppearanceProbe() {
  const { preference, resolvedAppearance } = useAppearance();
  return <span>{`${preference}:${resolvedAppearance}`}</span>;
}

it("follows system appearance changes without reloading", () => {
  let prefersDark = false;
  const listeners = new Set<() => void>();

  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query === "(prefers-color-scheme: dark)" && prefersDark,
        media: query,
        onchange: null,
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        removeListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );

  render(
    <AppearanceProvider>
      <AppearanceProbe />
    </AppearanceProvider>,
  );

  expect(screen.getByText("system:light")).toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute("data-theme", "light");

  act(() => {
    prefersDark = true;
    listeners.forEach((listener) => listener());
  });

  expect(screen.getByText("system:dark")).toBeInTheDocument();
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
});

it("applies a desktop bootstrap preference before React renders", () => {
  applyInitialAppearance("dark");

  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(document.documentElement.style.colorScheme).toBe("dark");
  expect(localStorage.getItem("mish.appearance")).toBe("dark");
});

describe("window surface resolution", () => {
  it.each([
    ["opaque", true, false, "opaque", null],
    ["material", true, false, "native-material", null],
    ["material", false, false, "opaque", "unsupported"],
    ["material", true, true, "opaque", "reduced-transparency"],
  ] as const)(
    "resolves %s with supported=%s and reduced=%s",
    (preference, supported, reduced, effectiveSurface, fallbackReason) => {
      expect(resolveWindowSurface(preference, supported, reduced)).toEqual({
        effectiveSurface,
        fallbackReason,
      });
    },
  );

  it("applies the resolved surface before React renders", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({ matches: query === "(prefers-reduced-transparency: reduce)" }) as MediaQueryList,
    );

    applyInitialWindowSurface("material", true);

    expect(document.documentElement).toHaveAttribute("data-window-surface", "opaque");
    expect(document.documentElement).toHaveAttribute(
      "data-window-surface-fallback",
      "reduced-transparency",
    );
  });
});
