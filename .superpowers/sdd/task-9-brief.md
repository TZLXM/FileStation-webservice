# Task 9 — TOTP 前端（登录两步 + 设置页管理）

## 基线与执行

- 基线：`497fc35`（Task 8 最终复修）
- 实施：GPT-6 Luna / max
- 计划：`docs/superpowers/plans/2026-09-19-phase2-reliability-agent-mobile.md` Task 9
- 台账：沿用平铺目录 `.superpowers/sdd/`

## 目标

- 使用 Task 8 `/auth/login` 的 `LoginResponseData`：密码登录返回 challenge 时进入 TOTP 步骤；调用 `/auth/login/totp` 后成功建立会话并导航，失败时丢弃单次 challenge 并回到账密步骤。
- 设置页提供 TOTP setup（QR 与手动密钥）、确认启用、密码+验证码停用，并显示后端派生的 `security.totp_active`。
- 允许更新 `security.totp_required`；无激活器时向用户展示后端 400 信息，激活后可以保存。

## 必须遵守

- 先写用户可见行为测试并观察预期 RED，再实现；保持改动在 Task 9，不开始 Task 10。
- 处理快速重复提交、旧响应晚到、切换/取消步骤后的陈旧响应；API 失败后的 challenge 不得继续复用。
- 登录、setup、confirm、disable、设置保存的错误状态彼此独立；使用语义化标签、inline `role=alert`/`role=status`、键盘可达控件及窄屏布局。
- secret/QR 仅在 setup 界面临时展示；验证码、密码、challenge、secret、QR、access/refresh token 不写日志、测试诊断或报告。
- 遵循真实接口封套 `ApiResponse.data`；端点分别为 `/auth/login`、`/auth/login/totp`、`/auth/totp/setup`、`/auth/totp/confirm`、`/auth/totp/disable` 和 `/settings`。
- 桌面及移动端都实际检查登录两步、TOTP 设置布局与交互；必要时读取 computer-use skill 后操作浏览器。
- 更新 `docs/CURRENT-STATE.md`、Task 9 报告和 progress；只暂存 Task 9 代码及必要台账文档。
- 保留未跟踪 `.claude/settings.local.json` 与计划文件。

## 预期验证

- LoginPage：密码成功时分流 challenge；正确码完成登录；错误码消耗 challenge 并回到账密步骤；返回时清除 challenge；快速重复提交不产生重复请求；迟到响应不改变新状态。
- TotpSection：setup、确认、取消、停用使用正确 DTO；输入验证、双击保护、失败与成功状态；敏感 setup 数据不跨组件生命周期留存。
- SettingsPage：读取/保存 `totp_active` 与 `totp_required`；保存无激活 TOTP 的强制选项时保留开关并显示后端 400。
- Web 测试、Task 8 相关服务端测试、typecheck、build、diff-check。

## 已知约束

- Task 8 当前契约已在本地后端实现；错误 TOTP 会消费 challenge。
- 仓库 lint 脚本缺 ESLint 可执行文件，既有台账已记录；本任务不安装额外工具链。
