# Task 14 Report：Phase 2 文档与发布收尾

## 基线与范围

- 基线：`15dd142`，分支 `feat/phase2-reliability-agent-mobile`
- tracked 改动仅：`AGENTS.md`、`README.md`、`docs/CURRENT-STATE.md`、设计文档 v2.3、新增 `docs/adr/0005-mcp-embedded-with-api-token.md`。
- SDD brief/report/progress 在既有 `.superpowers/sdd/` ignored 账本中；未修改源码、package manifests/lockfile，也未运行 `npm audit fix`。
- 保留用户未跟踪 `.claude/settings.local.json` 与 `docs/superpowers/plans/2026-09-19-phase2-reliability-agent-mobile.md`，未暂存。

## 裁决

1. 代码、package-lock 与测试优先于过期 Task14 计划；精确 API/参数放进设计/current-state，AGENTS 只保留抽象硬规则。
2. Phase 2 实现与自动化验证可以记录为完成；真实 MCP 客户端、375px、TOTP/recovery、刷新后上传续传仍待用户手动验收，不能称发布验收完成。
3. npm audit 旧记录“39 findings”不等于当日 registry snapshot；2026-09-26 当前锁文件快照是 46，全量与 `--omit=dev` 分开记录。
4. `tar` 是 production dependency closure 中的 Critical，但引用位于 native dependency installers 的 archive extraction，不是 FileStation HTTP handler 调用；仍应阻止“安全审计通过/发布完成”声明，后续另立修复/风险接受任务。
5. 不对 sqlite3/bcrypt 做未经完整 native build/runtime/E2E 验证的 major 升级或 overrides；TypeORM peer 兼容仅说明其 manifest 范围接受 sqlite3 6，不证明项目整体已验证。
6. Task13 mixed-version 部署约束：新旧进程不得同时写同一 DB/storage，升级前 drain/stop 旧进程；owner-specific UUID staging 命名与扫描是必须维护的不变量。

## 已核实实现事实

- API Token：`fs_api_` + 48 小写 hex（192 bit）；只显示一次；DB 存 SHA-256 完整值，12-char display prefix；exchange 用全值 SHA-256 精确查找；API-token JWT 有 1h expiry，后续 JWT 请求从 DB reload scopes/撤销/expiry；scope 六项为 `files:read/write`、`folders:read/write`、`shares:read/write`。
- API 管理路由：`POST/GET /api/v1/api-tokens`、`DELETE /api/v1/api-tokens/:id`，管理员 Guard；exchange `POST /api/v1/auth/api-token/exchange`。
- MCP：default off；无状态 Streamable HTTP `POST /api/v1/mcp`；GET/DELETE 404；直接持有 API Token；11 tools：`server_info` (valid token, no extra scope)、`list_files` (`files:read`)、`list_folders` (`folders:read`)、`create_folder` (`folders:write`)、`upload_init/upload_part/complete_upload/delete_file` (`files:write`)、`create_share/revoke_share` (`shares:write`)、`list_shares` (`shares:read`)。MCP SDK 1.30.1、Zod 3.25.76；manifest ranges `^1.30.0`/`^3.25.76`。专用 MCP JSON body 16 MiB；普通 JSON/urlencoded 100 KiB；文件默认 32 MiB，设置允许 1–512 MiB；单 part 解码原始值最多 8 MiB；MCP chunk 64 KiB–8 MiB。
- 普通 uploads：文件上限 100 GiB、chunk 64 KiB–64 MiB、default 8 MiB、session 24h；初始化为 JWT + `files:write`，后续使用 `X-Upload-Token`。Finalizer lease 10 min、heartbeat 30 sec、等待硬上限 15 min、lost owner 返回 409 `UPLOAD_FINALIZE_LOST`；I/O 在 DB 写事务外。
- 上传 staging 不变量：`<stored UUIDv4>.verify-<owner UUIDv4>.tmp`；legacy `<stored UUIDv4>.tmp` 有限期兼容扫描。DB lease 并非跨进程文件系统 CAS；混版部署不支持。
- TOTP：otplib 12.0.1，SHA-1/6 digits/30 sec/window ±1；challenge 5 min 单次；用 atomic last-used step 防重放；secret AES-256-GCM，12 byte IV/16 byte tag，key `SHA-256(JWT_SECRET)`，因此 secret rotation 会影响已存 TOTP。
- Recovery：10 个 Crockford Base32 × 10 chars (50 bit)、4-4-2显示分组、24h TTL；Argon2id m=19,456 KiB/t=2/p=1；5 account failures/15 min lock，IP admission 每条 reservation 5 min，阈值计数 10；成功原子消费/旧 session revoke/新 session 建立。
- Audit action enum 17 项：`auth.login`, `auth.login_failed`, `auth.api_token_exchanged`, `api_token.created`, `api_token.revoked`, `upload.initiated`, `upload.completed`, `file.deleted`, `share.created`, `share.revoked`, `settings.updated`, `mcp.tool_called`, `auth.totp_enabled`, `auth.totp_disabled`, `auth.totp_failed`, `recovery.generated`, `recovery.used`。Retention 90d，daily 04:00 purge；IPv4 /24、IPv6 前 3 段、UA max 256；details 不做通用 secret scrub。

