import {
  DynamicModule,
  INestApplication,
  Module,
  Type,
} from '@nestjs/common';
import { AttemptJournal } from '@filestation/updater';
import { WriteBarrierService } from './write-barrier.service';
import {
  TrustedStartupAccess,
  UpdateStartupIntent,
} from './startup-authority';

export interface GatedStartupOptions {
  access: TrustedStartupAccess;
  intent: UpdateStartupIntent;
  startupAuthorized?: boolean;
  host?: string;
  port?: number;
  commitPollIntervalMs?: number;
  onCommitted?: (app: INestApplication) => Promise<void>;
}

export interface GatedApplicationHandle {
  app: INestApplication;
  committed: Promise<void>;
  close(): Promise<void>;
}

export interface ValidationStartupOptions {
  access: TrustedStartupAccess;
  intent: UpdateStartupIntent;
  startupAuthorized?: boolean;
  host?: string;
  port?: number;
}

export interface ValidationApplicationHandle {
  app: INestApplication;
  close(): Promise<void>;
}

function abortError(): Error {
  const error = new Error('gated startup stopped');
  error.name = 'AbortError';
  return error;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function waitForMatchingCommit(
  intent: UpdateStartupIntent,
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  let invalidJournalError: Error | undefined;
  while (!signal.aborted) {
    try {
      const snapshot = await AttemptJournal.inspect(
        intent.attempt.installRoot,
      );
      if (
        snapshot.attemptId === intent.attempt.attemptId &&
        snapshot.fence === intent.attempt.fence &&
        snapshot.phase === 'COMMITTED' &&
        snapshot.pending === null
      ) {
        return;
      }
      invalidJournalError = undefined;
    } catch (error) {
      invalidJournalError =
        error instanceof Error ? error : new Error('journal read failed');
    }
    await wait(intervalMs, signal);
  }
  throw invalidJournalError ?? abortError();
}

function createGatedRootModule(
  protocolModule: DynamicModule,
  appModule: Type<unknown>,
): Type<unknown> {
  @Module({
    imports: [appModule, protocolModule],
  })
  class GatedUpdateRootModule {}
  return GatedUpdateRootModule;
}

export async function startGatedApplication(
  options: GatedStartupOptions,
): Promise<GatedApplicationHandle> {
  if (!options.startupAuthorized) {
    await options.access.authorizeStartup(options.intent);
  }

  // Business modules are imported only after trusted startup authority has
  // accepted the inherited attempt. A CLI/environment flag alone cannot reach
  // this branch because main calls a refusing provider by default.
  const [
    { NestFactory },
    { ConfigService },
    { AppModule },
    { UpdateProtocolModule },
    { setupFullApplication },
  ] =
    await Promise.all([
      import('@nestjs/core'),
      import('@nestjs/config'),
      import('../app.module'),
      import('./update-protocol.module'),
      import('../common/http/application-setup'),
    ]);
  const appModule = AppModule;
  const protocolModule = UpdateProtocolModule.register({
    access: options.access,
    intent: options.intent,
  });
  const RootModule = createGatedRootModule(protocolModule, appModule);
  const app = await NestFactory.create(RootModule, { bodyParser: false });
  const { ApplicationShutdownService } = await import(
    '../updates/application-shutdown.service'
  );
  app.get(ApplicationShutdownService).attach(app);
  app.enableShutdownHooks();
  setupFullApplication(app, app.get(ConfigService));

  const barrier = app.get(WriteBarrierService);
  barrier.enterMaintenance(options.intent.attempt);
  await app.init();
  await app.listen(options.port ?? 0, options.host ?? '127.0.0.1');

  const controller = new AbortController();
  const committed = waitForMatchingCommit(
    options.intent,
    options.commitPollIntervalMs ?? 500,
    controller.signal,
  ).then(async () => {
    const authority = barrier.beginCommittedActivation(options.intent.attempt);
    try {
      const [{ StorageService }, { FileLifecycleService }] = await Promise.all([
        import('../files/storage.service'),
        import('../files/file-lifecycle.service'),
      ]);
      await barrier.withCommittedActivation(
        authority,
        'startup-scan',
        async () => {
          await app.get(StorageService).activate();
          await app.get(FileLifecycleService).activate();
          await options.onCommitted?.(app);
        },
      );
      barrier.reopenAfterCommitted(options.intent.attempt);
      const { UpdateAuditReconciler } = await import(
        '../updates/update-audit-reconciler'
      );
      await app
        .get(UpdateAuditReconciler)
        .reconcile(options.intent.attempt.installRoot);
    } finally {
      barrier.finishCommittedActivation(authority);
    }
  }).catch((error: unknown) => {
    if (
      controller.signal.aborted &&
      error instanceof Error &&
      error.name === 'AbortError'
    ) {
      return;
    }
    throw error;
  });

  let closed = false;
  return {
    app,
    committed,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      controller.abort();
      await app.close();
    },
  };
}

export async function startValidationApplication(
  options: ValidationStartupOptions,
): Promise<ValidationApplicationHandle> {
  if (!options.startupAuthorized) {
    await options.access.authorizeStartup(options.intent);
  }
  const [{ NestFactory }, { UpdateValidationModule }] = await Promise.all([
    import('@nestjs/core'),
    import('../update-validation.module'),
  ]);
  const app = await NestFactory.create(
    UpdateValidationModule.register({
      access: options.access,
      intent: options.intent,
    }),
    { bodyParser: false },
  );
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');
  await app.listen(options.port ?? 0, options.host ?? '127.0.0.1');
  return {
    app,
    close: () => app.close(),
  };
}
