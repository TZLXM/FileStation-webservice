# FileStation 部署

## 前置
- Node.js 20+
- 构建：`npm run build`（server + web + shared）

## 环境变量
- `JWT_SECRET`（生产必填，缺失时启动抛错）
- `FILESTATION_PORT`（默认 8080）
- `FILESTATION_STORAGE_PATH`（默认 ./data/storage）
- `FILESTATION_TEMP_PATH`（默认 ./data/temp）
- `FILESTATION_DB_PATH`（默认 ./data/filestation.db）

## 启动
1. `node apps/server/dist/main.js`
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
