import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuthService } from './auth/auth.service';
import { setupFullApplication } from './common/http/application-setup';
import { FileLifecycleService } from './files/file-lifecycle.service';
import { StorageService } from './files/storage.service';
import { ApplicationShutdownService } from './updates/application-shutdown.service';
import { bootstrap } from './main';

jest.mock('@nestjs/common', () => ({
  ...jest.requireActual('@nestjs/common'),
  Logger: class Logger {
    log = jest.fn();
    error = jest.fn();
  },
}));
jest.mock('@nestjs/core', () => ({
  NestFactory: {
    create: jest.fn(),
  },
}));
jest.mock('@nestjs/config', () => ({
  ConfigService: class ConfigService {},
}));
jest.mock('typeorm', () => ({
  DataSource: class DataSource {},
}));
jest.mock('./app.module', () => ({
  AppModule: class AppModule {},
}));
jest.mock('./auth/auth.service', () => ({
  AuthService: class AuthService {},
}));
jest.mock('./bootstrap/managed-preflight', () => ({
  loadInstallEnvironment: jest.fn(async () => ({ values: {} })),
  loadManagedInstallMetadata: jest.fn(),
  validateManagedDataOnDisk: jest.fn(),
  validateManagedLaunchOnDisk: jest.fn(),
}));
jest.mock('./bootstrap/startup-mode', () => ({
  detectStartupMode: jest.fn(async () => ({
    mode: 'legacy',
    root: process.cwd(),
  })),
}));
jest.mock('./common/http/application-setup', () => ({
  setupFullApplication: jest.fn(),
}));
jest.mock('./files/file-lifecycle.service', () => ({
  FileLifecycleService: class FileLifecycleService {},
}));
jest.mock('./files/storage.service', () => ({
  StorageService: class StorageService {},
}));
jest.mock('./maintenance/server-startup', () => ({
  startGatedApplication: jest.fn(),
  startValidationApplication: jest.fn(),
}));
jest.mock('./updates/application-shutdown.service', () => ({
  ApplicationShutdownService: class ApplicationShutdownService {
    attach = jest.fn();
  },
}));

interface FakeApplication {
  app: {
    get: jest.Mock;
    getHttpServer: jest.Mock;
    enableShutdownHooks: jest.Mock;
    init: jest.Mock;
    listen: jest.Mock;
    close: jest.Mock;
  };
  config: { get: jest.Mock };
  init: jest.Mock;
  listen: jest.Mock;
  close: jest.Mock;
  storage: { activate: jest.Mock };
  fileLifecycle: { activate: jest.Mock };
  auth: { ensureInitToken: jest.Mock };
  database: { query: jest.Mock };
}

function createFakeApplication(): FakeApplication {
  const config = {
    get: jest.fn((key: string) =>
      key === 'app.serveStatic' ? false : 'test',
    ),
  };
  const init = jest.fn(async () => undefined);
  const httpServer = { listening: false };
  const listen = jest.fn(async () => {
    httpServer.listening = true;
  });
  const close = jest.fn(async () => {
    httpServer.listening = false;
  });
  const storage = { activate: jest.fn(async () => undefined) };
  const fileLifecycle = { activate: jest.fn(async () => undefined) };
  const auth = { ensureInitToken: jest.fn(async () => undefined) };
  const database = { query: jest.fn(async () => [{ integrity_check: 'ok' }]) };
  const shutdown = { attach: jest.fn() };
  const app = {
    get: jest.fn((token: unknown) => {
      if (token === ApplicationShutdownService) return shutdown;
      if (token === ConfigService) return config;
      if (token === StorageService) return storage;
      if (token === FileLifecycleService) return fileLifecycle;
      if (token === AuthService) return auth;
      if (token === DataSource) return database;
      throw new Error('unexpected application dependency');
    }),
    getHttpServer: jest.fn(() => httpServer),
    enableShutdownHooks: jest.fn(),
    init,
    listen,
    close,
  };
  return {
    app,
    config,
    init,
    listen,
    close,
    storage,
    fileLifecycle,
    auth,
    database,
  };
}

