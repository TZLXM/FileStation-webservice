# Current State

Updated: 2026-09-26

FileStation 是一个私有文件传输站 Web 应用。**Phase 1 MVP 与 Phase 2 实现/自动化验证已完成；Phase 2 发布验收仍 blocked/pending。** 代码测试通过不能替代用户手动验收或未解决的依赖安全门。

## 项目状态

| 方面 | 状态 |
|------|------|
| 设计文档 | v2.3 as-built 更新；Phase 1 实施计划迭代至 v1.7（经两轮外部评审） |
| 项目管理 | AGENTS.md 已建立 |
| 代码实现 | Phase 1 MVP 完成；Phase 2 TOTP 两步登录与设置页管理、恢复码前后端、API Token、审计日志、MCP 服务及对应 Web 页面已实现；Task 10 第三轮复审修复、Task 11 最终复审、Task 12 断点续传 UI 与 Task 13 并发/压力测试修复均已获独立审阅批准 |
| 自动化 | Task14 文档变更后：server unit 25 suites / 172 passed / 20 todo；full server E2E 9 suites / 83 passed；Web `npx vitest run --no-cache` 15 files / 131 passed；root typecheck/build/diff-check 通过。Lint 不可用；CI 单次 `npm test` 的 server/Web 均通过，但根聚合最终因 shared 缺少 `test` script 退出 1 |
| 用户手动验收 | **Pending**：真实 MCP 客户端、375px 小屏、TOTP/恢复码真实流程、页面刷新后的文件断点续传；Phase 1 的既有浏览器验证不代表 Phase 2 验收 |
| 发布安全门 | **Blocked/Pending**：2026-09-26 `npm audit` 仍有 Critical/High；未运行 `npm audit fix`，未升级大版本；风险与兼容性细节见下文 |
| 部署 | 单进程模式（默认）与 Nginx 反代模式均可用；已推送至 GitHub |

## 设计决策摘要

### 技术栈
- **后端**: NestJS 10 (Node.js/TypeScript)
- **前端**: React 18 + Tailwind CSS（shadcn/ui 风格组件，未引入 shadcn 依赖）
- **数据库**: SQLite (TypeORM, WAL 模式, busy_timeout=5000)
- **构建**: Vite 5 + npm workspaces

### 核心架构决策

1. **文件公开方式**: 统一走 `shares` 表，文件始终私有
2. **上传协议**: HTTP 分块上传（非 WebSocket 传文件主体）
3. **上传完成**: 三阶段分离（抢占 → 处理 → 完成）+ 租约心跳 + 崩溃恢复
4. **下载计数**: 先抢占 `download_sessions`，再扣减分享额度
5. **直链规则**: `type=direct` 必须 `protection=none`（Phase 3 实现）
6. **初始化安全**: 一次性 Token（哈希存储 + timingSafeEqual + 10 分钟过期）；Nginx `allow/deny` 为可选加强层
7. **临时码**: 130 bit 熵（26 字符 Crockford Base32），Argon2id 哈希（Phase 4 实现）
8. **Nginx 可选**: 单进程模式后端自托管前端静态文件（ADR-0004）

### 数据库关键设计

- 时间字段：Unix 毫秒 (INTEGER)，UTC
- 限速单位：bytes_per_second (INTEGER)
- 分块存储：独立 `.part` 文件，完成时合并 + fsync + 原子 rename
- 文件夹删除：MVP 仅允许删除空文件夹
- 存储路径：环境变量控制，非热更新
- 21 张表 + 初始迁移 `1700000000000-initial-schema.ts`

## 开发里程碑

### Phase 1: MVP（已完成，2026-09-01 验证通过）

