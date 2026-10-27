# Current State

Updated: 2026-10-28

FileStation 是一个私有文件传输站 Web 应用。**Phase 1 MVP 与 Phase 2 实现/自动化验证已完成；security fix commit `7a5ba50` 经最终独立复审 APPROVED。最近一次成功 registry audit 快照中依赖 Critical/High 已清零，但 Phase 2 发布验收仍 pending。** 代码测试通过不能替代用户手动验收；该快照仍有 Moderate/Low advisories，续作时的 registry 刷新未获网络权限。

## 项目状态

| 方面 | 状态 |
|------|------|
| 设计文档 | v2.3 as-built 更新；Phase 1 实施计划迭代至 v1.7（经两轮外部评审） |
| 项目管理 | AGENTS.md 已建立 |
| 代码实现 | Phase 1 MVP 完成；Phase 2 TOTP 两步认证、恢复码、API Token、审计、MCP 与断点续传已实现；Task 2 已落地 `0.2.0` 版本同步、双语发布说明、RFC 8785/Ed25519 manifest、可重定位原生制品、候选/签名/tag workflow 与固定公钥 fail-closed 占位；Task 3 已统一根路径与 `/fs/` 子路径的 Web URL 派生；Task 4 新增 Node-only `@filestation/update-core@0.2.0` 的严格签名 manifest、stable 选版、官方 Release 有界读取与真实 ZIP/tar.gz handle-bound 校验/解压；Task 5 新增 `@filestation/updater@0.2.0` 的校验和追加 journal、owner/recovery fencing lock、boot/process identity、durable filesystem、current 切换与按实际卷聚合空间预算 |
| 自动化 | Task 5 fix round 1/5 updater 7 suites / 59 passed / 2 skipped（本机 Windows 跳过 POSIX symlink 切换与真实 Linux `/proc` 分支）；release tools 45/45；server unit 25 suites / 172 passed / 20 todo；full E2E 10 suites / 85 passed；Web no-cache 17 files / 186 passed；root shared → update-core → updater → server → web typecheck/build 退出 0，updater 与 update-core dist 均存在。本机真实 Win32 write-through、`FlushFileBuffers`、junction 三阶段切换、CIM boot/process identity、卷 ID 与 ACL 用例通过。Task 4 update-core 历史结果为 6 suites / 92 passed / 1 skipped（Windows 文件 symlink 权限不足）。Lint 不可用；根 `npm test` 仍因 shared 缺少 `test` script 非零退出 |
| 用户手动验收 | **Partial**：真实 MCP 客户端已通过 `server_info`、上传、列表、分享、浏览器下载/读回、审计查询及 Token 吊销；直接 MCP `download_file` 工具当前不存在。375px 小屏、TOTP/恢复码真实流程及页面刷新后的断点续传仍 Pending |
| 发布安全门 | **Critical/High gate cleared；最终独立复审 APPROVED（`7a5ba50`）**：按最近一次成功快照，full/prod audit 均为 0 Critical、0 High；仍有 Moderate/Low，`npm audit` 因此仍 exit 1。整体发布仍因真实客户端/小屏/认证/续传手动验收 pending；续作时 registry audit 刷新被 EACCES/权限审查阻止，残余 advisories 与升级建议见下文和 security-gate report |
| 发布自动门 | **Task 1/2 本地实现完成，stable tag 仍禁止**：版本、双语 notes、canonical manifest、平台制品、candidate evidence、tag 重建 digest 匹配和 protected signing workflow 已落地。round 1 增加签名前认证 GitHub candidate run/repository/workflow/source/provenance 和下载/重建 digest 对账（本地仅 fixture 验证）；真实 candidate Actions、hosted Windows/Linux smoke、三项人工验收与 tag/Release 仍 pending；固定公钥持续 `UNCONFIGURED`，签名按设计 fail closed。证据见 [release-evidence/v0.2.0.json](../release-evidence/v0.2.0.json) 与 [UPDATING.md](UPDATING.md) |
| 部署 | 单进程模式（默认）；已提供 Nginx 根路径/`/fs/` 子路径反代示例。Task 3 round 1 修正子路径 API 代理保留 `/api/` 前缀，chapter P1 修复保留 canonical init 精确回环 allow/deny，并以大小写不敏感 regex 拒绝整条路径大小写/尾斜杠变体；实际配置静态回归对照已安装 Express matcher，覆盖根路径与 `/fs/`、URI 解码/斜杠/点路径规范化及 settings/MCP/ticket 路由；本机未安装 Nginx，`nginx -t` 与真实代理验收仍 pending |

## Task 4: Node-only 更新核心（2026-10-27）

