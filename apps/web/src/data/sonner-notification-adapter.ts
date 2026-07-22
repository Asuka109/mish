import { toast } from "sonner";
import type { DeliveredNotification } from "./notification-delivery";

/** The only production boundary allowed to call Sonner's imperative API. */
export function presentNotificationToast(
  notification: DeliveredNotification,
  execute: (actionId?: string) => void,
) {
  const primaryAction = notification.actions.find((action) => action.tone !== "secondary");
  const secondaryAction = notification.actions.find((action) => action.tone === "secondary");
  const options = {
    description: notification.detail ?? notification.message,
    duration: notification.duration,
    id: notification.id,
    action: primaryAction
      ? {
          label: primaryAction.label,
          onClick: () => execute(primaryAction.id),
        }
      : undefined,
    cancel: secondaryAction
      ? {
          label: secondaryAction.label,
          onClick: () => execute(secondaryAction.id),
        }
      : undefined,
  };
  const title = notification.title ?? notification.message;
  const hasOptions =
    options.action ||
    options.cancel ||
    options.description !== title ||
    options.duration !== undefined;
  if (!hasOptions) {
    if (notification.level === "success") toast.success(title);
    else if (notification.level === "warning") toast.warning(title);
    else if (notification.level === "error") toast.error(title);
    else toast.info(title);
    return;
  }
  if (notification.level === "success") toast.success(title, options);
  else if (notification.level === "warning") toast.warning(title, options);
  else if (notification.level === "error") toast.error(title, options);
  else toast.info(title, options);
}

export function dismissNotificationToast(id: string) {
  toast.dismiss(id);
}
