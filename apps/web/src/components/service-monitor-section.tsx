import { ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { PencilSimple } from "@phosphor-icons/react/PencilSimple";
import { Plus } from "@phosphor-icons/react/Plus";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  Input,
  SectionGrid,
  Spinner,
} from "@mish/ui";
import { useEffect, useMemo, useState } from "react";
import { cx, tv } from "@mish/ui/tv";
import { notificationPublication, useNotificationDelivery } from "../data/notification-delivery";
import { useProduct } from "../data/product-provider";
import {
  createServiceMonitorEditorAuthority,
  type ServiceMonitorEditorAuthority,
} from "../data/service-monitor-editor-operation";
import { getCommandDescriptionId } from "../data/status-capabilities";
import {
  SERVICE_ICON_URLS,
  ServiceIconUrlSchema,
  type ServiceMonitorDraft,
  type ServiceMonitorDto,
  type ServiceProbeResultDto,
} from "@mish/contracts";
import { useI18nContext } from "../i18n/i18n-react";

const serviceProbeIntervals = [0, 5, 10, 30, 60] as const;
const serviceMonitorLimit = 12;
const serviceMonitorMediumColumnCount = 3;
const serviceMonitorWideColumnCount = 4;
const maximumDisplayedLatency = 9999;
const defaultServiceIconUrls = new Set<string>(Object.values(SERVICE_ICON_URLS));

const serviceStyles = tv({
  slots: {
    section: "service-monitor-section mt-7",
    heading: "service-monitor-heading flex min-h-11 items-center justify-between gap-4 px-1 pb-2.5",
    headingCopy: "flex min-w-0 items-baseline gap-2",
    trigger: cx(
      "inline-flex h-8.5 items-center justify-center gap-1.75 rounded-md border border-transparent",
      "bg-transparent px-2.25 text-metadata text-muted-foreground hover:border-hairline",
      "hover:bg-accent hover:text-ink data-popup-open:border-hairline data-popup-open:bg-accent",
      "data-popup-open:text-ink [&_svg]:size-3",
    ),
    unavailable: cx(
      "service-manage-unavailable block max-w-59 px-2.25 pt-1.5 pb-2 text-caption leading-4.25",
      "font-normal whitespace-normal text-muted-foreground",
    ),
    intervalLabel:
      "service-interval-label block px-2.25 pt-1.5 pb-0.75 text-caption leading-4.25 font-medium text-muted-foreground",
    list: cx(
      "service-monitor-list [--section-grid-columns:3] bg-hairline-soft",
      "service-grid-wide:[--section-grid-columns:4]",
      "max-page-compact:[--section-grid-columns:1]",
      "runtime-mobile:[--section-grid-columns:1]",
    ),
    row: cx(
      "service-monitor-cell service-monitor-row grid min-h-13 min-w-0",
      "grid-cols-[minmax(0,1fr)_minmax(74px,144px)_76px_minmax(0,1fr)] items-center gap-2.5",
      "overflow-clip rounded-none border-0 bg-canvas py-0 pr-3.25 pl-2.75 text-left text-fg",
      "hover:bg-accent hover:text-ink",
    ),
    placeholder: "service-monitor-cell service-monitor-placeholder min-h-13 border-0 bg-canvas",
    identity: cx(
      "service-monitor-identity col-start-2 grid min-w-0 grid-cols-[22px_minmax(0,1fr)]",
      "items-center gap-2.5 [&_strong]:overflow-hidden [&_strong]:text-left [&_strong]:text-body",
      "[&_strong]:font-medium [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap",
    ),
    icon: cx(
      "service-monitor-icon grid size-5.5 place-items-center text-muted-foreground",
      "theme-dark:[&_[data-monochrome=true]]:invert [&_img]:block [&_img]:size-4.5",
      "[&_img]:object-contain [&_img]:opacity-75",
    ),
    latency: cx(
      "service-monitor-latency col-start-3 block justify-self-stretch text-right text-metadata",
      "whitespace-nowrap text-success-text data-[status=error]:text-error",
      "data-[status=warning]:text-warning [&_.ui-spinner]:size-3.25",
    ),
    managerDialog: cx(
      "service-manager-dialog w-[min(420px,calc(100vw_-_32px))] [&_.dialog-header]:justify-between",
      "[&_.dialog-header]:gap-md [&_.dialog-header>div]:min-w-0",
    ),
    managerList:
      "service-manager-list max-h-[min(360px,calc(100vh_-_180px))] overflow-auto pt-1 pb-1.5",
    managerRow: cx(
      "service-manager-row grid min-h-11.5 w-full grid-cols-[22px_minmax(0,1fr)_16px] items-center",
      "justify-stretch gap-2.5 rounded-none border-0 px-4 py-0 text-left [&+&]:border-t",
      "[&+&]:border-hairline-soft [&_strong]:overflow-hidden [&_strong]:text-body",
      "[&_strong]:font-medium [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap",
      "[&>svg]:justify-self-end [&>svg]:text-muted-foreground",
    ),
    managerFooter: "service-manager-footer justify-start",
    editorDialog: "w-[min(460px,calc(100vw_-_32px))]",
    editorForm: "grid gap-4 px-4 pt-4",
    editorFooter: "mt-0.5 -mx-4 mb-0 justify-between",
    footerActions: "flex gap-2",
  },
});