- **Task 4 fix round 1/5（Important 1）**：release version gate 的显式产品清单已包含 `packages/update-core/package.json`，当前 root/server/web/shared/update-core 共 5 个 manifest 必须与 tag 一致，缺失或版本错配均拒绝；第三方工具不纳入产品版本，尚不存在的 updater 不提前要求，Task 5 新增后必须加入清单。本轮 RED 为 release tools 39 passed / 4 failed；GREEN 43/43；update-core 6 suites / 92 passed / 1 skipped（沿用 Windows 文件 symlink 权限边界），包含实际 publisher ZIP/tar.gz 兼容回归，package typecheck 退出 0。本轮仅执行受影响的 focused 检查，未重跑未变更的 server/Web 重型套件。
- 产品版本继续为 `0.2.0`。新增 `packages/update-core`，直接声明 `canonicalize`、`semver` 和 Win32 FFI 适配依赖 `koffi`；根 build/typecheck 显式按 shared → update-core → server → web 执行，typecheck 在 shared 检查后生成其声明供依赖包使用。Web/shared 源码没有导入该 Node-only 包。
- Manifest 使用 RFC 8785 字节一致性与 Ed25519 签名；仅接受显式受信任公钥 `KeyObject`，严格拒绝未知字段/协议、不安全数字、非 stable SemVer、非法 Unicode/日期、签名篡改与不一致的制品 URL/平台/格式。迁移工作区有迁移时 multiplier 2–64、min bytes 至少 256 MiB；无迁移时两者必须为零。选版只接受更高 stable，并给出平台/Node/updater/bootstrap 边界。共享生产公钥仍为 `UNCONFIGURED`，未增加生产信任根。
- Release source 默认只查询 `TZLXM/FileStation-webservice` 的 latest stable Release；使用 publisher 实际的 `update-manifest.json` 和 `update-manifest.json.sig`，限制 HTTPS、重定向主机/次数、超时和读取字节。全部新增 fetch 测试均为注入的离线 Response，没有调用 GitHub/API 或外部系统。
- ZIP 与 tar.gz 读取真实归档流，支持 publisher 单一 `filestation-v<version>-win-x64/` 或 `-linux-x64/` 前缀，剥离前缀后要求 server/web/shared dist 与 node_modules 内容。拒绝遍历/drive/UNC、链接/特殊类型、重复/大小写冲突、data/.env/updater、尺寸/数量/比率超限和声明不符；ZIP 再核对中央/本地记录、CRC 与解压观察值，tar 核对 USTAR checksum/padding/gzip 流。
- inspect/extract 共享同一只读句柄，记录 identity/size/SHA-256；各次实际解析/解压消耗的压缩字节也必须匹配原摘要，绝不按源 pathname 重开。Windows 本机 `O_NOFOLLOW/O_SYMLINK/O_SYNC` 均缺失，使用真实 `CreateFileW(FILE_FLAG_OPEN_REPARSE_POINT)`、同句柄属性/volume-file identity 与 ReadFile，源及逐级 ancestor 保留拒绝 write/delete sharing 的句柄。POSIX 使用真实 O_NOFOLLOW，无零值替代。目标必须不存在，在调用方控制的私有父目录下创建本次根和随机子 staging，exclusive/no-follow 创建输出并再次计数；失败只清理本次创建根，已有目标/旁边文件保留。
- 本机 Node 22.14.0 Windows x64：真实文件打开、publisher 生成的两种格式、junction 拒绝和 inspect 后 pathname rename 被锁阻止均通过；独立注入适配器测试验证 Win32 调用序列。文件 symlink fixture 因本机权限限制跳过 1 项，不作为真实覆盖；Linux 与 Node 20.17 hosted 运行、Task 5 安装根 ACL/切换/持久化及人工升级验收仍待后续，未声称部署/发布完成。
- 首次完整 root typecheck/build 发现此前 chapter 的 `base-url.test.ts` 三处 ILayer.match 类型缺口；按用户新增授权，仅在该测试增加局部结构 typeguard，保留所有 matcher 断言，未更改 Nginx/URL 生产逻辑或放宽全局 strict。修复后 focused suite 与 root 两项均通过。完整 server/Web 套件仅运行一次；未重复无关回归。Lint 仍因缺少 ESLint 不可用，根 npm test 的 shared script 边界不变；本次未刷新 audit、未 push/tag/Release。

完整命令、RED/GREEN 输出、变更路径与自审边界见 [Task 4 report](../.superpowers/sdd/2026-09-29-release-auto-update-implementation/task-4-report.md)。

## Task 5: Durable updater primitives / fix round 1/5 (2026-10-28)

