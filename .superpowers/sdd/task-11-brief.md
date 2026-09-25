# Task 11 — 恢复码前端

## 基线与执行

- 基线：`8b07aa3`（Task 10 第三轮复审批准后的共享工作树）
- 实施：GPT-6 Luna
- 审阅：父任务安排 GPT-5.6 Sol / medium
- 计划：`docs/superpowers/plans/2026-09-19-phase2-reliability-agent-mobile.md` Task 11
- 台账：沿用平铺目录 `.superpowers/sdd/`

## 目标与接口

- 设置页新增 `RecoverySection`：当前密码 + TOTP 激活时的 6 位验证码，调用 `POST /auth/recovery/generate`，从统一响应的 `data.codes` 读取 10 个恢复码；明文只在当前组件内存短暂展示，并提供全量复制和文本文件下载。
- 登录页新增用户名 + 恢复码模式，调用 `POST /auth/recovery/verify`，成功时用返回的 `access_token` 和 `username` 走现有 auth store / 导航；失败时对用户显示统一错误，不揭露用户名或恢复码是否存在、有效、过期或被锁。
- 实际 Task 10 DTO：生成 `{ password, totp_code? }`，验证 `{ username, code }`；响应为 `ApiResponse<T>`，字段位于 `data`。

## 实施约束

- 遵循 RED → GREEN → REFACTOR；先添加行为、竞态和布局契约测试并观察预期失败，再写生产代码。
- 处理重复提交、取消后的迟到响应、组件卸载后的响应；生成成功/取消时清密码与 TOTP，切换登录模式时清 challenge、密码、各类验证码及错误。
- Clipboard、Blob、object URL 建立/点击/释放均有错误处理与用户反馈；不把码写入 localStorage、日志或报告快照。
- 输入与恢复码列表在窄屏不溢出；标签、错误/状态提示和按钮满足键盘及辅助技术使用。
- 浏览器本地页面已有 IAB `ERR_BLOCKED_BY_CLIENT` 阻塞记录，不重试浏览器；用行为测试及布局契约覆盖并在报告中说明视觉限制。
- 只修改 Task 11 前端、对应测试、`CURRENT-STATE.md` 与平铺台账文件；保留 `.claude/settings.local.json` 和未跟踪 Phase 2 计划，不开始 Task 12。

## 验收

- Web 全量测试、Recovery E2E 及必要 server 回归、根目录 typecheck/build、`git diff --check`。
- lint 按仓库现状记录；不安装额外工具链。
- 仅提交 Task 11 范围，使用中文 Conventional Commit 与 GPT-6 Luna trailer。
