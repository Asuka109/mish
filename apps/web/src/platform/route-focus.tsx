import { useEffect, useRef } from "react";
import { useLocation } from "react-router";

function prepareCurrentRoute(targetDocument: Document, moveFocus: boolean) {
  const heading = targetDocument.querySelector<HTMLElement>("main h1");
  if (!heading) return false;

  heading.tabIndex = -1;
  if (moveFocus) heading.focus({ preventScroll: true });
  const title = heading.textContent?.trim();
  if (title) targetDocument.title = `${title} — Mish`;
  return true;
}

export function focusCurrentRoute(targetDocument: Document = document) {
  return prepareCurrentRoute(targetDocument, true);
}

function watchCurrentRoute(
  onReady: () => void,
  shouldMoveFocus: () => boolean,
  targetDocument: Document = document,
) {
  if (prepareCurrentRoute(targetDocument, shouldMoveFocus())) {
    onReady();
    return () => undefined;
  }
  const main = targetDocument.querySelector("main");
  if (!main) return () => undefined;

  const observer = new MutationObserver(() => {
    if (!prepareCurrentRoute(targetDocument, shouldMoveFocus())) return;
    observer.disconnect();
    onReady();
  });
  observer.observe(main, { childList: true, subtree: true });
  return () => observer.disconnect();
}

export function RouteFocusManager() {
  const { pathname } = useLocation();
  const previousPathname = useRef(pathname);
  const scrollPositions = useRef(new Map<string, number>());

  useEffect(() => {
    const routeChanged = previousPathname.current !== pathname;
    previousPathname.current = pathname;
    let stopWatching: () => void = () => undefined;
    let pageScroller: HTMLElement | null = null;
    const routeTrigger = document.activeElement;
    const rememberScrollPosition = () => {
      if (pageScroller) scrollPositions.current.set(pathname, pageScroller.scrollTop);
    };
    const restoreScrollPosition = () => {
      pageScroller = document.querySelector<HTMLElement>("main .page-scroll");
      if (!pageScroller) return;
      pageScroller.scrollTop = scrollPositions.current.get(pathname) ?? 0;
      pageScroller.addEventListener("scroll", rememberScrollPosition, { passive: true });
    };
    const animationFrame = window.requestAnimationFrame(() => {
      stopWatching = watchCurrentRoute(
        restoreScrollPosition,
        () =>
          routeChanged &&
          (document.activeElement === routeTrigger || document.activeElement === document.body),
      );
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      stopWatching();
      rememberScrollPosition();
      pageScroller?.removeEventListener("scroll", rememberScrollPosition);
    };
  }, [pathname]);

  return null;
}