- Node-only `@filestation/updater@0.2.0` directly depends on dotenv/shared/update-core/koffi. Root build/typecheck retain explicit shared → update-core → updater → server → web ordering.
- Journal records are append-only, sequenced and checksummed, with durable intent → action → durable completion. Ordinary open/read never truncate partial tails; append refuses an unrepaired tail. Explicit `repairJournalTail` requires retained recovery ownership and verified writer exit, with journal write-queue coordination. Status remains a secret-free whitelist projection.
- Owner/recovery records retain exclusive creation. A permanent OS guard now serializes stale-generation inspection → quarantine → replacement and remains held for the whole recovery handle lifetime: Windows CreateFileW share=0, Linux native flock(LOCK_EX|LOCK_NB). The guard path/inode must never be replaced or removed. Contention/unknown identity fail closed; process exit automatically releases kernel exclusion.
- Process identity distinguishes confirmed absence (ENOENT / explicit CIM no-process), verified PID reuse and ESRCH from permission/query/malformed-response failures. Unknown identity throws. Boot mismatch remains fail closed; PID/port alone cannot prove death.
- Authenticated `recoverAttempt` verifies attempt/expected fence, recovery actor and stopped old owner; durably binds the actual recovering process, advances fence and preserves phase plus the pending filesystem intent. Different-PID restarts before/after owner replacement are covered. COMMITTED rejects rollback transitions. Handoff still requires matching inherited identity and proven old-process exit.
- Windows uses real CreateFileW write-through, WriteFile, FlushFileBuffers and MoveFileExW write-through; Node fs.sync maps to FlushFileBuffers but plain Windows rename is not write-through. Complete protected DACL replacement/readback retains only current user/SYSTEM/Administrators and removes explicit Everyone/Users grants. POSIX file/directory modes remain 0600/0700 with fsync.
- Current-link recovery covers Windows stage/detach/attach intent/action/completion boundaries, completed-history gaps and restore/cleanup recovery crashes followed by repeat recovery. Complete-payload eight-state real junction detach matrices fail closed except uniquely recoverable combinations. Linux uses same-directory symlink plus rename.
- Windows actual volume IDs now use canonical GetVolumeNameForVolumeMountPointW GUIDs. Mount aliases aggregate all concurrent artifact/retained-release/DB/WAL/SHM/snapshot/restore/migration budgets and margin; maintenance rechecks remain required and unique rollback assets are never deleted. Separate volumes remain separate. Large DB/logical/snapshot fixtures each dominate the migration minimum; native-flush-boundary failure tests assert no action/completion.
- This round: updater **7 suites / 59 passed / 2 skipped**; core **6 suites / 92 passed / 1 skipped**; release tools **45/45**; root typecheck/build exit 0 and updater/core dist exist. Later test-only fixture improvements passed corresponding journal/volume suites; unchanged heavy suites were not repeated. Previous server unit **172 passed / 20 todo**, E2E **85 passed**, Web no-cache **186 passed** are historical results, not new runs. Lint remains unavailable; root npm test still fails on shared's missing test script.
- Local runtime is Node 22.14.0 Windows x64: real Win32 guard cross-process exit/kill, write-through, flush, rename, CIM, exact ACLs, junction recovery and volume GUID probe ran. Linux flock adapter sequences ran with injection only. The two updater skips are real Linux /proc identity and POSIX symlink switching because the host is Windows; core's one skip is its file-symlink fixture whose probe catches EPERM/EACCES. **Real Linux and Node 20.17 hosted checks remain pending.** Independent review remains pending after this fix commit.

Task 6 bootstrap, Task 9 orchestrator, snapshots/restoration, global WriteBarrier and a full updater CLI remain outside this change. No external service/API calls, push, tag or release. Exact RED/GREEN evidence, changed paths and self-review limits: [Task 5 report](../.superpowers/sdd/2026-09-29-release-auto-update-implementation/task-5-report.md).

## 设计决策摘要

### 技术栈
- **后端**: NestJS 10 (Node.js/TypeScript)
- **前端**: React 18 + Tailwind CSS（shadcn/ui 风格组件，未引入 shadcn 依赖）
- **数据库**: SQLite (TypeORM, WAL 模式, busy_timeout=5000)
- **构建**: Vite 6 + npm workspaces

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

- [x] TOTP 认证（AES-256-GCM 密文、管理员 setup/confirm/disable、active TOTP 总触发单次 login_challenge 两步登录；`totp_required` 只约束启用前置与禁止 disable，不切换登录挑战策略）
- [x] API Token 管理、exchange 短期 JWT 与 scopes（默认拒绝，scope 以数据库为准）
- [x] 恢复码后端（Argon2id、24 小时、一次性消费、账户/IP 防线、带租约的持久化逐请求 IP reservation、单事务消费+旧 session 撤销+新 session 插入；Swagger/OpenAPI 文档；第三轮修复由 GPT-5.6 Sol 最终批准，无 Critical/P1/P2）
- [x] 恢复码前端（设置页以密码和启用时的 TOTP 生成、一次性展示、复制/下载；登录页用户名+恢复码应急登录）
- [x] 断点续传 UI（本地续传记录校验、服务端状态探测与重试、重新选择原文件续传、确认放弃；存储不可用时不阻断当前上传）
- [x] LAN HTTP Web 上传 SHA-256 兼容（优先 WebCrypto，SubtleCrypto 缺失或拒绝时回退至 `@noble/hashes@1.8.0`；保持 `X-Part-Checksum` SHA-256 契约，并提供专用计算失败提示）
- [x] 审计日志（管理员查询、90 天保留、关键操作埋点）
- [x] 内嵌 MCP 服务（默认关闭、Streamable HTTP、11 个工具、API Token scope 校验与按 handler callsite 的审计埋点；不是每次尝试的完整账本）
- [x] Web API Token 管理、MCP 设置与审计日志分页/操作过滤页面
- [x] 前端全局导航与移动端适配（文件夹抽屉、文件卡片、触屏操作、分享/设置页布局）
- [x] 并发/压力测试（下载额度、同 session complete 幂等、冲突分块竞争、不同 session 并发上传/完成）

