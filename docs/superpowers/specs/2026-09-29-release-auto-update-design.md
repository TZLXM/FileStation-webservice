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
- 保留 `data/` 的稳定路径，不删除、不复制整个 storage。
- 创建 managed layout、安装 `v0.2.5`、建立 `current`，输出新的启动命令。
- 检测 Nginx 配置并打印需要人工执行的修改与验证命令，但不自行修改或 reload Nginx。
- 任一步失败时保留旧源码和数据，使管理员仍可手动恢复启动。
- 创建并校验 `managed-install.json`，后续只能通过稳定启动器运行 managed 安装。

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

维护与升级门控只以安装根的 attempt 状态为权威，不在数据库中复制第二份可漂移的开关。状态包含随机 `attempt_id`、平台 boot ID、owner PID、owner 启动时间、心跳时间、阶段、deadline、当前/目标/上一版本和备份标识。应用、launcher 与 updater 每次只接受匹配当前 attempt 的操作。

锁判活不能只依赖 PID 或 `process.kill(pid, 0)`：Windows PID 可能复用。有效 owner 至少要求 boot ID 一致且心跳新鲜；PID 和现有服务端口占用仅作为附加信号。心跳过期或状态中断时不直接删除文件，而由 `updater status` / `updater recover` 根据阶段选择恢复旧服务、继续安全步骤或清除已经验证无效的 attempt。管理员恢复命令、预期输出和不可手工只删状态文件的原因必须写入 `docs/UPDATING.md`。

应用需要新增完整关停编排：调用 `app.enableShutdownHooks()` 启用 Nest shutdown hooks，追踪活动请求与 upload finalizer，停止接收新业务，等待 drain，调用 `app.close()` 触发已有 `onModuleDestroy`，最后才退出。若应用自身不能在安全期限完成 drain，必须取消更新、清除本次维护状态并恢复服务，不能把半完成状态交给 updater。

## 8. 管理接口与授权

更新接口只允许当前管理员主体访问；API Token principal 即使拥有广泛 scope 也默认拒绝。

- `GET /api/v1/updates/status`：当前/最新版本、检查状态、bootstrap 和平台能力。
- `POST /api/v1/updates/check`：手动检查，带调用频率限制。
- `POST /api/v1/updates/prepare`：下载和验证制品，不停止服务。
- `POST /api/v1/updates/install`：再次认证后启动维护和切换。

`install` 必须重新验证管理员密码；账户启用 TOTP 时同时验证 TOTP。恢复码和 API Token 不用于确认安装。认证失败继续受到既有账户/IP 防护，不在日志或审计详情中记录提交的秘密。

所有更新管理接口必须通过 Authorization Bearer 中的管理员 access JWT 和 `AdminOnlyGuard`；仅有 refresh cookie 不能调用 check、prepare 或 install，因此不把 cookie 会话当作安装授权。密码/TOTP 再认证是 Bearer 管理员身份之上的第二道确认。

同一时间只能运行一个 prepare/install。应用状态与安装根目录文件锁共同防止同进程重复、重启重复和多实例竞争。锁使用 §7.3 的 attempt/boot/owner/heartbeat 身份；不得仅凭 PID、端口占用或过期时间中的任意单一信号决定抢占。

## 9. 管理员确认后的更新流程

