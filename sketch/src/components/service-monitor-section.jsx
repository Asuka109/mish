import {
  AppleLogo,
  ArrowCounterClockwise,
  CaretDown,
  Cloud,
  GithubLogo,
  GlobeSimple,
  GoogleLogo,
  PawPrint,
  Plus,
  WindowsLogo,
} from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SectionGrid, SectionGridItem } from "./ui/section-grid";

const DEFAULT_SERVICES = [
  { icon: "google", id: "google", latency: 48, name: "Google", url: "https://www.google.com/generate_204" },
  { icon: "github", id: "github", latency: 92, name: "GitHub", url: "https://github.com" },
  { icon: "cloudflare", id: "cloudflare", latency: 31, name: "Cloudflare", url: "https://cp.cloudflare.com/generate_204" },
  { icon: "baidu", id: "baidu", latency: 12, name: "Baidu", url: "https://www.baidu.com" },
  { icon: "apple", id: "apple", latency: 56, name: "Apple", url: "https://www.apple.com/library/test/success.html" },
  { icon: "microsoft", id: "microsoft", latency: 64, name: "Microsoft", url: "https://www.msftconnecttest.com/connecttest.txt" },
];

const serviceIcons = {
  apple: AppleLogo,
  baidu: PawPrint,
  cloudflare: Cloud,
  github: GithubLogo,
  globe: GlobeSimple,
  google: GoogleLogo,
  microsoft: WindowsLogo,
};

function cloneDefaults() {
  return DEFAULT_SERVICES.map((service) => ({ ...service }));
}

function isValidProbeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function ServiceEditorDialog({ draft, onDelete, onOpenChange, onSave, open, setDraft }) {
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  if (!draft) return null;

  const nameInvalid = draft.name.trim().length === 0;
  const urlInvalid = !isValidProbeUrl(draft.url);
  const canSave = !nameInvalid && !urlInvalid;
  const existingService = Boolean(draft.id);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="service-editor-dialog" showCloseButton>
        <div className="dialog-header">
          <div>
            <DialogTitle className="dialog-title">
              {existingService ? "Edit service" : "Add service"}
            </DialogTitle>
            <DialogDescription className="dialog-description">
              Define the endpoint used for this availability probe.
            </DialogDescription>
          </div>
        </div>

        <form
          className="service-editor-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) onSave(draft);
          }}
        >
          <FieldGroup>
            <Field data-invalid={nameInvalid}>
              <FieldLabel htmlFor="service-title">Title</FieldLabel>
              <Input
                aria-invalid={nameInvalid}
                autoFocus
                id="service-title"
                onValueChange={(value) => setDraft({ ...draft, name: value })}
                placeholder="Service name"
                value={draft.name}
              />
              {nameInvalid ? <FieldError>Enter a title.</FieldError> : null}
            </Field>
            <Field data-invalid={urlInvalid}>
              <FieldLabel htmlFor="service-probe-url">Probe URL</FieldLabel>
              <Input
                aria-invalid={urlInvalid}
                id="service-probe-url"
                onValueChange={(value) => setDraft({ ...draft, url: value })}
                placeholder="https://example.com/generate_204"
                type="url"
                value={draft.url}
              />
              <FieldDescription>Use an HTTP or HTTPS endpoint that responds quickly and reliably.</FieldDescription>
              {urlInvalid ? <FieldError>Enter a valid HTTP or HTTPS URL.</FieldError> : null}
            </Field>
          </FieldGroup>

          <div className="dialog-footer service-editor-footer">
            {existingService ? (
              <Button
                className="danger-text-button"
                onClick={() => setDeleteConfirmOpen(true)}
                type="button"
                variant="destructive"
              >
                Delete
              </Button>
            ) : <span />}
            <div className="dialog-footer-actions">
              <DialogClose render={<Button className="secondary-button" type="button" variant="outline" />}>
                Cancel
              </DialogClose>
              <Button className="primary-action-button" disabled={!canSave} type="submit">Save</Button>
            </div>
          </div>
        </form>
      </DialogContent>

      <AlertDialog onOpenChange={setDeleteConfirmOpen} open={deleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {draft.name || "this service"}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the monitor from the Status page. You can add it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                onDelete(draft.id);
                setDeleteConfirmOpen(false);
              }}
              variant="destructive"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

