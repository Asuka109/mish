import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createFixtureStatusClient } from "./fixture-status-client";
import type {
  RoutingMode,
  ServiceMonitorDraft,
  StatusClient,
  StatusSnapshotDto,
} from "./status-client";
import { useI18nContext } from "../i18n/i18n-react";

type ProductError = "command" | "load";

interface ProductContextValue {
  error: string | null;
  isLoading: boolean;
  removeServiceMonitor(monitorId: string): Promise<void>;
  restoreDefaultServices(): Promise<void>;
  selectGroupChild(groupId: string, childId: string): Promise<void>;
  setActiveProfile(profileId: string): Promise<void>;
  setCapture(systemProxyEnabled: boolean, tunEnabled: boolean): Promise<void>;
  setRoutingMode(mode: RoutingMode): Promise<void>;
  snapshot: StatusSnapshotDto | null;
  upsertServiceMonitor(draft: ServiceMonitorDraft): Promise<void>;
}

const ProductContext = createContext<ProductContextValue | null>(null);

interface ProductProviderProps {
  children: ReactNode;
  client?: StatusClient;
}

export function ProductProvider({ children, client }: ProductProviderProps) {
  const { LL } = useI18nContext();
  const resolvedClient = useMemo(() => client ?? createFixtureStatusClient(), [client]);
  const [snapshot, setSnapshot] = useState<StatusSnapshotDto | null>(null);
  const [error, setError] = useState<ProductError | null>(null);

  useEffect(() => {
    let active = true;
    resolvedClient
      .getSnapshot()
      .then((nextSnapshot) => {
        if (active) setSnapshot(nextSnapshot);
      })
      .catch(() => {
        if (active) setError("load");
      });

    return () => {
      active = false;
    };
  }, [resolvedClient]);

  async function runCommand(command: () => Promise<StatusSnapshotDto>) {
    setError(null);
    try {
      setSnapshot(await command());
    } catch {
      setError("command");
    }
  }

  const value: ProductContextValue = {
    error:
      error === "load" ? LL.errors.loadFixture() : error === "command" ? LL.errors.command() : null,
    isLoading: snapshot === null && error === null,
    removeServiceMonitor: (monitorId) =>
      runCommand(() => resolvedClient.removeServiceMonitor(monitorId)),
    restoreDefaultServices: () => runCommand(() => resolvedClient.restoreDefaultServices()),
    selectGroupChild: (groupId, childId) =>
      runCommand(() => resolvedClient.selectGroupChild(groupId, childId)),
    setActiveProfile: (profileId) => runCommand(() => resolvedClient.setActiveProfile(profileId)),
    setCapture: (systemProxyEnabled, tunEnabled) =>
      runCommand(() => resolvedClient.setCapture(systemProxyEnabled, tunEnabled)),
    setRoutingMode: (mode) => runCommand(() => resolvedClient.setRoutingMode(mode)),
    snapshot,
    upsertServiceMonitor: (draft) => runCommand(() => resolvedClient.upsertServiceMonitor(draft)),
  };

  return <ProductContext.Provider value={value}>{children}</ProductContext.Provider>;
}

export function useProduct() {
  const context = useContext(ProductContext);
  if (!context) throw new Error("useProduct must be used inside ProductProvider");
  return context;
}
