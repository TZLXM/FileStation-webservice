import { registerAs } from '@nestjs/config';

export default registerAs('app', () => {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const jwtSecret = process.env.JWT_SECRET;

  // 生产环境必须设置 JWT_SECRET
  if (nodeEnv === 'production' && !jwtSecret) {
    throw new Error('JWT_SECRET is required in production');
  }

  const port = parseInt(process.env.FILESTATION_PORT || '8080', 10);

  // Nginx 可选项（v1.8）：无 Nginx 直连部署时设 FILESTATION_SERVE_STATIC=true，
  // 由本进程托管 apps/web/dist 构建产物（SPA 回退到 index.html）。
  // 注意：setGlobalPrefix('api/v1') 之后所有非 /api 路径都不会匹配控制器，
  // 因此 serve-static 的 SPA 回退不会与 API 路由冲突。
  const serveStatic = process.env.FILESTATION_SERVE_STATIC === 'true';
  const webDistPath = process.env.FILESTATION_WEB_DIST || '../web/dist';

  // 监听地址：默认 127.0.0.1（Nginx 反代场景）；
  // 无 Nginx 局域网直连时设 FILESTATION_HOST=0.0.0.0 对外开放。
  const host = process.env.FILESTATION_HOST || '127.0.0.1';

  // CORS：仅在"前端与 API 不同源"时需要（开发模式 vite:5173，或显式 FILESTATION_CORS_ORIGINS）。
  // 静态托管同源部署时 CORS 自动关闭（浏览器不发 CORS 请求）。
  const corsOrigins = process.env.FILESTATION_CORS_ORIGINS
    ? process.env.FILESTATION_CORS_ORIGINS.split(',').map((o) => o.trim())
    : serveStatic
      ? []
      : ['http://localhost:5173', 'http://127.0.0.1:5173'];

  return {
    nodeEnv,
    port,
    host,
    serveStatic,
    webDistPath,
    corsOrigins,
    storagePath: process.env.FILESTATION_STORAGE_PATH || './data/storage',
    tempPath: process.env.FILESTATION_TEMP_PATH || './data/temp',
    dbPath: process.env.FILESTATION_DB_PATH || './data/filestation.db',
    jwtSecret: jwtSecret || 'dev-secret-change-in-production',
    jwtExpiresIn: '24h',
    refreshTokenExpiresIn: '7d',
  };
});
