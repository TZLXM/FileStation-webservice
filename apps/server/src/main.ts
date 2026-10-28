import { realpath } from 'fs/promises';
import {
  loadInstallEnvironment,
  loadManagedInstallMetadata,
  validateManagedLaunch,
  validateManagedLaunchOnDisk,
} from './bootstrap/managed-preflight';
import { detectStartupMode } from './bootstrap/startup-mode';
import {
  ParsedStartupExecution,
  parseStartupExecution,
  RefusingTrustedStartupAccess,
  TrustedStartupAccess,
  UpdateStartupIntent,
} from './maintenance/startup-authority';
import {
  startGatedApplication,
  startValidationApplication,
} from './maintenance/server-startup';

interface PreparedStartup {
  mode: 'legacy' | 'managed';
  root: string;
  releaseRealpath?: string;
}

function applyEnvironment(values: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

async function prepareStartup(): Promise<PreparedStartup> {
  const cwdRealpath = await realpath(process.cwd());
  const executableRealpath = await realpath(__filename);
  const startup = await detectStartupMode({
    cwd: cwdRealpath,
    executableRealpath,
  });
  const invocationEnvironment = { ...process.env };
  const environment = await loadInstallEnvironment(startup.root, { processEnvironment: invocationEnvironment });
  applyEnvironment(environment.values);
  if (startup.mode === 'legacy') {
    return { mode: 'legacy', root: startup.root };
  }

  const metadata = await loadManagedInstallMetadata(startup.root);
  const currentRealpath = await realpath(metadata.currentPath);
  const plan = await validateManagedLaunchOnDisk({
    cwd: cwdRealpath,
    executableRealpath,
    installMetadata: metadata,
    environment: environment.values,
    processEnvironment: invocationEnvironment,
    currentRealpath,
    configuredPaths: {
      database: environment.values.FILESTATION_DB_PATH,
      storage: environment.values.FILESTATION_STORAGE_PATH,
      temp: environment.values.FILESTATION_TEMP_PATH,
    },
  });
  applyEnvironment(plan.environment);
  return {
    mode: 'managed',
    root: startup.root,
    releaseRealpath: plan.releaseRealpath,
  };
}

async function prepareAuthorizedUpdateStartup(
  intent: UpdateStartupIntent,
): Promise<PreparedStartup> {
  const cwdRealpath = await realpath(process.cwd());
  const executableRealpath = await realpath(__filename);
  const installRoot = await realpath(intent.attempt.installRoot);
  if (installRoot !== intent.attempt.installRoot) {
    throw new Error('authorized update install root must be canonical');
  }
  const startup = await detectStartupMode({
    cwd: cwdRealpath,
    executableRealpath,
    environment: {
      ...process.env,
      FILESTATION_INSTALL_ROOT: installRoot,
    },
  });
  if (startup.mode !== 'managed') {
    throw new Error('update validation and gated startup require a managed install');
  }
  const invocationEnvironment = { ...process.env };
  const environment = await loadInstallEnvironment(startup.root, {
    processEnvironment: invocationEnvironment,
  });
  applyEnvironment(environment.values);
  const metadata = await loadManagedInstallMetadata(startup.root);
  const currentRealpath = await realpath(metadata.currentPath);
  const plan = validateManagedLaunch({
    cwd: cwdRealpath,
    executableRealpath,
    installMetadata: metadata,
    environment: environment.values,
    processEnvironment: invocationEnvironment,
    currentRealpath,
    configuredPaths: {
      database: environment.values.FILESTATION_DB_PATH,
      storage: environment.values.FILESTATION_STORAGE_PATH,
      temp: environment.values.FILESTATION_TEMP_PATH,
    },
  });
  applyEnvironment(plan.environment);
  return {
    mode: 'managed',
    root: startup.root,
    releaseRealpath: plan.releaseRealpath,
  };
}

async function bootstrapNormal() {
  const prepared = await prepareStartup();
  const { NestFactory } = await import('@nestjs/core');
  const { Logger } = await import('@nestjs/common');
  const { AppModule } = await import('./app.module');
  const { ConfigService } = await import('@nestjs/config');
  const { AuthService } = await import('./auth/auth.service');
  const { StorageService } = await import('./files/storage.service');
  const { FileLifecycleService } = await import(
    './files/file-lifecycle.service'
  );
  const { setupFullApplication } = await import(
    './common/http/application-setup'
  );
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

  // ========== 阶段 1：创建应用（migrationsRun 在此触发） ==========
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  const configService = app.get(ConfigService);

  setupFullApplication(app, configService);

  // ========== 阶段 3：app.init() 触发数据库初始化 ==========
  await app.init();
  await app.get(StorageService).activate();
  await app.get(FileLifecycleService).activate();

  // ========== 阶段 4：init token 覆盖（listen 前写入 DB，防 listen 后窗口期旧 token 仍有效） ==========
  const authService = app.get(AuthService);
  const initToken = await authService.ensureInitToken();

  // ========== 阶段 5：最后才监听 ==========
  await app.listen(port, host);

  const serveStatic = configService.get<boolean>('app.serveStatic');
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  logger.log(`FileStation server running on http://${displayHost}:${port}`);
  logger.log(`Environment: ${configService.get<string>('app.nodeEnv')}`);
  if (prepared.mode === 'managed') {
    logger.log(
      `Managed startup: install=${prepared.root}, release=${prepared.releaseRealpath}`,
    );
  }
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
  return { app, prepared, configService, initToken };
}

async function bootstrapUpdate(
  execution: Exclude<ParsedStartupExecution, { mode: 'normal' }>,
  access: TrustedStartupAccess,
) {
  const intent: UpdateStartupIntent = {
    mode: execution.mode,
    attempt: execution.attempt,
  };
  await access.authorizeStartup(intent);
  const prepared = await prepareAuthorizedUpdateStartup(intent);
  const { Logger } = await import('@nestjs/common');
  const logger = new Logger('Bootstrap');

  if (execution.mode === 'validate') {
    const handle = await startValidationApplication({
      access,
      intent,
      startupAuthorized: true,
    });
    const address = handle.app.getHttpServer().address();
    const port =
      address && typeof address === 'object' ? address.port : 0;
    logger.log(
      `Update validation listening on 127.0.0.1:${port} (release=${prepared.releaseRealpath})`,
    );
    return handle;
  }

  const handle = await startGatedApplication({
    access,
    intent,
    startupAuthorized: true,
    host: process.env.FILESTATION_HOST || '127.0.0.1',
    port: parseInt(process.env.FILESTATION_PORT || '8080', 10),
    onCommitted: async (app) => {
      const { AuthService } = await import('./auth/auth.service');
      await app.get(AuthService).ensureInitToken();
    },
  });
  void handle.committed.then(
    () => logger.log('Matching durable COMMITTED observed; normal service activated'),
    (error) =>
      logger.error(
        `Gated startup failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      ),
  );
  logger.log(
    `Update gated service listening in maintenance mode (release=${prepared.releaseRealpath})`,
  );
  return handle;
}

export async function bootstrap(
  startupAccess: TrustedStartupAccess = new RefusingTrustedStartupAccess(),
) {
  const execution = parseStartupExecution(process.argv.slice(2));
  if (execution.mode !== 'normal') {
    return bootstrapUpdate(execution, startupAccess);
  }
  return bootstrapNormal();
}

if (require.main === module) {
  void bootstrap().catch((error) => {
    const message =
      error instanceof Error ? error.message : 'FileStation startup failed';
    process.stderr.write(`FileStation startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
