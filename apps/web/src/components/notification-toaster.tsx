import { Toaster } from "sonner";
import { useAppearance } from "../appearance";

const DEFAULT_NOTIFICATION_DURATION_MILLISECONDS = 8_000;

export function NotificationToaster() {
  const { resolvedAppearance } = useAppearance();
  return (
    <Toaster
      closeButton
      duration={DEFAULT_NOTIFICATION_DURATION_MILLISECONDS}
      expand
      position="bottom-right"
      theme={resolvedAppearance}
    />
  );
}
