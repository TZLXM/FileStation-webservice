import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpdateOperationReservationService } from './update-operation-reservation.service';

jest.setTimeout(20_000);

describe('UpdateOperationReservationService', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), 'filestation-operation-reservation-')),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('rejects prepare/prepare and prepare/install before a second operation allocation', async () => {
    const service = new UpdateOperationReservationService();
    const prepare = await service.acquire(root, 'prepare');
    const expected = {
      response: expect.objectContaining({
        code: 'UPDATE_OPERATION_IN_PROGRESS',
      }),
    };

    await expect(service.acquire(root, 'prepare')).rejects.toMatchObject(expected);
    await expect(service.acquire(root, 'install')).rejects.toMatchObject(expected);

    await prepare.release();
    const install = await service.acquire(root, 'install');
    await expect(service.acquire(root, 'prepare')).rejects.toMatchObject(expected);
    await install.release();
  });

  it('uses the real native guard to exclude a competing process and releases on exit', async () => {
    const serverRoot = path.resolve(__dirname, '../..');
    const source = path.resolve(__dirname, 'update-operation-reservation.service.ts');
    const child = spawn(
      process.execPath,
      [
        '-r',
        require.resolve('ts-node/register'),
        '-e',
        `const {UpdateOperationReservationService}=require(${JSON.stringify(source)});new UpdateOperationReservationService().acquire(${JSON.stringify(root)},'prepare').then(async lease=>{process.stdout.write('ready');process.stdin.resume();process.stdin.on('data',async()=>{await lease.release();process.exit(0);});},error=>{console.error(error);process.exit(1);});`,
      ],
      {
        cwd: serverRoot,
        env: {
          ...process.env,
          TS_NODE_PROJECT: path.join(serverRoot, 'tsconfig.json'),
          TS_NODE_TRANSPILE_ONLY: 'true',
        },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
    const exited = once(child, 'exit');
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      try {
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            child.stdout?.once('data', () => resolve());
            child.once('error', reject);
            child.once('exit', () =>
              reject(new Error(`reservation child exited early: ${output}`)),
            );
          }),
          new Promise<never>((_resolve, reject) => {
            readinessTimer = setTimeout(
            () => reject(new Error('reservation child readiness timed out')),
            10_000,
            );
          }),
        ]);
      } finally {
        if (readinessTimer) clearTimeout(readinessTimer);
      }

      const parent = new UpdateOperationReservationService();
      await expect(parent.acquire(root, 'install')).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'UPDATE_OPERATION_IN_PROGRESS',
        }),
      });
      child.kill('SIGKILL');
      await exited;
      const replacement = await parent.acquire(root, 'install');
      await replacement.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('releases an acquired guard if its assertion fails and invalidates released leases', async () => {
    const release=jest.fn(async()=>undefined);
    const factory=jest.fn().mockResolvedValueOnce({assertActive:async()=>{throw new Error('lost guard');},release})
      .mockResolvedValue({assertActive:async()=>undefined,release});
    const service=new UpdateOperationReservationService(factory);
    await expect(service.acquire(root,'prepare')).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(1);
    const lease=await service.acquire(root,'prepare');
    await lease.release();
    await expect(lease.assertActive()).rejects.toThrow();
    expect(release).toHaveBeenCalledTimes(2);
  });
});
