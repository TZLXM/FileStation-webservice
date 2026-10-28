import {
  parseStartupExecution,
  RefusingTrustedStartupAccess,
} from './startup-authority';
import path from 'node:path';

describe('update startup authority', () => {
  it('defaults to normal execution and never treats an environment flag as authority', () => {
    expect(
      parseStartupExecution([], {
        FILESTATION_STARTUP_MODE: 'gated',
      }),
    ).toEqual({ mode: 'normal' });
  });

  it('requires an explicit complete attempt for validate and gated modes', () => {
    const installRoot = path.resolve('/fixture/install');
    expect(
      parseStartupExecution([
        '--startup-mode=validate',
        '--attempt-id=attempt-01',
        '--fence=7',
        `--install-root=${installRoot}`,
        '--backup-id=backup-01',
        '--target-version=0.2.5',
      ]),
    ).toEqual({
      mode: 'validate',
      attempt: {
        attemptId: 'attempt-01',
        fence: 7,
        installRoot,
        backupId: 'backup-01',
        targetVersion: '0.2.5',
      },
    });

    expect(() =>
      parseStartupExecution(['--startup-mode=gated', '--attempt-id=attempt-01']),
    ).toThrow(/fence|install-root|backup-id|target-version/i);
    expect(() =>
      parseStartupExecution(['--startup-mode=unexpected']),
    ).toThrow(/startup.mode/i);
  });

  it('fails closed by default because Task 9 owns inherited capability verification', async () => {
    const access = new RefusingTrustedStartupAccess();
    const installRoot = path.resolve('/fixture/install');
    const intent = {
      mode: 'gated' as const,
      attempt: {
        attemptId: 'attempt-01',
        fence: 7,
        installRoot,
        backupId: 'backup-01',
        targetVersion: '0.2.5',
      },
    };

    await expect(access.authorizeStartup(intent)).rejects.toMatchObject({
      code: 'TRUSTED_UPDATE_STARTUP_UNAVAILABLE',
    });
    await expect(
      access.authorizeRequest(intent, {
        attemptId: 'attempt-01',
        fence: 7,
        capability: undefined,
        purpose: 'health',
        method: 'GET',
        stage: 'gated',
      }),
    ).rejects.toMatchObject({
      code: 'TRUSTED_UPDATE_STARTUP_UNAVAILABLE',
    });
  });
});
