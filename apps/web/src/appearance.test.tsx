import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { applyInitialAppearance, AppearanceProvider, useAppearance } from "./appearance";

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
