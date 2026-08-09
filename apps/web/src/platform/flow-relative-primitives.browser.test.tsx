import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  SearchInput,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mish/ui";
import { createRoot, type Root } from "react-dom/client";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "../styles.css";

const tolerance = 0.5;

function inset(start: number, end: number) {
  return { end: Math.round(end * 100) / 100, start: Math.round(start * 100) / 100 };
}

function inlineInsets(container: Element, child: Element) {
  const containerRect = container.getBoundingClientRect();
  const childRect = child.getBoundingClientRect();
  const physical = inset(
    childRect.left - containerRect.left,
    containerRect.right - childRect.right,
  );
  return document.documentElement.dir === "rtl"
    ? { end: physical.start, start: physical.end }
    : physical;
}

function expectClose(actual: number, expected: number, context: string) {
  expect(Math.abs(actual - expected), context).toBeLessThanOrEqual(tolerance);
}

function Harness({ locale, mobile }: { locale: "en" | "zh-CN"; mobile: boolean }) {
  const copy =
    locale === "zh-CN"
      ? { dialog: "共享几何", menu: "配置", option: "自动", search: "搜索节点", table: "名称" }
      : {
          dialog: "Shared geometry",
          menu: "Configure",
          option: "Automatic",
          search: "Search nodes",
          table: "Name",
        };

  return (
    <main className="grid gap-6 p-6">
      <SearchInput
        aria-label={copy.search}
        icon={<MagnifyingGlass />}
        rootClassName="w-70 max-w-full"
        touchTarget={mobile ? "adaptive" : "default"}
        type="search"
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{copy.table}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Mish</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <DropdownMenu open>
        <DropdownMenuTrigger>{copy.menu}</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="auto">
            <DropdownMenuRadioItem value="auto">{copy.option}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{copy.dialog}</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </main>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await page.viewport(800, 600);
  document.documentElement.dataset.runtime = "browser";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  root.unmount();
  container.remove();
  document.documentElement.dir = "";
  document.documentElement.lang = "";
  delete document.documentElement.dataset.runtime;
  delete document.documentElement.dataset.theme;
});

for (const viewport of [
  { height: 600, name: "desktop", width: 800 },
  { height: 640, name: "mobile", width: 360 },
] as const) {
  for (const theme of ["light", "dark"] as const) {
    for (const locale of ["en", "zh-CN"] as const) {
      test(`preserves ${locale} LTR geometry in ${theme} ${viewport.name}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dir = "ltr";
        document.documentElement.lang = locale;
        document.documentElement.dataset.theme = theme;
        root.render(<Harness locale={locale} mobile={viewport.name === "mobile"} />);

        const dialog = page.getByRole("dialog");
        const close = page.getByRole("button", { name: "Close" });
        await vi.waitFor(() => expect(dialog.element()).toBeInstanceOf(HTMLElement));

        const dialogElement = dialog.element() as HTMLElement;
        const closeElement = close.element() as HTMLElement;
        const header = dialogElement.querySelector(".dialog-header")!;
        const title = dialogElement.querySelector(".dialog-title")!;
        const searchElement = document.querySelector(".ui-search-control input")!;
        const searchControl = searchElement.closest(".ui-search-control")!;
        const searchIcon = searchControl.querySelector("[data-slot=search-control-icon]")!;

        expectClose(
          inlineInsets(dialogElement, closeElement).end,
          11,
          "dialog close trailing inset",
        );
        expect(getComputedStyle(header).paddingLeft).toBe("16px");
        expect(getComputedStyle(header).paddingRight).toBe("44px");
        expect(inlineInsets(header, title).start).toBe(16);
        expect(getComputedStyle(document.querySelector(".ui-table-head")!).textAlign).toBe("start");
        expect(getComputedStyle(searchElement).paddingLeft).toBe(
          viewport.name === "mobile" ? "38px" : "34px",
        );
        expectClose(
          inlineInsets(searchControl, searchIcon).start,
          viewport.name === "mobile" ? 12 : 11,
          "search icon leading inset",
        );
        expect(searchElement.getBoundingClientRect().height).toBe(
          viewport.name === "mobile" ? 44 : 38,
        );

        const radioElement = document.querySelector("[role=menuitemradio]")!;
        expect(radioElement).toBeInstanceOf(HTMLElement);
        const indicator = radioElement.querySelector(".menu-radio-indicator")!;
        expect(getComputedStyle(radioElement).paddingRight).toBe("30px");
        expectClose(inlineInsets(radioElement, indicator).end, 8, "menu indicator trailing inset");
      });
    }
  }
}

for (const viewport of [
  { height: 600, name: "desktop", width: 800 },
  { height: 640, name: "mobile", width: 360 },
] as const) {
  test(`a test-only direction override mirrors ${viewport.name} geometry without hit or focus regressions`, async () => {
    await page.viewport(viewport.width, viewport.height);
    document.documentElement.dir = "rtl";
    document.documentElement.lang = "en";
    document.documentElement.dataset.theme = "light";
    root.render(<Harness locale="en" mobile={viewport.name === "mobile"} />);

    const dialog = page.getByRole("dialog");
    const close = page.getByRole("button", { name: "Close" });
    await vi.waitFor(() => expect(dialog.element()).toBeInstanceOf(HTMLElement));

    const dialogElement = dialog.element() as HTMLElement;
    const closeElement = close.element() as HTMLElement;
    const header = dialogElement.querySelector(".dialog-header")!;
    const title = dialogElement.querySelector(".dialog-title")!;
    const searchElement = document.querySelector(".ui-search-control input")!;
    const searchControl = searchElement.closest(".ui-search-control")!;
    const searchIcon = searchControl.querySelector("[data-slot=search-control-icon]")!;

    expectClose(inlineInsets(dialogElement, closeElement).end, 11, "dialog close trailing inset");
    expect(getComputedStyle(header).paddingLeft).toBe("44px");
    expect(getComputedStyle(header).paddingRight).toBe("16px");
    expectClose(inlineInsets(header, title).start, 16, "dialog title leading inset");
    expect(getComputedStyle(document.querySelector(".ui-table-head")!).textAlign).toBe("start");
    expect(getComputedStyle(searchElement).paddingRight).toBe(
      viewport.name === "mobile" ? "38px" : "34px",
    );
    expectClose(
      inlineInsets(searchControl, searchIcon).start,
      viewport.name === "mobile" ? 12 : 11,
      "search icon leading inset",
    );

    const closeRect = closeElement.getBoundingClientRect();
    expect(closeRect.width).toBeGreaterThanOrEqual(30);
    expect(closeRect.height).toBeGreaterThanOrEqual(30);
    expect(closeRect.right).toBeLessThanOrEqual(title.getBoundingClientRect().left + tolerance);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(closeElement);

    const radioElement = document.querySelector("[role=menuitemradio]")!;
    expect(radioElement).toBeInstanceOf(HTMLElement);
    const indicator = radioElement.querySelector(".menu-radio-indicator")!;
    expect(getComputedStyle(radioElement).paddingLeft).toBe("30px");
    expectClose(inlineInsets(radioElement, indicator).end, 8, "menu indicator trailing inset");
  });
}
