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
import { useSettings } from "../data/settings-provider";
import { useI18nContext } from "../i18n/i18n-react";

const DEFAULT_SCOPE: LocalBackupScopeDto = {
  patches: true,
  profiles: false,
  schedules: true,
  settings: true,
  sourceLocators: false,
};

type OperationResult = "cancelled" | "exported" | "failed" | "idle" | "restored";

export function LocalBackupControl() {
  const settings = useSettings();
  const client = settings.localBackupClient;
  const { LL } = useI18nContext();
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPreview, setExportPreview] = useState<LocalBackupPreviewDto | null>(null);
  const [pending, setPending] = useState(false);
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
    setPending(true);
    setResult("idle");
    try {
      setExportPreview(await client.previewExport(scope));
    } catch {
      setResult("failed");
    } finally {
      setPending(false);
    }
  }

  async function saveExport() {
    if (!exportPreview) return;
    setPending(true);
    try {
      const save = await client.saveExport(exportPreview.previewId);
      setResult(save.status === "written" ? "exported" : "cancelled");
      if (save.status === "written") setExportOpen(false);
      setExportPreview(null);
    } catch {
      setResult("failed");
    } finally {
      setPending(false);
    }
  }

  async function chooseRestore() {
    setPending(true);
    setResult("idle");
    try {
      const preview = await client.previewRestore();
      setRestorePreview(preview);
      if (!preview) setResult("cancelled");
    } catch {
      setResult("failed");
    } finally {
      setPending(false);
    }
  }

  async function commitRestore() {
    if (!restorePreview) return;
    setPending(true);
    try {
      const restored = await client.commitRestore(restorePreview.previewId, resolution);
      settings.acceptSnapshot(restored.settingsSnapshot);
      setRestorePreview(null);
      setResult("restored");
    } catch {
      setRestorePreview(null);
      setResult("failed");
    } finally {
      setPending(false);
    }
  }

  const hasScope = scope.settings || scope.profiles || scope.patches || scope.schedules;

  return (
    <div className="local-backup-control">
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
        <span className="local-backup-result" data-status={result} role="status">
          {LL.settingsPage.backupFlow.result[result]()}
        </span>
      ) : null}

      <Dialog onOpenChange={setExportOpen} open={exportOpen}>
        <DialogContent className="local-backup-dialog" closeLabel={LL.common.close()}>
          <DialogHeader>
            <DialogTitle>{LL.settingsPage.backupFlow.exportTitle()}</DialogTitle>
            <DialogDescription>{LL.settingsPage.backupFlow.exportDescription()}</DialogDescription>
          </DialogHeader>
          <fieldset className="local-backup-scope">
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
            <p className="local-backup-boundary">{LL.settingsPage.backupFlow.exclusionSummary()}</p>
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
              <Button disabled={pending} onClick={() => void saveExport()} type="button">
                {pending ? LL.common.pending() : LL.settingsPage.backupFlow.save()}
              </Button>
            ) : (
              <Button
                disabled={pending || !hasScope}
                onClick={() => void previewExport()}
                type="button"
              >
                {pending ? LL.common.pending() : LL.settingsPage.backupFlow.preview()}
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
        <DialogContent className="local-backup-dialog" closeLabel={LL.common.close()}>
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
              {restorePreview.conflicts.length > 0 ? (
                <div className="local-restore-conflicts">
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
                  <fieldset className="local-restore-resolution">
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
              <p className="local-backup-safety">
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
                <Button disabled={pending} onClick={() => void commitRestore()} type="button">
                  {pending ? LL.common.pending() : LL.settingsPage.backupFlow.commit()}
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
    <label className="local-backup-option" data-sensitive={sensitive}>
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
    <dl className="local-backup-summary">
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