#### 相关实现边界（as-built）

- **TOTP 策略：** 单管理员只要已有 active TOTP，密码登录就总是要求 TOTP challenge；`totp_required` 开启前必须已启用 TOTP，开启后禁止移除 authenticator，需先关闭策略。此设置不决定当前登录是否弹出二次验证。
- **API Token 双路径：** REST exchange 签发 1 小时 `api_token` JWT；JWT Guard 每次请求回查 Token 行、scope、撤销与到期，所以吊销后下一个请求失败。MCP 每次请求直接验证原始 API Token，不先 exchange。两者都不能追溯取消已鉴权的在途请求。
- **MCP 审计边界：** `mcp.tool_called` 只在代码中的各 handler audit callsite 落记录，并非 attempt 计数。协议/schema/auth/scope 前置拒绝、16 MiB MCP body 超限、MCP 超文件上限、Base64 格式/解码字节上限都可能在对应审计前拒绝。`server_info`/列表类工具先审计再读取服务，mutation 多数在服务成功后审计；该 action 不能统一表示成功或失败。
- **LAN HTTP 上传：** 非安全 LAN HTTP origin 可能没有可用的 `crypto.subtle.digest`。`FileUpload` 现在通过共享 `uploadChunks` helper 在 native digest 不可用或拒绝时使用 `@noble/hashes` 计算相同的 SHA-256 hex；服务器端分块 checksum 校验和请求 header 未改变。继续续传会提示用户再次选择最初的同一文件，现有文件名与大小检查、隐藏 picker 可访问性、单飞和中止语义保持不变。

#### 发布验收状态

- **实现 + 自动化验证：** Phase 2 功能已实现；Task 13 独立复审 APPROVED。Task 15 focused FileUpload/SHA-256 测试 2 files / 32 passed，完整 Web Vitest 16 files / 137 passed，root typecheck/build 与 `git diff --check` 均退出 0。Lint 未改且仓库仍缺 ESLint，可用性沿用已知限制。
- **用户验收：** 用户实际 MCP 客户端已通过 `server_info`、上传、列表、分享、浏览器下载/读回、审计查询及 Token 吊销；直接 MCP `download_file` 工具仍不存在。375px 真实浏览器/设备、TOTP 启用/登录/禁用与恢复码流程、刷新页面后的续传仍需用户验收。当前 Codex 内置浏览器访问 localhost 为 `ERR_BLOCKED_BY_CLIENT`，未重试，像素 QA 仍待办。
- **依赖安全门：** 最近一次成功的 registry audit 快照中 Critical/High 已清零；Moderate/Low 仍在且 audit 命令 exit 1。整体 Phase 2 发布仍因真实客户端/小屏/认证/续传手动验收 pending，不得称为发布完成。

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
- 应用未启用 Express `trust proxy`：经 Nginx 请求的审计 `req.ip` 是应用看到的直接 peer，通常为 Nginx 地址，不是原始客户端 IP；Nginx 上游的 `X-Forwarded-For` 不会自动变成可信 `req.ip`。
- MCP `share_url_absolute` 使用请求 scheme/`Host` 构建便利展示值；即使经过 Nginx 设置 `$host`，也不作为可信公开 origin。相对 `share_url` 才是规范值；Phase 3 入口能力计划从配置/校验后的 `public_base_url` 派生对外链接。

### 上传部署不变量（2026-09-26 更新）

- 孤儿扫描依赖最终存储名和 owner token 均为 UUIDv4，并识别 `<stored UUID>.verify-<owner UUID>.tmp` 与旧版 `<stored UUID>.tmp`。不得擅改 staging 命名、UUID 格式或清理其他 owner 的临时文件。
- **混合版本并写不受支持。** 新旧版本不能同时操作同一 SQLite 数据库和 storage；升级时需先 drain/stop 全部旧进程，再启动新版本。DB lease 是 owner claim/fence，不是跨进程文件系统 CAS；旧版使用共享临时文件命名。

### 自动化验证边界

