import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import { PencilSimple } from "@phosphor-icons/react/PencilSimple";
import { Plus } from "@phosphor-icons/react/Plus";
import { Trash } from "@phosphor-icons/react/Trash";
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Toggle,
} from "@mish/ui";
import type {
  CommonRuleType,
  ProfileListItemDto,
  ProfilePatchDto,
  ProfilePatchEditorDto,
  ProfilePatchOperationDto,
  ProfilePatchStatus,
  ProfilePatchValidationCode,
  StructuredRuleDto,
} from "@mish/contracts";
import { useEffect, useState } from "react";
import { cx, tv } from "@mish/ui/tv";
import { notificationPublication, useNotificationDelivery } from "../data/notification-delivery";
import { useProfiles } from "../data/profile-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";

type PatchKind = ProfilePatchOperationDto["kind"];
interface ProfilePatchEditorProps {
  canSave: boolean;
  fixture: boolean;
  onOpenChange(open: boolean): void;
  open: boolean;
  profile: ProfileListItemDto | null;
}

const patchKindItems: Array<{ label: string; value: PatchKind }> = [
  { label: "Rule insertion", value: "rule-insert" },
  { label: "Disable source rule", value: "rule-disable" },
  { label: "Delete source rule", value: "rule-delete" },
  { label: "Add selector group", value: "group-add" },
  { label: "Change group members", value: "group-members" },
  { label: "Order policy groups", value: "group-reorder" },
];

const commonRuleItems: Array<{ label: string; value: CommonRuleType | "match" | "rule-set" }> = [
  { label: "DOMAIN", value: "domain" },
  { label: "DOMAIN-SUFFIX", value: "domain-suffix" },
  { label: "DOMAIN-KEYWORD", value: "domain-keyword" },
  { label: "IP-CIDR", value: "ip-cidr" },
  { label: "IP-CIDR6", value: "ip-cidr6" },
  { label: "GEOIP", value: "geo-ip" },
  { label: "GEOSITE", value: "geo-site" },
  { label: "PROCESS-NAME", value: "process-name" },
  { label: "RULE-SET", value: "rule-set" },
  { label: "MATCH", value: "match" },
];

const patchStyles = tv({
  slots: {
    dialog: "w-[min(760px,calc(100vw_-_32px))] max-h-[min(760px,calc(100vh_-_32px))]",
    content: "flex flex-col gap-3 p-4",
    notice:
      "m-0 rounded-md border border-hairline bg-surface-soft px-3 py-2.5 text-muted-foreground",
    blocked: "text-error",
    toolbar: cx(
      "flex items-center justify-between gap-3 max-editor-stack:flex-col",
      "max-editor-stack:items-stretch [&>div]:flex [&>div]:items-center [&>div]:gap-2",
      "max-editor-stack:[&>div]:flex-wrap [&_span]:text-metadata [&_span]:text-muted-foreground",
    ),
    scroll: cx(
      "min-h-40 max-h-[min(430px,50vh)] overflow-auto rounded-md border border-hairline bg-canvas",
      "[&>.ui-empty]:min-h-39.5 [&>.ui-empty]:border-0",
    ),
    loading: "inline-flex items-center gap-2",
    row: cx(
      "flex min-w-0 items-center justify-between gap-3 p-3 max-editor-stack:flex-col",
      "max-editor-stack:items-stretch [&+&]:border-t [&+&]:border-hairline-soft",
    ),
    summary: cx(
      "min-w-0 flex-1 [&>div]:flex [&>div]:items-center [&>div]:gap-1.5 [&_p]:my-0.5 [&_p]:mt-1",
      "[&_p]:overflow-hidden [&_p]:text-ellipsis [&_p]:whitespace-nowrap [&_small]:text-metadata",
      "[&_small]:text-muted-foreground",
    ),
    rowActions: "flex items-center gap-1.5 max-editor-stack:flex-wrap",
    dirty: "text-metadata text-muted-foreground",
    formDialog:
      "w-[min(560px,calc(100vw_-_32px))] max-h-[min(720px,calc(100vh_-_32px))] overflow-auto",
    orderList: cx(
      "flex flex-col gap-px overflow-hidden rounded-md border border-hairline bg-hairline-soft",
      "[&>div]:flex [&>div]:min-w-0 [&>div]:min-h-10 [&>div]:items-center [&>div]:gap-1",
      "[&>div]:bg-canvas [&>div]:py-1 [&>div]:pr-1.5 [&>div]:pl-2.5 [&_span]:min-w-0",
      "[&_span]:flex-1 [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:whitespace-nowrap",
    ),
    members: "flex max-h-45 flex-wrap gap-1.5 overflow-auto p-0.5",
  },
});

