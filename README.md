# FileStation

私有文件传输站 Web 应用：单管理员、文件默认私有，通过分享链接对外提供受控访问，文件到期自动清理。适用于局域网直连或经 FRP 暴露到公网的自托管场景。

## 已实现功能

- **安全初始化**：首次启动生成哈希存储的一次性初始化 Token（10 分钟有效、成功后失效）；公网反代可额外限制初始化路由
- **认证**：账号密码登录 + JWT Access Token + Refresh Token（HttpOnly Cookie）+ 登录锁定（账号维度固定锁定 + IP 维度独立限速）
- **分块上传**：三阶段完成协议（抢占 → 合并校验 → 落库），租约心跳 + 崩溃后自动恢复续传
- **下载**：HTTP Range 支持（断点续传/多线程下载器兼容），416 标准响应
- **分享链接**：免密 / 密码保护，可设下载次数上限与有效期，下载票据四层重校验
- **文件夹**：虚拟文件夹树、嵌套、移动文件
- **自动过期**：文件可设有效期，到期自动清理；可手动延长或设为永久
- **基础设置**：默认有效期、分块大小、清理宽限期、登录锁定参数
- **API Token**：管理员可签发与吊销 Token；exchange 短期 JWT 按数据库 scopes 授权
- **MCP 服务**：启用设置中的 MCP 开关后，可通过无状态 Streamable HTTP `/api/v1/mcp` 使用 11 个文件、文件夹、上传与分享工具；直接使用 API Token，并按 token scopes 校验权限
- **审计日志**：管理员可通过 `GET /api/v1/audit-logs` 分页查询关键操作，支持按 action 筛选；IP 匿名化并保留 90 天
- **Managed 更新**：Windows x64 / Linux x64 独立 updater、管理员二次确认、WAL 安全快照、维护栅栏、失败回滚和重启健康验证

**v0.2.5 已完成本地候选实现，但 hosted candidate 与真实双平台/bootstrap/Docker/Nginx 验收尚未完成。** WebAuthn、多 FRP 入口智能选路、直链分享、限速控制、临时码、P2P 传输和统计面板仍属 Phase 3/4 路线图。当前安全门、用户手动验收与已知限制见[当前状态](docs/CURRENT-STATE.md)。

## 技术栈

- **后端**: NestJS 10 (Node.js/TypeScript)
- **前端**: React 18 + Tailwind CSS
- **数据库**: SQLite (TypeORM, WAL 模式)
- **构建**: Vite + npm workspaces

## 快速开始

要求 Node.js ≥ 20.17.0。

```bash
git clone https://github.com/TZLXM/FileStation-webservice.git
cd FileStation-webservice
npm install
npm run build
npm start
```

首次启动后，控制台会打印完整的初始化地址和一次性 Token，浏览器打开该地址设置管理员账号即可。

生产环境应预先设置 `JWT_SECRET` 并妥善备份。TOTP 密文加密 key 从该值派生；更换它会导致已保存的 TOTP secret 无法解密。

### v0.2.5 managed 升级

`v0.2.5` 增加 Windows x64 与 Linux x64 managed updater、管理员确认更新、
维护栅栏、SQLite WAL 快照、失败回滚和独立重启验证。旧式源码部署不能直接
点击自动安装，必须先停止全部旧进程，再执行一次手动 bootstrap。完整步骤、
`.env` 优先级与权限、Nginx 根路径/`/fs/`、`updater status/recover`、备份保留、
源码恢复和 Docker 手动更新见 [升级与恢复权威说明](docs/UPDATING.md)。

Docker 只显示镜像升级说明，不在容器内自更新，也不得挂载 Docker socket。
当前 `v0.2.5` 候选证据仍是 pending，双平台 bootstrap、确认更新、
pre-COMMITTED 回滚、Docker 拒绝和 Nginx 验收完成前不得创建稳定 tag。

### 部署模式

Nginx 是**可选项**，不是必需的：

| 命令 | 模式 | 说明 |
|------|------|------|
| `npm start` | 单进程（默认） | 监听 `0.0.0.0:8080`，前端静态文件由本进程托管。局域网直连开箱即用 |
| `npm run start:bynginx` | Nginx 反代 | 只监听 `127.0.0.1:8080`，不托管前端。前端由 Nginx 托管并反代 `/api`，参考配置见 [deploy/nginx/filestation.conf](deploy/nginx/filestation.conf) |
| `npm run dev` | 开发模式 | vite 开发服务器（5173）+ 后端（8080），支持热更新 |

**公网部署建议**：经 FRP 暴露到公网时建议使用 Nginx 模式——初始化端点 `/api/v1/auth/init` 可获得 Nginx 层"仅本机可达"的额外防护（无 Nginx 时仅由一次性 Token 保护）。同时生产环境必须设置 `JWT_SECRET` 环境变量。

### 根路径与子路径构建

Web 默认使用根路径。需要在反向代理下部署到 `/fs/` 时，在构建阶段设置
`FILESTATION_BASE`：

```bash
npm run build --workspace=@filestation/web
npx cross-env FILESTATION_BASE=/fs/ npm run build --workspace=@filestation/web
```

