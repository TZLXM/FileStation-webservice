# Task 10 实施报告：恢复码后端

## 结果

- 新增 Argon2id 恢复码生成/验证与 DTO，管理员端要求当前密码；账户激活 TOTP 时还要求有效的一次性 TOTP。每次生成 10 个 50-bit Crockford Base32 码，响应只返回一次，存储仅含 Argon2id 哈希，有效期为生成组发布时起 24 小时。
- 重新生成在全部哈希完成后，通过一个独立即时 SQLite 事务作废旧未用组并插入完整新组；插入失败会回滚删除。实际验证了并发生成最终只发布一个完整组，以及注入 SQLite 插入错误后旧组完整可用。
- 公开验证统一去除连字符/空白并转大写；最多进行 10 次 Argon2id 比较，未命中位置不提前返回。比较和 token/session 准备均在写事务外完成；最终事务以当前提交时刻再次检查锁定及到期状态，条件更新抢占一次性码，并在同一事务吊销账户所有活跃会话、插入本次 prepared session、清理账户/IP失败状态。
- 账户连续 5 次失败锁 15 分钟；同用户名验证在进程内串行，跨进程由 `BEGIN IMMEDIATE`、事务内重读和条件 UPDATE 保证消费及失败计数线性化。另用独立 RecoveryService/事务队列的真实 SQLite 测试覆盖不同恢复码并发，不依赖单实例的内存队列。没有使用 TypeORM 共享 QueryRunner 执行这些原子操作。
- `AuthService` 在用户名查找及 Argon2 之前，以独立即时事务原子预留共享 IP 槽；失败保留计数，成功在恢复消费/旧 session 撤销/新 session 插入事务中清除 IP 状态。refresh cookie 哈希与 prepared session 一致，JWT 的 `sub`/用户名与该 session 账户一致；保持现有无 `session_id` claim 的 admin JWT 形状，未改造全站 access-JWT 撤销语义。
- 管理员生成端点使用 `JwtAuthGuard` 与 `AdminOnlyGuard`；公开验证端点设置 refresh cookie，不在响应中回显提交的恢复码。新增 `@nestjs/swagger` 7.4.2 与 OpenAPI bootstrap，仅完整注解两个 Task 10 端点及其 DTO/响应；现存非 Task 10 控制器端点本轮不扩展注解范围，Swagger 文档初始化后也会列出这些旧路由但契约完整度留待对应任务补齐。
- 未新增数据库迁移；初始 schema 已包含 `recovery_codes`。本轮新增生产依赖 `@nestjs/swagger` 7.4.2；Task 10 初始轮另新增计划要求的 `argon2`。

## 初始实施轮 TDD 与验证记录

- RED：新增服务测试最初 7 项均因 `RecoveryService` 缺失而失败；AuthService 新增 4 个 IP 防线测试在原有 22 项通过的同时失败；新增 E2E 在控制器尚未接线时因路由 404 失败。随后实现并转绿。
- 服务单测覆盖格式/数量/哈希/24h、密码及 TOTP、旧组替换、替换事务失败回滚、并发生成只发布单组、归一/单次消费/会话吊销、过期和比较期间过期、5 次锁定及第 6 次拒绝、并发同码只成功一次。新增 AuthService 测试覆盖 IP 前置节流、失败计数及成功清理/签发。
- 最终 server 单测：25 suites，157 passed、20 todo。
- 最终完整 server E2E：6 suites、58 passed；包括新恢复码 E2E 6/6。测试过程中 body-parser 对已有超大请求用例打印预期 `request entity too large` 日志，该用例和整套 E2E 均通过。
- Web Vitest：11 files、65 passed。
- 根目录 `npm run typecheck`：server/web/shared 全部通过。
- 根目录 `npm run build`：shared、server、web 全部通过。
- `git diff --check`：通过（提交前将对 stage 中的精确文件再次检查）。
- `npm run lint`：不可运行；server 与 web 的脚本提示找不到 `eslint`，shared 无 lint script。按范围未安装额外 lint 工具链。

## 裁定与限制

- SQLite 的替换、失败计数、恢复码抢占及会话撤销均复用 Task 8 独立连接 `SqliteImmediateTransactionService`。Argon2id 与 bcrypt/TOTP 校验不在写事务内运行。验证期间过期边界测试推动最终事务使用当前时间，而非 Argon2 比较开始时刻。
- 进程内按用户名队列牺牲同账户恢复尝试的并行延迟，以保证本实例的 5 次失败顺序；跨进程依靠 SQLite 写事务串行化和事务内重读。多进程部署时 SQLite 文件锁是最终互斥保障。
- 安装 `argon2` 后 npm audit 显示 38 项既有依赖发现（6 low、14 moderate、17 high、1 critical）；未进行与 Task 10 无关的依赖升级。
- 测试夹具、日志、审计事件和本报告不包含明文恢复码、密码、TOTP 或 Token。

