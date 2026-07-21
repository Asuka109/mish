# Mish 五端 Web 客户端研发计划（历史摘要）

状态：已被当前代码、契约与验收文档取代

日期：原计划 2026-07-20；摘要更新 2026-07-21

本文件只保留早期方案中仍有解释价值的方向，不再承担 backlog、工期、
实现状态或验收依据。开始任务时先读 `docs/README.md`，再按任务加载最小的
产品、架构和质量文档。

## 保留的方向

- React、TypeScript、Vite 负责共享产品层；Tauri 2 提供平台壳。
- 桌面端运行独立 Mihomo 进程；移动端使用受控、可验证的原生 Core。
- Android 由 Kotlin `VpnService` 持有授权、TUN、socket protection 与后台
  生命周期；iOS 由 Swift `NEPacketTunnelProvider` 持有 Packet Tunnel。
- WebView 不持有 VPN/TUN 生命周期，平台能力通过类型化边界暴露。
- Mihomo 固定到稳定 tag/commit，构建记录工具链、参数、SHA-256 与 SBOM。
- 原生网络状态修改必须显式、可确认、可恢复；不支持的能力如实显示为
  unavailable。

## 当前现实

| 领域 | 现状与权威来源 |
| --- | --- |
| 产品与视觉 | `PRODUCT.md`、`DESIGN.md`、`docs/product/status-experience.md` |
| Web 与 macOS | 已有生产 Web 基础、Tauri 壳、认证 RPC、Profiles 与 Controller-backed 功能；见 `docs/quality/prototype-validation.md` |
| macOS TUN | 已有显式安装的开发服务；生产打包仍受签名、嵌入与注册门约束 |
| Android | 已有安装包壳、`VpnService` 生命周期原型与 Mobile Core 身份探针；真实 VPN 数据面尚未接通 |
| iOS | 只有架构和验收契约，尚无完整 shell、Packet Tunnel extension 或 XCFramework 流程 |
| 许可证 | 已确定为 GPL-3.0-only；上游来源见 `THIRD_PARTY_NOTICES.md` |

## 下一阶段边界

1. 不从本文件推导任务优先级；以用户请求、当前 issues/PR 和代码事实为准。
2. Android 只有在配置加载、TUN 所有权、socket protection、生命周期与安全
   停止同时闭环后，才能从 fixture 变为真实 VPN。
3. iOS 在账号和 capability 条件具备前，只能推进不冒充真机证据的编译级工作。
4. TUN、System Proxy、签名、安装与网络恢复必须使用对应 operations/quality
   文档，不得以早期阶段计划替代验收。

## 当前入口

- 文档路由：`docs/README.md`
- 开发流程：`development.md`
- 移动架构：`docs/architecture/mobile-runtime-integration.md`
- Android 现状：`docs/operations/android-phase0-prototype.md`
- 移动证据等级：`docs/quality/mobile-validation.md`
