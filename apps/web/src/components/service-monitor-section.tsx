import { AppleLogo } from "@phosphor-icons/react/AppleLogo";
import { ArrowCounterClockwise } from "@phosphor-icons/react/ArrowCounterClockwise";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { Cloud } from "@phosphor-icons/react/Cloud";
import { GithubLogo } from "@phosphor-icons/react/GithubLogo";
import { GlobeSimple } from "@phosphor-icons/react/GlobeSimple";
import { GoogleLogo } from "@phosphor-icons/react/GoogleLogo";
import { PawPrint } from "@phosphor-icons/react/PawPrint";
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
  onClose(): void;
  setDraft(draft: ServiceMonitorDraft): void;
}

function ServiceEditorDialog({ draft, onClose, setDraft }: ServiceEditorDialogProps) {
  const { isCommandPending, removeServiceMonitor, upsertServiceMonitor } = useProduct();
  const { LL } = useI18nContext();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [editedFields, setEditedFields] = useState({ label: false, url: false });
  if (!draft) return null;

  const labelInvalid = draft.label.trim().length === 0;
  const urlInvalid = !isValidProbeUrl(draft.url);
  const showLabelError = labelInvalid && editedFields.label;
  const showUrlError = urlInvalid && editedFields.url;
  const canSave = !labelInvalid && !urlInvalid;
  const existingService = Boolean(draft.id);
  const commandPending = isCommandPending("services");

  async function saveService() {
    if (!draft || !canSave) return;
    const result = await upsertServiceMonitor(draft);
    if (!result.ok) return;
    toast.success(existingService ? LL.services.updatedToast() : LL.services.addedToast());
    onClose();
  }

  async function deleteService() {
    if (!draft?.id) return;
    const result = await removeServiceMonitor(draft.id);
    if (!result.ok) return;
    toast.success(LL.services.removedToast());
    setDeleteConfirmOpen(false);
    onClose();
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
              {LL.services.metadataDescription()}
            </DialogDescription>
          </div>
        </div>
        <form
          className="service-editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveService();
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
                type="url"
                value={draft.url}
              />
              <FieldDescription>{LL.services.urlDescription()}</FieldDescription>
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
                onClick={() => void deleteService()}
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
  const { isCommandPending, isCommandSupported, restoreDefaultServices, snapshot } = useProduct();
  const { LL } = useI18nContext();
  const [draft, setDraft] = useState<ServiceMonitorDraft | null>(null);
  if (!snapshot) return null;
  const commandPending = isCommandPending("services");
  const commandSupported = isCommandSupported("services");
  const actionDescriptionId = getCommandDescriptionId(snapshot.adapterKind, commandSupported);

  async function restoreServices() {
    const result = await restoreDefaultServices();
    if (result.ok) toast.success(LL.services.defaultRestoredToast());
  }

  return (
    <section aria-label={LL.services.aria()} className="service-monitor-section">
      <div className="section-heading service-monitor-heading">
        <div className="section-heading-copy">
          <h2>{LL.status.services()}</h2>
          <p>
            {snapshot.adapterKind === "fixture"
              ? LL.services.fixtureEndpointDescription()
              : LL.services.desktopEndpointDescription()}
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-describedby={actionDescriptionId}
            className="service-manage-trigger"
            disabled={!commandSupported}
          >
            {LL.services.manage()}
            <CaretDown aria-hidden="true" weight="bold" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="service-manage-menu" sideOffset={7}>
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={!commandSupported}
                onClick={() => setDraft({ icon: "globe", label: "", url: "https://" })}
              >
                <Plus aria-hidden="true" data-icon="inline-start" />
                {LL.services.add()}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                disabled={commandPending || !commandSupported}
                onClick={() => void restoreServices()}
              >
                <ArrowCounterClockwise aria-hidden="true" data-icon="inline-start" />
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
            const result = snapshot.probeResults.find(
              (candidate) => candidate.monitorId === service.id,
            );
            return (
              <Button
                aria-describedby={actionDescriptionId}
                className="section-grid-item service-monitor-row"
                data-service-icon={service.icon}
                disabled={commandPending || !commandSupported}
                key={service.id}
                onClick={() => setDraft({ ...service })}
                type="button"
                variant="ghost"
              >
                <span className="sr-only">{LL.services.editAria()} </span>
                <span className="service-monitor-icon">
                  <ServiceIcon aria-hidden="true" weight="fill" />
                </span>
                <strong className="user-authored-label">{service.label}</strong>
                <span className="service-monitor-latency tabular">
                  {result?.latencyMilliseconds === null || result?.latencyMilliseconds === undefined
                    ? LL.common.pending()
                    : `${result.latencyMilliseconds} ms`}
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
        key={draft ? (draft.id ?? "new") : "closed"}
        onClose={() => setDraft(null)}
        setDraft={setDraft}
      />
    </section>
  );
}
