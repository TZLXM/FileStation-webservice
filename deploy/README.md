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