`FILESTATION_BASE` 是构建时配置，不是服务端运行时配置。Vite 会把它规范化后
写入页面、API、分享链接、下载票据和 MCP 端点；根路径与子路径应分别使用各自
的构建产物。Nginx 的 `/fs/` 示例会先移除代理路径前缀，后端 API 契约仍保持
`/api/v1/...`。具体配置见 [deploy/README.md](deploy/README.md)。

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `FILESTATION_PORT` | `8080` | 监听端口 |
| `FILESTATION_HOST` | `127.0.0.1` | 监听地址（`npm start` 脚本已设为 `0.0.0.0`） |
| `FILESTATION_SERVE_STATIC` | 关闭 | `=true` 时由本进程托管前端构建产物（`npm start` 脚本已开启） |
| `FILESTATION_WEB_DIST` | `apps/web/dist-root` | 前端构建产物路径（相对仓库根）；`/fs/` 使用 `apps/web/dist-fs` |
| `FILESTATION_CORS_ORIGINS` | — | 逗号分隔的允许跨域来源；前后端同源部署时无需设置 |
| `FILESTATION_WEB_URL` | 服务自身地址 | 开发模式下指向 vite 地址，用于打印正确的初始化 URL |
| `FILESTATION_STORAGE_PATH` | `./data/storage` | 文件存储目录 |
| `FILESTATION_TEMP_PATH` | `./data/temp` | 上传分块临时目录 |
| `FILESTATION_DB_PATH` | `./data/filestation.db` | SQLite 数据库路径 |
| `JWT_SECRET` | — | JWT 签名密钥，**生产环境必须设置** |

### Agent / MCP 接入

在 Web 设置中启用 MCP 并创建一个只授予所需 scope 的 API Token。Token 明文仅在创建时显示一次；丢失后需吊销并重新签发。MCP 使用无状态 Streamable HTTP `POST`：

```text
Endpoint (root): https://<YOUR_HOST>/api/v1/mcp
Endpoint (/fs/): https://<YOUR_HOST>/fs/api/v1/mcp
Authorization: Bearer <API_TOKEN>
```

`<API_TOKEN>` 是占位符，不是可用凭据。请使用 HTTPS，不要把 Token 放入 URL、源码、日志、截图或仓库。客户端配置文件格式因 MCP 客户端而异，本项目不声称提供某个桌面客户端专属 JSON 模板；请按所用客户端当前文档配置 endpoint 与安全凭据存储。MCP 默认关闭、每个工具按 API Token scope 授权；单文件默认上限 32 MiB（设置可调 1–512 MiB），单分块解码后最多 8 MiB，MCP JSON body 最多 16 MiB。

### 手动验收（部分完成，发布仍待验收）

- [x] 用户实际 MCP 客户端验收通过：`server_info`、上传、列表、分享、浏览器下载/读回、审计查询及 Token 吊销；直接 MCP `download_file` 工具当前不存在
- [ ] 在真实浏览器或设备检查 375px 布局
- [ ] 实际完成 TOTP 启用、登录、禁用及恢复码生成/单次恢复流程
- [ ] 刷新页面后重新选择原文件并验证断点续传

Web 上传现已在 LAN HTTP 缺少 SubtleCrypto 时使用 SHA-256 回退，并保留 `X-Part-Checksum` 校验；自动化回归验证了首个分块请求和准确校验值。继续续传时，点击“继续”后需要重新选择最初上传的同一个文件。

当前内置浏览器访问本地服务被 `ERR_BLOCKED_BY_CLIENT` 阻断，因此 375px、TOTP/恢复码及刷新后续传的真实设备验收仍待用户环境完成。2026-10-28 fresh registry audit 的 full 结果为 4 Critical / 7 High / 25 Moderate / 9 Low，production 为 1 Critical / 5 High / 19 Moderate，两个命令均 exit 1；Task 11 未执行大范围 audit fix 或 major 升级。Critical/High 处置或明确风险接受前发布保持 blocked，详情见 [当前状态](docs/CURRENT-STATE.md)。

## 文档

- [当前状态](docs/CURRENT-STATE.md) — 实现进度和里程碑
- [升级与恢复](docs/UPDATING.md) — v0.2.5 bootstrap、更新、回滚与 Docker 操作
- [设计文档](docs/superpowers/specs/2026-07-28-filestation-design.md) — 详细架构设计
- [开发手册](AGENTS.md) — Agent 开发指南
- [架构决策](docs/adr/) — 技术决策记录

## 开发

```bash
npm run dev                                            # 开发模式（前后端并行，热更新）
npm run typecheck                                     # 类型检查
npm run build                                         # 构建（shared → server → web）
npm test --workspace=@filestation/server -- --runInBand # Server 单测
npm run test:e2e --workspace=@filestation/server      # Server 全量 E2E
npm run build:runtime && npm run build --workspace=@filestation/server # Web projection 测试前置构建（fresh checkout 必需）
cd apps/web
npx vitest run --no-cache                             # Web Vitest（单次运行）
cd ../..
git diff --check                                      # 补丁空白检查
```

根 `npm test` 会遍历所有 workspace，但 `packages/shared` 没有 test script，因而退出非零；请显式运行上面的 Server/Web 命令，勿误报为完整测试套件通过。当前已安装依赖未提供 ESLint 可执行文件，`npm run lint` 可能不可用，需复核后如实报告。

Web 的真实更新状态 projection fixture 会加载已编译的 server 和 updater 模块；单独运行 Web 测试前也须从仓库根执行上述前置构建，不能依赖旧的 `apps/server/dist`。Windows PowerShell 使用 `npm.cmd`，将 `&&` 两侧命令分开执行并在每步检查 `$LASTEXITCODE`。

## 许可证

MIT

---

*项目状态: v0.2.5 本地候选；hosted candidate、真实双平台/Docker/Nginx 验收、签名与发布仍待完成，详见 docs/CURRENT-STATE.md*
