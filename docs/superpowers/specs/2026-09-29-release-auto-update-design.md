# FileStation 发布与管理员确认更新设计

状态：待用户书面审阅  
日期：2026-09-29  
目标版本：`v0.2.0` 发布基线、`v0.2.5` 更新基础设施  

## 1. 背景与目标

FileStation 当前通过拉取仓库、安装依赖、构建后手动启动；前端可由 Nginx 托管，运行时数据库和文件默认位于仓库根目录下的 `data/`。这种部署方式没有稳定的发布制品、外部进程监督者或可回滚版本目录，不能安全地让正在运行的 Node.js 进程直接覆盖自身。

本设计新增一套发布和更新能力：

- GitHub Release 提供经过验证的 Windows/Linux 发布制品、签名更新清单和中英文 Release Notes。
- FileStation 定期检查 stable Release，在设置页显示可用更新。
- 下载和安装更新必须由管理员明确确认；不做无人值守更新。
- Windows 与 Linux 支持管理员确认后的下载、切换、重启、健康检查和失败回滚。
- Docker 第一阶段只显示新镜像版本和升级说明，不允许容器内自更新，也不挂载 Docker socket。
- 从旧式源码部署迁移到 managed layout 需要一次手动 bootstrap，并在 Release、README 和部署文档中明确说明。

该能力属于发布与运维基础设施，可与 Phase 3 同期开发，但不并入多入口传输的业务范围。Phase 3 的 `public_base_url`、入口选路、跨入口授权、CORS、限速和直链分享仍独立设计与交付。

## 2. 非目标

- 不从 `master` 或其他开发分支直接执行生产更新。
- 不在容器内调用 Docker daemon 或替换容器自身。
- 不支持旧版与新版进程同时写同一个 SQLite 数据库或 storage。
- 不自动修改、重载 Nginx，也不自动修改 Windows/Linux 系统服务。
- 不在 Release、日志、状态文件或审计详情中保存密码、TOTP、JWT、API Token、`.env` 内容或其他凭据。
- 第一版不提供 beta/nightly 更新通道，也不提供 Windows MSI、Linux deb/rpm 安装包。

## 3. 版本策略

四个 workspace 的 `package.json` 使用相同版本号，发布工作流拒绝版本不一致的 tag。

- `v0.2.0`：当前已经完成的 Phase 2，作为第一个正式发布基线。
- `v0.2.5`：完善 PR #1 的 URL/子路径支持，加入发布工作流、更新检测、手动 bootstrap 和 Windows/Linux updater。
- `v0.3.0`：完整 Phase 3。
- `v0.3.1` 及后续 patch：Phase 3 基础上的兼容修复和小更新。
- `v1.0.0`：部署、升级和核心接口达到稳定承诺后再发布。

项目在 `0.x` 阶段采用里程碑驱动版本规则：第二位对应主要开发阶段，第三位可包含该阶段内的功能补充和兼容修复。版本允许从 `0.2.0` 直接跳至 `0.2.5`，无需发布 `0.2.1` 至 `0.2.4`。不兼容变更不得放入 patch，必须提升第二位并在 Release Notes 和 manifest 中标明。

Git tag 必须等于 `v${package.version}`；Release 标题使用 `FileStation v${package.version}`。Updater 只接受严格高于当前版本的 stable SemVer，拒绝同版本重装、降级和 prerelease。人工回滚只允许切换到本机已验证的上一成功版本，不通过远端降级 manifest 实现。

## 4. 发布说明与 CHANGELOG

GitHub Release 和仓库级 `CHANGELOG.md` 使用同一版本内容。发布前先创建 Release PR：根据 Conventional Commits 和 PR 元数据生成双语初稿，同时更新四个 workspace 版本、`CHANGELOG.md` 和版本化 Release Notes 源文件；发布负责人审核并合并后，才允许在该合并提交上创建 tag。Tag workflow 只消费已经提交并审阅的说明，不能在 tag 后生成未进入仓库的另一份内容。

Release Notes 使用中英文双语。分类结构固定，但只展示有实际内容的分类：

