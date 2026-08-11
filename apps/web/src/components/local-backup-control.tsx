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
import { useRef, useState } from "react";
import { cx, tv } from "@mish/ui/tv";
import { useSettings } from "../data/settings-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { LocalBackupExportAuthorityFailure } from "../platform/local-backup-authority";

const DEFAULT_SCOPE: LocalBackupScopeDto = {
  patches: true,
  profiles: false,
  schedules: true,
  settings: true,
  sourceLocators: false,
};

const backupStyles = tv({
  slots: {
    control: "grid justify-items-end gap-1.25 @max-settings-compact:justify-items-start",
    result: cx(
      "min-h-4.25 max-w-container-session-compact text-right text-caption leading-4.25",
      "text-muted-foreground data-[status=busy]:text-error data-[status=failed]:text-error",
      "data-[status=previewExpired]:text-error data-[status=recoveryRequired]:text-error",
      "data-[status=exported]:text-success-text",
      "data-[status=restored]:text-success-text @max-settings-compact:text-left",
    ),
    dialog: cx(
      "w-[min(680px,calc(100vw_-_32px))] max-h-[min(780px,calc(100vh_-_32px))]",
      "[&_.dialog-header]:grid [&_.dialog-header]:content-center",
    ),
    fieldset: cx(
      "grid gap-px overflow-hidden rounded-md border border-hairline bg-hairline-soft p-0 m-4",
      "[&_legend]:w-full [&_legend]:bg-canvas [&_legend]:pb-2.25 [&_legend]:text-metadata",
      "[&_legend]:font-semibold",
    ),
    option: cx(
      "grid min-h-13 grid-cols-[18px_minmax(0,1fr)] items-start gap-2.5 bg-canvas px-2.75 py-2.25",
      "has-disabled:opacity-55 [&_input]:mt-0.5 [&_input]:size-3.75 [&_input]:accent-brand",
      "[&>span]:grid [&>span]:gap-0.5 [&_strong]:text-metadata [&_strong]:font-medium",
      "[&_small]:text-caption [&_small]:leading-4.25 [&_small]:text-muted-foreground",
      "data-[sensitive=true]:[&_strong]:text-warning",
    ),
    previewRegion: "mx-4 mb-4 grid min-h-20 content-center",
    boundary: "m-0 text-caption leading-4.5 text-muted-foreground",
    safety: cx(
      "mx-4 mb-4 grid grid-cols-[16px_minmax(0,1fr)] gap-2 rounded-md border",
      "border-feedback-warning-border px-2.75 py-2.5 text-caption leading-4.5 text-fg",
      "[&_svg]:size-4 [&_svg]:text-warning",
    ),
    summary: cx(
      "local-backup-summary grid grid-cols-[110px_150px_minmax(0,1fr)] gap-px border-y",
      "border-hairline-soft bg-hairline-soft [&>div]:grid [&>div]:content-start [&>div]:gap-1",
      "[&>div]:bg-canvas [&>div]:px-3 [&>div]:py-2.5 [&_dt]:text-caption",
      "[&_dt]:text-muted-foreground [&_dd]:wrap-anywhere [&_dd]:text-metadata [&_dd]:text-fg",
    ),
    restoreScope: cx(
      "local-restore-scope grid gap-1.75 border-b border-hairline-soft px-4 py-3 text-metadata",
      "text-fg [&>strong]:font-semibold [&>p]:m-0 [&>p]:text-muted-foreground [&_dl]:grid",
      "[&_dl]:gap-1 [&_dl>div]:flex [&_dl>div]:items-baseline [&_dl>div]:justify-between",
      "[&_dl>div]:gap-3 [&_dd]:font-medium [&_dd]:text-muted-foreground",
      "[&_[data-included=true]_dd]:text-warning",
    ),
    conflicts: cx(
      "local-restore-conflicts grid gap-2.25 px-4 pt-4 [&>strong]:text-metadata",
      "[&>strong]:font-semibold [&_ul]:m-0 [&_ul]:grid [&_ul]:list-none [&_ul]:gap-px",
      "[&_ul]:rounded-md [&_ul]:bg-hairline-soft [&_ul]:p-px [&_li]:flex [&_li]:min-h-10",
      "[&_li]:items-center [&_li]:justify-between [&_li]:gap-3 [&_li]:bg-canvas [&_li]:px-2.5",
      "[&_li]:py-1.75 [&_li]:text-metadata [&_li]:text-fg",
    ),
    resolution: cx(
      "local-restore-resolution mt-1 grid gap-px overflow-hidden rounded-md border border-hairline",
      "bg-hairline-soft p-0 [&_legend]:w-full [&_legend]:bg-canvas [&_legend]:pb-2.25",
      "[&_legend]:text-metadata [&_legend]:font-semibold [&_label]:grid [&_label]:min-h-9.5",
      "[&_label]:grid-cols-[18px_minmax(0,1fr)] [&_label]:items-center [&_label]:gap-2",
      "[&_label]:bg-canvas [&_label]:px-2.5 [&_label]:py-1.75 [&_label]:text-metadata",
      "[&_label]:text-fg [&_input]:mt-0.5 [&_input]:size-3.75 [&_input]:accent-brand",
    ),
  },
});

