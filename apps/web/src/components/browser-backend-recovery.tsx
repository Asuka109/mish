import type { StatusConnectionState } from "@mish/contracts";
import { Button, Input } from "@mish/ui";
import { ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cx, tv } from "@mish/ui/tv";
import { useI18nContext } from "../i18n/i18n-react";
import {
  buildBrowserBackendUrl,
  discoverMishBrowserBackend,
  MISH_BROWSER_DISCOVERY_START_PORT,
  probeMishBrowserBackend,
  type BrowserBackendDiscoveryResult,
} from "../platform/browser-backend-discovery";

interface BrowserConnectionMonitor {
  getConnectionState(): StatusConnectionState;
  subscribeConnection(listener: (state: StatusConnectionState) => void): () => void;
}

type RecoveryState =
  | Extract<BrowserBackendDiscoveryResult, { phase: "not-found" }>
  | { phase: "connect-failed" | "connecting"; port: number }
  | { phase: "disconnected" | "scan-failed" | "scanning" };

interface RecoveryOperation {
  controller: AbortController;
}

interface BrowserBackendRecoveryProps {
  backendPort?: number;
  children: ReactNode;
  connection?: BrowserConnectionMonitor;
  discover?: typeof discoverMishBrowserBackend;
  navigate?: (origin: string) => Promise<void> | void;
  onRecoveryRequired?: () => void;
  probe?: typeof probeMishBrowserBackend;
  runtime: "browser" | "desktop" | "mobile";
}

const recoveryStyles = tv({
  slots: {
    root: cx(
      "browser-backend-recovery fixed inset-0 flex items-center justify-center bg-surface-soft",
      "p-xl font-sans text-ink",
    ),
    card: "w-full max-w-dialog rounded-lg border border-hairline bg-canvas p-xl shadow-panel",
    icon: "mb-md flex size-11 items-center justify-center rounded-md bg-accent text-focus-accent [&_svg]:size-6",
    eyebrow: "text-metadata text-muted-foreground",
    title: "my-xs mb-sm text-title font-semibold",
    form: "mt-lg",
    portField: cx(
      "[&_label]:mb-xs [&_label]:block [&_label]:text-body [&_label]:font-semibold",
      "[&_label]:text-ink [&_.ui-input]:w-full [&_.ui-input]:font-mono",
    ),
    fieldError: "mt-xs text-metadata text-error",
    actions: "mt-lg grid grid-cols-2 gap-sm [&_.ui-button]:w-full",
    statusRegion: "mt-md min-h-11",
    status: "text-body text-error",
  },
});

