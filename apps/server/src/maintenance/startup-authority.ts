import { Injectable } from '@nestjs/common';
import path from 'node:path';
import { MaintenanceAttempt } from './write-freeze.service';

export const TRUSTED_STARTUP_ACCESS = Symbol('TRUSTED_STARTUP_ACCESS');
export const UPDATE_STARTUP_INTENT = Symbol('UPDATE_STARTUP_INTENT');

export type UpdateStartupMode = 'validate' | 'gated';

export interface UpdateStartupIntent {
  mode: UpdateStartupMode;
  attempt: MaintenanceAttempt;
}

export type ParsedStartupExecution =
  | { mode: 'normal' }
  | ({ mode: UpdateStartupMode } & { attempt: MaintenanceAttempt });

export interface UpdateProtocolCredentials {
  attemptId: string;
  fence: number;
  capability?: string;
}

export interface TrustedStartupAccess {
  /** Task 9 verifies the inherited channel before any module import. */
  authorizeStartup(intent: UpdateStartupIntent): Promise<void>;
  /** The validation module verifies short-lived capability-protected requests. */
  authorizeRequest(
    intent: UpdateStartupIntent,
    credentials: UpdateProtocolCredentials,
  ): Promise<void>;
}

export class TrustedUpdateStartupUnavailableError extends Error {
  readonly code = 'TRUSTED_UPDATE_STARTUP_UNAVAILABLE';

  constructor() {
    super(
      'Trusted update startup is unavailable; Task 9 must verify the inherited capability channel',
    );
    this.name = 'TrustedUpdateStartupUnavailableError';
  }
}

@Injectable()
export class RefusingTrustedStartupAccess implements TrustedStartupAccess {
  async authorizeStartup(_intent: UpdateStartupIntent): Promise<void> {
    throw new TrustedUpdateStartupUnavailableError();
  }

  async authorizeRequest(
    _intent: UpdateStartupIntent,
    _credentials: UpdateProtocolCredentials,
  ): Promise<void> {
    throw new TrustedUpdateStartupUnavailableError();
  }
}

const ATTEMPT_FLAGS = {
  '--attempt-id': 'attemptId',
  '--fence': 'fence',
  '--install-root': 'installRoot',
  '--backup-id': 'backupId',
  '--target-version': 'targetVersion',
} as const;

function flagValue(argument: string, name: string): string | undefined {
  const prefix = `${name}=`;
  return argument.startsWith(prefix)
    ? argument.slice(prefix.length)
    : undefined;
}

export function parseStartupExecution(
  argv: readonly string[],
  _environment: NodeJS.ProcessEnv = process.env,
): ParsedStartupExecution {
  let mode: string | undefined;
  const values: Partial<Record<(typeof ATTEMPT_FLAGS)[keyof typeof ATTEMPT_FLAGS], string>> = {};
  for (const argument of argv) {
    const startupMode = flagValue(argument, '--startup-mode');
    if (startupMode !== undefined) {
      mode = startupMode;
      continue;
    }
    for (const [flag, key] of Object.entries(ATTEMPT_FLAGS) as Array<
      [keyof typeof ATTEMPT_FLAGS, (typeof ATTEMPT_FLAGS)[keyof typeof ATTEMPT_FLAGS]]
    >) {
      const value = flagValue(argument, flag);
      if (value !== undefined) values[key] = value;
    }
  }

  if (mode === undefined || mode === 'normal') return { mode: 'normal' };
  if (mode !== 'validate' && mode !== 'gated') {
    throw new Error(`invalid startup mode: ${mode}`);
  }
  for (const key of [
    'attemptId',
    'fence',
    'installRoot',
    'backupId',
    'targetVersion',
  ] as const) {
    if (!values[key]) throw new Error(`${key} is required for ${mode} startup`);
  }
  const fence = Number(values.fence);
  if (!Number.isSafeInteger(fence) || fence < 1) {
    throw new Error('fence must be a positive safe integer');
  }
  if (!path.isAbsolute(values.installRoot!)) {
    throw new Error('install-root must be an absolute canonical path');
  }
  return {
    mode,
    attempt: {
      attemptId: values.attemptId!,
      fence,
      installRoot: values.installRoot!,
      backupId: values.backupId!,
      targetVersion: values.targetVersion!,
    },
  };
}
