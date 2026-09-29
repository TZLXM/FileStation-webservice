# FileStation Release and Administrator-Confirmed Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 发布可验证的 Windows/Linux 制品，并让管理员在设置页明确确认后，以可恢复、禁止混合版本写入的方式更新 FileStation。

**Architecture:** 发布侧以提交内的双语结构化 Release Notes 生成 RFC 8785 + Ed25519 签名 manifest 和平台制品；运行侧新增 Node-only `@filestation/update-core` 与独立 `@filestation/updater` workspace。应用负责检查、展示、再认证、全局写栅栏、drain 和 WAL-safe 快照，外部 updater 负责 durable journal、版本目录切换、门控启动、提交或回滚；`COMMITTED` 是唯一不可回滚线性化点。

**Tech Stack:** Node.js 20.17+, TypeScript, NestJS 10, TypeORM/SQLite WAL, React 18/Vite 6, npm workspaces, GitHub Actions, RFC 8785 JSON Canonicalization, Ed25519, Jest/Vitest。

**Spec:** `docs/superpowers/specs/2026-09-29-release-auto-update-design.md`

## Global Constraints

- 第一优先级为 Windows x64 与 Linux x64；Docker 只显示镜像升级说明，禁止容器内自更新和挂载 Docker socket。
- `v0.2.0` 是 Phase 2 功能/自动化基线，但只有 `docs/CURRENT-STATE.md` 中 375px、TOTP/恢复码、刷新续传等人工验收得到记录后才能发布 stable tag。
- `v0.2.5` 包含完善后的 PR #1、发布基础设施、手动 bootstrap、更新检查、管理员确认安装和 Windows/Linux updater；Phase 3 完成后为 `v0.3.0`。
- 根包与三个现有 workspace 的版本保持一致；增加 updater/update-core 后，版本校验覆盖所有 FileStation workspace，但第三方工具依赖不参与产品版本判断。
- 只接受严格更高的 stable SemVer；拒绝同版本、降级和 prerelease。远端不提供自动降级，回滚只使用本机已验证 previous。
- Manifest 协议首版为 `update_protocol: 1`，使用 RFC 8785 canonical JSON 与 Ed25519；私钥只存在 GitHub Release job，仓库和制品只含公钥。
- 第一版绝不自动替换 updater 自身；协议或 `min_updater_version` 不兼容时安全拒绝，并显示手动 bootstrap/updater 升级说明。
- 更新必须由 Bearer 管理员 access JWT 访问，并再次验证密码；启用 TOTP 时同时验证 TOTP。API Token、恢复码和仅 refresh cookie 均不能确认安装。
- 旧/新进程不得同时写同一 SQLite DB 或 storage；SQLite lease 不能替代进程隔离。
- SQLite 备份只允许 `VACUUM INTO` 或等价 backup API，并验证 `integrity_check`/`foreign_key_check`；禁止复制单个 WAL 模式 `.db`。
- Managed 安装必须以安装根为 cwd；错误 cwd、非 current release 和 canonical DB/storage/temp 路径变化在任何目录/DB 写入前失败。
- `.env`、DB 快照、journal 和诊断集合不得进入 Release；Linux 权限为文件 `0600`/目录 `0700`，Windows 使用运行账户与管理员专属 ACL。
- 更新接口、日志、状态、审计和 argv/env 不得记录密码、TOTP、JWT、API Token、capability 明文或 `.env` 内容。
- Nginx 下 `req.ip` 不是本机授权依据；内部 health/promote 以 attempt/fence-bound capability 为权威，Nginx deny 和回环直连只作纵深防御。
- CI/验收显式运行 server unit、server full E2E、Web `vitest --run --no-cache`、typecheck、build、`git diff --check`。根 `npm test` 因 shared 无 test script 非零；lint 在真正安装 ESLint 前不得列为通过项。
- 每个任务先写失败测试、确认 RED、实现最小改动、确认 GREEN，再提交；每个任务更新 `docs/CURRENT-STATE.md` 中实际完成与验证边界，不提前宣称发布完成。

## Review Focus

- 掉电/崩溃发生在 journal intent/completion、current 切换、DB sidecar 隔离、`READY_TO_COMMIT`/`COMMITTED` 之间时，只能执行该阶段唯一安全恢复动作；Task 5、9 的逐阶段 crash-point 测试固定此行为。
- 安装根、DB、temp、备份位于同一 volume，且 WAL 与 migration workspace 同时增长时，按 volume 聚合预算并在维护前复查；Task 5 的 volume planner 测试覆盖。
- 外部请求经 Nginx 看到的 peer 为回环地址时，不能访问 internal health/promote；Task 6/11 的 capability 与 Nginx 配置测试覆盖。
- 旧部署使用相对 DB/storage/temp 且 bootstrap 改变 cwd 时，必须拒绝静默分叉并要求绝对路径或显式迁移；Task 6 的 canonical-path 测试覆盖。
- `install` 响应尚未 finish、promote receipt 响应丢失或重复时，不能自持 lease、自锁或重复提交；Task 8/9 的 202 交接与幂等 receipt 测试覆盖。

---

## File Structure

**发布与版本治理：**

```text
.github/workflows/ci.yml
.github/workflows/release-platform.yml
.github/workflows/release-candidate.yml
.github/workflows/release.yml
release-notes/v0.2.0.json
release-notes/v0.2.5.json
CHANGELOG.md
scripts/release/
  draft-release-notes.mjs
  validate-version.mjs
  validate-release-notes.mjs
  render-release-notes.mjs
  build-manifest.mjs
  package-artifact.mjs
  smoke-artifact.mjs
  *.test.mjs
```

**共享协议与 Node-only 核心：**

```text
packages/shared/src/update-types.ts
packages/shared/src/update-public-key.ts
packages/update-core/
  package.json
  tsconfig.json
  jest.config.json
  src/manifest.ts
  src/release-source.ts
  src/download-policy.ts
  src/archive-policy.ts
  src/index.ts
  src/*.spec.ts
```

**独立 updater/launcher：**

```text
apps/updater/
  package.json
  tsconfig.json
  jest.config.json
  src/cli.ts
  src/launcher.ts
  src/bootstrap/bootstrap-command.ts
  src/bootstrap/path-plan.ts
  src/state/attempt-journal.ts
  src/state/update-lock.ts
  src/state/boot-identity.ts
  src/platform/durable-fs.ts
  src/platform/current-link.ts
  src/platform/volume-space.ts
  src/update/orchestrator.ts
  src/update/rollback.ts
  src/update/capability.ts
  src/update/retention.ts
  src/**/*.spec.ts
scripts/bootstrap-update.ps1
scripts/bootstrap-update.sh
scripts/start-filestation.ps1
scripts/start-filestation.sh
```

**服务端更新模块与启动门控：**

```text
apps/server/src/bootstrap/managed-preflight.ts
apps/server/src/bootstrap/startup-mode.ts
apps/server/src/maintenance/maintenance.module.ts
apps/server/src/maintenance/write-barrier.service.ts
apps/server/src/maintenance/write-barrier.interceptor.ts
apps/server/src/maintenance/maintenance-allowed.decorator.ts
apps/server/src/updates/updates.module.ts
apps/server/src/updates/updates.controller.ts
apps/server/src/updates/internal-update.controller.ts
apps/server/src/updates/update-check.service.ts
apps/server/src/updates/update-prepare.service.ts
apps/server/src/updates/update-install-coordinator.ts
apps/server/src/updates/database-snapshot.service.ts
apps/server/src/updates/shutdown-coordinator.ts
apps/server/src/updates/update-reauth.service.ts
apps/server/src/updates/dto/install-update.dto.ts
apps/server/src/update-validation.module.ts
```

**Web、部署与文档：**

```text
apps/web/src/lib/base-url.ts
apps/web/src/lib/maintenance.ts
apps/web/src/pages/settings/UpdateSection.tsx
apps/web/src/components/MaintenanceOverlay.tsx
apps/web/src/lib/asset-recovery.ts
docs/UPDATING.md
deploy/nginx/filestation.conf
deploy/README.md
README.md
docs/CURRENT-STATE.md
```

