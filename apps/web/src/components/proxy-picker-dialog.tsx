import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@mish/ui";
import { cx, tv } from "@mish/ui/tv";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useI18nContext } from "../i18n/i18n-react";
import type { RouteGraph } from "../pages/routes-model";
import { PolicyGroupBrowser, usePolicyGroupBrowserSession } from "./policy-group-browser";

const pickerStyles = tv({
  slots: {
    dialog: cx(
      "policy-picker-dialog max-h-[min(680px,calc(100vh_-_32px))]",
      "w-[min(560px,calc(100vw_-_32px))] overflow-hidden overscroll-contain",
      "max-shell-mobile:max-h-[calc(100vh_-_12px)] max-shell-mobile:w-[calc(100vw_-_12px)]",
    ),
    header: "policy-picker-header gap-2",
    title: "text-body font-semibold",
    description: "mt-0.75 text-metadata leading-4.5 text-muted-foreground",
    list: "min-h-0 overflow-auto overscroll-contain",
    empty: "px-4 py-7 text-center text-metadata text-muted-foreground",
  },
});

interface PolicyPickerDialogProps {
  commandsDisabled?: boolean;
  graph: RouteGraph;
  groupId: string | null;
  onOpenChange(open: boolean): void;
  open: boolean;
}

export function PolicyPickerDialog({
  commandsDisabled = false,
  graph,
  groupId,
  onOpenChange,
  open,
}: PolicyPickerDialogProps) {
  const { LL } = useI18nContext();
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const browserSession = usePolicyGroupBrowserSession();
  const group = groupId ? graph.groupById.get(groupId) : undefined;

  useEffect(() => {
    if (open && groupId) setQuery("");
  }, [groupId, open]);

  function focusSearch() {
    const search = dialogRef.current?.querySelector<HTMLInputElement>("input[type=search]");
    search?.focus({ preventScroll: true });
    search?.select();
  }

  function handleDialogKeys(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
      event.preventDefault();
      focusSearch();
    }
  }

  if (!group) return null;

  return (
    <Dialog
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && details.reason === "escape-key" && query) {
          details.cancel();
          setQuery("");
          return;
        }
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent
        className={pickerStyles().dialog()}
        closeLabel={LL.common.close()}
        onKeyDownCapture={handleDialogKeys}
        ref={dialogRef}
      >
        <DialogHeader className={pickerStyles().header()}>
          <div>
            <DialogTitle className={pickerStyles().title({ className: "user-authored-label" })}>
              {group.label}
            </DialogTitle>
            <DialogDescription className={pickerStyles().description()}>
              {LL.proxyPicker.description()}
            </DialogDescription>
          </div>
        </DialogHeader>
        <PolicyGroupBrowser
          commandsDisabled={commandsDisabled}
          emptyClassName={pickerStyles().empty()}
          emptyLabel={LL.proxyPicker.empty()}
          graph={graph}
          group={group}
          listClassName={pickerStyles().list()}
          onQueryChange={setQuery}
          onSelectionConfirmed={() => onOpenChange(false)}
          onSortChange={(sort) => browserSession.setSort(group.id, sort)}
          query={query}
          searchLabel={LL.proxyPicker.searchAria()}
          searchPlaceholder={LL.proxyPicker.searchPlaceholder()}
          sort={browserSession.sortFor(group.id)}
        />
      </DialogContent>
    </Dialog>
  );
}

export { PolicyPickerDialog as ProxyPickerDialog };
