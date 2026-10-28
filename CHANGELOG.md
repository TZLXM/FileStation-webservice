# Changelog

All notable changes to FileStation are documented here. GitHub Release notes
and each versioned source file under `release-notes/` must contain the same
reviewed facts.

## [0.2.5] - 2026-10-28 (local candidate)

### 中文

#### 新增功能

- 新增 Windows x64 与 Linux x64 的 managed 安装、更新检查、管理员确认安装、维护栅栏、失败回滚和独立重启验证。
- 新增可重定位双平台制品、结构化双语发布说明、未签名候选证据和重建摘要校验流程。

#### 问题修复

- 修复更新切换、SQLite WAL 快照、进程身份、当前版本链接切换和中断恢复中的竞态。
- 完善根路径与 `/fs/` 子路径配置，并为 `index.html`、SPA fallback 和失效静态资源设置正确缓存边界。

#### 安全更新

- 内部更新健康与提交通道使用 attempt/fence 绑定的短时 capability；归档、路径、凭据和文件权限保持 fail closed。
- 发布必须校验精确候选提交、运行 ID、双平台 SHA-256、固定公钥和受保护签名环境。

#### 升级说明

- 旧式源码部署必须先停止全部旧进程并按 UPDATING.md 手动 bootstrap；升级不得让旧、新版本同时写同一数据库或存储。
- Nginx 静态目录：根路径使用 `<install-root>/current/apps/web/dist-root`，`/fs/` 子路径使用 `<install-root>/current/apps/web/dist-fs`；Docker 内禁止自更新或挂载 Docker socket，只能按文档手动更新镜像。

#### 已知问题

- `0.2.5` 首个 managed updater 不自动替换自身，协议或 updater 版本不兼容时会要求手动 bootstrap/upgrade。
- 2026-10-28 registry 快照的 full audit 为 4 Critical、7 High、25 Moderate、9 Low，production 为 1 Critical、5 High、19 Moderate；Critical/High 处置或明确风险接受前发布保持 blocked。

### English

#### Features

- Add Windows x64 and Linux x64 managed installs, update checks, administrator-confirmed installation, maintenance fencing, rollback, and independent restart verification.
- Add relocatable dual-platform artifacts, structured bilingual notes, unsigned candidate provenance, and rebuilt digest verification.

#### Bug Fixes

- Fix races in update switching, SQLite WAL snapshots, process identity, current-link changes, and interrupted recovery.
- Complete root and `/fs/` deployments with correct cache boundaries for `index.html`, SPA fallback, and stale static assets.

#### Security

- Bind internal update health and promote routes to short-lived attempt/fence capabilities while keeping archives, paths, credentials, and file permissions fail closed.
- Require the exact candidate commit, run ID, both platform SHA-256 digests, fixed public key, and protected signing environment.

#### Upgrade Notes

- Legacy source deployments must stop every old process and follow UPDATING.md for a one-time bootstrap; old and new versions must never write the same database or storage concurrently.
- Point Nginx at `<install-root>/current/apps/web/dist-root` for the root path or `<install-root>/current/apps/web/dist-fs` for `/fs/`. Docker installations must use documented manual image updates and must not self-update or mount the Docker socket.

#### Known Issues

- The first managed updater in `0.2.5` does not replace itself; incompatible protocols or updater versions require manual bootstrap or upgrade guidance.
- The 2026-10-28 registry snapshot has 4 Critical, 7 High, 25 Moderate, and 9 Low findings for the full tree, and 1 Critical, 5 High, and 19 Moderate for production; publication remains blocked until Critical/High findings are resolved or explicitly accepted.

## [0.2.0] - 2026-10-27 (candidate)

### 中文

#### 新增功能

- 完成 Phase 2 发布基线：管理员双因素认证、一次性恢复码、细粒度 API Token、审计查询和默认关闭的内嵌 MCP。
- 加入分块上传、服务端恢复、Web 断点续传、Range 下载和分享访问控制。

#### 问题修复

- 修复并发上传、下载额度抢占和最终化恢复之间的竞态。
- 修复无 WebCrypto 的 LAN HTTP 浏览器无法计算上传分块 SHA-256 的问题。

#### 安全更新

- 增加结构化发布门、严格权限检查和文件响应安全头；依赖审计的 Critical/High 已清零。

#### 升级说明

- 要求 Node.js 20.17.0 或更高版本，并从 v0.2.5 起支持面向 managed layout 的自动更新。
- 旧式源码部署升级到 managed layout 前需要一次手动 bootstrap。

#### 已知问题

- 发布门要求使用同一候选制品提供 375px、TOTP/恢复码和刷新后续传的人工验收证据。
- 现有 Moderate/Low 依赖审计告警仍需按 CURRENT-STATE 的风险记录继续处理。

### English

#### Features

- Complete the Phase 2 baseline with administrator two-factor authentication, one-time recovery codes, scoped API tokens, audit queries, and an opt-in embedded MCP service.
- Add chunked uploads, server-side recovery, browser resume after refresh, Range downloads, and controlled share access.

#### Bug Fixes

- Fix races across concurrent uploads, download-quota claims, and finalization recovery.
- Fix upload chunk SHA-256 calculation in LAN HTTP browsers without WebCrypto.

#### Security

- Add a structured release gate, strict permission checks, and safe file-response headers; no Critical or High audit findings remain.

#### Upgrade Notes

- Require Node.js 20.17.0 or newer; managed-layout automatic updates begin with v0.2.5.
- Legacy source deployments require a one-time manual bootstrap before moving to the managed layout.

#### Known Issues

- The release gate requires manual acceptance evidence from the same candidate artifact at 375px, for TOTP/recovery, and for resume after refresh.
- Existing Moderate/Low dependency audit advisories remain tracked in CURRENT-STATE.
