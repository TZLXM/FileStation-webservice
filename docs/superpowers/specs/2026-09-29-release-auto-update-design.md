# FileStation 发布与管理员确认更新设计

- 状态：已批准（2026-09-29）
- 日期：2026-09-29
- 目标版本：`v0.2.0` 发布基线、`v0.2.5` 更新基础设施

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

根包与三个 workspace 共四处 `package.json` 使用相同版本号，发布工作流拒绝版本不一致的 tag。

- `v0.2.0`：Phase 2 功能与自动化验证基线；完成 §3 的手动发布验收门后，作为第一个正式发布基线。
- `v0.2.5`：完善 PR #1 的 URL/子路径支持，加入发布工作流、更新检测、手动 bootstrap 和 Windows/Linux updater。
- `v0.3.0`：完整 Phase 3。
- `v0.3.1` 及后续 patch：Phase 3 基础上的兼容修复和小更新。
- `v1.0.0`：部署、升级和核心接口达到稳定承诺后再发布。

`v0.2.0` 只有在 `docs/CURRENT-STATE.md` 已记录 Phase 2 手动验收结果、发布检查结果和剩余已知风险后才能作为 stable GitHub Release 打 tag。若这些证据仍显示 pending，工作流必须拒绝 stable 发布；第一版不以引入 prerelease 通道绕过该发布门。

项目在 `0.x` 阶段采用里程碑驱动版本规则：第二位对应主要开发阶段，第三位可包含该阶段内的功能补充和兼容修复。版本允许从 `0.2.0` 直接跳至 `0.2.5`，无需发布 `0.2.1` 至 `0.2.4`。不兼容变更不得放入 patch，必须提升第二位并在 Release Notes 和 manifest 中标明。

Git tag 必须等于 `v${package.version}`；Release 标题使用 `FileStation v${package.version}`。Updater 只接受严格高于当前版本的 stable SemVer，拒绝同版本重装、降级和 prerelease。人工回滚只允许切换到本机已验证的上一成功版本，不通过远端降级 manifest 实现。

## 4. 发布说明与 CHANGELOG

GitHub Release 和仓库级 `CHANGELOG.md` 使用同一版本内容。发布前先创建 Release PR：根据 Conventional Commits 和 PR 元数据生成双语初稿，同时更新根包与三个 workspace 版本、`CHANGELOG.md` 和版本化 Release Notes 源文件；发布负责人审核并合并后，才允许在该合并提交上创建 tag。Tag workflow 只消费已经提交并审阅的说明，不能在 tag 后生成未进入仓库的另一份内容。

Release Notes 使用中英文双语。分类结构固定，但只展示有实际内容的分类：

- 新增功能 / Features
- 问题修复 / Bug Fixes
- 安全更新 / Security
- 升级说明 / Upgrade Notes
- 不兼容变更 / Breaking Changes
- 已知问题 / Known Issues

例如只有新增与修复时，页面只显示“新增功能、问题修复、Features、Bug Fixes”。空分类不渲染。`feat` 默认进入新增功能，`fix` 默认进入问题修复，安全依赖和安全逻辑修改进入安全更新；`docs`、`test`、`chore` 默认仅进入完整比较链接，除非它们改变部署或升级行为。

即使 Release 页面省略空分类，机器读取的 manifest 仍必须显式包含 `database_migration`、`breaking_changes`、`minimum_node`、`requires_manual_bootstrap` 等固定字段，并提供 `zh-CN` 与 `en` 两种结构化摘要供设置页直接渲染。一个 `release_notes_url` 指向同时包含中英文的同一 GitHub Release 页面，不需要为两种语言制造两个页面。工作流检查中英文部分表达相同事实，并要求每个 Release 至少明确列出其实际新增、修复或维护内容。

## 5. 发布制品与更新清单

第一阶段发布两个平台制品：

- Windows x64：`filestation-v0.2.5-win-x64.zip`；后续版本替换文件名中的 SemVer。
- Linux x64：`filestation-v0.2.5-linux-x64.tar.gz`；后续版本替换文件名中的 SemVer。

制品在对应 GitHub Actions runner 上构建，包含运行所需的 shared/server/web 构建产物、锁定依赖和启动所需文件，不包含 `.env`、`data/`、日志、测试数据或真实凭据。每个制品必须在全新的临时目录中解压并完成原生依赖加载与启动冒烟测试。其他 CPU 架构只有在发布工作流能够构建并验证相应制品后才加入 manifest。

Release 同时发布 `update-manifest.json` 及其签名。清单字段契约为：

