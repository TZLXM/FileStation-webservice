# Phase 2 SDD Progress Ledger

Plan: docs/superpowers/plans/2026-09-19-phase2-reliability-agent-mobile.md (v1.2)
Branch: feat/phase2-reliability-agent-mobile
Baseline: c221270 (master) — typecheck green, 49 unit tests pass, 20 todo

## Tasks
Task 1: complete (commits c221270..b0fb035, review clean — spec ✅ / quality Approved)
  - deviation (verified necessary): plan's `foreignKeys: false` is not a TypeORM 0.3 sqlite option
    (typecheck error) and SqliteDriver forces PRAGMA foreign_keys=ON on connect; implementer
    used `PRAGMA foreign_keys = OFF` after initialize(). Plan text corrected.
  - Minor (for final review triage): alignment spec compares column NAMES only — type/nullability
    drift would pass (plan-mandated verbatim). Also redundant '../database/migrations' import path.

Ruling: 继续复用旧版 SDD 的平铺工作区 `.superpowers/sdd/`，不迁移到新版按计划隔离的子目录 — 用户明确要求使用相同任务台账目录，且现有台账、Task 1 提交与计划身份已交叉验证一致 — 若判断错误，代价是本计划的临时产物可能与未来另一份计划共享目录，但当前所有文件均有 Task 编号和提交范围可恢复。
Execution routing: implementers = gpt-6-luna/max; task reviewers = gpt-5.6-sol/medium (user requested 2026-09-24).
Ruling: 后续提交不再使用计划中的 `Claude Fable 5` 署名，改为实际实现模型 `GPT-6 Luna <noreply@openai.com>` — 原署名与用户指定执行模型不符 — 若判断错误，只影响提交元数据，不影响代码，可在合并前统一修订。

Task 2: fix round 1/5 opened after review (base b0fb035, head b8844cc)
  - Important: `touchLastUsed` 的 findOne→update 不是原子节流，并发请求可同时写入；必须改为带 last_used_at 截止条件的单条条件 UPDATE，并补能约束该查询契约的测试。
  - Minor included in same round: `validatePlaintext` 应完整匹配 `^fs_api_[0-9a-f]{48}$`，而非仅检查前缀。
  - Deferred tooling observation: 仓库 lint 脚本因缺少 eslint 可执行文件无法运行；Task 2 不扩张范围安装工具链，最终审查时统一裁决。
Ruling: Task 2 计划示例的“先查后写”与全局并发条件 UPDATE 约束冲突时，以全局约束为准，改为原子条件更新 — 否则并发流量下节流失效并放大 SQLite 写入 — 若判断错误，代价是 repository mock/实现复杂度略增，但行为更严格且接口不变。
Task 2: fix round 1/5 complete (2 addressed, 0 open; commit d052c20; scoped re-review clean)
Task 2: complete (commits b0fb035..d052c20, review clean — spec ✅ / quality Approved after fix round 1)

Task 2: fix round 2/5 opened after controller preflight discovered a missed brief contradiction
  - Missing: Task 2 Step 4/Step 6 explicitly create `AdminOnlyGuard`, attach it to all API Token management endpoints after JwtAuthGuard, and stage it in the Task 2 commit; current d052c20 tree has neither the guard nor the attachment.
  - The first review missed this because the Task 2 interface summary inconsistently said the guard lands in Task 3 and the controller should temporarily use only JwtAuthGuard.
Ruling: Task 2 的接口摘要与其 Step 4/Step 6 冲突时，采用更具体且被 v1.2 修订记录再次确认的 Step 4/Step 6：本轮创建 AdminOnlyGuard 并挂到 api-tokens controller；Task 3 只负责把它注册/导出到 SecurityModule 并接入其他管理端点 — 否则 Task 3 接入 api_token JWT 后会留下 Token 管理权限漏洞 — 若判断错误，代价仅是守卫文件提前一个任务存在，接口与最终计划状态不变。
Task 2: fix round 2/5 complete (1 addressed, 0 open; commit 5e90cef; scoped re-review clean)
Task 2: complete-final (commits b0fb035..5e90cef, review clean — spec ✅ / quality Approved after 2 fix rounds; supersedes earlier completion line)