1. 管理员查看中英文 Release Notes 和升级风险。
2. 管理员重新提交密码及所需 TOTP，确认更新。
3. Prepare 根据 manifest 的压缩大小、解压大小、当前 SQLite 大小和安全余量检查磁盘空间。安装卷至少需要“制品 + 解压目录 + 10%/256 MiB 较大者”；数据库卷至少需要“自包含备份 + 临时恢复文件 + 10%/64 MiB 较大者”。空间不足时在设置页显示所需/可用容量，不下载、不删除上一成功版本来强行腾空间。
4. 应用在仍正常提供服务时下载制品到 staging，校验 manifest 签名、目标版本、协议、平台、文件大小和 SHA-256。
5. 制品解压到新版本目录并完成离线预检；预检失败不进入维护模式。
6. 应用进入维护模式，拒绝新的上传、下载和配置修改，返回 `503`、`Retry-After` 和稳定错误码 `UPDATE_MAINTENANCE`。MaintenanceCoordinator 同时禁止新的 Cron/生命周期轮次进入。
7. 等待已经开始的 upload finalizer、生命周期/Cron 和其他后台写任务结束；普通上传依靠既有断点续传恢复。若关键任务在安全期限内未结束，取消更新、清除本次维护 attempt 并恢复调度与服务，不强杀后并行启动新版本。
8. 仍在运行的旧应用使用自己的 SQLite 连接执行 `VACUUM INTO`（或等价 SQLite backup API），生成不依赖 `-wal/-shm` 的自包含快照；再用独立只读连接执行 `PRAGMA integrity_check` 和 `PRAGMA foreign_key_check`。验证失败则取消更新。Updater 不需要携带第二套 sqlite3 原生模块。
9. 旧应用写入已验证备份元数据，启动独立 updater，并通过新增的关停编排执行 `app.close()` 后退出。
10. Updater 以 attempt ID、boot ID、owner 心跳、PID 和服务端口等多信号确认旧进程完全结束。迁移只能由一个新版本进程执行，旧版本不得被外部守护或管理员旧命令被动拉起。
11. Updater 按平台切换 `current`：Linux 创建同目录临时 symlink 后以 rename 原子覆盖；Windows 先创建并验证新 junction，再将旧 `current` 重命名为 attempt 专属 previous 名，随后把新 junction 重命名为 `current`。Windows 的两步切换存在短暂缺口，因此状态文件必须记录每一步，launcher 在任何中间态优先恢复 previous，不能猜测目标。
12. 新版本先以随机回环端口启动验证进程，运行数据库迁移和门控健康检查；不绑定公开端口。门控白名单只允许：迁移、SQLite PRAGMA/完整性检查、读取版本/配置/依赖的健康检查和 attempt 心跳。明确禁止：`ensureInitToken()`、审计写入、生命周期启动扫描、所有 Cron、上传恢复、MCP、业务 Controller、storage I/O 和公开监听。
13. 验证成功后停止验证进程，再以正常端口启动新版本，但保持同一升级门控：公开业务请求继续返回维护响应，后台业务任务仍禁用。Updater 通过直连 `127.0.0.1` 和一次性随机密钥访问内部 health/promote；密钥是授权的唯一权威，来源地址只作纵深防御。
14. 任一门控阶段失败时，Updater 确认所有新进程退出，先移除目标数据库的 `-wal/-shm`，将当前数据库重命名保留为诊断副本，再把已验证快照复制到同目录临时文件并 fsync；POSIX 额外 fsync 父目录后 rename 为正式数据库，Windows 使用带 attempt journal 的可恢复分步 rename/FlushFileBuffers，不假设 rename-over 目录或已存在文件是原子的。随后恢复 previous `current` 并启动旧版本。
15. 健康检查成功后，Updater 调用一次性 promote。新版本原子清除门控，才启动生命周期/Cron 并接受业务流量；随后写入延迟的更新审计。Promote 成功即确认版本。业务流量恢复后不再自动用旧数据库覆盖运行数据，后续运行故障转为管理员介入的普通回滚流程。

维护模式不得与新版本业务运行重叠。下载可以被维护窗口中断并由客户端以 Range 重试；已经接收的上传分块继续由现有恢复协议处理。数据库备份目录权限限制为运行账户。门控阶段除 migration 明确声明的数据库变更外，业务表和 storage 必须保持零写入；自动化测试以数据库表快照和 storage 树 hash/mtime 证明该不变量，而不是只断言 HTTP 503。

维护/门控状态不能因崩溃永久自锁。每个标志只对匹配 attempt ID、boot ID 和有效 owner 心跳的会话生效。旧应用在 updater 接管前崩溃时，launcher 可依据尚未切换的阶段恢复旧服务；切换后或迁移后的陈旧状态只能由 `updater recover` 根据备份和 current/previous 关系恢复，应用不得因 deadline 到期自行清除后接受流量。恢复命令同时清理文件状态和任何已验证的临时数据库/进程状态，禁止文档指导用户只删除标志文件。

最近两个成功版本指“当前版本 + 紧邻的上一成功版本”。Promote 成功且状态持久化后，Updater 才可删除更老且不被 `current`、previous、活动 attempt、备份元数据或诊断保留引用的 release。磁盘不足时不能自动删除唯一上一成功版本来满足新更新；应中止并让管理员决定。

### 9.1 Nginx、静态缓存与维护体验

Nginx 和单进程静态托管都必须对 `index.html`/SPA fallback 设置 `Cache-Control: no-store`；带内容 hash 的 `/assets/` 继续 immutable。Release 目录保持只读，不把上一版本 assets 混入新制品。已经打开的旧页面若在切换后请求不存在的旧 hash，Web 全局资源加载错误处理允许执行一次带防循环标记的整页刷新；刷新后的 `index.html` 因 no-store 获取新资源映射。

