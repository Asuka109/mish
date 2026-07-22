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
import { useState } from "react";
import { toast } from "sonner";
import { tv } from "tailwind-variants";
import { useProduct } from "../data/product-provider";
import { getCommandDescriptionId } from "../data/status-capabilities";
import {
  SERVICE_ICON_URLS,
  type ServiceMonitorDraft,
  type ServiceMonitorDto,
  type ServiceProbeResultDto,
} from "@mish/contracts";
import { useI18nContext } from "../i18n/i18n-react";

const serviceProbeIntervals = [0, 5, 10, 30, 60] as const;
const maximumDisplayedLatency = 9999;
const defaultServiceIconUrls = new Set<string>(Object.values(SERVICE_ICON_URLS));

const serviceStyles = tv({
  slots: {
    section: "service-monitor-section mt-7",
    heading: "service-monitor-heading section-heading pb-[9px]",
    trigger:
      "service-manage-trigger border-transparent hover:border-(--color-hairline) hover:bg-(--color-accent) hover:text-(--color-ink) data-[popup-open]:border-(--color-hairline) data-[popup-open]:bg-(--color-accent) data-[popup-open]:text-(--color-ink) [&_svg]:size-3",
    unavailable:
      "service-manage-unavailable block max-w-[236px] px-[9px] pt-[6px] pb-2 text-[12px] leading-[17px] whitespace-normal text-(--color-text-muted)",
    intervalLabel:
      "service-interval-label block px-[9px] pt-[6px] pb-[3px] text-[12px] leading-[17px] font-(--font-weight-control) text-(--color-text-muted)",
    list: "service-monitor-list gap-0 bg-(--color-canvas)",
    row: "service-monitor-row grid min-h-[52px] grid-cols-[minmax(0,1fr)_minmax(74px,144px)_76px_minmax(0,1fr)] items-center gap-[10px] rounded-none border-0 bg-transparent py-0 pr-[13px] pl-[11px] text-left text-(--color-body) hover:bg-(--color-accent) hover:text-(--color-ink)",
    identity:
      "service-monitor-identity col-start-2 grid min-w-0 grid-cols-[22px_minmax(0,1fr)] items-center gap-[10px] [&_strong]:overflow-hidden [&_strong]:text-(--text-body) [&_strong]:font-(--font-weight-control) [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap",
    icon: "service-monitor-icon grid size-[22px] place-items-center text-(--color-text-muted) [&_img]:block [&_img]:size-[18px] [&_img]:object-contain [&_img]:opacity-75",
    latency:
      "service-monitor-latency col-start-3 block justify-self-stretch text-right text-(--text-metadata) whitespace-nowrap text-(--color-success-text) data-[status=error]:text-(--color-error) data-[status=warning]:text-(--color-warning) [&_.ui-spinner]:size-[13px]",
    managerDialog:
      "service-manager-dialog w-[min(420px,calc(100vw_-_32px))] [&_.dialog-header]:justify-between [&_.dialog-header]:gap-(--mish-spacing-md) [&_.dialog-header>div]:min-w-0",
    managerList:
      "service-manager-list max-h-[min(360px,calc(100vh_-_180px))] overflow-auto pt-1 pb-[6px]",
    managerRow:
      "service-manager-row grid min-h-[46px] w-full grid-cols-[22px_minmax(0,1fr)_16px] items-center justify-stretch gap-[10px] rounded-none border-0 px-4 py-0 text-left [&+&]:border-t [&+&]:border-(--color-hairline-soft) [&_strong]:overflow-hidden [&_strong]:text-(--text-body) [&_strong]:font-(--font-weight-control) [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&>svg]:justify-self-end [&>svg]:text-(--color-text-muted)",
    managerFooter: "service-manager-footer justify-start",
  },
});

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
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

interface ServiceIconImageProps {
  src: string;
}

function ServiceIconImage({ src }: ServiceIconImageProps) {
  return (
    <img
      alt=""
      aria-hidden="true"
      data-monochrome={defaultServiceIconUrls.has(src) || undefined}
      decoding="async"
      onError={(event) => {
        event.currentTarget.hidden = true;
      }}
      onLoad={(event) => {
        event.currentTarget.hidden = false;
      }}
      referrerPolicy="no-referrer"
      src={src}
    />
  );
}

