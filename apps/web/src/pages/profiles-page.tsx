import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { FileText } from "@phosphor-icons/react/FileText";
import { FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { GlobeHemisphereWest } from "@phosphor-icons/react/GlobeHemisphereWest";
import { Trash } from "@phosphor-icons/react/Trash";
import { useMemo, useState, type FormEvent } from "react";
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
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  SectionGrid,
  SectionGridItem,
  Spinner,
} from "@mish/ui";
import type { ProfileListItemDto, ProfilePreviewDto } from "@mish/contracts";
import { useProfiles } from "../data/profile-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";

export function ProfilesPage() {
  const { LL, locale } = useI18nContext();
  const profiles = useProfiles();
  const [importOpen, setImportOpen] = useState(false);
  const [preview, setPreview] = useState<ProfilePreviewDto | null>(null);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProfileListItemDto | null>(null);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  const snapshot = profiles.snapshot;
  const httpsSupported = snapshot?.capabilities.httpsImport === "supported";
  const localSupported =
    snapshot?.capabilities.localFileImport === "supported" ||
    snapshot?.capabilities.localFileImport === "permission-required";

  function openHttpsImport() {
    setUrl("");
    setLabel("");
    setPreview(null);
    setImportOpen(true);
  }

  function closeImport() {
    setImportOpen(false);
    setPreview(null);
    setUrl("");
    setLabel("");
  }

  async function preflightHttps(event: FormEvent) {
    event.preventDefault();
    const result = await profiles.preflightHttps(url, label.trim() || undefined);
    setUrl("");
    if (!result.ok) {
      toast.error(LL.profiles.importFailed());
      return;
    }
    setPreview(result.preview);
  }

  async function preflightLocal() {
    const result = await profiles.preflightLocal();
    if (!result.ok) {
      toast.error(LL.profiles.importFailed());
      return;
    }
    if (!result.preview) return;
    setPreview(result.preview);
    setImportOpen(true);
  }

  async function savePreview() {
    if (!preview) return;
    const result = await profiles.savePreview(preview.previewId);
    if (!result.ok) {
      toast.error(LL.profiles.saveFailed());
      return;
    }
    toast.success(LL.profiles.savedToast());
    closeImport();
  }

  async function refreshProfile(profileId: string) {
    const result = await profiles.refreshProfile(profileId);
    if (!result.ok) {
      toast.error(LL.profiles.refreshFailed());
    }
  }

  async function deleteProfile() {
    if (!deleteTarget) return;
    const result = await profiles.deleteProfile(deleteTarget.id);
    if (!result.ok) {
      toast.error(LL.profiles.deleteFailed());
      return;
    }
    toast.success(LL.profiles.deletedToast());
    setDeleteTarget(null);
  }

  return (
    <div className="profiles-page page-scroll">
      <header className="profiles-header">
        <div>
          <h1>{LL.profiles.title()}</h1>
          <p>{LL.profiles.description()}</p>
        </div>
        <div className="profiles-import-actions">
          <Button
            disabled={!localSupported || profiles.isPending("preflight")}
            onClick={preflightLocal}
            variant="outline"
          >
            <FolderOpen data-icon="inline-start" />
            {LL.profiles.importLocal()}
          </Button>
          <Button
            disabled={!httpsSupported || profiles.isPending("preflight")}
            onClick={openHttpsImport}
          >
            <GlobeHemisphereWest data-icon="inline-start" />
            {LL.profiles.importHttps()}
          </Button>
        </div>
      </header>

      <section className="profiles-boundary" aria-label={LL.profiles.title()}>
        <FileText aria-hidden="true" />
        <p>
          {snapshot?.adapterKind === "fixture"
            ? LL.profiles.fixtureDescription()
            : LL.profiles.desktopDescription()}
        </p>
      </section>

      {snapshot?.adapterKind === "rpc" ? (
        <p className="profiles-local-boundary">{LL.profiles.localPermission()}</p>
      ) : null}

      {profiles.isLoading ? <p className="profiles-loading">{LL.profiles.loading()}</p> : null}

      {snapshot && snapshot.profiles.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{LL.profiles.emptyTitle()}</EmptyTitle>
            <EmptyDescription>{LL.profiles.emptyDescription()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {snapshot && snapshot.profiles.length > 0 ? (
        <SectionGrid aria-label={LL.profiles.profilesAria()} className="profile-list">
          {snapshot.profiles.map((profile) => (
            <ProfileRow
              LL={LL}
              dateFormatter={dateFormatter}
              deletionSupported={snapshot.capabilities.deletion === "supported"}
              key={profile.id}
              onDelete={() => setDeleteTarget(profile)}
              onRefresh={() => refreshProfile(profile.id)}
              profile={profile}
              refreshPending={profiles.isPending("refresh", profile.id)}
              refreshSupported={snapshot.capabilities.refresh === "supported"}
            />
          ))}
        </SectionGrid>
      ) : null}

      <Dialog
        onOpenChange={(open) => (open ? setImportOpen(true) : closeImport())}
        open={importOpen}
      >
        <DialogContent className="profile-import-dialog" closeLabel={LL.common.close()}>
          <DialogHeader>
            <div>
              <DialogTitle className="dialog-title">
                {preview ? LL.profiles.previewTitle() : LL.profiles.importTitle()}
              </DialogTitle>
              <DialogDescription className="dialog-description">
                {preview ? LL.profiles.previewDescription() : LL.profiles.importDescription()}
              </DialogDescription>
            </div>
          </DialogHeader>
          {preview ? (
            <ProfilePreview LL={LL} preview={preview} />
          ) : (
            <form
              className="profile-import-form"
              id="profile-import-form"
              onSubmit={preflightHttps}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="profile-label">{LL.profiles.labelLabel()}</FieldLabel>
                  <Input
                    autoComplete="off"
                    id="profile-label"
                    maxLength={120}
                    onValueChange={setLabel}
                    value={label}
                  />
                  <FieldDescription>{LL.profiles.labelDescription()}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="profile-url">{LL.profiles.httpsLabel()}</FieldLabel>
                  <Input
                    aria-required="true"
                    autoComplete="off"
                    id="profile-url"
                    inputMode="url"
                    onValueChange={setUrl}
                    required
                    spellCheck={false}
                    type="password"
                    value={url}
                  />
                  <FieldDescription>{LL.profiles.httpsDescription()}</FieldDescription>
                </Field>
              </FieldGroup>
            </form>
          )}
          <DialogFooter>
            <Button onClick={closeImport} type="button" variant="outline">
              {LL.common.cancel()}
            </Button>
            {preview ? (
              <Button disabled={profiles.isPending("save")} onClick={savePreview}>
                {profiles.isPending("save") ? <Spinner data-icon="inline-start" /> : null}
                {profiles.isPending("save") ? LL.profiles.saving() : LL.profiles.saveProfile()}
              </Button>
            ) : (
              <Button
                disabled={!url || profiles.isPending("preflight")}
                form="profile-import-form"
                type="submit"
              >
                {profiles.isPending("preflight") ? <Spinner data-icon="inline-start" /> : null}
                {profiles.isPending("preflight") ? LL.profiles.checking() : LL.profiles.preflight()}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        open={deleteTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {LL.profiles.deleteTitle({ profile: deleteTarget?.label ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{LL.profiles.deleteDescription()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{LL.common.cancel()}</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                !deleteTarget ||
                deleteTarget.status.active ||
                profiles.isPending("delete", deleteTarget.id)
              }
              onClick={deleteProfile}
              variant="destructive"
            >
              {profiles.isPending("delete", deleteTarget?.id) ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              {LL.common.delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface ProfileRowProps {
  LL: TranslationFunctions;
  dateFormatter: Intl.DateTimeFormat;
  deletionSupported: boolean;
  onDelete(): void;
  onRefresh(): void;
  profile: ProfileListItemDto;
  refreshPending: boolean;
  refreshSupported: boolean;
}

function ProfileRow({
  LL,
  dateFormatter,
  deletionSupported,
  onDelete,
  onRefresh,
  profile,
  refreshPending,
  refreshSupported,
}: ProfileRowProps) {
  return (
    <SectionGridItem className="profile-row">
      <div className="profile-row-main">
        <div className="profile-row-title">
          <strong className="user-authored-label" title={profile.label}>
            {profile.label}
          </strong>
          <div className="profile-statuses">
            {profile.status.active ? <Badge variant="success">{LL.profiles.active()}</Badge> : null}
            {profile.status.error ? (
              <Badge variant="destructive">{LL.profiles.error()}</Badge>
            ) : null}
            {profile.status.stale ? <Badge variant="warning">{LL.profiles.stale()}</Badge> : null}
            {profile.status.warning ? (
              <Badge variant="warning">{LL.profiles.warning()}</Badge>
            ) : null}
            {profile.status.valid ? <Badge>{LL.profiles.valid()}</Badge> : null}
            {profile.lastKnownValid && profile.status.error ? (
              <Badge variant="outline">{LL.profiles.lastKnownValid()}</Badge>
            ) : null}
          </div>
        </div>
        <span className="profile-source-summary user-authored-label" title={profile.source.display}>
          {profile.source.display}
        </span>
        <dl className="profile-timestamps">
          <div>
            <dt>{LL.profiles.lastAttempt()}</dt>
            <dd>
              {profile.lastAttempt
                ? `${dateFormatter.format(profile.lastAttempt.attemptedAt)} · ${
                    profile.lastAttempt.outcome === "succeeded"
                      ? LL.profiles.attemptSucceeded()
                      : LL.profiles.attemptFailed()
                  }`
                : LL.profiles.never()}
            </dd>
          </div>
          <div>
            <dt>{LL.profiles.lastSuccess()}</dt>
            <dd>
              {profile.lastSuccessAt
                ? dateFormatter.format(profile.lastSuccessAt)
                : LL.profiles.never()}
            </dd>
          </div>
        </dl>
        {profile.status.active ? (
          <p className="profile-boundary-explanation">{LL.profiles.activeDeleteUnavailable()}</p>
        ) : null}
      </div>
      <div className="profile-row-actions">
        <Button disabled variant="outline">
          {LL.profiles.activation()}
        </Button>
        <Button
          disabled={!refreshSupported || refreshPending}
          onClick={onRefresh}
          variant="outline"
        >
          {refreshPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ArrowClockwise data-icon="inline-start" />
          )}
          {refreshPending ? LL.profiles.refreshing() : LL.profiles.refresh()}
        </Button>
        <Button
          aria-label={`${LL.common.delete()} ${profile.label}`}
          disabled={!deletionSupported || profile.status.active}
          onClick={onDelete}
          size="icon-sm"
          title={profile.status.active ? LL.profiles.activeDeleteUnavailable() : LL.common.delete()}
          variant="ghost"
        >
          <Trash aria-hidden="true" />
        </Button>
      </div>
      <p className="profile-activation-explanation">{LL.profiles.activationUnavailable()}</p>
    </SectionGridItem>
  );
}

function ProfilePreview({ LL, preview }: { LL: TranslationFunctions; preview: ProfilePreviewDto }) {
  return (
    <div className="profile-preview">
      <div className="profile-preview-heading">
        <strong className="user-authored-label">{preview.label}</strong>
        <Badge variant="outline">
          {preview.sourceType === "https" ? LL.profiles.sourceHttps() : LL.profiles.sourceLocal()}
        </Badge>
      </div>
      <SectionGrid className="profile-preview-counts" columns={3}>
        <SectionGridItem>
          <span>{LL.profiles.proxies()}</span>
          <strong>{preview.proxyCount}</strong>
        </SectionGridItem>
        <SectionGridItem>
          <span>{LL.profiles.groups()}</span>
          <strong>{preview.groupCount}</strong>
        </SectionGridItem>
        <SectionGridItem>
          <span>{LL.profiles.rules()}</span>
          <strong>{preview.ruleCount}</strong>
        </SectionGridItem>
      </SectionGrid>
      <div className="profile-preview-classifications">
        <strong>{LL.profiles.classifications()}</strong>
        <span>
          {LL.profiles.classificationPreserved({ count: preview.classificationCounts.preserved })}
        </span>
        <span>
          {LL.profiles.classificationOverridden({ count: preview.classificationCounts.overridden })}
        </span>
        <span>
          {LL.profiles.classificationDisabled({ count: preview.classificationCounts.disabled })}
        </span>
        <span>
          {LL.profiles.classificationRejected({ count: preview.classificationCounts.rejected })}
        </span>
      </div>
      <p className="profile-preview-sensitive">{LL.profiles.sensitiveNotice()}</p>
      <Badge variant="warning">
        {LL.profiles.warnings({ count: preview.warningCodes.length })}
      </Badge>
    </div>
  );
}
