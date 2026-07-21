import { AppleLogo } from "@phosphor-icons/react/AppleLogo";
import { ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { Cloud } from "@phosphor-icons/react/Cloud";
import { GithubLogo } from "@phosphor-icons/react/GithubLogo";
import { GlobeSimple } from "@phosphor-icons/react/GlobeSimple";
import { GoogleLogo } from "@phosphor-icons/react/GoogleLogo";
import { PawPrint } from "@phosphor-icons/react/PawPrint";
import { PencilSimple } from "@phosphor-icons/react/PencilSimple";
import { Plus } from "@phosphor-icons/react/Plus";
import { WindowsLogo } from "@phosphor-icons/react/WindowsLogo";
import type { Icon } from "@phosphor-icons/react/lib";
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
import { useProduct } from "../data/product-provider";
import { getCommandDescriptionId } from "../data/status-capabilities";
import type { ServiceMonitorDraft, ServiceMonitorDto } from "@mish/contracts";
import { useI18nContext } from "../i18n/i18n-react";

const serviceIcons: Record<ServiceMonitorDto["icon"], Icon> = {
  apple: AppleLogo,
  baidu: PawPrint,
  cloudflare: Cloud,
  github: GithubLogo,
  globe: GlobeSimple,
  google: GoogleLogo,
  microsoft: WindowsLogo,
};

const serviceProbeIntervals = [30, 60, 300, 900] as const;

function isValidProbeUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

interface ServiceEditorDialogProps {
  draft: ServiceMonitorDraft | null;
  fixture: boolean;
  onClose(): void;
  setDraft(draft: ServiceMonitorDraft): void;
}

interface ServiceManagerDialogProps {
  onClose(): void;
  onEdit(service: ServiceMonitorDto): void;
  open: boolean;
  services: ServiceMonitorDto[];
}

function ServiceManagerDialog({ onClose, onEdit, open, services }: ServiceManagerDialogProps) {
  const { LL } = useI18nContext();

  return (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={open}>
      <DialogContent className="service-manager-dialog" closeLabel={LL.common.close()}>
        <div className="dialog-header">
          <div>
            <DialogTitle className="dialog-title">{LL.services.editServices()}</DialogTitle>
            <DialogDescription className="dialog-description">
              {LL.services.editServicesDescription()}
            </DialogDescription>
          </div>
        </div>
        <div className="service-manager-list">
          {services.map((service) => {
            const ServiceIcon = serviceIcons[service.icon];
            return (
              <Button
                className="service-manager-row"
                key={service.id}
                onClick={() => onEdit(service)}
                type="button"
                variant="ghost"
              >
                <span className="service-monitor-icon" data-service-icon={service.icon}>
                  <ServiceIcon aria-hidden="true" weight="fill" />
                </span>
                <strong className="user-authored-label">{service.label}</strong>
                <PencilSimple aria-hidden="true" />
              </Button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ServiceEditorDialog({ draft, fixture, onClose, setDraft }: ServiceEditorDialogProps) {
  const { isCommandPending, removeServiceMonitor, upsertServiceMonitor } = useProduct();
  const { LL } = useI18nContext();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [editedFields, setEditedFields] = useState({ label: false, url: false });
  const [pendingAction, setPendingAction] = useState<{
    kind: "delete" | "save";
    promise: Promise<void>;
  } | null>(null);
  if (!draft) return null;

  const labelInvalid = draft.label.trim().length === 0;
  const urlInvalid = !isValidProbeUrl(draft.url);
  const showLabelError = labelInvalid && editedFields.label;
  const showUrlError = urlInvalid && editedFields.url;
  const canSave = !labelInvalid && !urlInvalid;
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
      case 30:
        return LL.services.interval30Seconds();
      case 60:
        return LL.services.interval1Minute();
      case 300:
        return LL.services.interval5Minutes();
      case 900:
        return LL.services.interval15Minutes();
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
    <section aria-label={LL.services.aria()} className="service-monitor-section">
      <div className="section-heading service-monitor-heading">
        <div className="section-heading-copy">
          <h2>{LL.status.services()}</h2>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-busy={restorePending}
            aria-describedby={actionDescriptionId}
            className="service-manage-trigger"
            disabled={commandPending}
          >
            {restorePending ? <Spinner data-icon="inline-start" /> : null}
            {LL.services.manage()}
            <CaretDown aria-hidden="true" weight="bold" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="service-manage-menu" sideOffset={7}>
            <DropdownMenuGroup>
              {!commandSupported ? (
                <DropdownMenuLabel className="service-manage-unavailable">
                  {LL.capabilities.localActionUnavailable()}
                </DropdownMenuLabel>
              ) : null}
              <DropdownMenuItem
                disabled={!commandSupported}
                onClick={() => setDraft({ icon: "globe", label: "", url: "https://" })}
              >
                <Plus aria-hidden="true" data-icon="inline-start" />
                {LL.services.add()}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!commandSupported || snapshot.services.length === 0}
                onClick={() => setManagerOpen(true)}
              >
                <PencilSimple aria-hidden="true" data-icon="inline-start" />
                {LL.services.editServices()}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
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
              <DropdownMenuLabel className="service-interval-label">
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
                aria-busy={restorePending}
                disabled={commandPending || !commandSupported}
                onClick={() => void restoreServices()}
              >
                {restorePending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <ArrowCounterClockwise aria-hidden="true" data-icon="inline-start" />
                )}
                {LL.services.restoreDefaults()}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {snapshot.services.length > 0 ? (
        <SectionGrid className="service-monitor-list" columns={3}>
          {snapshot.services.map((service) => {
            const ServiceIcon = serviceIcons[service.icon];
            const probePending = isServiceProbePending(service.id);
            const result = snapshot.probeResults.find(
              (candidate) => candidate.monitorId === service.id,
            );
            return (
              <Button
                aria-busy={probePending}
                aria-label={LL.services.testAria({ service: service.label })}
                aria-describedby={actionDescriptionId}
                className="section-grid-item service-monitor-row"
                data-service-icon={service.icon}
                disabled={commandPending || !commandSupported}
                key={service.id}
                onClick={() => void testServiceMonitor(service.id)}
                type="button"
                variant="ghost"
              >
                <span className="service-monitor-icon">
                  <ServiceIcon aria-hidden="true" weight="fill" />
                </span>
                <strong className="user-authored-label">{service.label}</strong>
                <span aria-live="polite" className="service-monitor-latency tabular">
                  {probePending ? (
                    <Spinner />
                  ) : result?.latencyMilliseconds === null ||
                    result?.latencyMilliseconds === undefined ? (
                    result?.status === "error" ? (
                      LL.services.unavailable()
                    ) : (
                      LL.common.pending()
                    )
                  ) : (
                    `${result.latencyMilliseconds} ms`
                  )}
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
            onClick={() => setDraft({ icon: "globe", label: "", url: "https://" })}
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
        onClose={() => setManagerOpen(false)}
        onEdit={(service) => {
          setManagerOpen(false);
          setDraft({ ...service });
        }}
        open={managerOpen}
        services={snapshot.services}
      />
    </section>
  );
}
