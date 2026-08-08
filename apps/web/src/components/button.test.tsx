import { render, screen, waitFor } from "@testing-library/react";
import { Button, cn, Spinner, Toggle, ToggleGroup, ToggleGroupItem } from "@mish/ui";
import { describe, expect, it } from "vitest";

function deferred() {
  let resolve!: () => void;
  let reject!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("Button promise loading", () => {
  it("keeps semantic typography beside a conflicting foreground utility", () => {
    render(
      <>
        <Button>Continue</Button>
        <Button className="text-caption">Compact</Button>
        <Button className="text-sm">Native</Button>
      </>,
    );

    const button = screen.getByRole("button", { name: "Continue" });
    const override = screen.getByRole("button", { name: "Compact" });
    const native = screen.getByRole("button", { name: "Native" });
    expect(button).toHaveClass("text-metadata", "text-canvas");
    expect(override).toHaveClass("text-caption", "text-canvas");
    expect(override).not.toHaveClass("text-metadata");
    expect(native).toHaveClass("text-sm", "text-canvas");
    expect(native).not.toHaveClass("text-metadata");
    expect(cn("text-sm", "text-metadata", "text-fg")).toBe("text-metadata text-fg");
  });

  it("keeps the semantic spinner width through the shared merge boundary", () => {
    render(<Spinner />);

    const spinner = document.querySelector(".ui-spinner");
    expect(spinner).toHaveClass("spinner-border", "border-current", "border-r-transparent");
    expect(spinner).not.toHaveClass("border-spinner");
  });

  it("lets a caller override conflicting recipe utilities at the shared TV merge boundary", () => {
    render(
      <Button className="h-12 bg-red-500 px-6" variant="outline">
        Override
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Override" });
    expect(button).toHaveClass("h-12", "bg-red-500", "px-6");
    expect(button.className).not.toContain("h-8.5");
  });

  it("keeps Base UI pressed state semantic while the capture recipe styles it", () => {
    render(
      <Toggle data-capture-state="running" pressed variant="capture">
        System proxy
      </Toggle>,
    );

    const toggle = screen.getByRole("button", { name: "System proxy" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("data-capture-state", "running");
    expect(toggle).toHaveClass("data-[capture-state=running]:text-fg");
  });

  it("exposes the shared adaptive coarse-pointer target without changing compact defaults", () => {
    render(
      <>
        <Button size="icon" touchTarget="adaptive" variant="toolbar">
          Toolbar
        </Button>
        <Toggle touchTarget="adaptive" variant="capture">
          Capture
        </Toggle>
        <ToggleGroup touchTarget="adaptive" value={["rule"]} variant="segmented">
          <ToggleGroupItem value="rule">Rule</ToggleGroupItem>
        </ToggleGroup>
      </>,
    );

    for (const name of ["Toolbar", "Capture", "Rule"]) {
      expect(screen.getByRole("button", { name })).toHaveClass(
        "touch-manipulation",
        "pointer-coarse:min-h-11",
        "pointer-coarse:min-w-11",
      );
    }
    expect(screen.getByRole("button", { name: "Toolbar" })).toHaveClass(
      "size-8.5",
      "text-muted-foreground",
      "hover:text-fg",
    );
    expect(screen.getByRole("button", { name: "Capture" })).toHaveClass("h-7.5");
    expect(screen.getByRole("button", { name: "Rule" })).toHaveClass("h-7.5");
  });

  it("stays loading until a promise resolves", async () => {
    const operation = deferred();
    render(
      <Button loading={operation.promise} loadingText="Saving">
        Save
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Saving" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector(".ui-spinner")).toBeInTheDocument();

    operation.resolve();

    await waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Save");
  });

  it("settles rejected promises and follows replacement promises", async () => {
    const first = deferred();
    const second = deferred();
    const { rerender } = render(<Button loading={first.promise}>Run</Button>);
    const button = screen.getByRole("button", { name: "Run" });

    rerender(<Button loading={second.promise}>Run</Button>);
    first.resolve();
    await Promise.resolve();
    expect(button).toHaveAttribute("aria-busy", "true");

    second.reject();
    await waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
    expect(button).toBeEnabled();
  });
});
