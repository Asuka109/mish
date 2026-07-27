import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

function prepareCurrentRoute(
  targetDocument: Document,
  moveFocus: boolean,
  headingSelector = "main h1",
) {
  const heading = targetDocument.querySelector<HTMLElement>(headingSelector);
  if (!heading) return false;

  heading.tabIndex = -1;
  if (moveFocus) heading.focus({ preventScroll: true });
  const title = heading.textContent?.trim();
  if (title) targetDocument.title = `${title} — Mish`;
  return true;
}

export function focusCurrentRoute(targetDocument: Document = document, headingSelector?: string) {
  return prepareCurrentRoute(targetDocument, true, headingSelector);
}

function watchCurrentRoute(
  onReady: () => void,
  shouldMoveFocus: () => boolean,
  targetDocument: Document = document,
  headingSelector?: string,
) {
  if (prepareCurrentRoute(targetDocument, shouldMoveFocus(), headingSelector)) {
    onReady();
    return () => undefined;
  }
  const main = targetDocument.querySelector("main");
  if (!main) return () => undefined;

  const observer = new MutationObserver(() => {
    if (!prepareCurrentRoute(targetDocument, shouldMoveFocus(), headingSelector)) return;
    observer.disconnect();
    onReady();
  });
  observer.observe(main, { childList: true, subtree: true });
  return () => observer.disconnect();
}

interface RouteFocusManagerProps {
  headingSelector?: string;
  scrollerSelector?: string;
}

export function RouteFocusManager({
  headingSelector = "main h1",
  scrollerSelector = "main .workspace-page-scroll",
}: RouteFocusManagerProps = {}) {
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);
  const scrollPositions = useRef(new Map<string, number>());

  useEffect(() => {
    const routeChanged = previousPathname.current !== pathname;
    previousPathname.current = pathname;
    let stopWatching: () => void = () => undefined;
    let pageScroller: HTMLElement | null = null;
    let restoreFrame = 0;
    const routeTrigger = document.activeElement;
    const rememberScrollPosition = () => {
      if (pageScroller) scrollPositions.current.set(pathname, pageScroller.scrollTop);
    };
    const restoreScrollPosition = () => {
      if (!pageScroller) return;
      const scrollTop = scrollPositions.current.get(pathname) ?? 0;
      pageScroller.scrollTop = scrollTop;
      restoreFrame = window.requestAnimationFrame(() => {
        if (pageScroller) pageScroller.scrollTop = scrollTop;
      });
    };
    pageScroller = document.querySelector<HTMLElement>(scrollerSelector);
    pageScroller?.addEventListener("scroll", rememberScrollPosition, { passive: true });
    const animationFrame = window.requestAnimationFrame(() => {
      stopWatching = watchCurrentRoute(
        restoreScrollPosition,
        () =>
          routeChanged &&
          (document.activeElement === routeTrigger || document.activeElement === document.body),
        document,
        headingSelector,
      );
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.cancelAnimationFrame(restoreFrame);
      stopWatching();
      pageScroller?.removeEventListener("scroll", rememberScrollPosition);
    };
  }, [headingSelector, pathname, scrollerSelector]);

  return null;
}
