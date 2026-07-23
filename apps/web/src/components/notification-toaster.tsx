import { Toaster } from "sonner";
import { useAppearance } from "../appearance";

export function NotificationToaster() {
  const { resolvedAppearance } = useAppearance();
  return <Toaster closeButton expand position="bottom-right" theme={resolvedAppearance} />;
}
