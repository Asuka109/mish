import { act, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => vi.restoreAllMocks());

function runDocumentBootstrap() {
  const source = readFileSync("appearance-bootstrap.js", "utf8");
  Function(source)();
}

describe("document appearance bootstrap", () => {
  it.each(["light", "dark"] as const)("applies a persisted %s appearance", (appearance) => {
    localStorage.setItem("mish.appearance", appearance);

    runDocumentBootstrap();

    expect(document.documentElement).toHaveAttribute("data-theme", appearance);
    expect(document.documentElement.style.colorScheme).toBe(appearance);
  });

  it("follows the system appearance before React starts", () => {
    localStorage.setItem("mish.appearance", "system");
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query === "(prefers-color-scheme: dark)" }) as MediaQueryList,
    );

    runDocumentBootstrap();

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it.each([null, "sepia", "{malformed"])(
    "fails safely for a missing or malformed stored value: %s",
    (storedAppearance) => {
      if (storedAppearance !== null) {
        localStorage.setItem("mish.appearance", storedAppearance);
      }

      runDocumentBootstrap();

      const expected = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      expect(document.documentElement).toHaveAttribute("data-theme", expected);
      expect(document.documentElement.style.colorScheme).toBe(expected);
    },
  );

  it("fails safely when storage and media queries are unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(window, "matchMedia").mockImplementation(() => {
      throw new Error("unavailable");
    });

    runDocumentBootstrap();

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });
});

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

it("hands a matching bootstrap appearance to Settings without a duplicate DOM transition", async () => {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.style.colorScheme = "dark";
  const callback = vi.fn();
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributeFilter: ["data-theme", "style"],
    attributes: true,
  });

  applyInitialAppearance("dark");
  await Promise.resolve();

  expect(callback).not.toHaveBeenCalled();
  observer.disconnect();
});

it("converges a stale bootstrap hint to the Rust-authoritative Settings appearance once", async () => {
  document.documentElement.dataset.theme = "dark";
  document.documentElement.style.colorScheme = "dark";
  const callback = vi.fn();
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributeFilter: ["data-theme"],
    attributes: true,
  });

  applyInitialAppearance("light");
  applyInitialAppearance("light");
  await Promise.resolve();

  expect(callback).toHaveBeenCalledOnce();
  expect(callback.mock.calls[0]?.[0]).toHaveLength(1);
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  expect(localStorage.getItem("mish.appearance")).toBe("light");
  observer.disconnect();
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
