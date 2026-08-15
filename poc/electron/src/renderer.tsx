import React, { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createStore, useMishStore } from "@mish/poc-query-store";

import type { OrpcAdmissionResult, StoreReport } from "./electron-api.ts";

interface FixtureState {
  readonly count: number;
}

const store = createStore<FixtureState>({ count: 0 });

function reportStore(report: StoreReport): void {
  window.mishElectron.reportStore(report);
}

function StoreProbe({
  label,
  onRemount,
  onCleanup,
  onNotify,
}: {
  readonly label: "first" | "remount";
  readonly onRemount: () => void;
  readonly onCleanup: () => void;
  readonly onNotify: () => void;
}): React.ReactElement {
  const count = useMishStore(store, (state) => state.count);
  const notified = useRef(false);

  useEffect(() => {
    reportStore({ kind: "store-mounted", label });
    return () => {
      reportStore({ kind: "store-cleaned", label });
      onCleanup();
    };
  }, [label, onCleanup]);

  useEffect(() => {
    if (count === 0 || notified.current) return;
    notified.current = true;
    reportStore({ kind: "store-notified", count });
    onNotify();
  }, [count, onNotify]);

  useEffect(() => {
    if (label === "remount") onRemount();
  }, [label, onRemount]);

  return React.createElement("output", { "data-count": count }, String(count));
}

function AdmissionRenderer(): React.ReactElement {
  const [label, setLabel] = useState<"first" | "remount">("first");
  const [admission, setAdmission] = useState<OrpcAdmissionResult>();
  const notificationCount = useRef(0);
  const cleanupCount = useRef(0);
  const completed = useRef(false);

  const onCleanup = (): void => {
    cleanupCount.current += 1;
  };

  const onNotify = (): void => {
    notificationCount.current += 1;
  };

  useEffect(() => {
    void window.mishElectron.runOrpcAdmission().then((result) => {
      setAdmission(result);
      store.batch(() => {
        store.setState({ count: 1 });
        store.setState({ count: 2 });
      });
      reportStore({ kind: "store-batched", count: 2 });
      setLabel("remount");
    });
  }, []);

  const onRemount = (): void => {
    if (completed.current || !admission) return;
    completed.current = true;
    window.mishElectron.rendererReady({
      orpc: admission,
      store: {
        notifications: notificationCount.current,
        cleanups: cleanupCount.current,
        remounted: true,
      },
    });
  };

  useEffect(() => {
    const unsubscribe = store.subscribe(() => {
      notificationCount.current += 1;
    });
    return () => {
      unsubscribe();
      cleanupCount.current += 1;
    };
  }, []);

  return React.createElement(
    StrictMode,
    null,
    React.createElement(StoreProbe, { key: label, label, onRemount, onCleanup, onNotify }),
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Electron fixture root is missing");
createRoot(rootElement).render(React.createElement(AdmissionRenderer));
