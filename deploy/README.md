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

刷新 Cookie 未显式设置 `Path`，浏览器默认作用域为 `/`，同时覆盖根路径和
`/fs/`；不要为子路径另设不兼容的 Cookie Path。