- **Task 2 release foundation（2026-10-27，仅本地自动化）：** 根包与 server/web/shared workspace 已统一为 `0.2.0`；新增 `release-notes/v0.2.0.json`、CHANGELOG、更新类型和固定公钥 sentinel。`release-tools.test.mjs` 先观察到模块缺失 RED，后覆盖版本/tag/workspace、分类省略与双语 item ID、patch breaking fail-closed、初始/prior tag migration、非线性/不可达 tag、RFC 8785、Ed25519 篡改/长度/密钥绑定、artifact URL/size/hash、确定性 ZIP/tar.gz、PR metadata 草稿、relative path/目录边界过滤、native smoke 输出脱敏和 workflow 隔离，现为 31/31 passed。生产 Windows x64 在 `SOURCE_DATE_EPOCH=1704067200` 下由 `npm ci --omit=dev` 本地缓存闭包打包，archive 50,770,078 bytes、unpacked 177,055,021 bytes、SHA-256 `9722bad0b5d5fa5d17721fc1dd240fe78aa218e1983f1f567da7e840f5ecc48f`。解压到全新临时绝对路径后，`sqlite3@6.0.1`、`bcrypt@6.0.0`、无账户初始化 DB 与 `/api/v1/settings/public` smoke 通过。该结果不等同于 GitHub hosted Windows/Linux、真实 candidate run 或人工验收。
- **Task 2 签名与发布边界：** `release-platform.yml` 只执行 workflow-call 构建、smoke 与 SHA-256 输出；`release-candidate.yml` 仅生成无签名 candidate/provenance，不接触签名 secret 或 Release；`release.yml` 只在 `v*` tag 上运行全套门禁，从 evidence 的精确 source commit 复用平台构建，并只允许 candidate→tag 改变 release evidence 与 CURRENT-STATE。`release-signing` protected environment 是唯一读取 base64 PKCS#8 secret 的任务，签名前同时验证私钥与仓库固定 SPKI 公钥绑定。当前 fixed public-key module 明确为 `UNCONFIGURED`，没有 publisher key、fixture production key 或远程/runtime trust root；在 reviewed SPKI 公钥 provision 前 signing 必须失败。部署前置条件记录于 [UPDATING.md](UPDATING.md)。
- **Task 1 release CI gate（2026-10-27）：** `scripts/ci/verify-release-gate.test.mjs` 先观察到模块缺失 RED，初版 14/14 passed；首轮复审补齐两版本的缺失/null/错误 candidate 与 failed 状态测试，现为 47/47 passed，且 CI 显式执行该 Node suite；覆盖 candidate source/run/platform digest、375px/TOTP-恢复码/刷新续传、`v0.2.5` Linux/Windows 更新项、未知版本/schema/字段 fail closed，以及仅按结构化状态判断、不扫描自由文本。PR/master workflow 监听 `master`，使用完整 fetch depth，先构建 shared，再按 server unit、server E2E、Web no-cache、typecheck、build、diff-check 顺序运行。`v0.2.0` 结构化文件中的 candidate 和人工项保持 pending，未将其转为自动化通过或 stable release。
- security-gate round 显式运行 server unit：25 suites / 172 passed / 20 todo；完整 server E2E：10 suites / 85 passed；Web `npx vitest run --no-cache`：15 files / 131 passed；并发/恢复/文件夹聚焦回归 3 轮各 3 suites / 18 passed；root `npm run typecheck`、`npm run build`、`git diff --check` 通过。
- 根 `CI=true npm test` 已实际运行：server 25 suites / 172 passed / 20 todo、Web 15 files / 131 passed，随后因 `packages/shared/package.json` 没有 `test` script 以 exit 1 结束；显式 shared workspace 同样返回 `Missing script: "test"`。不能把根聚合报告成全绿；server/Web 显式 no-cache 命令均独立 exit 0。
- Lint 复核：server 与 Web 的 `npm run lint` 都因找不到 `eslint` 可执行文件退出 1；shared 没有 `lint` script。Lint 状态是不可用，不是通过。

### 依赖审计快照与处置（2026-09-26）

基于 baseline `df26fc5` 与修复后 `package-lock.json`，此前通过 registry 分别执行 `npm audit --json` 和 `npm audit --omit=dev --json`。本次续作尝试再次刷新时默认环境返回 registry 连接 `EACCES`，请求提升网络权限也被拒绝，因此下表是最近一次成功审计快照而非本次续作的新结果；期间未再修改依赖。`npm audit` 命令仍因 Moderate/Low advisories exit 1；不要将其表述为 audit 全绿。

| 范围 | 修复前 | 最近成功快照 Critical / High / Moderate / Low | findings | direct / transitive |
|------|-------:|------------------------------------------------:|---------:|--------------------:|
| 全依赖 | 46（2 / 19 / 19 / 6） | 0 / 0 / 23 / 2 | 25 | 15 / 10 |
| `--omit=dev` 生产闭包 | 28（1 / 13 / 11 / 3） | 0 / 0 / 16 / 1 | 17 | 12 / 5 |