- [x] 项目脚手架（NestJS + React + SQLite）
- [x] 安全初始化（一次性 Token，header 传递；Nginx allow/deny 可选）
- [x] 账号密码登录 + JWT + Refresh Token（HttpOnly Cookie）
- [x] 登录锁定（账号维度固定锁定 + IP 维度独立限速 + 计时扁平化）
- [x] 文件上传（分块 + upload_token + 三阶段完成 + 租约恢复）
- [x] 文件下载（Range + download_session + 416 处理）
- [x] 文件夹 CRUD（仅空文件夹删除）
- [x] 文件有效期 + 自动过期（生命周期 Cron + 启动全量扫描）
- [x] 分享链接（page 类型，统一 access 流程，下载票据四层重校验）
- [x] 基础设置页（默认有效期/分块大小/清理宽限/登录锁定参数）
- [x] Nginx 可选化（单进程静态托管模式，ADR-0004）

### Phase 2: 可靠性（实现/自动化完成，发布验收待完成）

- [x] TOTP 认证（AES-256-GCM 密文、管理员 setup/confirm/disable、单次 login_challenge 两步登录、两步登录 UI、设置页启停与强制 TOTP 开关）
- [x] API Token 管理、exchange 短期 JWT 与 scopes（默认拒绝，scope 以数据库为准）
- [x] 恢复码后端（Argon2id、24 小时、一次性消费、账户/IP 防线、带租约的持久化逐请求 IP reservation、单事务消费+旧 session 撤销+新 session 插入；Swagger/OpenAPI 文档；第三轮修复由 GPT-5.6 Sol 最终批准，无 Critical/P1/P2）
- [x] 恢复码前端（设置页以密码和启用时的 TOTP 生成、一次性展示、复制/下载；登录页用户名+恢复码应急登录）
- [x] 断点续传 UI（本地续传记录校验、服务端状态探测与重试、重新选择原文件续传、确认放弃；存储不可用时不阻断当前上传）
- [x] 审计日志（管理员查询、90 天保留、关键操作埋点）
- [x] 内嵌 MCP 服务（默认关闭、Streamable HTTP、11 个工具、API Token scope 校验与工具审计）
- [x] Web API Token 管理、MCP 设置与审计日志分页/操作过滤页面
- [x] 前端全局导航与移动端适配（文件夹抽屉、文件卡片、触屏操作、分享/设置页布局）
- [x] 并发/压力测试（下载额度、同 session complete 幂等、冲突分块竞争、不同 session 并发上传/完成）

#### 发布验收状态

- **实现 + 自动化验证：** Phase 2 功能已实现；Task 13 独立复审 APPROVED。Task14 文档变更后的 server unit 25 suites / 172 passed / 20 todo、完整 server E2E 9 suites / 83 passed、Web 15 files / 131 passed、typecheck/build/diff-check 均通过。
- **用户验收：** 尚未完成。真实 MCP 客户端联调、375px 真实浏览器/设备、TOTP 启用/登录/禁用与恢复码流程、刷新页面后的续传须由用户在可用浏览器环境确认。当前 Codex 内置浏览器访问 localhost 为 `ERR_BLOCKED_BY_CLIENT`，未重试，像素 QA 仍待办。
- **依赖安全门：** **Blocked/Pending**，详见“依赖审计快照”。不得在安全门解除或经独立风险接受前称为 Phase 2 发布验收/发布完成。

### Phase 3: 多入口传输

- [ ] 入口管理（public_base_url）
- [ ] 客户端探测与选路
- [ ] Nginx 配置生成（含 CORS）
- [ ] 跨入口授权与切换
- [ ] 入口限速
- [ ] 直链分享（302 + Token）

### Phase 4: 增强功能

- [ ] WebAuthn
- [ ] P2P 传输
- [ ] 临时码（完整功能 + 配额预留）
- [ ] 文件夹分享
- [ ] 统计面板

## 关键约束

### 安全约束

- 用户上传的 HTML/SVG/JS 强制 `attachment`
- 允许 inline 的 MIME 白名单：图片/视频/音频/PDF
- 必须设置 `X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: sandbox`
- 禁止 `Access-Control-Allow-Origin: *`
- 禁止在 URL 查询参数中传递密码或长期 Token

### SQLite 约束