---

### Task 1: Repair CI and Make Versioned Release Gates Executable

**Files:**
- Modify: `.github/workflows/ci.yml:1-43`
- Create: `scripts/ci/verify-release-gate.mjs`
- Create: `scripts/ci/verify-release-gate.test.mjs`
- Create: `release-evidence/v0.2.0.json`
- Modify: `package.json:7-18`
- Modify: `docs/CURRENT-STATE.md:84-88,176-179`

**Interfaces:**
- Produces: `npm run verify:release-gate -- --version <semver>`，按版本读取受 schema 校验的 `release-evidence/v<semver>.json`；所有发布都要求 candidate source commit/run/platform digests，`v0.2.0` 另要求 Phase 2 人工项，`v0.2.5` 另要求更新系统跨平台项；未知版本、字段或未通过证据一律非零退出。
- Produces: PR/master CI 的权威命令集合，供 Task 2 的 tag workflow 复用。

- [ ] **Step 1: Write failing Node tests for branch and release-gate parsing**

在 `verify-release-gate.test.mjs` 固定断言：`v0.2.0` 缺少 candidate provenance/digest 或遇到任一 375px、TOTP/恢复码、刷新续传证据未通过时失败；全部记录且保留已知风险时通过。预置 `v0.2.5` schema fixture，证明它既不能借用 Phase 2 字段绕过更新验收，也必须提供自己的 candidate provenance/digest；未知版本/schema/额外字段 fail closed。`CURRENT-STATE` 只链接证据与描述边界，脚本不得解析自由文本中的 “Pending”。

- [ ] **Step 2: Run the tests and observe RED**

Run: `node --test scripts/ci/verify-release-gate.test.mjs`
Expected: FAIL because the gate module does not exist.

- [ ] **Step 3: Implement the release-gate script and explicit CI commands**

`ci.yml` 同时监听 `master` 的 push/PR，设置足够的 fetch depth，删除当前不可用 lint 与根 `npm test`，依次运行：server unit、server E2E、Web no-cache、typecheck、build、diff-check。PR 对 merge-base…HEAD 执行 `git diff --check`，本地仍对工作树执行同名检查；脚本只解析结构化证据，不把自动化记录当人工验收。

- [ ] **Step 4: Verify targeted tests and workflow text**

Run: `node --test scripts/ci/verify-release-gate.test.mjs`
Expected: PASS.

Run: `rg -n "branches: \[master\]|test:e2e|--no-cache|diff --check" .github/workflows/ci.yml`
Expected: all required commands present; no `npm run lint` or root `npm test` step.

- [ ] **Step 5: Run the repository CI command set**