export function ServiceMonitorSection() {
  const [services, setServices] = useState(cloneDefaults);
  const [draft, setDraft] = useState(null);

  const closeEditor = () => setDraft(null);
  const saveService = (nextService) => {
    const normalized = {
      ...nextService,
      icon: nextService.icon ?? "globe",
      latency: nextService.latency ?? null,
      name: nextService.name.trim(),
      url: nextService.url.trim(),
    };

    if (nextService.id) {
      setServices((current) => current.map((service) => (
        service.id === nextService.id ? normalized : service
      )));
    } else {
      setServices((current) => [
        ...current,
        { ...normalized, id: globalThis.crypto?.randomUUID?.() ?? `service-${Date.now()}` },
      ]);
    }

    closeEditor();
    toast.success(nextService.id ? "Service updated" : "Service added");
  };

  const deleteService = (serviceId) => {
    setServices((current) => current.filter((service) => service.id !== serviceId));
    closeEditor();
    toast.success("Service removed");
  };

  return (
    <section className="service-monitor-section" aria-label="Service latency monitors">
      <div className="section-heading service-monitor-heading">
        <div className="section-heading-copy">
          <h2>Services</h2>
          <p>Endpoint latency.</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger className="service-manage-trigger" type="button">
            Manage
            <CaretDown aria-hidden="true" size={12} weight="bold" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="service-manage-menu" sideOffset={7}>
            <DropdownMenuItem
              className="service-manage-item"
              onClick={() => setDraft({ icon: "globe", latency: null, name: "", url: "https://" })}
            >
              <Plus aria-hidden="true" data-icon="inline-start" size={15} />
              Add service
            </DropdownMenuItem>
            <DropdownMenuSeparator className="service-manage-separator" />
            <DropdownMenuItem
              className="service-manage-item"
              onClick={() => {
                setServices(cloneDefaults());
                toast.success("Default services restored");
              }}
            >
              <ArrowCounterClockwise aria-hidden="true" data-icon="inline-start" size={15} />
              Restore defaults
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {services.length > 0 ? (
        <SectionGrid className="service-monitor-list" columns={3}>
          {services.map((service) => {
          const Icon = serviceIcons[service.icon] ?? GlobeSimple;

          return (
            <SectionGridItem
              as={Button}
              className="service-monitor-row"
              data-service-icon={service.icon}
              key={service.id}
              onClick={() => setDraft({ ...service })}
              type="button"
              variant="ghost"
            >
              <span className="sr-only">Edit monitor: </span>
              <span className="service-monitor-icon">
                <Icon aria-hidden="true" data-icon="inline-start" size={18} weight="fill" />
              </span>
              <span className="service-monitor-copy">
                <strong className="user-authored-label">{service.name}</strong>
              </span>
              <span className="service-monitor-latency tabular">
                {service.latency === null ? "Pending" : `${service.latency} ms`}
              </span>
            </SectionGridItem>
          );
          })}
        </SectionGrid>
      ) : (
        <Empty className="service-monitor-empty">
          <EmptyHeader>
            <EmptyTitle>No service monitors</EmptyTitle>
            <EmptyDescription>Add a service to track endpoint latency here.</EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setDraft({ icon: "globe", latency: null, name: "", url: "https://" })} variant="outline">
            <Plus data-icon="inline-start" />
            Add service
          </Button>
        </Empty>
      )}

      <ServiceEditorDialog
        draft={draft}
        onDelete={deleteService}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        onSave={saveService}
        open={draft !== null}
        setDraft={setDraft}
      />
    </section>
  );
}
