# Task 11 实施报告：恢复码前端

## 结果

- `SettingsPage` 在 TOTP 区之后挂载 `RecoverySection`，并按后端派生的 `totp_active` 决定是否收集 6 位验证码。组件使用 Task 10 的 `POST /auth/recovery/generate` `{ password, totp_code? }` 契约，从 `ApiResponse.data.codes` 读取且验证完整 10 码；生成请求发出时清空密码/TOTP 输入，成功后只在组件内存展示，关闭或卸载即清除，没有 localStorage/日志写入。
- 提供完整复制与 `text/plain` 下载；Clipboard 缺失/拒绝、Blob、object URL 创建、链接点击与 object URL 释放失败均有可访问的反馈。下载链接会在下一轮事件后撤销其 object URL，给浏览器启动下载留出时间；用户关闭码组或组件卸载后的剪贴板迟到结果不会覆盖新状态。
- `LoginPage` 添加密码页和 TOTP challenge 页的恢复入口，恢复表单按 Task 10 契约提交 `{ username, code }`；成功用返回的 access token 和用户名走现有 auth store / 导航。所有恢复验证失败共用一条错误，不显示原始服务端错误或账户/码状态差异。空闲时切换模式会清 challenge、密码、TOTP/恢复码和错误；认证 pending 时锁定所有模式入口，卸载后的响应仍不会回写组件状态。
- 恢复码列表和操作区使用单列到双列的窄屏布局契约、长码换行、语义 label/list、inline `role=alert` / `role=status`。

## TDD 与验证

- RED：实现前聚焦运行中，LoginPage 新增 6 项因恢复入口/表单缺失失败，原有 4 项通过；SettingsPage 新增挂载契约因恢复区缺失失败；RecoverySection 测试因组件文件不存在无法收集。符合预期的 feature-missing RED。
- GREEN：RecoverySection 14 项、LoginPage 10 项、SettingsPage 13 项聚焦测试全部通过（37/37），覆盖实际 DTO、生成后一次性展示、验证输入、取消/确认清敏感状态、重复提交、取消/卸载/模式切换竞态、复制/下载成功失败、object URL 回收、错误信息统一及窄屏布局契约。
- Web 全量：`npm exec --workspace=@filestation/web -- vitest run --reporter=dot --silent --no-color` → 12 files / 86 passed。输出包含既有 React Router future-flag 警告。
- Recovery E2E：`npm run test:e2e --workspace=@filestation/server -- recovery.e2e-spec.ts` → 1 suite / 12 passed。
- 根目录 `npm run typecheck` → server/web/shared 通过；`npm run build` → shared、server、web 通过。
- `npm run lint` 无法运行：server/web 缺 ESLint executable，shared 无 lint script；未安装工具链。
- 工作区 `git diff --check`、暂存后 `git diff --cached --check` 均通过；提交前仅暂存 Task 11 源码、测试、CURRENT-STATE 及平铺 SDD brief/report/progress。

## 运行边界

- 生成请求 pending 时取消和提交按钮禁用，单飞锁保持到请求 settle；`beforeunload` 会提示用户不要刷新/关闭。该接口没有取消信号、幂等请求键或可恢复结果，浏览器崩溃、断网、SPA 卸载或服务端完成但响应丢失时，服务端可能已替换旧码组而新明文码无法送达。前端不持久化恢复码，并明确提示此状态不能依赖恢复码且应确保存在其他认证途径。

## 视觉验收与限制

本地 IAB 对 localhost 的已知 `ERR_BLOCKED_BY_CLIENT` 限制不再重复尝试；本轮以组件行为及响应式布局契约测试替代自动检查。桌面/移动浏览器像素验收未完成，待有可用浏览器环境补做。

## 提交与审阅

独立复审由父任务安排 GPT-5.6 Sol / medium；提交 id 在交接消息中提供。

## 首轮复审修复

- 首轮复审指出 1 个 P1（生成请求 pending 时取消释放单飞锁）和 2 个 P2（登录模式切换可丢弃仍会设置 refresh cookie 的认证响应；父 SettingsPage 的派生 TOTP 状态等 GET 才更新）。逐项对照源码和 AuthController 后确认成立。
- RED：RecoverySection 3 个新行为失败（pending 时取消未禁用、beforeunload 未拦截、TOTP 隐藏后会复显旧值）；LoginPage 3 个认证单飞行为失败（密码、TOTP、恢复验证期间切换控件均未禁用）；SettingsPage 启用/停用确认后 RecoverySection 契约 2 个失败。修正一个测试初始加载同步点后，失败均落在目标行为。
- RecoverySection：请求 pending 时保留请求锁，取消和提交按钮禁用并有明确处理中状态；取消处理器另有防御性锁检查；请求 pending 时为 `beforeunload` 安装离开提示。页面同时解释网络中断可能造成服务端已替换旧码而本地未收到新组，结果不确定时不要依赖恢复码并确保仍有其他认证途径。未将恢复码持久化。
- 登录：密码、TOTP 和恢复码认证的返回/模式切换按钮均在 loading 时禁用，处理器也检查 in-flight ref；模式切换不再递增 generation 或释放请求锁，锁只由原请求 `finally` 释放。服务端 AuthController 仅在密码直登成功、TOTP 成功和恢复码成功时写 HttpOnly `refresh_token`；前端状态测试验证 pending 结果不会被模式切换丢弃，Recovery/TOTP E2E 继续实测 refresh cookie。
- TOTP 派生状态：`TotpSection.onChanged(active)` 在成功启用/停用后携带确认状态；SettingsPage 先同步 `security.totp_active`，再发起带 generation 检查的 GET 并仅合并派生字段，因此不会覆盖 `totp_required` 等未保存草稿。RecoverySection 收到 `totp_active=false` 后清除隐藏的 TOTP 输入。
- GREEN：聚焦 RecoverySection/LoginPage/SettingsPage 42/42；Web 全量 12 files / 91 passed；Recovery E2E 12/12；TOTP E2E 12/12；AuthController cookie 单测 2/2；根目录 typecheck/build 与 `git diff --check` 通过。Web 仍有既有 React Router future-flag 警告。

### 协议级残余风险

`beforeunload` 只为可拦截的刷新/关闭提供浏览器提示；它无法保证浏览器崩溃、网络中断、SPA 导航卸载或服务端已提交而响应丢失时，新生成的明文码一定送达客户端。当前接口没有幂等请求键/可恢复结果，也不应在客户端持久化明文恢复码；不确定时旧码可能已失效、新码可能未送达，前端无法确认服务器此刻采用的恢复码组。此限制已在 UI 和本报告明确告知。
