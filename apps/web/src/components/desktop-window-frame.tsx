import type { MouseEventHandler, ReactNode } from "react";
import { handleDesktopWindowDrag } from "../platform/desktop-window";

interface DesktopWindowFrameProps {
  children: ReactNode;
  runtime: "browser" | "desktop" | "mobile";
}

const handleWindowFrameMouseDown: MouseEventHandler<HTMLDivElement> = (event) => {
  handleDesktopWindowDrag(event);
};

export function DesktopWindowFrame({ children, runtime }: DesktopWindowFrameProps) {
  return (
    <>
      {children}
      {runtime === "desktop" ? (
        <div
          aria-hidden="true"
          className="desktop-window-drag-surface"
          data-window-drag-behavior="drag-and-zoom"
          data-window-drag-surface="window-frame"
          onMouseDown={handleWindowFrameMouseDown}
          tabIndex={-1}
        />
      ) : null}
    </>
  );
}
