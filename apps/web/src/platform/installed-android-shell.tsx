import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";

export interface InstalledAndroidShellEntry {
  authorityId: string;
  revision: number;
  webEntryPath: string;
}

declare global {
  interface Window {
    __MISH_ANDROID_SHELL_PENDING__?: unknown[];
    __MISH_ANDROID_SHELL_SNAPSHOT__?: InstalledAndroidShellEntry;
    __MISH_APPLY_ANDROID_SHELL_ENTRY__?: (entry: unknown) => void;
    __MISH_INSTALLED_ANDROID_SHELL__?: boolean;
  }
}

const authorityPattern = /^[A-Za-z0-9._:-]{1,128}$/u;
const acceptedRootPattern = /^\/(?:status|routes|profiles|traffic|events|settings)(?:[/?]|$)/u;

export function isInstalledAndroidShellActive(targetWindow: Window = window) {
  return targetWindow.__MISH_INSTALLED_ANDROID_SHELL__ === true;
}

export function parseInstalledAndroidShellEntry(value: unknown): InstalledAndroidShellEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.authorityId !== "string" ||
    !authorityPattern.test(entry.authorityId) ||
    typeof entry.revision !== "number" ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision < 0 ||
    typeof entry.webEntryPath !== "string" ||
    entry.webEntryPath.length > 2_048 ||
    !acceptedRootPattern.test(entry.webEntryPath) ||
    entry.webEntryPath.startsWith("//") ||
    hasForbiddenLiteralCharacter(entry.webEntryPath) ||
    hasInvalidPercentEncoding(entry.webEntryPath)
  ) {
    return null;
  }
  return {
    authorityId: entry.authorityId,
    revision: entry.revision,
    webEntryPath: entry.webEntryPath,
  };
}

function hasForbiddenLiteralCharacter(value: string) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      character === "#" ||
      character === "\\" ||
      /\s/u.test(character) ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    ) {
      return true;
    }
  }
  return false;
}

function hasInvalidPercentEncoding(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") continue;
    const encoded = value.slice(index + 1, index + 3);
    if (!/^[0-9A-Fa-f]{2}$/u.test(encoded)) return true;
    const decoded = Number.parseInt(encoded, 16);
    if (decoded <= 0x1f || decoded === 0x7f || [0x2f, 0x3f, 0x23, 0x5c].includes(decoded)) {
      return true;
    }
    index += 2;
  }
  return false;
}

/** Consumes Native -> Shared Rust -> Web entries and intentionally exposes no return channel. */
export function InstalledAndroidShellEntryBridge() {
  const navigate = useNavigate();
  const accepted = useRef<InstalledAndroidShellEntry | null>(null);

  useEffect(() => {
    const apply = (candidate: unknown) => {
      const entry = parseInstalledAndroidShellEntry(candidate);
      if (!entry) return;
      const current = accepted.current;
      if (current?.authorityId === entry.authorityId && current.revision >= entry.revision) {
        return;
      }
      accepted.current = entry;
      window.__MISH_ANDROID_SHELL_SNAPSHOT__ = entry;
      navigate(entry.webEntryPath, { replace: true });
    };

    window.__MISH_APPLY_ANDROID_SHELL_ENTRY__ = apply;
    const pending = window.__MISH_ANDROID_SHELL_PENDING__ ?? [];
    window.__MISH_ANDROID_SHELL_PENDING__ = [];
    for (const entry of pending) apply(entry);

    return () => {
      if (window.__MISH_APPLY_ANDROID_SHELL_ENTRY__ === apply) {
        delete window.__MISH_APPLY_ANDROID_SHELL_ENTRY__;
      }
    };
  }, [navigate]);

  return null;
}