function serviceMonitorCellCorners(index: number, serviceCount: number) {
  const mediumCellCount =
    Math.ceil(serviceCount / serviceMonitorMediumColumnCount) * serviceMonitorMediumColumnCount;
  const wideCellCount =
    Math.ceil(serviceCount / serviceMonitorWideColumnCount) * serviceMonitorWideColumnCount;

  return cx(
    index === 0 && "rounded-ss-section-grid-inner",
    index === serviceMonitorMediumColumnCount - 1 && "rounded-se-section-grid-inner",
    index === mediumCellCount - serviceMonitorMediumColumnCount && "rounded-es-section-grid-inner",
    index === mediumCellCount - 1 && "rounded-ee-section-grid-inner",
    "service-grid-wide:rounded-none",
    index === 0 && "service-grid-wide:rounded-ss-section-grid-inner",
    index === serviceMonitorWideColumnCount - 1 &&
      "service-grid-wide:rounded-se-section-grid-inner",
    index === wideCellCount - serviceMonitorWideColumnCount &&
      "service-grid-wide:rounded-es-section-grid-inner",
    index === wideCellCount - 1 && "service-grid-wide:rounded-ee-section-grid-inner",
    "max-page-compact:rounded-none",
    index === 0 &&
      "max-page-compact:rounded-ss-section-grid-inner max-page-compact:rounded-se-section-grid-inner",
    index === serviceCount - 1 &&
      "max-page-compact:rounded-es-section-grid-inner max-page-compact:rounded-ee-section-grid-inner",
    "runtime-mobile:rounded-none",
    index === 0 &&
      "runtime-mobile:rounded-ss-section-grid-inner runtime-mobile:rounded-se-section-grid-inner",
    index === serviceCount - 1 &&
      "runtime-mobile:rounded-es-section-grid-inner runtime-mobile:rounded-ee-section-grid-inner",
  );
}

function formatLatency(latencyMilliseconds: number) {
  if (latencyMilliseconds > maximumDisplayedLatency) return ">9999ms";
  return `${latencyMilliseconds} ms`;
}

export type ServiceLatencyStatus = "error" | "pending" | "success" | "warning";

export function classifyServiceLatency(
  result: ServiceProbeResultDto | undefined,
  probeFailed: boolean,
): ServiceLatencyStatus {
  if (probeFailed || result?.status === "error") return "error";
  if (result?.status !== "healthy" || result.latencyMilliseconds === null) return "pending";
  return result.latencyMilliseconds > 1000 ? "warning" : "success";
}

function isValidProbeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidIconUrl(value: string) {
  return ServiceIconUrlSchema.safeParse(value).success;
}

interface ServiceIconImageProps {
  src: string;
}

export function normalizedServiceIconUrl(value: string) {
  return isValidIconUrl(value) ? value : SERVICE_ICON_URLS.fallback;
}

export function ServiceIconImage({ src }: ServiceIconImageProps) {
  const safeSource = normalizedServiceIconUrl(src);
  const [source, setSource] = useState(safeSource);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setSource(safeSource);
    setLoadFailed(false);
  }, [safeSource]);

  return (
    <img
      alt=""
      aria-hidden="true"
      data-monochrome={defaultServiceIconUrls.has(source) || undefined}
      data-service-icon-fallback={loadFailed || safeSource !== src || undefined}
      decoding="async"
      onError={() => {
        if (source === SERVICE_ICON_URLS.fallback) return;
        setLoadFailed(true);
        setSource(SERVICE_ICON_URLS.fallback);
      }}
      referrerPolicy="no-referrer"
      src={source}
    />
  );
}

interface ServiceEditorDialogProps {
  draft: ServiceMonitorDraft | null;
  editorAuthority: ServiceMonitorEditorAuthority;
  fixture: boolean;
  onClose(): void;
  setDraft(draft: ServiceMonitorDraft): void;
}

interface ServiceManagerDialogProps {
  commandPending: boolean;
  onAdd(): void;
  onClose(): void;
  onEdit(service: ServiceMonitorDto): void;
  onRestore(): void;
  open: boolean;
  restorePending: boolean;
  services: ServiceMonitorDto[];
}