- 新增功能 / Features
- 问题修复 / Bug Fixes
- 安全更新 / Security
- 升级说明 / Upgrade Notes
- 不兼容变更 / Breaking Changes
- 已知问题 / Known Issues

例如只有新增与修复时，页面只显示“新增功能、问题修复、Features、Bug Fixes”。空分类不渲染。`feat` 默认进入新增功能，`fix` 默认进入问题修复，安全依赖和安全逻辑修改进入安全更新；`docs`、`test`、`chore` 默认仅进入完整比较链接，除非它们改变部署或升级行为。

即使 Release 页面省略空分类，机器读取的 manifest 仍必须显式包含 `database_migration`、`breaking_changes`、`minimum_node`、`requires_manual_bootstrap` 等固定字段。工作流检查中英文部分表达相同事实，并要求每个 Release 至少明确列出其实际新增、修复或维护内容。

## 5. 发布制品与更新清单

第一阶段发布两个平台制品：

- Windows x64：`filestation-v0.2.5-win-x64.zip`；后续版本替换文件名中的 SemVer。
- Linux x64：`filestation-v0.2.5-linux-x64.tar.gz`；后续版本替换文件名中的 SemVer。

制品在对应 GitHub Actions runner 上构建，包含运行所需的 shared/server/web 构建产物、锁定依赖和启动所需文件，不包含 `.env`、`data/`、日志、测试数据或真实凭据。每个制品必须在全新的临时目录中解压并完成原生依赖加载与启动冒烟测试。其他 CPU 架构只有在发布工作流能够构建并验证相应制品后才加入 manifest。

Release 同时发布 `update-manifest.json` 及其签名。清单字段契约为：

| 字段 | 类型与约束 |
|------|------------|
| `version` | stable SemVer，必须等于 tag 与四个 workspace 版本 |
| `commit` | tag 指向的 40 字符 Git commit SHA |
| `published_at` | UTC ISO-8601 时间 |
| `channel` | 第一版固定为 `stable` |
| `minimum_node` | 最低 Node.js SemVer，`v0.2.5` 为 `20.17.0` |
| `database_migration` | 是否包含数据库迁移 |
| `breaking_changes` | 是否包含不兼容变更；patch 必须为 `false` |
| `requires_manual_bootstrap` | 当前安装是否必须先完成手动 bootstrap |
| `automatic_update_from` | 能使用设置页自动安装的最低版本；第一版为 `0.2.5` |
| `release_notes_url` | 当前 tag 的 GitHub Release HTTPS URL |
| `upgrade_guide_url` | 当前 tag 下版本化 `docs/UPDATING.md` 的 HTTPS URL |
| `artifacts` | 每个平台的 OS、arch、签名资产 URL、精确字节数与 64 位小写十六进制 SHA-256 |

Manifest 按 RFC 8785 JSON Canonicalization Scheme 产生签名字节，并使用 Ed25519 发布私钥签名；应用和 updater 内置对应公钥。签名密钥只存在于受保护的发布环境；仓库和 Release 制品不得包含私钥。下载器只允许签名 manifest 中列出的 GitHub Release HTTPS 资产，限制响应大小、超时和重定向主机，客户端不能提交任意下载 URL。

## 6. Managed Layout 与一次性 Bootstrap

自动更新后的稳定安装布局为：

```text
filestation/
├─ current/                 # Windows junction / Linux symlink
├─ releases/
│  ├─ 0.2.5/
│  └─ 0.3.0/
├─ updater/                 # 独立于应用版本
├─ data/                    # 数据库、storage、temp
├─ .env                     # 可选稳定配置
├─ update-status.json       # 无凭据状态
└─ update.lock              # 更新互斥锁
```

应用始终以安装根目录为工作目录，因此默认 `./data` 路径在版本切换后保持不变。Nginx 静态目录一次性改为 `<install-root>/current/apps/web/dist`。Updater 位于 `current` 外，旧应用退出后仍可工作。

旧式源码部署不能直接点击自动安装 `v0.2.5`。设置页检测到未完成 bootstrap 时只显示“需要手动迁移”和升级文档链接，不显示自动安装按钮。

