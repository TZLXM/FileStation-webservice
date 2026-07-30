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

async function bootstrap() {
  const logger = new Logger('Bootstrap');

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
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.use(cookieParser());
  app.setGlobalPrefix('api/v1'); // 唯一前缀来源
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: false }, // DTO @Type 显式转换
    }),
  );
  app.useGlobalFilters(new RangeNotSatisfiableFilter()); // 416 + Content-Range
  app.enableCors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  });

  // ========== 阶段 3：app.init() 触发 OnApplicationBootstrap ==========
  // DatabaseInitializer（PRAGMA + foreign_keys 校验）、StorageService.ensureDirectories、
  // FileLifecycleService 启动扫描 在此执行，migrationsRun 已完成
  await app.init();

  // ========== 阶段 4：init token 覆盖 —— 必须在 listen 之前 ==========
  // 修复 v1.5 竞态：旧 token 在 listen 后才被覆盖存在窗口期；现在端口开放前完成覆盖
  const authService = app.get(AuthService);
  const initToken = await authService.ensureInitToken();
  const port = configService.get<number>('app.port') || 8080;
  if (initToken) {
    // 初始化页面是前端路由（React /init），不是后端 API（POST /api/v1/auth/init 仅接受 POST）。
    // 生产模式 Nginx 同端口托管前端+反代后端（默认 http://localhost:8080/init）；
    // 开发模式前后端分离（vite 5173），设 FILESTATION_WEB_URL=http://localhost:5173 指向开发前端。
    const webUrl = process.env.FILESTATION_WEB_URL || `http://localhost:${port}`;
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

  // ========== 阶段 5：最后才监听 ==========
  await app.listen(port, '127.0.0.1');

  logger.log(`FileStation server running on http://127.0.0.1:${port}`);
  logger.log(`Environment: ${configService.get<string>('app.nodeEnv')}`);
}

bootstrap();
