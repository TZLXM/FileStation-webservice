// Controlled synthetic-install fixture. No network, application DB or user data.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Test } = require('@nestjs/testing');
require('ts-node').register({ project: path.join(__dirname, '../../tsconfig.json'), transpileOnly: true });
const { PlatformBootIdentityProvider, NodeDurableFileSystem, acquireRecoveryGuard } = require('@filestation/updater');
const { UpdateInstallCoordinator } = require('../../src/updates/update-install-coordinator');
const { WriteBarrierService } = require('../../src/maintenance/write-barrier.service');
const { WriteFreezeService } = require('../../src/maintenance/write-freeze.service');
const { registerMaintenanceRequestLease } = require('../../src/maintenance/maintenance-admission.guard');
let coordinator, acceptance, receipt, barrier, installRoot, app;
let resumeAppend, resumeHandoff;
const send = (value) => process.send(value);
process.on('message', async (message) => {
  try {
    if (message.command === 'init') {
      receipt = Object.freeze(message.receipt);
      const root = message.root;
      installRoot = root;
      const identity = new PlatformBootIdentityProvider();
      const boot = await identity.current();
      const created = await identity.processCreatedAt(process.pid);
      barrier = new WriteBarrierService(new WriteFreezeService());
      coordinator = new UpdateInstallCoordinator(
        { get: () => root }, barrier,
        { inspect: async () => ({ mode: 'managed', supported: true, install_root: root,
          platform: receipt.platform, updater_version: '0.2.0', reason: null }) },
        { record: async () => undefined },
        { assertAvailable: async () => undefined, execute: async (context) => {
          await app.close(); // Real Nest lifecycle close before HANDOFF_READY.
          await context.ownership.lock.assertActive();
          send({ event: 'nest-closed' });
          await new Promise((resolve) => { resumeHandoff = resolve; });
          await context.ownership.recoveryGuard.assertActive();
          const intent = await context.ownership.journal.appendIntent({
            attemptId: context.attempt.attemptId, fence: context.attempt.fence,
            action: 'fixture-handoff-ready', phase: 'HANDOFF_READY',
          });
          await context.ownership.journal.appendCompletion({
            attemptId: context.attempt.attemptId, fence: context.attempt.fence,
            intentId: intent.id, phase: 'HANDOFF_READY',
          });
          send({ event: 'handoff-ready' });
        } }, identity, () => Date.now(), '0.2.0', randomUUID,
      );
      const module = await Test.createTestingModule({
        providers: [{ provide: UpdateInstallCoordinator, useValue: coordinator }],
      }).compile();
      app = module.createNestApplication({ logger: false });
      await app.init(); // No listener, database, storage service or external call.
      send({ event: 'ready', pid: process.pid, boot, created });
    } else if (message.command === 'accept') {
      if (message.pauseAppend) {
        const original = NodeDurableFileSystem.prototype.append;
        NodeDurableFileSystem.prototype.append = async function (...args) {
          NodeDurableFileSystem.prototype.append = original;
          send({ event: 'append-paused' });
          await new Promise((resolve) => { resumeAppend = resolve; });
          return original.apply(this, args);
        };
      }
      try {
        acceptance = await coordinator.accept(receipt);
        send({ event: 'accepted', acceptance });
      } catch (error) { send({ event: 'refused', code: error.response?.code, message: error.message }); }
    } else if (message.command === 'probe-guard') {
      try {
        const guard = await acquireRecoveryGuard(path.join(installRoot, 'update.recovery.guard'));
        await guard.release();
        send({ event: 'guard-acquired' });
      } catch { send({ event: 'guard-refused' }); }
    } else if (message.command === 'resume-append') {
      resumeAppend();
    } else if (message.command === 'handoff') {
      const response = new EventEmitter();
      const lease = await barrier.acquire('http');
      const state = registerMaintenanceRequestLease({}, response, lease);
      state.handlerStarted = true;
      state.handlerDone = true;
      coordinator.scheduleAfterResponse(acceptance.attempt, response);
      response.emit('finish');
    } else if (message.command === 'resume-handoff') {
      resumeHandoff();
    } else if (message.command === 'exit') {
      resumeAppend?.();
      resumeHandoff?.();
      await app.close();
      process.disconnect(); // Natural fixture exit; the OS releases retained handles.
    }
  } catch (error) { send({ event: 'fixture-error', message: error.stack }); }
});