- 禁用 `SELECT ... FOR UPDATE`（SQLite 不支持）
- 写事务中禁止文件 I/O 或网络请求
- 使用独立 sqlite3 连接执行 `BEGIN IMMEDIATE`；进程内事务入口串行排队，避免竞争连接的 busy wait 占满 libuv 工作线程并阻塞持锁事务
- 并发抢占使用条件 UPDATE

### 部署约束（2026-09-01 更新）

- **默认单进程模式**：`npm start` 监听 `0.0.0.0`，后端自托管前端，Nginx 非必需（ADR-0004）
- **Nginx 反代模式**：`npm run start:bynginx` 只监听 `127.0.0.1`
- 公网（FRP）部署建议 Nginx 模式：初始化端点可获得 Nginx 层本机限制；无 Nginx 时仅由一次性 Token 保护
- 生产环境必须设置 `JWT_SECRET`
- Nginx 模式下 Nginx 必须覆盖 `X-Entry-Id` Header（Phase 3 多入口）

### 上传部署不变量（2026-09-26 更新）

- 孤儿扫描依赖最终存储名和 owner token 均为 UUIDv4，并识别 `<stored UUID>.verify-<owner UUID>.tmp` 与旧版 `<stored UUID>.tmp`。不得擅改 staging 命名、UUID 格式或清理其他 owner 的临时文件。
- **混合版本并写不受支持。** 新旧版本不能同时操作同一 SQLite 数据库和 storage；升级时需先 drain/stop 全部旧进程，再启动新版本。DB lease 是 owner claim/fence，不是跨进程文件系统 CAS；旧版使用共享临时文件命名。

### 自动化验证边界

- Task14 显式运行 server unit：25 suites / 172 passed / 20 todo；完整 server E2E：9 suites / 83 passed；Web `npx vitest run --no-cache`：15 files / 131 passed；root `npm run typecheck`、`npm run build`、`git diff --check` 通过。
- 根 `CI=true npm test` 已实际运行：server 25 suites / 172 passed / 20 todo、Web 15 files / 131 passed，随后因 `packages/shared/package.json` 没有 `test` script 以 exit 1 结束；显式 shared workspace 同样返回 `Missing script: "test"`。不能把根聚合报告成全绿；server/Web 显式 no-cache 命令均独立 exit 0。
- Lint 复核：server 与 Web 的 `npm run lint` 都因找不到 `eslint` 可执行文件退出 1；shared 没有 `lint` script。Lint 状态是不可用，不是通过。

### 依赖审计快照（2026-09-26）

基于当前 `package-lock.json` 执行 `npm audit --json`（registry 返回的当日快照）：

| 范围 | Audit findings | Critical | High | Moderate | Low | direct / transitive | fix 建议（SemVer） |
|------|---------------:|---------:|-----:|---------:|----:|---------------------:|-------------------:|
| 全依赖 | 46 | 2 | 19 | 19 | 6 | 17 / 29 | 31 major，15 non-major |
| `--omit=dev` 生产依赖闭包 | 28 | 1 | 13 | 11 | 3 | 12 / 16 | 22 major，6 non-major |

`npm audit` findings 是当前锁文件/注册表 advisory 视图，不应与旧 Task 记录（例如 `npm install` 当时报告的 39 项）混为同一快照；Task14 不运行 `npm audit fix`，不做 dependency override 或大版本升级。

