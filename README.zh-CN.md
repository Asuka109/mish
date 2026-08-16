# Mish

Mish 是面向本地流量管理的 Mihomo 兼容服务界面。当前产品表面由
TypeScript/React 实现，包含 Status、Routes、Profiles、Traffic、Events 和
Settings 六个可导航页面。

当前生产图保持明确且单一：

- `packages/contracts` 定义共享契约和操作；
- `packages/orpc-client` 提供 oRPC 传输与有界 transcript；
- `packages/domain` 和 XState actor 持有领域生命周期；
- TanStack Query 持有服务器投影，`packages/ui-state` 只持有展示状态；
- Electron 与 React Native 只提供宿主 seam，不复制产品生命周期或缓存权威。

浏览器产品在渲染数据投影前必须完成 session 认证。测试使用无凭据的契约
fixture、确定性 transcript 和 replay；不宣称真实网络、权限、VPN、TUN 或系统代理
效果。隔离的 `poc/` 目录仅能由 `pnpm poc:admission` 检查，不能进入生产 workspace
或运行时图。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm check:pr
pnpm web:build
```

宿主门禁为 `pnpm desktop:check` 和 `pnpm mobile:check`。`pnpm
desktop:bundle:fixture` 只生成一次性、无凭据的 DMG fixture；`pnpm
mobile:android:build` 生成 admission 使用的双 ABI debug APK。这些命令不会发布、签名、
公证、部署，也不会写入外部服务。

架构和验证入口见 [`docs/README.md`](docs/README.md)，贡献规则见
[`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 许可证

Mish 原创代码采用 [GPL-3.0-only](LICENSE) 许可。直接依赖和资源通知见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
