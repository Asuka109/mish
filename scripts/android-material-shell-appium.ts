import { writeFileSync } from "node:fs";

const PACKAGE_NAME = "com.asuka109.mish";
const ACTIVITY = ".MainActivity";
const DISABLED_DESTINATION_EXTRA = `${PACKAGE_NAME}.test.DISABLED_DESTINATION`;
const EXTERNAL_DEEP_LINK_EXTRA = `${PACKAGE_NAME}.test.EXTERNAL_DEEP_LINK`;
const DESTINATION_IDS = {
  Activity: `${PACKAGE_NAME}:id/native_shell_activity`,
  Home: `${PACKAGE_NAME}:id/native_shell_home`,
  Profiles: `${PACKAGE_NAME}:id/native_shell_profiles`,
  Routes: `${PACKAGE_NAME}:id/native_shell_routes`,
  Settings: `${PACKAGE_NAME}:id/native_shell_settings`,
} as const;

type Destination = keyof typeof DESTINATION_IDS;

interface ShellSnapshot {
  authorityId: string;
  revision: number;
  webEntryPath: string;
}

interface Evidence {
  apkSha256: string;
  device: string;
  assertions: string[];
  initial: ShellSnapshot;
  final: ShellSnapshot;
  screenshots: string[];
}

const options = new Map<string, string>();
const firstArgument = process.argv[2] === "--" ? 3 : 2;
for (let index = firstArgument; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument near ${key ?? "end"}`);
  options.set(key.slice(2), value);
}

const server = options.get("server") ?? "http://127.0.0.1:4723";
const device = options.get("serial");
const output = options.get("output");
const screenshotPrefix = options.get("screenshots");
const apkSha256 = options.get("apk-sha256") ?? "not-supplied";
if (!device) throw new Error("--serial is required");

const delay = (milliseconds: number) =>
  new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`${server}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
  });
  const payload = (await response.json()) as { value?: T & { message?: string } };
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${payload.value?.message ?? JSON.stringify(payload)}`);
  }
  return payload.value as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const session = await request<{ sessionId: string }>("/session", "POST", {
  capabilities: {
    alwaysMatch: {
      platformName: "Android",
      "appium:appActivity": ACTIVITY,
      "appium:appPackage": PACKAGE_NAME,
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": "Mish Android Material shell acceptance",
      "appium:newCommandTimeout": 600,
      "appium:noReset": true,
      "appium:udid": device,
    },
  },
});
const sessionPath = `/session/${session.sessionId}`;
const assertions: string[] = [];
const screenshots: string[] = [];

async function element(using: string, value: string): Promise<string> {
  const found = await request<Record<string, string>>(`${sessionPath}/element`, "POST", {
    using,
    value,
  });
  return found["element-6066-11e4-a52e-4f735466cecf"];
}

async function waitForElement(using: string, value: string, timeout = 8_000): Promise<string> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await element(using, value);
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw lastError;
}

async function attribute(elementId: string, name: string): Promise<string> {
  return request(`${sessionPath}/element/${elementId}/attribute/${name}`);
}

async function rect(
  elementId: string,
): Promise<{ height: number; width: number; x: number; y: number }> {
  return request(`${sessionPath}/element/${elementId}/rect`);
}

async function click(elementId: string): Promise<void> {
  await request(`${sessionPath}/element/${elementId}/click`, "POST", {});
}

async function switchContext(name: "NATIVE_APP" | `WEBVIEW_${string}`): Promise<void> {
  await request(`${sessionPath}/context`, "POST", { name });
}

async function waitForContexts(timeout = 12_000): Promise<string[]> {
  const deadline = Date.now() + timeout;
  let contexts: string[] = [];
  while (Date.now() < deadline) {
    contexts = await request<string[]>(`${sessionPath}/contexts`);
    if (
      contexts.includes("NATIVE_APP") &&
      contexts.filter((context) => context.startsWith("WEBVIEW_")).length === 1
    ) {
      return contexts;
    }
    await delay(250);
  }
  throw new Error(`Expected one native and one WebView context, got ${contexts.join(", ")}`);
}

async function execute<T>(script: string, argument?: unknown): Promise<T> {
  return request(`${sessionPath}/execute/sync`, "POST", {
    args: argument === undefined ? [] : [argument],
    script,
  });
}

async function snapshot(): Promise<ShellSnapshot> {
  const value = await execute<ShellSnapshot>("return window.__MISH_ANDROID_SHELL_SNAPSHOT__");
  assert(value && typeof value.authorityId === "string", "Web shell snapshot is unavailable");
  return value;
}

async function webUrl(): Promise<string> {
  return request(`${sessionPath}/url`);
}

async function capture(name: string): Promise<void> {
  if (!screenshotPrefix) return;
  const path = `${screenshotPrefix}-${name}.png`;
  const encoded = await request<string>(`${sessionPath}/screenshot`);
  writeFileSync(path, Buffer.from(encoded, "base64"));
  screenshots.push(path);
}

async function startActivity(argument: Record<string, unknown>): Promise<void> {
  await switchContext("NATIVE_APP");
  await execute("mobile: startActivity", {
    component: `${PACKAGE_NAME}/${ACTIVITY}`,
    wait: true,
    ...argument,
  });
}

async function destinationItem(destination: Destination): Promise<string> {
  return waitForElement("id", DESTINATION_IDS[destination]);
}

async function selectedDestination(destination: Destination): Promise<string> {
  const item = await destinationItem(destination);
  assert((await attribute(item, "selected")) === "true", `${destination} is not selected`);
  return item;
}

try {
  await startActivity({
    action: "android.intent.action.MAIN",
    categories: ["android.intent.category.LAUNCHER"],
    flags: "0x10200000",
    stop: true,
  });
  const contexts = await waitForContexts();
  const webContexts = contexts.filter((context) => context.startsWith("WEBVIEW_"));
  assert(
    contexts.includes("NATIVE_APP") && webContexts.length === 1,
    "Expected one native and one WebView context",
  );
  const webContext = webContexts[0] as `WEBVIEW_${string}`;

  await switchContext("NATIVE_APP");
  await waitForElement("id", `${PACKAGE_NAME}:id/native_shell_root`);
  await waitForElement("id", `${PACKAGE_NAME}:id/native_shell_app_bar`);
  await waitForElement("id", `${PACKAGE_NAME}:id/native_shell_bottom_navigation`);
  for (const destination of Object.keys(DESTINATION_IDS) as Destination[]) {
    const item = await destinationItem(destination);
    assert(
      (await attribute(item, "content-desc")).trim().length > 0,
      `${destination} has no accessible name`,
    );
  }
  await selectedDestination("Home");
  assertions.push(
    "one retained WebView context and five semantically labelled Material destinations",
  );
  await capture("home");

  await switchContext(webContext);
  const initial = await snapshot();
  assert(
    initial.revision === 0 && initial.webEntryPath === "/status",
    "Unexpected initial Rust snapshot",
  );

  await switchContext("NATIVE_APP");
  await click(await destinationItem("Settings"));
  await selectedDestination("Settings");
  const settingsTitle = await waitForElement(
    "xpath",
    `//*[@resource-id='${PACKAGE_NAME}:id/native_shell_app_bar']//*[@class='android.widget.TextView']`,
  );
  assert((await attribute(settingsTitle, "text")).trim().length > 0, "App-bar title is empty");
  await capture("settings");
  await switchContext(webContext);
  const settings = await snapshot();
  assert(
    settings.revision === 1 && settings.webEntryPath === "/settings",
    "Settings entry was not committed once",
  );
  assert((await webUrl()).endsWith("/settings"), "Settings directive did not enter React Router");

  await switchContext("NATIVE_APP");
  await click(await destinationItem("Settings"));
  await switchContext(webContext);
  assert(
    (await snapshot()).revision === settings.revision,
    "Reselection mutated Shared Rust authority",
  );
  assertions.push("Native -> Shared Rust -> Web selection and non-mutating reselection");

  await switchContext("NATIVE_APP");
  const routes = await destinationItem("Routes");
  const routesRect = await rect(routes);
  await request(`${sessionPath}/actions`, "POST", {
    actions: [
      {
        actions: [
          {
            duration: 0,
            type: "pointerMove",
            x: routesRect.x + routesRect.width / 2,
            y: routesRect.y + routesRect.height / 2,
          },
          { button: 0, type: "pointerDown" },
          { duration: 350, type: "pause" },
          { duration: 250, type: "pointerMove", x: 4, y: routesRect.y - 24 },
          { button: 0, type: "pointerUp" },
        ],
        id: "material-cancel",
        parameters: { pointerType: "touch" },
        type: "pointer",
      },
    ],
  });
  await switchContext(webContext);
  assert(
    (await snapshot()).revision === settings.revision,
    "Cancelled Material press committed selection",
  );
  await switchContext("NATIVE_APP");
  await click(routes);
  await selectedDestination("Routes");
  await switchContext(webContext);
  const routesSnapshot = await snapshot();
  assert(
    routesSnapshot.revision === 2 && routesSnapshot.webEntryPath === "/routes",
    "Routes selection did not commit",
  );
  assertions.push("cancelled press is inert; committed press increments exactly once");

  await startActivity({
    action: "android.intent.action.MAIN",
    categories: ["android.intent.category.LAUNCHER"],
    extras: [["s", DISABLED_DESTINATION_EXTRA, "profiles"]],
    flags: "0x20000000",
  });
  const profiles = await destinationItem("Profiles");
  assert(
    (await attribute(profiles, "enabled")) === "false",
    "Disabled destination is not exposed semantically",
  );
  await click(profiles).catch(() => undefined);
  await switchContext(webContext);
  assert(
    (await snapshot()).revision === routesSnapshot.revision,
    "Disabled destination committed selection",
  );
  assertions.push("disabled destination exposes enabled=false and cannot commit");
  await switchContext("NATIVE_APP");
  await capture("disabled");

  await startActivity({
    action: "android.intent.action.VIEW",
    categories: ["android.intent.category.BROWSABLE"],
    extras: [["z", EXTERNAL_DEEP_LINK_EXTRA, "true"]],
    flags: "0x20000000",
    uri: "mish://app/settings/network?source=appium",
  });
  await selectedDestination("Settings");
  await switchContext(webContext);
  const deepLink = await snapshot();
  assert(
    deepLink.revision === 3 && deepLink.webEntryPath === "/settings/network?source=appium",
    "Validated deep link was not preserved exactly",
  );

  await startActivity({
    action: "android.intent.action.VIEW",
    categories: ["android.intent.category.BROWSABLE"],
    extras: [
      ["z", EXTERNAL_DEEP_LINK_EXTRA, "true"],
      ["s", "android.intent.extra.REFERRER_NAME", `android-app://${PACKAGE_NAME}`],
    ],
    flags: "0x20000000",
    uri: "mish://app/profiles?source=self",
  });
  await switchContext(webContext);
  assert(
    (await snapshot()).revision === deepLink.revision,
    "Self-originated deep link crossed the native boundary",
  );
  assertions.push("external deep link commits exactly; self-originated deep link is rejected");

  await switchContext("NATIVE_APP");
  await click(await destinationItem("Home"));
  await selectedDestination("Home");
  await click(await destinationItem("Settings"));
  await selectedDestination("Settings");
  await switchContext(webContext);
  const settingsRoot = await snapshot();
  const applicationLink = await waitForElement("css selector", "a[href='/settings/application']");
  await click(applicationLink);
  assert(
    (await webUrl()).endsWith("/settings/application"),
    "Internal Web child history did not advance",
  );
  assert(
    (await snapshot()).revision === settingsRoot.revision,
    "Internal Web navigation mutated Shared Rust authority",
  );
  await switchContext("NATIVE_APP");
  await click(
    await waitForElement(
      "xpath",
      `//*[@resource-id='${PACKAGE_NAME}:id/native_shell_app_bar']//*[@clickable='true']`,
    ),
  );
  await switchContext(webContext);
  assert(
    (await webUrl()).endsWith("/settings"),
    "Native app-bar Back did not consume Web history once",
  );
  assert(
    (await snapshot()).revision === settingsRoot.revision,
    "Web Back mutated Shared Rust authority",
  );
  assertions.push("Web owns child history and the sole Android Back callback consumes it once");

  await switchContext("NATIVE_APP");
  await click(await destinationItem("Routes"));
  await switchContext(webContext);
  const search = await waitForElement("css selector", "input[type='search']");
  await click(search);
  await request(`${sessionPath}/element/${search}/value`, "POST", {
    text: "Proxy",
    value: [..."Proxy"],
  });
  await switchContext("NATIVE_APP");
  assert(await execute<boolean>("mobile: isKeyboardShown"), "Search did not expose the real IME");
  assert(
    (await attribute(
      await waitForElement("id", `${PACKAGE_NAME}:id/native_shell_bottom_navigation`),
      "displayed",
    )) === "true",
    "IME obscured the native navigation projection",
  );
  await capture("ime");
  await execute("mobile: hideKeyboard");
  await click(await destinationItem("Settings"));
  await selectedDestination("Settings");
  assertions.push("real IME keeps native navigation visible and dismisses without a shell command");

  await request(`${sessionPath}/orientation`, "POST", { orientation: "LANDSCAPE" });
  await waitForElement("id", `${PACKAGE_NAME}:id/native_shell_bottom_navigation`);
  await capture("landscape");
  await request(`${sessionPath}/orientation`, "POST", { orientation: "PORTRAIT" });
  await waitForElement("id", `${PACKAGE_NAME}:id/native_shell_bottom_navigation`);
  assertions.push("Material chrome survives API 36 portrait/landscape configuration changes");

  await startActivity({
    action: "android.intent.action.MAIN",
    categories: ["android.intent.category.LAUNCHER"],
    flags: "0x10200000",
    stop: true,
  });
  const recreatedContexts = await waitForContexts();
  const recreatedWebContext = recreatedContexts.find((context) => context.startsWith("WEBVIEW_"));
  assert(recreatedWebContext, "Recreated process did not expose exactly one WebView");
  await switchContext(recreatedWebContext as `WEBVIEW_${string}`);
  const final = await snapshot();
  assert(
    final.authorityId !== initial.authorityId,
    "Process replacement reused a retired Rust authority",
  );
  assert(
    final.revision === 0 && final.webEntryPath === "/status",
    "Recreated process did not bootstrap its complete snapshot",
  );
  await switchContext("NATIVE_APP");
  await selectedDestination("Home");
  assertions.push("process replacement creates a new authority and reprojects Home revision 0");

  await request(`${sessionPath}/back`, "POST", {});
  await delay(500);
  const currentPackage = await execute<string>("mobile: getCurrentPackage");
  assert(currentPackage !== PACKAGE_NAME, "System Back at the Web root did not exit the Activity");
  assertions.push("system Back at a Web root exits instead of double-dispatching");

  const evidence: Evidence = {
    apkSha256,
    assertions,
    device,
    final,
    initial,
    screenshots,
  };
  if (output) writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await request(`${sessionPath}`, "DELETE").catch(() => undefined);
}
