# Task 11 实施报告：恢复码前端

## 结果

- `SettingsPage` 在 TOTP 区之后挂载 `RecoverySection`，并按后端派生的 `totp_active` 决定是否收集 6 位验证码。组件使用 Task 10 的 `POST /auth/recovery/generate` `{ password, totp_code? }` 契约，从 `ApiResponse.data.codes` 读取且验证完整 10 码；生成请求发出时清空密码/TOTP 输入，成功后只在组件内存展示，关闭或卸载即清除，没有 localStorage/日志写入。
- 提供完整复制与 `text/plain` 下载；Clipboard 缺失/拒绝、Blob、object URL 创建、链接点击与 object URL 释放失败均有可访问的反馈。下载链接会在下一轮事件后撤销其 object URL，给浏览器启动下载留出时间；用户关闭码组或组件卸载后的剪贴板迟到结果不会覆盖新状态。
- `LoginPage` 添加密码页和 TOTP challenge 页的恢复入口，恢复表单按 Task 10 契约提交 `{ username, code }`；成功用返回的 access token 和用户名走现有 auth store / 导航。所有恢复验证失败共用一条错误，不显示原始服务端错误或账户/码状态差异。切换模式会清 challenge、密码、TOTP/恢复码和错误；重复提交、切换后迟到响应及卸载后响应均被忽略。
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

- 点击取消会清除本地输入并使该请求响应失效，但 `api.post` 当前没有取消信号接口；已经发往服务器的生成操作仍可能完成并替换服务器上的恢复码组，而 UI 不会展示这组响应。该限制已作为本轮 ruling 记入台账，独立复审时应重点评估；用户仍可重新发起生成并保存新返回的码组。

## 视觉验收与限制

本地 IAB 对 localhost 的已知 `ERR_BLOCKED_BY_CLIENT` 限制不再重复尝试；本轮以组件行为及响应式布局契约测试替代自动检查。桌面/移动浏览器像素验收未完成，待有可用浏览器环境补做。

## 提交与审阅

独立复审由父任务安排 GPT-5.6 Sol / medium；提交 id 在交接消息中提供。
