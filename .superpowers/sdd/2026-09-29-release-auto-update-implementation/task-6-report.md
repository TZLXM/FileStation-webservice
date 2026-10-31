# Task 6 implementation report

Date: 2026-10-28. Workspace: `C:/Users/ckm41/.codex/worktrees/release-auto-update/FileStation-webservice`.
Branch: `codex/release-auto-update`. Base: `669a69c5f840fa85b45ae0211fdf19ccd7c2e9d8`.
Product and updater versions remain **0.2.0**. No agents, whole-plan execution,
external service/API calls, push, tag, Release, Nginx edit/reload or service edit.
All bootstrap executions used synthetic OS-temporary fixtures; repository
`data/` and `.env` were never used. The tracked local modification to
`.superpowers/.../task-5-report.md` is intentionally preserved and unstaged.

## Result

Implemented the managed-layout bootstrap, stable launcher and server pre-write
validation required by Task 6:

- `filestation-updater bootstrap|launch|status|recover`, with dry-run launch
  validation and secret-free help/manual instructions.
- Root `.env` loading with process-environment precedence before dynamic
  `AppModule` import. Managed launch validates cwd, current realpath, metadata and
  absolute canonical DB/storage/temp paths before mkdir, SQLite open or app import.
- Transactional bootstrap using the durable filesystem, real boot/process
  identity, a same-parent exclusive bootstrap lock, space planning, recoverable
  source/env backup, current junction/symlink and idempotent metadata.
- Direct-server `VACUUM INTO` helper with read-only source/snapshot connections,
  integrity/FK verification and failed-output cleanup.
- Source/Windows/Linux thin scripts with Node >=20.17 checks, root resolution,
  fixture-safe dry runs and manual restore instructions.
- Minimal fresh-CI closure repair: server directly depends on the updater; source
  and release artifacts include updater/update-core manifests+dist and launcher
  scripts; CI/tag verification build shared → update-core → updater before server.

Active update recovery deliberately fails closed with Task 9 guidance. No Task 9
orchestration, maintenance barrier, commit/promote flow, retention or release
acceptance was fabricated.

## RED evidence

Initial updater interface RED:

```text
npm test --workspace=@filestation/updater -- --runInBand src/bootstrap/bootstrap-command.spec.ts src/bootstrap/path-plan.spec.ts src/launcher.spec.ts
# Test Suites: 3 failed, 3 total
# Tests: 0 total
# Missing bootstrap-command/path-plan/launcher modules.
```

Initial server interface RED:

```text
npm test --workspace=@filestation/server -- --runInBand bootstrap/managed-preflight.spec.ts bootstrap/startup-mode.spec.ts bootstrap/bootstrap-snapshot.spec.ts
# Test Suites: 3 failed, 3 total
# Tests: 0 total
# Missing managed-preflight/startup-mode/bootstrap-snapshot modules.
```

Additional behavioral REDs:

```text
# Missing path variables incorrectly overwrote defaults:
# path-plan.spec.ts: 1 failed, 5 passed

# Required updater/update-core/launcher artifact closure:
# release-tools.test.mjs: 1 failed, 45 passed

# Missing fresh-CI updater prerequisite order:
# release-tools.test.mjs: 1 failed, 46 passed

# Initial PowerShell fixture run:
# exit 1, UnauthorizedAccess before CLI invocation

# Initial script dry-run after bypass:
# exit 1, TypeError in nativePath because undefined path variables replaced defaults
```

The first full updater run exposed an inherited Task 5 child-fixture setup gap:
`update-lock` and `recovery-guard` children inherited the repository root cwd, so
`ts-node` chose an incompatible config. It reported **77 passed / 2 skipped / 3
failed**, specifically both recovery-guard child cases plus zero winners in the
two-process O_EXCL race. Production lock code was unchanged. The harness now sets
the workspace absolute `TS_NODE_PROJECT` and cwd; the real child tests then
reported **20 passed / 20**. The final full updater run was **81 passed / 2
skipped / 83 total**.

## GREEN evidence

Final focused Task 6 updater:

```text
node node_modules/jest/bin/jest.js --config apps/updater/jest.config.json --cacheDirectory E:/aicode/FileStation-webservice/.tmp-jest-updater --runInBand --runTestsByPath apps/updater/src/bootstrap/bootstrap-command.spec.ts apps/updater/src/bootstrap/path-plan.spec.ts apps/updater/src/launcher.spec.ts
# Test Suites: 3 passed, 3 total
# Tests: 22 passed, 22 total
```

Full updater:

```text
node node_modules/jest/bin/jest.js --config apps/updater/jest.config.json --cacheDirectory E:/aicode/FileStation-webservice/.tmp-jest-updater --runInBand
# Test Suites: 10 passed, 10 total
# Tests: 2 skipped, 81 passed, 83 total
```

Server bootstrap focused:

