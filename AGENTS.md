# FileStation Agent 开发手册

> 本文件是 agent 进入项目后的第一入口。当前实现事实优先级高于早期设想文档；如有冲突，以本文件的工作规则和安全规则、`docs/CURRENT-STATE.md`、`docs/superpowers/specs/2026-07-28-filestation-design.md` 和代码测试为准。

## 1. 项目目标

FileStation 是一个私有文件传输站 Web 应用，单管理员模式，支持多传输入口、灵活分享控制、细粒度权限管理。

**核心能力：**
- 多传输入口智能选路（直连 / 多 FRP 地址）
- 文件 URL 直链（免密预览 / 密码保护 / 管理员验证）
- 临时码授权访客上传下载
- 文件自动过期 + 手动延长/永久保留
- 全局限速 + 入口限速 + 角色限速
- 多设备管理员认证（TOTP / API Token / WebAuthn）
- 虚拟文件夹管理
- WebUI 全配置

## 2. 当前阶段

**Phase 1: MVP（当前）**
- 项目脚手架
- 安全初始化
- 账号密码登录 + JWT
- 文件上传/下载
- 文件夹管理
- 文件有效期
- 分享链接（page 类型）

**详细设计：** [docs/superpowers/specs/2026-07-28-filestation-design.md](docs/superpowers/specs/2026-07-28-filestation-design.md)

## 3. 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | NestJS (Node.js/TypeScript) |
| 前端 | React + shadcn/ui + Tailwind CSS |
| 数据库 | SQLite (TypeORM) |
| 文件存储 | 本地磁盘 |
| 实时通信 | WebSocket (Socket.io) |
| 构建 | Vite + npm workspaces |

## 4. 项目结构

```
filestation-webservice/
├── apps/
│   ├── server/          # NestJS 后端
│   └── web/             # React 前端
├── packages/
│   └── shared/          # 共享类型
├── data/                # 运行时数据（gitignored）
├── docs/                # 文档
│   ├── adr/             # 架构决策记录
│   └── superpowers/     # 设计文档
├── scripts/             # 构建/测试脚本
└── .github/             # CI/CD 和模板
```

## 5. 启动与测试

```bash
# 安装依赖
npm install

# 开发模式（前后端并行）
npm run dev

# 构建
npm run build

# 测试
npm test

# 类型检查
npm run typecheck

# Lint
npm run lint
```

## 6. 安全规则（必须遵守）

### 6.1 密钥与敏感信息

- **不提交** `data/` 目录下的任何运行时数据
- **不提交** `.env` 或任何包含真实密钥的文件
- **不在回复、文档、提交信息中复述** 真实 API key、密码、Token
- 涉及真实外部服务调用的操作需要用户明确同意

### 6.2 初始化安全

- 首次初始化必须在本机进行（Nginx `allow 127.0.0.1`）
- 一次性初始化 Token 10 分钟有效期
- 初始化完成后 Token 立即失效

### 6.3 认证安全

- 所有密码使用 bcrypt 哈希
- 临时码 secret 使用 Argon2id 哈希
- API Token 仅存储 SHA-256 哈希
- JWT 必须区分 `principal_type: admin | api_token`

### 6.4 文件安全

- 用户上传的 HTML/SVG/JS 强制 `Content-Disposition: attachment`
- 允许 inline 的 MIME 类型白名单：图片/视频/音频/PDF
- 响应头必须包含 `X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: sandbox`

## 7. 开发流程

### 7.1 标准任务流程

1. 确认当前状态：`docs/CURRENT-STATE.md`
2. 写或更新测试
3. 实现最小改动
4. 运行 `npm test` 和 `npm run typecheck`
5. 更新 `docs/CURRENT-STATE.md`
6. 按文档治理规则检查是否需要更新其他文档
7. 提交

### 7.2 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type:**
- `feat`: 新功能
- `fix`: 修复 bug
- `docs`: 文档修改
- `style`: 代码格式
- `refactor`: 重构
- `perf`: 性能优化
- `test`: 测试
- `chore`: 构建/工具

**Scope:**
- `server`: 后端
- `web`: 前端
- `shared`: 共享包
- `db`: 数据库
- `auth`: 认证
- `upload`: 上传
- `share`: 分享
- `ci`: CI/CD

**示例：**
```
feat(server): add file upload with chunk support

fix(web): correct folder tree rendering

docs: update CURRENT-STATE for Phase 1 completion
```

### 7.3 提交前检查

```bash
npm run typecheck
npm run lint
npm test
```

