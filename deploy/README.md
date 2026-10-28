# FileStation 部署

## 前置
- Node.js 20.17+
- 构建：`npm run build`（shared + update-core + updater + server + web）

## 环境变量
- `JWT_SECRET`（生产必填，缺失时启动抛错）
- `FILESTATION_PORT`（默认 8080）
- `FILESTATION_STORAGE_PATH`（默认 ./data/storage）
- `FILESTATION_TEMP_PATH`（默认 ./data/temp）
- `FILESTATION_DB_PATH`（默认 ./data/filestation.db）


### Managed 配置来源与迁移

Managed launcher 从安装根 `.env` 读取，已存在的调用进程环境优先；在导入
AppModule、mkdir 或打开数据库前验证。Bootstrap 必须明确提供原有 NODE_ENV（production/development/test），缺失时拒绝
猜测 development。生产环境必须保留相同的 `JWT_SECRET`
及 `NODE_ENV=production`。若必需项只在旧 shell，使用可信编辑器迁移到受限
`.env`（POSIX 0600 / Windows 运行账户与管理员专属 ACL），或安全配置新服务
环境并显式指定 `--production-env-resolution service`（PowerShell 为
`-ProductionEnvResolution service`）。service 模式每次启动要求调用环境直接
提供这两个变量，不回退到旧 dotenv secret。Bootstrap 只记录名称/来源，不
自动落盘 shell secret、不打印值、不修改服务。不要更换 JWT secret，否则
现有 TOTP 密文会失效。

操作员变量：`NODE_ENV`、`JWT_SECRET`；`FILESTATION_DB_PATH`、
`FILESTATION_STORAGE_PATH`、`FILESTATION_TEMP_PATH`；`FILESTATION_PORT`
（8080）、`FILESTATION_HOST`（127.0.0.1）、`FILESTATION_SERVE_STATIC`
（true 启用静态托管）、`FILESTATION_WEB_DIST`（../web/dist）、
`FILESTATION_CORS_ORIGINS`（逗号分隔；默认同源或开发回环）、
`FILESTATION_WEB_URL`（初始化页地址，默认本进程地址）。脚本可用
`FILESTATION_NODE` 选择 Node 20.17+。`FILESTATION_DEBUG=1` 仅增加本地
CLI 错误栈。`FILESTATION_MANAGED_LAUNCH`、`FILESTATION_INSTALL_ID`、
`FILESTATION_INSTALL_ROOT`、`FILESTATION_RELEASE_ROOT` 由稳定 launcher 设置，
不得手工伪造以绕过校验。

Linux 在源码、打包和解压后的支持调用方式均为显式 bash，文件可保持 0600：

```bash
bash scripts/bootstrap-update.sh --help
bash scripts/start-filestation.sh --root /srv/filestation --dry-run
```

完整的旧进程身份、路径变更、原始 DB/目标 DB 分离验证、恢复与人工 Nginx
步骤见 [UPDATING.md](../docs/UPDATING.md)。

### Managed 安装与升级

v0.2.5 的稳定布局以 `/opt/filestation` 为例：

```text
/opt/filestation/current/       -> releases/<release>
/opt/filestation/releases/       # 当前与回滚版本
/opt/filestation/updater/        # 独立 updater
/opt/filestation/data/           # DB、storage、temp
/opt/filestation/.env            # 受限配置
```

源码部署先按 UPDATING.md 停止全部旧进程、校验旧 `.env` 来源与 canonical
数据路径，再执行一次 bootstrap。managed 启动和 recover 必须以安装根为 cwd。
调用环境变量优先于 `.env`；生产 `NODE_ENV` 和稳定的 `JWT_SECRET` 必须在任何
数据库或目录写入前通过校验。状态、单 attempt 恢复、失败诊断确认和
bootstrap 专属备份清理命令见 UPDATING.md。

Docker 不执行应用内自更新、不挂载 Docker socket。管理员记录当前/目标镜像
tag 或 immutable digest、备份挂载的 DB/storage，并通过 Compose 手动拉取和
更新；回滚改用先前记录的镜像 digest，旧、新容器不得同时挂载并写同一数据。

## 启动
1. managed 安装从安装根运行 `scripts/start-filestation.ps1` 或
   `bash scripts/start-filestation.sh --root <install-root>`。源码模式可运行
   `node apps/server/dist/main.js`
2. 控制台打印初始化 Token（10 分钟有效，仅本机）
3. 本机浏览器访问 `/init` 完成管理员初始化

## Nginx
```bash
sudo cp deploy/nginx/filestation.conf /etc/nginx/sites-available/filestation
sudo ln -s /etc/nginx/sites-available/filestation /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 根路径构建（默认）
npm run build --workspace=@filestation/web

# 子路径 /fs/ 构建；随后启用配置中的 /fs/ 示例段
npx cross-env FILESTATION_BASE=/fs/ npm run build --workspace=@filestation/web
```

Managed 安装的 Nginx `root`/`alias` 必须指向
`<install-root>/current/apps/web/dist`，不能继续指向源码目录。
根路径与子路径部署二选一，分别使用各自的 Web 构建产物。子路径构建会生成
`/fs/assets/...` 引用；浏览器中的 API 请求使用 `/fs/api/v1/...`，分享页使用
`/fs/s/...`。Nginx 在 `location /fs/api/` 代理前去掉 `/fs`，所以后端仍只看到
canonical `/api/v1/...` 路径。根路径与 `/fs/` 初始化端点都保留仅允许回环
地址的 `allow/deny`。该配置不增加 CORS 或 trust-proxy 设置。

刷新 Cookie 的调用未显式设置 `Path`，Express `res.cookie` 默认设置 `Path=/`，同时覆盖根路径和
`/fs/`。若响应未包含 `Path` 属性，浏览器会按请求路径计算默认路径，并非始终为 `/`；不要为子路径另设不兼容的 Cookie Path。


初始化安全限制覆盖 Express 默认接受的整个路径大小写变化和单个尾随斜杠：
canonical `/api/v1/auth/init` 与 `/fs/api/v1/auth/init` 仍由精确 location
执行回环 `allow/deny`；非 canonical 变体（如 `/api/v1/auth/INIT`、
`/API/V1/AUTH/INIT/` 和 `/fs/api/v1/auth/init/`）由大小写不敏感的 regex
location 返回 403。启用 `/fs/` 示例时必须一并启用其精确初始化与 regex
拒绝规则；不要为 API prefix 添加 `^~`，以免绕过 regex 检查。
Nginx 按规范化后的 URI 匹配 location（百分号解码、默认合并相邻斜杠、处理
`.`/`..`），因此编码或规范化后命中初始化路径的请求仍进入对应限制。
该限制由 Nginx 执行，不依赖后端 `req.ip`、trust-proxy 或 CORS。

本机未安装 Nginx；现有回归读取实际配置并对照已安装 Express 路由 matcher，
仅提供静态匹配证据。部署前仍须执行 `nginx -t`，并从非回环客户端验证根路径
和 `/fs/` 的 canonical、大小写、尾斜杠及编码变体均无法初始化；真实代理验收 pending。
