# FileStation Agent 开发手册

> 本文件是 agent 进入项目后的第一入口。当前实现事实优先级高于早期设想文档；如有冲突，以本文件的工作规则和安全规则、`docs/CURRENT-STATE.md`、`docs/superpowers/specs/2026-07-28-filestation-design.md` 和代码测试为准。

## 1. 项目目标

FileStation 是一个私有文件传输站 Web 应用，单管理员模式，支持多传输入口、灵活分享控制、细粒度权限管理。

**当前已实现能力：**
- 私有文件上传/下载、Range、分享页（免密/密码）、虚拟文件夹、到期清理
- 管理员密码登录、TOTP 两步验证、一次性恢复码
- API Token、细粒度 scope、默认关闭的内嵌 MCP Agent、审计查询
- 分块上传、服务端恢复和 Web 端断点续传

多入口选路、WebAuthn、临时码、P2P、入口/全局限速等仍属于 Phase 3/4 路线图，勿描述为当前已交付。

## 2. 当前阶段

**Phase 1 MVP 与 Phase 2 自动化实现/验证已完成；发布验收未完成。**

- Phase 1 基础能力、Phase 2 TOTP/恢复码/API Token/MCP/审计/断点续传/并发回归已实现并自动化测试。
- 真实 MCP 客户端、375px 浏览器/设备布局、TOTP+恢复码真实流程及刷新后断点续传仍待用户手动验收；当前内置浏览器访问 localhost 被 `ERR_BLOCKED_BY_CLIENT` 阻断。
- 截至 2026-09-26 的 npm audit 有关键生产依赖风险，发布 security gate 为 blocked/pending；详见 `docs/CURRENT-STATE.md`，不得把自动化通过表述成发布完成。

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

- 首次初始化必须使用短时、一次性初始化 Token；公网反代部署应额外限制初始化路由，不得假设应用会识别远端请求是否来自本机
- 一次性初始化 Token 10 分钟有效期
- 初始化完成后 Token 立即失效

### 6.3 认证安全

- 所有密码使用 bcrypt 哈希
- 临时码 secret 使用 Argon2id 哈希
- API Token 仅存储 SHA-256 哈希
- JWT 必须区分 `principal_type: admin | api_token`
- API Token 只保存不可逆校验值，创建明文仅展示一次；每次请求必须校验 Token 仍有效并按当前授权拒绝越权
- 受保护路由必须遵循最小权限和默认拒绝原则；TOTP 等加密密钥依赖生产 `JWT_SECRET`，必须稳定备份。实现细节见 `docs/CURRENT-STATE.md`

### 6.4 Agent/MCP 安全

- 默认关闭 Agent 接入；只授予完成任务所需的最小权限，敏感凭据须通过受保护的 Authorization header 传递
- API Token 创建明文只展示一次；及时吊销不再使用的 Token，不得在 URL query、客户端源码、日志、截图或提交中暴露
- 对 Agent 请求继续强制逐工具/路由最小权限和专用资源上限；不得为 Agent 全局放宽普通 API 的解析/上传限额。实际端点、工具、scope 与大小限制见 `docs/CURRENT-STATE.md`
- 不把某个具体 MCP 客户端配置文件格式当成稳定项目契约；README 示例必须用占位符，不可复述真实 Token
- `audit_logs.details` 不做通用凭据脱敏；严禁记录密码、TOTP secret/code、完整 API/Upload Token、恢复码、临时码 secret

### 6.5 文件安全

- 用户上传的 HTML/SVG/JS 强制 `Content-Disposition: attachment`
- 允许 inline 的 MIME 类型白名单：图片/视频/音频/PDF
- 响应头必须包含 `X-Content-Type-Options: nosniff` 和 `Content-Security-Policy: sandbox`
- 上传 finalizer 必须保留 owner 专属 staging 与孤儿扫描间的不变量，不得清理/覆盖其他 owner 的文件；具体命名及验证测试见 `docs/CURRENT-STATE.md`
- **禁止混合版本并写**：旧版和新版进程不能同时写相同数据库/存储路径。升级前先 drain/stop 所有旧进程，再启动新版本；SQLite lease 不是文件系统 CAS。

## 7. 开发流程

### 7.1 标准任务流程

1. 确认当前状态：`docs/CURRENT-STATE.md`
2. 写或更新测试
3. 实现最小改动
4. 显式运行 server unit、server full E2E、Web Vitest（`--run --no-cache`）、`npm run typecheck`、`npm run build` 与 `git diff --check`；仓库根 `npm test` 因 `packages/shared` 没有 `test` script 会退出 1，不可误报为全套测试失败或通过
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
npm test --workspace=@filestation/server -- --runInBand
npm run test:e2e --workspace=@filestation/server
cd apps/web
npx vitest run --no-cache
cd ../..
npm run typecheck
npm run build
git diff --check
```

`npm run lint` 当前需要 `eslint` 可执行文件，但 server/web 的已安装依赖中没有 ESLint，shared 也没有 lint script；应复核现状并准确报告“不可用”，不得声称 lint 通过。根 `npm test` 包含无 `test` script 的 shared workspace，会非零退出；用上面的 workspace 命令分别验证。

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
- Nginx 可选；公网 FRP 场景建议作为 TLS 终结/反代并提供初始化本机限制
- SQLite（嵌入式，无需单独安装）

### 11.2 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FILESTATION_STORAGE_PATH` | 文件存储路径 | `./data/storage` |
| `FILESTATION_DB_PATH` | SQLite 数据库路径 | `./data/filestation.db` |
| `FILESTATION_INIT_TOKEN` | 初始化 Token（可选） | 自动生成 |
| `FILESTATION_PORT` | 服务端口 | `8080` |
| `JWT_SECRET` | JWT 与 TOTP 密文 key 派生 | 生产环境必须设置且保持稳定 |

### 11.3 发布检查清单

- [ ] `npm run build` 成功
- [ ] server unit + server full E2E + Web Vitest 显式通过；不要依赖会在 shared workspace 失败的根 `npm test`
- [ ] `npm run typecheck` 无错误
- [ ] 数据库迁移测试通过
- [ ] 审阅并处置 `npm audit` Critical/High；如保留例外需单独记录风险接受，不能把有 Critical/High 的审计称为通过
- [ ] 版本号更新（SemVer）
- [ ] CHANGELOG 更新

## 12. 禁止事项

- **禁止** 使用 `SELECT ... FOR UPDATE`（SQLite 不支持）
- **禁止** 在 SQLite 写事务中执行文件 I/O 或网络请求
- **禁止** 将客户端提交的 `X-Entry-Id` 等安全 Header 直接信任
- **禁止** 在 URL 查询参数中传递密码或长期 Token
- **禁止** 使用 `Access-Control-Allow-Origin: *`
- **禁止** 提交 `data/` 目录下的运行时数据
- **禁止** 混合旧/新版本进程同时写同一 SQLite DB 与 storage；升级前停止旧进程

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