`v0.2.5` 提供：

- Windows：`bootstrap-update.ps1`
- Linux：`bootstrap-update.sh`

Bootstrap 必须：

- 支持重复执行，已完成时安全退出。
- 要求旧 FileStation 进程已经停止。
- 在变更前备份 SQLite、`.env` 和旧源码目录。
- 保留 `data/` 的稳定路径，不删除、不复制整个 storage。
- 创建 managed layout、安装 `v0.2.5`、建立 `current`，输出新的启动命令。
- 检测 Nginx 配置并打印需要人工执行的修改与验证命令，但不自行修改或 reload Nginx。
- 任一步失败时保留旧源码和数据，使管理员仍可手动恢复启动。

Bootstrap 的权威说明写入 `docs/UPDATING.md`，同时在 `README.md`、`deploy/README.md`、`v0.2.5` 中英文 Release Notes 和脚本 `--help` 中提供摘要与链接。`deploy/nginx/filestation.conf` 更新为 managed layout，并包含根路径和子路径示例。`docs/CURRENT-STATE.md` 记录实际实现和验证边界。

## 7. 更新组件

### 7.1 应用内 UpdateCheckService

- 启动后异步检查，不阻塞 FileStation 启动。
- 默认每 6 小时检查一次，并加入随机抖动。
- 只检查官方 stable GitHub Release。
- 缓存当前版本、最新版本、最后检查时间、错误摘要和平台能力。
- 网络失败不影响文件服务，不进行紧密重试；设置页展示最后检查状态。
- 校验 manifest 签名、SemVer、平台、架构、最低 Node 版本和 bootstrap 要求。

### 7.2 设置页更新面板

显示：

- 当前版本和最新版本。
- 最后检查时间与检查错误。
- 中英文 Release Notes 摘要及完整说明链接。
- 数据库迁移、不兼容变更、最低 Node 版本和预计停机提示。
- 当前环境是自动更新可用、需要 bootstrap，还是 Docker 手动更新。

页面只自动检查和展示，不自动下载。管理员可手动刷新、准备制品并确认安装。

### 7.3 外部 updater 与稳定启动器

Updater 位于安装根目录的 `updater/`，不属于 `current`。Windows 与 Linux 分别提供稳定启动脚本，但共同调用同一套 Node.js updater/launcher 逻辑：

- Windows：`start-filestation.ps1`
- Linux：`start-filestation.sh`

启动器始终从 `current` 运行 server，并将安装根目录设为工作目录。第一版不强制 systemd 或 Windows Service；后续可增加服务配置示例，但不能改变更新协议。

`update-status.json` 通过原子临时文件 + rename 更新，只保存版本、阶段、时间、非敏感错误摘要和回滚结果。Updater 不直接伪造审计日志；新版本或回滚后的旧版本在读取状态后写入审计记录。

## 8. 管理接口与授权

更新接口只允许当前管理员主体访问；API Token principal 即使拥有广泛 scope 也默认拒绝。

- `GET /api/v1/updates/status`：当前/最新版本、检查状态、bootstrap 和平台能力。
- `POST /api/v1/updates/check`：手动检查，带调用频率限制。
- `POST /api/v1/updates/prepare`：下载和验证制品，不停止服务。
- `POST /api/v1/updates/install`：再次认证后启动维护和切换。

`install` 必须重新验证管理员密码；账户启用 TOTP 时同时验证 TOTP。恢复码和 API Token 不用于确认安装。认证失败继续受到既有账户/IP 防护，不在日志或审计详情中记录提交的秘密。

同一时间只能运行一个 prepare/install。应用状态与安装根目录文件锁共同防止同进程重复、重启重复和多实例竞争。锁中包含 owner、PID、目标版本和有限期时间；不得仅凭过期时间删除仍有存活 owner 的锁。

## 9. 管理员确认后的更新流程