- **生产 Critical：`tar@6.2.1`，间接依赖。** 路径包括 `sqlite3@5.1.7 → node-gyp@8.4.1 → tar`、`sqlite3@5.1.7 → tar`，以及 `bcrypt@5.1.1 → @mapbox/node-pre-gyp@1.0.11 → tar`。当前代码引用 `tar.extract` 的位置在依赖安装器：node-gyp 解压 Node headers、node-pre-gyp 解压原生预编译包；仓库 `apps/server/src` 没有直接调用 `tar` 的 HTTP/API 路径。因此这是依赖安装/原生构建阶段的归档解包攻击面（包括依赖归档不可信/被篡改时的路径逃逸/覆盖/读取/拒绝服务风险），不是当前文件上传 HTTP 路径的直接 tar 调用。但它处于 production dependency closure，`npm audit --omit=dev` 仍报告 Critical，**security gate 仍 blocked/pending**。
- **Dev Critical：`vitest@1.6.1`。** Advisory 仅在 Vitest UI server 正在监听时可读取/执行任意文件；它不是生产 server 的 HTTP 依赖。当前 `test:ui` 是单独的开发命令，不应在不受信网络开放 UI server。Audit 建议 Vitest 5 主版本。
- **生产 High direct：** `@nestjs/platform-express@10.4.22`、`@nestjs/serve-static@4.0.2`、`bcrypt@5.1.1`、`sqlite3@5.1.7`。npm 给出的主要修复路线均为 major（Nest 12 / bcrypt 6 / sqlite3 6）；另有多项间接 High。
- npm 元数据显示 `sqlite3@6.0.1` 要求 Node `>=20.17.0` 且 peer `node-gyp@12.x`；仓库 root `engines` 目前仅声明 Node `>=20.0.0`。TypeORM `0.3.31` 的 `sqlite3` peerOptional 范围包含 `^5.0.3 || ^6.0.0`，但这不构成对新 native install chain、Node 最低版本或本项目迁移/运行测试的完整兼容证明。`bcrypt@6.0.0` 要求 Node `>=18`，但仍需验证 native install/build。建议另立安全修复任务，在升级 Node 最低版本后，先验证 sqlite3/bcrypt 新链路与迁移/全量并发回归；不要用 override 猜测绕过。
- `npm audit --omit=dev` 的 13 项 High 及其他 production advisories 仍需在后续安全任务逐项审查。当前 Task14 仅准确记录风险，没有修依赖；不能把 npm audit 说成通过。

## 文档引用

- **设计文档**: [docs/superpowers/specs/2026-07-28-filestation-design.md](superpowers/specs/2026-07-28-filestation-design.md)
- **Phase 1 实施计划**: [docs/superpowers/plans/2026-07-28-phase1-mvp-v1.7.md](superpowers/plans/2026-07-28-phase1-mvp-v1.7.md)（历史实现计划）
- **Agent 手册**: [AGENTS.md](../AGENTS.md)
- **架构决策**: [docs/adr/](adr/)
- **MCP 决策**: [ADR-0005](adr/0005-mcp-embedded-with-api-token.md)

## 待办事项

### Phase 2 后续

- 发布 security gate：另立安全修复任务，先评审并修复/单独接受当前 Critical/High npm audit advisory；Task14 未修改依赖。
- 用户手动验收：真实 MCP 客户端、375px 小屏/设备；TOTP 与恢复码流程；刷新页面后的上传续传。

### 待设计（Phase 3+）

- WebAuthn RP ID 配置策略
- P2P 传输协议细节
- 统计面板数据聚合策略
- 多入口部署下的 CORS 白名单生成

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| SQLite 并发性能 | 多用户上传下载时锁定 | WAL 模式 + 短事务 + busy_timeout；需要即时事务的进程内调用串行进入 |
| 大文件上传内存 | 分块合并时内存溢出 | 流式合并 + 临时文件 + fsync |
| FRP 配置复杂性 | 用户配置困难 | 提供 Nginx 配置生成器（Phase 3） |
| 无 Nginx 公网暴露 | 初始化端点少一层本机限制 | 一次性 Token 哈希存储 + 短有效期；文档建议公网用 Nginx 模式 |

## 变更日志

