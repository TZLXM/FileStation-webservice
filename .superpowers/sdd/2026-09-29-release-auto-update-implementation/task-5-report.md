# Task 5 implementation report

Date: 2026-10-27. Workspace: `C:/Users/ckm41/.codex/worktrees/release-auto-update/FileStation-webservice`.
Branch: `codex/release-auto-update`. Required base: `120a60618cca80b121aa4a9c3e3b394a3aa86d9a`.
Product version remains **0.2.0**. No agents, whole-plan execution, external service/API calls, push, tag or Release operations.

## Result

Added the Node-only `@filestation/updater@0.2.0` workspace with exported interfaces for Task 6 and Task 9:

- `AttemptJournal.open`, `beginAttempt`, `appendIntent`, `appendCompletion`, `readSnapshot` and `writeStatusProjection`.
- `UpdateLock.acquire`, `UpdateLock.acquireRecovery`, active-lock heartbeat/assertion and handoff takeover.
- `PlatformBootIdentityProvider` and injectable `ProcessIdentityProvider`.
- `DurableFileSystem`, `NodeDurableFileSystem` and `WindowsDurableFileSystem`.
- `CurrentLinkSwitcher.switchTo` and `recover`.
- `planRequiredSpace` and `recheckRequiredSpace`.

The updater directly declares `dotenv`, `@filestation/shared`, `@filestation/update-core` and `koffi`. Koffi is direct because the updater itself invokes Win32 APIs. Root build/typecheck are explicitly ordered shared → update-core → updater → server → web. The release version validator now requires six product manifests and rejects missing/mismatched updater versions.

## Durable journal

`update-attempt.journal` is append-only with a process-serialized writer, global monotonically increasing sequence, per-record SHA-256 checksum, strict envelope/owner/context validation and bounded record/file sizes. An incomplete final line is truncated to the previous newline and flushed. A newline-complete checksum failure, sequence gap/rollback or malformed record fails closed. A later attempt becomes writable only when the prior attempt is terminal (`COMMITTED`, `ROLLED_BACK`, `FAILED` or `ABORTED`), has no pending intent, uses a new attempt ID and advances the fence.

Destructive work uses an open-intent invariant: only one pending intent may exist. Callers write/flush intent, perform the action, then append/flush completion. Failure after an intent remains recoverable at that intent; the reader does not infer an earlier safe phase. A failed flush after bytes were written leaves the intent authoritative. Fencing rejects an old attempt/fence writer.

`update-status.json` is a whitelist projection of journal phase, versions, attempt, fence and timestamps. It omits owner handoff hashes, payloads, action results, capabilities and error text. Projection replacement uses private temporary creation, durable flush and rename; it is not treated as authoritative state.

The journal rejects credential-like field names in payload/result objects and stores only the SHA-256 hash of an inherited handoff capability. Checksums detect accidental/torn corruption under the protected file boundary; they are not a signature against an actor already authorized to rewrite the journal.

## Locking, owner handoff and identity

Owner and recovery locks use actual `CREATE_NEW`/`O_CREAT|O_EXCL` creation. A live lock is never released by stale inspection. Recovery-lock takeover first verifies exact boot/PID creation identity, then atomically renames the stale recovery record to a unique quarantine name before one contender can create a replacement. Normal owner release unlinks only its own still-matching record.

Owner replacement requires:

1. A recovery-lock winner and a journal phase of `HANDOFF_READY`.
2. Matching inherited handoff identity hash, checked with a constant-time digest comparison.
3. Matching attempt/fence and owner lock record.
4. Same boot identity and a different/no live process creation identity for the old PID.
5. A service port not still owned by the old PID. An unrelated port owner is an additional signal, not proof that the old process is alive.

The takeover writes owner-replacement intent, archives the old owner lock, durably creates the new owner record, replaces the lock, then appends completion with fence + 1. Recovery covers pauses after intent but before lock replacement and after lock replacement but before journal completion. A competing process without the matching inherited identity cannot advance the attempt. PID reuse is accepted only when the old creation identity is gone and the new creation identity is proven alive.

Linux boot identity comes from `/proc/sys/kernel/random/boot_id`, process creation from `/proc/<pid>/stat`, and listener PID from `/proc/net/{tcp,tcp6}` socket inode ownership. Windows obtains canonical UTC `LastBootUpTime` and process `CreationDate` through `Get-CimInstance`. Unavailable or mismatched identity fails closed.

## Durable filesystem and current link

The production abstraction was exercised with real temporary files. POSIX uses exclusive creation, `0600/0700`, file `fsync` and parent-directory `fsync`. Windows uses explicit Kernel32 operations:

- `CreateFileW` with `FILE_FLAG_WRITE_THROUGH` for exclusive/append writes.
- `WriteFile` and `FlushFileBuffers` before progression.
- `MoveFileExW` with `MOVEFILE_WRITE_THROUGH` and optional replace.
- Directory handles where available; rename write-through is the authoritative Windows replacement boundary.

