import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { AnonymousPipeHandoffSpawner } from './handoff-spawner';

function childFixture() {
  const stdin = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin,
    kill: jest.fn(),
  });
  return { child, stdin };
}

describe('AnonymousPipeHandoffSpawner', () => {
  it('delivers the inherited authority only through anonymous stdin', async () => {
    const { child, stdin } = childFixture();
    const deliveredPromise = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
      stdin.on('end', () => resolve(Buffer.concat(chunks)));
      stdin.on('error', reject);
    });
    const spawn = jest.fn(() => child);
    const channel = { close: jest.fn(async () => undefined) };
    const root = path.resolve('/fixture/install');
    const attempt = {
      attemptId: 'attempt-handoff-01',
      fence: 4,
      installRoot: root,
      backupId: 'backup-handoff-01',
      targetVersion: '0.2.5',
    };
    const capability = Buffer.from('{"schemaVersion":1,"key":"fixture"}\n');
    const spawner = new AnonymousPipeHandoffSpawner({
      spawn: spawn as never,
      environment: {
        PATH: '/fixture/bin',
        SECRET_FROM_PARENT: 'must-not-be-inherited',
      },
    });

    await spawner.startWaiting(attempt, channel, capability);

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        path.join(root, 'updater/dist/cli.js'),
        'continue',
        '--attempt',
        attempt.attemptId,
        '--root',
        root,
      ],
      expect.objectContaining({
        cwd: root,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: { PATH: '/fixture/bin' },
      }),
    );
    const serialized = JSON.stringify(spawn.mock.calls[0]);
    expect(serialized).not.toContain('fixture\\"}');
    expect(serialized).not.toContain(capability.toString('utf8'));

    const delivered = await deliveredPromise;
    expect(delivered).toEqual(capability);
    expect(channel.close).toHaveBeenCalledTimes(1);
  });

  it('rejects an absent or unbounded inherited capability before spawning', async () => {
    const spawn = jest.fn();
    const spawner = new AnonymousPipeHandoffSpawner({
      spawn: spawn as never,
      environment: { PATH: '/fixture/bin' },
    });
    const attempt = {
      attemptId: 'attempt-handoff-01',
      fence: 4,
      installRoot: path.resolve('/fixture/install'),
      backupId: 'backup-handoff-01',
      targetVersion: '0.2.5',
    };
    const channel = { close: jest.fn(async () => undefined) };

    await expect(
      spawner.startWaiting(attempt, channel, Buffer.alloc(0)),
    ).rejects.toThrow(/capability/i);
    await expect(
      spawner.startWaiting(attempt, channel, Buffer.alloc(4097, 0x20)),
    ).rejects.toThrow(/capability|bounded/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('transports service-only production configuration privately with the capability', async () => {
    const {child,stdin}=childFixture();
    const chunks:Buffer[]=[]; stdin.on('data',chunk=>chunks.push(Buffer.from(chunk)));
    const spawn=jest.fn(()=>child);
    const spawner=new AnonymousPipeHandoffSpawner({spawn:spawn as never,environment:{PATH:'fixture',NODE_ENV:'production',JWT_SECRET:'synthetic-service-secret',FILESTATION_PORT:'19371',UNRELATED_SECRET:'excluded'}});
    const capability=Buffer.from('{"schemaVersion":1,"key":"fixture"}\n');
    await spawner.startWaiting({attemptId:'service-attempt',fence:1,installRoot:path.resolve('/fixture/install'),backupId:'backup',targetVersion:'0.2.5'}, {close:async()=>{}}, capability);
    const envelope=JSON.parse(Buffer.concat(chunks).toString());
    expect(envelope.runtime).toEqual({NODE_ENV:'production',JWT_SECRET:'synthetic-service-secret',FILESTATION_PORT:'19371'});
    expect(JSON.stringify(spawn.mock.calls)).not.toContain('synthetic-service-secret');
    expect(envelope.runtime.UNRELATED_SECRET).toBeUndefined();
  });
});