Task 3: fix round 1/5 opened after review (base 5e90cef, head d7bf902)
  - Important: exchange controller 的 `authorization?.replace(/^Bearer\s+/i, '')` 会接受没有 Bearer scheme 的合法 `fs_api_*` 明文；必须要求完整 Bearer 前缀，并补 E2E 拒绝路径。
Task 3: fix round 1/5 complete (1 addressed, 0 open; commit e47719f; scoped re-review clean)
Task 3: complete (commits 5e90cef..e47719f, review clean — spec ✅ / quality Approved after fix round 1)

Task 4: fix round 1/5 opened after review (base e47719f, head c9f560f)
  - Important: `AuditService.toEntry()` 直接 JSON.parse(details)，单条历史/损坏记录可令整页查询 500；需安全降级并测试。
  - Minor included: 空 settings 更新不应写入误导性的 settings.updated；CURRENT-STATE/README 的日期与审计待办状态需自洽。
Task 4: fix round 1/5 complete (3 addressed, 0 open; commit 0359466; scoped re-review clean)
Task 4: complete (commits e47719f..0359466, review clean — spec ✅ / quality Approved after fix round 1)

Ruling: Task 5 不直接注册具名为 `jsonParser` 的路由中间件，而用具名 wrapper 包住 MCP 16MB parser — 当前 Nest Express adapter 会以中间件函数名判断全局 parser 是否已注册，直接样例会意外跳过全局 100KB parser；E2E 同时锁定 MCP 约 11.2MB JSON 成功与普通路由 120KB 返回 413 — 若判断错误，代价是 wrapper 多一层调用，但路由行为由集成测试覆盖。
Ruling: SDK 1.30.1 + Zod 3.25.76 的兼容重载触发 TS2589 时，允许用局部强类型适配器调用同一 variadic `server.tool` 运行时 API，不升级包族/版本 — 保留 Zod3 handler 输入推导与运行时 schema 校验，同时让默认堆 typecheck 通过 — 若判断错误，代价是 SDK 重载层的静态检查范围缩小，需由协议 E2E 与最终审查兜底。
Deferred security observation: Task 5 dependency install reports 38 aggregate npm audit findings (6 low, 14 moderate, 17 high, 1 critical); no out-of-scope upgrade performed, must be assessed during Task 14/release security check.

Task 5: fix round 1/5 opened after review (base 0359466, head 88643bc)
  - Important: MCP disabled/method 404 can be preempted by route JSON parser 400/413; parser must not disclose endpoint before disabled/method checks.
  - Important: token.scopes JSON must be a validated array of known scopes, failing closed on corrupt/wrong-shape data.
  - Important: upload_part must enforce decoded <=8MiB independently of ordinary-upload session chunk size.
  - Important: zero-byte upload must report a protocol consistent with UploadsService (zero parts + direct complete, or equivalent consistent behavior).
  - Important: base64 must be strictly validated before Buffer decoding.
  - Minor included: Bearer separator should be spaces only; protocol tests should perform initialize before tools calls where the SDK requires it.
Task 5: fix round 1/5 review result (7 original findings addressed; commit 2f0337a) but new Important breakage opened fix round 2/5:
  - early 404/401/method gates await an unbounded request-body drain; a never-ending/chunked slow client can hold handler resources indefinitely.
  - Minor evidence gap: zero-byte test verifies metadata only, not actual complete_upload success.
Ruling: SDK 1.30.1 stateless transport with `sessionIdGenerator: undefined` does not require initialize/session validation; source validateSession path and real SDK E2E confirm this pinned-version behavior — adding a synthetic initialize round per request would not improve correctness — if wrong, future SDK upgrade must revisit this documented assumption.
Task 5: fix round 2/5 complete (availability regression + zero-byte evidence addressed; commit 00d0c3b; scoped re-review clean)
Task 5: complete (commits 0359466..00d0c3b, review clean — spec ✅ / quality Approved after 2 fix rounds)