1. 管理员查看中英文 Release Notes 和升级风险。
2. 管理员重新提交密码及所需 TOTP，确认更新。
3. 应用在仍正常提供服务时下载制品到 staging。
4. 应用校验 manifest 签名、目标版本、平台、文件大小和 SHA-256。
5. 制品解压到新版本目录并完成离线预检；预检失败不进入维护模式。
6. 应用进入维护模式，拒绝新的上传、下载和配置修改，返回 `503` 与 `Retry-After`。
7. 等待正在执行的上传 finalizer 完成；普通上传依靠既有断点续传恢复。
8. 若关键 finalizer 在安全期限内未结束，取消更新并退出维护模式，不强杀后并行启动新版本。
9. 应用启动独立 updater 并优雅退出。
10. Updater 确认旧 PID 完全结束，备份 SQLite，切换 `current`。
11. Updater 启动新版本；数据库迁移只由新版本在单进程状态下执行。
12. 新版本在持久化“升级门控”状态下启动：只允许本机一次性健康检查，拒绝公开业务请求，并禁止生命周期扫描、恢复任务、清理任务和其他会写 storage 的后台工作。
13. Updater 使用本机一次性凭据验证版本、配置、数据库迁移、原生依赖和健康状态；失败时停止新版本、恢复数据库、切回旧版本并启动旧版本。
14. 健康检查成功后，Updater 调用一次性本机 promote 操作；新版本清除升级门控，才开始后台任务并接受业务流量。
15. Promote 成功即确认版本，保留最近两个成功版本并记录成功状态。业务流量恢复后不再自动用旧数据库覆盖运行数据；后续运行故障转为管理员介入的普通回滚流程。

维护模式不得与新版本运行重叠。下载可以被维护窗口中断并由客户端以 Range 重试；已经接收的上传分块继续由现有恢复协议处理。数据库备份目录权限限制为运行账户，备份保留和清理由明确策略控制。

## 10. Docker 行为

Docker 环境不得在容器内替换代码、调用宿主 Docker API 或挂载 Docker socket。设置页可检查 stable Release 并显示目标镜像 tag、Release Notes 和 Compose/平台升级文档，但自动安装按钮不可用。

后续发布工作流可为同一 tag 构建多架构镜像并发布不可变 digest。Docker 更新和回滚由管理员通过 Compose 或容器平台完成；应用只报告当前版本和可用镜像。

## 11. CI 与 Release 工作流

现有 CI 在作为发布门之前必须修正：默认分支实际为 `master`，工作流不能只监听 `main`；根 `npm test` 会因 shared 没有 test script 非零退出；lint 当前缺少 ESLint，不得虚报通过。

PR/master CI 显式运行：

- `npm test --workspace=@filestation/server -- --runInBand`
- `npm run test:e2e --workspace=@filestation/server`
- Web `npx vitest run --no-cache`
- `npm run typecheck`
- `npm run build`
- `git diff --check`

Lint 只有在仓库真正安装并配置 ESLint 后才能重新作为必过项。

发布过程分为 Release PR 与 tag workflow。

Release PR：

1. 人工选择目标版本。
2. 校验项目的 pre-1.0 版本策略。
3. 同步更新根包和三个 workspace 版本。
4. 从提交与 PR 元数据生成双语说明初稿。
5. 更新 `CHANGELOG.md` 和版本化 Release Notes 源文件。
6. 经发布负责人审阅并合并。

在 Release PR 合并提交上推送 `v*` tag 后，tag workflow：

1. 验证 tag、根包和三个 workspace 版本一致。
2. 重跑完整发布检查。
3. 在 Windows/Linux runner 构建对应制品。
4. 在全新目录解压，检查版本、依赖树、SQLite/bcrypt 原生绑定和启动健康。
5. 读取已提交的双语 Release Notes，生成 manifest 和 SHA-256。
6. 签名 manifest。
7. 创建 GitHub Release 并上传制品。

Release 发布前禁止使用未经审阅的全自动说明直接上线。Release workflow 使用最小 GitHub 权限，签名秘密只在发布 job 中可见。

## 12. 安全与审计