## npm audit（2026-09-26）

`npm audit --json` 元数据：46 findings = Critical 2 / High 19 / Moderate 19 / Low 6。`isDirect` 分类：direct 17、transitive 29。Audit 建议 31 项 major fixes、15 项 non-major fixes。

`npm audit --omit=dev --json`：28 production-closure findings = Critical 1 / High 13 / Moderate 11 / Low 3；direct 12、transitive 16；建议 22 major、6 non-major。全量记录与旧 `npm install` 的 39 项历史输出为不同快照。

Critical 两项：

- `tar@6.2.1`：transitive + production closure。路径 `sqlite3@5.1.7 -> tar` 与 `sqlite3 -> optional node-gyp@8.4.1 -> tar`，另有 `bcrypt@5.1.1 -> @mapbox/node-pre-gyp@1.0.11 -> tar`。已检查安装元数据：sqlite3 install 执行 `prebuild-install -r napi || node-gyp rebuild`；bcrypt install 执行 `node-pre-gyp install --fallback-to-build`；tar.extract 位于 node-gyp header / node-pre-gyp prebuild unpacker，`apps/server/src` 无 tar 引用。风险位于安装/原生构建 archive extraction，并非 app HTTP 文件上传调用；由于生产 dependency closure 仍命中 Critical，security gate blocked/pending。相关 advisory 覆盖 hardlink/symlink path traversal, arbitrary read/write, malformed archive DoS。
- `vitest@1.6.1`：direct dev dependency。GHSA-5xrq-8626-4rwp 仅当 Vitest UI server listening 时攻击面可达；不是 app production server route。Audit 建议 Vitest 5 major。

生产 High direct 四项：`@nestjs/platform-express@10.4.22`、`@nestjs/serve-static@4.0.2`、`bcrypt@5.1.1`、`sqlite3@5.1.7`；npm 修复建议主要是 Nest 12、bcrypt 6、sqlite3 6 majors。高/危建议有不止升级包这一项影响，不应直接 audit fix。

Registry metadata read-only checks：`sqlite3@6.0.1` Node `>=20.17.0`, peer `node-gyp@12.x`, dependency `tar:^7.5.10`; `bcrypt@6.0.0` Node `>=18`; TypeORM 0.3.31 peerOptional sqlite3 `^5.0.3 || ^6.0.0`. Repo root Node engine still `>=20.0.0`; existing peer range does not certify new native installation, current OS binaries, migration behavior, or concurrency suite. 最小 production-critical 修复候选应另立安全任务：升级 sqlite3/bcrypt 两个 major（从依赖树移除旧 tar6 安装链并验证新 tar patch resolution）并把 Node 最低版本提升到 sqlite3 要求，然后执行 native build、migration 与完整 server/web 并发回归；该范围仍留下 production High advisories，故另需安全评审 Nest/其他 High。Task14 未改动依赖。

## 验证

- `npm test --workspace=@filestation/server -- --runInBand`：exit 0；25 suites / 172 passed / 20 todo。ts-jest 有既有 `shared/dist/index.js` allowJs warning。
- `apps/web` cwd 下 `npx vitest run --no-cache`：exit 0；15 files / 131 passed。React Router future-flag warnings。
- `npm run test:e2e --workspace=@filestation/server`：exit 0；9 suites / 83 passed；预期 MCP oversized-request 与 owner-abort 回归用例会在 Nest 日志输出错误栈。
- `npm run typecheck`：exit 0；`npm run build`：exit 0；`git diff --check`：exit 0（仅行尾 LF→CRLF 警告）。
- `npm run lint --workspace=@filestation/server` 与 Web 等均 exit 1：没有 `eslint` 可执行文件；shared 无 lint script。
- `CI=true npm test` 实际 exit 1：根脚本先运行 server 25/172/20 todo、Web 15/131 均通过，最终因 `packages/shared` 缺少 `test` script 失败；`npm run test --workspace=@filestation/shared` 显式 exit 1: `Missing script: "test"`。根聚合不能作为全绿证据；server/Web 显式通过。

## 最终状态

- 文档更新可以提交并交给父 Agent 安排独立 GPT-5.6 Sol medium review。
- **Phase 2 发布批准仍 blocked/pending**：production dependency closure 存在 Critical `tar` + 13 High findings，尚未修复或由授权人正式接受；真实客户端/设备手动验收也未完成。自动化通过只表示实现验证完成，不代表发布验收完成。