## 提交与审阅

- 实施提交：随 Task 10 范围使用中文 Conventional Commit 提交；具体 commit id 在交接消息中提供。
- 独立复审：由父任务安排 GPT-5.6 Sol / medium；本实施任务不自行选择审阅模型。

## 独立复审修复轮次

- 复审结论：REJECTED。确认的两项 P1 为同 IP admission 的读/失败计数非原子，及恢复码消费/旧 session 撤销与新 session 插入处于不同线性化点；另有 P2 为新端点缺 Swagger 契约且项目未安装 `@nestjs/swagger`。
- RED：同 IP 的 11 个不同用户名请求被 gate 在恢复 verifier 时，旧实现没有任何 IP_THROTTLED 响应且 11 项因子工作全进入；在第一个不同有效码消费后挂起 AuthService，第二个有效码完成后旧实现留下 2 个活跃 session；`/api/docs-json` 返回 404。三项均为实现前失败证据。
- 修复：IP 槽在 Argon2 前 `BEGIN IMMEDIATE` 预留；verified code 的消费、旧 session 撤销、预制新 session 插入和 recovery/IP failure 清理现在同事务提交，cookie/token 只在成功提交后返回。测试也实际证明旧 refresh cookie 401、最终 winner cookie 可 refresh 并正确轮换 session。
- 并发覆盖：增加两个独立 `RecoveryService` 与两个独立 SQLite 事务队列对不同有效码的竞态，证明最终只留一个活跃 session；注入新 session INSERT 失败，确认旧 session、未用码及 IP 错误状态均因事务回滚保留。
- Swagger裁定：引入与 Nest 10 peers 兼容的官方 `@nestjs/swagger@7.4.2`，公开 `/api/docs`、`/api/docs-json`，仅为两个新增恢复端点完整添加 auth tag、鉴权、状态码、输入与响应 schemas；本轮不扩展所有历史 controller 的 annotations，旧路由虽然列入全局文档但需后续各自任务补契约。
- token 语义裁定：现有 admin JWT schema/strategy 不含或校验 session id；本轮令 JWT 主体、refresh cookie 哈希及新 session account/id 由同一预备材料产生，不只为 recovery 新 token 引入失效不一致的 `sid` claim。访问 JWT 的现有 stateless 过期语义未扩展。
- fix-round 完整验证：server 单测 25 suites / 159 passed / 20 todo；完整 server E2E 6 suites / 61 passed（含恢复码 9/9）；Web Vitest 11 files / 65 passed；根目录 `npm run typecheck` 与 `npm run build` 通过；`git diff --check` 通过。
- lint 复核仍不可运行：server/web 缺少 `eslint` 可执行文件，shared 无 lint script；没有安装 lint 工具链。为 Swagger 安装时 npm 报告当前依赖树有 39 项 audit findings（6 low、15 moderate、17 high、1 critical）；未运行 audit fix 或扩展升级。
- `.claude/settings.local.json` 与未跟踪 Phase 2 计划保持未暂存；fix-round 提交 id 在交接消息中报告。

## 独立复审修复轮次 2

- 新增 P2 核实：成立。RED 使用真实 SQLite 与可控 gate 暂停不同用户名 A 的恢复验证，在同 IP 下让 admin/B 成功消费另一个有效码，再放行 A 的错误码。旧实现中 B 成功删除整个 `login_ip_<ip>`，A 之后仅更新账户失败状态；新回归断言应存在 IP `failed_count:1`，实现前失败证据是查询结果为空。
- 最小修复裁定：历史失败继续使用既有 `login_ip_<ip>` JSON（`failed_count`/`delay_until`），每个恢复请求另有 `login_ip_reservation_<uuid>` 持久行，保存 IP 与五分钟租约。该方案复用 `system_meta`，不新增迁移、不依赖进程内 Map；预留计数由独立 `BEGIN IMMEDIATE` 事务按“历史失败 + 未过期 reservations”原子计算，适用于多个 SQLite transaction queue/进程。
- 成功时只在恢复码 claim、旧 session 撤销、新 session 插入的既有原子事务里消费当前 request id 并清历史 IP 失败行；其他在途 reservation 不删除。失败/运行时异常会删除自己的 reservation 并把失败累计到当前历史状态；若进程崩溃，五分钟 lease 到期后按失败结算，后台每分钟清理并在后续 reserve/settlement 中懒清理；过期 request 在最终事务验证 reservation 后会被拒绝，不能消费有效码。若异常结算数据库暂时不可用，也由 lease 清理兜底。
- 兼容性：普通密码登录和 TOTP 继续使用相同的 `login_ip_<ip>` 历史状态与既有精确 key 清理行为；新 reservation 使用独立 key，不被这些 legacy 清理覆盖。恢复成功也只删自己的新 reservation，不覆盖其他请求。没有扩大既有普通登录/TOTP 的限流算法或调整其 payload 格式。
- 新增覆盖：真实 SQLite gate E2E 验证 B 成功后 A reservation 仍在、IP history 已清，再放行 A 失败后 history 重新成为 1；注入 verifier infrastructure error 后 IP failure 持久为 1 且无残留 reservation；真实 SQLite 过期测试验证迟到的有效码被拒绝、码不消费且租约变失败；两个独立 SQLite transaction queue 并发 11 次 reserve，恰好允许 10 次。
- 完整验证：server unit 25 suites / 163 passed / 20 todo；full server E2E 6 suites / 63 passed；Web Vitest 11 files / 65 passed；root typecheck/build 与 `npx vitest run --no-cache` 通过。`npm run lint` 仍不可运行：server/web 缺少 ESLint 可执行文件，shared 没有 lint script。旧 E2E 的 body-parser 超大请求日志仍属预期测试输出。`git diff --check` 将在提交前对精确暂存文件复核。
- 提交与审阅：本修复轮仅提交 Task 10 相关源代码/测试/台账/CURRENT-STATE；保留 `.claude/settings.local.json` 和未跟踪 Phase 2 计划。commit id 在交接消息报告，并请父任务安排独立复审。

