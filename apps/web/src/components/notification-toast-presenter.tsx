import type { ApplicationActionId } from "@mish/contracts";
import { useEffect, useRef } from "react";
import { useNotificationDelivery } from "../data/notification-delivery";
import {
  dismissNotificationToast,
  presentNotificationToast,
} from "../data/sonner-notification-adapter";

const ignoreAction = async (_notificationId: string, _actionId: ApplicationActionId) => undefined;

interface NotificationToastPresenterProps {
  execute?(notificationId: string, actionId: ApplicationActionId): Promise<void>;
  pendingActions?: ReadonlyMap<string, ApplicationActionId>;
  suppressActions?: boolean;
}

export function NotificationToastPresenter({
  execute = ignoreAction,
  pendingActions,
  suppressActions = false,
}: NotificationToastPresenterProps) {
  const { completePresentation, toastEntries } = useNotificationDelivery();
  const presented = useRef<ReadonlyMap<string, string>>(new Map());
  const suppressedToastCompletions = useRef(new Set<string>());

  useEffect(() => {
    const nextPresented = new Map<string, string>();
    for (const notification of toastEntries) {
      if (notification.toast !== "present") {
        suppressedToastCompletions.current.add(notification.id);
        dismissNotificationToast(notification.id);
        completePresentation(notification.id, "suppressed");
        continue;
      }
      const presentedNotification = {
        ...notification,
        actions: suppressActions ? [] : notification.actions,
        pendingActionId: pendingActions?.get(notification.id),
      };
      const signature = JSON.stringify({
        actions: presentedNotification.actions.map(({ id }) => id),
        detail: presentedNotification.detail,
        level: presentedNotification.level,
        message: presentedNotification.message,
        pendingActionId: presentedNotification.pendingActionId,
        presentationAttempt: presentedNotification.presentationAttempt,
        title: presentedNotification.title,
        toast: presentedNotification.toast,
      });
      nextPresented.set(notification.id, signature);
      if (presented.current.get(notification.id) !== signature) {
        presentNotificationToast(
          presentedNotification,
          (actionId) => execute(notification.id, actionId),
          {
            onAutoClose: () => completePresentation(notification.id, "timed-out"),
            onDismiss: () => {
              if (suppressedToastCompletions.current.delete(notification.id)) return;
              completePresentation(notification.id, "dismissed");
            },
          },
        );
      }
    }
    for (const id of presented.current.keys()) {
      if (nextPresented.has(id)) continue;
      suppressedToastCompletions.current.add(id);
      dismissNotificationToast(id);
    }
    presented.current = nextPresented;
  }, [completePresentation, execute, pendingActions, suppressActions, toastEntries]);

  return null;
}
