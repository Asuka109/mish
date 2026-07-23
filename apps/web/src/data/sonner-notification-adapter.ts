import { toast } from "sonner";
import { cx, tv } from "@mish/ui/tv";
import { createElement } from "react";
import type { DeliveredNotification } from "./notification-delivery";

const notificationToastStyles = tv({
  slots: {
    action: "notification-toast-action min-w-0 max-w-full whitespace-nowrap",
    actions: cx(
      "notification-toast-actions col-start-2 row-start-2 mt-2 flex min-w-0 max-w-full",
      "flex-wrap gap-1.5",
    ),
    copy: "notification-toast-copy min-w-0 cursor-text pr-6 select-text",
    toast: "notification-toast",
  },
});

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
  const styles = notificationToastStyles();

  return createElement(
    "span",
    { className: styles.actions() },
    actions.map((action) =>
      createElement(
        "button",
        {
          "aria-busy": pendingActionId === action.id || undefined,
          className: styles.action(),
          "data-button": true,
          "data-cancel": action.tone === "secondary" || undefined,
          "data-disabled": pending || undefined,
          disabled: pending,
          key: action.id,
          onClick: () => (pending ? undefined : void execute(action.id)),
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
  const styles = notificationToastStyles();
  const options = {
    className: styles.toast(),
    classNames: { content: styles.copy() },
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
  if (notification.level === "success") toast.success(title, options);
  else if (notification.level === "warning") toast.warning(title, options);
  else if (notification.level === "error") toast.error(title, options);
  else toast.info(title, options);
}

export function dismissNotificationToast(id: string) {
  toast.dismiss(id);
}