describe('normal startup failure cleanup', () => {
  let environment: NodeJS.ProcessEnv;
  let argv: string[];

  beforeEach(() => {
    environment = { ...process.env };
    argv = process.argv;
    process.argv = ['node', 'main.js'];
    process.env.FILESTATION_PORT = '0';
    process.env.FILESTATION_HOST = '127.0.0.1';
    delete process.env.FILESTATION_INSTALL_ROOT;
    ((NestFactory.create as unknown) as jest.Mock).mockReset();
    (setupFullApplication as jest.Mock).mockReset();
  });

  afterEach(() => {
    process.env = environment;
    process.argv = argv;
    jest.restoreAllMocks();
  });

  it.each([
    ['init', (value: FakeApplication) => value.init],
    ['storage activation', (value: FakeApplication) => value.storage.activate],
    [
      'file lifecycle activation',
      (value: FakeApplication) => value.fileLifecycle.activate,
    ],
    ['listen', (value: FakeApplication) => value.listen],
    ['health query', (value: FakeApplication) => value.database.query],
  ])('closes the application when %s fails', async (_phase, select) => {
    const value = createFakeApplication();
    const originalError = new Error(`${_phase} failed`);
    select(value).mockRejectedValueOnce(originalError);
    ((NestFactory.create as unknown) as jest.Mock).mockResolvedValue(value.app);

    await expect(bootstrap()).rejects.toBe(originalError);
    expect(value.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the original startup error when cleanup also fails', async () => {
    const value = createFakeApplication();
    const originalError = new Error('init failed');
    const cleanupError = new Error('close failed');
    value.init.mockRejectedValueOnce(originalError);
    value.close.mockRejectedValueOnce(cleanupError);
    ((NestFactory.create as unknown) as jest.Mock).mockResolvedValue(value.app);

    await expect(bootstrap()).rejects.toBe(originalError);
    expect(value.close).toHaveBeenCalledTimes(1);
    expect((originalError as Error & { cause?: unknown }).cause).toBe(
      cleanupError,
    );
  });

  it('leaves a healthy application open', async () => {
    const value = createFakeApplication();
    value.database.query
      .mockResolvedValueOnce([{ integrity_check: 'ok' }])
      .mockResolvedValueOnce([]);
    ((NestFactory.create as unknown) as jest.Mock).mockResolvedValue(value.app);

    const handle = await bootstrap();

    if (!('restartHealth' in handle)) {
      throw new Error('normal startup returned an unexpected handle');
    }
    expect(handle.restartHealth.health).toBe('ok');
    expect(value.close).not.toHaveBeenCalled();
  });

  it('exits non-zero even when an inherited loopback listener keeps the process alive', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'filestation-main-exit-'));
    try {
      const keepalive = path.join(root, 'keepalive-listener.cjs');
      await writeFile(
        keepalive,
        [
          "const net = require('node:net');",
          'const server = net.createServer();',
          "server.listen(0, '127.0.0.1');",
          '',
        ].join('\n'),
      );
      const child = spawn(
        process.execPath,
        [
          '-r',
          'ts-node/register/transpile-only',
          '-r',
          keepalive,
          path.resolve(__dirname, 'main.ts'),
          '--startup-mode=fixture-invalid',
        ],
        {
          cwd: path.resolve(__dirname, '../..'),
          env: {
            ...process.env,
            TS_NODE_PROJECT: path.resolve(__dirname, '../tsconfig.json'),
          },
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        },
      );
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(
            new Error(
              'server executable kept a loopback listener open after startup failure',
            ),
          );
        }, 5_000);
      });

      let result: Awaited<typeof exited>;
      try {
        result = await Promise.race([exited, timedOut]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      expect(result).toEqual({ code: 1, signal: null });
      expect(stderr).toContain('FileStation startup failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