Task 6: authenticated 375×812 visual QA found the initial dialog gutter contract was false at runtime (`w-full max-w-md mx-4` rendered x=0/full viewport); fixed by moving `p-4` to the overlay (commit 7cdb62d). Post-fix browser measurement: x=16px, width≈343.33px, right≈359.33px, document scrollWidth=375px.
Task 6: fix round 1/5 opened after review (base 00d0c3b, head 7cdb62d)
  - Important: aria-modal folder drawer did not trap focus, so keyboard focus could reach obscured header/main.
  - Important: crossing to `min-width: 768px` while the drawer was open hid it with CSS but left body scrolling locked and focus in hidden content.
  - Important: FolderTree expand/select paths used non-semantic 16px/click-only spans; desktop actions were hover-only.
  - Minor evidence/test gap: mobile file actions were mostly checked for presence rather than API/payload/confirmation/callback behavior; gutter unit test was structural only.
Ruling: 不为 Task 6 单独引入新的 Playwright 浏览器测试栈；保留结构契约测试，并用已认证本地 Edge 375×812 的真实 DOM 几何与截图补足像素证据 — 当前仓库没有浏览器 harness，新增整套依赖超出本任务，而真实测量已复现旧缺陷并验证修复 — 若判断错误，代价是该像素回归仍需人工验收，Task 14/后续测试基础设施可再引入正式浏览器测试。
Task 6: fix round 1/5 complete (drawer focus/breakpoint cleanup, FolderTree semantics/touch targets, mobile action behavior tests addressed; commit 958e021; scoped re-review Approved)
Task 6: complete (commits 00d0c3b..958e021, review clean — spec ✅ / quality Approved after fix round 1; web 5 files/26 tests, typecheck, build, diff-check green; lint remains unavailable because repository lacks eslint executable)

Ruling: Task 7 浏览器代码不运行时导入 shared 的 CommonJS `API_TOKEN_SCOPES`；Web 端用 `ApiTokenScope` 类型约束本地只读列表，契约测试直接读取受版本控制的 `packages/shared/src` — Vite 对 workspace CJS named export 的解析会在 production build 失败，而 default/namespace interop 也不可靠；直接源码契约测试避免依赖 gitignored/陈旧 `dist` — 若判断错误，代价是 Web 列表仍有一份重复常量，但漂移会在干净测试中失败。
Task 7: pre-review fix commit 2db1ad7 followed initial implementation 9254502: preserve unrelated Settings drafts when refreshing agent state, strictly validate numeric expiry text, wrap long token names, and add `/audit` page ErrorBoundary required by AGENTS.md.
Task 7: fix round 1/5 opened after review (base 958e021, head 2db1ad7)
  - High: scope contract test resolved shared through gitignored/stale dist; clean checkout could fail or miss drift.
  - Important: Audit page retained an out-of-range page after total_pages shrank.
  - Important: API Token list requests lacked stale-response isolation and shared one error state, allowing old lists/error clearing.
  - Minor: successful Agent PUT followed by refresh failure was misreported as a save failure.
Task 7: fix round 1/5 complete (all 4 addressed; commit 5c9d7e7; scoped re-review Approved)
Task 7: complete (commits 958e021..5c9d7e7, review clean — spec ✅ / quality Approved after fix round 1; web 10 files/50 tests, typecheck, build, diff-check green; temporary real API smoke passed create/list-no-plaintext/settings-audit/revoke and all QA data was removed)

Task 7: started (base 958e021; brief `.superpowers/sdd/task-7-brief.md` read; scope is settings Token/MCP UI and protected audit page)
Task 7: RED observed (pre-implementation web Vitest: 5 files failed / 4 passed; 3 tests failed / 26 passed; missing Task 7 components and route were the expected causes)
Ruling: Web bundle does not support runtime named imports from linked CommonJS `@filestation/shared`; default import fails TS1192 and namespace import is warned as missing by Vite — use a readonly `ApiTokenScope`-typed local choices array and a Vitest contract assertion against shared `API_TOKEN_SCOPES` — avoids module-format/Vite configuration changes while detecting future scope drift — if wrong, stale choices could be offered only if both the contract test and typecheck are bypassed.
Task 7: implementation committed as `9254502` (12 Task 7 files; `.claude/settings.local.json` and the untracked plan remain unstaged); final code review pending.