type OperationResult =
  | "busy"
  | "cancelled"
  | "exported"
  | "failed"
  | "idle"
  | "previewExpired"
  | "recoveryRequired"
  | "restored";
type PendingOperation = "commit-restore" | "choose-restore" | "preview-export" | "save-export";

export function LocalBackupControl() {
  const settings = useSettings();
  const client = settings.localBackupClient;
  const { localBackupExportAuthority } = settings;
  const { LL } = useI18nContext();
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPreview, setExportPreview] = useState<LocalBackupPreviewDto | null>(null);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [resolution, setResolution] = useState<LocalRestoreConflictResolution>("keep-existing");
  const [restorePreview, setRestorePreview] = useState<LocalRestorePreviewDto | null>(null);
  const [result, setResult] = useState<OperationResult>("idle");
  const [scope, setScope] = useState(DEFAULT_SCOPE);
  const previewAttempt = useRef(0);

  const supported =
    client.availability === "supported" &&
    settings.snapshot.capabilities.backupRestore === "supported";

  function changeScope(key: keyof LocalBackupScopeDto, selected: boolean) {
    previewAttempt.current += 1;
    localBackupExportAuthority.invalidate();
    setExportPreview(null);
    setScope((current) => {
      const next = { ...current, [key]: selected };
      if (key === "profiles" && !selected) next.sourceLocators = false;
      return next;
    });
  }

  async function previewExport() {
    const attempt = ++previewAttempt.current;
    setPendingOperation("preview-export");
    setResult("idle");
    try {
      const requestResult = await localBackupExportAuthority.beginPreview(scope);
      if (requestResult.kind !== "accepted") {
        if (attempt === previewAttempt.current) {
          setExportPreview(null);
          setResult(authorityFailureResult(requestResult.kind));
        }
        return;
      }
      const preview = await client.previewExport(scope);
      const accepted = await localBackupExportAuthority.acceptPreview(
        requestResult.request,
        preview,
      );
      if (attempt !== previewAttempt.current) return;
      if (accepted.kind !== "accepted") {
        setExportPreview(null);
        setResult(authorityFailureResult(accepted.kind));
        return;
      }
      setExportPreview(accepted.authority.preview);
    } catch (error) {
      if (attempt === previewAttempt.current) {
        localBackupExportAuthority.invalidate();
        setExportPreview(null);
        setResult(operationFailure(error));
      }
    } finally {
      setPendingOperation((current) => (current === "preview-export" ? null : current));
    }
  }

  async function saveExport() {
    const preview = exportPreview;
    if (!preview) return;
    previewAttempt.current += 1;
    setPendingOperation("save-export");
    try {
      const authorized = await localBackupExportAuthority.authorizeSave(scope, preview);
      if (authorized.kind !== "accepted") {
        setExportPreview(null);
        setResult(authorityFailureResult(authorized.kind));
        return;
      }
      setExportPreview(null);
      const save = await client.saveExport(authorized.authority.preview.previewId);
      setResult(save.status === "written" ? "exported" : "cancelled");
      if (save.status === "written") setExportOpen(false);
    } catch (error) {
      setResult(operationFailure(error));
    } finally {
      setPendingOperation((current) => (current === "save-export" ? null : current));
    }
  }

  async function chooseRestore() {
    setPendingOperation("choose-restore");
    setResult("idle");
    try {
      const preview = await client.previewRestore();
      setRestorePreview(preview);
      if (!preview) setResult("cancelled");
    } catch (error) {
      setResult(operationFailure(error));
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
    } catch (error) {
      const failure = operationFailure(error);
      if (failure !== "busy") setRestorePreview(null);
      setResult(failure);
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
      <span
        aria-live="polite"
        className={backupStyles().result()}
        data-status={result}
        role="status"
      >
        {LL.settingsPage.backupFlow.result[result]()}
      </span>

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
              disabled={pendingOperation === "save-export"}
              label={LL.settingsPage.backupFlow.settings()}
              onChange={(selected) => changeScope("settings", selected)}
            />
            <ScopeOption
              checked={scope.patches}
              description={LL.settingsPage.backupFlow.patchesDescription()}
              disabled={pendingOperation === "save-export"}
              label={LL.settingsPage.backupFlow.patches()}
              onChange={(selected) => changeScope("patches", selected)}
            />
            <ScopeOption
              checked={scope.schedules}
              description={LL.settingsPage.backupFlow.schedulesDescription()}
              disabled={pendingOperation === "save-export"}
              label={LL.settingsPage.backupFlow.schedules()}
              onChange={(selected) => changeScope("schedules", selected)}
            />
            <ScopeOption
              checked={scope.profiles}
              description={LL.settingsPage.backupFlow.profilesSensitiveDescription()}
              disabled={pendingOperation === "save-export"}
              label={LL.settingsPage.backupFlow.profilesSensitive()}
              onChange={(selected) => changeScope("profiles", selected)}
              sensitive
            />
            <ScopeOption
              checked={scope.sourceLocators}
              description={LL.settingsPage.backupFlow.locatorsSensitiveDescription()}
              disabled={!scope.profiles || pendingOperation === "save-export"}
              label={LL.settingsPage.backupFlow.locatorsSensitive()}
              onChange={(selected) => changeScope("sourceLocators", selected)}
              sensitive
            />
          </fieldset>
          <div className={backupStyles().previewRegion()} data-testid="local-backup-preview-region">
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
          </div>
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => setExportOpen(false)}
              type="button"
              variant="outline"
            >
              {LL.common.cancel()}
            </Button>
            <Button
              disabled={pending || !hasScope}
              loading={pendingOperation === "preview-export"}
              loadingText={LL.common.pending()}
              onClick={() => void previewExport()}
              type="button"
              variant="outline"
            >
              {LL.settingsPage.backupFlow.preview()}
            </Button>
            <Button
              disabled={pending || !exportPreview}
              loading={pendingOperation === "save-export"}
              loadingText={LL.common.pending()}
              onClick={() => void saveExport()}
              type="button"
            >
              {LL.settingsPage.backupFlow.save()}
            </Button>
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

function operationFailure(error: unknown): OperationResult {
  if (!error || typeof error !== "object" || !("code" in error)) return "failed";
  switch (error.code) {
    case "busy":
      return "busy";
    case "preview-expired":
      return "previewExpired";
    case "recovery-required":
      return "recoveryRequired";
    default:
      return "failed";
  }
}

function authorityFailureResult(kind: LocalBackupExportAuthorityFailure): OperationResult {
  return kind === "malformed" ? "failed" : "previewExpired";
}