interface ServiceEditorDialogProps {
  draft: ServiceMonitorDraft | null;
  fixture: boolean;
  onClose(): void;
  setDraft(draft: ServiceMonitorDraft): void;
}

interface ServiceManagerDialogProps {
  onAdd(): void;
  onClose(): void;
  onEdit(service: ServiceMonitorDto): void;
  onRestore(): void;
  open: boolean;
  restorePending: boolean;
  services: ServiceMonitorDto[];
}

function ServiceManagerDialog({
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
        <div className="dialog-header">
          <div>
            <DialogTitle className="dialog-title">{LL.services.editServices()}</DialogTitle>
            <DialogDescription className="dialog-description">
              {LL.services.editServicesDescription()}
            </DialogDescription>
          </div>
          <Button onClick={onAdd} type="button" variant="outline">
            <Plus aria-hidden="true" data-icon="inline-start" />
            {LL.services.add()}
          </Button>
        </div>
        <div className={serviceStyles().managerList()}>
          {services.map((service) => {
            return (
              <Button
                className={serviceStyles().managerRow()}
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
            disabled={restorePending}
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

function ServiceEditorDialog({ draft, fixture, onClose, setDraft }: ServiceEditorDialogProps) {
  const { isCommandPending, removeServiceMonitor, upsertServiceMonitor } = useProduct();
  const { LL } = useI18nContext();
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
  const commandPending = isCommandPending("services");

  function saveService() {
    if (!draft || !canSave) return;
    const promise = upsertServiceMonitor(draft).then((result) => {
      if (!result.ok) return;
      toast.success(existingService ? LL.services.updatedToast() : LL.services.addedToast());
      onClose();
    });
    setPendingAction({ kind: "save", promise });
  }

  function deleteService() {
    if (!draft?.id) return;
    const promise = removeServiceMonitor(draft.id).then((result) => {
      if (!result.ok) return;
      toast.success(LL.services.removedToast());
      setDeleteConfirmOpen(false);
      onClose();
    });
    setPendingAction({ kind: "delete", promise });
  }

  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="service-editor-dialog" closeLabel={LL.common.close()}>
        <div className="dialog-header">
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
        </div>
        <form
          className="service-editor-form"
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
                onValueChange={(value) => {
                  setEditedFields((fields) => ({ ...fields, icon: true }));
                  setDraft({ ...draft, icon: value });
                }}
                placeholder={SERVICE_ICON_URLS.globe}
                spellCheck={false}
                type="url"
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
          <div className="dialog-footer service-editor-footer">
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
            <div className="dialog-footer-actions">
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
          </div>
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
  const [draft, setDraft] = useState<ServiceMonitorDraft | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [restorePending, setRestorePending] = useState(false);
  if (!snapshot) return null;
  const commandPending = isCommandPending("services");
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
    setRestorePending(true);
    try {
      const result = await restoreDefaultServices();
      if (result.ok) toast.success(LL.services.defaultRestoredToast());
    } finally {
      setRestorePending(false);
    }
  }

  return (
    <section aria-label={LL.services.aria()} className={serviceStyles().section()}>
      <div className={serviceStyles().heading()}>
        <div className="section-heading-copy">
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
        <SectionGrid className={serviceStyles().list()} columns={3}>
          {snapshot.services.map((service) => {
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
                className={serviceStyles().row({ className: "section-grid-item" })}
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
                  className={serviceStyles().latency({ className: "tabular" })}
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
            onClick={() => setDraft({ icon: SERVICE_ICON_URLS.globe, label: "", url: "https://" })}
            variant="outline"
          >
            <Plus data-icon="inline-start" />
            {LL.services.add()}
          </Button>
        </Empty>
      )}

      <ServiceEditorDialog
        draft={draft}
        fixture={snapshot.adapterKind === "fixture"}
        key={draft ? (draft.id ?? "new") : "closed"}
        onClose={() => setDraft(null)}
        setDraft={setDraft}
      />
      <ServiceManagerDialog
        onAdd={() => {
          setManagerOpen(false);
          setDraft({ icon: SERVICE_ICON_URLS.globe, label: "", url: "https://" });
        }}
        onClose={() => setManagerOpen(false)}
        onEdit={(service) => {
          setManagerOpen(false);
          setDraft({ ...service });
        }}
        onRestore={() => void restoreServices()}
        open={managerOpen}
        restorePending={restorePending}
        services={snapshot.services}
      />
    </section>
  );
}