| 字段 | 类型与约束 |
|------|------------|
| `version` | stable SemVer，必须等于 tag、根包与三个 workspace 版本 |
| `commit` | tag 指向的 40 字符 Git commit SHA |
| `published_at` | UTC ISO-8601 时间 |
| `channel` | 第一版固定为 `stable` |
| `minimum_node` | 最低 Node.js SemVer，`v0.2.5` 为 `20.17.0` |
| `database_migration` | 是否包含数据库迁移；由前一 tag 到当前 tag 的 migration 目录差异自动推导 |
| `migration_workspace_multiplier` / `migration_workspace_min_bytes` | 签名的数据库迁移额外空间下限；前者为有限数字，后者为 JSON safe integer 字节数，prepare 按基准 DB 大小取两者较大值 |
| `breaking_changes` | 是否包含不兼容变更；patch 必须为 `false` |
| `requires_manual_bootstrap` | 当前安装是否必须先完成手动 bootstrap |
| `automatic_update_from` | 能使用设置页自动安装的最低版本；第一版为 `0.2.5` |
| `update_protocol` | Manifest/updater 协议整数版本；第一版为 `1` |
| `min_updater_version` | 执行该更新所需的最低 updater SemVer |
| `release_notes_url` | 当前 tag 的 GitHub Release HTTPS URL |
| `release_summaries` | `zh-CN` 与 `en` 的结构化非空分类及条目 |
| `upgrade_guide_url` | 当前 tag 下版本化 `docs/UPDATING.md` 的 HTTPS URL |
| `artifacts` | 每个平台的 OS、arch、制品下载 URL、压缩/解压精确字节数与 64 位小写十六进制 SHA-256 |

Manifest 按 RFC 8785 JSON Canonicalization Scheme 产生签名字节，并使用 Ed25519 发布私钥签名；应用和 updater 内置对应公钥。签名密钥只存在于受保护的发布环境；仓库和 Release 制品不得包含私钥。下载器只允许签名 manifest 中列出的 GitHub Release HTTPS 资产，限制响应大小、超时和重定向主机，客户端不能提交任意下载 URL。

`database_migration=false` 时两个 migration workspace 字段均为 `0`。为 `true` 时，multiplier 范围为 `2.0..64.0`，minimum 至少为 `268435456` bytes；默认值为 `3.0` 与 `268435456`，Release PR 必须根据实际 migration 显式审阅并说明增大或保留默认值的理由。计算基准取 SQLite `page_count × page_size`、已验证快照字节数和主 DB 文件字节数中的最大值，不使用可能漏掉 WAL 逻辑内容的单一 `.db` 长度作为唯一基准。

