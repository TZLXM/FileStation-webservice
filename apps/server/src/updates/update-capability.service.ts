import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadManagedInstallMetadata } from '../bootstrap/managed-preflight';
import type { UpdateCapability } from './update-types';

function platformName(): string {
  if (process.platform === 'win32') return 'windows-x64';
  if (process.platform === 'linux') return 'linux-x64';
  return `${process.platform}-${process.arch}`;
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isDockerRuntime(): boolean {
  return (
    process.env.FILESTATION_DEPLOYMENT_MODE === 'docker' ||
    process.env.FILESTATION_CONTAINER === 'docker' ||
    existsSync('/.dockerenv')
  );
}

@Injectable()
export class UpdateCapabilityService {
  constructor(private readonly config: ConfigService) {}

  async inspect(): Promise<UpdateCapability> {
    const platform = platformName();
    if (
      !['win32', 'linux'].includes(process.platform) ||
      process.arch !== 'x64'
    ) {
      return {
        mode: 'unsupported',
        supported: false,
        install_root: null,
        updater_version: null,
        platform,
        reason: 'UNSUPPORTED_PLATFORM',
      };
    }
    if (isDockerRuntime()) {
      return {
        mode: 'docker',
        supported: false,
        install_root: null,
        updater_version: null,
        platform,
        reason: 'DOCKER_MANUAL_UPGRADE',
      };
    }

    const configured =
      this.config.get<string>('app.updateInstallRoot') ??
      process.env.FILESTATION_INSTALL_ROOT;
    if (!configured || !path.isAbsolute(configured)) {
      return {
        mode: 'unmanaged',
        supported: false,
        install_root: null,
        updater_version: null,
        platform,
        reason: 'UNMANAGED_INSTALL',
      };
    }

    const root = path.resolve(configured);
    try {
      const actualRoot = await realpath(root);
      if (actualRoot !== root) {
        throw new Error('install root is not canonical');
      }
      const metadata = await loadManagedInstallMetadata(root);
      if (path.resolve(metadata.installRoot) !== root) {
        throw new Error('managed metadata install root mismatch');
      }
    } catch {
      return {
        mode: 'unmanaged',
        supported: false,
        install_root: root,
        updater_version: null,
        platform,
        reason: 'MANAGED_METADATA_INVALID',
      };
    }

    let updaterVersion: string | null = null;
    try {
      const updaterRoot = path.join(root, 'updater');
      const packagePath = path.join(updaterRoot, 'package.json');
      const packageStat = await lstat(packagePath);
      if (!packageStat.isFile() || packageStat.isSymbolicLink()) {
        throw new Error('updater package must be a real file');
      }
      const actualPackage = await realpath(packagePath);
      const actualUpdaterRoot = await realpath(updaterRoot);
      if (
        !inside(root, actualUpdaterRoot) ||
        !inside(actualUpdaterRoot, actualPackage)
      ) {
        throw new Error('updater package escapes the installation');
      }
      const raw = await readFile(actualPackage, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > 64 * 1024) {
        throw new Error('updater package metadata is too large');
      }
      const value = JSON.parse(raw) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        value.name !== '@filestation/updater' ||
        typeof value.version !== 'string' ||
        !/^\d+\.\d+\.\d+$/.test(value.version)
      ) {
        throw new Error('updater package identity is invalid');
      }
      updaterVersion = value.version;
    } catch {
      return {
        mode: 'managed',
        supported: false,
        install_root: root,
        updater_version: null,
        platform,
        reason: 'UPDATER_METADATA_INVALID',
      };
    }

    return {
      mode: 'managed',
      supported: true,
      install_root: root,
      updater_version: updaterVersion,
      platform,
      reason: null,
    };
  }
}
