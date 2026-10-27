# Changelog

All notable changes to FileStation are documented here. GitHub Release notes
and each versioned source file under `release-notes/` must contain the same
reviewed facts.

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

- 发布前仍需使用同一候选制品完成 375px、TOTP/恢复码和刷新后续传的人工验收。
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

- The same candidate artifact still requires manual acceptance at 375px, for TOTP/recovery, and for resume after refresh before publication.
- Existing Moderate/Low dependency audit advisories remain tracked in CURRENT-STATE.
