"use strict";

// Controlled business data/HTTP ports; prepare/install/barrier/snapshot/freeze
// and durable cancellation run the shipped server services, in this old process.
const path = require('node:path');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const { DataSource } = require(__TYPEORM_PATH__);
const server = __SERVER_DIST__;
const updater = __UPDATER_DIST__;
const { PlatformBootIdentityProvider } = require(path.join(updater, 'state/boot-identity.js'));
const { WriteFreezeService } = require(path.join(server, 'maintenance/write-freeze.service.js'));
const { WriteBarrierService } = require(path.join(server, 'maintenance/write-barrier.service.js'));
const { registerMaintenanceRequestLease } = require(path.join(server, 'maintenance/maintenance-admission.guard.js'));
const { DatabaseSnapshotService } = require(path.join(server, 'updates/database-snapshot.service.js'));
const { UpdateSpacePreflightService } = require(path.join(server, 'updates/update-space-preflight.service.js'));
const { UpdatePrepareService } = require(path.join(server, 'updates/update-prepare.service.js'));
const { UpdateOperationReservationService } = require(path.join(server, 'updates/update-operation-reservation.service.js'));
const { UpdateInstallCoordinator, HandoffUpdateInstallExecutor } = require(path.join(server, 'updates/update-install-coordinator.js'));
const { ApplicationShutdownService } = require(path.join(server, 'updates/application-shutdown.service.js'));
const root = process.argv[2], database = process.argv[3];
const evidence = { events: [], preflights: [], snapshots: 0, freezes: 0, spawns: 0 };
const emit = (event, data = {}) => process.send?.({ event, ...data });
async function main() {
  const source = new DataSource({ type: 'sqlite', database, entities: [], synchronize: false });
  await source.initialize();
  await source.query('PRAGMA journal_mode=WAL');
  await source.query('PRAGMA wal_autocheckpoint=0');
  await source.query('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  await source.query('CREATE TABLE fixture_audit(action TEXT NOT NULL)');
  const freeze = new WriteFreezeService();
  const barrier = new WriteBarrierService(freeze);
  const writerLease = await barrier.acquire('upload-finalizer');
  const config = { get: key => ({ 'app.dbPath': database, 'app.storagePath': path.join(root, 'data/storage'), 'app.tempPath': path.join(root, 'data/temp') })[key] };
  const payload = path.join(root, '.filestation-update-staging/payload');
  // Lightweight controlled release, packaged with the publisher's real archive
  // writer; the separate artifact suite proves installed dependency closure.
  for (const name of ['package-lock.json', 'apps/server/package.json', 'apps/web/package.json', 'apps/updater/package.json', 'packages/shared/package.json', 'packages/update-core/package.json', 'apps/updater/dist/cli.js', 'apps/updater/dist/launcher.js', 'apps/web/dist-root/index.html', 'apps/web/dist-fs/index.html', 'packages/shared/dist/index.js', 'packages/update-core/dist/index.js', 'node_modules/runtime/index.js', 'scripts/release/smoke-artifact.mjs', 'scripts/release/create-smoke-db.mjs', 'scripts/release/validate-version.mjs', 'scripts/release/start-artifact.mjs', 'scripts/bootstrap-update.ps1', 'scripts/bootstrap-update.sh', 'scripts/start-filestation.ps1', 'scripts/start-filestation.sh']) {
    await fs.mkdir(path.dirname(path.join(payload, name)), { recursive: true });
    await fs.writeFile(path.join(payload, name), name.endsWith('.json') ? '{"version":"0.2.6"}' : '// controlled fixture');
  }
  const { packageArtifact } = await import(__PACKAGER_URL__);
  const platform = process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
  const archive = await packageArtifact({ sourceRoot: payload, outputDirectory: path.join(root, 'fixture-archives'), version: '0.2.6', platform, sourceDateEpoch: 1_800_000_000 });
  await fs.copyFile(archive.archivePath, path.join(root, 'fixture-archive'));
  const artifact = { platform, os: platform === 'windows-x64' ? 'windows' : 'linux', arch: 'x64', filename: archive.filename, url: `https://github.com/TZLXM/FileStation-webservice/releases/download/v0.2.6/${archive.filename}`, archive_size: archive.archiveSize, unpacked_size: archive.unpackedSize, sha256: archive.sha256, format: archive.format };
  const candidate = { manifest: { version: '0.2.6', database_migration: true, migration_workspace_multiplier: 2, migration_workspace_min_bytes: 256 * 1024 ** 2 }, manifest_sha256: 'c'.repeat(64), artifact };
  const capability = { inspect: async () => ({ mode: 'managed', supported: true, install_root: root, platform: candidate.artifact.platform, updater_version: '0.2.5', reason: null }) };
  let lowCapacity = false;
  const space = new UpdateSpacePreflightService(source, config, {
    readAvailableBytes: async () => lowCapacity ? 1 : 1024 ** 4,
  });
  const assertSpace = space.assertSufficient.bind(space);
  space.assertSufficient = async (...args) => {
    const walBytes = (await fs.stat(database + '-wal')).size;
    evidence.preflights.push({ walBytes, active: barrier.activeLeaseCount, accepting: barrier.accepting, lowCapacity });
    return assertSpace(...args);
  };
  const operations = new UpdateOperationReservationService();
  const prepare = new UpdatePrepareService({ resolveCandidate: async () => candidate }, capability, space, operations, config,
    async () => new Response(await fs.readFile(path.join(root, 'fixture-archive')), { status: 200 }), Date.now, () => 'prepared-task11');
  const snapshot = new DatabaseSnapshotService(source, config, barrier, freeze);
  const create = snapshot.createVerifiedSnapshot.bind(snapshot);
  snapshot.createVerifiedSnapshot = async attempt => {
    evidence.snapshots++;
    evidence.events.push('snapshot');
    evidence.snapshotLeaseCount = barrier.activeLeaseCount;
    evidence.snapshotAccepting = barrier.accepting;
    evidence.snapshotWalBytes = (await fs.stat(database + '-wal')).size;
    return create(attempt);
  };
  const freezeSource = snapshot.freezeSourceDatabase.bind(snapshot);
  snapshot.freezeSourceDatabase = async attempt => {
    await freezeSource(attempt);
    evidence.freezes++;
    evidence.events.push('freeze');
    try { await source.query("INSERT INTO items(value) VALUES ('forbidden-after-freeze')"); }
    catch (error) { evidence.frozenSqlRejected = /readonly/i.test(error.message); }
    try { freeze.assertWritable(); }
    catch (error) { evidence.frozenStorageRejected = error.code === 'UPDATE_SOURCE_FROZEN'; }
  };
  const shutdown = new ApplicationShutdownService();
  shutdown.attach({ close: async () => {
    evidence.events.push('close');
    await source.destroy();
    evidence.closedConnection = !source.isInitialized;
    await fs.writeFile(path.join(root, 'fixture-prehandoff.json'), JSON.stringify(evidence));
    // Keep the coordinator's recovery guard until actual process exit.
  } });
  const spawner = { startWaiting: async (_attempt, _channel, capability) => {
    evidence.spawns++; evidence.events.push('spawn');
    // Never put this inherited identity on disk, argv or in a diagnostic log.
    emit('handoff', { identity: capability.toString('utf8') });
    if (process.argv.includes('--hold-old')) await new Promise(() => {});
  } };
  const realExecutor = new HandoffUpdateInstallExecutor(config, capability, snapshot, barrier, shutdown, spawner, space);
  const audit = { record: async entry => barrier.withLease('audit', () => source.query('INSERT INTO fixture_audit(action) VALUES (?)', [entry.action])) };
  let serial = 0, acceptance;
  const install = new UpdateInstallCoordinator(config, barrier, capability, audit, {
    assertAvailable: () => realExecutor.assertAvailable(),
    execute: async context => {
      if (process.argv.includes('--disk-full')) lowCapacity = true;
      evidence.events.push('maintenance');
      emit('maintenance', { attempt: context.attempt, active: barrier.activeLeaseCount, accepting: barrier.accepting });
      return realExecutor.execute(context);
    },
  }, new PlatformBootIdentityProvider(), Date.now, '0.2.5', () => serial++ === 0 ? 'attempt-task11-real-wal' : 'backup-01', operations);
  process.on('message', async command => {
    try {
      if (command === 'install') {
        const receipt = await prepare.prepare({ version: candidate.manifest.version, manifest_sha256: candidate.manifest_sha256, artifact_sha256: candidate.artifact.sha256 });
        const consumed = await prepare.consume(receipt.prepared_id);
        acceptance = await install.accept(consumed);
        const response = new EventEmitter();
        registerMaintenanceRequestLease({}, response, await barrier.acquire('http'));
        install.scheduleAfterResponse(acceptance.attempt, response);
        response.emit('finish');
      } else if (command === 'probe') {
        let admissionRejected = false;
        try { const lease = await barrier.acquire('http'); lease.release(); }
        catch (error) { admissionRejected = error.code === 'UPDATE_MAINTENANCE'; }
        emit('blocked', { active: barrier.activeLeaseCount, admissionRejected, snapshots: evidence.snapshots, freezes: evidence.freezes });
      } else if (command === 'release') {
        evidence.walBefore = (await fs.stat(database + '-wal')).size;
        await source.query('INSERT INTO items(value) VALUES (?)', ['wal-before-update']);
        evidence.walAfter = (await fs.stat(database + '-wal')).size;
        evidence.events.push('lease-write');
        writerLease.release();
        evidence.events.push('lease-release');
        emit('released');
        if (process.argv.includes('--disk-full')) {
          // Wait for the production coordinator's durable pre-freeze abort.
          const deadline = Date.now() + 10_000;
          while (!barrier.accepting && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          const lease = await barrier.acquire('http');
          lease.release();
          evidence.acceptingAfterFailure = barrier.accepting;
          evidence.frozenAfterFailure = freeze.isFrozen;
          await fs.writeFile(path.join(root, 'fixture-prehandoff.json'), JSON.stringify(evidence));
          emit('failed', { evidence });
        }
      } else if (command === 'close') {
        await source.destroy();
        await install.onModuleDestroy();
        process.disconnect?.();
      }
    } catch (error) { emit('error', { error: error.stack }); }
  });
  emit('ready');
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