export function BrowserBackendRecovery({
  backendPort,
  children,
  connection,
  discover = discoverMishBrowserBackend,
  navigate = (origin) => window.location.replace(buildBrowserBackendUrl(origin)),
  onRecoveryRequired,
  probe = probeMishBrowserBackend,
  runtime,
}: BrowserBackendRecoveryProps) {
  const { LL } = useI18nContext();
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryState>({ phase: "disconnected" });
  const [requestedPort, setRequestedPort] = useState(
    backendPort === undefined ? "" : String(backendPort),
  );
  const heading = useRef<HTMLHeadingElement | null>(null);
  const portInput = useRef<HTMLInputElement | null>(null);
  const activeOperation = useRef<RecoveryOperation | null>(null);
  const componentActive = useRef(true);
  const recoveryNotified = useRef(false);

  useEffect(() => {
    if (runtime !== "browser" || !connection || backendPort === undefined) return;
    let connected = connection.getConnectionState().phase === "connected";
    return connection.subscribeConnection((state) => {
      if (state.phase === "connected") connected = true;
      if (connected && state.phase === "disconnected") setRecoveryRequired(true);
    });
  }, [backendPort, connection, runtime]);

  useEffect(() => {
    if (!recoveryRequired || recoveryNotified.current) return;
    recoveryNotified.current = true;
    heading.current?.focus({ preventScroll: true });
    onRecoveryRequired?.();
  }, [onRecoveryRequired, recoveryRequired]);

  useEffect(() => {
    componentActive.current = true;
    return () => {
      componentActive.current = false;
      activeOperation.current?.controller.abort();
      activeOperation.current = null;
    };
  }, []);

  if (!recoveryRequired || runtime !== "browser" || backendPort === undefined) return children;
  const requestedBackendPort = parseBackendPort(requestedPort);
  const pending = recovery.phase === "connecting" || recovery.phase === "scanning";
  const invalidPort = requestedBackendPort === null;

  const beginOperation = () => {
    if (activeOperation.current) return null;
    const operation = {
      controller: new AbortController(),
    };
    activeOperation.current = operation;
    return operation;
  };

  const operationIsCurrent = (operation: RecoveryOperation) =>
    componentActive.current &&
    activeOperation.current === operation &&
    !operation.controller.signal.aborted;

  const finishOperation = (operation: RecoveryOperation) => {
    if (activeOperation.current === operation) activeOperation.current = null;
  };

  const connectToPort = async (port: number, operation: RecoveryOperation) => {
    if (!operationIsCurrent(operation)) return;
    setRecovery({ phase: "connecting", port });
    try {
      const result = await probe({ port, signal: operation.controller.signal });
      if (!operationIsCurrent(operation)) return;
      if (result.phase !== "found") {
        setRecovery({ phase: "connect-failed", port });
        finishOperation(operation);
        return;
      }
      await navigate(result.origin);
      // A successful navigation unloads this view. Keep the operation pending until then.
    } catch {
      if (!operationIsCurrent(operation)) return;
      setRecovery({ phase: "connect-failed", port });
      finishOperation(operation);
    }
  };

  const connect = () => {
    if (requestedBackendPort === null) {
      portInput.current?.focus();
      return;
    }
    const operation = beginOperation();
    if (!operation) return;
    void connectToPort(requestedBackendPort, operation);
  };

  const scan = async () => {
    const operation = beginOperation();
    if (!operation) return;
    setRecovery({ phase: "scanning" });
    try {
      const result: BrowserBackendDiscoveryResult = await discover({
        preferredPort: MISH_BROWSER_DISCOVERY_START_PORT,
        signal: operation.controller.signal,
      });
      if (!operationIsCurrent(operation)) return;
      if (result.phase === "not-found") {
        setRecovery(result);
        finishOperation(operation);
        return;
      }
      flushSync(() => setRequestedPort(String(result.port)));
      await connectToPort(result.port, operation);
    } catch {
      if (!operationIsCurrent(operation)) return;
      setRecovery({ phase: "scan-failed" });
      finishOperation(operation);
    }
  };

  const status = recoveryStatus(LL, recovery);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    connect();
  };

  return (
    <main className={recoveryStyles().root()}>
      <section
        aria-busy={pending}
        aria-labelledby="browser-backend-recovery-title"
        className={recoveryStyles().card()}
      >
        <div className={recoveryStyles().icon()} aria-hidden="true">
          <ShieldCheck weight="duotone" />
        </div>
        <p className={recoveryStyles().eyebrow()}>{LL.browserBackendRecovery.eyebrow()}</p>
        <h1
          className={recoveryStyles().title()}
          id="browser-backend-recovery-title"
          ref={heading}
          tabIndex={-1}
        >
          {LL.browserBackendRecovery.title()}
        </h1>
        <form className={recoveryStyles().form()} onSubmit={submit}>
          <div className={recoveryStyles().portField()}>
            <label htmlFor="browser-backend-recovery-port">
              {LL.browserBackendRecovery.portLabel()}
            </label>
            <Input
              id="browser-backend-recovery-port"
              aria-describedby={invalidPort ? "browser-backend-recovery-port-error" : undefined}
              aria-invalid={invalidPort}
              disabled={pending}
              inputMode="numeric"
              maxLength={5}
              onChange={(event) => {
                setRequestedPort(event.target.value.replace(/\D/g, "").slice(0, 5));
                if (!activeOperation.current) {
                  setRecovery({ phase: "disconnected" });
                }
              }}
              pattern="[0-9]{1,5}"
              ref={portInput}
              value={requestedPort}
            />
            {invalidPort ? (
              <p className={recoveryStyles().fieldError()} id="browser-backend-recovery-port-error">
                {LL.browserBackendRecovery.invalidPort()}
              </p>
            ) : null}
          </div>

          <div className={recoveryStyles().actions()}>
            <Button
              disabled={pending || requestedBackendPort === null}
              loading={recovery.phase === "connecting"}
              loadingText={LL.browserBackendRecovery.connecting()}
              type="submit"
            >
              {LL.browserBackendRecovery.connect()}
            </Button>
            <Button
              disabled={pending}
              loading={recovery.phase === "scanning"}
              loadingText={LL.browserBackendRecovery.scanning()}
              onClick={() => void scan()}
              type="button"
              variant="outline"
            >
              {LL.browserBackendRecovery.scan()}
            </Button>
          </div>
          <div className={recoveryStyles().statusRegion()}>
            {status ? (
              <div
                aria-live="assertive"
                className={recoveryStyles().status()}
                data-phase={recovery.phase}
                role="alert"
              >
                <span>{status}</span>
              </div>
            ) : null}
          </div>
        </form>
      </section>
    </main>
  );
}

function recoveryStatus(LL: ReturnType<typeof useI18nContext>["LL"], recovery: RecoveryState) {
  switch (recovery.phase) {
    case "not-found":
      return LL.browserBackendRecovery.notFound();
    case "connect-failed":
      return LL.browserBackendRecovery.connectFailed({ port: recovery.port });
    case "scan-failed":
      return LL.browserBackendRecovery.scanFailed();
    default:
      return null;
  }
}

function parseBackendPort(value: string) {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
}