- 更新检查、手动刷新、准备、管理员确认、进入维护、成功、失败和回滚均写入审计日志。
- 审计详情只记录版本、阶段、制品标识和安全错误分类，不记录密码、TOTP、JWT、API Token、完整临时凭据或 `.env`。
- 所有下载地址来自通过签名验证的 manifest，并限制协议、主机、重定向、大小和超时。
- Staging、备份、状态和锁文件拒绝符号链接逃逸与路径穿越。
- 解压前检查归档成员路径、总解压大小、单文件大小和文件类型，不允许覆盖安装根目录外文件。
- Updater 拒绝 root/install-root、`data/`、`.env` 和 `updater/` 出现在 Release 替换列表中。
- 更新健康凭据短时、一次性、仅限本机检查；成功或失败后立即失效。
- 版本切换前必须确认旧进程退出；SQLite lease 不能替代进程隔离。

## 13. 错误处理与恢复

- 检查失败：保留现有服务，记录最后错误和下次检查时间。
- 下载/签名/hash/解压失败：删除本次 staging，不进入维护。
- 预检失败：保留新版本目录用于有限诊断或安全删除，不停止旧服务。
- Drain 超时：取消更新，退出维护，旧服务继续运行。
- 旧进程未退出：Updater 不切换、不启动新版本。
- 数据库备份失败：Updater 中止，绝不启动新版本。
- 新版本在升级门控下启动或健康检查失败：停止新版本、恢复数据库、切回旧版本；门控保证此时没有 storage 写入。
- Promote 后运行失败：不自动恢复旧数据库，避免覆盖已经恢复的业务写入；保留版本和备份并要求管理员按文档判断回滚。
- 回滚启动也失败：保留两个版本、数据库备份和无敏感信息的诊断状态，要求管理员手工介入，不继续循环重启。

## 14. 验证与验收

自动化必须覆盖：

- Manifest 确定性序列化、签名验证、篡改拒绝。
- SemVer 比较、同版本/降级/prerelease 拒绝。
- OS/arch/最低 Node 匹配和不支持平台提示。
- 下载 URL allowlist、重定向、大小、超时和归档路径安全。
- 非管理员和 API Token principal 更新接口拒绝。
- 密码/TOTP 再认证及失败防线。
- Prepare/install 并发互斥与 stale lock owner 检查。
- Bootstrap 幂等、默认 `data/` 保留、`.env` 保留和旧目录恢复。
- Windows junction、Linux symlink 切换和恢复。
- 下载失败、签名失败、drain 超时、数据库备份失败、迁移失败、健康检查失败和回滚失败。
- 根路径与 `/fs/` 子路径下更新面板/API。
- Release 制品解压后的版本、依赖、原生绑定和启动冒烟测试。

发布 `v0.2.5` 前完成：

- Windows 真实环境 bootstrap 验收。
- Linux 真实环境 bootstrap 验收。
- Windows 与 Linux 各一次从 `v0.2.5` 到测试 Release 的确认更新、健康检查和回滚演练。
- Docker 环境只显示镜像更新说明且不能自更新。
- Nginx 根路径和 `/fs/` 子路径部署说明实际验证。

自动化通过不替代上述真实部署验收。

## 15. 实施分解

为保持审阅和回滚边界，实施不合并为一个巨大 PR：

1. 修正 CI，建立版本同步和 `v0.2.0` Release 基线。
2. 完善 PR #1，统一根路径/子路径 URL 解析和测试。
3. 建立双语 Release Notes、CHANGELOG、manifest、签名和平台制品工作流。
4. 实现 managed layout、Windows/Linux bootstrap 和部署文档。
5. 实现 UpdateCheckService、管理接口、设置页展示与管理员再认证。
6. 实现 prepare、维护/drain、外部 updater、启动器、健康检查和回滚。
7. 完成 Windows/Linux/Docker 真实验收，更新 CURRENT-STATE 并发布 `v0.2.5`。
8. 在该基础上继续 Phase 3，并于完成后发布 `v0.3.0`。

每个实施 PR 都必须遵循项目 TDD、独立审阅、显式全套验证和文档治理规则。
