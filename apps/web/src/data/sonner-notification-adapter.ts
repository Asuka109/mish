import { toast } from "sonner";
import { createElement } from "react";
import type { DeliveredNotification } from "./notification-delivery";

function ToastActionGroup({
  actions,
  execute,
  pendingActionId,
}: {
  actions: DeliveredNotification["actions"];
  execute(actionId: string): Promise<void>;
  pendingActionId?: string;
}) {
  const pending = Boolean(pendingActionId);

  return createElement(
    "span",
    { style: { display: "flex", gap: 4, marginLeft: "auto" } },
    actions.map((action) =>
      createElement(
        "button",
        {
          "aria-busy": pendingActionId === action.id || undefined,
          "data-button": true,
          "data-cancel": action.tone === "secondary" || undefined,
          "data-disabled": pending || undefined,
          disabled: pending,
          key: action.id,
          onClick: () => (pending ? undefined : void execute(action.id)),
          style: { marginLeft: 0, marginRight: 0 },
          type: "button",
        },
        action.label,
      ),
    ),
  );
}

/** The only production boundary allowed to call Sonner's imperative API. */
export function presentNotificationToast(
  notification: DeliveredNotification,
  execute: (actionId?: string) => Promise<void>,
) {
  const options = {
    description:
      notification.title && notification.detail
        ? createElement(
            "div",
            undefined,
            createElement("p", undefined, notification.message),
            notification.detail ? createElement("p", undefined, notification.detail) : undefined,
          )
        : (notification.detail ?? (notification.title ? notification.message : undefined)),
    duration: notification.duration,
    id: notification.id,
    action:
      notification.actions.length > 0
        ? createElement(ToastActionGroup, {
            actions: notification.actions,
            execute,
            pendingActionId: notification.pendingActionId,
          })
        : undefined,
    cancel: undefined,
  };
  const title = notification.title ?? notification.message;
  const hasOptions =
    options.action ||
    options.cancel ||
    options.description !== undefined ||
    options.duration !== undefined;
  if (!hasOptions) {
    const id = { id: notification.id };
    if (notification.level === "success") toast.success(title, id);
    else if (notification.level === "warning") toast.warning(title, id);
    else if (notification.level === "error") toast.error(title, id);
    else toast.info(title, id);
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
