# Mish

[简体中文](README.zh-CN.md) | [English](README.md)

![Mish 字标](packages/brand-assets/public/brand/mish-brand.svg)

**Mish 是一个用于本地流量转发、配置管理与诊断的跨平台客户端。**

> [!IMPORTANT]
> Mish 尚无稳定公开版本。已完成的打包就绪审计选定了仅使用系统代理的首个
> macOS 公开版本，但发布准备和验收尚未完成。详情请参阅
> [macOS 打包状态](docs/operations/macos-packaging.md)。

## Mish 可以做什么

- 导入和管理用户提供的 Mihomo 配置。
- 显示连接状态、路由活动、流量、事件和诊断信息。
- 更改路由模式和策略组选项。
- 应用并安全还原 macOS 系统代理设置。
- 在本地保存应用数据，并提供由用户主动发起的导出与备份工具。

## 平台兼容性

| 平台                | 当前兼容性     |
| ------------------- | -------------- |
| macOS（Apple 芯片） | 🚧 有限兼容    |
| Android             | ❌ 暂不支持    |
| iOS                 | — 暂无可用版本 |
| Windows             | — 暂无可用版本 |
| Linux               | — 暂无可用版本 |

附注：

- **macOS：** 当前预览版本仅面向 Apple 芯片，并要求 macOS 13
  或更高版本。首个公开版本选定使用系统代理。目前尚无稳定软件包可供下载。
- **Android：** 仓库中存在开发原型，但它还不是可用的网络客户端，也不支持普通用户使用。
- **iOS：** 目前只有早期架构与验证工作。
- **Windows 和 Linux：** 目前没有可用的应用软件包或已完成的原生集成。
- **浏览器：** 仓库包含用于开发和界面审查的虚构离线演示；它不是网络客户端。

## 安全与隐私

Mish 是一个围绕本地管理的 [Mihomo](THIRD_PARTY_NOTICES.md#mihomo)
Core 构建的中立实验性项目。界面使用 React 和 TypeScript 构建，并通过 Tauri
和 Rust 实现平台集成。Mish 与 MetaCubeX 不存在隶属、背书或官方客户端关系。

Mish 仅提供客户端软件。项目不运营托管代理或 VPN 服务，不销售订阅，也不提供网络端点。

请仅将 Mish 用于合法且已获授权的用途，并遵守所在地区适用的法律及第三方条款。如果您认为
Mish 或本仓库中的任何材料侵犯了您的权利，请联系项目维护者。请勿在公开报告中包含敏感信息或个人信息。

Mish 以本地运行为主，但并非与网络隔离。用户配置、Mihomo、提供者更新、延迟测试和服务探测可能发起出站请求。内置服务图标随应用本地提供；用户自行配置的 HTTPS 服务图标会由浏览器直接请求，Rust 服务不会获取或代理该资源。当前仓库没有配置遥测、托管账户服务、崩溃报告器或自动更新器。

如需报告安全或隐私问题，请联系项目维护者，不要公开发布敏感细节。不要在公开
Issue、截图、CI
日志或文档中包含真实配置、订阅地址、凭据、节点标签、桥接凭据或未经脱敏的支持包。

## 当前限制

- Mish 是预发布软件，可能存在影响连接、系统代理设置、本地文件或用户预期的缺陷。
- 首个 macOS
  公开版本计划仅使用系统代理。“虚拟接口”支持属于独立的后续发行路径，目前不可用。
- Android、iOS、Windows 和 Linux 目前不是受支持的最终用户平台。
- 发布打包、签名、独立验证、已安装应用验收、支持政策、隐私决策、供应链证据和完整依赖通知仍在审查中。
- 公开分发需要完成 [macOS 打包指南](docs/operations/macos-packaging.md)中的发布工作，并解决
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)中的依赖问题。

路线图文档描述意图，而不是承诺。代码、测试、包清单和特定目标的验证证据仍是当前行为的依据。

## 开发与贡献

开发环境、命令、架构和验证细节维护在 [`development.md`](development.md)
和[文档索引](docs/README.md)中。提交拉取请求前请阅读
[CONTRIBUTING.md](CONTRIBUTING.md)。Mish 不要求转让版权或签署贡献者许可协议。提交
贡献即表示提交者确认其有权贡献相关材料，并按照 GPL-3.0-only
许可该贡献，这与 [GitHub 的入站许可等于出站许可规则](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#6-contributions-under-repository-license)
一致。提交本身不会向 Mish 转让版权；所有权仍属于适用的版权所有者，维护者也不会因此
获得单独的专有再许可权。使用生成式 AI 辅助的提交必须经过完整的人工核查，贡献者仍需
对其内容与来源负责。

## 致谢

Mish 的架构与交互设计受到 [Mihomo](THIRD_PARTY_NOTICES.md#mihomo)、ClashX、
[Clash Mi](https://github.com/KaringX/clashmi)、[Stash](https://stash.ws/)、
[Clash Verge](https://github.com/zzzgydi/clash-verge)、
[MetaCubeXD](https://github.com/MetaCubeX/metacubexd) 及其衍生项目的启发，并在部分方面
参考了这些项目。它们均独立于 Mish；此处致谢不表示任何隶属、背书，也不表示 Mish
使用了其代码或资源。若存在具体材料复用，将另行记录在第三方通知中。

## 许可证与署名

Mish 原创源代码采用 [GPL-3.0-only](LICENSE)
许可。第三方组件和资源保留其各自的许可证与通知；详情请参阅
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
