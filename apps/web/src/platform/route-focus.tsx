import { useEffect } from "react";
import { useLocation } from "react-router";

export function focusCurrentRoute(targetDocument: Document = document) {
  const heading = targetDocument.querySelector<HTMLElement>("main h1");
  if (!heading) return false;

  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  const title = heading.textContent?.trim();
  if (title) targetDocument.title = `${title} — Mish`;
  return true;
}

function watchCurrentRoute(targetDocument: Document = document) {
  if (focusCurrentRoute(targetDocument)) return () => undefined;
  const main = targetDocument.querySelector("main");
  if (!main) return () => undefined;

  const observer = new MutationObserver(() => {
    if (focusCurrentRoute(targetDocument)) observer.disconnect();
  });
  observer.observe(main, { childList: true, subtree: true });
  return () => observer.disconnect();
}

export function RouteFocusManager() {
  const { pathname } = useLocation();

  useEffect(() => {
    let stopWatching: () => void = () => undefined;
    const animationFrame = window.requestAnimationFrame(() => {
      stopWatching = watchCurrentRoute();
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      stopWatching();
    };
  }, [pathname]);

  return null;
}
