import { Toaster } from "sonner";
import { useAppearance } from "../appearance";

const DEFAULT_NOTIFICATION_DURATION_MILLISECONDS = 8_000;

export function NotificationToaster() {
  const { resolvedAppearance } = useAppearance();
  const mobile =
    typeof document !== "undefined" && document.documentElement.dataset.runtime === "mobile";
  return (
    <Toaster
      closeButton
      duration={DEFAULT_NOTIFICATION_DURATION_MILLISECONDS}
      expand
      position={mobile ? "top-center" : "bottom-right"}
      theme={resolvedAppearance}
    />
  );
}
