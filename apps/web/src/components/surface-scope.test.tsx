import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppearanceProvider } from "../appearance";
import { SurfaceScope, useSurfaceScope } from "./surface-scope";

function ScopeProbe() {
  const scope = useSurfaceScope();
  return <span>{`${scope.role}:${scope.rendering}`}</span>;
}

describe("surface scope", () => {
  it("keeps an opaque content subtree inside a material window subtree", () => {
    render(
      <AppearanceProvider initialWindowSurfacePreference="material" nativeSidebarMaterialSupported>
        <SurfaceScope data-testid="window" surfaceRole="window">
          <ScopeProbe />
          <SurfaceScope data-testid="content" surfaceRole="content">
            <ScopeProbe />
          </SurfaceScope>
        </SurfaceScope>
      </AppearanceProvider>,
    );

    expect(screen.getByTestId("window")).toHaveAttribute("data-surface-rendering", "material");
    expect(screen.getByTestId("content")).toHaveAttribute("data-surface-rendering", "opaque");
    expect(screen.getByText("window:material")).toBeInTheDocument();
    expect(screen.getByText("content:opaque")).toBeInTheDocument();
  });

  it("resolves a window subtree to opaque when the user chooses opaque", () => {
    render(
      <AppearanceProvider initialWindowSurfacePreference="opaque" nativeSidebarMaterialSupported>
        <SurfaceScope data-testid="window" surfaceRole="window">
          <ScopeProbe />
        </SurfaceScope>
      </AppearanceProvider>,
    );

    expect(screen.getByTestId("window")).toHaveAttribute("data-surface-rendering", "opaque");
    expect(screen.getByText("window:opaque")).toBeInTheDocument();
  });
});
