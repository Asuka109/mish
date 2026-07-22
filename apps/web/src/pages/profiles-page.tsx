import { Alarm } from "@phosphor-icons/react/Alarm";
import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { FilePlus } from "@phosphor-icons/react/FilePlus";
import { FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { GlobeHemisphereWest } from "@phosphor-icons/react/GlobeHemisphereWest";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { tv } from "tailwind-variants";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mish/ui";
import type { ProfileListItemDto, ProfilePreviewDto, ProfileRefreshPolicy } from "@mish/contracts";
import { useProfiles } from "../data/profile-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";

const refreshPolicies: ProfileRefreshPolicy[] = [
  "off",
  "six-hours",
  "twelve-hours",
  "daily",
  "weekly",
];

const profileStyles = tv({
  slots: {
    cardList: "profile-card-list grid gap-3",
    card: "profile-card overflow-hidden rounded-(--radius-md) border border-(--color-hairline) bg-(--color-canvas)",
    cardHeader:
      "profile-card-header flex min-h-[58px] items-center justify-between gap-3 px-4 py-3",
    cardTitle: "profile-card-title flex min-w-0 items-center gap-2",
    cardActions: "profile-card-actions flex shrink-0 items-center gap-2",
    fileTitle:
      "profile-file-title min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-(--font-weight-control)",
    extension: "profile-file-extension text-(--color-text-muted)",
    subscription:
      "profile-subscription border-t border-(--color-hairline-soft) bg-(--color-surface-soft)",
    subscriptionGrid:
      "profile-subscription-grid grid grid-cols-[minmax(0,1fr)_auto_auto] gap-px bg-(--color-hairline-soft)",
    subscriptionCell: "bg-(--color-canvas) px-4 py-3",
    source: "profile-subscription-source grid min-w-0 gap-1",
    url: "profile-subscription-url overflow-hidden text-ellipsis whitespace-nowrap text-(--text-metadata) text-(--color-body)",
    date: "profile-subscription-date grid gap-1 text-(--text-metadata) text-(--color-text-muted) [&_strong]:text-(--color-body) [&_strong]:font-(--font-weight-control)",
    nextUpdate: "profile-next-update flex items-center gap-2",
    intervalTrigger:
      "profile-interval-trigger grid size-[30px] place-items-center rounded-(--radius-sm) border-0 bg-transparent text-(--color-text-muted) hover:bg-(--color-accent) hover:text-(--color-ink) data-[popup-open]:bg-(--color-accent) data-[popup-open]:text-(--color-ink) focus-visible:bg-(--color-accent) focus-visible:text-(--color-ink) disabled:opacity-50 [&_svg]:size-[15px]",
    overwrite:
      "profile-overwrite-note flex gap-2 px-4 py-3 text-(--text-metadata) text-(--color-text-muted) [&_svg]:mt-px [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-(--color-warning) [&_button]:text-(--color-body) [&_button]:underline hover:[&_button]:text-(--color-ink) focus-visible:[&_button]:text-(--color-ink)",
    preview: "profile-preview grid gap-3 p-4",
    previewCompact: "profile-preview-compact",
    previewList:
      "grid grid-cols-3 gap-px overflow-hidden rounded-(--radius-md) bg-(--color-hairline-soft) [&>div]:bg-(--color-canvas) [&>div]:p-3 [&_dt]:text-(--text-metadata) [&_dt]:text-(--color-text-muted) [&_dd]:mt-1 [&_dd]:font-(--font-weight-control)",
  },
});

export function ProfilesPage() {
  const { LL, locale } = useI18nContext();
  const profiles = useProfiles();
  const [createOpen, setCreateOpen] = useState(false);
  const [createFileName, setCreateFileName] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [preview, setPreview] = useState<ProfilePreviewDto | null>(null);
  const [url, setUrl] = useState("");
  const [fileName, setFileName] = useState("");
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        month: "short",
      }),
    [locale],
  );

  const snapshot = profiles.snapshot;
  const httpsSupported = snapshot?.capabilities.httpsImport === "supported";
  const fileActionsSupported = profiles.fileActionsAvailable;
  const createSupported = profiles.createProfileAvailable;

  function openCreate() {
    setCreateFileName("");
    setCreateOpen(true);
  }

  function closeCreate() {
    setCreateOpen(false);
    setCreateFileName("");
  }

  async function createProfile(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeFileName(createFileName);
    if (!normalized) return;
    const result = await profiles.createProfile(normalized);
    if (!result.ok) {
      toast.error(LL.profiles.createFailed());
      return;
    }
    toast.success(LL.profiles.createdToast());
    closeCreate();
  }

  function openHttpsImport() {
    setUrl("");
    setFileName("");
    setPreview(null);
    setImportOpen(true);
  }

  function closeImport() {
    setImportOpen(false);
    setPreview(null);
    setUrl("");
    setFileName("");
  }

  async function preflightHttps(event: FormEvent) {
    event.preventDefault();
    const result = await profiles.preflightHttps(url, normalizeFileName(fileName));
    if (!result.ok) {
      toast.error(LL.profiles.importFailed());
      return;
    }
    setUrl("");
    setPreview(result.preview);
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

  async function refreshProfile(profile: ProfileListItemDto) {
    const result = await profiles.refreshProfile(profile.id);
    if (!result.ok) {
      toast.error(LL.profiles.refreshFailed());
      return;
    }
    toast.success(LL.profiles.subscriptionUpdated());
  }

  async function setRefreshPolicy(profileId: string, policy: ProfileRefreshPolicy) {
    const result = await profiles.setRefreshPolicy(profileId, policy);
    if (!result.ok) toast.error(LL.profiles.scheduleFailed());
  }

  async function detachSubscription(profile: ProfileListItemDto) {
    const result = await profiles.detachSubscription(profile.id);
    if (!result.ok) {
      toast.error(LL.profiles.detachSubscriptionFailed());
      return;
    }
    toast.success(LL.profiles.subscriptionDetached());
  }

  async function openDirectory() {
    const result = await profiles.openProfileDirectory();
    if (!result.ok) toast.error(LL.profiles.fileActionFailed());
  }

  return (
    <div className="profiles-page">
      <header className="profiles-header">
        <div>
          <h1>{LL.profiles.title()}</h1>
          <p>{LL.profiles.description()}</p>
        </div>
        <div className="profiles-import-actions">
          <Button disabled={!createSupported} onClick={openCreate} variant="outline">
            <FilePlus data-icon="inline-start" />
            {LL.profiles.createProfile()}
          </Button>
          <Button
            disabled={!fileActionsSupported}
            onClick={() => void openDirectory()}
            variant="outline"
          >
            <FolderOpen data-icon="inline-start" />
            {LL.profiles.openConfigDirectory()}
          </Button>
          <Button disabled={!httpsSupported} onClick={openHttpsImport}>
            <GlobeHemisphereWest data-icon="inline-start" />
            {LL.profiles.addSubscription()}
          </Button>
        </div>
      </header>

      {profiles.isLoading ? <p className="profiles-loading">{LL.profiles.loading()}</p> : null}

      {snapshot && snapshot.profiles.length === 0 ? (
        <Empty className="profiles-empty">
          <EmptyHeader>
            <EmptyTitle>{LL.profiles.emptyTitle()}</EmptyTitle>
            <EmptyDescription>{LL.profiles.emptyDescription()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {snapshot && snapshot.profiles.length > 0 ? (
        <section aria-label={LL.profiles.profilesAria()} className={profileStyles().cardList()}>
          {snapshot.profiles.map((profile) => (
            <ProfileCard
              LL={LL}
              dateFormatter={dateFormatter}
              fileActionsSupported={fileActionsSupported}
              key={profile.id}
              onDetach={() => void detachSubscription(profile)}
              onRefresh={() => void refreshProfile(profile)}
              onOpenDirectory={() => void openDirectory()}
              onSchedule={(policy) => void setRefreshPolicy(profile.id, policy)}
              profile={profile}
              refreshPending={profiles.isPending("refresh", profile.id)}
              refreshSupported={snapshot.capabilities.refresh === "supported"}
              schedulePending={profiles.isPending("schedule", profile.id)}
              schedulingSupported={snapshot.capabilities.scheduling === "supported"}
            />
          ))}
        </section>
      ) : null}

      <Dialog
        onOpenChange={(open) => (open ? setCreateOpen(true) : closeCreate())}
        open={createOpen}
      >
        <DialogContent className="profile-import-dialog" closeLabel={LL.common.close()}>
          <DialogHeader>
            <div>
              <DialogTitle className="dialog-title">{LL.profiles.createTitle()}</DialogTitle>
              <DialogDescription className="dialog-description">
                {LL.profiles.createDescription()}
              </DialogDescription>
            </div>
          </DialogHeader>
          <form className="profile-import-form" id="profile-create-form" onSubmit={createProfile}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="profile-create-file-name">
                  {LL.profiles.fileNameLabel()}
                </FieldLabel>
                <Input
                  aria-required="true"
                  autoComplete="off"
                  autoFocus
                  id="profile-create-file-name"
                  maxLength={115}
                  onValueChange={setCreateFileName}
                  placeholder="my-profile.yaml"
                  required
                  spellCheck={false}
                  value={createFileName}
                />
                <FieldDescription>{LL.profiles.fileNameDescription()}</FieldDescription>
              </Field>
            </FieldGroup>
          </form>
          <DialogFooter>
            <Button onClick={closeCreate} type="button" variant="outline">
              {LL.common.cancel()}
            </Button>
            <Button
              disabled={!normalizeFileName(createFileName) || profiles.isPending("create")}
              form="profile-create-form"
              loading={profiles.isPending("create")}
              loadingText={LL.profiles.creating()}
              type="submit"
            >
              {LL.profiles.createProfile()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => (open ? setImportOpen(true) : closeImport())}
        open={importOpen}
      >
        <DialogContent className="profile-import-dialog" closeLabel={LL.common.close()}>
          <DialogHeader>
            <div>
              <DialogTitle className="dialog-title">
                {preview ? LL.profiles.previewTitle() : LL.profiles.addSubscription()}
              </DialogTitle>
              <DialogDescription className="dialog-description">
                {preview
                  ? LL.profiles.previewDescription()
                  : LL.profiles.subscriptionImportDescription()}
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
                  <FieldLabel htmlFor="profile-file-name">{LL.profiles.fileNameLabel()}</FieldLabel>
                  <Input
                    autoComplete="off"
                    id="profile-file-name"
                    maxLength={120}
                    onValueChange={setFileName}
                    placeholder="studio-route-set.yaml"
                    value={fileName}
                  />
                  <FieldDescription>{LL.profiles.fileNameDescription()}</FieldDescription>
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
                    type="url"
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
              <Button
                disabled={profiles.isPending("save")}
                loading={profiles.isPending("save")}
                loadingText={LL.profiles.saving()}
                onClick={() => void savePreview()}
              >
                {LL.profiles.saveProfile()}
              </Button>
            ) : (
              <Button
                disabled={!url || profiles.isPending("preflight")}
                form="profile-import-form"
                loading={profiles.isPending("preflight")}
                loadingText={LL.profiles.checking()}
                type="submit"
              >
                {LL.profiles.checkAndSave()}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ProfileCardProps {
  LL: TranslationFunctions;
  dateFormatter: Intl.DateTimeFormat;
  fileActionsSupported: boolean;
  onDetach(): void;
  onRefresh(): void;
  onOpenDirectory(): void;
  onSchedule(policy: ProfileRefreshPolicy): void;
  profile: ProfileListItemDto;
  refreshPending: boolean;
  refreshSupported: boolean;
  schedulePending: boolean;
  schedulingSupported: boolean;
}

function ProfileCard({
  LL,
  dateFormatter,
  fileActionsSupported,
  onDetach,
  onRefresh,
  onOpenDirectory,
  onSchedule,
  profile,
  refreshPending,
  refreshSupported,
  schedulePending,
  schedulingSupported,
}: ProfileCardProps) {
  const subscription = profile.source.sourceType === "https";
  const fileName = profileFileName(profile);
  const lastUpdateAt = profile.refresh.lastSuccessAt ?? profile.lastSuccessAt;

  return (
    <article
      className={profileStyles().card()}
      data-source={subscription ? "subscription" : "local"}
    >
      <header className={profileStyles().cardHeader()}>
        <div className={profileStyles().cardTitle()}>
          <FileNameTitle fileName={fileName} />
          {profile.status.active ? <Badge variant="outline">{LL.profiles.active()}</Badge> : null}
        </div>
        <div className={profileStyles().cardActions()}>
          {subscription ? (
            <Button
              disabled={!refreshSupported || refreshPending}
              loading={refreshPending}
              loadingText={LL.profiles.updatingSubscription()}
              onClick={onRefresh}
            >
              <ArrowClockwise data-icon="inline-start" />
              {LL.profiles.updateSubscription()}
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={LL.profiles.openConfigDirectory()}
                  disabled={!fileActionsSupported}
                  onClick={onOpenDirectory}
                  size="icon-sm"
                  variant="outline"
                />
              }
            >
              <FolderOpen aria-hidden="true" data-icon="icon-only" />
            </TooltipTrigger>
            <TooltipContent>{LL.profiles.openConfigDirectory()}</TooltipContent>
          </Tooltip>
        </div>
      </header>
      {subscription ? (
        <div className={profileStyles().subscription()}>
          <div className={profileStyles().subscriptionGrid()}>
            <div className={`${profileStyles().subscriptionCell()} ${profileStyles().source()}`}>
              <span>
                <GlobeHemisphereWest aria-hidden="true" />
                {LL.profiles.subscriptionAddress()}
              </span>
              <span className={profileStyles().url()} title={profile.source.display}>
                {profile.source.display}
              </span>
            </div>
            <ProfileDate
              label={LL.profiles.lastUpdate()}
              value={formatTimestamp(lastUpdateAt, dateFormatter, LL)}
            />
            <div className={`${profileStyles().subscriptionCell()} ${profileStyles().date()}`}>
              <span>{LL.profiles.nextUpdate()}</span>
              <div className={profileStyles().nextUpdate()}>
                <strong>
                  {profile.refresh.policy === "off"
                    ? LL.profiles.automaticRefreshOff()
                    : formatTimestamp(profile.refresh.nextRunAt, dateFormatter, LL)}
                </strong>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={LL.profiles.setUpdateInterval({ profile: fileName })}
                    className={profileStyles().intervalTrigger()}
                    disabled={!schedulingSupported || schedulePending}
                  >
                    <Alarm aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="profile-interval-menu" sideOffset={7}>
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{LL.profiles.updateInterval()}</DropdownMenuLabel>
                    </DropdownMenuGroup>
                    <DropdownMenuRadioGroup
                      onValueChange={(value) => {
                        if (isRefreshPolicy(value)) onSchedule(value);
                      }}
                      value={profile.refresh.policy}
                    >
                      {refreshPolicies.map((policy) => (
                        <DropdownMenuRadioItem key={policy} value={policy}>
                          {refreshPolicyLabel(LL, policy)}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>
          <p className={profileStyles().overwrite()}>
            <WarningCircle aria-hidden="true" />
            <span>
              {LL.profiles.subscriptionOverwriteBeforeDetach()}
              <button onClick={onDetach} type="button">
                {LL.profiles.detachSubscription()}
              </button>
              {LL.profiles.subscriptionOverwriteAfterDetach()}
            </span>
          </p>
        </div>
      ) : null}
    </article>
  );
}

function FileNameTitle({ fileName }: { fileName: string }) {
  const extensionStart = fileName.lastIndexOf(".");
  const hasExtension = extensionStart > 0;
  const name = hasExtension ? fileName.slice(0, extensionStart) : fileName;
  const extension = hasExtension ? fileName.slice(extensionStart) : "";
  return (
    <strong className={profileStyles().fileTitle()} title={fileName}>
      <span>{name}</span>
      {extension ? <span className={profileStyles().extension()}>{extension}</span> : null}
    </strong>
  );
}

function ProfileDate({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${profileStyles().subscriptionCell()} ${profileStyles().date()}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProfilePreview({ LL, preview }: { LL: TranslationFunctions; preview: ProfilePreviewDto }) {
  return (
    <div className={`${profileStyles().preview()} ${profileStyles().previewCompact()}`}>
      <FileNameTitle fileName={normalizeFileName(preview.label) ?? preview.label} />
      <dl className={profileStyles().previewList()}>
        <div>
          <dt>{LL.profiles.proxies()}</dt>
          <dd>{preview.proxyCount}</dd>
        </div>
        <div>
          <dt>{LL.profiles.groups()}</dt>
          <dd>{preview.groupCount}</dd>
        </div>
        <div>
          <dt>{LL.profiles.rules()}</dt>
          <dd>{preview.ruleCount}</dd>
        </div>
      </dl>
      {preview.warningCodes.length > 0 ? (
        <p>{LL.profiles.warnings({ count: preview.warningCodes.length })}</p>
      ) : null}
    </div>
  );
}

function profileFileName(profile: ProfileListItemDto) {
  return profile.fileName ?? normalizeFileName(profile.label) ?? "profile.yaml";
}

function normalizeFileName(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const extension = /\.(?:yaml|yml)$/i.exec(trimmed);
  return extension
    ? `${trimmed.slice(0, extension.index)}${extension[0].toLowerCase()}`
    : `${trimmed}.yaml`;
}

function formatTimestamp(
  timestamp: number | null,
  formatter: Intl.DateTimeFormat,
  LL: TranslationFunctions,
) {
  return timestamp === null ? LL.profiles.never() : formatter.format(timestamp);
}

function isRefreshPolicy(value: string): value is ProfileRefreshPolicy {
  return refreshPolicies.some((policy) => policy === value);
}

function refreshPolicyLabel(LL: TranslationFunctions, policy: ProfileRefreshPolicy) {
  switch (policy) {
    case "off":
      return LL.profiles.scheduleOff();
    case "six-hours":
      return LL.profiles.scheduleSixHours();
    case "twelve-hours":
      return LL.profiles.scheduleTwelveHours();
    case "daily":
      return LL.profiles.scheduleDaily();
    case "weekly":
      return LL.profiles.scheduleWeekly();
  }
}
