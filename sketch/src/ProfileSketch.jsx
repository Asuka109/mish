import { useMemo, useState } from "react";
import {
  Alarm,
  ArrowClockwise,
  CaretDown,
  CirclesFour,
  FileText,
  FolderOpen,
  Gauge,
  GearSix,
  GlobeHemisphereWest,
  ListBullets,
  PlugsConnected,
  Power,
  Stack,
  WarningCircle,
  WifiHigh,
  X,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/sonner";

const navigation = [
  { href: "/", icon: Gauge, label: "状态" },
  { href: "/", icon: CirclesFour, label: "路由" },
  { href: "/profiles.html", icon: FileText, label: "配置" },
  { href: "/", icon: PlugsConnected, label: "流量" },
  { href: "/", icon: ListBullets, label: "事件" },
];

const initialProfiles = [
  {
    active: false,
    appliedAt: "今天 18:42",
    file: "studio-route-set.yaml",
    id: "studio",
    interval: "12",
    lastSubscriptionUpdate: "今天 18:40",
    nextSubscriptionUpdate: "明天 06:40",
    source: "subscription",
    url: "https://profiles.example/subscriptions/studio-route-set.yaml",
    valid: true,
  },
  {
    active: true,
    appliedAt: "今天 17:26",
    error: "第 42 行无法解析",
    file: "home.yaml",
    id: "home",
    source: "local",
    valid: false,
  },
];

const updateIntervals = [
  { label: "关闭自动更新", value: "off" },
  { label: "每 6 小时", value: "6" },
  { label: "每 12 小时", value: "12" },
  { label: "每天", value: "24" },
];

function nextUpdateLabel(interval) {
  switch (interval) {
    case "6":
      return "明天 00:40";
    case "12":
      return "明天 06:40";
    case "24":
      return "明天 18:40";
    default:
      return "已关闭";
  }
}

function FileNameTitle({ file }) {
  const extensionStart = file.lastIndexOf(".");
  const hasExtension = extensionStart > 0;
  const name = hasExtension ? file.slice(0, extensionStart) : file;
  const extension = hasExtension ? file.slice(extensionStart) : "";

  return (
    <strong className="profile-sketch-file-title" title={file}>
      <span className="profile-sketch-file-title-name">{name}</span>
      {extension ? <span className="profile-sketch-file-title-extension">{extension}</span> : null}
    </strong>
  );
}

function Sidebar({ connected, onConnectedChange }) {
  return (
    <aside className="sidebar profile-sketch-sidebar" aria-label="主导航">
      <div className="traffic-lights" aria-hidden="true">
        <span className="traffic-light" data-color="red" />
        <span className="traffic-light" data-color="yellow" />
        <span className="traffic-light" data-color="green" />
      </div>
      <div className="brand-row" aria-label="Mish">
        <Stack size={18} />
        <span>Mish</span>
      </div>
      <nav className="nav-list">
        {navigation.map(({ href, icon: Icon, label }) => (
          <a
            className="nav-item"
            data-active={label === "配置" ? "" : undefined}
            href={href}
            key={label}
          >
            <Icon size={17} />
            <span>{label}</span>
          </a>
        ))}
        <a className="nav-item settings-link" href="/">
          <GearSix size={17} />
          <span>设置</span>
        </a>
      </nav>
      <div className="sidebar-status-area">
        <Button
          className="profile-sketch-proxy-button"
          data-connected={connected ? "" : undefined}
          onClick={() => onConnectedChange(!connected)}
          type="button"
          variant={connected ? "default" : "outline"}
        >
          {connected ? <WifiHigh size={17} /> : <Power size={17} />}
          {connected ? "关闭代理" : "启动代理"}
        </Button>
      </div>
    </aside>
  );
}

function Toolbar({ activeProfileId, onActiveProfileChange, profiles }) {
  return (
    <header className="toolbar">
      <span className="toolbar-title">配置</span>
      <label className="profile-sketch-profile-select">
        <FileText size={15} />
        <span className="sr-only">当前配置</span>
        <select
          aria-label="当前配置"
          onChange={(event) => onActiveProfileChange(event.target.value)}
          value={activeProfileId}
        >
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.file}
            </option>
          ))}
        </select>
        <CaretDown aria-hidden="true" size={12} />
      </label>
    </header>
  );
}

