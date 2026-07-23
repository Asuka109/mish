# Mish

[简体中文](README.zh-CN.md) | [English](README.md)

![Mish 字标](packages/brand-assets/public/brand/mish-brand.svg)

**Mish 是一个面向桌面端和移动端的本地流量转发、配置管理与诊断客户端。**

它是一个围绕本地管理的 [Mihomo](https://github.com/MetaCubeX/mihomo) Core
构建的中立实验性项目。共享的 React 和 TypeScript 界面与 Tauri 和 Rust
平台服务集成。Mish 采用 GPL-3.0-only
许可证，与 MetaCubeX 不存在隶属、背书或官方客户端关系。

> [!IMPORTANT]
> Mish 尚无稳定公开版本。目前的 macOS 和 Android
> 构建产物是用于开发和验证的短期测试包，不是生产发行版。已完成的打包就绪审计选定了仅使用系统代理的首个
> macOS 公开版本，但仓库尚未提供所需的签名无辅助程序发行模式和发布证据。详情请参阅[公开发布审查](docs/legal/public-release-review.md)。

Mish 仅提供客户端软件。项目不运营托管代理或 VPN 服务，不销售订阅，不提供网络端点，也不保证任何用户提供的配置或远程服务能够正常工作。

## 当前能力

- 导入、验证、存储、编辑和启用本地或 HTTPS Mihomo 配置。
- 通过类型化应用契约查看状态、路由、流量、事件、诊断、设置和受管理的运行时状态。
- 通过固定版本的 Mihomo Controller API 更改路由模式和策略组选项。
- 通过经过身份验证的本地桥接应用并核对 macOS 系统代理状态，提供明确的恢复和安全停止路径。
- 在独立的安装和授权边界后运行源码开发用途的 macOS TUN 服务。
- 使用虚构数据运行不产生原生副作用的离线浏览器演示。
- 构建 Android 生命周期原型：请求系统 VPN 同意并验证源码构建的 Mobile Core 身份，但不捕获流量。

## 平台状态

| 目标          | 由证据支持的状态                                                                                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 浏览器        | 使用明确测试数据的六路由离线演示。它不会连接桌面 RPC、启动 Mihomo 或更改网络设置。                                                                                                                                                                                         |
| macOS         | 面向 Apple Silicon 的开发和测试包路径，包含经过身份验证的进程内桥接、受管理的 Mihomo 生命周期、可逆系统代理、原生窗口与状态栏集成，以及单独安装的开发 TUN 服务。选定的首个公开版本仅使用系统代理；其签名无辅助程序软件包尚未实现。未提供发布凭据时，测试包仅使用临时签名。 |
| Android       | 可安装的 Tauri 外壳、`VpnService` 生命周期原型，以及经过验证的 Mobile Core 身份探测。它尚未建立 TUN 接口或捕获流量。                                                                                                                                                       |
| iOS           | 仅有架构和验证契约。尚无完整外壳、Packet Tunnel 扩展、签名设备路径或 XCFramework 打包流程。                                                                                                                                                                                |
| Windows/Linux | 仓库中没有受支持的软件包或已完成的原生集成。                                                                                                                                                                                                                               |

桌面 Core 固定为 Mihomo `v1.19.29`。准确的实现声明分别维护在
[生产 Web](docs/quality/production-web-validation.md)、
[macOS](docs/quality/macos-p0-acceptance.md) 和
[移动端](docs/quality/mobile-validation.md)验证文档中。

## 下载与安装

目前没有推荐的最终用户下载。GitHub Actions 已配置为从 `main`
生成会过期的测试产物，但最新的 `cbe281c`
打包运行在托管作业启动前受到私有仓库 Actions 配额或账单状态阻断。因此当前缺少 CI
产物证据，但这不是产品实现阻塞项。测试前仍必须确认工作流成功、产物身份和摘要；这里不承诺未来的
Actions 容量。无发布凭据的 macOS
路径仅使用临时签名且未经公证，Android 路径生成的是调试原型。不要镜像这些产物，也不要将其描述为稳定版本。

维护者和测试人员应遵循有明确边界的
[macOS 打包](docs/operations/macos-packaging.md)或
[Android Phase 0](docs/operations/android-phase0-prototype.md)说明。这些文档描述了准确的产物身份、验证和清理步骤。

## 开发快速开始

要求：

- Node.js 24；
- pnpm 11.13.1；以及
- 稳定版 Rust 工具链。

安装依赖并运行拉取请求门禁：

```sh
pnpm install --frozen-lockfile
pnpm check:pr
```

运行使用虚构数据的浏览器演示：

```sh
pnpm demo
```

当 `http://127.0.0.1:4173` 可用时，`pnpm demo`
会在该地址提供明确的测试数据；否则使用下一个可用端口。它不会执行身份验证、读取应用数据、启动 Mihomo 或修改主机网络设置。

在 Apple Silicon macOS 上进行桌面开发：

```sh
pnpm prepare:mihomo
export MISH_MIHOMO_BIN="$PWD/.scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29"
pnpm desktop:dev
```

准备命令通过 GitHub CLI 下载固定版本的上游发行产物，将其存储在忽略跟踪的临时目录中，并验证上游发布的摘要。桌面进程会自行创建临时桥接凭据；不要手动配置或持久化该凭据。

首次配置工作站请参阅 [`bootstrap.md`](bootstrap.md)，完整命令请参阅[开发命令索引](docs/operations/development-commands.md)。

## 架构

```text
React/TypeScript 界面
        |
        v
类型化契约和经过身份验证的本地 RPC
        |
        v
Rust 应用运行时和桌面桥接
        |
        +--> 平台管理的系统代理 / TUN 边界
        |
        +--> 受管理且固定版本的 Mihomo Core 和 Controller API
```

| 路径                                                   | 职责                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| [`apps/web`](apps/web)                                 | 共享界面以及浏览器、桌面端和移动端客户端选择               |
| [`apps/desktop`](apps/desktop)                         | 精简的 Tauri 桌面外壳和原生组合                            |
| [`apps/mobile`](apps/mobile)                           | Tauri 移动端外壳和 Android 生命周期插件                    |
| [`crates/runtime`](crates/runtime)                     | 与传输方式无关的应用状态和命令                             |
| [`crates/desktop-bridge`](crates/desktop-bridge)       | 经过身份验证的 RPC、进程生命周期、配置、持久化和桌面副作用 |
| [`crates/mihomo-controller`](crates/mihomo-controller) | 固定版本 Mihomo Controller API 的有界适配器                |
| [`crates/profile`](crates/profile)                     | 配置验证、持久化、补丁和启用输入                           |
| [`mobile-core`](mobile-core)                           | 固定的原生 Core ABI、可复现构建输入和证据                  |
| [`packages`](packages)                                 | 共享契约、RPC 客户端、测试数据、UI、设计令牌和品牌资源     |

WebView 不拥有 TUN 描述符、VPN 生命周期、特权状态或 Mihomo
进程。浏览器测试数据不会声称原生或网络操作成功。

## 安全与隐私

Mish 以本地运行为主，但并非与网络隔离。桌面桥接绑定到回环地址并要求应用创建的凭据；配置、Mihomo、计划执行的提供者操作、延迟测试、服务探测和远程服务图标可能发起出站请求。当前仓库没有配置遥测、托管账户服务、崩溃报告器或自动更新器。

报告安全问题前请阅读 [SECURITY.md](SECURITY.md)，当前存储、网络、导出和删除行为请参阅
[PRIVACY.md](PRIVACY.md)。不要在公开 Issue、截图、CI
日志或文档中包含真实配置、订阅地址、凭据、节点标签、桥接凭据或未经脱敏的支持包。

## 限制与路线图边界

- Mish 是预发布软件，可能存在影响连接、系统代理设置、本地文件或用户预期的缺陷。
- 选定的首个 macOS
  公开版本仅使用系统代理。它需要明确的签名无辅助程序发行模式、经过独立验证的
  Developer ID 签名与公证、包含源码修订和 SHA-256 的版本化 DMG 与 GitHub
  Release，以及干净账户安装、升级、卸载、恢复和系统代理还原验收。它不依赖生产特权
  TUN 辅助程序。
- 启用 TUN 的发行版是独立的后续路径，依赖
  [#85](https://github.com/Asuka109/mish/issues/85)、
  [#95](https://github.com/Asuka109/mish/issues/95)和
  [#98](https://github.com/Asuka109/mish/issues/98)。首个版本必须保持“虚拟接口”不可用；计划中的说明交互尚未在当前仓库修订中实现，因此不作为已交付功能声明。
- Android 和 iOS 仍需要真实的原生 VPN 数据路径、套接字保护、生命周期恢复、签名设备验证和分发政策审查。
- Windows 和 Linux 支持不是已排期承诺。
- 更新器、托管服务、付费支持、兼容性保证、服务可用性保证和发布日期均不在当前范围内。
- 发布渠道、手动更新与回滚、支持、隐私、安全联系方式、供应链证据和完整依赖通知政策仍需维护者决策和验证。
- 在[公开发布审查](docs/legal/public-release-review.md)中的依赖许可证和法律通知问题解决前，不得进行分发。

路线图文档描述意图，而不是承诺。代码、测试、包清单和特定目标的验证证据仍是当前行为的依据。

## 文档与贡献

请从[文档索引](docs/README.md)开始。主要契约包括：

- [`PRODUCT.md`](PRODUCT.md)：产品行为和声明边界；
- [`DESIGN.md`](DESIGN.md)：视觉令牌和交互规则；
- [`development.md`](development.md)：仓库工作流和验证；
- [`docs/architecture`](docs/architecture)：运行时和平台边界；以及
- [`docs/quality`](docs/quality)：证据和验收门禁。

欢迎在当前实验性范围内贡献。提交拉取请求前请阅读
[CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证与署名

Mish 原创源代码采用 [GPL-3.0-only](LICENSE)
许可。第三方组件和资源保留其各自的许可证与通知；详情请参阅
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。仓库的公开发布材料属于工程文档，不构成法律建议。另请参阅
[DISCLAIMER.md](DISCLAIMER.md)。