Node `fs.fsync` is backed by libuv's Win32 `FlushFileBuffers`; this is recorded as a fact, but Node's plain Windows rename is not claimed to be write-through. Node 22.14 exposes no `O_SYNC` on this host, and the updater does not coerce missing flags to zero. Windows ACL setup removes inheritance and explicitly grants the current user SID, SYSTEM and Administrators. A real `icacls` inspection confirms no inherited `(I)` entries and at least three explicit rules.

Linux switches `current` by creating a same-directory temporary symlink and atomically renaming it over `current`. Windows performs the approved three-step sequence: create/verify an attempt-specific new junction, move old `current` to a unique previous name, then move the new junction to `current`. Every step has intent/completion records. Recovery accepts only a filesystem combination with one safe result; an ambiguous combination throws fail-closed, and no release is selected in that state.

## Volume planning

The planner resolves every relevant path to an actual volume ID, groups concurrent demands and applies the safety margin once per volume. Included components are the selected-platform archive and unpacked artifact, retained release, existing DB/WAL/SHM, self-contained snapshot, restore temp, migration workspace and per-volume 10%/minimum safety margin. Migration base is `max(logical page bytes, snapshot bytes, DB file bytes)` multiplied by the manifest factor, floored by the manifest minimum.

The maintenance recheck accepts fresh WAL/snapshot metrics and available-byte readings, reports changed plans and fails the aggregate if any volume is short. Planning has no deletion path; a low-space case verifies the unique previous release and recoverable snapshot remain intact.

## RED → GREEN evidence

### Initial RED

After adding the workspace configuration and failing tests but before production modules:

```text
npm test --workspace=@filestation/updater -- --runInBand
FAIL src/state/attempt-journal.spec.ts
TS2307: Cannot find module './attempt-journal'
FAIL src/platform/durable-fs.spec.ts
TS2307: Cannot find module './durable-fs'
FAIL src/state/boot-identity.spec.ts
TS2307: Cannot find module './boot-identity'
FAIL src/platform/volume-space.spec.ts
TS2307: Cannot find module './volume-space'
FAIL src/platform/current-link.spec.ts
TS2307: Cannot find module './current-link'
FAIL src/state/update-lock.spec.ts
TS2307: Cannot find module './update-lock'
Test Suites: 6 failed, 6 total
Tests:       0 total
exit 1
```

The harness also exposed that Jest's `it.runIf` is not available and that sandboxed Jest cannot write its default transform cache. Conditional test registration was corrected. The authorized test command is configured with `--no-cache`; escalated local execution was needed because this session's sandbox grants write access to a different worktree root. These harness issues were not counted as feature RED evidence.

Release version gate RED:

```text
npm run test:release-tools
not ok 1 - version validation requires the tag and all six product manifests to agree
actual productManifestCount: 5; expected: 6
not ok 3 - version validation rejects a missing updater manifest
Missing expected exception.
not ok 5 - version validation rejects a mismatched updater product version
Missing expected exception.
not ok 6 - version validation excludes third-party tooling but includes all product workspaces
5 !== 6
1..45
# tests 45
# pass 41
# fail 4
exit 1
```

### Behavioral and self-review REDs

After the first production pass, actual tests ran and produced:

```text
Test Suites: 5 failed, 1 passed, 6 total
Tests:       8 failed, 1 skipped, 21 passed, 30 total
exit 1
```

Those failures identified Linux `/proc` field indexing, Win32 `ERROR_FILE_EXISTS` not being normalized to `EEXIST`, Win32 volume-path decoding, assertion placement around corrupt journal open, and recovery-lock race handling.

The persistent-journal self-review found the old implementation allowed only one attempt forever. New lifecycle tests first produced:

```text
FAIL src/state/attempt-journal.spec.ts
JournalError: journal attempt is already initialized
FAIL src/state/update-lock.spec.ts
LockFailure: an existing attempt has no active owner lock; use recovery
Tests: 2 failed, 16 passed, 18 total
exit 1
```

The Linux listener-owner adapter first failed typecheck because the provider had no `/proc` directory/readlink injectable boundary. The target-platform artifact budget first failed because `VolumePlanOptions` had no `artifactPlatform`; those were corrected before final runs.

The strengthened ACL test initially used an ineffective nested PowerShell probe. It was replaced with independent `icacls` output inspection, which verifies no inherited entries and explicit grants. This was a test-quality repair; the production ACL invocation was already executing successfully.

### Final GREEN

