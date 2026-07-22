import { Warning } from "@phosphor-icons/react/Warning";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mish/ui";
import type {
  LocalBackupScopeDto,
  LocalBackupPreviewDto,
  LocalRestoreConflictKind,
  LocalRestoreConflictResolution,
  LocalRestorePreviewDto,
} from "@mish/contracts";
import { useState } from "react";
import { tv } from "tailwind-variants";
import { useSettings } from "../data/settings-provider";
import { useI18nContext } from "../i18n/i18n-react";

const DEFAULT_SCOPE: LocalBackupScopeDto = {
  patches: true,
  profiles: false,
  schedules: true,
  settings: true,
  sourceLocators: false,
};

const backupStyles = tv({
  slots: {
    control:
      "local-backup-control grid justify-items-end gap-[5px] @max-[680px]:justify-items-start",
    result:
      "local-backup-result max-w-[320px] text-right text-[12px] leading-[17px] text-(--color-text-muted) data-[status=failed]:text-(--color-error) data-[status=exported]:text-(--color-success-text) data-[status=restored]:text-(--color-success-text) @max-[680px]:text-left",
    dialog:
      "local-backup-dialog w-[min(680px,calc(100vw_-_32px))] max-h-[min(780px,calc(100vh_-_32px))] [&_.dialog-header]:grid [&_.dialog-header]:content-center",
    fieldset:
      "grid gap-px overflow-hidden rounded-(--radius-md) border border-(--color-hairline) bg-(--color-hairline-soft) p-0 m-4 [&_legend]:w-full [&_legend]:bg-(--color-canvas) [&_legend]:pb-[9px] [&_legend]:text-(--text-metadata) [&_legend]:font-(--font-weight-section)",
    option:
      "local-backup-option grid min-h-[52px] grid-cols-[18px_minmax(0,1fr)] items-start gap-[10px] bg-(--color-canvas) px-[11px] py-[9px] has-[input:disabled]:opacity-[0.55] [&_input]:mt-[2px] [&_input]:size-[15px] [&_input]:accent-(--color-brand) [&>span]:grid [&>span]:gap-[2px] [&_strong]:text-(--text-metadata) [&_strong]:font-(--font-weight-control) [&_small]:text-[12px] [&_small]:leading-[17px] [&_small]:text-(--color-text-muted) data-[sensitive=true]:[&_strong]:text-(--color-warning)",
    boundary:
      "local-backup-boundary mx-4 mb-4 text-[12px] leading-[18px] text-(--color-text-muted)",
    safety:
      "local-backup-safety mx-4 mb-4 grid grid-cols-[16px_minmax(0,1fr)] gap-2 rounded-(--radius-md) border border-[color-mix(in_srgb,var(--color-warning)_28%,var(--color-hairline))] px-[11px] py-[10px] text-[12px] leading-[18px] text-(--color-body) [&_svg]:size-4 [&_svg]:text-(--color-warning)",
    summary:
      "local-backup-summary grid grid-cols-[110px_150px_minmax(0,1fr)] gap-px border-y border-(--color-hairline-soft) bg-(--color-hairline-soft) [&>div]:grid [&>div]:content-start [&>div]:gap-1 [&>div]:bg-(--color-canvas) [&>div]:px-3 [&>div]:py-[10px] [&_dt]:text-[12px] [&_dt]:text-(--color-text-muted) [&_dd]:wrap-anywhere [&_dd]:text-(--text-metadata) [&_dd]:text-(--color-body)",
    restoreScope:
      "local-restore-scope grid gap-[7px] border-b border-(--color-hairline-soft) px-4 py-3 text-(--text-metadata) text-(--color-body) [&>strong]:font-(--font-weight-section) [&>p]:m-0 [&>p]:text-(--color-text-muted) [&_dl]:grid [&_dl]:gap-1 [&_dl>div]:flex [&_dl>div]:items-baseline [&_dl>div]:justify-between [&_dl>div]:gap-3 [&_dd]:font-(--font-weight-control) [&_dd]:text-(--color-text-muted) [&_[data-included=true]_dd]:text-(--color-warning)",
    conflicts:
      "local-restore-conflicts grid gap-[9px] px-4 pt-4 [&>strong]:text-(--text-metadata) [&>strong]:font-(--font-weight-section) [&_ul]:m-0 [&_ul]:grid [&_ul]:list-none [&_ul]:gap-px [&_ul]:rounded-(--radius-md) [&_ul]:bg-(--color-hairline-soft) [&_ul]:p-px [&_li]:flex [&_li]:min-h-10 [&_li]:items-center [&_li]:justify-between [&_li]:gap-3 [&_li]:bg-(--color-canvas) [&_li]:px-[10px] [&_li]:py-[7px] [&_li]:text-(--text-metadata) [&_li]:text-(--color-body)",
    resolution:
      "local-restore-resolution mt-1 grid gap-px overflow-hidden rounded-(--radius-md) border border-(--color-hairline) bg-(--color-hairline-soft) p-0 [&_legend]:w-full [&_legend]:bg-(--color-canvas) [&_legend]:pb-[9px] [&_legend]:text-(--text-metadata) [&_legend]:font-(--font-weight-section) [&_label]:grid [&_label]:min-h-[38px] [&_label]:grid-cols-[18px_minmax(0,1fr)] [&_label]:items-center [&_label]:gap-2 [&_label]:bg-(--color-canvas) [&_label]:px-[10px] [&_label]:py-[7px] [&_label]:text-(--text-metadata) [&_label]:text-(--color-body) [&_input]:mt-[2px] [&_input]:size-[15px] [&_input]:accent-(--color-brand)",
  },
});

