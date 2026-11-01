import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { WriteBarrierService } from './write-barrier.service';
import {
  startGatedApplication,
  startValidationApplication,
} from './server-startup';
import { TrustedStartupAccess, UpdateStartupIntent } from './startup-authority';

jest.mock('@nestjs/core', () => ({
  NestFactory: {
    create: jest.fn(),
  },
}));
jest.mock('../app.module', () => ({
  AppModule: class AppModule {},
}));
jest.mock('../common/http/application-setup', () => ({
  setupFullApplication: jest.fn(),
}));
jest.mock('../update-validation.module', () => ({
  UpdateValidationModule: {
    register: jest.fn(() => ({ module: class UpdateValidationModule {} })),
  },
}));
jest.mock('../updates/application-shutdown.service', () => ({
  ApplicationShutdownService: class ApplicationShutdownService {
    attach = jest.fn();
  },
}));
jest.mock('./update-protocol.module', () => ({
  UpdateProtocolModule: {
    register: jest.fn(() => ({ module: class UpdateProtocolModule {} })),
  },
}));

const intent: UpdateStartupIntent = {
  mode: 'validate',
  attempt: {
    attemptId: 'attempt-cleanup',
    fence: 1,
    installRoot: 'C:\\fixture-install',
    backupId: 'backup-cleanup',
    targetVersion: '0.2.5',
  },
};

const access: TrustedStartupAccess = {
  async authorizeStartup() {},
  async authorizeRequest() {},
};

function fakeApplication() {
  const init = jest.fn(async () => undefined);
  const listen = jest.fn(async () => undefined);
  const close = jest.fn(async () => undefined);
  const app = {
    get: jest.fn((token: unknown) => {
      if (token === ConfigService) {
        return { get: jest.fn() };
      }
      if (token === WriteBarrierService) {
        return {
          enterMaintenance: jest.fn(),
        };
      }
      return {
        attach: jest.fn(),
      };
    }),
    enableShutdownHooks: jest.fn(),
    setGlobalPrefix: jest.fn(),
    init,
    listen,
    close,
  };
  return { app, init, listen, close };
}

describe('authorized startup application cleanup', () => {
  beforeEach(() => {
    ((NestFactory.create as unknown) as jest.Mock).mockReset();
  });

  it('closes a validation application when listening fails', async () => {
    const value = fakeApplication();
    const originalError = new Error('validation listen failed');
    value.listen.mockRejectedValueOnce(originalError);
    ((NestFactory.create as unknown) as jest.Mock).mockResolvedValue(value.app);

    await expect(
      startValidationApplication({
        access,
        intent,
        startupAuthorized: true,
        host: '127.0.0.1',
        port: 0,
      }),
    ).rejects.toBe(originalError);
    expect(value.close).toHaveBeenCalledTimes(1);
  });

  it('closes a gated application when initialization fails', async () => {
    const value = fakeApplication();
    const originalError = new Error('gated init failed');
    value.init.mockRejectedValueOnce(originalError);
    ((NestFactory.create as unknown) as jest.Mock).mockResolvedValue(value.app);

    await expect(
      startGatedApplication({
        access,
        intent: { ...intent, mode: 'gated' },
        startupAuthorized: true,
        host: '127.0.0.1',
        port: 0,
      }),
    ).rejects.toBe(originalError);
    expect(value.close).toHaveBeenCalledTimes(1);
  });
});