export function ProfilePatchEditor({
  canSave,
  fixture,
  onOpenChange,
  open,
  profile,
}: ProfilePatchEditorProps) {
  const { LL } = useI18nContext();
  const { publish } = useNotificationDelivery();
  const profiles = useProfiles();
  const { isPending, loadPatches, replacePatches } = profiles;
  const [editor, setEditor] = useState<ProfilePatchEditorDto | null>(null);
  const [draft, setDraft] = useState<ProfilePatchDto[]>([]);
  const [baseline, setBaseline] = useState("[]");
  const [loading, setLoading] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const dirty = JSON.stringify(draft) !== baseline;
  const profileId = profile?.id;
  const sourceRevision = profile?.runtimeProvenance.sourceRevision;
  const artifactFingerprint = profile?.runtimeProvenance.artifactFingerprint;

  useEffect(() => {
    if (!open || !profileId || !sourceRevision || !artifactFingerprint) return;
    let cancelled = false;
    setLoading(true);
    const authority = {
      artifactFingerprint,
      profileId,
      sourceRevision,
    };
    void loadPatches(authority).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        publish(
          notificationPublication("profile.patch-load-failed", {
            dedupeKey: "profile.patch-load-failed",
            severity: "error",
          }),
        );
        return;
      }
      const patches = result.editor.patches.map(({ enabled, id, operation }) => ({
        enabled,
        id,
        operation,
      }));
      setEditor(result.editor);
      setDraft(patches);
      setBaseline(JSON.stringify(patches));
    });
    return () => {
      cancelled = true;
    };
  }, [LL, artifactFingerprint, loadPatches, open, profileId, sourceRevision]);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);

  function requestClose() {
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    closeImmediately();
  }

  function closeImmediately() {
    setDiscardOpen(false);
    setFormOpen(false);
    setEditingIndex(null);
    setEditor(null);
    setDraft([]);
    setBaseline("[]");
    onOpenChange(false);
  }

  async function save() {
    if (!editor || !canSave) return;
    const result = await replacePatches(editor.authority, draft);
    if (!result.ok) {
      publish(
        notificationPublication("profile.patch-save-failed", {
          dedupeKey: "profile.patch-save-failed",
          severity: "error",
        }),
      );
      return;
    }
    const patches = result.editor.patches.map(({ enabled, id, operation }) => ({
      enabled,
      id,
      operation,
    }));
    setEditor(result.editor);
    setDraft(patches);
    setBaseline(JSON.stringify(patches));
    publish(
      notificationPublication("profile.patch-saved", {
        dedupeKey: "profile.patch-saved",
        severity: "success",
      }),
    );
  }

  function openNewPatch() {
    setEditingIndex(null);
    setFormOpen(true);
  }

  function editPatch(index: number) {
    setEditingIndex(index);
    setFormOpen(true);
  }

  function commitOperation(operation: ProfilePatchOperationDto) {
    if (editingIndex === null) {
      setDraft((current) => [...current, { enabled: true, id: crypto.randomUUID(), operation }]);
    } else {
      setDraft((current) =>
        current.map((patch, index) => (index === editingIndex ? { ...patch, operation } : patch)),
      );
    }
    setFormOpen(false);
    setEditingIndex(null);
  }

  return (
    <>
      <Dialog
        onOpenChange={(nextOpen) => {
          if (!nextOpen) requestClose();
        }}
        open={open}
      >
        <DialogContent className={patchStyles().dialog()} closeLabel={LL.common.close()}>
          <DialogHeader>
            <div>
              <DialogTitle className="dialog-title">
                {LL.profiles.patchEditorTitle({ profile: profile?.label ?? "" })}
              </DialogTitle>
              <DialogDescription className="dialog-description">
                {LL.profiles.patchEditorDescription()}
              </DialogDescription>
            </div>
          </DialogHeader>

          <div className={patchStyles().content()}>
            {fixture ? (
              <p className={patchStyles().notice()}>{LL.profiles.patchFixture()}</p>
            ) : null}
            {editor?.activationBlocked ? (
              <p
                className={patchStyles().notice({ className: patchStyles().blocked() })}
                role="alert"
              >
                {LL.profiles.patchActivationBlocked()}
              </p>
            ) : null}

            <div className={patchStyles().toolbar()}>
              <div>
                <strong>{LL.profiles.patches()}</strong>
                <span>{LL.profiles.patchCount({ count: draft.length })}</span>
              </div>
              <div>
                <Button
                  disabled={!editor || loading}
                  onClick={openNewPatch}
                  size="sm"
                  variant="outline"
                >
                  <Plus data-icon="inline-start" />
                  {LL.profiles.patchAdd()}
                </Button>
                <Button
                  disabled={draft.length === 0}
                  onClick={() => setDraft([])}
                  size="sm"
                  variant="ghost"
                >
                  {LL.profiles.patchReset()}
                </Button>
              </div>
            </div>

            <div className={patchStyles().scroll()} aria-live="polite">
              {loading ? (
                <p className={patchStyles().loading()}>
                  <Spinner data-icon="inline-start" />
                  {LL.profiles.loading()}
                </p>
              ) : null}
              {!loading && draft.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>{LL.profiles.patchEmptyTitle()}</EmptyTitle>
                    <EmptyDescription>{LL.profiles.patchEmptyDescription()}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : null}
              {draft.map((patch, index) => {
                const candidate = editor?.patches.find((item) => item.id === patch.id);
                const saved =
                  candidate &&
                  JSON.stringify({
                    enabled: candidate.enabled,
                    id: candidate.id,
                    operation: candidate.operation,
                  }) === JSON.stringify(patch)
                    ? candidate
                    : undefined;
                const status = saved?.status ?? (patch.enabled ? "enabled" : "disabled");
                return (
                  <article className={patchStyles().row()} key={patch.id}>
                    <div className={patchStyles().summary()}>
                      <div>
                        <strong>{patchKindLabel(LL, patch.operation.kind)}</strong>
                        <Badge variant={patchBadge(status)}>{patchStatusLabel(LL, status)}</Badge>
                      </div>
                      <p className="user-authored-label" title={saved?.target}>
                        {saved?.target ?? operationTarget(LL, editor, patch.operation)}
                      </p>
                      <small>
                        {saved
                          ? validationLabel(LL, saved.validationCode)
                          : LL.profiles.patchUnsavedValidation()}
                      </small>
                    </div>
                    <div className={patchStyles().rowActions()}>
                      <Button
                        aria-label={LL.profiles.patchMoveUp()}
                        disabled={index === 0}
                        onClick={() => setDraft((current) => move(current, index, index - 1))}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        aria-label={LL.profiles.patchMoveDown()}
                        disabled={index === draft.length - 1}
                        onClick={() => setDraft((current) => move(current, index, index + 1))}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <Button
                        onClick={() =>
                          setDraft((current) =>
                            current.map((candidate, candidateIndex) =>
                              candidateIndex === index
                                ? { ...candidate, enabled: !candidate.enabled }
                                : candidate,
                            ),
                          )
                        }
                        size="sm"
                        variant="ghost"
                      >
                        {patch.enabled ? LL.profiles.patchDisable() : LL.profiles.patchEnable()}
                      </Button>
                      <Button
                        aria-label={LL.profiles.patchEdit()}
                        onClick={() => editPatch(index)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <PencilSimple aria-hidden="true" />
                      </Button>
                      <Button
                        aria-label={LL.common.delete()}
                        onClick={() =>
                          setDraft((current) =>
                            current.filter((_, candidateIndex) => candidateIndex !== index),
                          )
                        }
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Trash aria-hidden="true" />
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <DialogFooter>
            <span className={patchStyles().dirty()} aria-live="polite">
              {dirty ? LL.profiles.patchUnsavedChanges() : LL.profiles.patchAllSaved()}
            </span>
            <Button onClick={requestClose} variant="outline">
              {LL.common.close()}
            </Button>
            <Button
              disabled={!dirty || !canSave || isPending("patch-save", profile?.id)}
              loading={isPending("patch-save", profile?.id)}
              loadingText={LL.profiles.patchSave()}
              onClick={save}
            >
              {LL.profiles.patchSave()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PatchFormDialog
        editor={editor}
        initial={editingIndex === null ? null : (draft[editingIndex]?.operation ?? null)}
        onCommit={commitOperation}
        onOpenChange={setFormOpen}
        open={formOpen}
      />

      <AlertDialog onOpenChange={setDiscardOpen} open={discardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{LL.profiles.patchDiscardTitle()}</AlertDialogTitle>
            <AlertDialogDescription>{LL.profiles.patchDiscardDescription()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{LL.common.cancel()}</AlertDialogCancel>
            <AlertDialogAction onClick={closeImmediately} variant="destructive">
              {LL.profiles.patchDiscard()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

interface PatchFormDialogProps {
  editor: ProfilePatchEditorDto | null;
  initial: ProfilePatchOperationDto | null;
  onCommit(operation: ProfilePatchOperationDto): void;
  onOpenChange(open: boolean): void;
  open: boolean;
}

function PatchFormDialog({ editor, initial, onCommit, onOpenChange, open }: PatchFormDialogProps) {
  const { LL } = useI18nContext();
  const [kind, setKind] = useState<PatchKind>("rule-insert");
  const [operation, setOperation] = useState<ProfilePatchOperationDto | null>(null);

  useEffect(() => {
    if (!open || !editor) return;
    const next = initial ?? defaultOperation(kind, editor);
    setKind(next.kind);
    setOperation(next);
  }, [editor, initial, open]);

  if (!editor || !operation) return null;
  const valid = operationIsComplete(operation);
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className={patchStyles().formDialog()} closeLabel={LL.common.close()}>
        <DialogHeader>
          <div>
            <DialogTitle className="dialog-title">
              {initial ? LL.profiles.patchEditTitle() : LL.profiles.patchAddTitle()}
            </DialogTitle>
            <DialogDescription className="dialog-description">
              {LL.profiles.patchFormDescription()}
            </DialogDescription>
          </div>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel>{LL.profiles.patchType()}</FieldLabel>
            <Select
              disabled={initial !== null}
              items={patchKindItems.map((item) => ({
                ...item,
                label: patchKindLabel(LL, item.value),
              }))}
              onValueChange={(value) => {
                if (!value) return;
                setKind(value);
                setOperation(defaultOperation(value, editor));
              }}
              value={kind}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {patchKindItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {patchKindLabel(LL, item.value)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          <OperationFields editor={editor} operation={operation} setOperation={setOperation} />
        </FieldGroup>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            {LL.common.cancel()}
          </Button>
          <Button disabled={!valid} onClick={() => onCommit(operation)}>
            {initial ? LL.profiles.patchUpdate() : LL.profiles.patchAdd()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OperationFields({
  editor,
  operation,
  setOperation,
}: {
  editor: ProfilePatchEditorDto;
  operation: ProfilePatchOperationDto;
  setOperation(operation: ProfilePatchOperationDto): void;
}) {
  const { LL } = useI18nContext();
  if (operation.kind === "rule-insert") {
    const rule = operation.rule;
    const ruleKind = rule.kind === "standard" ? rule.ruleType : rule.kind;
    return (
      <>
        <SelectField
          label={LL.profiles.patchPosition()}
          items={[
            { label: LL.profiles.patchPrefix(), value: "prefix" },
            { label: LL.profiles.patchSuffix(), value: "suffix" },
          ]}
          onValue={(value) =>
            setOperation({ ...operation, position: value as "prefix" | "suffix" })
          }
          value={operation.position}
        />
        <SelectField
          label={LL.profiles.patchRuleType()}
          items={commonRuleItems}
          onValue={(value) =>
            setOperation({
              ...operation,
              rule: changeRuleKind(value as typeof ruleKind, rule, editor),
            })
          }
          value={ruleKind}
        />
        {rule.kind === "standard" ? (
          <Field>
            <FieldLabel htmlFor="patch-rule-value">{LL.profiles.patchRuleValue()}</FieldLabel>
            <Input
              id="patch-rule-value"
              onValueChange={(value) => setOperation({ ...operation, rule: { ...rule, value } })}
              spellCheck={false}
              value={rule.value}
            />
            <FieldDescription>{LL.profiles.patchRuleValueDescription()}</FieldDescription>
          </Field>
        ) : null}
        {rule.kind === "rule-set" ? (
          <SelectField
            label={LL.profiles.patchRuleProvider()}
            items={editor.catalog.ruleProviders.map(({ id, label }) => ({ label, value: id }))}
            onValue={(value) =>
              setOperation({ ...operation, rule: { ...rule, providerId: value } })
            }
            value={rule.providerId}
          />
        ) : null}
        <SelectField
          label={LL.profiles.patchRuleTarget()}
          items={editor.catalog.outbounds.map(({ id, label }) => ({ label, value: id }))}
          onValue={(value) =>
            setOperation({ ...operation, rule: { ...rule, targetId: value } as StructuredRuleDto })
          }
          value={rule.targetId}
        />
      </>
    );
  }
  if (operation.kind === "rule-disable" || operation.kind === "rule-delete") {
    return (
      <SelectField
        label={LL.profiles.patchSourceRule()}
        items={editor.catalog.rules.map((rule) => ({
          label: LL.profiles.patchRuleSummary({
            position: rule.position + 1,
            ruleType: rule.ruleType,
            target: rule.target,
          }),
          value: rule.id,
        }))}
        onValue={(value) => setOperation({ ...operation, ruleId: value })}
        value={operation.ruleId}
      />
    );
  }
  if (operation.kind === "group-add") {
    return (
      <>
        <Field>
          <FieldLabel htmlFor="patch-group-label">{LL.profiles.patchGroupLabel()}</FieldLabel>
          <Input
            id="patch-group-label"
            onValueChange={(value) => setOperation({ ...operation, label: value })}
            value={operation.label}
          />
        </Field>
        <MemberPicker
          editor={editor}
          memberIds={operation.memberIds}
          onChange={(memberIds) => setOperation({ ...operation, memberIds })}
        />
      </>
    );
  }
  if (operation.kind === "group-members") {
    return (
      <>
        <SelectField
          label={LL.profiles.patchPolicyGroup()}
          items={editor.catalog.groups
            .filter((group) => group.supported)
            .map((group) => ({ label: group.label, value: group.id }))}
          onValue={(value) => setOperation({ ...operation, groupId: value })}
          value={operation.groupId}
        />
        <MemberPicker
          editor={editor}
          memberIds={operation.memberIds}
          onChange={(memberIds) => setOperation({ ...operation, memberIds })}
        />
      </>
    );
  }
  return (
    <Field>
      <FieldLabel>{LL.profiles.patchGroupOrder()}</FieldLabel>
      <div className={patchStyles().orderList()}>
        {operation.groupIds.map((id, index) => {
          const group = editor.catalog.groups.find((candidate) => candidate.id === id);
          return (
            <div key={id}>
              <span className="user-authored-label">{group?.label ?? id}</span>
              <Button
                aria-label={LL.profiles.patchMoveUp()}
                disabled={index === 0}
                onClick={() =>
                  setOperation({
                    ...operation,
                    groupIds: move(operation.groupIds, index, index - 1),
                  })
                }
                size="icon-sm"
                variant="ghost"
              >
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button
                aria-label={LL.profiles.patchMoveDown()}
                disabled={index === operation.groupIds.length - 1}
                onClick={() =>
                  setOperation({
                    ...operation,
                    groupIds: move(operation.groupIds, index, index + 1),
                  })
                }
                size="icon-sm"
                variant="ghost"
              >
                <ArrowDown aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </div>
    </Field>
  );
}

function SelectField({
  label,
  items,
  onValue,
  value,
}: {
  label: string;
  items: Array<{ label: string; value: string }>;
  onValue(value: string): void;
  value: string;
}) {
  return (
    <Field data-invalid={!value || undefined}>
      <FieldLabel>{label}</FieldLabel>
      <Select items={items} onValueChange={(next) => next && onValue(next)} value={value || null}>
        <SelectTrigger aria-invalid={!value}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <span className="user-authored-label">{item.label}</span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  );
}

function MemberPicker({
  editor,
  memberIds,
  onChange,
}: {
  editor: ProfilePatchEditorDto;
  memberIds: string[];
  onChange(ids: string[]): void;
}) {
  const { LL } = useI18nContext();
  return (
    <Field data-invalid={memberIds.length === 0 || undefined}>
      <FieldLabel>{LL.profiles.patchMembers()}</FieldLabel>
      <div className={patchStyles().members()}>
        {editor.catalog.outbounds.map((entity) => {
          const pressed = memberIds.includes(entity.id);
          return (
            <Toggle
              aria-label={entity.label}
              key={entity.id}
              onPressedChange={(next) =>
                onChange(
                  next ? [...memberIds, entity.id] : memberIds.filter((id) => id !== entity.id),
                )
              }
              pressed={pressed}
              variant="outline"
            >
              <span className="user-authored-label">{entity.label}</span>
            </Toggle>
          );
        })}
      </div>
      <FieldDescription>{LL.profiles.patchMembersDescription()}</FieldDescription>
    </Field>
  );
}

function defaultOperation(
  kind: PatchKind,
  editor: ProfilePatchEditorDto,
): ProfilePatchOperationDto {
  const targetId = editor.catalog.outbounds[0]?.id ?? "";
  if (kind === "rule-insert")
    return {
      kind,
      position: "prefix",
      rule: { kind: "standard", noResolve: false, ruleType: "domain-suffix", targetId, value: "" },
    };
  if (kind === "rule-disable" || kind === "rule-delete")
    return { kind, ruleId: editor.catalog.rules[0]?.id ?? "" };
  if (kind === "group-add") return { kind, label: "", memberIds: targetId ? [targetId] : [] };
  if (kind === "group-members") {
    const group = editor.catalog.groups.find((candidate) => candidate.supported);
    return { kind, groupId: group?.id ?? "", memberIds: group?.memberIds ?? [] };
  }
  return { kind, groupIds: editor.catalog.groups.map((group) => group.id) };
}

function changeRuleKind(
  kind: CommonRuleType | "match" | "rule-set",
  current: StructuredRuleDto,
  editor: ProfilePatchEditorDto,
): StructuredRuleDto {
  if (kind === "match") return { kind, targetId: current.targetId };
  if (kind === "rule-set")
    return {
      kind,
      noResolve: false,
      providerId: editor.catalog.ruleProviders[0]?.id ?? "",
      targetId: current.targetId,
    };
  return {
    kind: "standard",
    noResolve: false,
    ruleType: kind,
    targetId: current.targetId,
    value: current.kind === "standard" ? current.value : "",
  };
}

function operationIsComplete(operation: ProfilePatchOperationDto) {
  if (operation.kind === "rule-insert") {
    if (!operation.rule.targetId) return false;
    if (operation.rule.kind === "standard") return operation.rule.value.length > 0;
    if (operation.rule.kind === "rule-set") return operation.rule.providerId.length > 0;
    return true;
  }
  if (operation.kind === "rule-disable" || operation.kind === "rule-delete")
    return operation.ruleId.length > 0;
  if (operation.kind === "group-add")
    return operation.label.length > 0 && operation.memberIds.length > 0;
  if (operation.kind === "group-members")
    return operation.groupId.length > 0 && operation.memberIds.length > 0;
  return operation.groupIds.length > 0;
}

function operationTarget(
  LL: TranslationFunctions,
  editor: ProfilePatchEditorDto | null,
  operation: ProfilePatchOperationDto,
) {
  if (operation.kind === "group-add") return operation.label;
  if (operation.kind === "group-members")
    return editor?.catalog.groups.find((group) => group.id === operation.groupId)?.label ?? "";
  if (operation.kind === "group-reorder") return LL.profiles.patchPolicyGroupsTarget();
  return operation.kind === "rule-insert"
    ? LL.profiles.patchRulesTarget({ position: operation.position })
    : LL.profiles.patchSourceRule();
}

function patchKindLabel(LL: TranslationFunctions, kind: PatchKind) {
  const labels = {
    "rule-insert": LL.profiles.patchRuleInsert(),
    "rule-disable": LL.profiles.patchRuleDisable(),
    "rule-delete": LL.profiles.patchRuleDelete(),
    "group-add": LL.profiles.patchGroupAdd(),
    "group-members": LL.profiles.patchGroupMembers(),
    "group-reorder": LL.profiles.patchGroupReorder(),
  };
  return labels[kind];
}

function patchStatusLabel(LL: TranslationFunctions, status: ProfilePatchStatus) {
  return status === "enabled"
    ? LL.profiles.patchEnabled()
    : status === "disabled"
      ? LL.profiles.patchDisabled()
      : status === "stale"
        ? LL.profiles.patchStale()
        : LL.profiles.patchInvalid();
}

function patchBadge(status: ProfilePatchStatus): "default" | "warning" | "destructive" | "outline" {
  if (status === "stale") return "warning";
  if (status === "invalid") return "destructive";
  return status === "enabled" ? "default" : "outline";
}

function validationLabel(LL: TranslationFunctions, code: ProfilePatchValidationCode) {
  if (code === "valid") return LL.profiles.patchValidationValid();
  if (code === "disabled") return LL.profiles.patchValidationDisabled();
  if (code === "revision-mismatch") return LL.profiles.patchValidationRevision();
  if (code === "target-missing") return LL.profiles.patchValidationTarget();
  if (code === "duplicate-target") return LL.profiles.patchValidationDuplicateTarget();
  if (code === "duplicate-label") return LL.profiles.patchValidationDuplicateLabel();
  if (code === "unsafe-reference") return LL.profiles.patchValidationReference();
  if (code === "invalid-order") return LL.profiles.patchValidationOrder();
  if (code === "semantic-conflict") return LL.profiles.patchValidationConflict();
  return LL.profiles.patchValidationValue();
}

function move<T>(items: T[], from: number, to: number) {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