function SubscriptionMaintenance({ onDetach, onIntervalChange, profile }) {
  return (
    <div className="profile-sketch-maintenance">
      <div className="profile-sketch-subscription-grid">
        <div className="profile-sketch-subscription-source">
          <span>
            <GlobeHemisphereWest aria-hidden="true" size={15} />
            订阅地址
          </span>
          <strong title={profile.url}>{profile.url}</strong>
        </div>
        <div>
          <span>上次更新</span>
          <strong>{profile.lastSubscriptionUpdate}</strong>
        </div>
        <div>
          <span>下次更新</span>
          <span className="profile-sketch-next-update">
            <strong>{profile.nextSubscriptionUpdate}</strong>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`${profile.file} 设置更新间隔`}
                className="profile-sketch-interval-trigger"
              >
                <Alarm aria-hidden="true" size={15} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="profile-sketch-interval-menu">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>更新间隔</DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuRadioGroup onValueChange={onIntervalChange} value={profile.interval}>
                  {updateIntervals.map((interval) => (
                    <DropdownMenuRadioItem key={interval.value} value={interval.value}>
                      {interval.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      </div>
      <p className="profile-sketch-overwrite-note">
        <WarningCircle aria-hidden="true" size={15} />
        <span>
          直接编辑会在下次更新订阅时被覆盖；如需保留当前文件，可
          <button onClick={onDetach} type="button">解除订阅关联</button>。
        </span>
      </p>
    </div>
  );
}

function ProfileCard({
  onDetach,
  onIntervalChange,
  onRefresh,
  onReveal,
  profile,
  updating,
}) {
  return (
    <article
      className="profile-sketch-card"
      data-profile-id={profile.id}
      data-source={profile.source}
    >
      <header className="profile-sketch-card-header">
        <div className="profile-sketch-card-title">
          <FileNameTitle file={profile.file} />
          {profile.active ? <Badge variant="outline">使用中</Badge> : null}
        </div>
        <div className="profile-sketch-card-actions">
          {profile.source === "subscription" ? (
            <Button disabled={updating} onClick={onRefresh} type="button">
              <ArrowClockwise data-icon="inline-start" />
              {updating ? "正在更新…" : "更新订阅"}
            </Button>
          ) : null}
          <Button onClick={onReveal} type="button" variant="outline">
            <FolderOpen data-icon="inline-start" />
            在文件夹中显示
          </Button>
        </div>
      </header>
      {profile.source === "subscription" ? (
        <div className="profile-sketch-subscription-extension">
          <SubscriptionMaintenance
            onDetach={onDetach}
            onIntervalChange={onIntervalChange}
            profile={profile}
          />
        </div>
      ) : null}
    </article>
  );
}

function AddSubscriptionDialog({ onAdd, onOpenChange, open }) {
  const [fileName, setFileName] = useState("");
  const [url, setUrl] = useState("");
  const canAdd = url.startsWith("https://");

  function submit(event) {
    event.preventDefault();
    if (!canAdd) return;
    const host = new URL(url).hostname.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase();
    const requestedFile = fileName.trim() || `${host || "subscription"}.yaml`;
    const file = requestedFile.includes(".") ? requestedFile : `${requestedFile}.yaml`;
    onAdd({ file, url });
    setFileName("");
    setUrl("");
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="profile-sketch-add-dialog">
        <DialogHeader>
          <DialogTitle>添加订阅</DialogTitle>
          <DialogDescription>
            订阅内容会保存为配置目录中的 YAML 文件，并持续从该地址更新。
          </DialogDescription>
        </DialogHeader>
        <form id="add-subscription-form" onSubmit={submit}>
          <label>
            <span>本地文件名（可选）</span>
            <input
              autoComplete="off"
              onChange={(event) => setFileName(event.target.value)}
              placeholder="例如 studio-route-set.yaml"
              value={fileName}
            />
            <small>留空时使用订阅地址的域名生成文件名。</small>
          </label>
          <label>
            <span>HTTPS 订阅地址</span>
            <input
              aria-invalid={url.length > 0 && !canAdd}
              autoComplete="off"
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/subscription"
              type="url"
              value={url}
            />
          </label>
          {url.length > 0 && !canAdd ? <p>订阅地址必须使用 HTTPS。</p> : null}
        </form>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            取消
          </Button>
          <Button disabled={!canAdd} form="add-subscription-form" type="submit">
            检查并保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecoveryNotification({ onClose, onRestore }) {
  return (
    <aside className="profile-sketch-notification" aria-label="配置文件错误通知">
      <WarningCircle aria-hidden="true" size={19} />
      <div>
        <strong>Home.yaml 无法应用</strong>
        <p>核心未受影响，仍在使用最近正确版本。</p>
      </div>
      <Button onClick={onRestore} size="sm" type="button" variant="outline">
        恢复到上个版本
      </Button>
      <button aria-label="关闭通知" onClick={onClose} type="button">
        <X size={15} />
      </button>
    </aside>
  );
}

export function ProfileSketch() {
  const [activeProfileId, setActiveProfileId] = useState("home");
  const [addOpen, setAddOpen] = useState(false);
  const [connected, setConnected] = useState(true);
  const [notificationVisible, setNotificationVisible] = useState(true);
  const [profiles, setProfiles] = useState(initialProfiles);
  const [updatingId, setUpdatingId] = useState(null);
  const invalidActiveProfile = useMemo(
    () => profiles.find((profile) => profile.active && !profile.valid),
    [profiles],
  );

  function updateProfile(id, updater) {
    setProfiles((current) =>
      current.map((profile) => (profile.id === id ? updater(profile) : profile)),
    );
  }

  function refreshSubscription(id) {
    setUpdatingId(id);
    window.setTimeout(() => {
      updateProfile(id, (profile) => ({
        ...profile,
        appliedAt: profile.active ? "刚刚" : profile.appliedAt,
        lastSubscriptionUpdate: "刚刚",
        nextSubscriptionUpdate: nextUpdateLabel(profile.interval),
      }));
      setUpdatingId(null);
      toast.success("订阅已更新，本地 YAML 已原子替换");
    }, 900);
  }

  function restoreProfile(id) {
    updateProfile(id, (profile) => ({
      ...profile,
      appliedAt: "刚刚",
      error: undefined,
      valid: true,
    }));
    setNotificationVisible(false);
    toast.success("已恢复 Home.yaml，并重新应用配置");
  }

  function detachSubscription(id) {
    updateProfile(id, (profile) => ({
      ...profile,
      source: "local",
      url: undefined,
    }));
    toast.success("已解除订阅关联；YAML 文件保留在配置目录中");
  }

  function changeActiveProfile(id) {
    setActiveProfileId(id);
    setProfiles((current) =>
      current.map((profile) => ({ ...profile, active: profile.id === id })),
    );
    const selected = profiles.find((profile) => profile.id === id);
    if (selected?.valid === false) {
      setNotificationVisible(true);
      return;
    }
    toast.success(`已切换到 ${selected?.file ?? id}`);
  }

  function addSubscription({ file, url }) {
    const id = `subscription-${Date.now()}`;
    setProfiles((current) => [
      ...current,
      {
        active: false,
        appliedAt: "尚未应用",
        file,
        id,
        interval: "12",
        lastSubscriptionUpdate: "刚刚",
        nextSubscriptionUpdate: nextUpdateLabel("12"),
        source: "subscription",
        url,
        valid: true,
      },
    ]);
    setAddOpen(false);
    toast.success(`${file} 已保存到配置目录`);
  }

  return (
    <div className="profile-sketch" data-screen-label="profiles-materialized-yaml-recovery">
      <div className="app-shell">
        <Sidebar connected={connected} onConnectedChange={setConnected} />
        <section className="workspace">
          <Toolbar
            activeProfileId={activeProfileId}
            onActiveProfileChange={changeActiveProfile}
            profiles={profiles}
          />
          <main className="page-scroll profile-sketch-page">
            <header className="profile-sketch-page-header">
              <div>
                <h1>配置</h1>
                <p>所有配置都保存在本地 YAML；订阅负责持续更新其中的文件。</p>
              </div>
              <div>
                <Button
                  onClick={() => toast.info("演示：已打开配置目录")}
                  type="button"
                  variant="outline"
                >
                  <FolderOpen data-icon="inline-start" />
                  打开配置目录
                </Button>
                <Button onClick={() => setAddOpen(true)} type="button">
                  <GlobeHemisphereWest data-icon="inline-start" />
                  添加订阅
                </Button>
              </div>
            </header>
            <section aria-label="配置文件" className="profile-sketch-list">
              {profiles.map((profile) => (
                <ProfileCard
                  key={profile.id}
                  onDetach={() => detachSubscription(profile.id)}
                  onIntervalChange={(interval) =>
                    updateProfile(profile.id, (current) => ({
                      ...current,
                      interval,
                      nextSubscriptionUpdate: nextUpdateLabel(interval),
                    }))
                  }
                  onRefresh={() => refreshSubscription(profile.id)}
                  onReveal={() => toast.info(`演示：在文件夹中显示 ${profile.file}`)}
                  profile={profile}
                  updating={updatingId === profile.id}
                />
              ))}
            </section>
          </main>
        </section>
      </div>
      {notificationVisible && invalidActiveProfile ? (
        <RecoveryNotification
          onClose={() => setNotificationVisible(false)}
          onRestore={() => restoreProfile(invalidActiveProfile.id)}
        />
      ) : null}
      <AddSubscriptionDialog onAdd={addSubscription} onOpenChange={setAddOpen} open={addOpen} />
      <Toaster position="bottom-right" />
    </div>
  );
}
