import { Injectable } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { MaintenanceAttempt } from '../maintenance/write-freeze.service';

export const HANDOFF_SPAWNER = Symbol('HANDOFF_SPAWNER');

export interface HandoffChannel {
  close(): Promise<void>;
}

export interface HandoffSpawner {
  startWaiting(
    attempt: MaintenanceAttempt,
    handoffChannel: HandoffChannel,
    inheritedCapability?: Buffer,
  ): Promise<void>;
}

export class HandoffSpawnerUnavailableError extends Error {
  readonly code = 'HANDOFF_SPAWNER_UNAVAILABLE';

  constructor() {
    super(
      'The updater continue command is not wired; Task 9 must inject a trusted HandoffSpawner',
    );
    this.name = 'HandoffSpawnerUnavailableError';
  }
}

@Injectable()
export class RefusingHandoffSpawner implements HandoffSpawner {
  async startWaiting(
    _attempt: MaintenanceAttempt,
    _handoffChannel: HandoffChannel,
    _inheritedCapability?: Buffer,
  ): Promise<void> {
    throw new HandoffSpawnerUnavailableError();
  }
}

export interface AnonymousPipeHandoffSpawnerOptions {
  spawn?: (
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      windowsHide: boolean;
      stdio: ["pipe", "ignore", "ignore"];
    },
  ) => ChildProcess;
  environment?: NodeJS.ProcessEnv;
}

function minimalEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return environment;
}

@Injectable()
export class AnonymousPipeHandoffSpawner implements HandoffSpawner {
  private readonly spawnProcess: NonNullable<
    AnonymousPipeHandoffSpawnerOptions["spawn"]
  >;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: AnonymousPipeHandoffSpawnerOptions = {}) {
    this.spawnProcess =
      options.spawn ??
      ((command, args, spawnOptions) =>
        spawn(command, [...args], spawnOptions));
    this.environment = minimalEnvironment(
      options.environment ?? process.env,
    );
  }

  async startWaiting(
    attempt: MaintenanceAttempt,
    handoffChannel: HandoffChannel,
    inheritedCapability?: Buffer,
  ): Promise<void> {
    if (
      !Buffer.isBuffer(inheritedCapability) ||
      inheritedCapability.length === 0 ||
      inheritedCapability.length > 4096
    ) {
      throw new Error("inherited update capability is absent or unbounded");
    }
    const root = path.resolve(attempt.installRoot);
    const updaterCli = path.join(root, "updater/dist/cli.js");
    const child = this.spawnProcess(
      process.execPath,
      [
        updaterCli,
        "continue",
        "--attempt",
        attempt.attemptId,
        "--root",
        root,
      ],
      {
        cwd: root,
        env: { ...this.environment },
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    if (!child.stdin) {
      child.kill();
      throw new Error("update continuation did not receive an anonymous pipe");
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        child.stdin!.once("error", onError);
        child.stdin!.end(inheritedCapability, () => {
          child.stdin!.removeListener("error", onError);
          resolve();
        });
      });
      await handoffChannel.close();
    } catch (error) {
      child.kill();
      throw error;
    }
  }
}
