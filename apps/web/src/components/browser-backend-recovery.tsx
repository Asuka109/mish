import type { StatusConnectionState } from "@mish/contracts";
import { Button, Spinner } from "@mish/ui";
import { ShieldCheck } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  | { phase: "disconnected" }
  | { phase: "searching" }
  | { phase: "cancelled" | "failed" | "not-found" }
  | { origin: string; phase: "found"; port: number };

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

  const reconnect = async () => {
    if (scanController.current) return;
    const controller = new AbortController();
    scanController.current = controller;
    setRecovery({ phase: "searching" });
    try {
      const result: BrowserBackendDiscoveryResult = await discover({
        currentPort: backendPort,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        setRecovery({ phase: "cancelled" });
      } else if (result.phase === "found") {
        setRecovery(result);
      } else {
        setRecovery({ phase: "not-found" });
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
        <dl className="browser-backend-recovery__details">
          <div>
            <dt>{LL.browserBackendRecovery.portLabel()}</dt>
            <dd className="tabular">{backendPort}</dd>
          </div>
        </dl>

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
            <Button onClick={cancel} variant="outline">
              {LL.browserBackendRecovery.cancel()}
            </Button>
          ) : recovery.phase !== "found" ? (
            <Button onClick={() => void reconnect()}>
              {recovery.phase === "disconnected"
                ? LL.browserBackendRecovery.reconnect()
                : LL.browserBackendRecovery.retry()}
            </Button>
          ) : null}
        </div>
      </section>
    </main>
  );
}

function recoveryStatus(LL: ReturnType<typeof useI18nContext>["LL"], recovery: RecoveryState) {
  switch (recovery.phase) {
    case "searching":
      return LL.browserBackendRecovery.searching();
    case "found":
      return LL.browserBackendRecovery.found({ port: recovery.port });
    case "not-found":
      return LL.browserBackendRecovery.notFound();
    case "cancelled":
      return LL.browserBackendRecovery.cancelled();
    case "failed":
      return LL.browserBackendRecovery.failed();
    default:
      return null;
  }
}
