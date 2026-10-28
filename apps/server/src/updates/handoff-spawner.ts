import { Injectable } from '@nestjs/common';
import { MaintenanceAttempt } from '../maintenance/write-freeze.service';

export const HANDOFF_SPAWNER = Symbol('HANDOFF_SPAWNER');

export interface HandoffChannel {
  close(): Promise<void>;
}

export interface HandoffSpawner {
  startWaiting(
    attempt: MaintenanceAttempt,
    handoffChannel: HandoffChannel,
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
  ): Promise<void> {
    throw new HandoffSpawnerUnavailableError();
  }
}