## 独立复审修复轮次 3

- 新增 P1 核实：成立。真实 SQLite RED 在 `delay_until` 已过去、历史 `failed_count=10` 时仍返回 30 秒并拒绝新 reservation；有 8 个活跃 reservation 时，5 个到期冷却 admission 全部被挡（本应只允许剩余 2 槽）；同批 10 个 TTL reservation 到期后，旧实现把已过期窗口 10 次失败与本批 10 次失败叠加为 20，顺序不符合既有 IP 冷却语义。Recovery E2E 通过真实 AuthService/SQLite 调用有效码，也复现 `IP_THROTTLED`。
- 最小修复：新增冷却到期归一逻辑，历史失败计数归零并清 `delay_until`，但 reservation 仍单独持久化并照常占并发槽。admission 在任何槽位计算前归一并持久化；失败结算也在累加本次失败前归一，确保过期冷却后从新窗口重新计数。批量 TTL 结算则先归一旧窗口、再增加本批过期 reservation 失败并判断阈值，因此达到 10 次时会新建冷却，而不是归一后误放行。
- 顺序/竞态覆盖：真实 SQLite 测试以 8 个有效 reservation 和两个独立 transaction queue 同时发起 5 个 admission，严格得到 2 个获准、3 个受限；10 个同批过期 reservation 测试断言归一后失败计数为 10 且新冷却已设置。另测冷却过期后的有效恢复登录成功并清旧 IP 失败状态，以及新窗口内一次失败从 1 计数、旧冷却后续状态已清除。未改变 success-before-failure：成功仍只删除自己的 reservation 并清历史失败，其他在途请求保留并可在失败或 TTL 时结算。
- TDD：新增的三项单元 RED 均重现目标行为错误；新增 Recovery E2E 在有效码路径上因 `IP_THROTTLED` 失败。实现后针对性 unit 20/20、Recovery E2E 12/12 全绿。
- 第三轮完整验证 GREEN：server 单测 25 suites / 167 passed / 20 todo；full server E2E 6 suites / 64 passed；Web Vitest 11 files / 65 passed；root `npm run typecheck`、`npm run build` 通过。`npm run lint` 仍无法运行：server/web 缺 ESLint 可执行文件，shared 无 lint script；未额外安装 lint 工具链。E2E 中既有 body-parser 超大请求测试打印预期 413 日志，套件仍通过。提交前对精确范围运行 `git diff --check`。
- 本轮提交仅包含 IP reservation helper、相应 unit/E2E 测试、本报告、进度台账与 `CURRENT-STATE.md`；保留 `.claude/settings.local.json` 与未跟踪 Phase 2 计划，不开始 Task 11。commit id 在 handoff 报告，并由父任务安排 GPT-5.6 Sol / medium 独立复审。

## 最终独立复审结论

- GPT-5.6 Sol 对第三轮修复最终 APPROVED，无 Critical、P1 或 P2 finding；批准实现提交 `3c9d7a1`。
- 残余非阻断性能风险：reservation 查找/TTL 回收当前使用 `system_meta` 的 `GLOB` 查询，扫描成本随元数据行数增长（O(N)）；五分钟 reservation lease 限制单条记录的驻留时间，但高请求量仍可能增加扫描成本。后续如规模需要，可单独评估专用 reservation 表及索引，本轮不扩大 schema/功能范围。
- 当前 Task 10 实现、回归测试及独立复审均已完成；以上性能观察不阻塞交付。保留 `.claude/settings.local.json` 与未跟踪 Phase 2 计划。
