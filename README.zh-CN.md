<p align="center">
  <img src="src/assets/flavor.png" width="128" alt="Flavor Island logo" />
</p>

<h1 align="center">Flavor Island</h1>

<p align="center">
  跨平台（Windows / macOS）桌面端<strong>浮岛</strong>（Floating Island）：实时展示
  <strong>flavor-code</strong> coding agent 的工作状态。
  <br />
  参考 <a href="https://github.com/wxtsky/CodeIsland">CodeIsland</a> 与
  <a href="https://github.com/wxtsky/CodeIslandWin">CodeIslandWin</a> 实现，
  对 flavor-code 提供<strong>原生支持</strong>。
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.1.0-6f42c1" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-brightgreen" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-0078d4" />
  <img alt="electron" src="https://img.shields.io/badge/Electron-42.7.0-47848f" />
</p>

---

## ✨ 功能特性

Flavor Island 住在屏幕顶部，以一个置顶的小药丸（pill）形式展示 flavor-code 会话状态：

- 🟢 **实时状态追踪** — 思考中（闪烁思考点）/ 运行工具（工具类别色）/ 等待审批（琥珀脉冲）/ 等待回答
- 🔐 **权限审批** — 直接在浮岛上 Allow / Allow all / Deny 工具权限请求
- ❓ **问题回答** — 渲染 AskUserQuestion 卡片（单选 / 多选 / 文本 / 自定义输入），自定义输入以复选框 + 单行文本的形式一并提交
- 💬 **会话概览** — 多个会话排序展示，正在工作的会话置顶
- 🖱️ **拖拽移动** — 拖到任意位置，双击复位到顶部居中
- 🪟 **点击穿透** — 浮岛周围的透明区域不遮挡桌面
- 🔊 **音效提示** — 可选的 8-bit 风格提示音

## 🎯 为什么对 flavor-code 是"原生支持"？

Flavor Island **自带配套的 flavor-code 插件**（`src/plugin/`），并在应用启动时
自动安装到 flavor-code 的全局插件目录：

```
~/.flavor-code/plugins/flavor-island/
  ├── flavor-plugin.json   插件清单（声明 12 个 hook）
  ├── activate.mjs         hook 注册：事件转发 + 审批阻塞 relay
  └── bridge.mjs           跨平台传输：Win 命名管道 / macOS Unix socket
```

该插件：

1. 通过 flavor-code 的 hook 系统捕获 `SessionStart` / `UserPromptSubmit` /
   `PreToolUse` / `PostToolUse` / `PermissionRequest` / `Stop` 等全部生命周期事件；
2. 通过 `bridge.mjs` 把事件转发到浮岛监听的 endpoint：
   - **Windows**：命名管道 `\\.\pipe\codeisland-<user>`（可用 `CODEISLAND_PIPE` 覆盖）
   - **macOS**：Unix socket `/tmp/codeisland-<uid>.sock`（可用 `CODEISLAND_SOCKET_PATH` 覆盖，沿用 CodeIsland 原约定）
3. 对 `PermissionRequest` 阻塞等待浮岛的决策并回写（allow / allow-all / deny）；
   浮岛不可达时回退 `ask`，退回终端审批，不会阻塞 flavor-code。
4. `AskUserQuestion` 同样经由 `PermissionRequest` 中继：浮岛弹出选择面板
   （点选选项 / 自定义输入，确认后提交），答案通过决策的 `updatedInput`
   写回；浮岛未应答时 flavor-code 自动退回终端提问，两端互为兜底。

全局插件目录对所有项目生效，**无需在每个项目里 `flavor init` 或做任何配置**。
若项目里同时存在 `flavor init` 安装的内置 `codeisland` 插件，浮岛会自动对
重复的权限请求去重，两个插件可以安全共存。

## 🔌 工作原理

```
flavor-code (CLI)
  → flavor-island 插件（~/.flavor-code/plugins，启动浮岛时自动安装）
    → bridge.mjs
      → Windows: \\.\pipe\codeisland-<user>
      → macOS:   /tmp/codeisland-<uid>.sock
        → Flavor Island (Electron)
          → 实时更新浮岛 UI（状态色 / 动效 / 会话列表）
          → 审批/问答决策写回 socket → bridge 转成 hook decision
            （AskUserQuestion 的答案随 updatedInput 回传给工具）
```

### 平台差异

| | Windows | macOS |
|---|---|---|
| 传输 | 命名管道 | Unix socket |
| 残留清理 | 无需（管道随进程释放） | 启动时自动清理崩溃残留的 stale socket |
| GPU workaround | 启用（disable-gpu 等开关） | 不启用 |
| Dock 图标 | — | 隐藏（仅托盘常驻） |

## 🚀 安装与运行

```bash
npm install
npm start          # 开发模式启动（首次启动即自动安装 flavor-code 插件）
npm test           # 运行单元测试
npm run dist       # 打包 Windows 安装程序（NSIS）
npm run dist:mac   # 打包 macOS 安装包（dmg + zip，需在 macOS 上执行）
```

首次运行后，浮岛会在系统托盘常驻（托盘菜单可查看插件安装状态）。

### 验证链路

```bash
node scripts/e2e-bridge.mjs   # 用真实 bridge 走一遍事件→浮岛→决策回写
node scripts/smoke.mjs        # 启动 Electron 检查 endpoint 是否监听
```

## 📁 项目结构

```
src/
  core/       纯逻辑层（无 Electron 依赖，可单测）：endpoint 路径、事件解析、会话 reducer、问答解析、视图模型、窗口布局
  server/     socket 服务器：事件路由 + 阻塞决策回写 + stale socket 清理
  main/       Electron 主进程：窗口、状态机、托盘、IPC、插件自动安装
  plugin/     flavor-code 配套插件（随应用分发，启动时安装到 ~/.flavor-code/plugins）
  renderer/   浮岛 UI：HTML / CSS / JS
  assets/     图标与音效
test/         node:test 单元测试
scripts/      诊断与端到端验证脚本
```

## 🙏 致谢

- [CodeIsland](https://github.com/wxtsky/CodeIsland) — macOS 刘海灵动岛，MIT
- [CodeIslandWin](https://github.com/wxtsky/CodeIslandWin) — Windows 移植版，MIT
- [flavor-code](https://github.com/wxtsky/flavor-code) — coding agent，提供插件系统与 hook 总线

## 📄 License

[MIT](LICENSE)
