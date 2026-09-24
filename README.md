# FileStation

私有文件传输站 Web 应用：单管理员、文件默认私有，通过分享链接对外提供受控访问，文件到期自动清理。适用于局域网直连或经 FRP 暴露到公网的自托管场景。

## 已实现功能

- **安全初始化**：首次启动生成一次性初始化 Token（哈希存储、10 分钟有效、仅本机可完成初始化）
- **认证**：账号密码登录 + JWT Access Token + Refresh Token（HttpOnly Cookie）+ 登录锁定（账号维度固定锁定 + IP 维度独立限速）
- **分块上传**：三阶段完成协议（抢占 → 合并校验 → 落库），租约心跳 + 崩溃后自动恢复续传
- **下载**：HTTP Range 支持（断点续传/多线程下载器兼容），416 标准响应
- **分享链接**：免密 / 密码保护，可设下载次数上限与有效期，下载票据四层重校验
- **文件夹**：虚拟文件夹树、嵌套、移动文件
- **自动过期**：文件可设有效期，到期自动清理；可手动延长或设为永久
- **基础设置**：默认有效期、分块大小、清理宽限期、登录锁定参数
- **API Token**：管理员可签发与吊销 Token；exchange 短期 JWT 按数据库 scopes 授权
- **审计日志**：管理员可通过 `GET /api/v1/audit-logs` 分页查询关键操作，支持按 action 筛选；IP 匿名化并保留 90 天

路线图中（Phase 2-4）：TOTP / WebAuthn 认证、多 FRP 入口智能选路、直链分享、限速控制、临时码、P2P 传输、统计面板。详见 [当前状态](docs/CURRENT-STATE.md)。

## 技术栈

- **后端**: NestJS 10 (Node.js/TypeScript)
- **前端**: React 18 + Tailwind CSS
- **数据库**: SQLite (TypeORM, WAL 模式)
- **构建**: Vite + npm workspaces

## 快速开始

要求 Node.js ≥ 20。

```bash
git clone https://github.com/TZLXM/FileStation-webservice.git
cd FileStation-webservice
npm install
npm run build
npm start
```

首次启动后，控制台会打印完整的初始化地址和一次性 Token，浏览器打开该地址设置管理员账号即可。

### 部署模式

Nginx 是**可选项**，不是必需的：

| 命令 | 模式 | 说明 |
|------|------|------|
| `npm start` | 单进程（默认） | 监听 `0.0.0.0:8080`，前端静态文件由本进程托管。局域网直连开箱即用 |
| `npm run start:bynginx` | Nginx 反代 | 只监听 `127.0.0.1:8080`，不托管前端。前端由 Nginx 托管并反代 `/api`，参考配置见 [deploy/nginx/filestation.conf](deploy/nginx/filestation.conf) |
| `npm run dev` | 开发模式 | vite 开发服务器（5173）+ 后端（8080），支持热更新 |

**公网部署建议**：经 FRP 暴露到公网时建议使用 Nginx 模式——初始化端点 `/api/v1/auth/init` 可获得 Nginx 层"仅本机可达"的额外防护（无 Nginx 时仅由一次性 Token 保护）。同时生产环境必须设置 `JWT_SECRET` 环境变量。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `FILESTATION_PORT` | `8080` | 监听端口 |
| `FILESTATION_HOST` | `127.0.0.1` | 监听地址（`npm start` 脚本已设为 `0.0.0.0`） |
| `FILESTATION_SERVE_STATIC` | 关闭 | `=true` 时由本进程托管前端构建产物（`npm start` 脚本已开启） |
| `FILESTATION_WEB_DIST` | `apps/web/dist` | 前端构建产物路径（相对仓库根） |
| `FILESTATION_CORS_ORIGINS` | — | 逗号分隔的允许跨域来源；前后端同源部署时无需设置 |
| `FILESTATION_WEB_URL` | 服务自身地址 | 开发模式下指向 vite 地址，用于打印正确的初始化 URL |
| `FILESTATION_STORAGE_PATH` | `./data/storage` | 文件存储目录 |
| `FILESTATION_TEMP_PATH` | `./data/temp` | 上传分块临时目录 |
| `FILESTATION_DB_PATH` | `./data/filestation.db` | SQLite 数据库路径 |
| `JWT_SECRET` | — | JWT 签名密钥，**生产环境必须设置** |

## 文档

- [当前状态](docs/CURRENT-STATE.md) — 实现进度和里程碑
- [设计文档](docs/superpowers/specs/2026-07-28-filestation-design.md) — 详细架构设计
- [开发手册](AGENTS.md) — Agent 开发指南
- [架构决策](docs/adr/) — 技术决策记录

## 开发

```bash
npm run dev        # 开发模式（前后端并行，热更新）
npm run typecheck  # 类型检查
npm run lint       # Lint
npm test           # 测试
npm run build      # 构建（shared → server → web）
```

## 许可证

MIT

---

*项目状态: Phase 1 MVP 已完成，Phase 2 规划中*
