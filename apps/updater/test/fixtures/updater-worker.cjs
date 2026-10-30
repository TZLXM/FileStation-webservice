"use strict";

const path = require("node:path");
const { AttemptJournal } = require(__ATTEMPT_JOURNAL_PATH__);
const { NodeDurableFileSystem } = require(__DURABLE_FS_PATH__);
const {
  createManagedUpdateOrchestrator,
} = require(__ORCHESTRATOR_PATH__);
const {
  OperatorRecoveryAuthority,
} = require(__OPERATOR_AUTHORITY_PATH__);

class CrashFileSystem extends NodeDurableFileSystem {
  async append(filename, bytes, options) {
    await super.append(filename, bytes, options);
    const expected = process.env.FIXTURE_CRASH_ACTION;
    if (!expected) return;
    let record;
    try {
      record = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      return;
    }
    if (`${record.action}:${record.kind}` === expected) process.exit(73);
  }
}

async function main() {
  const rootIndex = process.argv.indexOf("--root");
  const attemptIndex = process.argv.indexOf("--attempt");
  const portIndex = process.argv.indexOf("--port");
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : undefined;
  const attemptId =
    attemptIndex >= 0 ? process.argv[attemptIndex + 1] : undefined;
  const servicePort =
    portIndex >= 0 ? Number(process.argv[portIndex + 1]) : undefined;
  const recovery = process.argv.includes("--recovery");
  let handoffIdentity = '';
  for await (const chunk of process.stdin) handoffIdentity += chunk.toString('utf8');
  if (
    !root ||
    !attemptId ||
    !Number.isSafeInteger(servicePort) ||
    servicePort < 1
  ) {
    throw new Error("worker root, attempt and port are required");
  }
  const snapshot = await AttemptJournal.inspect(root);
  let operatorAuthority;
  if (recovery) {
    operatorAuthority = await OperatorRecoveryAuthority.authorize(
      root,
      attemptId,
      snapshot.fence,
    );
  }
  const orchestrator = createManagedUpdateOrchestrator({
    handoffIdentity: recovery ? "" : handoffIdentity,
    fs: new CrashFileSystem(),
    operatorAuthority,
  });
  const result = await orchestrator.run({
    attemptId,
    installRoot: path.resolve(root),
    handoffIdentity: recovery ? "" : handoffIdentity,
    servicePort,
    // The live-owner refusal never launches a terminal; retain its short wait.
    // Normal native identity + independent proof uses the production 120s budget.
    timeoutMs: process.env.FIXTURE_EXPECT_LIVE_OWNER === "1" ? 4_000 : 120_000,
    recovery,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `updater-worker fixture: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
