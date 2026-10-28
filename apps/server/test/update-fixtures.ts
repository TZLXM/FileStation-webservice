import {
  createHash,
  generateKeyPairSync,
  KeyObject,
  sign,
} from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import type { UpdateManifestV1 } from '@filestation/shared';
import {
  verifyManifest,
  VerifiedManifestV1,
} from '@filestation/update-core';

export interface SignedManifestFixture {
  bytes: Buffer;
  digest: string;
  manifest: VerifiedManifestV1;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

interface ZipEntry {
  name: string;
  data?: Buffer;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: ZipEntry[], version = '0.2.5'): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = entry.data ?? Buffer.from('ok');
    const compressed = deflateRawSync(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc32(data), 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50);
    centralHeader.writeUInt16LE(0x0314, 4);
    localHeader.copy(centralHeader, 6, 4, 26);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(0o100644 * 65536, 38);
    centralHeader.writeUInt32LE(offset, 42);

    local.push(localHeader, name, compressed);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

export function buildSafePublisherZip(version = '0.2.5'): Buffer {
  const root = `filestation-v${version}-win-x64/`;
  return buildZip(
    [
      'apps/server/dist/main.js',
      'apps/updater/dist/cli.js',
      'apps/web/dist-root/index.html',
      'apps/web/dist-fs/index.html',
      'packages/shared/dist/index.js',
      'packages/update-core/dist/index.js',
      'node_modules/runtime/index.js',
    ].map((name) => ({ name: root + name })),
    version,
  );
}

export function createSignedManifestFixture(
  artifactBytes = buildSafePublisherZip(),
  version = '0.2.5',
): SignedManifestFixture {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const manifest: UpdateManifestV1 = {
    version,
    commit: 'a'.repeat(40),
    published_at: '2026-10-28T00:00:00.000Z',
    channel: 'stable',
    minimum_node: '20.17.0',
    database_migration: false,
    migration_workspace_multiplier: 0,
    migration_workspace_min_bytes: 0,
    breaking_changes: false,
    requires_manual_bootstrap: false,
    automatic_update_from: '0.2.0',
    update_protocol: 1,
    min_updater_version: '0.2.0',
    release_notes_url:
      'https://github.com/TZLXM/FileStation-webservice/releases/tag/v0.2.5',
    release_summaries: {
      'zh-CN': {
        fixes: [{ id: 'fix-update-api', text: '更新管理接口已就绪' }],
      },
      en: {
        fixes: [{ id: 'fix-update-api', text: 'Update management is ready' }],
      },
    },
    upgrade_guide_url:
      'https://github.com/TZLXM/FileStation-webservice/blob/master/docs/UPDATING.md',
    artifacts: [
      {
        platform: 'windows-x64',
        os: 'windows',
        arch: 'x64',
        filename: `filestation-v${version}-win-x64.zip`,
        url: `https://github.com/TZLXM/FileStation-webservice/releases/download/v${version}/filestation-v${version}-win-x64.zip`,
        archive_size: artifactBytes.length,
        unpacked_size: 7 * 2,
        sha256: createHash('sha256').update(artifactBytes).digest('hex'),
        format: 'zip',
      },
    ],
  };
  const bytes = Buffer.from(canonicalJson(manifest), 'utf8');
  const signature = sign(null, bytes, privateKey);
  const verified = verifyManifest(bytes, signature, publicKey);
  return {
    bytes,
    digest: createHash('sha256').update(bytes).digest('hex'),
    manifest: verified,
    privateKey,
    publicKey,
  };
}
