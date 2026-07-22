import { toast } from "sonner";
import { createElement, useState } from "react";
import type { DeliveredNotification } from "./notification-delivery";

function ToastActionGroup({
  actions,
  execute,
}: {
  actions: DeliveredNotification["actions"];
  execute(actionId: string): Promise<void>;
}) {
  const [pendingActionId, setPendingActionId] = useState<string>();
  const pending = Boolean(pendingActionId);

  async function run(actionId: string) {
    if (pending) return;
    setPendingActionId(actionId);
    try {
      await execute(actionId);
    } finally {
      setPendingActionId(undefined);
    }
  }

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
          onClick: () => void run(action.id),
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
        ? createElement(ToastActionGroup, { actions: notification.actions, execute })
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