## 8. 功能开发指南

### 8.1 新增 API 端点

1. 在 `apps/server/src/<module>/` 下创建 Controller
2. 使用 `@ApiTags()` 和 `@ApiOperation()` 注解（Swagger）
3. 实现 Guard 进行权限控制
4. 添加 DTO 进行输入校验（class-validator）
5. 编写单元测试和 e2e 测试

### 8.2 新增数据库表

1. 在 `apps/server/src/database/migrations/` 创建迁移文件
2. 使用 TypeORM Migration API
3. 包含 `up()` 和 `down()` 方法
4. 添加必要的索引和约束
5. 更新 `docs/CURRENT-STATE.md`

### 8.3 新增前端页面

1. 在 `apps/web/src/pages/` 创建页面组件
2. 使用 React Router 配置路由
3. 使用 shadcn/ui 组件保持视觉一致
4. 添加页面级错误边界
5. 实现加载和错误状态

## 9. 文档治理

### 9.1 文档优先级

1. `AGENTS.md`（本文件）
2. `docs/CURRENT-STATE.md`
3. `docs/superpowers/specs/2026-07-28-filestation-design.md`
4. `README.md`
5. 代码和测试

### 9.2 文档更新规则

- **CURRENT-STATE.md**：每次功能变更后更新
- **设计文档**：重大架构变更时更新，版本号递增
- **ADR**：重要技术决策记录，不可修改，只能新增
- **README.md**：用户可见变更时更新

### 9.3 文档分层

- **Agent 入口**：`AGENTS.md` → `CURRENT-STATE.md`
- **设计参考**：`docs/superpowers/specs/`
- **架构决策**：`docs/adr/`
- **用户文档**：`README.md`

## 10. 测试策略

### 10.1 测试金字塔

```
    /\
   /  \     E2E (少量，关键路径)
  /____\
 /      \   Integration (适量，API/数据库)
/________\  Unit (大量，快速)
```

### 10.2 必须覆盖的场景

- 认证：登录/登出/Token 刷新/权限拒绝
- 上传：分块上传/断点续传/并发完成/崩溃恢复
- 下载：Range 请求/计数原子性/会话复用
- 分享：密码验证/次数限制/过期处理
- 文件：过期清理/状态转换/级联删除

### 10.3 测试数据

- 使用内存 SQLite 或临时文件数据库
- 每个测试文件独立数据库
- 测试后清理临时文件

## 11. 部署与发布

### 11.1 环境要求

- Node.js 20+
- Nginx（生产环境必需）
- SQLite（嵌入式，无需单独安装）

### 11.2 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FILESTATION_STORAGE_PATH` | 文件存储路径 | `./data/storage` |
| `FILESTATION_DB_PATH` | SQLite 数据库路径 | `./data/filestation.db` |
| `FILESTATION_INIT_TOKEN` | 初始化 Token（可选） | 自动生成 |
| `FILESTATION_PORT` | 服务端口 | `8080` |

### 11.3 发布检查清单

- [ ] `npm run build` 成功
- [ ] `npm test` 全部通过
- [ ] `npm run typecheck` 无错误
- [ ] 数据库迁移测试通过
- [ ] 安全扫描通过（npm audit）
- [ ] 版本号更新（SemVer）
- [ ] CHANGELOG 更新

## 12. 禁止事项

- **禁止** 使用 `SELECT ... FOR UPDATE`（SQLite 不支持）
- **禁止** 在 SQLite 写事务中执行文件 I/O 或网络请求
- **禁止** 将客户端提交的 `X-Entry-Id` 等安全 Header 直接信任
- **禁止** 在 URL 查询参数中传递密码或长期 Token
- **禁止** 使用 `Access-Control-Allow-Origin: *`
- **禁止** 提交 `data/` 目录下的运行时数据

## 13. 故障排查

### 13.1 常见问题

**数据库锁定：**
- 检查是否有长事务
- 确认使用 WAL 模式
- 检查 `busy_timeout` 设置

**上传失败：**
- 检查 `temp/` 目录权限
- 检查磁盘空间
- 查看 `upload_sessions` 状态

**下载计数错误：**
- 确认使用 `download_sessions` 抢占模式
- 检查事务隔离级别

### 13.2 调试工具

- 后端日志：`apps/server/logs/`
- 数据库检查：`sqlite3 data/filestation.db`
- API 测试：Swagger UI `/api/docs`

---

*文档版本: v1.0*
*创建日期: 2026-07-28*
*维护者: AI Agent*