High-severity 发布门已清零，但剩余 Moderate/Low 仍是已知安全风险；所有包级 direct/transitive、runtime/dev、advisory 与 `fixAvailable` 明细见 [security-gate report](../.superpowers/sdd/security-gate-report.md)。

- **原生产 Critical `tar` 链已移除：** `sqlite3@6.0.1` 替换 sqlite3 5/node-gyp8 安装链，`bcrypt@6.0.0` 移除旧 `@mapbox/node-pre-gyp` 链；未修改应用上传路径。旧 bcrypt hash 与新登录验证、SQLite/原生安装回归均通过。
- **原 Vitest Critical 已修复：** Web 升级至 `vitest@4.1.11` + `vite@6.4.3`，符合当前 Node20.17 最低版本；4.1.11 同时覆盖影响 Vitest4.0–4.1.10 的后续 advisory。Vitest4 将一处通用 mock 返回类型收窄为明确登录回调签名，类型检查修正仅在测试文件。
- **原生产 High 已清零：** `@nestjs/platform-express@10.4.22 → multer@2.3.0` 精确 override（非 Nest 官方组合；upload/MCP/full E2E 与 typecheck 通过）；`@nestjs/serve-static@4.0.2 → path-to-regexp@1.9.0`，并显式保持 Express4 的 `path-to-regexp@0.1.13`，避免错误复用。静态 asset、SPA fallback、API/exclude E2E 通过，`npm ls --all` clean。
- **Dev High 已清零而保留 Nest10：** `@nestjs/cli@10.4.9 → glob@11.1.0` 与 `external-editor@3.1.0 → tmp@0.2.7` 均为精确 parent override；CLI build、clean dependency tree 通过。`tmp@0.2.6` 会引入新的 GHSA-7c78-jf6q-g5cm High，最终选用 npm advisory 首个修复版本 0.2.7。官方 `@nestjs/cli@12.0.7` 实验在当前 Node22.14 下因 Nest CLI/Angular DevKit `ERR_REQUIRE_CYCLE_MODULE` 导致 `nest build` 失败，已完整回滚，未升级任何 Nest runtime 包。
- 根 `engines`、README、AGENTS 已同步为 Node `>=20.17.0`（sqlite3 6 的要求）；TypeORM `0.3.31` peerOptional 明确支持 sqlite3 `^5.0.3 || ^6.0.0`。
- **仍未运行 `npm audit fix --force`。** 剩余生产 moderate 主要涉及 Nest10 依赖族、`file-type@20.5.0`、`qs`、React Router6 与 `uuid@9`；主要官方升级建议分别要求 Nest12、file-type21、React Router7、uuid14。开发 Moderate/Low 包含 `ajv`/webpack/Angular Devkit，官方 CLI 修复建议 Nest CLI12；应另行制定 major/toolchain 兼容计划。Production Low `body-parser` 也随 Nest platform-express12 的 audit 修复建议出现。保持当前兼容性并在后续计划处置，不为数字强行跨 major。
- 在本机默认 npm `10.9.2` / Node `v22.14.0` 下，把 root 与三个 workspace manifest、lockfile 复制到独立 Temp 副本，`npm ci --ignore-scripts --no-audit` 安装 1077 packages 且退出 0，`npm ls --all` exit 0；副本随后删除。
- **最终独立安全复审：APPROVED（无 Critical/P1/P2），审阅范围 `df26fc5..7a5ba50`。** Reviewer 实际复跑 server unit 25/172（20 todo）、full E2E 10/85、Web no-cache 15/131、root typecheck/build、ServeStatic focused E2E 2/2、`git diff --check`，并检查 `npm ls --all`、SQLite native binding load/version、bcrypt6 hash round-trip 与预期依赖子树。批准仅代表此安全修复轮；不代表 `npm audit` 全绿或 Phase 2 发布验收完成。
- 剩余风险/边界：registry audit 刷新因 `EACCES` 未成功，数字沿用最近一次成功快照；隔离 `npm ci --ignore-scripts` 跳过 lifecycle scripts，只证明 lock/tree 可复现，不单独证明 clean-room 原生安装；当前 host 的 native binding load 与运行测试另有验证。精确 parent override 在 parent 升级时需重新审查，尤其非官方 Nest10/Multer2 组合。Moderate/Low advisories 与真实 MCP 客户端、375px、TOTP/恢复码、刷新续传用户验收仍 pending。

## 文档引用

- **设计文档**: [docs/superpowers/specs/2026-07-28-filestation-design.md](superpowers/specs/2026-07-28-filestation-design.md)
- **Phase 1 实施计划**: [docs/superpowers/plans/2026-07-28-phase1-mvp-v1.7.md](superpowers/plans/2026-07-28-phase1-mvp-v1.7.md)（历史实现计划）
- **Agent 手册**: [AGENTS.md](../AGENTS.md)
- **架构决策**: [docs/adr/](adr/)
- **MCP 决策**: [ADR-0005](adr/0005-mcp-embedded-with-api-token.md)

