export type VerifyLeaseFailureReason = 'lost' | 'cancelled';

export class VerifyLeaseError extends Error {
  constructor(readonly reason: VerifyLeaseFailureReason) {
    super(reason === 'lost' ? 'Upload verification lease was lost' : 'Upload verification lease heartbeat was cancelled');
    this.name = 'VerifyLeaseError';
  }
}

/** A single, non-overlapping owner heartbeat loop for long verification I/O. */
export class UploadVerifyHeartbeat {
  private readonly abortController = new AbortController();
  private stopped = false;
  private failure: VerifyLeaseError | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: (() => void) | null = null;
  private task: Promise<void> = Promise.resolve();

  constructor(
    private readonly intervalMs: number,
    private readonly refresh: () => Promise<boolean>,
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  start(): this {
    this.task = this.run();
    return this;
  }

  assertOwned(): void {
    if (this.failure) throw this.failure;
    if (this.signal.aborted) throw new VerifyLeaseError('cancelled');
  }

  cancel(reason: VerifyLeaseFailureReason = 'cancelled'): void {
    if (!this.failure) this.failure = new VerifyLeaseError(reason);
    this.stopped = true;
    this.abortController.abort();
    this.clearTimerAndWake();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimerAndWake();
    await this.task;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      await this.waitInterval();
      if (this.stopped) return;

      try {
        await this.refreshNow();
      } catch {
        return;
      }
    }
  }

  async refreshNow(): Promise<void> {
    this.assertOwned();
    let owned = false;
    try {
      owned = await this.refresh();
    } catch {
      this.cancel('lost');
    }
    if (!owned) this.cancel('lost');
    this.assertOwned();
  }

  private waitInterval(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeTimer = resolve;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.wakeTimer = null;
        resolve();
      }, this.intervalMs);
    });
  }

  private clearTimerAndWake(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const wake = this.wakeTimer;
    this.wakeTimer = null;
    wake?.();
  }
}
