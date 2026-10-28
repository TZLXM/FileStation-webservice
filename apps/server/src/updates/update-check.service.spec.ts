import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KeyObject, sign } from 'node:crypto';
import {
  createSignedManifestFixture,
  SignedManifestFixture,
} from '../../test/update-fixtures';
import {
  UpdateCapabilityService,
} from './update-capability.service';
import { UpdateCheckService } from './update-check.service';
import {
  UPDATE_FETCH,
  UPDATE_NOW,
  UPDATE_NODE_VERSION,
  UPDATE_PRODUCT_VERSION,
  UPDATE_RANDOM,
  UPDATE_TRUSTED_KEY,
} from './updates.tokens';
import { UpdateCapability } from './update-types';

interface FetchScript {
  fixture: SignedManifestFixture;
  fail?: boolean;
}

function releaseBytes(fixture: SignedManifestFixture): Buffer {
  return Buffer.from(
    JSON.stringify({
      draft: false,
      prerelease: false,
      tag_name: 'v0.2.5',
      assets: [
        {
          name: 'update-manifest.json',
          browser_download_url:
            'https://github.com/TZLXM/FileStation-webservice/releases/download/v0.2.5/update-manifest.json',
        },
        {
          name: 'update-manifest.json.sig',
          browser_download_url:
            'https://github.com/TZLXM/FileStation-webservice/releases/download/v0.2.5/update-manifest.json.sig',
        },
      ],
    }),
  );
}

function scriptedFetch(
  scripts: FetchScript[],
): jest.MockedFunction<typeof fetch> {
  let scriptIndex = 0;
  let callInScript = 0;
  return jest.fn(async () => {
    const script = scripts[scriptIndex];
    if (!script) throw new Error('unexpected network request');
    if (script.fail) {
      scriptIndex += 1;
      callInScript = 0;
      throw new Error('network unavailable');
    }
    const step = callInScript++;
    if (step === 0) {
      return new Response(releaseBytes(script.fixture), { status: 200 });
    }
    if (step === 1) {
      return new Response(script.fixture.bytes, { status: 200 });
    }
    if (step === 2) {
      const signature = sign(
        null,
        script.fixture.bytes,
        script.fixture.privateKey,
      );
      scriptIndex += 1;
      callInScript = 0;
      return new Response(signature, { status: 200 });
    }
    throw new Error('unexpected scripted request');
  }) as unknown as jest.MockedFunction<typeof fetch>;
}

function readyCapability(
  overrides: Partial<UpdateCapability> = {},
): UpdateCapability {
  return {
    mode: 'managed',
    supported: true,
    install_root: '/fixture/install',
    updater_version: '0.2.0',
    platform: 'windows-x64',
    reason: null,
    ...overrides,
  };
}

