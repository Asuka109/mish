import { Button } from "@base-ui/react/button";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
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
  X,
} from "@phosphor-icons/react";
import { useState } from "react";
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
  if (!draft) return null;

  const canSave = draft.name.trim().length > 0 && isValidProbeUrl(draft.url);
  const existingService = Boolean(draft.id);

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Viewport className="modal-viewport">
          <Dialog.Popup className="service-editor-dialog">
            <div className="dialog-header">
              <div>
                <Dialog.Title className="dialog-title">
                  {existingService ? "Edit service" : "Add service"}
                </Dialog.Title>
                <Dialog.Description className="dialog-description">
                  Define the endpoint used for this availability probe.
                </Dialog.Description>
              </div>
              <Dialog.Close aria-label="Close service editor" className="icon-button">
                <X aria-hidden="true" size={16} />
              </Dialog.Close>
            </div>

            <form
              className="service-editor-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (canSave) onSave(draft);
              }}
            >
              <label className="form-field">
                <span>Title</span>
                <input
                  autoFocus
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Service name"
                  value={draft.name}
                />
              </label>
              <label className="form-field">
                <span>Probe URL</span>
                <input
                  aria-invalid={draft.url.length > 0 && !isValidProbeUrl(draft.url)}
                  onChange={(event) => setDraft({ ...draft, url: event.target.value })}
                  placeholder="https://example.com/generate_204"
                  type="url"
                  value={draft.url}
                />
                <small>Use an HTTP or HTTPS endpoint that responds quickly and reliably.</small>
              </label>

              <div className="dialog-footer service-editor-footer">
                {existingService ? (
                  <Button className="danger-text-button" onClick={() => onDelete(draft.id)} type="button">
                    Delete
                  </Button>
                ) : <span />}
                <div className="dialog-footer-actions">
                  <Dialog.Close className="secondary-button" type="button">Cancel</Dialog.Close>
                  <Button className="primary-action-button" disabled={!canSave} type="submit">Save</Button>
                </div>
              </div>
            </form>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
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
  };

  const deleteService = (serviceId) => {
    setServices((current) => current.filter((service) => service.id !== serviceId));
    closeEditor();
  };

  return (
    <section className="service-monitor-section" aria-label="Service latency monitors">
      <div className="section-heading service-monitor-heading">
        <div className="section-heading-copy">
          <h2>Services</h2>
          <p>Endpoint latency.</p>
        </div>
        <Menu.Root>
          <Menu.Trigger className="service-manage-trigger" type="button">
            Manage
            <CaretDown aria-hidden="true" size={12} weight="bold" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="end" sideOffset={7}>
              <Menu.Popup className="service-manage-menu">
                <Menu.Item
                  className="service-manage-item"
                  onClick={() => setDraft({ icon: "globe", latency: null, name: "", url: "https://" })}
                >
                  <Plus aria-hidden="true" size={15} />
                  Add service
                </Menu.Item>
                <Menu.Separator className="service-manage-separator" />
                <Menu.Item className="service-manage-item" onClick={() => setServices(cloneDefaults())}>
                  <ArrowCounterClockwise aria-hidden="true" size={15} />
                  Restore defaults
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>

      <SectionGrid className="service-monitor-list" columns={3}>
        {services.map((service) => {
          const Icon = serviceIcons[service.icon] ?? GlobeSimple;

          return (
            <SectionGridItem
              as={Button}
              aria-label={`Edit ${service.name} monitor`}
              className="service-monitor-row"
              data-service-icon={service.icon}
              key={service.id}
              onClick={() => setDraft({ ...service })}
              type="button"
            >
              <span className="service-monitor-icon">
                <Icon aria-hidden="true" size={18} weight="fill" />
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
