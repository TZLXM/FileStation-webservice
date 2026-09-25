# Task 10 实施报告：恢复码后端

## 结果

- 新增 Argon2id 恢复码生成/验证与 DTO，管理员端要求当前密码；账户激活 TOTP 时还要求有效的一次性 TOTP。每次生成 10 个 50-bit Crockford Base32 码，响应只返回一次，存储仅含 Argon2id 哈希，有效期为生成组发布时起 24 小时。
- 重新生成在全部哈希完成后，通过一个独立即时 SQLite 事务作废旧未用组并插入完整新组；插入失败会回滚删除。实际验证了并发生成最终只发布一个完整组，以及注入 SQLite 插入错误后旧组完整可用。
- 公开验证统一去除连字符/空白并转大写；最多进行 10 次 Argon2id 比较，未命中位置不提前返回。比较在写事务外完成；最终事务以当前提交时刻再次检查锁定及到期状态，条件更新抢占一次性码，并在同一事务吊销账户所有活跃会话、清失败计数。
- 账户连续 5 次失败锁 15 分钟；同用户名验证在进程内串行，跨进程由 `BEGIN IMMEDIATE`、事务内重读和条件 UPDATE 保证失败计数与一次性消费正确。没有使用 TypeORM 共享 QueryRunner 执行这些原子操作。
- `AuthService` 复用现有 IP 节流；恢复成功后清除该 IP 失败状态并签发新会话。管理员生成端点使用 `JwtAuthGuard` 与 `AdminOnlyGuard`；公开验证端点设置 refresh cookie，不在响应中回显提交的恢复码。
- 未新增数据库迁移；初始 schema 已包含 `recovery_codes`。唯一新增生产依赖为计划要求的 `argon2`。

## TDD 与验证

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