## 待办事项

### Phase 2 后续

- 发布门：Task 1/2 的本地可执行门禁已完成；需推送并运行真实 `release-candidate.yml`，记录精确 source commit/run ID/双平台 digest，再以同一制品完成 375px、TOTP/恢复码、刷新续传人工验收并更新 `release-evidence/v0.2.0.json`，否则 stable tag 必须保持禁止。hosted Windows/Linux smoke、reviewed publisher SPKI 公钥和 protected signing environment 亦未完成。Critical/High gate 已清零；后续仍需计划剩余 Moderate/Low advisories 的 major 迁移或风险接受。
- 用户手动验收：375px 小屏/设备；TOTP 与恢复码流程；刷新页面后的上传续传。真实 MCP 客户端上述用例已通过；直接 MCP `download_file` 工具尚未实现。

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
| Publisher key 未配置 | tag workflow 无法签名/发布 | 固定公钥 sentinel 与签名 fail closed；按 UPDATING.md 在 protected environment provision reviewed Ed25519 SPKI/PKCS#8 后才可发布 |

## 变更日志

- **2026-07-28**: 项目初始化，设计文档 v2.2 完成，AGENTS.md 建立
- **2026-07-30**: Phase 1 实施计划经两轮外部评审迭代至 v1.7；MVP 实现完成
- **2026-07-31**: 浏览器端到端验证通过（初始化→登录→上传→分享→下载→文件夹全流程）；修复验证发现的 5 个 bug
- **2026-09-01**: Nginx 可选化（ADR-0004）：默认单进程模式托管前端，`start:bynginx` 保留反代模式；代码推送至 GitHub
- **2026-09-24**: Phase 2 API Token 管理、exchange 与 scope 授权落地；API token JWT 每次请求检查吊销状态，scope 从数据库读取
- **2026-09-25**: Phase 2 审计日志落地；关键认证/文件/分享/设置操作埋点，管理员分页查询，IP 匿名化与 90 天清理
- **2026-09-25**: Phase 2 内嵌 MCP 服务落地；默认关闭的无状态 Streamable HTTP 入口、11 个工具、逐工具 scope 与审计，上传总大小及分块上限
- **2026-09-25**: Phase 2 Web 设置页增加 API Token 签发/吊销与 MCP 配置，新增受保护的审计日志分页、过滤页面
- **2026-09-25**: Phase 2 TOTP 后端落地；AES-256-GCM 密文存储、管理员启停、active TOTP 总触发单次登录挑战；`totp_required` 要求启用前置且阻止策略开启时禁用，并提供派生状态
- **2026-09-25**: Task 8 并发复修；即时事务连接独立于 TypeORM，并在进程内排队，避免 SQLite busy wait 导致的线程池饥饿
- **2026-09-25**: Task 9 TOTP 前端落地；登录两步验证、设置页启停、`totp_required` 策略开关与异步响应竞态保护
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
- **2026-09-26**: Task14 首轮独立文档审阅 REJECTED（5×P2）；对照 Controller/Service/migration/Nginx 配置修正 MCP 审计 callsite 语义、API Token hash 查询与 REST/MCP 双认证轨、TOTP 策略/登录响应、普通上传 scope 说明、反代 IP 与 Host 边界；移除不存在的 `FILESTATION_INIT_TOKEN` 环境变量并说明当前无 CHANGELOG 时记录于本文件。仅改文档，`npm run typecheck` 与 `git diff --check` 通过；依赖安全门仍 blocked/pending，等待复审。
- **2026-09-26**: Task14 第二轮独立复审修正 ADR-0005 中 MCP 拒绝请求体的有界排空说明并获 APPROVED；随后 Phase2 security-gate 独立修复轮以 `df26fc5` 为基线升级 sqlite3/bcrypt/Vite/Vitest，修复 production tar Critical、Vitest Critical 与可兼容 High。最近一次成功的 registry audit 快照从全量 46（2C/19H/19M/6L）、生产 28（1C/13H/11M/3L）降至全量 25（0C/0H/23M/2L）、生产 17（0C/0H/16M/1L）；Moderate/Low 仍使 audit exit 1。续作期间再次 audit 因 registry 网络 EACCES 且权限提升请求被拒，未产生新快照；`npm ls --all`、临时副本 `npm ci --ignore-scripts`、server unit 25/172、E2E 10/85、Web 15/131、focused 并发/恢复/文件夹 3 轮各 18、root typecheck/build 和 diff-check 均通过。Lint 不可用；真实 MCP/375px/TOTP/恢复码/刷新续传手动验收仍 pending。
- **2026-09-26**: Phase2 security fix commit `7a5ba50` 获最终独立 security review **APPROVED**（无 Critical/P1/P2）。Reviewer 实际重跑 server unit 25/172、full E2E 10/85、Web no-cache 15/131、root typecheck/build、ServeStatic focused E2E 2/2 与 diff-check；并核对 clean npm dependency tree、native SQLite binding、bcrypt6 hash 与 dependency placement。非阻断残余：registry audit refresh 因 EACCES 继续使用最后成功快照；隔离 `npm ci --ignore-scripts` 跳过 install scripts，不作为 clean-room 原生安装证据；scoped overrides 升级需重审；Moderate/Low 与用户手动验收仍 pending，不代表 Phase2 发布批准。
- **2026-09-26**: Task 15 修复 LAN HTTP Web 上传在首次分块前失败的问题：`FileUpload` 通过共享 `uploadChunks` helper 优先使用 SubtleCrypto，缺失或拒绝时回退到显式依赖 `@noble/hashes@1.8.0`，仍发送准确的 SHA-256 `X-Part-Checksum`；总计算失败显示专用错误并保留待续传状态，继续操作提示重新选择原文件。TDD RED 观察到首个 PUT 为 0、通用上传中断文案及续传说明缺失；focused GREEN 2 files / 32 passed，完整 Web 16 files / 137 passed，root typecheck/build/diff-check 通过。用户实际 MCP 客户端验收记录为通过：`server_info`、上传、列表、分享、浏览器下载/读回、审计查询及 Token 吊销；直接 MCP `download_file` 不存在。375px、TOTP/恢复码和刷新续传手动验收仍 pending；Lint 未运行，仓库已知缺少 ESLint。
- **2026-10-27**: Task 1 修复发布 CI 并落地版本化 release gate：workflow 改为在 `master` 的 push/PR 运行，先构建 shared，再执行 server unit、server E2E、Web no-cache、typecheck、build 与 PR merge-base/本地 diff-check；移除不可用 lint 与根 `npm test`。新增严格结构化证据校验脚本、14 项 Node tests 与 `verify:release-gate` script，支持 `v0.2.0` Phase 2 人工项及 `v0.2.5` Linux/Windows 更新项，未知版本/schema/字段和非 passed 状态 fail closed。`v0.2.0` candidate provenance/digest 与三项真实人工验收保持 pending，命令按设计 exit 1；未创建 tag/release。验证：server unit 25/172（20 todo）、server E2E 10/85、Web 16 files/137、root typecheck/build 通过。
- **2026-10-27**: Task 1 首轮复审修复：补齐 v0.2.5（同时覆盖 v0.2.0）sourceCommit/runId/两平台 digest 缺失、null 与格式错误以及 failed 验收状态测试；CI 增加独立 Node gate tests step，未执行 pending production evidence gate。Focused Node tests 47/47、workflow YAML/命令检查与 diff-check 通过；本轮按要求未重跑未变的重型 suites，真实验收仍 pending。
- **2026-10-27**: Task 2 release foundation 本地实现：统一四处产品版本为 `0.2.0`，新增双语版本化 Release Notes/CHANGELOG、shared update protocol types、固定公钥显式 sentinel、确定性发布工具、双平台可重定位制品与 native smoke、候选 provenance、tag 重建 digest 匹配以及唯一 protected signing job。Task 2 focused Node tests 31/31；server unit 25/172（20 todo）、server E2E 10/85、Web 16/137、typecheck/build 通过。Windows x64 生产闭包制品在全新临时目录完成 SQLite/bcrypt/公共设置 smoke，archive SHA-256 为 `9722bad0b5d5fa5d17721fc1dd240fe78aa218e1983f1f567da7e840f5ecc48f`。未调用 GitHub API、未 push/tag/创建 Release；真实 candidate Actions、hosted Linux、人工验收、publisher SPKI/PKCS#8 provision 与签名发布均保持 pending。
- **2026-10-27**: Task 3 canonical root/subpath URLs：新增 `base-url` helper 与根路径/`/fs/` 回归；所有浏览器 API、BrowserRouter、分享复制/列表、下载票据和 MCP 路径统一从 `import.meta.env.BASE_URL` 派生；`FILESTATION_BASE` 仅映射 Vite `base`，拒绝外部 absolute URL，HTML favicon/assets 使用构建 base；Nginx 文档提供 `/fs/api/` 去前缀代理和两套初始化 allow/deny，refresh Cookie 维持框架默认 `Path=/`。Focused Web 5 files / 45 passed；full Web 17 files / 158 passed；root 与 `/fs/` 构建通过并核对 `/assets/` 与 `/fs/assets/`；server unit 首次发生既有 90 天审计 cutoff 的 1 ms 时序抖动，随后 full rerun 25 suites / 172 passed（20 todo），full E2E 10 suites / 85 passed。版本保持 `0.2.0`；未调用外部服务、未 push/tag/Release。

---

*此文档每次功能变更后必须更新*
