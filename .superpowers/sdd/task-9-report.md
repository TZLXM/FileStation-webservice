# Task 9 — TOTP 前端实施报告

## 结果

- 登录页使用 Task 8 的 `LoginResponseData` 判别式响应：收到单次 challenge 后切换至验证码步骤；验证码请求只提交一次，失败或返回后丢弃 challenge、验证码与密码；仅成功响应写入会话。
- 设置页新增 TOTP setup、二维码/手动密钥、确认启用和密码+验证码停用流程。setup 内容仅在当前组件的初始化步骤临时呈现，取消/成功后清理；错误、成功提示、设置刷新错误分别显示。
- `totp_active` 作为后端派生状态呈现且不随 PUT 提交；`totp_required` 可设置，后端拒绝未绑定强制验证时保留用户选择并展示错误。
- 对登录、setup、confirm、disable、设置保存增加重复提交保护及过期响应隔离；登录/设置表单使用语义标签、inline 可访问状态与响应式窄屏布局。

## 验证

- TDD：先运行新增行为测试，观察到预期 RED（7 个预期失败、原有设置页测试通过），再完成实现并转绿。
- Web 全量：11 个测试文件，65 项通过（含 review fix-round 回归）。
- Server 单元：24 suites，143 passed、20 todo。
- Task 8 TOTP e2e：12 项通过，覆盖服务端实际 challenge、消费与 settings 契约。
- `npm run typecheck`：通过。
- `npm run build`：shared、server、web 均通过。
- `git diff --check`：通过。
- `npm run lint`：无法运行；server 与 web 脚本调用的 `eslint` 可执行文件未安装，shared workspace 没有 lint script。未为本任务增装工具链。

## 视觉验收限制与风险

计划要求桌面和移动端浏览器实测。当前环境的 IAB 访问本地开发页返回 `ERR_BLOCKED_BY_CLIENT`，CUA 中无可用 Chrome/Edge；该限制已由父任务确认。未伪称视觉验收通过；补充了登录卡片和 TOTP 设置窄屏响应式类契约测试及真实接口行为测试，但它们不能取代浏览器视觉检查。需要在可用浏览器环境补做桌面/移动实测。

## 安全与范围

- 不记录或输出真实账号、密码、验证码、challenge、TOTP secret、QR 数据或 token；测试仅使用占位夹具。
- 本次只涉及 Task 9 登录/设置前端和台账文档，未开始 Task 10。
- `.claude/settings.local.json` 与 Phase 2 计划文件保持未暂存。

## 提交 / 审阅

- 初始实现提交：`40bfb8a`（GPT-6 Luna）。
- GPT-5.6 Sol 首轮审阅指出两项 Important：TOTP 状态刷新覆盖未保存的 `totp_required` 草稿，以及并发 refresh 缺少陈旧响应保护；均已先补充回归测试并验证 RED，再修复为 GREEN。
- 修复轮 1 提交：`bb51b70`。刷新只覆盖派生 `totp_active`，保留未保存设置草稿；以递增 generation 忽略迟到的 TOTP 状态刷新。SettingsPage 9/9 通过。
- GPT-5.6 Sol 二轮复审确认前两项已解决，但发现旧 refresh 的 reject 仍会形成矛盾错误提示。补测在 10 项设置页测试中得到 1 个预期失败；增加代际错误过滤后 SettingsPage 10/10 通过。
- 修复轮 2 提交：`af71ec6`；generation-aware catch 忽略过期请求的 reject，仍将最新 refresh 错误传播给当前 TOTP 操作。GPT-5.6 Sol 第三轮指出当前 generation 的错误传播缺回归覆盖；现已分别补充启用/停用刷新失败测试（SettingsPage 12/12）。
- 最终复审和本轮测试/文档提交待完成。
