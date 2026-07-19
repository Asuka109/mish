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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from "@mish/ui";
import type {
  ProfileActivationSnapshotDto,
  ProfileListItemDto,
  ProfilePolicyClassificationDto,
  ProfilePreviewDto,
  ProfileRuntimeProvenanceDto,
} from "@mish/contracts";
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
  const [replacementProfileId, setReplacementProfileId] = useState<string | null>(null);
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  const snapshot = profiles.snapshot;
  const httpsSupported = snapshot?.capabilities.httpsImport === "supported";
  const localSupported =
    snapshot?.capabilities.localFileImport === "supported" ||
    snapshot?.capabilities.localFileImport === "permission-required";
  const activationSupported = snapshot?.capabilities.activation === "supported";
  const currentDeleteTarget = snapshot?.profiles.find((profile) => profile.id === deleteTarget?.id);
  const replacementProfiles =
    snapshot?.profiles.filter(
      (profile) => profile.id !== deleteTarget?.id && profile.status.valid,
    ) ?? [];

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

  async function activateProfile(profileId: string) {
    const result = await profiles.activateProfile(profileId);
    if (!result.ok) toast.error(LL.profiles.activationFailed());
  }

  async function cancelActivation() {
    const result = await profiles.cancelActivation();
    if (!result.ok) toast.error(LL.profiles.activationFailed());
  }

  async function stopForDeletion() {
    const result = await profiles.stopActiveProfile();
    if (!result.ok) toast.error(LL.profiles.activationFailed());
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
              activation={snapshot.activation}
              activationSupported={activationSupported}
              key={profile.id}
              onActivate={() => activateProfile(profile.id)}
              onCancelActivation={cancelActivation}
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
          if (!open) {
            setDeleteTarget(null);
            setReplacementProfileId(null);
          }
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
          {currentDeleteTarget?.status.active ? (
            <div className="profile-delete-active-options">
              <p>{LL.profiles.chooseReplacement()}</p>
              {replacementProfiles.length > 0 ? (
                <div className="profile-delete-replacement">
                  <Select
                    onValueChange={(value) => setReplacementProfileId(value)}
                    value={replacementProfileId}
                  >
                    <SelectTrigger aria-label={LL.profiles.chooseReplacement()}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {replacementProfiles.map((profile) => (
                        <SelectItem key={profile.id} value={profile.id}>
                          <span className="user-authored-label">{profile.label}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    disabled={!replacementProfileId || profiles.isPending("activate")}
                    onClick={() => replacementProfileId && activateProfile(replacementProfileId)}
                    type="button"
                    variant="outline"
                  >
                    {profiles.isPending("activate") ? <Spinner data-icon="inline-start" /> : null}
                    {profiles.isPending("activate")
                      ? LL.profiles.activating()
                      : LL.profiles.activation()}
                  </Button>
                </div>
              ) : null}
              <Button
                disabled={profiles.isPending("stop") || profiles.isPending("activate")}
                onClick={stopForDeletion}
                type="button"
                variant="outline"
              >
                {profiles.isPending("stop") ? <Spinner data-icon="inline-start" /> : null}
                {profiles.isPending("stop")
                  ? LL.profiles.stopping()
                  : LL.profiles.stopForDeletion()}
              </Button>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{LL.common.cancel()}</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                !deleteTarget ||
                currentDeleteTarget?.status.active ||
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
  activation: ProfileActivationSnapshotDto;
  activationSupported: boolean;
  dateFormatter: Intl.DateTimeFormat;
  deletionSupported: boolean;
  onActivate(): void;
  onCancelActivation(): void;
  onDelete(): void;
  onRefresh(): void;
  profile: ProfileListItemDto;
  refreshPending: boolean;
  refreshSupported: boolean;
}

function ProfileRow({
  LL,
  activation,
  activationSupported,
  dateFormatter,
  deletionSupported,
  onActivate,
  onCancelActivation,
  onDelete,
  onRefresh,
  profile,
  refreshPending,
  refreshSupported,
}: ProfileRowProps) {
  const activationPending =
    activation.phase === "pending" && activation.targetProfileId === profile.id;
  const activationMessage =
    activation.availability === "missing-binary"
      ? LL.profiles.binaryMissing()
      : activation.phase === "failure" && activation.targetProfileId === profile.id
        ? activation.failure === "cancelled"
          ? LL.profiles.activationCancelled()
          : LL.profiles.activationFailed()
        : !activationSupported
          ? LL.profiles.activationUnavailable()
          : null;
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
        <Button
          disabled={
            !activationSupported ||
            profile.status.active ||
            (activation.phase === "pending" && !activationPending)
          }
          onClick={activationPending ? onCancelActivation : onActivate}
          variant="outline"
        >
          {activationPending ? <Spinner data-icon="inline-start" /> : null}
          {activationPending ? LL.profiles.cancelActivation() : LL.profiles.activation()}
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
          disabled={!deletionSupported}
          onClick={onDelete}
          size="icon-sm"
          title={profile.status.active ? LL.profiles.chooseReplacement() : LL.common.delete()}
          variant="ghost"
        >
          <Trash aria-hidden="true" />
        </Button>
      </div>
      {activationMessage ? (
        <p className="profile-activation-explanation">{activationMessage}</p>
      ) : null}
      <ProfileProvenance
        LL={LL}
        activeFingerprint={activation.activeFingerprint}
        isActive={profile.status.active}
        review={profile.runtimeProvenance}
      />
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
          {LL.profiles.classificationApplicationOverridden({
            count: preview.classificationCounts.applicationOverridden,
          })}
        </span>
        <span>
          {LL.profiles.classificationPlatformOverridden({
            count: preview.classificationCounts.platformOverridden,
          })}
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
      <ProfileProvenance LL={LL} preview review={preview.runtimeProvenance} />
    </div>
  );
}

interface ProfileProvenanceProps {
  LL: TranslationFunctions;
  activeFingerprint?: string | null;
  isActive?: boolean;
  preview?: boolean;
  review: ProfileRuntimeProvenanceDto;
}

function ProfileProvenance({
  LL,
  activeFingerprint,
  isActive = false,
  preview = false,
  review,
}: ProfileProvenanceProps) {
  const revisionMatchesRuntime = !isActive || activeFingerprint === review.artifactFingerprint;
  return (
    <details className="profile-provenance" open={preview || undefined}>
      <summary>
        <span>{LL.profiles.provenanceDetail()}</span>
        <span className="profile-provenance-authority">
          {review.authority === "desktop-policy"
            ? LL.profiles.provenanceAuthorityDesktop()
            : review.authority === "illustrative-browser-fixture"
              ? LL.profiles.provenanceAuthorityFixture()
              : LL.profiles.provenanceAuthorityMigrated()}
        </span>
      </summary>
      <div className="profile-provenance-content">
        <p className="profile-provenance-flow">{LL.profiles.provenanceLayerFlow()}</p>
        <p className="profile-provenance-binding">
          {LL.profiles.provenanceRevisionBinding({
            fingerprint: shortHash(review.artifactFingerprint),
            revision: shortHash(review.sourceRevision),
          })}
        </p>
        {!revisionMatchesRuntime ? (
          <p className="profile-provenance-mismatch">{LL.profiles.provenanceRevisionMismatch()}</p>
        ) : null}
        <ul className="profile-provenance-items">
          {review.items.map((item) => (
            <ProvenanceItem LL={LL} item={item} key={`${item.fieldIdentity}:${item.owner}`} />
          ))}
        </ul>
      </div>
    </details>
  );
}

function ProvenanceItem({
  LL,
  item,
}: {
  LL: TranslationFunctions;
  item: ProfilePolicyClassificationDto;
}) {
  return (
    <li className="profile-provenance-item">
      <div className="profile-provenance-item-heading">
        <code>{item.fieldIdentity}</code>
        <Badge variant={item.disposition === "rejected" ? "destructive" : "outline"}>
          {policyDisposition(LL, item.disposition)}
        </Badge>
      </div>
      <p>
        {policyOwner(LL, item.owner)} · {policyReason(LL, item.reason)}
      </p>
      <p>
        {LL.profiles.provenanceActivationImpact()}: {activationImpact(LL, item.activationImpact)}
      </p>
      <span className="profile-provenance-presence">
        {item.sourcePresent
          ? LL.profiles.provenanceSourceField()
          : LL.profiles.provenanceBaseline()}
      </span>
    </li>
  );
}

function shortHash(value: string) {
  return `${value.slice(0, 8)}…`;
}

function policyDisposition(
  LL: TranslationFunctions,
  disposition: ProfilePolicyClassificationDto["disposition"],
) {
  switch (disposition) {
    case "preserved":
      return LL.profiles.provenancePreserved();
    case "application-overridden":
      return LL.profiles.provenanceApplicationOverridden();
    case "platform-overridden":
      return LL.profiles.provenancePlatformOverridden();
    case "disabled":
      return LL.profiles.provenanceDisabled();
    case "rejected":
      return LL.profiles.provenanceRejected();
  }
}

function policyOwner(LL: TranslationFunctions, owner: ProfilePolicyClassificationDto["owner"]) {
  switch (owner) {
    case "source":
      return LL.profiles.provenanceOwnerSource();
    case "application-policy":
      return LL.profiles.provenanceOwnerApplication();
    case "platform-integration":
      return LL.profiles.provenanceOwnerPlatform();
  }
}

function policyReason(LL: TranslationFunctions, reason: ProfilePolicyClassificationDto["reason"]) {
  switch (reason) {
    case "portable-source-policy":
      return LL.profiles.provenanceReasonPortable();
    case "unknown-key-preserved":
      return LL.profiles.provenanceReasonUnknown();
    case "managed-proxy-ingress":
      return LL.profiles.provenanceReasonManagedIngress();
    case "loopback-only-binding":
      return LL.profiles.provenanceReasonLoopback();
    case "private-controller":
      return LL.profiles.provenanceReasonController();
    case "managed-runtime-behavior":
      return LL.profiles.provenanceReasonManagedRuntime();
    case "capture-requires-explicit-permission":
      return LL.profiles.provenanceReasonCapture();
    case "passive-inspection-only":
      return LL.profiles.provenanceReasonPassive();
    case "runtime-persistence-disabled":
      return LL.profiles.provenanceReasonRuntimePersistence();
    case "dns-integration-managed":
      return LL.profiles.provenanceReasonDns();
    case "external-surface-disabled":
      return LL.profiles.provenanceReasonExternal();
    case "device-integration-unsafe":
      return LL.profiles.provenanceReasonDevice();
    case "provider-path-unsafe":
      return LL.profiles.provenanceReasonProviderPath();
    case "relative-provider-path":
      return LL.profiles.provenanceReasonRelativeProviderPath();
  }
}

function activationImpact(
  LL: TranslationFunctions,
  impact: ProfilePolicyClassificationDto["activationImpact"],
) {
  switch (impact) {
    case "preserved-in-effective-runtime":
      return LL.profiles.provenanceImpactPreserved();
    case "replaced-by-application-value":
      return LL.profiles.provenanceImpactReplacedApplication();
    case "replaced-by-platform-value":
      return LL.profiles.provenanceImpactReplacedPlatform();
    case "forced-off":
      return LL.profiles.provenanceImpactForcedOff();
    case "blocks-import":
      return LL.profiles.provenanceImpactBlocksImport();
    case "excluded-from-effective-runtime":
      return LL.profiles.provenanceImpactExcluded();
  }
}
