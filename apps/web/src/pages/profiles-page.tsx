import { Alarm } from "@phosphor-icons/react/Alarm";
import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { FilePlus } from "@phosphor-icons/react/FilePlus";
import { FolderOpen } from "@phosphor-icons/react/FolderOpen";
import { GlobeHemisphereWest } from "@phosphor-icons/react/GlobeHemisphereWest";
import { WarningCircle } from "@phosphor-icons/react/WarningCircle";
import { useMemo, useState, type FormEvent } from "react";
import { cx, tv } from "@mish/ui/tv";
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
import { useNotificationDelivery } from "../data/notification-delivery";
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
    page: cx(
      "mx-auto w-full max-w-page-medium p-8 max-page-compact:p-6 max-shell-mobile:px-4",
      "max-shell-mobile:pt-4.5 max-shell-mobile:pb-6",
    ),
    header: cx(
      "flex items-start justify-between gap-6 max-page-compact:flex-col",
      "max-page-compact:items-stretch [&_p]:mt-1.75 [&_p]:max-w-165 [&_p]:leading-5.25",
      "[&_p]:text-muted-foreground",
    ),
    importActions: cx(
      "flex shrink-0 items-center gap-2 max-page-compact:self-start max-shell-mobile:w-full",
      "max-shell-mobile:flex-wrap max-shell-mobile:[&>.ui-button]:min-w-0",
      "max-shell-mobile:[&>.ui-button]:grow max-shell-mobile:[&>.ui-button]:shrink",
      "max-shell-mobile:[&>.ui-button]:basis-45",
    ),
    loading: "mt-2.5 text-caption leading-4.5 text-muted-foreground",
    empty: "mt-5",
    cardList: "mt-6 grid gap-3.5",
    card: cx(
      "overflow-hidden rounded-lg border border-hairline bg-canvas",
      "data-[source=subscription]:[&>header]:border-b",
      "data-[source=subscription]:[&>header]:border-hairline-soft",
    ),
    cardHeader:
      "flex min-h-17 items-center justify-between gap-4 px-4 py-3 max-content-narrow:items-start",
    cardTitle: "flex min-w-0 flex-1 items-center gap-2",
    cardActions:
      "flex shrink-0 items-center gap-2 max-content-narrow:flex-wrap max-content-narrow:justify-end",
    fileTitle: "min-w-0 overflow-hidden text-ink text-ellipsis whitespace-nowrap font-semibold",
    extension: "text-muted-foreground font-medium",
    subscription: "bg-profile-subscription-surface px-4 pt-3.5 pb-3.25",
    subscriptionGrid: cx(
      "profile-subscription-grid grid grid-cols-[minmax(260px,1fr)_126px_144px] items-end gap-5",
      "max-page-compact:grid-cols-[minmax(0,1fr)_112px_132px] max-page-compact:gap-3.5",
      "max-content-narrow:grid-cols-2",
    ),
    subscriptionCell: cx(
      "grid min-w-0 gap-1 [&>span]:text-caption [&>span]:leading-4 [&>span]:text-muted-foreground",
      "[&>dt]:text-caption [&>dt]:leading-4 [&>dt]:text-muted-foreground",
    ),
    source: cx(
      "grid min-w-0 gap-1 max-content-narrow:col-span-2 [&>span:first-child]:flex",
      "[&>span:first-child]:items-center [&>span:first-child]:gap-1.5 [&_svg]:size-3.75",
    ),
    url: cx(
      "profile-subscription-url block min-h-6.5 overflow-hidden text-metadata leading-6.5",
      "font-medium text-muted-foreground",
      "text-ellipsis whitespace-nowrap",
    ),
    date: cx(
      "grid gap-1 text-metadata text-muted-foreground [&>strong]:flex [&>strong]:min-h-6.5",
      "[&>strong]:items-center [&>strong]:truncate [&>strong]:text-metadata [&>strong]:leading-4.5",
      "[&>strong]:font-medium [&>strong]:text-ink [&>strong]:tabular-nums",
    ),
    nextUpdate: "inline-flex w-max max-w-full items-center gap-1",
    intervalTrigger: cx(
      "profile-interval-trigger grid size-7 place-items-center rounded-sm border-0 bg-transparent",
      "text-muted-foreground hover:bg-accent hover:text-ink data-popup-open:bg-accent",
      "data-popup-open:text-ink focus-visible:bg-accent focus-visible:text-ink disabled:opacity-45",
      "[&_svg]:size-3.75",
    ),
    intervalMenu: "w-47.5",
    overwrite: cx(
      "mt-2.25 flex items-center gap-1.75 border-t border-hairline-soft pt-2.25 text-caption",
      "leading-4.5 text-warning [&_svg]:size-3.75 [&_svg]:shrink-0 [&_span]:text-muted-foreground",
      "[&_button]:ml-0.75 [&_button]:inline [&_button]:border-0 [&_button]:bg-transparent",
      "[&_button]:p-0 [&_button]:text-ink [&_button]:underline [&_button]:underline-offset-0.75",
      "hover:[&_button]:text-brand focus-visible:[&_button]:text-brand",
    ),
    importDialog: "w-[min(720px,calc(100vw_-_32px))]",
    importForm: "p-4",
    preview: "grid gap-3.5 p-4",
    previewList: cx(
      "grid grid-cols-3 overflow-hidden rounded-md border border-hairline [&>div]:grid",
      "[&>div]:gap-1 [&>div]:p-3 [&>div+div]:border-l [&>div+div]:border-hairline-soft",
      "[&_dt]:text-caption [&_dt]:text-muted-foreground [&_dd]:text-ink [&_dd]:font-semibold",
    ),
    previewMessage: "text-caption text-muted-foreground",
  },
});

