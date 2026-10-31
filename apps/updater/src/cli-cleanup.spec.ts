import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from './cli';
import {
  launchManagedInstall,
  loadInstallEnvironment,
  loadManagedInstallMetadata,
} from './launcher';
import { PlatformBootIdentityProvider } from './state/boot-identity';
import { readInheritedEnvelope } from './update/capability';

jest.mock('./bootstrap/bootstrap-command', () => ({
  bootstrapManagedInstall: jest.fn(),
  inspectManagedUpdate: jest.fn(),
  recoverManagedUpdate: jest.fn(),
}));
jest.mock('./launcher', () => ({
  launchManagedInstall: jest.fn(),
  loadInstallEnvironment: jest.fn(),
  loadManagedInstallMetadata: jest.fn(),
  validateManagedLaunchOnDisk: jest.fn(),
}));
jest.mock('./state/boot-identity', () => ({
  PlatformBootIdentityProvider: class PlatformBootIdentityProvider {
    async processCreatedAt(): Promise<string> {
      return 'unconfigured';
    }
    async current(): Promise<{ value: string }> {
      return { value: 'unconfigured' };
    }
  },
  ProcessIdentityProvider: class ProcessIdentityProvider {},
}));
jest.mock('./update/capability', () => ({
  encodeInheritedCapability: jest.fn(() => Buffer.from('fixture')),
  readInheritedEnvelope: jest.fn(),
}));
jest.mock('./update/terminal-launch', () => ({
  acceptTerminalLaunch: jest.fn(),
}));

describe('updater launch cleanup', () => {
  let root: string;
  let environment: NodeJS.ProcessEnv;
  let sendDescriptor: PropertyDescriptor | undefined;
  let exitCode: number | string | undefined;

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'filestation-cli-cleanup-')),
    );
    const entrypoint = path.join(root, 'apps', 'server', 'dist', 'main.js');
    await mkdir(path.dirname(entrypoint), { recursive: true });
    await writeFile(entrypoint, 'fixture');

    environment = { ...process.env };
    exitCode = process.exitCode;
    sendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    Object.defineProperty(process, 'send', {
      configurable: true,
      enumerable: true,
      value: jest.fn(),
      writable: true,
    });

    (loadInstallEnvironment as jest.Mock).mockResolvedValue({
      values: {},
    });
    (loadManagedInstallMetadata as jest.Mock).mockResolvedValue({
      currentPath: root,
    });
    (readInheritedEnvelope as jest.Mock).mockResolvedValue({
      authority: {},
      launch: {
        attemptId: 'attempt-cleanup',
        fence: 1,
        nonce: 'fixture-nonce',
      },
      runtime: {},
    });
  });

  afterEach(async () => {
    process.env = environment;
    process.exitCode = exitCode;
    if (sendDescriptor) {
      Object.defineProperty(process, 'send', sendDescriptor);
    } else {
      delete (process as NodeJS.Process & { send?: unknown }).send;
    }
    jest.restoreAllMocks();
    jest.clearAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('closes the started application when terminal health is not ready', async () => {
    const close = jest.fn(async () => undefined);
    const handle = {
      app: {
        getHttpServer: () => ({ listening: false }),
        close,
      },
      restartHealth: {
        version: '0.2.5',
        release: root,
        health: 'failed',
      },
    };
    (launchManagedInstall as jest.Mock).mockResolvedValue({
      imported: {
        bootstrap: jest.fn(async () => handle),
      },
    });

    await expect(
      main(['launch', '--root', root, '--inherited-launch']),
    ).rejects.toThrow('terminal startup health is not ready');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not hang forever when closing a failed startup', async () => {
      (launchManagedInstall as jest.Mock).mockResolvedValue({ imported: { bootstrap: async () => ({
        app: { getHttpServer: () => ({ listening: false }), close: () => new Promise<void>(() => {}) },
      }) } });
      const outcome = main(['launch', '--root', root, '--inherited-launch']).catch(error => error);
      const error = await outcome;
      expect(error.message).toContain('terminal startup health is not ready');
      expect(error.cause.message).toMatch(/timed out/i);
  }, 20_000);

  it('keeps the original health error when application cleanup fails', async () => {
    const cleanupError = new Error('close failed');
    const close = jest.fn(async () => {
      throw cleanupError;
    });
    const handle = {
      app: {
        getHttpServer: () => ({ listening: false }),
        close,
      },
      restartHealth: {
        version: '0.2.5',
        release: root,
        health: 'failed',
      },
    };
    (launchManagedInstall as jest.Mock).mockResolvedValue({
      imported: {
        bootstrap: jest.fn(async () => handle),
      },
    });

    let caught: unknown;
    try {
      await main(['launch', '--root', root, '--inherited-launch']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'terminal startup health is not ready',
    );
    expect((caught as Error & { cause?: unknown }).cause).toBe(cleanupError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the application when post-start audit reconciliation fails', async () => {
    const close = jest.fn(async () => undefined);
    const originalError = new Error('audit reconciliation failed');
    const reconcileUpdateAudit = jest.fn(async () => {
      throw originalError;
    });
    jest
      .spyOn(PlatformBootIdentityProvider.prototype, 'processCreatedAt')
      .mockResolvedValue('fixture-created-at');
    jest
      .spyOn(PlatformBootIdentityProvider.prototype, 'current')
      .mockResolvedValue({ value: 'fixture-boot' } as never);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    (readInheritedEnvelope as jest.Mock).mockResolvedValue({
      authority: {
        receipt: jest.fn(() => 'fixture-receipt'),
      },
      launch: {
        attemptId: 'attempt-cleanup',
        fence: 1,
        nonce: 'fixture-nonce',
      },
      runtime: {},
    });
    const handle = {
      app: {
        getHttpServer: () => ({ listening: true }),
        close,
      },
      restartHealth: {
        version: '0.2.5',
        release: root,
        health: 'ok',
      },
      reconcileUpdateAudit,
    };
    (launchManagedInstall as jest.Mock).mockResolvedValue({
      imported: {
        bootstrap: jest.fn(async () => handle),
      },
    });

    await expect(
      main(['launch', '--root', root, '--inherited-launch']),
    ).resolves.toBe(0);
    (
      process.emit as unknown as (
        event: string,
        ...args: unknown[]
      ) => boolean
    )('message', { event: 'verification-durable' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(process.send).toHaveBeenCalledTimes(1);
    expect(reconcileUpdateAudit).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero even when an inherited loopback listener keeps the process alive', async () => {
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
        path.join(__dirname, 'cli.ts'),
        'fixture-unsupported-command',
      ],
      {
        cwd: path.resolve(__dirname, '../../..'),
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
            'updater executable kept a loopback listener open after startup failure',
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
    expect(stderr).toContain('unsupported command fixture-unsupported-command');
  }, 10_000);
});