- **2026-07-28**: 项目初始化，设计文档 v2.2 完成，AGENTS.md 建立
- **2026-07-30**: Phase 1 实施计划经两轮外部评审迭代至 v1.7；MVP 实现完成
- **2026-07-31**: 浏览器端到端验证通过（初始化→登录→上传→分享→下载→文件夹全流程）；修复验证发现的 5 个 bug
- **2026-09-01**: Nginx 可选化（ADR-0004）：默认单进程模式托管前端，`start:bynginx` 保留反代模式；代码推送至 GitHub
- **2026-09-24**: Phase 2 API Token 管理、exchange 与 scope 授权落地；API token JWT 每次请求检查吊销状态，scope 从数据库读取
- **2026-09-25**: Phase 2 审计日志落地；关键认证/文件/分享/设置操作埋点，管理员分页查询，IP 匿名化与 90 天清理
- **2026-09-25**: Phase 2 内嵌 MCP 服务落地；默认关闭的无状态 Streamable HTTP 入口、11 个工具、逐工具 scope 与审计，上传总大小及分块上限
- **2026-09-25**: Phase 2 Web 设置页增加 API Token 签发/吊销与 MCP 配置，新增受保护的审计日志分页、过滤页面
- **2026-09-25**: Phase 2 TOTP 后端落地；AES-256-GCM 密文存储、管理员启停、单次挑战两步登录、强制 TOTP 防自锁与派生状态
- **2026-09-25**: Task 8 并发复修；即时事务连接独立于 TypeORM，并在进程内排队，避免 SQLite busy wait 导致的线程池饥饿
- **2026-09-25**: Task 9 TOTP 前端落地；登录两步验证、设置页启停、`totp_required` 开关与异步响应竞态保护
- **2026-09-25**: Phase 2 Task 10 恢复码后端落地；Argon2id 单次码、原子替换/消费、账户锁定、IP 限速与全会话吊销；复审待安排
- **2026-09-25**: Task 10 复审修复；原子预留恢复 IP 因子 admission，恢复码/会话替换同事务提交，覆盖不同有效码跨独立 SQLite 队列并发及 refresh 轮换；新增恢复端点 OpenAPI 契约与 `/api/docs` 文档
- **2026-09-26**: Task 10 第二轮复审修复；将恢复因子 IP admission 改为有 TTL 的逐请求持久 reservation，成功仅结算自身并保留其他在途请求，过期/异常释放有持久失败语义；全量验证通过，等待独立复审
- **2026-09-26**: Task 10 第三轮复审修复；IP 冷却到期后在新 admission 前重置历史失败计数，但仍将未过期 reservation 计入并发上限；TTL 结算先归一过期窗口再结算本批失败，达到阈值时正确重新锁定
- **2026-09-26**: Task 10 第三轮修复获独立复审 APPROVED（提交 `3c9d7a1`）；记录非阻断性能观察：恢复 IP reservation 的 `system_meta` GLOB 扫描为 O(N)，后续可按实际负载评估专表/索引
- **2026-09-26**: Phase 2 Task 11 恢复码前端实现；新增设置页一次性生成/展示/复制/下载与统一错误提示的登录恢复模式；Web 12 files / 86 passed、Recovery E2E 12 passed、typecheck/build 通过。IAB localhost 阻塞未重试，桌面/移动像素验收待有可用浏览器环境补做；独立复审待安排
- **2026-09-26**: Phase 2 Task 11 首轮复审修复；生成请求 pending 时保持单飞并阻止取消/再次提交，添加 beforeunload 防误离开提示；认证 pending 时锁定登录模式切换，避免 HttpOnly refresh cookie 已设置但前端丢弃 token 响应；TOTP 启停成功后父页立即同步派生状态并保留 totp_required 草稿。Web 12 files / 91 passed、Recovery 与 TOTP E2E 各 12 passed、typecheck/build 通过；当时记录的 SPA 页面卸载风险已由下一条的应用级 Provider 消除，断网、整页关闭/卸载或进程终止时仍有协议级结果送达风险
- **2026-09-26**: Phase 2 Task 11 第二轮复审修复最终获独立审阅 APPROVED（无 Critical/P1/P2；实现提交 `d0e0f4f`）；RecoveryGenerationProvider 放在 App/BrowserRouter 之间，生成锁、一次性结果与错误跨 React Router 页面卸载保留，至用户明确确认已保存后才从内存清除。Web 12 files / 92 passed、Recovery 与 TOTP E2E 各 12 passed、typecheck/build 通过，lint 不可用；整个 App/页面关闭、崩溃或网络中断时仍有接口协议级结果送达风险，为非阻断项；像素视觉 QA 待可用浏览器环境补做
- **2026-09-26**: Phase 2 Task 12 断点续传 UI 完成首轮实现；FileUpload 在 StrictMode/卸载下隔离过期状态探测，按服务端 GET/resume 契约恢复并跳过已收分块，localStorage 不可信数据与 quota/禁用异常安全处理，明确终态才清理，放弃请求携带上传 token；Web 15 files / 124 passed、uploads resume E2E 3 passed、root typecheck/build 通过；lint 因仓库未安装 ESLint 不可用；已知 IAB `ERR_BLOCKED_BY_CLIENT` 不重试，视觉待有可用浏览器环境补做，独立复审待安排
- **2026-09-26**: Task 12 首轮复审修复：API GET/POST/PUT/DELETE 支持向后兼容的可选 AbortSignal；组件卸载终止探测及上传/恢复/放弃请求，旧分块循环在中止后立即停止；服务端可能已提交但浏览器响应中止时保留续传记录并由重挂载 GET 对账；恢复文件选择器隐藏于键盘/读屏导航，仅由“继续上传”按钮触发。Web 15 files / 131 passed、uploads resume E2E 3 passed、root typecheck/build 通过；最终独立复审待安排
- **2026-09-26**: Task 12 最终独立复审 APPROVED（提交 `e4478c6`；无 Critical/P1/P2）。复审修复后 Web 15 files / 131 passed、uploads resume E2E 3 passed、server 单测 25 suites / 167 passed，typecheck/build/diff-check 通过。接受的非阻断限制：请求中止不能撤销服务端已接收的分块/完成操作，已知 session 可由重挂载 GET 对账；初始化响应在返回 upload id/token 前丢失可能留下不可由浏览器恢复的孤儿 session；真实浏览器文件选择器视觉/交互验收受 IAB localhost `ERR_BLOCKED_BY_CLIENT` 限制，未重试。
- **2026-09-26**: Phase 2 Task 13 并发/压力 E2E 完成；新增 HTTP 并发覆盖：10 路下载在 `max_downloads=2` 下严格为 2×200/8×410 且 used=2、同上传 5 路 complete 返回同一 file_id 且只创建一行 file、同 part 不同字节恰一方成功并读回获胜字节，以及 5 个不同 upload session 的 part/complete 并行回归。RED 暴露 TypeORM SQLite QueryRunner 共享连接事务错乱：下载 quota count 出现 5xx，complete stage 1/3 在并发时分别出现事务状态错误和外键错误；相关短写事务改用独立 SQLite `BEGIN IMMEDIATE` 队列，文件 I/O 仍在事务外，同 session complete loser 在提交后等待 durable completed 状态。并发 E2E 连续 3 轮通过；server 单测 25 suites / 167 passed / 20 todo、完整 E2E 8 suites / 71 passed、Web 15 files / 131 passed，root typecheck/build 与 `git diff --check` 通过。Lint 不可用（server/web 缺少 ESLint，共享包无 lint 脚本）；Task 13 独立复审待安排。
- **2026-09-26**: Task 13 首轮复审修复：HTTP/Storage barrier 断言真实参与数；同 upload losers 改用每进程单一指数退避 observer（250ms→5s）和不随 heartbeat 延长的 15 分钟 hard deadline，支持客户端断连与模块销毁取消；FileLifecycle verifying recovery 改用显式 camelCase SQL aliases、独立立即事务与 `.changes`，新增五个恢复场景；part claim/ready 也迁入独立立即事务，并以 `.changes===1` 保护一次性 received_size 更新。并发/recovery/folder E2E 连续 3 轮各 12 passed；完整 server unit 25 suites / 171 passed / 20 todo、E2E 9 suites / 77 passed、Web 15 files / 131 passed，root typecheck/build/diff-check 通过。Lint 仍不可用；第二轮独立复审待安排。
- **2026-09-26**: Task 13 第二轮复审修复（提交 `b5c262c`）：normal complete 与 FileLifecycle recovery 共用 owner-guarded 独立 SQLite heartbeat，覆盖完整 stage2 至 stage3 提交；renew 必须命中未过期 lease 与当前 owner，失权会 abort combine/hash 并阻止 rename/finalize，模块销毁及异常路径清理 heartbeat。新增短 lease + 可控 I/O gate 的跨 lease/独立 lifecycle 竞争、恢复与正常 complete owner replacement 不发布回归。Focused concurrency/recovery/folder E2E 连续 3 轮各 16 passed；server unit 25 suites / 172 passed / 20 todo、全量 E2E 9 suites / 81 passed、Web 15 files / 131 passed，root typecheck/build/diff-check 通过。Lint 不可用（server/web 缺少 ESLint，shared 无 lint script）；等待最终独立复审。
- **2026-09-26**: Task 13 第三轮复审修复：RED 用真实 `StorageService.combineParts` 和两个独立 FileLifecycle/SQLite immediate transaction 实例复现旧 owner abort cleanup 删除 replacement 的共享 `<stored>.tmp`，改为 `<stored>.verify-<owner UUID>.tmp` owner 专属 staging；合并后通过 heartbeat 立即续租并再次 owner-guard，再原子 rename 发布，失败只 unlink 自身 staging。启动孤儿扫描保护匹配 token 且 lease 未过期的 staging，清理过期 owner staging 与旧版 `<stored>.tmp`；旧版无 lease 行按 5 分钟 legacy 窗口保护。另将 VerifyLeaseError('lost') 映射回 HTTP 409 `UPLOAD_FINALIZE_LOST`，仅 request 已 abort 时把 cancelled 变为可由 Controller 吞掉的 AbortError。三项新/收紧回归均先 RED 后 GREEN；focused concurrency/recovery/folder E2E 连续 3 轮各 18 passed，server unit 25 suites / 172 passed / 20 todo、全量 E2E 9 suites / 83 passed、Web 15 files / 131 passed、root typecheck/build/diff-check 通过。Lint 不可用；滚动升级不应让未升级旧进程与新版本并行写同一 DB/storage，部署时先停止旧进程，避免旧版共享临时路径和非原子 owner fence 窗口。
- **2026-09-26**: Task 13 最终独立复审 APPROVED（无 Critical/P1/P2），批准代码提交 `414aa1e8e34ff37e6bcce8882d0eab02e6053cde`。最终验证记录：focused concurrency/recovery/folder E2E 连续 3 轮各 18 passed；server unit 25 suites / 172 passed / 20 todo；server E2E 9 suites / 83 passed；Web `npx vitest run --no-cache` 15 files / 131 passed；root typecheck/build 与 `git diff --check` 通过。测试中的 owner-loss AbortError/被拒 complete 与 MCP `request entity too large` 是回归用例预期日志；默认 Web Vitest 在 131 项均通过后写 cache 遇 EPERM，`--no-cache` 全量复跑 exit 0。孤儿扫描依赖不变量：final stored name 与 owner token 均保持 UUIDv4，才能匹配 `<stored UUID>.verify-<owner UUID>.tmp` / legacy `<stored UUID>.tmp` 并回收孤儿。部署残余边界：新旧版本不能同时对同一 DB/storage 做 finalization，升级前先 drain/stop 旧进程；数据库 lease fence 不是跨进程文件系统锁。
- **2026-09-26**: Task 14 文档收尾更新设计 v2.3、ADR-0005、Agent 手册与 README；补充 Task13 混合版本部署硬限制、UUID staging 不变量、Phase2 用户验收 pending 和 npm audit gate。文档变更后 server unit 25 suites / 172 passed / 20 todo、完整 E2E 9 suites / 83 passed、Web no-cache 15 files / 131 passed、typecheck/build/diff-check 通过；根 `CI=true npm test` 最终因 shared 缺少 `test` script exit 1，lint 因无 ESLint 无法运行。npm audit 当前快照 46 findings（production 闭包 28，含 Critical `tar@6.2.1`），未运行自动修复/大版本升级；发布 security gate 与真实 MCP/375px/TOTP-recovery/刷新续传手动验收均仍 pending，未宣称 Phase2 发布验收完成。

---

*此文档每次功能变更后必须更新*