type OperationResult = "cancelled" | "exported" | "failed" | "idle" | "restored";
type PendingOperation = "commit-restore" | "choose-restore" | "preview-export" | "save-export";

export function LocalBackupControl() {
  const settings = useSettings();
  const client = settings.localBackupClient;
  const { LL } = useI18nContext();
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPreview, setExportPreview] = useState<LocalBackupPreviewDto | null>(null);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [resolution, setResolution] = useState<LocalRestoreConflictResolution>("keep-existing");
  const [restorePreview, setRestorePreview] = useState<LocalRestorePreviewDto | null>(null);
  const [result, setResult] = useState<OperationResult>("idle");
  const [scope, setScope] = useState(DEFAULT_SCOPE);

  const supported =
    client.availability === "supported" &&
    settings.snapshot.capabilities.backupRestore === "supported";

  function changeScope(key: keyof LocalBackupScopeDto, selected: boolean) {
    setExportPreview(null);
    setScope((current) => {
      const next = { ...current, [key]: selected };
      if (key === "profiles" && !selected) next.sourceLocators = false;
      return next;
    });
  }

  async function previewExport() {
    setPendingOperation("preview-export");
    setResult("idle");
    try {
      setExportPreview(await client.previewExport(scope));
    } catch {
      setResult("failed");
    } finally {
      setPendingOperation(null);
    }
  }

  async function saveExport() {
    if (!exportPreview) return;
    setPendingOperation("save-export");
    try {
      const save = await client.saveExport(exportPreview.previewId);
      setResult(save.status === "written" ? "exported" : "cancelled");
      if (save.status === "written") setExportOpen(false);
      setExportPreview(null);
    } catch {
      setResult("failed");
    } finally {
      setPendingOperation(null);
    }
  }

  async function chooseRestore() {
    setPendingOperation("choose-restore");
    setResult("idle");
    try {
      const preview = await client.previewRestore();
      setRestorePreview(preview);
      if (!preview) setResult("cancelled");
    } catch {
      setResult("failed");
    } finally {
      setPendingOperation(null);
    }
  }

  async function commitRestore() {
    if (!restorePreview) return;
    setPendingOperation("commit-restore");
    try {
      const restored = await client.commitRestore(restorePreview.previewId, resolution);
      settings.acceptSnapshot(restored.settingsSnapshot);
      setRestorePreview(null);
      setResult("restored");
    } catch {
      setRestorePreview(null);
      setResult("failed");
    } finally {
      setPendingOperation(null);
    }
  }

  const hasScope = scope.settings || scope.profiles || scope.patches || scope.schedules;
  const pending = pendingOperation !== null;

  return (
    <div className={backupStyles().control()}>
      <div className="settings-inline-control">
        <Button
          disabled={!supported || pending}
          onClick={() => {
            setExportPreview(null);
            setExportOpen(true);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {LL.settingsPage.backupFlow.create()}
        </Button>
        <Button
          disabled={!supported || pending}
          loading={pendingOperation === "choose-restore"}
          loadingText={LL.settingsPage.backupFlow.restore()}
          onClick={() => void chooseRestore()}
          size="sm"
          type="button"
          variant="outline"
        >
          {LL.settingsPage.backupFlow.restore()}
        </Button>
        {!supported ? <Badge variant="outline">{LL.common.unavailable()}</Badge> : null}
      </div>
      {result !== "idle" ? (
        <span className={backupStyles().result()} data-status={result} role="status">
          {LL.settingsPage.backupFlow.result[result]()}
        </span>
      ) : null}

      <Dialog onOpenChange={setExportOpen} open={exportOpen}>
        <DialogContent className={backupStyles().dialog()} closeLabel={LL.common.close()}>
          <DialogHeader>
            <DialogTitle>{LL.settingsPage.backupFlow.exportTitle()}</DialogTitle>
            <DialogDescription>{LL.settingsPage.backupFlow.exportDescription()}</DialogDescription>
          </DialogHeader>
          <fieldset className={backupStyles().fieldset()}>
            <legend>{LL.settingsPage.backupFlow.scope()}</legend>
            <ScopeOption
              checked={scope.settings}
              description={LL.settingsPage.backupFlow.settingsDescription()}
              label={LL.settingsPage.backupFlow.settings()}
              onChange={(selected) => changeScope("settings", selected)}
            />
            <ScopeOption
              checked={scope.patches}
              description={LL.settingsPage.backupFlow.patchesDescription()}
              label={LL.settingsPage.backupFlow.patches()}
              onChange={(selected) => changeScope("patches", selected)}
            />
            <ScopeOption
              checked={scope.schedules}
              description={LL.settingsPage.backupFlow.schedulesDescription()}
              label={LL.settingsPage.backupFlow.schedules()}
              onChange={(selected) => changeScope("schedules", selected)}
            />
            <ScopeOption
              checked={scope.profiles}
              description={LL.settingsPage.backupFlow.profilesSensitiveDescription()}
              label={LL.settingsPage.backupFlow.profilesSensitive()}
              onChange={(selected) => changeScope("profiles", selected)}
              sensitive
            />
            <ScopeOption
              checked={scope.sourceLocators}
              description={LL.settingsPage.backupFlow.locatorsSensitiveDescription()}
              disabled={!scope.profiles}
              label={LL.settingsPage.backupFlow.locatorsSensitive()}
              onChange={(selected) => changeScope("sourceLocators", selected)}
              sensitive
            />
          </fieldset>
          {exportPreview ? (
            <BackupSummary
              bytes={exportPreview.contentBytes}
              counts={exportPreview.included}
              maxBytes={exportPreview.maxBytes}
            />
          ) : (
            <p className={backupStyles().boundary()}>
              {LL.settingsPage.backupFlow.exclusionSummary()}
            </p>
          )}
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => setExportOpen(false)}
              type="button"
              variant="outline"
            >
              {LL.common.cancel()}
            </Button>
            {exportPreview ? (
              <Button
                disabled={pending}
                loading={pendingOperation === "save-export"}
                loadingText={LL.common.pending()}
                onClick={() => void saveExport()}
                type="button"
              >
                {LL.settingsPage.backupFlow.save()}
              </Button>
            ) : (
              <Button
                disabled={pending || !hasScope}
                loading={pendingOperation === "preview-export"}
                loadingText={LL.common.pending()}
                onClick={() => void previewExport()}
                type="button"
              >
                {LL.settingsPage.backupFlow.preview()}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setRestorePreview(null);
        }}
        open={restorePreview !== null}
      >
        <DialogContent className={backupStyles().dialog()} closeLabel={LL.common.close()}>
          {restorePreview ? (
            <>
              <DialogHeader>
                <DialogTitle>{LL.settingsPage.backupFlow.restoreTitle()}</DialogTitle>
                <DialogDescription>
                  {LL.settingsPage.backupFlow.restoreDescription()}
                </DialogDescription>
              </DialogHeader>
              <BackupSummary
                bytes={restorePreview.contentBytes}
                counts={restorePreview.included}
                maxBytes={restorePreview.maxBytes}
              />
              <RestoreScopeSummary preview={restorePreview} />
              {restorePreview.conflicts.length > 0 ? (
                <div className={backupStyles().conflicts()}>
                  <strong>{LL.settingsPage.backupFlow.conflicts()}</strong>
                  <ul>
                    {restorePreview.conflicts.map((conflict) => (
                      <li key={`${conflict.profileId}-${conflict.kind}`}>
                        <span>{conflict.label}</span>
                        <Badge variant={conflict.replaceAllowed ? "warning" : "destructive"}>
                          {conflictLabel(LL.settingsPage.backupFlow.conflict, conflict.kind)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  <fieldset className={backupStyles().resolution()}>
                    <legend>{LL.settingsPage.backupFlow.resolution()}</legend>
                    <label>
                      <input
                        checked={resolution === "keep-existing"}
                        name="restore-resolution"
                        onChange={() => setResolution("keep-existing")}
                        type="radio"
                      />
                      <span>{LL.settingsPage.backupFlow.keepExisting()}</span>
                    </label>
                    <label>
                      <input
                        checked={resolution === "use-backup"}
                        name="restore-resolution"
                        onChange={() => setResolution("use-backup")}
                        type="radio"
                      />
                      <span>{LL.settingsPage.backupFlow.useBackup()}</span>
                    </label>
                  </fieldset>
                </div>
              ) : null}
              <p className={backupStyles().safety()}>
                <Warning aria-hidden="true" />
                {LL.settingsPage.backupFlow.restoreSafety()}
              </p>
              <DialogFooter>
                <Button
                  disabled={pending}
                  onClick={() => setRestorePreview(null)}
                  type="button"
                  variant="outline"
                >
                  {LL.common.cancel()}
                </Button>
                <Button
                  disabled={pending}
                  loading={pendingOperation === "commit-restore"}
                  loadingText={LL.common.pending()}
                  onClick={() => void commitRestore()}
                  type="button"
                >
                  {LL.settingsPage.backupFlow.commit()}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ScopeOption({
  checked,
  description,
  disabled = false,
  label,
  onChange,
  sensitive = false,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onChange(selected: boolean): void;
  sensitive?: boolean;
}) {
  return (
    <label className={backupStyles().option()} data-sensitive={sensitive}>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function BackupSummary({
  bytes,
  counts,
  maxBytes,
}: {
  bytes: number;
  counts: LocalBackupPreviewDto["included"];
  maxBytes: number;
}) {
  const { LL } = useI18nContext();
  return (
    <dl className={backupStyles().summary()}>
      <div>
        <dt>{LL.settingsPage.backupFlow.format()}</dt>
        <dd>JSON · v1</dd>
      </div>
      <div>
        <dt>{LL.settingsPage.backupFlow.size()}</dt>
        <dd>
          {formatBytes(bytes)} / {formatBytes(maxBytes)}
        </dd>
      </div>
      <div>
        <dt>{LL.settingsPage.backupFlow.contents()}</dt>
        <dd>
          {LL.settingsPage.backupFlow.contentCounts({
            patches: counts.patches,
            profiles: counts.profiles,
            schedules: counts.schedules,
            settings: counts.settings,
          })}
        </dd>
      </div>
    </dl>
  );
}

function RestoreScopeSummary({ preview }: { preview: LocalRestorePreviewDto }) {
  const { LL } = useI18nContext();
  const sensitive = new Set(preview.includedSensitiveData);
  const scopeLabels = [
    preview.scope.settings && LL.settingsPage.backupFlow.settings(),
    preview.scope.patches && LL.settingsPage.backupFlow.patches(),
    preview.scope.schedules && LL.settingsPage.backupFlow.schedules(),
    preview.scope.profiles && LL.settingsPage.backupFlow.profilesSensitive(),
    preview.scope.sourceLocators && LL.settingsPage.backupFlow.locatorsSensitive(),
  ].filter((label) => label !== false);
  return (
    <section
      aria-label={LL.settingsPage.backupFlow.restoreScope()}
      className={backupStyles().restoreScope()}
    >
      <strong>{LL.settingsPage.backupFlow.restoreScope()}</strong>
      <p>{scopeLabels.join(" · ")}</p>
      <dl>
        <SensitiveScopeRow
          included={sensitive.has("credentials-and-profile-contents")}
          label={LL.settingsPage.backupFlow.profileSecretsScope()}
        />
        <SensitiveScopeRow
          included={sensitive.has("subscription-urls-and-full-paths")}
          label={LL.settingsPage.backupFlow.sourceLocatorsScope()}
        />
      </dl>
    </section>
  );
}

function SensitiveScopeRow({ included, label }: { included: boolean; label: string }) {
  const { LL } = useI18nContext();
  return (
    <div data-included={included}>
      <dt>{label}</dt>
      <dd>
        {included ? LL.settingsPage.backupFlow.included() : LL.settingsPage.backupFlow.excluded()}
      </dd>
    </div>
  );
}

function conflictLabel(
  labels: Record<LocalRestoreConflictKind, () => string>,
  kind: LocalRestoreConflictKind,
) {
  return labels[kind]();
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}