Nginx 配置必须显式拒绝外部访问内部 update health/promote 路径，并把普通 `/api/` 维护响应原样传递。但 `req.ip` 在当前 Nginx 模式下是代理地址，不能作为本机授权证据。Updater 始终直连回环后端并提交一次性密钥。

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
5. 通过 `git diff <previous-tag>..<release-commit> -- apps/server/src/database/migrations` 自动计算 `database_migration`；该字段不允许人工覆盖为 false。
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
- 更新健康凭据短时、一次性、仅限本机检查；成功或失败后立即失效。
- “仅限本机”不是授权条件：在 Nginx 反代下外部请求的 `req.ip` 也是代理地址。内部 health/promote 必须同时满足匹配 attempt 的一次性随机密钥；Nginx deny 和回环直连仅作纵深防御。
- 版本切换前必须确认旧进程退出；SQLite lease 不能替代进程隔离。
- Managed 安装中的旧 release 检测到自身不再是 `current` 目标时必须在任何数据库/目录写入前拒绝启动，防止旧命令或外部守护在切换后拉起旧版本。
- 门控期间不写审计表；检查、确认等旧版本事件在备份前写入，迁移/成功/失败/回滚事件先写无敏感状态文件，在 promote 后的新版本或恢复后的旧版本补记审计。

## 13. 错误处理与恢复

- 检查失败：保留现有服务，记录最后错误和下次检查时间。
- 协议或 updater 版本不足：拒绝自动更新，显示手动 updater/bootstrap 指南。
- 安装卷或数据库卷空间不足：prepare 前拒绝，显示所需/可用空间，不进入维护。
- 下载/签名/hash/解压失败：删除本次 staging，不进入维护。
- 预检失败：保留新版本目录用于有限诊断或安全删除，不停止旧服务。
- Drain 超时：取消更新，退出维护，旧服务继续运行。
- 应用关停编排失败：Updater 不接管；旧应用清除本次维护 attempt 并恢复服务。
- 旧进程未退出：Updater 不切换、不启动新版本。
- 数据库备份失败：Updater 中止，绝不启动新版本。
- 新版本在升级门控下启动或健康检查失败：停止新版本、恢复数据库、切回旧版本；门控保证此时没有 storage 写入。
- Promote 后运行失败：不自动恢复旧数据库，避免覆盖已经恢复的业务写入；保留版本和备份并要求管理员按文档判断回滚。
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
- 安装卷/数据库卷磁盘空间预检及上一成功版本不可被自动牺牲。
- 非管理员和 API Token principal 更新接口拒绝。
- 仅有 refresh cookie、缺少管理员 Bearer access JWT 时更新接口拒绝。
- 密码/TOTP 再认证及失败防线。
- Prepare/install 并发互斥与 stale lock owner 检查。
- Windows PID 复用、boot ID 变化、心跳陈旧和端口被无关进程占用的锁恢复测试。
- Bootstrap 幂等、默认 `data/` 保留、`.env` 保留和旧目录恢复。
- `.env` 与已有进程环境变量优先级，以及 `FILESTATION_SERVE_STATIC` 在模块导入前生效。
- Managed layout 错误 cwd、旧 release 直接启动在任何 DB/storage 写入前失败。
- Release 内 `apps/server/dist`、`apps/web/dist`、shared 与依赖布局可从任意绝对路径重定位。
- Windows junction、Linux symlink 切换和恢复。
- Linux 临时 symlink + rename 原子切换，以及 Windows 两阶段 junction 中每个崩溃点的 previous 恢复。
- WAL 中含未 checkpoint 已提交事务时，`VACUUM INTO`/backup 快照完整包含数据；恢复前后 `-wal/-shm` 不被错误重放。
- 备份 `integrity_check` / `foreign_key_check` 失败拒绝更新。
- 进入维护后新的 Cron/生命周期任务不启动，已运行后台写任务被纳入 drain；取消更新后调度恢复。
- 门控期间除声明的 migration 变更外业务表与 storage 树零写入；`ensureInitToken`、审计、生命周期启动扫描和全部 Cron 均不运行。
- 陈旧维护/门控 attempt 不会永久 503，且不能通过只删标志绕过恢复检查。
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
4. 实现 managed layout、制品相对路径契约、错误 cwd/旧 release 启动保护、Windows/Linux bootstrap、`.env` 契约和部署文档。
5. 实现 UpdateCheckService、管理接口、设置页展示与管理员再认证。
6. 实现磁盘预检、prepare、维护/drain、活动 finalizer 跟踪、Nest shutdown hooks、`app.close()` 关停编排、WAL-safe SQLite 快照/恢复、attempt 状态机、外部 updater、启动器、门控健康/promote、平台切换和回滚。
7. 完成 Windows/Linux/Docker 真实验收，更新 CURRENT-STATE 并发布 `v0.2.5`。
8. 在该基础上继续 Phase 3，并于完成后发布 `v0.3.0`。

每个实施 PR 都必须遵循项目 TDD、独立审阅、显式全套验证和文档治理规则。
