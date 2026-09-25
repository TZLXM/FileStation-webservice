# Task 10 — 恢复码后端

## 基线与执行

- 基线：`19386c1`（Task 9 最终审阅记录）
- 实施：GPT-6 Luna / max
- 审阅：由父任务安排 GPT-5.6 Sol / medium；此任务不自行挑选审阅模型
- 计划：`docs/superpowers/plans/2026-09-19-phase2-reliability-agent-mobile.md` Task 10
- 台账：沿用 `.superpowers/sdd/`

## 目标

- 管理员以当前密码及已启用时的 TOTP 生成 10 个 Crockford Base32 恢复码；明文只随生成响应返回一次。
- 数据库仅存 Argon2id 哈希；恢复码展示格式为 `XXXX-XXXX-XX`，熵 50 bit，有效期 24 小时。重新生成原子作废旧未用码并只发布完整新组。
- 公开验证端点统一归一大小写/连字符/空格；AuthService 在因子计算前生成待发 token/session 材料，恢复码消费、旧 session 吊销、新 session 插入及失败状态清理在同一个独立即时事务中提交，之后才返回 token。
- 账户维度连续 5 次失败锁 15 分钟；IP admission 在因子计算前使用即时事务原子预留一个共享槽，失败保留计数，成功在 session 替换事务内清理；同一 IP 不能并发绕过上限执行 Argon2。
- 增加完整 DTO、模块注入、公开/管理端点、两个新端点的 Swagger/OpenAPI 契约，以及跨独立事务队列并发和真实 SQLite E2E 覆盖。

## 关键约束

- 哈希与密码验证绝不在 SQLite 写事务中运行。
- 复用 `SqliteImmediateTransactionService`，禁止使用 TypeORM 共享 QueryRunner 执行跨请求原子操作。
- 重验账户锁、恢复码未消费/未过期条件；消费、全部旧 session 撤销和 prepared session 插入必须在一个独立即时事务中完成。
- 审计只记录操作与匿名化 IP，不记录任何明文恢复码、哈希或密码。
- 只修改 Task 10 范围，更新 `CURRENT-STATE.md` 和本台账；保留 `.claude/settings.local.json` 与未跟踪计划文件；不开始 Task 11。

## 验收

- RED → GREEN 测试覆盖生成格式/数量/哈希/期限、重发作废、密码与 TOTP、归一、过期、一次性消费、会话撤销/替换与 refresh 行为、账户锁、跨用户名 IP 因子 admission、DTO/Guard/OpenAPI 契约、同/不同码并发与并发生成原子性。
- server 全单测、完整 server E2E、Web 必要回归、root typecheck/build、`git diff --check`。
- lint 若仍因 ESLint 可执行文件缺失而不可运行，记录现状，不额外安装工具链。
- 仅提交 Task 10 文件，使用中文 Conventional Commit 与实际实施模型 trailer。