```text
npm test --workspace=@filestation/updater -- --runInBand
PASS src/platform/volume-space.spec.ts
PASS src/platform/durable-fs.spec.ts
PASS src/state/boot-identity.spec.ts
PASS src/platform/current-link.spec.ts
PASS src/state/attempt-journal.spec.ts
PASS src/state/update-lock.spec.ts
Test Suites: 6 passed, 6 total
Tests:       2 skipped, 36 passed, 38 total
Time:        9.28 s
exit 0

npm run test:release-tools
# tests 45
# pass 45
# fail 0
exit 0

npm run typecheck --workspace=@filestation/updater
> tsc --noEmit
exit 0

npm run build --workspace=@filestation/updater
> tsc
exit 0
```

The two skips are explicitly local-platform boundaries: real POSIX symlink switching and real Linux `/proc` identity. They are not reported as executed coverage.

## Mandated repository verification

Each full application suite was run once:

```text
npm test --workspace=@filestation/server -- --runInBand
Test Suites: 25 passed, 25 total
Tests:       20 todo, 172 passed, 192 total
exit 0

npm run test:e2e --workspace=@filestation/server
Test Suites: 10 passed, 10 total
Tests:       85 passed, 85 total
exit 0

# cwd apps/web
npx vitest run --no-cache
Test Files  17 passed (17)
Tests       186 passed (186)
exit 0

npm run typecheck
> shared → shared build → update-core → updater → server → web
exit 0

npm run build
> shared → update-core → updater → server → web
> updater tsc
> server nest build
> Web tsc && vite build
✓ 85 modules transformed
✓ built in 1.14s
exit 0

Test-Path apps/updater/dist/index.js
True
Test-Path packages/update-core/dist/index.js
True
```

Existing ts-jest `.js`/`allowJs` warnings, expected upload-abort and oversized-request E2E logging, and Web PageErrorBoundary's intentional `render failed` logging occurred while all tests passed. Lint remains unavailable because the repository has no complete ESLint installation; it is not reported as passing. Root `npm test` remains unusable as a proxy because shared has no test script.

Package-lock was updated with:

```text
npm.cmd install --package-lock-only --ignore-scripts --offline
up to date, audited 1138 packages in 822ms
exit 0
```

This was an offline lockfile operation. It is not a fresh registry audit and is not used as an audit-green claim.

## Changed paths

- `apps/updater/package.json`, `tsconfig.json`, `jest.config.json`.
- `apps/updater/src/index.ts`, `test-support.ts`.
- `apps/updater/src/state/attempt-journal.ts` and `attempt-journal.spec.ts`.
- `apps/updater/src/state/update-lock.ts` and `update-lock.spec.ts`.
- `apps/updater/src/state/boot-identity.ts` and `boot-identity.spec.ts`.
- `apps/updater/src/platform/durable-fs.ts` and `durable-fs.spec.ts`.
- `apps/updater/src/platform/current-link.ts` and `current-link.spec.ts`.
- `apps/updater/src/platform/volume-space.ts` and `volume-space.spec.ts`.
- Root `package.json`, `package-lock.json`.
- `scripts/release/validate-version.mjs`, `scripts/release/release-tools.test.mjs`.
- `docs/CURRENT-STATE.md`.
- `.superpowers/sdd/2026-09-29-release-auto-update-implementation/task-5-report.md`.

No controller ledger, whole-plan file, design spec, Task 6 bootstrap, Task 9 orchestrator or prior Nginx configuration was changed.

## Self-review boundaries

- Local evidence is Node 22.14 Windows x64. Real Win32 write-through, FlushFileBuffers, write-through rename, CIM identity, junction switching, ACLs and volume probing ran. Linux Node 20.17 hosted execution remains pending; the POSIX and real `/proc` cases are the two local skips.
- This is API/sequence and local filesystem evidence, not a power-loss acceptance test. Real Windows socket/handle behavior, storage-controller caching and hosted filesystems still require platform validation.
- The journal checksum detects corruption but is not an authenticity signature against a writer that already has access to the protected installation root. The Windows ACL and POSIX modes are the secrecy/integrity boundary.
- Stale recovery records are quarantined by atomic rename. Quarantine artifacts are intentionally retained on failure for diagnosis and future explicit cleanup; no broad recursive cleanup is implemented here.
- `AttemptJournal` enforces attempt/fence but does not itself acquire the lock. Task 9 must hold and assert the matching `LockHandle` across work; handoff tests include the cross-fence old-writer rejection.
- `CurrentLinkSwitcher` cannot launch or choose a release by itself. Ambiguous filesystem combinations fail closed for the launcher/orchestrator, which are out of Task 5 scope.
- Space planning provides immutable measurements and recheck results; it does not reserve filesystem space atomically because no cross-process filesystem reservation primitive exists. The orchestrator must call the recheck immediately before maintenance and retain all referenced rollback assets.
- The updater uses local `icacls.exe`/PowerShell system utilities for ACL and CIM access. Hosted Windows execution must retain the same default shell/tool availability.

## Final checkpoint

Final `git diff --check`: **exit 0**, no whitespace errors. Git emitted only the configured LF→CRLF working-copy conversion warnings.

Commit command: `git commit -m "feat(updater): add durable update primitives"`.