function ServiceManagerDialog({
  commandPending,
  onAdd,
  onClose,
  onEdit,
  onRestore,
  open,
  restorePending,
  services,
}: ServiceManagerDialogProps) {
  const { LL } = useI18nContext();

  return (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
      <DialogContent className={serviceStyles().managerDialog()} closeLabel={LL.common.close()}>
        <DialogHeader>
          <div>
            <DialogTitle className="dialog-title">{LL.services.editServices()}</DialogTitle>
            <DialogDescription className="dialog-description">
              {LL.services.editServicesDescription()}
            </DialogDescription>
          </div>
          <Button
            disabled={commandPending || services.length >= serviceMonitorLimit}
            onClick={onAdd}
            title={services.length >= serviceMonitorLimit ? LL.services.serviceLimit() : undefined}
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            {LL.services.add()}
          </Button>
        </DialogHeader>
        <div className={serviceStyles().managerList()}>
          {services.map((service) => {
            return (
              <Button
                className={serviceStyles().managerRow()}
                disabled={commandPending}
                key={service.id}
                onClick={() => onEdit(service)}
                type="button"
                variant="ghost"
              >
                <span className={serviceStyles().icon()}>
                  <ServiceIconImage src={service.icon} />
                </span>
                <strong className="user-authored-label">{service.label}</strong>
                <PencilSimple aria-hidden="true" />
              </Button>
            );
          })}
        </div>
        <DialogFooter className={serviceStyles().managerFooter()}>
          <Button
            aria-busy={restorePending}
            disabled={commandPending || restorePending}
            onClick={onRestore}
            type="button"
            variant="outline"
          >
            {restorePending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ArrowCounterClockwise aria-hidden="true" data-icon="inline-start" />
            )}
            {LL.services.restoreDefaults()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ServiceEditorDialog({
  draft,
  editorAuthority,
  fixture,
  onClose,
  setDraft,
}: ServiceEditorDialogProps) {
  const { isCommandPending, removeServiceMonitor, upsertServiceMonitor } = useProduct();
  const { LL } = useI18nContext();
  const { publish } = useNotificationDelivery();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [editedFields, setEditedFields] = useState({ icon: false, label: false, url: false });
  const [pendingAction, setPendingAction] = useState<{
    kind: "delete" | "save";
    promise: Promise<void>;
  } | null>(null);
  if (!draft) return null;

  const iconInvalid = !isValidIconUrl(draft.icon);
  const labelInvalid = draft.label.trim().length === 0;
  const urlInvalid = !isValidProbeUrl(draft.url);
  const showIconError = iconInvalid && editedFields.icon;
  const showLabelError = labelInvalid && editedFields.label;
  const showUrlError = urlInvalid && editedFields.url;
  const canSave = !iconInvalid && !labelInvalid && !urlInvalid;
  const existingService = Boolean(draft.id);
  const commandPending = isCommandPending("services") || editorAuthority.isPending();

  function closeEditor() {
    const operation = editorAuthority.current();
    if (operation?.phase === "pending") editorAuthority.cancel(operation);
    onClose();
  }

  function saveService() {
    if (!draft || !canSave) return;
    const operation = editorAuthority.begin("save");
    if (!operation) return;
    const promise = upsertServiceMonitor(draft)
      .then((result) => {
        const accepted = editorAuthority.complete(operation, result.ok ? "success" : "failure");
        if (!accepted || !result.ok) return;
        publish(
          notificationPublication("service.saved", {
            data: { operation: existingService ? "updated" : "added" },
            severity: "success",
          }),
        );
        closeEditor();
      })
      .catch(() => {
        editorAuthority.complete(operation, "failure");
      });
    setPendingAction({ kind: "save", promise });
  }

  function deleteService() {
    if (!draft?.id) return;
    const operation = editorAuthority.begin("reset");
    if (!operation) return;
    const promise = removeServiceMonitor(draft.id)
      .then((result) => {
        const accepted = editorAuthority.complete(operation, result.ok ? "success" : "failure");
        if (!accepted || !result.ok) return;
        publish(
          notificationPublication("service.removed", {
            severity: "success",
          }),
        );
        setDeleteConfirmOpen(false);
        closeEditor();
      })
      .catch(() => {
        editorAuthority.complete(operation, "failure");
      });
    setPendingAction({ kind: "delete", promise });
  }

  return (
    <Dialog onOpenChange={(open) => !open && closeEditor()} open>
      <DialogContent className={serviceStyles().editorDialog()} closeLabel={LL.common.close()}>
        <DialogHeader>
          <div>
            <DialogTitle className="dialog-title">
              {existingService ? LL.services.edit() : LL.services.add()}
            </DialogTitle>
            <DialogDescription className="dialog-description">
              {fixture
                ? LL.services.fixtureMetadataDescription()
                : LL.services.metadataDescription()}
            </DialogDescription>
          </div>
        </DialogHeader>
        <form
          className={serviceStyles().editorForm()}
          onSubmit={(event) => {
            event.preventDefault();
            saveService();
          }}
        >
          <FieldGroup>
            <Field data-invalid={showLabelError || undefined}>
              <FieldLabel htmlFor="service-title">{LL.services.title()}</FieldLabel>
              <Input
                aria-invalid={showLabelError || undefined}
                autoFocus
                id="service-title"
                onValueChange={(value) => {
                  setEditedFields((fields) => ({ ...fields, label: true }));
                  setDraft({ ...draft, label: value });
                }}
                placeholder={LL.services.serviceName()}
                value={draft.label}
              />
              {showLabelError ? <FieldError>{LL.services.labelError()}</FieldError> : null}
            </Field>
            <Field data-invalid={showIconError || undefined}>
              <FieldLabel htmlFor="service-icon-url">{LL.services.iconUrl()}</FieldLabel>
              <Input
                aria-invalid={showIconError || undefined}
                id="service-icon-url"
                inputMode="url"
                onValueChange={(value) => {
                  setEditedFields((fields) => ({ ...fields, icon: true }));
                  setDraft({ ...draft, icon: value });
                }}
                placeholder="https://example.com/icon.svg"
                spellCheck={false}
                type="text"
                value={draft.icon}
              />
              <FieldDescription>{LL.services.iconUrlDescription()}</FieldDescription>
              {showIconError ? <FieldError>{LL.services.iconUrlError()}</FieldError> : null}
            </Field>
            <Field data-invalid={showUrlError || undefined}>
              <FieldLabel htmlFor="service-probe-url">{LL.services.probeUrl()}</FieldLabel>
              <Input
                aria-invalid={showUrlError || undefined}
                id="service-probe-url"
                onValueChange={(value) => {
                  setEditedFields((fields) => ({ ...fields, url: true }));
                  setDraft({ ...draft, url: value });
                }}
                placeholder="https://example.com/generate_204"
                spellCheck={false}
                type="url"
                value={draft.url}
              />
              <FieldDescription>
                {fixture ? LL.services.fixtureUrlDescription() : LL.services.urlDescription()}
              </FieldDescription>
              {showUrlError ? <FieldError>{LL.services.urlError()}</FieldError> : null}
            </Field>
          </FieldGroup>
          <DialogFooter className={serviceStyles().editorFooter()}>
            {existingService ? (
              <Button
                disabled={commandPending}
                onClick={() => setDeleteConfirmOpen(true)}
                type="button"
                variant="destructive"
              >
                {LL.common.delete()}
              </Button>
            ) : (
              <span />
            )}
            <div className={serviceStyles().footerActions()}>
              <DialogClose
                render={<Button className="secondary-button" type="button" variant="outline" />}
              >
                {LL.common.cancel()}
              </DialogClose>
              <Button
                className="primary-action-button"
                disabled={!canSave || commandPending}
                loading={pendingAction?.kind === "save" ? pendingAction.promise : false}
                loadingText={LL.common.save()}
                type="submit"
              >
                {LL.common.save()}
              </Button>
            </div>
          </DialogFooter>
        </form>

        <AlertDialog onOpenChange={setDeleteConfirmOpen} open={deleteConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {LL.services.deleteTitle({ service: draft.label || LL.services.fallbackName() })}
              </AlertDialogTitle>
              <AlertDialogDescription>{LL.services.deleteDescription()}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{LL.common.cancel()}</AlertDialogCancel>
              <AlertDialogAction
                disabled={commandPending}
                loading={pendingAction?.kind === "delete" ? pendingAction.promise : false}
                loadingText={LL.common.delete()}
                onClick={deleteService}
                variant="destructive"
              >
                {LL.common.delete()}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

export function ServiceMonitorSection() {
  const {
    hasServiceProbeFailed,
    isCommandPending,
    isCommandSupported,
    isServiceProbePending,
    restoreDefaultServices,
    setServiceProbeInterval,
    snapshot,
    testServiceMonitor,
  } = useProduct();
  const { LL } = useI18nContext();
  const { publish } = useNotificationDelivery();
  const [draft, setDraft] = useState<ServiceMonitorDraft | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [restorePending, setRestorePending] = useState(false);
  const editorAuthority = useMemo(() => createServiceMonitorEditorAuthority(), []);
  useEffect(
    () => () => {
      const operation = editorAuthority.current();
      if (operation?.phase === "pending") editorAuthority.cancel(operation);
    },
    [editorAuthority],
  );
  if (!snapshot) return null;
  const commandPending = isCommandPending("services") || editorAuthority.isPending();
  const commandSupported = isCommandSupported("services");
  const actionDescriptionId = getCommandDescriptionId(snapshot.adapterKind, commandSupported);

  function intervalLabel(intervalSeconds: (typeof serviceProbeIntervals)[number]) {
    switch (intervalSeconds) {
      case 0:
        return LL.services.intervalDisabled();
      case 5:
        return LL.services.interval5Seconds();
      case 10:
        return LL.services.interval10Seconds();
      case 30:
        return LL.services.interval30Seconds();
      case 60:
        return LL.services.interval1Minute();
    }
  }

  async function restoreServices() {
    const operation = editorAuthority.begin("restore-defaults");
    if (!operation) return;
    setRestorePending(true);
    try {
      const result = await restoreDefaultServices();
      const accepted = editorAuthority.complete(operation, result.ok ? "success" : "failure");
      if (accepted && result.ok)
        publish(
          notificationPublication("service.defaults-restored", {
            severity: "success",
          }),
        );
    } catch {
      editorAuthority.complete(operation, "failure");
    } finally {
      const current = editorAuthority.current();
      if (!current || current.operationId === operation.operationId) setRestorePending(false);
    }
  }

  function confirmRestoreServices() {
    setRestoreConfirmOpen(false);
    void restoreServices();
  }

  function openEditor(nextDraft: ServiceMonitorDraft) {
    const operation = editorAuthority.begin("edit");
    if (!operation) return;
    if (!editorAuthority.complete(operation, "success")) return;
    setManagerOpen(false);
    setDraft(nextDraft);
  }

  return (
    <section aria-label={LL.services.aria()} className={serviceStyles().section()}>
      <div className={serviceStyles().heading()}>
        <div className={serviceStyles().headingCopy()}>
          <h2>{LL.status.services()}</h2>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-busy={restorePending}
            aria-describedby={actionDescriptionId}
            className={serviceStyles().trigger()}
            disabled={commandPending}
          >
            {restorePending ? <Spinner data-icon="inline-start" /> : null}
            {LL.services.manage()}
            <CaretDown aria-hidden="true" weight="bold" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="service-manage-menu" sideOffset={7}>
            {!commandSupported ? (
              <DropdownMenuGroup>
                <DropdownMenuLabel className={serviceStyles().unavailable()}>
                  {LL.capabilities.localActionUnavailable()}
                </DropdownMenuLabel>
              </DropdownMenuGroup>
            ) : null}
            <DropdownMenuRadioGroup
              onValueChange={(value) => {
                const interval = Number(value);
                if (
                  serviceProbeIntervals.includes(interval as (typeof serviceProbeIntervals)[number])
                ) {
                  void setServiceProbeInterval(interval as (typeof serviceProbeIntervals)[number]);
                }
              }}
              value={String(snapshot.serviceProbePolicy.intervalSeconds)}
            >
              <DropdownMenuLabel className={serviceStyles().intervalLabel()}>
                {LL.services.testInterval()}
              </DropdownMenuLabel>
              {serviceProbeIntervals.map((interval) => (
                <DropdownMenuRadioItem
                  disabled={commandPending || !commandSupported}
                  key={interval}
                  value={String(interval)}
                >
                  {intervalLabel(interval)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={!commandSupported || snapshot.services.length === 0}
                onClick={() => setManagerOpen(true)}
              >
                <PencilSimple aria-hidden="true" data-icon="inline-start" />
                {LL.services.editServices()}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {snapshot.services.length > 0 ? (
        <SectionGrid className={serviceStyles().list()}>
          {snapshot.services.map((service, index) => {
            const probePending = isServiceProbePending(service.id);
            const probeFailed = hasServiceProbeFailed(service.id);
            const result = snapshot.probeResults.find(
              (candidate) => candidate.monitorId === service.id,
            );
            const latencyStatus = classifyServiceLatency(result, probeFailed);
            return (
              <Button
                aria-busy={probePending}
                aria-label={LL.services.testAria({ service: service.label })}
                aria-describedby={actionDescriptionId}
                className={serviceStyles().row({
                  className: serviceMonitorCellCorners(index, snapshot.services.length),
                })}
                disabled={probePending || commandPending || !commandSupported}
                key={service.id}
                onClick={() => void testServiceMonitor(service.id)}
                type="button"
                variant="ghost"
              >
                <span className={serviceStyles().identity()}>
                  <span className={serviceStyles().icon()}>
                    <ServiceIconImage src={service.icon} />
                  </span>
                  <strong className="user-authored-label" title={service.label}>
                    {service.label}
                  </strong>
                </span>
                <span
                  aria-live="polite"
                  className={serviceStyles().latency({ className: "tabular-nums" })}
                  data-status={latencyStatus === "success" ? undefined : latencyStatus}
                >
                  {latencyStatus === "pending" || latencyStatus === "error"
                    ? latencyStatus === "error"
                      ? LL.services.unavailable()
                      : LL.common.pending()
                    : formatLatency(result?.latencyMilliseconds ?? 0)}
                </span>
              </Button>
            );
          })}
          {Array.from({
            length:
              (serviceMonitorMediumColumnCount -
                (snapshot.services.length % serviceMonitorMediumColumnCount)) %
              serviceMonitorMediumColumnCount,
          }).map((_, offset) => (
            <div
              aria-hidden="true"
              className={serviceStyles().placeholder({
                className: cx(
                  serviceMonitorCellCorners(
                    snapshot.services.length + offset,
                    snapshot.services.length,
                  ),
                  "service-monitor-placeholder-medium service-grid-wide:hidden max-page-compact:hidden runtime-mobile:hidden",
                ),
              })}
              key={`service-monitor-medium-placeholder-${offset}`}
            />
          ))}
          {Array.from({
            length:
              (serviceMonitorWideColumnCount -
                (snapshot.services.length % serviceMonitorWideColumnCount)) %
              serviceMonitorWideColumnCount,
          }).map((_, offset) => (
            <div
              aria-hidden="true"
              className={serviceStyles().placeholder({
                className: cx(
                  serviceMonitorCellCorners(
                    snapshot.services.length + offset,
                    snapshot.services.length,
                  ),
                  "service-monitor-placeholder-wide hidden service-grid-wide:block max-page-compact:hidden runtime-mobile:hidden",
                ),
              })}
              key={`service-monitor-wide-placeholder-${offset}`}
            />
          ))}
        </SectionGrid>
      ) : (
        <Empty className="service-monitor-empty">
          <EmptyHeader>
            <EmptyTitle>{LL.services.empty()}</EmptyTitle>
            <EmptyDescription>
              {snapshot.adapterKind === "fixture"
                ? LL.services.fixtureEmptyDescription()
                : LL.services.desktopEmptyDescription()}
            </EmptyDescription>
          </EmptyHeader>
          <Button
            aria-describedby={actionDescriptionId}
            disabled={!commandSupported}
            onClick={() =>
              openEditor({ icon: SERVICE_ICON_URLS.fallback, label: "", url: "https://" })
            }
            variant="outline"
          >
            <Plus data-icon="inline-start" />
            {LL.services.add()}
          </Button>
        </Empty>
      )}

      <ServiceEditorDialog
        draft={draft}
        editorAuthority={editorAuthority}
        fixture={snapshot.adapterKind === "fixture"}
        key={draft ? (draft.id ?? "new") : "closed"}
        onClose={() => setDraft(null)}
        setDraft={setDraft}
      />
      <ServiceManagerDialog
        commandPending={commandPending}
        onAdd={() => openEditor({ icon: SERVICE_ICON_URLS.fallback, label: "", url: "https://" })}
        onClose={() => {
          setManagerOpen(false);
          setRestoreConfirmOpen(false);
        }}
        onEdit={(service) => openEditor({ ...service })}
        onRestore={() => setRestoreConfirmOpen(true)}
        open={managerOpen}
        restorePending={restorePending}
        services={snapshot.services}
      />
      <AlertDialog onOpenChange={setRestoreConfirmOpen} open={restoreConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{LL.services.restoreDefaultsTitle()}</AlertDialogTitle>
            <AlertDialogDescription>
              {LL.services.restoreDefaultsDescription()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{LL.common.cancel()}</AlertDialogCancel>
            <AlertDialogAction
              aria-busy={restorePending}
              disabled={commandPending || restorePending}
              onClick={confirmRestoreServices}
            >
              {restorePending ? <Spinner data-icon="inline-start" /> : null}
              {LL.services.restoreDefaults()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
