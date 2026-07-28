# Current State

Updated: 2026-07-28

FileStation 是一个私有文件传输站 Web 应用，当前处于 **Phase 1: MVP** 开发阶段。

## 项目状态

| 方面 | 状态 |
|------|------|
| 设计文档 | v2.2 已完成，协议闭合 |
| 项目管理 | AGENTS.md 已建立 |
| 代码实现 | 未开始 |
| 测试 | 未开始 |
| 部署 | 未开始 |

## 设计决策摘要

### 技术栈
- **后端**: NestJS (Node.js/TypeScript)
- **前端**: React + shadcn/ui + Tailwind CSS
- **数据库**: SQLite (TypeORM, WAL 模式)
- **构建**: Vite + npm workspaces

### 核心架构决策

1. **文件公开方式**: 统一走 `shares` 表，文件始终私有
2. **上传协议**: HTTP 分块上传（非 WebSocket 传文件主体）
3. **上传完成**: 三阶段分离（抢占 → 处理 → 完成）
4. **下载计数**: 先抢占 `download_sessions`，再扣减分享额度
5. **直链规则**: `type=direct` 必须 `protection=none`
6. **初始化安全**: Nginx `allow/deny` + 一次性 Token
7. **临时码**: 130 bit 熵（26 字符 Crockford Base32），Argon2id 哈希

### 数据库关键设计

- 时间字段：Unix 毫秒 (INTEGER)，UTC
- 限速单位：bytes_per_second (INTEGER)
- 分块存储：独立 `.part` 文件，完成时合并
- 文件夹删除：MVP 仅允许删除空文件夹
- 存储路径：环境变量控制，非热更新

## 开发里程碑

### Phase 1: MVP（当前，2 周）

- [ ] 项目脚手架（NestJS + React + SQLite）
- [ ] 安全初始化（Nginx allow/deny + Token）
- [ ] 账号密码登录 + JWT + Refresh Token
- [ ] 文件上传（分块 + upload_token + 三阶段完成）
- [ ] 文件下载（Range + download_session）
- [ ] 文件夹 CRUD（仅空文件夹删除）
- [ ] 文件有效期 + 自动过期
- [ ] 分享链接（page 类型，统一 access 流程）
- [ ] 基础设置页

### Phase 2: 可靠性（2 周）

- [ ] TOTP 认证（login_challenge 流程）
- [ ] API Token（exchange 端点 + scopes）
- [ ] 恢复码机制
- [ ] 断点续传（崩溃恢复）
- [ ] 原子计数（所有场景）
- [ ] 审计日志
- [ ] 并发/压力测试

### Phase 3: 多入口传输（2 周）

- [ ] 入口管理（public_base_url）
- [ ] 客户端探测与选路
- [ ] Nginx 配置生成（含 CORS）
- [ ] 跨入口授权与切换
- [ ] 入口限速
- [ ] 直链分享（302 + Token）

### Phase 4: 增强功能（2 周）

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
- 使用 `BEGIN IMMEDIATE` + 条件 UPDATE 抢占

### 部署约束

- Node.js 只绑定 `127.0.0.1` 或 Unix Socket
- Nginx 必须覆盖 `X-Entry-Id` Header
- 初始化端点必须 Nginx 层限制本机访问

## 文档引用

- **设计文档**: [docs/superpowers/specs/2026-07-28-filestation-design.md](docs/superpowers/specs/2026-07-28-filestation-design.md)
- **Agent 手册**: [AGENTS.md](AGENTS.md)
- **架构决策**: [docs/adr/](docs/adr/)

## 待办事项

### 立即执行（Phase 1 启动）

1. 初始化 npm workspaces 项目结构
2. 配置 TypeScript + ESLint + Prettier
3. 创建 NestJS 基础应用
4. 创建 React + Vite 基础应用
5. 配置 SQLite + TypeORM
6. 实现数据库迁移机制

### 待设计（Phase 2+）

- TOTP 具体实现方案
- WebAuthn RP ID 配置策略
- P2P 传输协议细节
- 统计面板数据聚合策略

## 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| SQLite 并发性能 | 多用户上传下载时锁定 | WAL 模式 + 短事务 + 连接池 |
| 大文件上传内存 | 分块合并时内存溢出 | 流式合并 + 临时文件 |
| FRP 配置复杂性 | 用户配置困难 | 提供 Nginx 配置生成器 |
| 多入口 CORS | 跨域请求被阻止 | 明确 CORS 白名单设计 |

## 变更日志

- **2026-07-28**: 项目初始化，设计文档 v2.2 完成，AGENTS.md 建立

---

*此文档每次功能变更后必须更新*