第一版不自动替换 updater 自身。若 manifest 的 `update_protocol` 不受当前 updater 支持，或当前 updater 低于 `min_updater_version`，应用必须拒绝自动安装并展示手动 bootstrap/updater 升级说明，不能尝试用未知协议继续更新。

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
├─ managed-install.json     # 安装根、安装 ID、启动模式和当前协议
├─ update-status.json       # 无凭据状态
├─ update-attempt.journal   # 限运行账户访问的持久化 attempt journal
├─ backups/                 # 受限权限的数据库/配置备份与诊断集合
└─ update.lock              # 更新互斥锁
```

应用始终以安装根目录为工作目录，因此默认 `./data` 路径在版本切换后保持不变。Nginx 静态目录一次性改为 `<install-root>/current/apps/web/dist`。Updater 位于 `current` 外，旧应用退出后仍可工作。

发布制品内部目录是可重定位契约，至少保持以下相对关系：

```text
<release>/
├─ apps/server/dist/
├─ apps/web/dist/
├─ packages/shared/dist/
├─ package.json
├─ package-lock.json
├─ apps/*/package.json
└─ packages/shared/package.json
```

后端静态资源解析继续依赖 `apps/server/dist` 与 `apps/web/dist` 的相对位置；运行时数据路径继续依赖安装根 cwd。Release workflow 必须把制品解压到任意临时绝对路径，以安装根为 cwd 启动，验证代码和静态资源均可重定位。

Managed 安装的启动器设置 `FILESTATION_INSTALL_ROOT`、安装 ID 和目标 release realpath。应用在创建 `./data`、连接数据库或运行迁移之前进行硬校验：cwd 必须是安装根，执行文件必须解析到 `current` 指向的 release。检测到从 `releases/<old-version>`、`current/` 或其他错误 cwd 直接启动时立即退出，禁止静默创建空数据库或分叉 storage。旧式未 bootstrap、没有 `managed-install.json` 的源码部署保持现有行为。

`.env` 从 `v0.2.5` 起成为 managed layout 的正式配置契约。启动器在创建 Node 子进程前加载安装根 `.env`，只填充尚未存在的环境变量；调用启动器时已经存在的进程环境变量优先。这样包括 `FILESTATION_SERVE_STATIC` 在内的模块加载期配置也能在导入 `AppModule` 前生效。Updater/launcher 必须声明自己的直接 dotenv 依赖，不能依赖 `@nestjs/config` 的传递依赖。Bootstrap 不擅自把当前进程中的 secret 写入磁盘：若生产必需变量只存在于旧启动 shell，脚本必须提示管理员将其安全迁移到受限权限 `.env` 或新的服务环境，并在不输出值的情况下验证必需项存在。`deploy/README.md` 必须记录来源优先级和全部变量。

旧式源码部署不能直接点击自动安装 `v0.2.5`。设置页检测到未完成 bootstrap 时只显示“需要手动迁移”和升级文档链接，不显示自动安装按钮。

`v0.2.5` 提供：

- Windows：`bootstrap-update.ps1`
- Linux：`bootstrap-update.sh`

Bootstrap 必须：

- 支持重复执行，已完成时安全退出。
- 要求旧 FileStation 进程已经停止。
- 在变更前备份 SQLite、`.env` 和旧源码目录。SQLite 备份由 bootstrap helper 复用旧安装的 `sqlite3` 直接依赖，在确认旧进程退出后执行 `VACUUM INTO`（或等价 backup API），并通过独立只读连接执行 `integrity_check` 与 `foreign_key_check`；禁止直接复制处于 WAL 模式的单个 `.db` 文件。
- 从旧启动环境和旧 cwd 解析 `FILESTATION_DB_PATH`、`FILESTATION_STORAGE_PATH` 与 `FILESTATION_TEMP_PATH` 的 canonical realpath，记入不含凭据的迁移计划；在新布局首次启动前逐项比对。若安装根/cwd 改变导致任何相对路径指向不同对象，必须要求管理员明确选择改为绝对路径或执行数据迁移，不得默认创建新目录/空库。
- 保留 `data/` 的稳定路径，不删除、不复制整个 storage。
- 创建 managed layout、安装 `v0.2.5`、建立 `current`，输出新的启动命令。
- 检测 Nginx 配置并打印需要人工执行的修改与验证命令，但不自行修改或 reload Nginx。
- 任一步失败时保留旧源码和数据，使管理员仍可手动恢复启动。
- 创建并校验 `managed-install.json`，后续只能通过稳定启动器运行 managed 安装。
- Linux 上将 `.env`、数据库备份和 journal 设为运行账户专属的 `0600`（目录 `0700`）；Windows 上使用显式 ACL 只授予运行账户和管理员，不继承宽松父目录权限。

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

`update-status.json` 是可向设置页展示的非权威投影，只保存版本、阶段、时间、非敏感错误摘要和回滚结果。受限权限的 `update-attempt.journal` 才是唯一权威状态，使用单调 sequence 和校验和的追加记录，遇到尾部部分写入时丢弃最后一条而不回退到更早的危险动作。每个不可逆文件/数据库步骤前写入 intent 记录，步骤完成后写入 completion 记录；两者都必须先 flush 内容再进入下一步。POSIX 对 journal 文件和新建/rename 后的父目录执行 fsync；Windows 使用 write-through/等价句柄并调用 `FlushFileBuffers`。`update-status.json` 可以从 journal 重建。Updater 不直接伪造审计日志；新版本或回滚后的旧版本在读取状态后写入审计记录。

维护与升级门控只以安装根 journal 的 attempt 状态为权威，不在数据库中复制第二份可漂移的开关。状态包含随机 `attempt_id`、单调 fencing token、平台 boot identity、owner PID、owner 进程创建时间、心跳时间、阶段、deadline、当前/目标/上一版本和备份标识。应用、launcher 与 updater 每次操作都必须匹配 attempt ID 和 fencing token；旧 owner 即使延迟恢复也无权写入新阶段。

`update.lock` 必须使用操作系统独占锁或同卷 `O_CREAT|O_EXCL` 等价原子 primitive 获取，不得使用“先检查后写文件”。Stale takeover 先竞争独立的 recovery lock，只有唯一获胜者可以追加更高 fencing token 并恢复；普通 unlink 不代表获得所有权。锁判活不能只依赖 PID 或 `process.kill(pid, 0)`：有效 owner 至少要求 boot identity、PID 创建时间和心跳一致，服务端口占用仅作为附加信号。Linux boot identity 取 `/proc/sys/kernel/random/boot_id`；Windows 取 `Win32_OperatingSystem.LastBootUpTime` 的 canonical UTC 值并同时校验进程创建时间。无法可靠取得时 fail closed，转入 `updater recover`。

心跳过期或状态中断时不直接删除文件，而由 `updater status` / `updater recover` 根据持久化阶段选择恢复旧服务、继续安全步骤或封闭等待管理员。管理员恢复命令、预期输出和不可手工只删状态文件的原因必须写入 `docs/UPDATING.md`。陈旧或无 owner 的状态仍然 fail closed，绝不因心跳失效就解除门控。

应用需要新增完整关停编排：调用 `app.enableShutdownHooks()` 启用 Nest shutdown hooks，启动等待模式的 updater，关闭全局写栅栏并 drain，调用 `app.close()` 触发已有 `onModuleDestroy`。只有 `app.close()` 成功返回后，Nest 外的最小 shutdown coordinator 才能持久化 `HANDOFF_READY`，然后退出；Updater 必须同时观察到该记录和旧 PID 已退出，再自行持久化 `OLD_STOPPED` 才可接管。`HANDOFF_READY` 前 journal 由旧应用单写；`OLD_STOPPED` 起由 Updater 单写，新应用只读 journal。若 drain/close 超时、报错或进程在 `HANDOFF_READY` 前崩溃，Updater 不切换；由 launcher 以原版本新进程恢复，不尝试继续使用已部分关闭的 Nest 实例。

### 7.4 全局写栅栏与持久化状态机

维护模式是默认拒绝的进程级写栅栏，不是一组手工枚举的路由。所有 HTTP 业务路由（包括登录/refresh/logout、分享 access/ticket、API Token、恢复码、文件夹和下载计数）、WebSocket 命令、审计、Cron、启动扫描、upload finalizer 及任何 DB/storage writer 都必须先获得 `WriteBarrier` lease。一旦关闭栅栏，新 lease 一律拒绝，已发放 lease 必须归还；非幂等读业务也一律 drain，避免“读请求”内部更新 session/计数/审计。维护期只允许无副作用的更新状态查询与绑定 attempt 的内部 health/promote 协议，其余 API/WS 返回稳定维护响应或关闭连接。

维护切换顺序固定为：先持久化 `MAINTENANCE`，关闭栅栏，等待 HTTP/WS/后台 lease 全部归零，再生成并验证 SQLite 快照。快照标记为 `SNAPSHOT_READY` 后，源 SQLite 连接设为只读/query-only，storage writer 保持冻结，直到旧进程退出；快照后禁止任何业务、审计、session、计数或 storage 写入。写栅栏不能只靠 HTTP middleware：共享写入协调器和 SQLite query-only 是最后一层防线，新增 writer 未注册 lease 应在测试和开发模式中直接失败。

持久化阶段与恢复决策为：

| 阶段 | 持久化不变量 | 崩溃/超时后的唯一默认动作 |
|------|----------------|--------------------------|
| `PREPARED` | 旧服务正常，未关栅栏 | 删除已验证 staging，继续旧服务 |
| `MAINTENANCE` | 旧 `current` 未切换，栅栏关闭 | 由 launcher 重启旧版本并显式重置本 attempt |
| `SNAPSHOT_READY` | 快照已验证，旧 `current` 未切换 | 保留快照，重启旧版本；不恢复快照 |
| `HANDOFF_READY` | `app.close()` 成功，旧进程可能尚未退出 | Updater 继续等待并校验旧 PID，不切换 |
| `OLD_STOPPED` | Updater 已确认旧 PID/创建时间不再存活 | Updater 可从最后 completion 记录继续；未开始切换时也可重启旧版 |
| `SWITCH_INTENT` / `CURRENT_SWITCHED` | 当前/previous 关系按 journal 可恢复 | 根据文件系统实际组合完成或逆转切换，禁止启动任一版 |
| `MIGRATED_VERIFIED` | 新库已迁移，未对外写 | 可停新进程、恢复快照和 previous |
| `READY_TO_COMMIT` | 新版本就绪但业务门仍关闭 | 重试提交查询；未有 `COMMITTED` 记录时仍可回滚 |
| `COMMITTED` | 唯一线性化点，新版本成为权威 | 只启动/继续新版本，绝不自动恢复旧快照 |
| `ROLLBACK_*` | 按 intent/completion 记录恢复 DB 与 previous | 继续幂等回滚；无法证明安全则封闭并要求管理员 |

Promote 是两阶段幂等协议，且 handoff 后只有 Updater 可写 journal。新应用验证 promote capability 和门控健康条件后，返回由 capability 对 canonical readiness payload 生成的 READY receipt，payload 绑定 attempt ID、fencing token、目标版本、migration/schema 标识和验证结果。在未 `COMMITTED` 且条件不变时，重复同一 promote 请求只重做幂等验证并返回同一 receipt，不写 journal、不开放业务；新进程重启则重新验证后可重建同一 receipt。Updater 验证 receipt 后依次持久化并 flush `READY_TO_COMMIT` 与 `COMMITTED`，后者是不可回滚的唯一线性化点。只有应用自行读到匹配 attempt/fencing token 的 `COMMITTED` 后才开放业务和后台任务。响应丢失时 Updater 重试取得 receipt；任一进程崩溃时，Updater/launcher 先查询 journal：已有 `COMMITTED` 则只恢复新版，没有则仍按表中阶段回滚，不以 HTTP 超时推测结果。

## 8. 管理接口与授权

更新接口只允许当前管理员主体访问；API Token principal 即使拥有广泛 scope 也默认拒绝。

- `GET /api/v1/updates/status`：当前/最新版本、检查状态、bootstrap 和平台能力。
- `POST /api/v1/updates/check`：手动检查，带调用频率限制。
- `POST /api/v1/updates/prepare`：下载和验证制品，不停止服务。
- `POST /api/v1/updates/install`：再次认证后创建 attempt，返回 `202 Accepted` 和 attempt ID；请求本身不同步进入维护。

`install` 必须重新验证管理员密码；账户启用 TOTP 时同时验证 TOTP。恢复码和 API Token 不用于确认安装。认证失败继续受到既有账户/IP 防护，不在日志或审计详情中记录提交的秘密。

`install` 请求使用普通 HTTP `WriteBarrier` lease 完成再认证、安全审计与 `PREPARED` attempt 创建，然后返回 `202`。只有在响应 `finish` 且该请求 lease 已归还后，Nest 外/后台 coordinator 才能持久化 `MAINTENANCE` 并关闭栅栏，因此 drain 不会等待 install 请求自身。响应未成功发送、进程在交接前崩溃或重启只能将 `PREPARED` 视为可取消状态，不得在没有新的管理员再认证时自动继续安装。设置页通过无副作用 status 查询跟踪进度。

所有更新管理接口必须通过 Authorization Bearer 中的管理员 access JWT 和 `AdminOnlyGuard`；仅有 refresh cookie 不能调用 check、prepare 或 install，因此不把 cookie 会话当作安装授权。密码/TOTP 再认证是 Bearer 管理员身份之上的第二道确认。

同一时间只能运行一个 prepare/install。应用状态与安装根目录文件锁共同防止同进程重复、重启重复和多实例竞争。锁使用 §7.3 的 attempt/boot/owner/heartbeat 身份；不得仅凭 PID、端口占用或过期时间中的任意单一信号决定抢占。

## 9. 管理员确认后的更新流程

1. 管理员查看中英文 Release Notes 和升级风险。
2. 管理员重新提交密码及所需 TOTP，确认更新；`install` 创建 `PREPARED` 后返回 `202`，coordinator 等待该 HTTP lease 完全释放才继续。
3. Prepare 将安装根、staging、DB、temp 及备份目录解析为实际 volume ID，对同一卷的所有同时需求求和，不分别重复使用同一份可用空间。需求包含制品压缩/解压大小、保留 release、现有 DB/WAL/SHM、自包含快照、恢复临时文件、manifest 声明的 migration 最坏工作空间及安全余量（每卷取 10% 与平台最小值的较大者）。进入维护前以当时 WAL 和卷空间再检一次。空间不足时显示逐卷所需/可用容量，不下载，也不删除唯一上一成功版本或唯一可恢复快照来强行腾空间。
4. 应用在仍正常提供服务时下载制品到 staging，校验 manifest 签名、目标版本、协议、平台、文件大小和 SHA-256。
5. 制品解压到新版本目录并完成离线预检；预检失败不进入维护模式。
6. 应用持久化 `MAINTENANCE` 并关闭 §7.4 的全局写栅栏：除无副作用状态查询和内部升级协议外，全部 API/WS 停止新业务，返回 `503`、`Retry-After` 和稳定错误码 `UPDATE_MAINTENANCE`；Cron/生命周期也不得获得新 lease。
7. 等待 HTTP/WS、upload finalizer、生命周期/Cron、审计及其他 DB/storage writer 的已发 lease 全部归零；普通上传依靠既有断点续传恢复。若在安全期限内未归零，取消更新；若关停已部分发生，由 launcher 新进程恢复旧服务，不强杀后并行启动新版本。
8. 仍在运行的旧应用使用自己的 SQLite 连接执行 `VACUUM INTO`（或等价 SQLite backup API），生成不依赖 `-wal/-shm` 的自包含快照；再用独立只读连接执行 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`。验证失败则取消更新。Updater 不需要携带第二套 sqlite3 原生模块。
9. 旧应用写入已验证备份元数据和 `SNAPSHOT_READY`，启动等待模式 updater，执行 `app.close()`；只有 close 成功后才持久化 `HANDOFF_READY` 并退出。
10. Updater 必须同时看到 `HANDOFF_READY`、匹配 attempt/fencing token，并以 boot identity、PID 创建时间、心跳与服务端口等多信号确认旧进程完全结束。迁移只能由一个新版本进程执行，旧版本不得被外部守护或管理员旧命令被动拉起。
11. Updater 按平台切换 `current`：Linux 创建同目录临时 symlink 后以 rename 原子覆盖；Windows 先创建并验证新 junction，再将旧 `current` 重命名为 attempt 专属 previous 名，随后把新 junction 重命名为 `current`。Windows 的两步切换存在短暂缺口，因此状态文件必须记录每一步，launcher 在任何中间态优先恢复 previous，不能猜测目标。
12. 新版本先以随机回环端口启动验证进程，运行数据库迁移和门控健康检查；不绑定公开端口。门控白名单只允许：迁移、SQLite PRAGMA/完整性检查、读取版本/配置/依赖的健康检查和 attempt 心跳。明确禁止：`ensureInitToken()`、审计写入、生命周期启动扫描、所有 Cron、上传恢复、MCP、业务 Controller、storage I/O 和公开监听。
13. 验证成功后停止验证进程，再以正常端口启动新版本，但保持同一升级门控：公开业务请求继续返回维护响应，后台业务任务仍禁用。Updater 通过直连 `127.0.0.1` 和两个 attempt-bound capability 访问内部协议：health capability 短时、只读且在当前阶段可重试；promote capability 只授权 `MIGRATED_VERIFIED` 之后的一个逻辑提交，在未提交且条件不变时可幂等重试取得同一 READY receipt，`COMMITTED`/失败/过期后立即失效。两者都校验 attempt、fencing token、用途、HTTP 方法和过期时间，并恒时比较。明文只通过继承的匿名管道/受 ACL 保护的 OS IPC 交给子进程，不出现在 URL、argv、环境变量、日志、journal 或普通状态文件中。来源地址只作纵深防御。
14. 任一 `COMMITTED` 前门控阶段失败时，Updater 确认所有新进程退出，先将目标 `.db`、`-wal`、`-shm` 和可能的 `-journal` 作为一个不可混用的诊断集合移入 attempt 目录，再把已验证快照复制到正式 DB 同目录的临时文件并 flush。POSIX 对文件及父目录 fsync 后 rename；Windows 使用带 intent/completion journal 的可恢复分步 rename 和 `FlushFileBuffers`。诊断 sidecar 永不与备份快照组合重放。随后恢复 previous `current` 并启动旧版本。
15. 新应用使用 promote capability 返回幂等 READY receipt，Updater 作为唯一 journal writer 验证 receipt，依次持久化/flush `READY_TO_COMMIT` 和 `COMMITTED`；新应用只在读到该 `COMMITTED` 记录后才启动生命周期/Cron 并接受业务流量，随后写入延迟的更新审计。一旦 `COMMITTED`，任何超时/崩溃都只恢复新版本，不再自动用旧数据库覆盖运行数据；后续运行故障转为管理员介入的普通回滚流程。

维护模式不得与新版本业务运行重叠。下载可以被维护窗口中断并由客户端以 Range 重试；已经接收的上传分块继续由现有恢复协议处理。门控阶段除 migration 明确声明的数据库变更外，业务表和 storage 必须保持零写入；自动化测试以数据库表快照和 storage 树 hash/mtime 证明该不变量，而不是只断言 HTTP 503。

维护/门控状态不能因崩溃永久自锁。Owner 只有在 attempt ID、fencing token、boot identity、进程创建时间和心跳全部匹配时才有权推进状态；但门控本身一旦持久化，即使 owner 失效也继续 fail closed，直到持有 recovery lock 的 launcher/updater 按状态表写入完成或 `ABORTED`。旧应用在 updater 接管前崩溃时，launcher 可依据尚未切换的阶段恢复旧服务；切换后或迁移后的陈旧状态只能由 `updater recover` 根据 journal、备份和 current/previous 关系恢复，应用不得因 deadline 到期自行清除后接受流量。恢复命令同时处理文件状态和任何已验证的临时数据库/进程状态，禁止文档指导用户只删除标志文件。

最近两个成功版本指“当前版本 + 紧邻的上一成功版本”。`COMMITTED` 已持久化且新版本重启验证通过后，Updater 才可删除更老且不被 `current`、previous、活动 attempt、备份元数据或诊断保留引用的 release。磁盘不足时不能自动删除唯一上一成功版本来满足新更新；应中止并让管理员决定。

备份清理同样受引用保护：活动 attempt、唯一可恢复快照、最近一次成功更新的 pre-update 快照不得自动删除；只有后续更新已 `COMMITTED`、新版本重启验证通过且无 journal 引用时才可清理更旧快照。失败诊断集合默认最多保留两份，但最新失败集合必须经管理员确认才能删除。Bootstrap 的 `.env` 备份不进入普通诊断包，以严格 ACL/`0600` 保留至管理员确认新启动方式后通过专用清理命令删除。

### 9.1 Nginx、静态缓存与维护体验

Nginx 和单进程静态托管都必须对 `index.html`/SPA fallback 设置 `Cache-Control: no-store`；带内容 hash 的 `/assets/` 继续 immutable。Release 目录保持只读，不把上一版本 assets 混入新制品。已经打开的旧页面若在切换后请求不存在的旧 hash，Web 全局资源加载错误处理允许执行一次带防循环标记的整页刷新；刷新后的 `index.html` 因 no-store 获取新资源映射。

Nginx 配置必须显式拒绝外部访问内部 update health/promote 路径，并把普通 `/api/` 维护响应原样传递。但 `req.ip` 在当前 Nginx 模式下是代理地址，不能作为本机授权证据。Updater 始终直连回环后端并按用途提交 health 或 promote capability。

维护期间 Nginx 仍可提供静态 shell，这是预期行为。Web API 客户端需要全局识别 `UPDATE_MAINTENANCE`，显示维护遮罩、Release 目标版本和重试状态，暂停其他操作；不要求 Nginx 动态切换独立维护页。

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
5. 从当前 release commit 可达的 stable SemVer tags 中选择版本最高且低于目标版本的唯一 prior tag，通过 `git diff <previous-tag>..<release-commit> -- apps/server/src/database/migrations` 自动计算 `database_migration`。无 prior tag 的初始 Release 按“包含迁移”处理；历史非线性、tag 不可达或候选不唯一时 fail closed。该字段不允许人工覆盖为 false。
6. 发布元数据中的 `breaking_changes` 由发布负责人明确填写；CI 校验 patch 版本必须为 false，若为 true 则 Release Notes 必须有非空 Breaking Changes 且提升第二位。
7. 更新 `CHANGELOG.md` 和版本化 Release Notes 源文件。
8. 检查 `docs/CURRENT-STATE.md` 已记录相应手动验收和发布风险，经发布负责人审阅并合并。

在 Release PR 合并提交上推送 `v*` tag 后，tag workflow：

1. 验证 tag、根包和三个 workspace 版本一致。
2. 重跑完整发布检查。
3. 在 Windows/Linux runner 构建对应制品。
4. 在全新任意绝对路径解压，以安装根为 cwd 检查版本、相对目录契约、依赖树、SQLite/bcrypt 原生绑定和门控启动健康。
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
- Health/promote 使用两个分离的用途绑定 capability：health 只读且在指定阶段内可重试，promote 只授权一个逻辑提交，响应丢失时可返回同一 READY receipt，但不能触发第二次状态转换；`COMMITTED`、失败或过期后立即失效。
- “仅限本机”不是授权条件：在 Nginx 反代下外部请求的 `req.ip` 也是代理地址。内部 health/promote 必须满足匹配 attempt/fencing token、用途、阶段和时限的 capability；Nginx deny 和回环直连仅作纵深防御。
- 版本切换前必须确认旧进程退出；SQLite lease 不能替代进程隔离。
- Managed 安装中的旧 release 检测到自身不再是 `current` 目标时必须在任何数据库/目录写入前拒绝启动，防止旧命令或外部守护在切换后拉起旧版本。
- 门控期间不写审计表；检查、确认等旧版本事件在备份前写入，迁移/成功/失败/回滚事件先写无敏感状态文件，在 promote 后的新版本或恢复后的旧版本补记审计。

## 13. 错误处理与恢复

- 检查失败：保留现有服务，记录最后错误和下次检查时间。
- 协议或 updater 版本不足：拒绝自动更新，显示手动 updater/bootstrap 指南。
- 任一实际 volume 的聚合空间不足：prepare 前或进入维护前拒绝，显示该卷所需/可用空间，不牺牲唯一回滚资产。
- 下载/签名/hash/解压失败：删除本次 staging，不进入维护。
- 预检失败：保留新版本目录用于有限诊断或安全删除，不停止旧服务。
- Drain 超时：在关停尚未部分执行时写入 `ABORTED`、重开栅栏并恢复调度；已进入部分关停则由 launcher 启动新的旧版本进程。
- `app.close()` 失败或旧进程在 `HANDOFF_READY` 前崩溃：Updater 不接管、不切换；launcher 持有 recovery lock 写入 `ABORTED` 并以原 release 新进程恢复，不复用部分关闭实例。
- 旧进程未退出：Updater 不切换、不启动新版本。
- 数据库备份失败：Updater 中止，绝不启动新版本。
- 新版本在 `COMMITTED` 前启动、迁移或健康检查失败：停止新版本，按 journal 隔离诊断 sidecars、恢复数据库快照和 previous；门控保证此时没有 storage 或业务写入。
- `COMMITTED` 后运行失败：只恢复新版本进程，不自动恢复旧数据库；保留版本和备份并要求管理员按文档判断手工回滚。
- 回滚启动也失败：保留两个版本、数据库备份和无敏感信息的诊断状态，要求管理员手工介入，不继续循环重启。
- Attempt/维护/门控标志陈旧：普通应用不自行清除并接受流量；launcher/updater 按阶段自动恢复安全的切换前状态，其他情况要求运行文档化 `updater recover`。
- 错误 cwd 或旧 release 直接启动：在创建目录和打开数据库前硬失败，并打印稳定启动器命令。

## 14. 验证与验收

自动化必须覆盖：

- Manifest 确定性序列化、签名验证、篡改拒绝。
- SemVer 比较、同版本/降级/prerelease 拒绝。
- OS/arch/最低 Node 匹配和不支持平台提示。
- `update_protocol` / `min_updater_version` 兼容性与安全拒绝。
- 下载 URL allowlist、重定向、大小、超时和归档路径安全。
- 相同/不同 volume 的聚合磁盘预算，包含 WAL/SHM、快照、恢复临时文件和 migration 工作空间；上一成功版本和唯一快照不可被自动牺牲。
- 非管理员和 API Token principal 更新接口拒绝。
- 仅有 refresh cookie、缺少管理员 Bearer access JWT 时更新接口拒绝。
- 密码/TOTP 再认证及失败防线。
- `install` 在返回 `202` 且释放自身 HTTP lease 前不得关闭栅栏；响应失败或重启后的 `PREPARED` 不得无再认证自动安装。
- Prepare/install 并发互斥、原子独占锁、recovery lock、fencing token 与 stale owner 竞争测试。
- Windows PID 复用、boot identity 变化/无法取得、进程创建时间不符、心跳陈旧和端口被无关进程占用的 fail-closed 恢复测试。
- Bootstrap 幂等、默认 `data/` 保留、`.env` 保留、权限和旧目录恢复；自定义相对 DB/storage/temp 在 cwd 变化前后的 canonical path 不一致时必须拒绝静默迁移。
- `.env` 与已有进程环境变量优先级，以及 `FILESTATION_SERVE_STATIC` 在模块导入前生效。
- Managed layout 错误 cwd、旧 release 直接启动在任何 DB/storage 写入前失败。
- Release 内 `apps/server/dist`、`apps/web/dist`、shared 与依赖布局可从任意绝对路径重定位。
- Windows junction、Linux symlink 切换和恢复。
- Linux 临时 symlink + rename 原子切换，以及 Windows 两阶段 junction 中每个崩溃点的 previous 恢复。
- Attempt journal 尾部部分写入、intent/completion 之间掉电、flush 失败和每个状态机阶段的唯一恢复决策。
- `HANDOFF_READY` 前崩溃、`HANDOFF_READY` 后但 `OLD_STOPPED` 前的延迟退出、`app.close()` 失败和部分关闭后必须按各自阶段处理，不得提前切换。
- WAL 中含未 checkpoint 已提交事务时，`VACUUM INTO`/backup 快照完整包含数据；恢复前后 `-wal/-shm` 不被错误重放。
- 备份 `integrity_check` / `foreign_key_check` 失败拒绝更新。
- 进入维护后登录/refresh/logout、分享 access/ticket、API Token、恢复码、文件夹、下载计数、审计、Cron/生命周期与 storage writer 均无法获得新 `WriteBarrier` lease；已发 lease 被纳入 drain，取消更新后只在安全新进程中恢复。
- 快照完成后到旧进程退出期间，SQLite query-only 与 storage 冻结拒绝所有绕过 HTTP middleware 的写入。
- 门控期间除声明的 migration 变更外业务表与 storage 树零写入；`ensureInitToken`、审计、生命周期启动扫描和全部 Cron 均不运行。
- 陈旧维护/门控 attempt 在 owner 失效时仍 fail closed，但 launcher/updater 能根据阶段幂等恢复，不会永久 503，且不能通过只删标志绕过检查。
- Health capability 可在授权阶段内安全重试，promote capability 只授权一个逻辑提交并幂等返回同一 READY receipt；两者不经 URL/argv/env/日志/状态文件传递。
- Handoff 后 Updater 是唯一 journal writer；READY receipt 响应丢失/重试、`READY_TO_COMMIT` 与 `COMMITTED` 之间掉电、`COMMITTED` 后崩溃及重启均不会触发旧快照回滚。
- Migration workspace 字段的类型/范围/最低值验证，以及基于 `page_count × page_size`、快照大小和 DB 文件大小最大值的预算。
- DB/`.env` 备份和诊断集合的 ACL/`0600`、引用保护、数量上限与专用清理命令。
- 下载失败、签名失败、drain 超时、关停失败、数据库备份失败、迁移失败、健康检查失败和回滚失败。
- 根路径与 `/fs/` 子路径下更新面板/API。
- Nginx/单进程 `index.html` no-store、旧页面缺失 hashed asset 时的单次防循环刷新，以及维护遮罩行为。
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
4. 实现 managed layout、制品相对路径契约、错误 cwd/旧 release 启动保护、自定义数据路径 canonical 校验、Windows/Linux bootstrap、`.env`/备份权限契约和部署文档。
5. 实现 UpdateCheckService、管理接口、设置页展示与管理员再认证。
6. 实现按 volume 聚合的磁盘预检、prepare、全局 `WriteBarrier`、活动 lease drain、Nest shutdown hooks、`app.close()`/`HANDOFF_READY` 关停编排、WAL-safe SQLite 快照/诊断集合/恢复、durable attempt journal 与 fencing lock、外部 updater、启动器、分离 health/promote capability、`COMMITTED` 两阶段提交、平台切换和回滚。
7. 完成 Windows/Linux/Docker 真实验收，更新 CURRENT-STATE 并发布 `v0.2.5`。
8. 在该基础上继续 Phase 3，并于完成后发布 `v0.3.0`。

每个实施 PR 都必须遵循项目 TDD、独立审阅、显式全套验证和文档治理规则。