Run the six commands from Global Constraints. Expected: all exit 0; record exact counts in CURRENT-STATE. Do not tag `v0.2.0` while the manual gate still fails.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml scripts/ci release-evidence/v0.2.0.json package.json docs/CURRENT-STATE.md
git commit -m "fix(ci): run release checks on master"
```

### Task 2: Add Bilingual Release Metadata, Version Synchronization, and Signed Platform Artifacts

**Files:**
- Create: `.github/workflows/release-platform.yml`
- Create: `.github/workflows/release-candidate.yml`
- Create: `.github/workflows/release.yml`
- Create: `release-notes/v0.2.0.json`
- Create: `CHANGELOG.md`
- Create: `scripts/release/draft-release-notes.mjs`
- Create: `scripts/release/validate-version.mjs`
- Create: `scripts/release/validate-release-notes.mjs`
- Create: `scripts/release/render-release-notes.mjs`
- Create: `scripts/release/build-manifest.mjs`
- Create: `scripts/release/package-artifact.mjs`
- Create: `scripts/release/smoke-artifact.mjs`
- Create: `scripts/release/create-smoke-db.mjs`
- Create: `scripts/release/release-tools.test.mjs`
- Create: `packages/shared/src/update-types.ts`
- Create: `packages/shared/src/update-public-key.ts`
- Modify: `packages/shared/src/index.ts:1`
- Modify: root and three existing workspace `package.json` versions
- Modify: `package-lock.json`
- Modify: `docs/CURRENT-STATE.md`

**Interfaces:**
- Produces: `UpdateManifestV1`, `UpdateArtifact`, `LocalizedReleaseSummary`, `UpdateStage`, `UpdateStatusResponse`, `UPDATE_PROTOCOL_VERSION = 1` from `@filestation/shared`.
- Produces: `npm run release:validate`, `release:notes`, `release:manifest`, `release:package`, `release:smoke`.
- Produces: reusable unsigned platform build/smoke workflow；PR/`workflow_dispatch` candidate workflow records source commit, run ID and artifact SHA-256 without signing or publishing a GitHub Release, while tag workflow reuses the same build definition.
- Produces: signed `update-manifest.json` + raw 64-byte Ed25519 `update-manifest.json.sig`, Windows/Linux x64 archives, and one bilingual GitHub Release body.
- Consumes: Task 1 release gate and CI commands.

- [ ] **Step 1: Write failing release-tool tests**

覆盖版本/tag/workspace 不一致、空分类省略、zh-CN/en 事实分类及稳定 item ID 配对、patch `breaking_changes=false`、初始 tag migration=true、prior stable tag 选择、非线性/不可达 tag fail closed、manifest RFC8785 确定性、Ed25519 篡改/非 64-byte 签名/多余字节拒绝、artifact URL/size/hash 字段。

- [ ] **Step 2: Run the release-tool tests and observe RED**

Run: `node --test scripts/release/release-tools.test.mjs`
Expected: FAIL because tools and shared types are missing.

- [ ] **Step 3: Define protocol types and structured release-note schema**

`release-notes/v0.2.0.json` 只包含非空中英文分类，并以 `release_summaries` 保存两种语言的事实分类；同时显式保存 `database_migration`、`breaking_changes`、`minimum_node: "20.17.0"`、`requires_manual_bootstrap: true`、`automatic_update_from: "0.2.5"`、`update_protocol: 1`、`min_updater_version` 与 migration workspace fields。私钥格式固定为 GitHub secret 中的 base64 PKCS#8 Ed25519 key；对应 base64 SPKI 公钥固定在 `update-public-key.ts`，server/updater 不从远端或可写配置替换信任根。

`draft-release-notes.mjs` 从上一个可达 stable tag 到 HEAD 的 Conventional Commits/PR metadata 生成带稳定 item ID 的中英文待编辑初稿；校验器要求同一事实的两种语言共用 item ID，但不会机器翻译或把未审阅初稿直接发布。

- [ ] **Step 4: Implement render, validation, manifest, packaging, and smoke tools**

平台 artifact 保持 spec 的可重定位目录契约，包含构建产物、锁定 production dependencies 和启动文件，不含 data/.env/log/test。`create-smoke-db.mjs` 用 artifact 内 server 的 TypeORM migrations 离线创建已初始化但不含真实账户/凭据的临时库；Smoke tool 在任意临时绝对路径、安装根 cwd 下加载 sqlite3/bcrypt、读取版本，以该 DB 和临时 storage/temp 启动并请求 `/api/v1/settings/public` 后退出。它捕获 stdout/stderr、拒绝初始化 Token/secret 模式且仅在失败时输出脱敏摘要；Task 9 完成后再追加内部 gated health smoke。

- [ ] **Step 5: Implement the tag workflow**

`release-platform.yml` 以 `workflow_call` 接收精确 source commit/version，固定 Node/npm、`SOURCE_DATE_EPOCH`、归档顺序/mtime/权限并在 `windows-latest`/`ubuntu-latest` build/smoke；输出每个平台 artifact SHA-256。`release-candidate.yml` 供 PR 和 `workflow_dispatch` 调用 reusable workflow，只上传无签名候选制品及 provenance，不接触签名 secret、不创建 Release。

`release.yml` 仅响应 `v*` tag；先执行 Task 1 全套检查与目标版本 release gate，读取 evidence 的 candidate source commit/run/digests，只允许 candidate→tag 之间改变 release evidence/CURRENT-STATE 等明确非制品输入，再以 candidate source commit 调用同一 reusable build。重建 digest 必须与 evidence 完全一致，之后才由最小权限 signing job 在 GitHub protected environment（required reviewers）中使用签名 secret 生成 manifest/Release，且仅签名步骤可见 secret。任何 provenance/digest/notes/manifest/tag/version 不一致均不得创建 Release。

- [ ] **Step 6: Verify RED-to-GREEN and deterministic output**

Run: `node --test scripts/release/release-tools.test.mjs`
Expected: fixture key/time 的两次 render/build 产生完全相同 notes/manifest bytes，且 draft item ID 配对、签名长度和 smoke 输出保密断言通过。

- [ ] **Step 7: Commit and build the unsigned v0.2.0 candidate**

把根包与三个现有 workspace 设为 `0.2.0`，更新 lockfile/CURRENT-STATE，并让 `release-evidence/v0.2.0.json` 的 Phase 2 与 candidate 字段保持明确 pending。Commit/push Release PR 后，对该精确 head SHA 运行 `release-candidate.yml`；此时 `npm run verify:release-gate -- --version 0.2.0` 预期仍非零，不得创建 tag。

```bash
git add .github/workflows/release-platform.yml .github/workflows/release-candidate.yml .github/workflows/release.yml release-notes release-evidence/v0.2.0.json CHANGELOG.md scripts/release packages/shared package.json apps/*/package.json package-lock.json docs/CURRENT-STATE.md
git commit -m "feat(ci): prepare FileStation v0.2.0 candidate"
```

- [ ] **Step 8: Complete Phase 2 acceptance against the exact candidate**

Download Windows/Linux candidate artifacts by workflow run ID and verify their SHA-256。Use those exact bytes for the pending 375px、TOTP/恢复码、刷新续传 manual checks；record candidate source commit, run ID, both platform digests, operator/date/result and known residual risks in `release-evidence/v0.2.0.json`。Follow-up commit may change only that evidence file and the evidence/status portion of CURRENT-STATE；candidate→HEAD artifact-input diff must be empty。

```bash
git add release-evidence/v0.2.0.json docs/CURRENT-STATE.md
git commit -m "docs: record v0.2.0 release acceptance"
```

- [ ] **Step 9: Publish only after the v0.2.0 gate and digest match**

Run `npm run verify:release-gate -- --version 0.2.0` and require exit 0, review/merge the Release PR, then create `v0.2.0` on that merge commit。Tag workflow rebuilds the recorded candidate source through `release-platform.yml`, compares both artifact digests byte-for-byte with evidence, then signs/publishes；any candidate provenance, artifact-input diff or digest mismatch stops the Release。

### Task 3: Complete PR #1 with One Canonical Base-Path Source

**Files:**
- Create: `apps/web/src/lib/base-url.ts`
- Create: `apps/web/src/__tests__/base-url.test.ts`
- Modify: `apps/web/vite.config.ts:1-24`
- Modify: `apps/web/index.html:1-12`
- Modify: `apps/web/src/App.tsx:30-68`
- Modify: `apps/web/src/lib/api.ts:1-120`
- Modify: `apps/web/src/pages/SharePage.tsx:48-64`
- Modify: `apps/web/src/components/ShareCreateDialog.tsx:30-52`
- Modify: `apps/web/src/components/FileList.tsx:95-108`
- Modify: `apps/web/src/pages/settings/AgentSection.tsx:19-31`
- Modify: relevant Web tests for API/share/MCP URLs
- Modify: `deploy/nginx/filestation.conf`
- Modify: `deploy/README.md`

**Interfaces:**
- Produces: `normalizeBasePath(baseUrl: string): string`, `withBasePath(path: string): string`, `absoluteAppUrl(path: string): string`, `apiPath(path: string): string`.
- Uses: Vite built-in `import.meta.env.BASE_URL` as the only browser source; build-time `FILESTATION_BASE` only sets Vite `base`.
- Replaces: PR #1's independent `FILESTATION_BASE`, `VITE_API_BASE`, and `VITE_BASE_PATH` runtime decisions.

- [ ] **Step 1: Write failing root/subpath URL tests**

断言 root 与 `/fs/` 下 API、BrowserRouter basename、share copy/list URL、ticket URL、MCP URL、favicon/assets 都使用同一前缀；双斜杠、缺前导/尾随斜杠被规范化；外部 absolute URL 不可被拼接为站内路径。

- [ ] **Step 2: Run focused Web tests and observe RED**

Run: `cd apps/web; npx vitest run src/__tests__/base-url.test.ts src/__tests__/api.test.ts src/__tests__/SharePage.test.tsx src/__tests__/FileList.test.tsx src/__tests__/AgentSection.test.tsx --no-cache`
Expected: FAIL for `/fs/` expectations.

- [ ] **Step 3: Implement the canonical helper and migrate every URL callsite**

Vite config maps normalized `FILESTATION_BASE` to `base`; browser code derives all internal paths from `BASE_URL`. Server responses remain canonical relative paths (`/s/:id`, `/api/v1/...`); Web alone applies deployment prefix. BrowserRouter receives normalized basename without trailing slash.

- [ ] **Step 4: Add root and `/fs/` Nginx examples**

Subpath `location /fs/api/` strips `/fs` before proxying; `location /fs/` serves the matching build. Do not add CORS or trust proxy. Preserve initialization restrictions under both paths.

- [ ] **Step 5: Run focused and full Web verification**

Run focused command from Step 2, then `cd apps/web; npx vitest run --no-cache`, `npm run typecheck`, `npm run build --workspace=@filestation/web`, and `npx cross-env FILESTATION_BASE=/fs/ npm run build --workspace=@filestation/web`. Expected: all pass and built asset references begin with the selected base.

- [ ] **Step 6: Commit**

```bash
git add apps/web deploy docs/CURRENT-STATE.md
git commit -m "fix(web): unify root and subpath URLs"
```

### Task 4: Implement Node-Only Manifest Verification and Release Selection

**Files:**
- Create: `packages/update-core/package.json`
- Create: `packages/update-core/tsconfig.json`
- Create: `packages/update-core/jest.config.json`
- Create: `packages/update-core/src/manifest.ts`
- Create: `packages/update-core/src/release-source.ts`
- Create: `packages/update-core/src/download-policy.ts`
- Create: `packages/update-core/src/archive-policy.ts`
- Create: `packages/update-core/src/index.ts`
- Create: `packages/update-core/src/*.spec.ts`
- Modify: `package-lock.json`
- Modify: root `package.json`

**Interfaces:**
- Produces: `verifyManifest(bytes: Buffer, signature: Buffer, publicKey: KeyObject): VerifiedManifestV1`.
- Produces: `selectUpdate(manifest, currentVersion, platform, arch, updaterVersion): UpdateDecision`.
- Produces: `validateReleaseAssetUrl(url, expectedRepository): URL` and bounded redirect/size policy.
- Produces: `openVerifiedArchive(path, digest): Promise<VerifiedArchiveHandle>`, `inspectArchive(handle, limits): Promise<VerifiedArchivePlan>` and `extractVerifiedArchive(handle, plan, destination)`；inspect/extract share one read-only no-follow handle bound to file identity/size/hash, and Windows rejects reparse-point sources. Canonical member paths stay inside a new empty destination and reject symlink/hardlink/device/FIFO/socket, duplicate/case-colliding names, reserved install paths, per-file/entry-count/total-unpacked overflow and declared-vs-observed size mismatch.
- Consumes: Task 2 shared protocol types.
- `packages/update-core/package.json` 初始版本与当前产品版本一致，并直接声明 canonicalization/SemVer 依赖；不得依赖偶然的 transitive package。

- [ ] **Step 1: Write failing verifier/selection tests**

覆盖 canonicalization、签名/篡改、unknown fields/version/protocol、stable SemVer、同版本/降级/prerelease、OS/arch、Node floor、`min_updater_version`、migration workspace 数值边界、非 GitHub HTTPS/跨主机 redirect/超限响应。Archive fixtures 覆盖 `../`/绝对路径、Windows drive/UNC、canonical escape、symlink/hardlink/device/FIFO/socket、重复和大小写冲突、保留的 `data/.env/updater`、单文件/entry-count/总解压超限、压缩炸弹声明不一致及安全 archive；inspect 后替换 path 或 Windows reparse point 不能改变已绑定 handle 的输入，否则 fail closed。

- [ ] **Step 2: Run tests and observe RED**

Run: `npm test --workspace=@filestation/update-core -- --runInBand`
Expected: FAIL because package implementation is missing.

- [ ] **Step 3: Implement strict parsing before policy evaluation**

拒绝未识别协议与不安全数字；校验签名后才信任 URL/size/hash。Release source 使用 injectable fetch，默认只访问官方 stable Release manifest/signature；测试不得访问网络。Archive 先完整验证 member metadata 与预算，再流式写入同卷随机空 staging；每个输出文件以 no-follow/exclusive create 打开并在写入时再次计数，失败只删除该受控 staging 根。

- [ ] **Step 4: Run unit/type/build checks**

Run: `npm test --workspace=@filestation/update-core -- --runInBand`
Expected: PASS.

Run: `npm run typecheck --workspace=@filestation/update-core && npm run build --workspace=@filestation/update-core`
Expected: exit 0.

更新根 build/typecheck scripts，使顺序显式为 shared → update-core → 现有 server/web；随后运行 `npm run build` 并断言 `packages/update-core/dist` 存在。Task 5 再把 updater 插入该显式依赖图。

- [ ] **Step 5: Commit**

```bash
git add packages/update-core package.json package-lock.json docs/CURRENT-STATE.md
git commit -m "feat(updater): verify signed update manifests"
```

### Task 5: Build Durable Journal, Locking, Platform Switching, and Volume Planning

**Files:**
- Create: `apps/updater/package.json`, `tsconfig.json`, `jest.config.json`
- Create: `apps/updater/src/state/attempt-journal.ts`
- Create: `apps/updater/src/state/update-lock.ts`
- Create: `apps/updater/src/state/boot-identity.ts`
- Create: `apps/updater/src/platform/durable-fs.ts`
- Create: `apps/updater/src/platform/current-link.ts`
- Create: `apps/updater/src/platform/volume-space.ts`
- Create: corresponding `*.spec.ts`
- Modify: root `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `AttemptJournal.open(root): Promise<AttemptJournal>`, `appendIntent`, `appendCompletion`, `readSnapshot`.
- Produces: `writeStatusProjection(snapshot): Promise<void>`；`update-status.json` 不含凭据且可完全从 journal 重建。
- Produces: `UpdateLock.acquire(root, owner): Promise<LockHandle>` and `acquireRecovery(root): Promise<LockHandle>` with monotonic fencing token.
- Produces: `BootIdentityProvider.current(): Promise<BootIdentity>`; Linux `/proc/sys/kernel/random/boot_id`, Windows canonical `LastBootUpTime`.
- Produces: `CurrentLinkSwitcher.switchTo(target, attempt)` and `recover(snapshot)` using injected durable filesystem.
- Produces: `planRequiredSpace(paths, manifest, sqliteMetrics): Promise<VolumePlan[]>` grouped by actual volume ID.
- `apps/updater/package.json` 直接依赖 `dotenv`、`@filestation/shared` 与 `@filestation/update-core`，初始版本与当前产品版本一致；不得依赖 `@nestjs/config` 的传递 dotenv。

- [ ] **Step 1: Write failing journal and torn-write tests**

使用 fake durable filesystem 覆盖 partial tail、checksum mismatch、sequence rollback、intent without completion、file flush failure、POSIX parent fsync、Windows `FlushFileBuffers` obligation；status projection must rebuild from journal.

- [ ] **Step 2: Write failing lock/identity tests**

覆盖两个进程同时 `O_CREAT|O_EXCL` 获取 owner record、stale takeover recovery-lock race、fencing old writer rejection、PID reuse、boot identity mismatch/unavailable fail closed、unrelated process owning service port。正常 handoff 中旧应用保留 owner record 直至退出；designated waiting updater 只能在独占 recovery lock 下确认旧 PID/创建时间死亡、匹配 handoff identity，并以 intent/completion 原子替换 owner record、追加更高 fence 后成为 journal owner。覆盖第三方竞争、旧 owner 延迟恢复、updater 在替换/加 fence 前后崩溃，任何无匹配 handoff identity 的竞争者均不能推进 attempt。

- [ ] **Step 3: Write failing link-switch crash-point tests**

Linux temp symlink + rename；Windows new junction、old→previous、new→current 各 intent/completion 间崩溃；每种实际 filesystem combination 只有一个 recovery result，未确定时不得启动任一 release。

- [ ] **Step 4: Write failing volume-plan tests**

覆盖 install/DB/temp/backups 同卷与分卷、WAL/SHM、snapshot、restore temp、artifact compressed/unpacked bytes、migration `max(logical page bytes,snapshot,db file) × multiplier`、安全余量与维护前二次检查。

- [ ] **Step 5: Run all updater primitive tests and observe RED**

Run: `npm test --workspace=@filestation/updater -- --runInBand`
Expected: FAIL because journal, locking, link switching, and volume planning are not implemented.

- [ ] **Step 6: Implement the minimal durable primitives**

Journal 是单写者 append-only records；owner record 与独立 recovery lock 均使用 Windows/Linux 可用的同卷 `O_CREAT|O_EXCL` primitive。普通 unlink 永不授予所有权；handoff/recovery 必须先持 recovery lock，再依据 journal intent/completion 可恢复地归档旧 owner、创建并 flush 新 owner、追加新 fence。旧应用到 updater 的交接必须校验 attempt、旧 fence、boot/PID creation 和 inherited handoff identity；后续 capability、journal 与新进程全部绑定新 fence。所有破坏性文件操作先 intent/flush 后执行，再 completion/flush。平台 API 通过接口注入，Linux runner 不伪装验证 Windows syscall，但必须验证 Windows command/sequence adapter。

- [ ] **Step 7: Run updater unit/type/build checks**

Run: `npm test --workspace=@filestation/updater -- --runInBand`
Expected: PASS.

Run: `npm run typecheck --workspace=@filestation/updater && npm run build --workspace=@filestation/updater`
Expected: exit 0.

更新根 build/typecheck scripts 为 shared → update-core → updater → server → web，并运行 `npm run build`；断言 `apps/updater/dist` 与 `packages/update-core/dist` 同时存在，不依赖 npm workspace 的未承诺顺序。

- [ ] **Step 8: Commit**

```bash
git add apps/updater package.json package-lock.json docs/CURRENT-STATE.md
git commit -m "feat(updater): add durable update primitives"
```

### Task 6: Add Managed Bootstrap, Stable Launcher, and Pre-Write Startup Validation

**Files:**
- Create: `apps/updater/src/bootstrap/bootstrap-command.ts`
- Create: `apps/updater/src/bootstrap/path-plan.ts`
- Create: `apps/updater/src/launcher.ts`
- Create: `apps/updater/src/cli.ts`
- Create: related updater specs
- Create: `scripts/bootstrap-update.ps1`, `scripts/bootstrap-update.sh`
- Create: `scripts/start-filestation.ps1`, `scripts/start-filestation.sh`
- Create: `scripts/bootstrap-scripts.test.mjs`
- Create: `apps/server/src/bootstrap/managed-preflight.ts`
- Create: `apps/server/src/bootstrap/startup-mode.ts`
- Create: `apps/server/src/bootstrap/bootstrap-snapshot.ts`
- Create: corresponding server specs
- Modify: `apps/server/src/main.ts:1-119`
- Modify: `apps/server/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces CLI: `filestation-updater bootstrap|launch|status|recover`.
- Produces: `loadInstallEnvironment(root): LaunchEnvironment` where process env wins over root `.env`.
- Produces: `validateManagedLaunch({cwd, executableRealpath, installMetadata, currentRealpath, configuredPaths}): ManagedLaunchPlan` before mkdir/DB/importing AppModule.
- Produces: bootstrap migration plan containing old/new canonical DB/storage/temp paths and explicit admin resolution for changes.
- Produces: protected bootstrap backup containing a manifest plus the recoverable legacy source tree and separate `.env` copy；exclude only `.git`, caches/logs and runtime `data/storage/temp` that are preserved by canonical path, never the files required to rebuild/restart the old deployment.
- Produces: `node apps/server/dist/bootstrap/bootstrap-snapshot.js --db <canonical-db> --out <protected-snapshot>`，由 server workspace 的直接 `sqlite3` 依赖执行初次 bootstrap 快照；updater 自身不引入 sqlite3。

- [ ] **Step 1: Write failing launcher/preflight tests**

覆盖 `.env` before module import、process env precedence、wrong cwd、direct old release、`current/` cwd、missing/bad metadata、relative custom path changing target、absolute path preservation、no filesystem writes before validation failure。

- [ ] **Step 2: Write failing bootstrap tests**

覆盖 idempotence、old PID still alive rejection、server bootstrap-snapshot helper `VACUUM INTO`/integrity/foreign-key failure、default data preservation、custom canonical paths、Windows ACL/Linux mode plan、Nginx instructions without modification/reload、rollback before current creation。另覆盖 legacy source + `.env` 备份 manifest、排除项、按卷空间预算、恢复旧启动方式及 bootstrap 中途失败不破坏原目录。

- [ ] **Step 3: Run launcher/bootstrap/preflight tests and observe RED**

Run: `npm test --workspace=@filestation/updater -- --runInBand src/bootstrap/bootstrap-command.spec.ts src/bootstrap/path-plan.spec.ts src/launcher.spec.ts`

Run: `npm test --workspace=@filestation/server -- --runInBand bootstrap/managed-preflight.spec.ts bootstrap/startup-mode.spec.ts bootstrap/bootstrap-snapshot.spec.ts`

Expected: FAIL because managed launch and bootstrap interfaces are missing.

- [ ] **Step 4: Refactor main entry to load environment and validate before static imports**

`main.ts` first loads managed environment/preflight, then dynamically imports `AppModule`; legacy source deployment without `managed-install.json` retains current behavior。Managed launch sets install ID/root/release realpath and refuses old release before any `mkdir`。正常 server 调用 `app.enableShutdownHooks()`；bootstrap-snapshot 是独立 CLI，不导入/启动 Nest 应用。

- [ ] **Step 5: Implement thin platform scripts**

Scripts locate Node 20.17+, resolve their own root, call updater CLI, never echo secrets, and provide `--help` with manual bootstrap/restore commands. Release archive contains built updater; source bootstrap may use the locally built workspace.

- [ ] **Step 6: Run focused tests and platform syntax checks**

Run: `npm test --workspace=@filestation/updater -- --runInBand src/bootstrap/bootstrap-command.spec.ts src/bootstrap/path-plan.spec.ts src/launcher.spec.ts`

Run: `npm test --workspace=@filestation/server -- --runInBand bootstrap/managed-preflight.spec.ts bootstrap/startup-mode.spec.ts bootstrap/bootstrap-snapshot.spec.ts`

Run: `node --test scripts/bootstrap-scripts.test.mjs`

Expected: all pass；the Node test invokes PowerShell parser + temp-root dry-run on Windows and `bash -n` + temp-root dry-run on Linux, and asserts no writes outside fixture roots.

- [ ] **Step 7: Commit**

```bash
git add apps/updater apps/server/src/bootstrap apps/server/src/main.ts apps/server/package.json scripts package-lock.json docs/CURRENT-STATE.md
git commit -m "feat(updater): add managed bootstrap and launcher"
```

### Task 7: Add Gated Server Startup, Global WriteBarrier, Snapshot, and Durable Handoff

**Files:**
- Create: `apps/server/src/maintenance/*`
- Create: `apps/server/src/updates/database-snapshot.service.ts`
- Create: `apps/server/src/updates/shutdown-coordinator.ts`
- Create: `apps/server/src/maintenance/write-freeze.service.ts`
- Create: `apps/server/src/update-validation.module.ts`
- Create: related unit/E2E tests
- Modify: `apps/server/src/app.module.ts:20-68`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/test/helpers.ts`
- Modify: `apps/server/src/files/storage.service.ts`
- Modify: `apps/server/src/files/file-lifecycle.service.ts`
- Modify: `apps/server/src/files/uploads.service.ts`
- Modify: `apps/server/src/audit/audit.service.ts`
- Modify: `apps/server/src/auth/recovery.service.ts`
- Modify: `apps/server/src/common/database/sqlite-immediate-transaction.service.ts`
- Modify: `apps/server/src/common/database/sqlite-immediate-transaction.module.ts`

**Interfaces:**
- Produces: `WriteBarrierService.acquire(source): WriteLease`, `enterMaintenance(attempt)`, `waitForZero(deadline)`, `abortMaintenance(attempt)`.
- Produces: `@MaintenanceAllowed()` only for side-effect-free update status/internal protocol.
- Produces: `DatabaseSnapshotService.createVerifiedSnapshot(attempt): Promise<SnapshotMetadata>` and `freezeSourceDatabase()`.
- Produces: process-wide `WriteFreezeService` shared by TypeORM/query helpers, `SqliteImmediateTransactionService` and storage writers；after `SNAPSHOT_READY` it rejects every new write connection/transaction and keeps TypeORM connections query-only until exit.
- Produces: `ShutdownCoordinator.handoff(attempt): Promise<never>`; writes `HANDOFF_READY` only after `app.close()` resolves.
- Produces: injectable `HandoffSpawner.startWaiting(attempt, handoffChannel)` contract；Task 7 tests it with a fake, Task 9 wires the real updater `continue --attempt` command.
- Produces startup modes: `normal`, `validate`, `gated`; validate uses minimal module and random loopback port.

- [ ] **Step 1: Write failing barrier/interceptor tests**

所有 current HTTP business routes receive leases; maintenance rejects login/refresh/logout/share access/ticket/API token/recovery/folders/download counter/upload/MCP/settings while status remains readable. Install handoff is not implemented here. No current WebSocket gateway exists; document that any future gateway must acquire `source: 'ws'` before commands.

- [ ] **Step 2: Write failing background/drain tests**

Cron/lifecycle/startup scan/audit purge/recovery cleanup/finalizer acquire background leases；maintenance blocks new work and waits existing leases。Abort before partial close restores scheduling；after partial close only a new old-release process may restore service。

- [ ] **Step 3: Write failing WAL snapshot tests**

Commit data only present in WAL, close barrier, drain, snapshot, verify integrity/FK, then assert snapshot contains the committed row. After `SNAPSHOT_READY`, writes through a TypeORM repository, `DataSource.query`, a newly opened `SqliteImmediateTransactionService` connection and storage writer must each fail。Drain closes any existing immediate transaction before freeze；the service checks the shared frozen latch before every open/BEGIN so per-connection `PRAGMA query_only` cannot be bypassed.

- [ ] **Step 4: Write failing gated-start tests**

Validate mode permits only migration/PRAGMA/version/config/dependency/attempt heartbeat; skips `ensureInitToken`, audit, storage mkdir, startup scan, Cron, recovery, MCP, business controllers and public listen. Gated normal-port mode returns maintenance until matching `COMMITTED` appears.

- [ ] **Step 5: Run maintenance/snapshot/gated-start tests and observe RED**

Run: `npm test --workspace=@filestation/server -- --runInBand maintenance updates/database-snapshot.service.spec.ts update-validation.module.spec.ts`
Expected: FAIL because the barrier, snapshot, and gated modules are missing.

- [ ] **Step 6: Implement maintenance module and explicit background activation**

Register interceptor globally. `StorageService.activate()` and `FileLifecycleService.activate()` replace unconditional gated startup work；Cron methods return before acquiring work when gate closed。`UpdateValidationModule` imports only Config/Database/internal update health dependencies。

- [ ] **Step 7: Implement snapshot and shutdown handoff**

Snapshot destination must be under protected backups; validate safe SQL path before `VACUUM INTO`. Old app calls the injected `HandoffSpawner`, closes Nest, then minimal non-Nest coordinator appends `HANDOFF_READY` and exits. It never writes `OLD_STOPPED`；this task proves the shutdown half with a fake waiting process, while Task 9 supplies the real updater continuation/orchestrator.

- [ ] **Step 8: Run focused server tests**

Run: `npm test --workspace=@filestation/server -- --runInBand maintenance updates/database-snapshot.service.spec.ts common/database/sqlite-immediate-transaction.service.spec.ts files/file-lifecycle.service.spec.ts auth/recovery.service.spec.ts files/uploads.service.spec.ts`

Run: `npm run test:e2e --workspace=@filestation/server -- update-maintenance.e2e-spec.ts`

Expected: PASS and DB/storage zero-write assertions use table snapshots/tree hashes rather than only HTTP 503；all four direct writer paths fail after freeze.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/maintenance apps/server/src/updates apps/server/src/update-validation.module.ts apps/server/src/common/database apps/server/src/{app.module.ts,main.ts} apps/server/test docs/CURRENT-STATE.md
git commit -m "feat(server): add update maintenance and handoff"
```

### Task 8: Add Update Check, Admin Reauthentication, and Public Management API

**Files:**
- Create: `apps/server/src/updates/updates.module.ts`
- Create: `apps/server/src/updates/updates.controller.ts`
- Create: `apps/server/src/updates/update-check.service.ts`
- Create: `apps/server/src/updates/update-prepare.service.ts`
- Create: `apps/server/src/updates/update-install-coordinator.ts`
- Create: `apps/server/src/updates/update-reauth.service.ts`
- Create: `apps/server/src/updates/dto/install-update.dto.ts`
- Create: `apps/server/src/updates/dto/prepare-update.dto.ts`
- Create: corresponding specs/E2E
- Modify: `apps/server/src/app.module.ts`
- Modify: `apps/server/src/auth/auth.module.ts`
- Modify: `apps/server/src/audit/audit.service.ts`
- Modify: `apps/server/src/config/configuration.ts`
- Modify: `apps/server/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Adds: `GET /api/v1/updates/status`, `POST /check`, `POST /prepare`, `POST /install`.
- All four public routes use `@UseGuards(JwtAuthGuard, AdminOnlyGuard)`; API Token principals and refresh-cookie-only requests fail before business logic.
- Produces: `UpdateCheckService.check({force}): Promise<UpdateStatusResponse>` with six-hour jittered cache.
- Produces: `UpdatePrepareService.prepare(selection): Promise<PreparedUpdateReceipt>`；receipt 使用受控随机 `prepared_id` 绑定 manifest digest、artifact digest、version、platform/arch、staging realpath、verified size 与 expiry，install 只消费该 exact receipt，绝不重新解析“latest”。
- Produces: `UpdateReauthService.verify(adminId, password, totpCode, clientIp): Promise<void>`，委托新增的 `AuthService.verifyUpdateConfirmation(...)` facade 复用既有账户锁定、IP 限速和 TOTP step 原子消费；不直接导出/绕过 `TotpService`。
- Produces: `UpdateInstallCoordinator.scheduleAfterResponse(attempt, response): void`; starts only after response `finish` and request lease release.
- Consumes: Tasks 4-7 core, managed detection, barrier, snapshot, updater CLI.
- `apps/server/package.json` declares direct `@filestation/update-core` workspace dependency；production packaging must not rely on root hoisting.

- [ ] **Step 1: Write failing auth/DTO tests**

Bearer admin accepted; API Token principal, cookie-only, wrong password, missing/invalid/replayed TOTP rejected. DTO forbids recovery codes, arbitrary URLs and unknown fields. 覆盖账户锁定、可信 `req.ip` 的现有 IP 限速、并发 TOTP step 仅一次成功；secrets never appear in audit/status/logger mocks.

- [ ] **Step 2: Write failing check/prepare tests**

覆盖 startup async non-blocking、six-hour jitter、manual rate limit、network failure cache、stable-only selection、bootstrap-required/Docker capability、protocol/updater mismatch、platform unsupported、signed bilingual summaries、download redirect/content-length/streamed-size/hash and per-volume preflight。Prepare 必须使用 Task 4 archive policy，拒绝 traversal/type/duplicate/reserved-path/size-limit，解压到同卷随机 staging，失败只清理该 staging；receipt 精确绑定已验证 bytes，manifest/latest 改变、receipt 篡改/过期/平台变化均不能 install。

Docker/unsupported/unmanaged 分类在 server 端 fail closed：伪造 UI 请求调用 prepare/install 也不得创建 attempt、下载或启动 updater。

- [ ] **Step 3: Write failing install 202 handoff test**

Assert controller consumes one exact `prepared_id`, returns `202` + attempt ID before `MAINTENANCE`; coordinator cannot close barrier while install request lease is active; response failure/restart leaves cancellable `PREPARED` and requires fresh reauth。重复或并发消费同一 receipt 只有一次成功。

- [ ] **Step 4: Run update API tests and observe RED**

Run: `npm test --workspace=@filestation/server -- --runInBand updates`

Run: `npm run test:e2e --workspace=@filestation/server -- updates.e2e-spec.ts`

Expected: FAIL because update management routes and services are missing.

- [ ] **Step 5: Implement service/controller and audit actions**

Add explicit audit actions for check/prepare/confirm/maintenance/failure/rollback/success。Old-version pre-backup events write before barrier closes；post-handoff events remain non-sensitive journal records until recovered version writes audit。

- [ ] **Step 6: Run unit and E2E checks**

Run: `npm test --workspace=@filestation/server -- --runInBand updates`

Run: `npm run test:e2e --workspace=@filestation/server -- updates.e2e-spec.ts`

Run: `npm ls @filestation/update-core --workspace=@filestation/server --omit=dev`

Expected: all pass, including archive/staging/TOCTOU、account/IP/TOTP、server-side Docker refusal、admin-only principal behavior and install self-lease regression；npm dependency tree shows a production direct workspace dependency。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/updates apps/server/src/{app.module.ts,config} apps/server/src/auth apps/server/src/audit apps/server/package.json apps/server/test package-lock.json docs/CURRENT-STATE.md
git commit -m "feat(server): expose administrator-confirmed updates"
```

### Task 9: Implement External Update Orchestration, Capabilities, Commit, and Rollback

**Files:**
- Create: `apps/updater/src/update/orchestrator.ts`
- Create: `apps/updater/src/update/rollback.ts`
- Create: `apps/updater/src/update/capability.ts`
- Create: `apps/updater/src/update/retention.ts`
- Create: related updater specs
- Create: `apps/server/src/updates/internal-update.controller.ts`
- Create: `apps/server/src/updates/update-audit-reconciler.ts`
- Create: internal controller/capability specs
- Modify: `apps/updater/src/cli.ts`
- Modify: `apps/server/src/updates/updates.module.ts`
- Modify: `deploy/nginx/filestation.conf`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Internal endpoints: `GET /api/v1/internal/update/health`, `POST /api/v1/internal/update/promote-ready`.
- Header: `X-FileStation-Update-Capability`; never query/argv/env/status. Plaintext travels to child only through inherited anonymous pipe or ACL-protected OS IPC.
- Produces: health capability (read-only/retryable) and promote capability (one logical transition, idempotent READY receipt).
- Produces: `UpdateOrchestrator.run(attempt): Promise<Committed|RolledBack>`; updater is sole journal writer from `OLD_STOPPED` onward.
- Produces CLI additions: `filestation-updater continue --attempt <id>` for Task 7 handoff and `cleanup --bootstrap-backup <id>` for explicit administrator-confirmed `.env`/legacy-source cleanup.
- Produces: durable post-commit restart-verification record and `RetentionService.cleanup(snapshot): Promise<CleanupResult>`；只有匹配 `COMMITTED` 的新版本经历一次独立 launcher restart/health verification 后，才清理未被 current/previous/attempt/snapshot/diagnostic metadata 引用的旧资产。
- Produces: `UpdateAuditReconciler` 将 handoff 后 journal 事件在恢复版本首次启动时按 `(attempt_id,event)` 幂等写入审计；门控期间不写 audit，重复启动/崩溃重试不重复记录。

- [ ] **Step 1: Write failing capability tests**

覆盖 attempt/fence/purpose/method/expiry、constant-time mismatch、health retry、promote deterministic canonical receipt、response loss/retry、changed schema/result rejection、no secret serialization/logging。并先创建 internal endpoint E2E/Nginx fixture：无 capability 即使来自 loopback 也失败、wrong-purpose 失败、admin JWT 不能 promote，root 与 `/fs/` internal path 都被 exact deny。

- [ ] **Step 2: Write failing state-machine crash matrix**

为 spec 表中 PREPARED、MAINTENANCE、SNAPSHOT_READY、HANDOFF_READY、OLD_STOPPED、SWITCH_INTENT/CURRENT_SWITCHED、MIGRATED_VERIFIED、READY_TO_COMMIT、COMMITTED、ROLLBACK_* 的每个 intent/completion 间注入 crash。Assert pre-COMMITTED can restore verified snapshot/previous；post-COMMITTED only restarts new release。

- [ ] **Step 3: Write failing DB sidecar rollback tests**

Updater waits all new processes exit, moves `.db/-wal/-shm/-journal` as one diagnostic set, flushes restore temp, performs platform rename sequence, never combines diagnostic sidecars with snapshot, and retains sole recoverable snapshot。

同时覆盖 retention：始终保留 current + previous、活动/唯一可恢复/最近 pre-update 快照；未出现 durable post-commit restart-verification 时不得清理；最新失败诊断必须管理员确认，其他诊断最多两份；bootstrap `.env`/legacy-source 只由带精确 ID 的 `cleanup` 管理员命令删除；空间不足不能删除唯一回滚资产来继续更新。

增加 delayed audit tests：`COMMITTED`/rollback 后首次恢复写一次，写入中崩溃可重试，重复启动不重复；从 `MAINTENANCE` 到 commit/rollback 完成前业务 audit 表保持不变。

- [ ] **Step 4: Run capability/orchestrator/rollback tests and observe RED**

Run: `npm test --workspace=@filestation/updater -- --runInBand src/update`

Run: `npm test --workspace=@filestation/server -- --runInBand updates/internal-update.controller.spec.ts`

Run: `npm run test:e2e --workspace=@filestation/server -- internal-update.e2e-spec.ts nginx-update-deny.e2e-spec.ts`

Expected: FAIL because orchestration, internal protocol, delayed audit and Nginx denial fixture are missing.

- [ ] **Step 5: Implement orchestrator and internal endpoints**

Wire Task 7 `HandoffSpawner` to `filestation-updater continue --attempt`。Sequence: read/validate matching `HANDOFF_READY` → use boot identity, PID creation, heartbeat and port signals to confirm old exit → acquire recovery lock → intent/completion owner replacement and fence++ → append `OLD_STOPPED` → switch current → validation process/migration → gated normal-port process → READY receipt → updater flushes `READY_TO_COMMIT` then `COMMITTED` → app observes commit and activates。Before old exit is proven, owner record, fence and journal stage must not advance。HTTP timeout never decides rollback; journal does。On the next independent launcher start, verify the committed version/health and append restart-verification before retention may run。

- [ ] **Step 6: Implement Nginx denial and delayed audit reconciliation**

Implement the already-red internal endpoint/Nginx fixture and journal-to-audit reconciler。Internal endpoints without capability fail even from loopback peer；wrong-purpose capability fails；normal admin JWT does not grant internal promote。Nginx fixture contains exact deny for root and `/fs/` internal paths。

- [ ] **Step 7: Run updater/server focused suites on both runners**

Run: `npm test --workspace=@filestation/updater -- --runInBand src/update`

Run: `npm test --workspace=@filestation/server -- --runInBand updates/internal-update.controller.spec.ts updates/update-audit-reconciler.spec.ts`

Run: `npm run test:e2e --workspace=@filestation/server -- internal-update.e2e-spec.ts nginx-update-deny.e2e-spec.ts`

Add a Windows/Linux `update-platform` matrix job to `ci.yml` that runs updater lock/link/crash suites。Expected: local focused suites and both hosted runner matrix legs pass, and no mixed-version interval is observable by launcher probes。

- [ ] **Step 8: Commit**

```bash
git add apps/updater/src/update apps/updater/src/cli.ts apps/server/src/updates deploy/nginx/filestation.conf .github/workflows/ci.yml docs/CURRENT-STATE.md
git commit -m "feat(updater): commit or roll back managed updates"
```

### Task 10: Add Settings Update UI, Maintenance Overlay, and Static Cache Recovery

**Files:**
- Create: `apps/web/src/pages/settings/UpdateSection.tsx`
- Create: `apps/web/src/components/MaintenanceOverlay.tsx`
- Create: `apps/web/src/lib/maintenance.ts`
- Create: `apps/web/src/lib/asset-recovery.ts`
- Create: corresponding Web tests
- Modify: `apps/web/src/pages/SettingsPage.tsx:1-230`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/server/src/app.module.ts` serve-static headers
- Modify: `apps/server/test/serve-static.e2e-spec.ts`
- Modify: `deploy/nginx/filestation.conf`

**Interfaces:**
- Produces: `UpdateSection` showing current/latest, bilingual non-empty sections, risk, last check/error, bootstrap/Docker/platform capability, prepare and confirm dialog.
- Produces: `maintenanceStore` driven by global `ApiError(code='UPDATE_MAINTENANCE')` and status polling.
- Produces: `installAssetRecovery()` allowing one session-guarded reload for missing hashed assets.

- [ ] **Step 1: Write failing update-panel tests**

覆盖 no update、available stable、empty categories omitted、bootstrap required、Docker manual instructions、unsupported platform、prepare progress、password/TOTP conditional form、double-submit prevention、202 attempt polling、failure/rollback/success messages。

- [ ] **Step 2: Write failing maintenance/API tests**

Any API `503 UPDATE_MAINTENANCE` opens global overlay, pauses ordinary actions, displays target/retry state and polls read-only status；logout/auth errors are not misclassified。Root and `/fs/` use Task 3 base helper。

- [ ] **Step 3: Write failing cache tests**

ServeStatic/Nginx `index.html` and SPA fallback are `no-store`; hashed assets remain immutable。Missing script/link under assets triggers one reload with session guard；second failure shows recoverable error instead of loop。

- [ ] **Step 4: Run update UI/cache tests and observe RED**

Run: `cd apps/web; npx vitest run src/__tests__/UpdateSection.test.tsx src/__tests__/MaintenanceOverlay.test.tsx src/__tests__/asset-recovery.test.ts src/__tests__/api.test.ts --no-cache`

Run: `npm run test:e2e --workspace=@filestation/server -- serve-static.e2e-spec.ts`

Expected: FAIL because update UI, maintenance handling, and no-store behavior are missing.

- [ ] **Step 5: Implement UI and global handlers**

Settings page keeps update state separate from editable settings payload。Confirm form never stores password/TOTP beyond component state and clears on close/result。Maintenance overlay works while Nginx still serves static shell。

- [ ] **Step 6: Run focused/full Web and serve-static tests**

Run: `cd apps/web; npx vitest run src/__tests__/UpdateSection.test.tsx src/__tests__/MaintenanceOverlay.test.tsx src/__tests__/asset-recovery.test.ts src/__tests__/api.test.ts src/__tests__/SettingsPage.test.tsx --no-cache`

Run: `npm run test:e2e --workspace=@filestation/server -- serve-static.e2e-spec.ts`

Run: `npm run build --workspace=@filestation/web`

Run: `npx cross-env FILESTATION_BASE=/fs/ npm run build --workspace=@filestation/web`

Expected: all pass；root build references `/assets/`, subpath build references `/fs/assets/`, and both server/Nginx fixtures apply `no-store` to index/fallback only。

- [ ] **Step 7: Commit**

```bash
git add apps/web apps/server/src/app.module.ts apps/server/test/serve-static.e2e-spec.ts deploy/nginx/filestation.conf docs/CURRENT-STATE.md
git commit -m "feat(web): add administrator update controls"
```

### Task 11: Integrate Release Packaging, Bootstrap Documentation, and End-to-End Upgrade Fixtures

**Files:**
- Create: `release-notes/v0.2.5.json`
- Create: `release-evidence/v0.2.5.json`
- Create: `docs/UPDATING.md`
- Create: `apps/updater/test/fixtures/` controlled old/new releases
- Create: cross-process integration tests under `apps/updater/test/`
- Modify: `.github/workflows/release-platform.yml`
- Modify: `.github/workflows/release-candidate.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/release/package-artifact.mjs`
- Modify: `scripts/release/smoke-artifact.mjs`
- Modify: `scripts/ci/verify-release-gate.mjs`
- Modify: `scripts/ci/verify-release-gate.test.mjs`
- Modify: `README.md`
- Modify: `deploy/README.md`
- Modify: `deploy/nginx/filestation.conf`
- Modify: `docs/CURRENT-STATE.md`
- Modify: root and all FileStation workspace versions to `0.2.5`
- Modify: `package-lock.json`

**Interfaces:**
- Produces v0.2.5 artifacts containing app, Web, update-core, updater, launcher/bootstrap scripts, production dependencies and public key.
- Produces `docs/UPDATING.md` as the authority for source→managed bootstrap, status/recover, Nginx manual edits, backup retention and Docker manual update.
- Produces a version-aware v0.2.5 evidence schema requiring Windows/Linux bootstrap, confirmed update, pre-COMMITTED rollback, Docker self-update refusal, and Nginx root + `/fs/` acceptance before the tag workflow can publish.
- Consumes all prior tasks.

- [ ] **Step 1: Write failing cross-process upgrade tests**

Fixture `0.2.5 → test release` exercises prepare, barrier/drain, WAL snapshot, old exit, fenced owner transfer, current switch, migration, gated health, READY receipt, COMMITTED activation and post-commit restart verification。Fault variants cover disk-full recheck, old PID alive, migration failure, health failure, promote response loss, updater crash, rollback-start failure and stale attempt recovery。扩展 release-gate fixture，证明 v0.2.5 任一平台/bootstrap/update/rollback/Docker/Nginx 证据缺失即 fail closed，而 v0.2.0 只要求其 Phase 2 schema。

- [ ] **Step 2: Write failing artifact relocation/smoke tests**

Extract each platform archive to a random absolute path, set install-root cwd, verify relative server/web/shared/update-core/updater layout, native sqlite/bcrypt, `.env` precedence, wrong-cwd hard fail, no `data/.env/log/test` members, and archive traversal/type/size limits。

- [ ] **Step 3: Run cross-process/artifact tests and observe RED**

Run: `npm test --workspace=@filestation/updater -- --runInBand test/update-flow.integration.spec.ts test/artifact-smoke.spec.ts`

Run: `node --test scripts/release/release-tools.test.mjs`

Run: `node --test scripts/ci/verify-release-gate.test.mjs`

Expected: FAIL because final artifact composition and end-to-end workflow are incomplete.

- [ ] **Step 4: Extend candidate/tag workflows and structured v0.2.5 notes**

`database_migration` is derived from `v0.2.0..v0.2.5`; workspace values obey numeric contract；notes show only non-empty Chinese/English sections and explicitly explain manual bootstrap。Candidate workflow runs the same platform integration/smoke definition without signing；tag workflow only publishes after rebuilding the recorded candidate source and matching every recorded digest。

- [ ] **Step 5: Write deployment and recovery documentation**

Document Windows/Linux commands, old-process stop, canonical path review, `.env` precedence/permissions, Nginx root/subpath/no-store/internal deny, `updater status/recover`, journal fail-closed behavior, dedicated `updater cleanup --bootstrap-backup <id>` confirmation, legacy-source/.env restore, backup/diagnostic cleanup, Docker Compose/image workflow, and prohibition on manually deleting flags/sidecars。

- [ ] **Step 6: Run complete local pre-candidate verification**

Run the six Global Constraints commands, then:

Run: `npm test --workspace=@filestation/update-core -- --runInBand`

Run: `npm test --workspace=@filestation/updater -- --runInBand`

Run: `node --test scripts/release/release-tools.test.mjs scripts/bootstrap-scripts.test.mjs scripts/ci/verify-release-gate.test.mjs`

Run full/production `npm audit`, record current Critical/High and any accepted Moderate/Low accurately; do not call nonzero audit “green”。At this point `npm run verify:release-gate -- --version 0.2.5` must still fail because real evidence is pending；that failure is expected and must not be bypassed。

- [ ] **Step 7: Commit and build the unsigned release candidate**

Commit/push the Release PR with `release-evidence/v0.2.5.json` explicitly pending, then run `release-candidate.yml` on that exact head SHA. Both `windows-latest` and `ubuntu-latest` legs execute package smoke plus `apps/updater/test/update-flow.integration.spec.ts` and `artifact-smoke.spec.ts` and upload provenance containing candidate commit, workflow run ID and SHA-256。No signing secret or GitHub Release is used。

```bash
git add .github/workflows/release-platform.yml .github/workflows/release-candidate.yml .github/workflows/release.yml release-notes/v0.2.5.json release-evidence/v0.2.5.json docs README.md deploy scripts/release scripts/ci apps/updater/test package.json apps/*/package.json packages/*/package.json package-lock.json CHANGELOG.md
git commit -m "feat(ci): prepare FileStation v0.2.5 candidate"
```

- [ ] **Step 8: Perform real deployment acceptance and commit only evidence**

Download the exact candidate artifacts by recorded run ID/digest。On real Windows and Linux: bootstrap existing source deployment; verify Nginx root and `/fs/`; perform one confirmed update and one pre-COMMITTED rollback drill。On Docker verify UI capability plus direct prepare/install hard refusal and only manual image instructions。Record candidate source commit, run ID, each artifact digest, operator/date/result in `release-evidence/v0.2.5.json` and link it from CURRENT-STATE；do not convert a failure or unperformed item to pass。

This follow-up commit may change only `release-evidence/v0.2.5.json` and the evidence/status portion of `docs/CURRENT-STATE.md`; CI compares candidate→HEAD paths and fails if any artifact input changed。

```bash
git add release-evidence/v0.2.5.json docs/CURRENT-STATE.md
git commit -m "docs: record v0.2.5 release acceptance"
```

- [ ] **Step 9: Tag only after review and all required real acceptance**

Run `npm run verify:release-gate -- --version 0.2.5` and require exit 0, review/merge the PR, then create `v0.2.5` on that merge commit。Tag workflow rejects artifact-input changes since the evidence candidate SHA, rebuilds from the recorded candidate source through `release-platform.yml`, compares both platform digests byte-for-byte with evidence, and only then signs/publishes。Confirm GitHub Release contains only non-empty bilingual categories, signed manifest and both verified artifacts。

---

## Execution Order and Review Gates

1. Tasks 1-2 form the `v0.2.0` release-foundation gate; the stable tag is a human checkpoint and cannot be synthesized from automated tests.
2. Task 3 replaces/completes PR #1; do not merge the PR's three independent base variables unchanged.
3. Tasks 4-6 establish protocol, durable primitives and managed layout before server install endpoints exist.
4. Tasks 7-9 are the safety-critical update path; each requires independent review before the next task because interfaces carry crash-recovery invariants.
5. Task 10 may start after Task 8 API types stabilize, but final maintenance behavior depends on Task 9.
6. Task 11 is the only place allowed to bump to `0.2.5`, perform real upgrade drills and publish the tag.

Each task's review must explicitly distinguish: automated verification, simulated crash testing, real Windows/Linux acceptance, and release publication. Passing an earlier category never implies a later one.