```text
node node_modules/jest/bin/jest.js --config apps/server/jest.config.json --cacheDirectory E:/aicode/FileStation-webservice/.tmp-jest-server --runInBand --runTestsByPath apps/server/src/bootstrap/managed-preflight.spec.ts apps/server/src/bootstrap/startup-mode.spec.ts apps/server/src/bootstrap/bootstrap-snapshot.spec.ts
# Test Suites: 3 passed, 3 total
# Tests: 9 passed, 9 total
```

Platform scripts:

```text
node --test scripts/bootstrap-scripts.test.mjs
# tests 3; pass 2; skipped 1; fail 0
```

Affected Node/release suites:

```text
node node_modules/jest/bin/jest.js --config packages/update-core/jest.config.json --cacheDirectory E:/aicode/FileStation-webservice/.tmp-jest-core --runInBand
# Test Suites: 6 passed, 6 total
# Tests: 1 skipped, 92 passed, 93 total

node --test scripts/release/release-tools.test.mjs
# tests 47; pass 47; fail 0

node --test scripts/ci/verify-release-gate.test.mjs
# tests 47; pass 47; fail 0
```

Required repository gates:

```text
node node_modules/jest/bin/jest.js --config apps/server/jest.config.json --cacheDirectory E:/aicode/FileStation-webservice/.tmp-jest-server --runInBand
# Test Suites: 28 passed, 28 total
# Tests: 20 todo, 181 passed, 201 total

npm run test:e2e --workspace=@filestation/server
# Test Suites: 10 passed, 10 total
# Tests: 85 passed, 85 total

npx --no-install vitest run --no-cache   # cwd apps/web
# Test Files: 17 passed, 17 total
# Tests: 186 passed, 186 total

npm run typecheck
# shared → update-core → updater → server → web; exit 0

npm run build
# shared → update-core → updater → server → web; exit 0

node scripts/release/validate-version.mjs --version 0.2.0 --tag v0.2.0
# {"version":"0.2.0","tag":"v0.2.0","productManifestCount":6,"database_migration":true,"breaking_changes":false,"candidate":null}
```

## Exact skips and platform boundary

- Updater skip 1: real Linux `/proc` boot/process identity.
- Updater skip 2: POSIX same-directory symlink/atomic rename current-link path.
- Script skip 1: `bash -n` runs only on Linux; this host is Windows.
- Update-core skip 1: real file-symlink source fixture when Windows privilege probe
  returns EPERM/EACCES.
- Server has 20 existing `todo` tests; none are Task 6 skips.
- Local runtime: **Node v22.14.0, Windows x64**. Real junctions, exact ACLs,
  cross-process lock exclusion, CIM boot identity, `VACUUM INTO`, WAL preservation
  and PowerShell parser/dry runs passed under elevated fixture execution.
- Real Linux, Node 20.17 hosted execution, physical power-loss durability,
  actual Nginx/FRP, candidate archive, Task 9 recovery and manual upgrade/rollback
  drills remain pending.

## Changed paths

- Updater: `apps/updater/src/{cli.ts,launcher.ts,launcher.spec.ts,index.ts}`,
  `apps/updater/src/bootstrap/{bootstrap-command.ts,bootstrap-command.spec.ts,path-plan.ts,path-plan.spec.ts}`,
  `apps/updater/package.json`; Task 5 test-harness-only fixes in
  `state/update-lock.spec.ts` and `platform/recovery-guard.spec.ts`.
- Server: `apps/server/src/main.ts`,
  `apps/server/src/bootstrap/{managed-preflight,startup-mode,bootstrap-snapshot}.ts`
  and specs; `apps/server/package.json`.
- Scripts/packaging/CI: four `scripts/{bootstrap-update,start-filestation}` files,
  `scripts/bootstrap-scripts.test.mjs`, `scripts/release/package-artifact.mjs`,
  `scripts/release/release-tools.test.mjs`,
  `packages/update-core/src/{archive-policy,publisher-archive}.spec.ts`,
  `.github/workflows/{ci,release}.yml`, `package-lock.json`.
- Documentation: `docs/CURRENT-STATE.md`, `docs/UPDATING.md`, this report.

## Self-review concerns

- Source bootstrap requires already built server/updater artifacts and the admin
  to record the old PID, boot identity and process creation identity before stop.
- Reviewed custom path changes preserve operator choice but do not migrate data.
  Documentation discloses that bootstrap never copies the storage tree; operators
  must prepare and validate external data before launch.
- Active journal recovery is intentionally unavailable until Task 9. The CLI
  fails closed and gives specific guidance instead of truncating/editing state.
- Local ACL/junction/Windows durability evidence is real but not power-loss,
  Linux, hosted Node 20.17 or physical storage-controller evidence.
- Existing ts-jest allowJs warnings are retained and disclosed rather than hidden
  by broad Jest configuration changes.