Task 8: Ruling: pin `otplib` to the 12.x API used by the plan examples — the initially resolved 13.5.0 package fails the existing CommonJS Jest runtime while loading its ESM-only `@scure/base` dependency, before any assertions run; using the compatible 12.x line keeps the project’s Node 20/CommonJS support and test runner intact — if wrong, the cost is an older TOTP library line that may need a separately scoped migration later.

Task 8: concurrency fix round started (base 2aa0b09; interrupted working-tree changes retained)
Task 8: RED observed — default-threadpool `totp.e2e-spec.ts` returned SQLITE_BUSY in concurrent challenge and same-step validation; corrected diagnostics traced the lock holder's first in-transaction SELECT at 5517ms, while subsequent SQL statements took 0–2ms. Competing connections failed at BEGIN IMMEDIATE after ~5.5s. A diagnostic-only run with UV_THREADPOOL_SIZE=16 passed the TOTP E2E suite 12/12.
Task 8: isolated RED→GREEN — eight concurrent real SQLite immediate transactions failed pre-fix with SQLITE_BUSY; process-local queue made `tx.helper.spec.ts` pass 3/3 and default-threadpool TOTP E2E pass 12/12.
Ruling: serialize calls to SqliteImmediateTransactionService before opening independent sqlite3 connections — concurrent busy waits occupy libuv workers and starve SQL submitted by the transaction that already owns SQLite's write lock; the queue prevents same-process connections from contending while keeping every transaction isolated from TypeORM Repository state and retaining the configured SQLite busy timeout — if wrong, immediate-transaction callers in one process gain queue latency; additional server processes still require SQLite's cross-process locking and should be re-evaluated if multi-process deployment is introduced.
Task 8: follow-up full verification — server 24 suites / 143 passed / 20 todo; web 10 files / 50 passed; full server E2E 5 suites / 52 passed; typecheck, build, diff-check green. Root `npm test` reports missing `test` script for `@filestation/shared`; explicit server and web workspace commands exit 0.
Task 8: follow-up committed as `497fc35` (`fix(server): 修复 TOTP 并发认证的 SQLite 锁饥饿`); only Task 8 files staged, `.claude/settings.local.json` and the untracked Phase 2 plan preserved.

Task 8: final review APPROVED (reviewed commit range `5c9d7e7..497fc35`; original implementation plus SQLite transaction-isolation/starvation fix accepted).

Task 9: started (base `497fc35`; brief `.superpowers/sdd/task-9-brief.md`; scope is TOTP login UI, setup/disable section, and `totp_required` setting only).
Task 9: RED observed — targeted Vitest run: 7 expected failures / 1 existing SettingsPage test passed. LoginPage ignored second-factor challenge (4 new behaviors failed), the duplicate-submit probe sent two password requests, and the SettingsPage had no TOTP section/required checkbox (3 new behaviors failed). The run entered Vitest watch mode despite the initial CLI arguments; subsequent runs will use the explicit `vitest run` command.
Ruling: show TOTP setup/confirm/disable and settings-save feedback inline with accessible `role=alert` / `role=status` regions instead of blocking browser alerts — this keeps errors discoverable to assistive technology and makes the flow usable on mobile without modal interruption — if wrong, the tradeoff is a persistent inline notice where the plan's sample used a transient alert.
Ruling: allow cancelling a pending TOTP setup request and guard stale setup `finally` handlers by generation — navigating/cancelling must not leave an old response able to expose a secret or clear a newer request's in-flight state — if wrong, the cost is one additional explicit cancel control during setup preparation.
Task 9: GREEN — full web Vitest 11 files / 61 passed; server unit 24 suites / 143 passed / 20 todo; Task 8 TOTP E2E 12 passed; typecheck/build/diff-check passed.
Task 9: visual verification limitation — parent-confirmed IAB local page returns `ERR_BLOCKED_BY_CLIENT`; CUA inventory has no available Chrome/Edge. Added responsive layout-contract assertions, but desktop/mobile visual acceptance remains unverified and must be completed in a browser-enabled environment.
Task 9: lint unavailable — repository scripts cannot find the `eslint` executable in server or web workspaces; shared has no lint script. No lint toolchain was installed.
Task 9: implementation/report ready for commit and GPT-5.6 Sol review; see `.superpowers/sdd/task-9-report.md`.
