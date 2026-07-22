import type { StatusConnectionState } from "@mish/contracts";
import { Button, Input, Spinner } from "@mish/ui";
import { ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useI18nContext } from "../i18n/i18n-react";
import {
  buildBrowserBackendUrl,
  discoverMishBrowserBackend,
  type BrowserBackendDiscoveryResult,
} from "../platform/browser-backend-discovery";

interface BrowserConnectionMonitor {
  getConnectionState(): StatusConnectionState;
  subscribeConnection(listener: (state: StatusConnectionState) => void): () => void;
}

type RecoveryState =
  | BrowserBackendDiscoveryResult
  | { phase: "disconnected" }
  | { phase: "searching"; port: number }
  | { phase: "cancelled" | "failed" };

interface BrowserBackendRecoveryProps {
  backendPort?: number;
  children: ReactNode;
  connection?: BrowserConnectionMonitor;
  discover?: typeof discoverMishBrowserBackend;
  navigate?: (origin: string) => void;
  onRecoveryRequired?: () => void;
  runtime: "browser" | "desktop" | "mobile";
}

export function BrowserBackendRecovery({
  backendPort,
  children,
  connection,
  discover = discoverMishBrowserBackend,
  navigate = (origin) => window.location.replace(buildBrowserBackendUrl(origin)),
  onRecoveryRequired,
  runtime,
}: BrowserBackendRecoveryProps) {
  const { LL } = useI18nContext();
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [recovery, setRecovery] = useState<RecoveryState>({ phase: "disconnected" });
  const [requestedPort, setRequestedPort] = useState(
    backendPort === undefined ? "" : String(backendPort),
  );
  const heading = useRef<HTMLHeadingElement | null>(null);
  const scanController = useRef<AbortController | null>(null);
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
    heading.current?.focus();
    onRecoveryRequired?.();
  }, [onRecoveryRequired, recoveryRequired]);

  useEffect(
    () => () => {
      scanController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (recovery.phase !== "found") return;
    const timer = window.setTimeout(() => navigate(recovery.origin), 400);
    return () => window.clearTimeout(timer);
  }, [navigate, recovery]);

  if (!recoveryRequired || runtime !== "browser" || backendPort === undefined) return children;
  const requestedBackendPort = parseBackendPort(requestedPort);

  const reconnect = async () => {
    if (scanController.current || requestedBackendPort === null) return;
    const controller = new AbortController();
    scanController.current = controller;
    setRecovery({ phase: "searching", port: requestedBackendPort });
    try {
      const result: BrowserBackendDiscoveryResult = await discover({
        preferredPort: requestedBackendPort,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        setRecovery({ phase: "cancelled" });
      } else if (result.phase === "found") {
        setRecovery(result);
      } else {
        setRecovery(result);
      }
    } catch (error) {
      setRecovery({
        phase:
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
            ? "cancelled"
            : "failed",
      });
    } finally {
      if (scanController.current === controller) scanController.current = null;
    }
  };

  const cancel = () => scanController.current?.abort();
  const status = recoveryStatus(LL, recovery);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void reconnect();
  };

  return (
    <main className="browser-backend-recovery">
      <section
        aria-busy={recovery.phase === "searching"}
        aria-labelledby="browser-backend-recovery-title"
      >
        <div className="browser-backend-recovery__icon" aria-hidden="true">
          <ShieldCheck weight="duotone" />
        </div>
        <p className="browser-backend-recovery__eyebrow">{LL.browserBackendRecovery.eyebrow()}</p>
        <h1 id="browser-backend-recovery-title" ref={heading} tabIndex={-1}>
          {LL.browserBackendRecovery.title()}
        </h1>
        <p>{LL.browserBackendRecovery.description()}</p>
        <form onSubmit={submit}>
          <div className="browser-backend-recovery__port-field">
            <label htmlFor="browser-backend-recovery-port">
              {LL.browserBackendRecovery.portLabel()}
            </label>
            <Input
              id="browser-backend-recovery-port"
              aria-describedby="browser-backend-recovery-port-hint"
              aria-invalid={requestedPort.length > 0 && requestedBackendPort === null}
              disabled={recovery.phase === "searching" || recovery.phase === "found"}
              inputMode="numeric"
              maxLength={5}
              onChange={(event) => {
                setRequestedPort(event.target.value.replace(/\D/g, "").slice(0, 5));
                if (recovery.phase !== "searching" && recovery.phase !== "found") {
                  setRecovery({ phase: "disconnected" });
                }
              }}
              pattern="[0-9]{1,5}"
              value={requestedPort}
            />
            <p id="browser-backend-recovery-port-hint" className="browser-backend-recovery__hint">
              {LL.browserBackendRecovery.portHint()}
            </p>
          </div>

          {status ? (
            <div
              aria-live="polite"
              className={`browser-backend-recovery__status browser-backend-recovery__status--${recovery.phase}`}
              role={
                recovery.phase === "failed" || recovery.phase === "not-found" ? "alert" : "status"
              }
            >
              {recovery.phase === "searching" ? <Spinner /> : null}
              <span>{status}</span>
            </div>
          ) : null}

          <div className="browser-backend-recovery__actions">
            {recovery.phase === "searching" ? (
              <Button onClick={cancel} type="button" variant="outline">
                {LL.browserBackendRecovery.cancel()}
              </Button>
            ) : recovery.phase !== "found" ? (
              <Button disabled={requestedBackendPort === null} type="submit">
                {recovery.phase === "disconnected"
                  ? LL.browserBackendRecovery.reconnect()
                  : LL.browserBackendRecovery.retry()}
              </Button>
            ) : null}
          </div>
        </form>
      </section>
    </main>
  );
}

function recoveryStatus(LL: ReturnType<typeof useI18nContext>["LL"], recovery: RecoveryState) {
  switch (recovery.phase) {
    case "searching":
      return LL.browserBackendRecovery.searching({ port: recovery.port });
    case "found":
      return LL.browserBackendRecovery.found({ port: recovery.port });
    case "not-found":
      return LL.browserBackendRecovery.notFound({
        emptyPorts: recovery.emptyPorts,
        occupiedPorts: recovery.occupiedPorts,
      });
    case "cancelled":
      return LL.browserBackendRecovery.cancelled();
    case "failed":
      return LL.browserBackendRecovery.failed();
    default:
      return null;
  }
}

function parseBackendPort(value: string) {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : null;
}
