# Changelog

本文档记录 Flavor Island 的用户可见变更，版本号遵循语义化版本。

## [0.5.1] - 2026-08-26

### 安全与兼容
- 接入 flavor-code hook 协议 v2，使用稳定会话、事件与工具调用 ID，避免 Electron 多项目并行时串会话，并正确匹配并行工具的乱序完成事件
- 审批去重改为精确 `eventId`：旧协议仍合并正在等待的重复 relay，但不再按相同工具输入回放已完成决定，避免下一次真实同构操作被误放行
- 移除 Island 本地会话授权副本；“Allow for session”完全由 flavor-code 按工具类别持久化，破坏性与不可缓存操作不展示该按钮

### 交互与动效
- 单击顶部胶囊可手动展开/收起面板，拖动不会误触，键盘 Enter/Space 可操作；审批和问题仍会强制展开
- 审批卡新增宿主原因与工具类别，并重排“一次允许 / 拒绝 / 本会话允许”的视觉层级
- 吉祥物按状态自适应刷新率，空闲降至 8 FPS、工作/等待 20 FPS；窗口隐藏时暂停，`prefers-reduced-motion` 下只绘制静态帧
- 会话归约与胶囊防闪调度支持多个并行工具活动，单个调用结束不再提前显示为 Thinking

### 测试
- 增加协议 v2 映射、精确去重、安全审批元数据与并行工具乱序完成覆盖

## [0.5.0] - 2026-08-26

### 新增
- 支持在岛屿中回答 flavor-code 的 `QuestionBridge` 命令确认；当前实际调用路径中的 `/commit` 与 `/go` loop budget 已覆盖，选择、跳过和自定义输入均沿既有 hook 响应链返回 TUI
- 新增实时任务票据，展开显示 TaskPlan/Todo 与子 Agent 图，标题以 `task 2/5 · implementing cache layer` 形式展示当前进度
- 注册并渲染 `LoopEnd`，展示 `/go` 的成功/失败终态、原因和最后一次验证证据
- 支持交互式 `Notification + question` 卡片及答案回传

### 改进
- fire-and-forget hook 在 daemon 内等待 island 的轻量确认后再关闭 socket，避免快速本地管道上的 EPIPE 竞态
- 活跃任务或 loop 终态会自动展开 island；新用户请求开始时清除上一轮 loop 结果

### 测试
- 增加任务快照变换、状态归约、任务/子 Agent 进度模型、LoopEnd 与插件注册的回归覆盖