describe('UpdateCheckService', () => {
  let fixture: SignedManifestFixture;
  let now: number;
  let random: number;
  let trustedKey: KeyObject | null;
  let capability: UpdateCapability;
  let fetchImpl: jest.MockedFunction<typeof fetch>;
  let service: UpdateCheckService;

  beforeEach(async () => {
    fixture = createSignedManifestFixture();
    now = Date.parse('2026-10-28T00:00:00.000Z');
    random = 0.5;
    trustedKey = fixture.publicKey;
    capability = readyCapability();
    fetchImpl = scriptedFetch([{ fixture }, { fixture }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UpdateCheckService,
        {
          provide: UpdateCapabilityService,
          useValue: { inspect: jest.fn(async () => capability) },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn() },
        },
        {
          provide: UPDATE_FETCH,
          useFactory: () =>
            ((url: string, init?: RequestInit) =>
              fetchImpl(url, init)) as typeof fetch,
        },
        {
          provide: UPDATE_TRUSTED_KEY,
          useValue: () => trustedKey,
        },
        { provide: UPDATE_NOW, useValue: () => now },
        { provide: UPDATE_RANDOM, useValue: () => random },
        { provide: UPDATE_PRODUCT_VERSION, useValue: '0.2.0' },
        { provide: UPDATE_NODE_VERSION, useValue: '20.17.0' },
      ],
    }).compile();
    service = module.get(UpdateCheckService);
  });

  it('returns the signed stable candidate with both bilingual summaries', async () => {
    const status = await service.check({ force: true });

    expect(status).toEqual(
      expect.objectContaining({
        stage: 'idle',
        current_version: '0.2.0',
        available_version: '0.2.5',
        candidate_commit: 'a'.repeat(40),
        manifest_sha256: fixture.digest,
        artifact_sha256: fixture.manifest.artifacts[0].sha256,
      }),
    );
    expect(status.release_summaries).toEqual(fixture.manifest.release_summaries);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('uses the installed updater version instead of the release bundle version', async () => {
    capability = readyCapability({ updater_version: '0.1.0' });
    fetchImpl = scriptedFetch([{ fixture }]);

    const status = await service.check({ force: true });

    expect(status).toEqual(
      expect.objectContaining({
        decision: 'updater_required',
        available_version: null,
        updater_version: '0.1.0',
      }),
    );
  });

  it('fails closed without a request when the publisher trust root is unconfigured', async () => {
    trustedKey = null;
    fetchImpl = scriptedFetch([]);

    const status = await service.check({ force: true });

    expect(status).toEqual(
      expect.objectContaining({
        stage: 'failed',
        error_code: 'PUBLISHER_UNCONFIGURED',
      }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not block application bootstrap on the startup network check', async () => {
    let releaseFetch!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    fetchImpl = jest.fn(async () => {
      await waiting;
      throw new Error('offline');
    }) as unknown as jest.MockedFunction<typeof fetch>;

    expect(service.onApplicationBootstrap()).toBeUndefined();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalled();
    releaseFetch();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('keeps successful cache entries for the six-hour jitter window', async () => {
    await service.check({ force: true });
    const callsAfterFirst = fetchImpl.mock.calls.length;

    now += 6 * 60 * 60 * 1000 - 1;
    await service.check({ force: false });
    expect(fetchImpl).toHaveBeenCalledTimes(callsAfterFirst);

    now += 2;
    await service.check({ force: false });
    expect(fetchImpl).toHaveBeenCalledTimes(callsAfterFirst + 3);
  });

  it('rate-limits repeated forced checks without discarding the cached result', async () => {
    await service.check({ force: true });
    const callsAfterFirst = fetchImpl.mock.calls.length;
    now += 30_000;

    const second = await service.check({ force: true });

    expect(second.available_version).toBe('0.2.5');
    expect(fetchImpl).toHaveBeenCalledTimes(callsAfterFirst);
  });

  it('coalesces concurrent manual checks into one release request', async () => {
    const [left, right] = await Promise.all([
      service.check({ force: true }),
      service.check({ force: true }),
    ]);

    expect(left.available_version).toBe('0.2.5');
    expect(right.available_version).toBe('0.2.5');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns the last successful status when a later refresh fails', async () => {
    await service.check({ force: true });
    fetchImpl = scriptedFetch([{ fixture, fail: true }]);
    now += 61_000;

    const status = await service.check({ force: true });

    expect(status).toEqual(
      expect.objectContaining({
        stage: 'idle',
        available_version: '0.2.5',
        error_code: 'UPDATE_CHECK_FAILED',
      }),
    );
  });
  it('throttles default retries after an expired success refresh fails', async () => {
    const original = await service.check({ force: false });
    now += 6 * 60 * 60 * 1000 + 1;
    fetchImpl = scriptedFetch([{ fixture, fail: true }, { fixture }]);
    const failed = await service.check({ force: false });
    expect(failed.available_version).toBe(original.available_version);
    await service.check({ force: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.getCachedStatus().available_version).toBe('0.2.5');
    now += 60_000;
    expect((await service.check({ force: false })).available_version).toBe('0.2.5');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

});
