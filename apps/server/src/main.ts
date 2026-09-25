import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth/auth.service';
import { StorageService } from './files/storage.service';
import { RangeNotSatisfiableFilter } from './common/http/range-not-satisfiable.filter';
import cookieParser from 'cookie-parser';
import * as fs from 'fs/promises';
import { dirname } from 'path';
import { installNonMcpBodyParsers } from './common/http/body-parsers';
import { setupSwagger } from './common/swagger/setup-swagger';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // ========== 阶段 0：端口预检（防 EADDRINUSE 时 init token 未激活的混淆） ==========
  const port = parseInt(process.env.FILESTATION_PORT || '8080', 10);
  const host = process.env.FILESTATION_HOST || '127.0.0.1';
  const net = await import('net');
  const portBusy = await new Promise<boolean>((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(true))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, host);
  });
  if (portBusy) {
    logger.error('================================');
    logger.error(`端口 ${host}:${port} 已被占用（EADDRINUSE）`);
    logger.error('另一个 FileStation 进程可能仍在运行。');
    logger.error('如果刚看到"初始化 Token"提示，那它是【未激活】的——');
    logger.error('请先结束旧进程（或换端口），再重新启动以激活新 Token。');
    logger.error('================================');
    process.exit(1);
  }

  // ========== 阶段 1：目录预创建（NestFactory.create 之前，纯配置读取，无 DI） ==========
  // DatabaseModule 连接 SQLite 前 db 父目录必须存在，否则报 SQLITE_CANTOPEN
  const storagePath = process.env.FILESTATION_STORAGE_PATH || './data/storage';
  const tempPath = process.env.FILESTATION_TEMP_PATH || './data/temp';
  const dbPath = process.env.FILESTATION_DB_PATH || './data/filestation.db';
  await fs.mkdir(storagePath, { recursive: true });
  await fs.mkdir(tempPath, { recursive: true });
  await fs.mkdir(dirname(dbPath), { recursive: true });
  logger.log(`Directories ensured: storage=${storagePath}, temp=${tempPath}, db=${dirname(dbPath)}`);

  // ========== 阶段 2：创建应用（migrationsRun 在此触发） ==========
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const configService = app.get(ConfigService);

  // Ordinary routes retain the default 100KB parser limit. MCP is parsed only
  // inside its controller, after its disabled/method/auth gates.
  installNonMcpBodyParsers(app);
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1'); // 唯一前缀来源
  setupSwagger(app);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false }, // DTO @Type 显式转换
    }),
  );
  app.useGlobalFilters(new RangeNotSatisfiableFilter()); // 416 + Content-Range
  const corsOrigins = configService.get<string[]>('app.corsOrigins') ?? [];
  if (corsOrigins.length > 0) {
    app.enableCors({ origin: corsOrigins, credentials: true });
  }
  // CORS 为空 = 同源部署（静态托管或 FILESTATION_CORS_ORIGINS 未配置且非开发模式），
  // 浏览器不发 CORS 预检，无需 enableCors。

  // ========== 阶段 3：app.init() 触发 OnApplicationBootstrap ==========
  // DatabaseInitializer（PRAGMA + foreign_keys 校验）、StorageService.ensureDirectories、
  // FileLifecycleService 启动扫描 在此执行，migrationsRun 已完成
  await app.init();

  // ========== 阶段 4：init token 覆盖（listen 前写入 DB，防 listen 后窗口期旧 token 仍有效） ==========
  const authService = app.get(AuthService);
  const initToken = await authService.ensureInitToken();

  // ========== 阶段 5：最后才监听 ==========
  await app.listen(port, host);

  const serveStatic = configService.get<boolean>('app.serveStatic');
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  logger.log(`FileStation server running on http://${displayHost}:${port}`);
  logger.log(`Environment: ${configService.get<string>('app.nodeEnv')}`);
  if (serveStatic) {
    logger.log(`部署模式：单进程（无 Nginx）—— 前端静态文件由本进程托管于 http://${displayHost}:${port}`);
  } else if (host === '127.0.0.1') {
    logger.log('部署模式：仅监听回环（Nginx 反代场景，或开发模式 vite 代理）');
  } else {
    logger.log(`部署模式：直接监听 ${host}:${port}（无静态托管，前端需单独部署）`);
  }

  // ========== 阶段 6：listen 成功后才打印 init token（token 只在进程真正激活后显示） ==========
  // 防 EADDRINUSE 场景：进程打印了 token 却未启动成功，用户拿未激活 token 去初始化
  if (initToken) {
    // 初始化页面是前端路由（React /init），不是后端 API（POST /api/v1/auth/init 仅接受 POST）。
    // 单进程模式（FILESTATION_SERVE_STATIC=true）或 Nginx 同端口托管时，直接用服务端口；
    // 开发模式前后端分离（vite 5173），设 FILESTATION_WEB_URL=http://localhost:5173 指向开发前端。
    const webUrl = process.env.FILESTATION_WEB_URL || `http://${displayHost}:${port}`;
    logger.log('================================');
    logger.log('FileStation 首次启动（未初始化）');
    logger.log(`初始化 Token: ${initToken}`);
    logger.log('有效期：10 分钟，仅本机可完成初始化');
    logger.log('');
    logger.log('请在浏览器打开以下地址完成初始化：');
    logger.log(`  ${webUrl}/init`);
    logger.log('');
    logger.log('（输入上面的初始化 Token + 设置管理员用户名/密码）');
    logger.log('================================');
  }
}

bootstrap();