export function ProfilesPage() {
  const { LL, locale } = useI18nContext();
  const profiles = useProfiles();
  const { publish } = useNotificationDelivery();
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
      publish({
        id: "profiles-create-failed",
        level: "error",
        message: LL.profiles.createFailed(),
      });
      return;
    }
    publish({ id: "profiles-created", level: "success", message: LL.profiles.createdToast() });
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
      publish({
        id: "profiles-import-failed",
        level: "error",
        message: LL.profiles.importFailed(),
      });
      return;
    }
    setUrl("");
    setPreview(result.preview);
  }

  async function savePreview() {
    if (!preview) return;
    const result = await profiles.savePreview(preview.previewId);
    if (!result.ok) {
      publish({ id: "profiles-save-failed", level: "error", message: LL.profiles.saveFailed() });
      return;
    }
    publish({ id: "profiles-saved", level: "success", message: LL.profiles.savedToast() });
    closeImport();
  }

  async function refreshProfile(profile: ProfileListItemDto) {
    const result = await profiles.refreshProfile(profile.id);
    if (!result.ok) {
      publish({
        id: "profiles-refresh-failed",
        level: "error",
        message: LL.profiles.refreshFailed(),
      });
      return;
    }
    publish({
      id: "profiles-subscription-updated",
      level: "success",
      message: LL.profiles.subscriptionUpdated(),
    });
  }

  async function setRefreshPolicy(profileId: string, policy: ProfileRefreshPolicy) {
    const result = await profiles.setRefreshPolicy(profileId, policy);
    if (!result.ok)
      publish({
        id: "profiles-schedule-failed",
        level: "error",
        message: LL.profiles.scheduleFailed(),
      });
  }

  async function detachSubscription(profile: ProfileListItemDto) {
    const result = await profiles.detachSubscription(profile.id);
    if (!result.ok) {
      publish({
        id: "profiles-detach-subscription-failed",
        level: "error",
        message: LL.profiles.detachSubscriptionFailed(),
      });
      return;
    }
    publish({
      id: "profiles-subscription-detached",
      level: "success",
      message: LL.profiles.subscriptionDetached(),
    });
  }

  async function openDirectory() {
    const result = await profiles.openProfileDirectory();
    if (!result.ok)
      publish({
        id: "profiles-file-action-failed",
        level: "error",
        message: LL.profiles.fileActionFailed(),
      });
  }

  return (
    <div className={profileStyles().page()}>
      <header className={profileStyles().header()}>
        <div>
          <h1>{LL.profiles.title()}</h1>
          <p>{LL.profiles.description()}</p>
        </div>
        <div className={profileStyles().importActions()}>
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

      {profiles.isLoading ? (
        <p className={profileStyles().loading()}>{LL.profiles.loading()}</p>
      ) : null}

      {snapshot && snapshot.profiles.length === 0 ? (
        <Empty className={profileStyles().empty()}>
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
        <DialogContent className={profileStyles().importDialog()} closeLabel={LL.common.close()}>
          <DialogHeader>
            <div>
              <DialogTitle className="dialog-title">{LL.profiles.createTitle()}</DialogTitle>
              <DialogDescription className="dialog-description">
                {LL.profiles.createDescription()}
              </DialogDescription>
            </div>
          </DialogHeader>
          <form
            className={profileStyles().importForm()}
            id="profile-create-form"
            onSubmit={createProfile}
          >
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
        <DialogContent className={profileStyles().importDialog()} closeLabel={LL.common.close()}>
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
              className={profileStyles().importForm()}
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
            <div
              className={profileStyles().subscriptionCell({
                className: profileStyles().source(),
              })}
            >
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
            <div
              className={profileStyles().subscriptionCell({
                className: profileStyles().date(),
              })}
            >
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
                  <DropdownMenuContent
                    align="end"
                    className={profileStyles().intervalMenu()}
                    sideOffset={7}
                  >
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
    <div className={profileStyles().subscriptionCell({ className: profileStyles().date() })}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ProfilePreview({ LL, preview }: { LL: TranslationFunctions; preview: ProfilePreviewDto }) {
  return (
    <div className={profileStyles().preview()}>
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
        <p className={profileStyles().previewMessage()}>
          {LL.profiles.warnings({ count: preview.warningCodes.length })}
        </p>
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
