# Task 8 实施报告：TOTP 后端与两阶段登录

## 实施内容

- 增加 AES-256-GCM TOTP secret 密文封装，数据库只保存带版本前缀的密文；解密/格式错误采用不暴露输入内容的失败处理。
- 增加 TOTP setup、confirm、disable 和激活码验证；启用/停用审计只写操作类型与账户标识，不写认证材料。
- 密码验证成功后按是否激活 TOTP 返回 token 或短时一次性挑战；公开二次验证端点在条件 UPDATE 原子抢占挑战后才校验并签发会话。挑战错误、过期、类型不匹配或重放均不签发 token；IP 限速仍在验证入口生效，TOTP 错误纳入账户与 IP 失败计数。
- 增加管理员 TOTP 路由与 DTO 校验；管理员 Guard 拒绝 API-token principal。
- 安全设置从激活器表派生 `totp_active`；控制器和服务都剥离此只读值。无激活器时拒绝设置 `totp_required=true`，避免配置自锁。
- 账户与 IP 失败计数使用短 `BEGIN IMMEDIATE` 事务内读-增-写，避免并发丢失更新；挑战已消费后，在该事务内重新检查并预留尝试配额，阈值外的并发请求在校验因子前拒绝。TOTP 时间步消费、计数清理和 refresh session 哈希插入也在同一事务完成。设置强制与停用删除同样串行化，避免留下“强制但无激活器”。
- 即时事务使用与 TypeORM Repository 隔离的 sqlite3 连接；同一进程内的事务在打开连接和执行 `BEGIN IMMEDIATE` 前排队，避免并发 busy wait 占满 libuv 工作线程、让持锁事务无法继续。
- 使用 otplib 12 `checkDelta` 精确识别当前或相邻 30 秒 counter；以现有 `last_used_at` 保存已消费 counter 的起始时间，并通过 `(last_used_at IS NULL OR last_used_at < ?)` 条件更新原子拒绝同 counter 重放，无需改表或迁移。该字段对 TOTP 表示 counter 起始时间，对 WebAuthn 保持原 last-use 时间语义。
- 未实现 Task 9 前端。

## TDD 与验证

- Cipher：先运行新测试确认因实现缺失而 RED，随后 3/3 GREEN。
- TOTP 服务：先 RED，完成后加密、窗口 current/adjacent counter 一次性消费与并发消费用例均 GREEN；与 AuthService / Settings 一共 3 个相关单测文件 38/38 通过。
- Settings：先 RED（派生状态缺失、写入守卫和控制器剥离缺失），完成后 8/8 GREEN。
- TOTP E2E：实现前新路由/流程测试 RED；完成后 `npm run test:e2e --workspace=@filestation/server -- --runInBand test/totp.e2e-spec.ts` 通过，12/12。
- 额度中断后的复修先以默认工作线程配置稳定复现 `SQLITE_BUSY`：六个并发错误挑战中四个返回 500，八个并发同时间步验证也失败。修正后的诊断显示，持锁事务首条 `SELECT value FROM system_meta WHERE key = ?` 耗时约 5.5 秒，后续同事务查询/写入为 0–2ms；失败栈位于 `AuthService.reserveTotpAttempt` → `SqliteImmediateTransactionService.run` → `BEGIN IMMEDIATE`。仅作诊断将 `UV_THREADPOOL_SIZE` 提至 16 后，TOTP E2E 12/12 通过，确认是多个 sqlite3 busy wait 占用 libuv 工作线程、延迟持锁连接后续 SQL。没有改变超时或加入重试。
- 新增真实 SQLite 并发事务回归测试：修复前 RED（`SQLITE_BUSY`，8 个即时事务竞争）；加入进程内排队后 GREEN，事务隔离单测 3/3、默认线程池 TOTP E2E 12/12。
- 复审补强：新增账户锁定时拒绝旧挑战、强制 TOTP 禁止停用最后激活器、并发限额、强制设置/停用竞态、跨挑战 OTP 重放及同 counter 并发消费 RED→GREEN 覆盖。6 个并发错误挑战先复现锁定被延迟失败清除及超额请求进入 OTP 校验；修复后只允许阈值内校验。跨挑战重放测试先复现同码可签发第二组会话，修复后第一个消费成功、同 counter 后续挑战均拒绝；另以 8 个并发真实 SQLite 服务校验确认只一个成功。
- 本轮最终验证：server 24 suites 全部通过（143 passed、20 todo）；web 10 files / 50 passed；完整 server E2E 5 suites / 52 passed；`npm run typecheck`、`npm run build` 和 `git diff --check` 均通过。根目录 `npm test` 在 server 与 web 测试通过后因 `@filestation/shared` 缺少 `test` script 以非零退出；分别运行 server、web workspace 测试均以退出码 0 完成。
- 之前的代码复审验证记录为相关单测 6 个 suite / 47 项通过、完整 server E2E 5 个 suite / 52 项通过；本轮新增并发队列由新回归测试及上述全量验证覆盖。
- `npm run lint`：未能运行，当前环境未安装 ESLint（server 与 web 均提示 `eslint` 不可识别；shared 也没有 lint 脚本）；按要求未安装额外工具。

## 依赖与裁定

- 新增依赖仅为计划中的 `otplib`、`qrcode`、`@types/qrcode`。
- `otplib` 锁定在 12.x（实际安装 12.0.1）：首次解析的 13.5.0 在现有 CommonJS Jest 环境加载 ESM-only `@scure/base` 时、进入断言前即失败；采用可兼容的 12.x 局部实例配置，避免共享 singleton options 污染并行测试。此裁定已记入 `.superpowers/sdd/progress.md`。
- npm 安装报告 38 项依赖审计发现（6 low、14 moderate、17 high、1 critical）；未做越界升级。

## 数据与隐私

测试输出、审计、日志、错误响应和本报告均未记录 TOTP secret、二维码内容、验证码、密码、登录挑战或完整 token。测试使用临时数据库与测试凭据。
