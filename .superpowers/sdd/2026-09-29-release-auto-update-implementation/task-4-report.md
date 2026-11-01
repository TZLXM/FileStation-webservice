# Task 4 implementation report

Date: 2026-10-27. Workspace: `C:/Users/ckm41/.codex/worktrees/release-auto-update/FileStation-webservice`.
Branch: `codex/release-auto-update`. Resumed base: `7dfcdf6a05b9a40ab275ca1d16fe2a83e8a91765` (supersedes original `e39fddd` after the controller's Task 3 P1 repair).
Product version remains **0.2.0**. No agents, external system/API tests, push, tag or Release operations.

## Result and implementation

Implemented `@filestation/update-core`, a Node-only library (`browser: false`) with typed exports for `verifyManifest`, `selectUpdate`, `validateReleaseAssetUrl`, bounded fetch/official stable Release source, and verified archive open/inspect/extract. Root scripts explicitly order shared → update-core → server → web; typecheck emits shared declarations after its own check so dependent type resolution also works with a fresh shared dist.

Direct runtime dependencies: `canonicalize ^2.1.0` (locked 2.1.0), `semver ^7.7.2` (package-local locked 7.8.5; root's unrelated transitive semver 6 is not used), `koffi ^2.14.1` (locked 2.16.3). SemVer types are directly declared. Setup command: `npm.cmd install --prefer-offline --ignore-scripts --no-audit --no-fund`; output `added 5 packages in 4s`, exit 0. Local cached formatter: `npm.cmd exec --offline --package=prettier -- prettier ...`, version 3.8.3; no formatter dependency added. No audit refresh or audit-green claim.

Manifest checks the exact RFC 8785 UTF-8 bytes and an Ed25519 signature using only the explicitly supplied trusted public KeyObject. It rejects unsupported protocol, unknown fields at every object level, duplicate keys/alternative encodings/BOM, invalid UTF-8/surrogates, nonstable or invalid versions, unsafe numeric values, inconsistent platforms/formats/URLs/digests and localized summaries. Migration bounds follow the approved publisher: 2–64 multiplier and ≥268435456 bytes with migration, zero/zero without migration. Dates must survive calendar normalization. Verified objects are deeply frozen and registered internally; selection rejects unverified objects. Decisions distinguish same version/downgrade/platform/Node floor/updater floor/bootstrap/source-version incompatibility; only a strictly higher stable candidate is available. The shared production key remains `UNCONFIGURED`; no production key, environment-selected trust root or key discovery was added. Fixture keys are generated in memory.

The injected-fetch Release source queries only the official repository latest Release, rejects drafts/prereleases, binds manifest asset paths and signed version to the selected tag, and uses the actual publisher names `update-manifest.json` / `update-manifest.json.sig`. Fetch uses manual redirects, HTTPS and exact host checks, credential omission, a single request deadline, response-byte/content-length bounds, and cancellation. Default deadline 15000 ms and maximum three redirects; redirect CDN allowlist is `release-assets.githubusercontent.com` / `objects.githubusercontent.com` plus official GitHub asset URLs. API/manifest budgets are 1 MiB and raw Ed25519 signature budget 64 bytes. Tests supply local Response objects only.

Real ZIP and gzip/USTAR parsers inspect all member bodies and budgets before extraction. Both formats support the publisher's top-level `filestation-v<version>-win-x64/` or `-linux-x64/`; output strips that prefix and requires content in `apps/server/dist`, `apps/web/dist`, `packages/shared/dist`, and `node_modules`. Tests invoke the unchanged `scripts/release/package-artifact.mjs` in a local child Node process to produce both safe formats. Malicious fixtures contain actual ZIP/tar.gz bytes, not supplied parser metadata. Rejections include traversal/absolute/drive/UNC/backslash/alternate streams, invalid path components, links/devices/FIFOs/sockets, duplicates/case or file-directory collisions, reserved root data/updater and .env components, entry/per-file/total/ratio budgets, bad declared sizes, ZIP encryption/unsupported flags, inconsistent local/central metadata, CRC errors, USTAR checksums/padding, truncated gzip and trailing input.

Default archive budgets: 1 GiB compressed (hard maximum 2 GiB), 100000 entries, 512 MiB/file, 4 GiB total, ratio 200; actual total must equal signed `unpackedSize`. ZIP and tar use bounded chunks rather than allocating entire inflated files. Plans are frozen and bound by internal object identity to their handle and limits; forged/cloned plans fail. Extraction exclusively creates a nonexistent destination, creates a random child stage on that same volume, writes with exclusive/native no-follow creation and repeat byte counting, verifies the consumed source hash and plan again, and moves content into its owned destination. Cleanup preserves an existing destination and unrelated siblings.

## Windows handle strategy and honest boundaries

Read-only probe on this actual host:

```json
{"node":"v22.14.0","platform":"win32","O_NOFOLLOW":"undefined","O_SYMLINK":"undefined","O_SYNC":"undefined","updateCoreDist":true}
```

No absent flag is replaced with zero. The Windows adapter calls kernel32 through Koffi. It opens the source with `CreateFileW`, `GENERIC_READ`, `OPEN_EXISTING`, `FILE_FLAG_OPEN_REPARSE_POINT`, and share-read only. `GetFileInformationByHandle` on that exact handle rejects reparse attributes, directories/special sources and multiple hardlinks, and provides volume/file index and size. Each ancestor directory is opened with OPEN_REPARSE_POINT / BACKUP_SEMANTICS, checked from its own handle, and retained without write/delete sharing until close. Reads and hash/parse/extract passes all use the retained source handle through SetFilePointerEx/ReadFile. Output uses GENERIC_WRITE / CREATE_NEW / OPEN_REPARSE_POINT with ancestor checks and retained handles during the write. POSIX uses native O_NOFOLLOW and exclusive output creation; ancestor lstat is defensive validation, not a claim of race-free pathname resolution. Source authenticity on every platform comes from retained file identity/size plus hashes of the actual consumed bytes.

The bytes consumed by ZIP parsing are hashed in physical order (local headers/names/compressed streams, the exact central records used for validation, footer). gzip input is hashed as fed to the decompressor. This also detects in-place source mutation/restoration that could defeat a mere before/after file hash. The source path is never reopened after inspection. On Windows the real replacement fixture confirms rename fails while the handle is open and extraction reads the original file. A real directory junction is created without elevated symlink privilege and rejected. Four injected native adapter tests separately assert Win32 flags/sharing, same-handle reads/identity, rejection before reads, close sequences and CREATE_NEW output. These are distinguished from real OS coverage.

The file-symlink fixture is **one explicit skip** on this Windows account (the supplied host finding was EPERM; the probe only permits EPERM/EACCES as skip reasons). It is not claimed as executed coverage. Linux execution and Node 20.17 hosted runs were not available here; implementation uses Node 20.17 APIs, but this local evidence is Node 22.14 Windows x64. The implementation deliberately accepts a strict publisher subset: ASCII portable member paths, non-ZIP64 ZIP without comments/extras/data descriptors, and USTAR tar without PAX/GNU extensions; unsupported formats fail closed. Windows source paths must be local drive paths, not UNC/device namespaces. Native adapter availability must be exercised on hosted Windows/Linux before release.

Caller boundary: destination parents belong to the installer and must be private/controlled; this library is not a sandbox against a malicious actor already authorized to rewrite that parent or its staging tree. It does not grant ACLs, perform version switching, establish durable journals or claim power-loss safety; those are Task 5 installer obligations. Source handle identity/reparse and consumed-byte checks are implemented here, not deferred to an lstat-only scheme. Relevant primary API references consulted: [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [Koffi output marshalling](https://koffi.dev/output). No runtime network use follows from these documentation reads.

## RED → GREEN evidence

Commands below were run in PowerShell. `npm.cmd` avoids PowerShell's npm wrapper swallowing `--runInBand`. The first `npm test --workspace=@filestation/update-core -- --runInBand` invocation did not forward that Jest flag; its output still established missing implementations. Repeated exact native command below did forward it.

1. After workspace/config and verifier/download tests, before implementation:

```text
npm test --workspace=@filestation/update-core -- --runInBand
FAIL src/download-policy.spec.ts
TS2307: Cannot find module './download-policy'
TS2307: Cannot find module './release-source'
FAIL src/manifest.spec.ts
TS2307: Cannot find module './manifest'
TS2307: Cannot find module 'canonicalize'
Test Suites: 2 failed, 2 total
Tests:       0 total
Snapshots:   0 total
Time:        2.264 s
Ran all test suites.
exit 1
```

2. After dependency setup and adding real archive fixture tests, still before implementation:

```text
npm.cmd test --workspace=@filestation/update-core -- --runInBand
> jest --config jest.config.json --runInBand
FAIL src/archive-policy.spec.ts
TS2307: Cannot find module './archive-policy'
FAIL src/manifest.spec.ts
TS2307: Cannot find module './manifest'
FAIL src/download-policy.spec.ts
TS2307: Cannot find module './download-policy'
TS2307: Cannot find module './release-source'
Test Suites: 3 failed, 3 total
Tests:       0 total
Snapshots:   0 total
Time:        1.457 s
Ran all test suites.
exit 1
```

3. Intermediate implementation run: same command, 2 suites passed / 1 failed; 65 passed / 3 failed / 68 total, 2.073 s, exit 1. All failures were actual successful extraction paths reaching `rm` on an empty directory (`EISDIR`). Added offline Release/adapter tests before fixing it: 4 suites passed / 1 failed; 70 passed / 3 failed / 73 total, 2.211 s, exit 1. Replaced that operation with `rmdir`; focused GREEN then reported 5 suites / 73 passed, 2.53 s, exit 0; focused typecheck/build exit 0.

4. Extended publisher-generated fixtures first failed because fixture preparation omitted the publisher-required package-lock.json: 5 suites passed / 1 failed; 87 passed / 2 failed / 1 skipped / 90 total, 2.315 s, exit 1. Populated all required publisher paths. Same command then passed 6 suites / 89 passed / 1 skipped / 90 total, 2.848 s, exit 0; focused typecheck/build exit 0.

5. Self-review regression RED: signed BOM and duplicate publisher-root directories were accepted. Added those tests (plus CDN/length policy test), then ran the same command:

```text
Test Suites: 2 failed, 4 passed, 6 total
Tests:       2 failed, 1 skipped, 90 passed, 93 total
Snapshots:   0 total
Time:        2.468 s, estimated 3 s
Ran all test suites.
exit 1
```

Changed canonical validation to compare canonical UTF-8 bytes against the original Buffer, validated normalized calendar timestamps, and tracked/validated explicit root directory entries.

6. Final focused GREEN (after final implementation and formatting):

```text
npm.cmd test --workspace=@filestation/update-core -- --runInBand
> @filestation/update-core@0.2.0 test
> jest --config jest.config.json --runInBand
PASS src/archive-policy.spec.ts
PASS src/manifest.spec.ts
PASS src/publisher-archive.spec.ts
PASS src/download-policy.spec.ts
PASS src/release-source.spec.ts
PASS src/platform-file.spec.ts
Test Suites: 6 passed, 6 total
Tests:       1 skipped, 92 passed, 93 total
Snapshots:   0 total
Time:        2.951 s, estimated 3 s
Ran all test suites.
exit 0

npm.cmd run typecheck --workspace=@filestation/update-core
> @filestation/update-core@0.2.0 typecheck
> tsc --noEmit
exit 0

npm.cmd run build --workspace=@filestation/update-core
> @filestation/update-core@0.2.0 build
> tsc
exit 0
```

## Mandated repository verification and authorized integration repair

Full server and Web suites were each run once. Outputs were captured with `2>&1 | Tee-Object -FilePath (Join-Path $env:TEMP 'filestation-task4-<suite>.log')`; exit codes explicitly use `$LASTEXITCODE`. No full suite reruns after the type-only integration repair, as the controller explicitly requested focused verification instead.

```text
npm.cmd test --workspace=@filestation/server -- --runInBand
Test Suites: 25 passed, 25 total
Tests:       20 todo, 172 passed, 192 total
Snapshots:   0 total
Time:        24.736 s, estimated 185 s
Ran all test suites.
exit 0

npm.cmd run test:e2e --workspace=@filestation/server
Test Suites: 10 passed, 10 total
Tests:       85 passed, 85 total
Snapshots:   0 total
Time:        24.264 s
Ran all test suites.
exit 0

# cwd apps/web
npm.cmd exec -- vitest run --no-cache
 Test Files  17 passed (17)
      Tests  186 passed (186)
   Start at  23:03:59
   Duration  5.87s (transform 2.91s, setup 0ms, import 23.74s, tests 5.77s, environment 38.55s)
exit 0
```

Existing ts-jest shared-dist/allowJs warnings, expected lifecycle AbortError/payload-too-large logging in server negative cases, and PageErrorBoundary's intentional `render failed` logging occurred while these suites passed. These were not hidden or interpreted as new failures.

First `npm.cmd run typecheck` exited 2 in Web. Since the sequential shell command stopped there, root build was then invoked independently once and also exited 2. Both exposed the prior chapter's integration typing gap:

```text
src/__tests__/base-url.test.ts(179,26): error TS2339: Property 'match' does not exist on type 'ILayer'.
src/__tests__/base-url.test.ts(202,22): error TS2339: Property 'match' does not exist on type 'ILayer'.
src/__tests__/base-url.test.ts(218,22): error TS2339: Property 'match' does not exist on type 'ILayer'.
```

`git diff --exit-code HEAD -- apps/web/src/__tests__/base-url.test.ts` was empty before repair. The controller then explicitly expanded scope for a minimal repair in that one file: a local unknown-input structural guard checks that the installed runtime layer has a callable `match(path: string): boolean`, failing setup if unavailable. No any, global declaration, strictness reduction, matcher assertion removal or Nginx/URL production change.

After that authorized repair:

```text
npm.cmd exec --workspace=@filestation/web -- vitest run --no-cache src/__tests__/base-url.test.ts
 Test Files  1 passed (1)
      Tests  44 passed (44)
   Start at  23:07:32
   Duration  1.16s (transform 44ms, setup 0ms, import 379ms, tests 362ms, environment 0ms)
exit 0

npm.cmd run typecheck
> npm run typecheck --workspace=@filestation/shared && npm run build:shared && npm run typecheck --workspace=@filestation/update-core && npm run typecheck --workspace=@filestation/server && npm run typecheck --workspace=@filestation/web
# shared typecheck/build, update-core/server/web typecheck all completed
exit 0

npm.cmd run build
> npm run build:shared && npm run build --workspace=@filestation/update-core && npm run build --workspace=@filestation/server && npm run build --workspace=@filestation/web
# shared and update-core tsc, server nest build, Web tsc && vite build
vite v6.4.3 building for production...
transforming...
✓ 85 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.48 kB │ gzip:  0.31 kB
dist/assets/index-LDiAzj-u.css   20.03 kB │ gzip:  4.39 kB
dist/assets/index-Btle6eXZ.js   323.55 kB │ gzip: 98.42 kB
✓ built in 1.14s
exit 0

Test-Path packages/update-core/dist/index.js
True
```

`rg -n '@filestation/update-core|update-core' apps/web/src packages/shared/src` returned no matches. `Test-Path node_modules/.bin/eslint.cmd` returned False; lint is unavailable, not passed. Root `npm test` was not used as a full-suite proxy because shared lacks its test script.

Final whitespace verification: `git diff --check` is run once after marking new files intent-to-add so it includes all Task 4/report changes. Its result is recorded below after execution; the commit uses `feat(updater): verify signed update manifests`.

## Changed paths and self-review

- `packages/update-core/package.json`, `tsconfig.json`, `jest.config.json`.
- `packages/update-core/src/manifest.ts`, `manifest.spec.ts`, `test-fixture.ts` (test helper excluded from production compilation).
- `packages/update-core/src/download-policy.ts`, `download-policy.spec.ts`.
- `packages/update-core/src/release-source.ts`, `release-source.spec.ts`.
- `packages/update-core/src/archive-policy.ts`, `archive-policy.spec.ts`.
- `packages/update-core/src/platform-file.ts`, `platform-file.spec.ts`, `publisher-archive.spec.ts`, `index.ts`.
- Root `package.json`, `package-lock.json`.
- `docs/CURRENT-STATE.md`.
- `apps/web/src/__tests__/base-url.test.ts` (explicitly authorized minimal prior-fix integration typing repair only).
- `.superpowers/sdd/2026-09-29-release-auto-update-implementation/task-4-report.md`.

Self-review addressed actual reproduced BOM, calendar-validation, duplicate-root and extraction-cleanup defects; same-consumed-input hashing closes the before/after hash-only race. Remaining review/acceptance boundaries are Linux/Node20 hosted execution, privilege-dependent file symlink, native Koffi deployment, strict publisher-format subset, and caller ownership of the destination parent. No claim of durable rename/power-loss acceptance, updater switching or completed product release. No controller ledger, design/whole-plan or prior Nginx configuration changed.

## Final checkpoint

`git diff --check` after intent-to-add: **exit 0**, no whitespace errors. Git emitted only the configured LF→CRLF working-copy conversion warnings. All six mandated checks have been executed; root typecheck/build passed after the authorized integration repair. Commit command: `git commit -m "feat(updater): verify signed update manifests"`.

## Task 4 fix round 1/5 — Important 1: product version gate

Base: `c60eb1bc253617fcce906f1b1263370b44a148d6`. The review correctly identified that the release validator still enumerated only root/server/web/shared and therefore accepted a missing or `9.9.9` update-core manifest while returning `productManifestCount: 4`.

Minimal authorized cross-task repair: add `packages/update-core/package.json` to the existing explicit `PRODUCT_MANIFESTS` list. Both in-memory validation and the CLI's manifest reader share this list. Existing missing-manifest and exact tag-version checks now cover update-core, returning count **5**. Third-party tools remain outside the explicit product set. The updater package does not exist yet and is not required now; a nearby comment records the obligation for Task 5 to add it when introduced. Product version stays `0.2.0`; no lockfile, dependency, trust-root, archive implementation, release workflow or publisher format changes.

Updated the release tests' workspace fixture and count assertion, plus three regression cases: missing update-core, mismatched update-core `9.9.9`, and unrelated tool manifests with independent versions while no future updater is present. Tests call real validation, not a mocked validator. The unchanged core publisher fixtures invoke the publisher module that imports this validator's SemVer helper; both archive formats passed, so they require no source changes for the constant addition.

Exact RED command (before the validator edit):

```text
node --test scripts/release/release-tools.test.mjs
not ok 1 - version validation requires the tag and all five product manifests to agree
# actual productManifestCount: 4; expected: 5
not ok 2 - version validation rejects a missing update-core manifest
# Missing expected exception.
not ok 3 - version validation rejects a mismatched update-core product version
# Missing expected exception.
not ok 4 - version validation excludes third-party tooling and does not require a future updater
# 4 !== 5
1..43
# tests 43
# suites 0
# pass 39
# fail 4
# cancelled 0
# skipped 0
# todo 0
# duration_ms 608.8702
exit 1
```

Exact GREEN command (after the two-line validator change):

```text
node --test scripts/release/release-tools.test.mjs
ok 1 - version validation requires the tag and all five product manifests to agree
ok 2 - version validation rejects a missing update-core manifest
ok 3 - version validation rejects a mismatched update-core product version
ok 4 - version validation excludes third-party tooling and does not require a future updater
1..43
# tests 43
# suites 0
# pass 43
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 601.1158
exit 0

npm.cmd test --workspace=@filestation/update-core -- --runInBand
> jest --config jest.config.json --runInBand
PASS src/archive-policy.spec.ts
PASS src/publisher-archive.spec.ts
PASS src/manifest.spec.ts
PASS src/download-policy.spec.ts
PASS src/release-source.spec.ts
PASS src/platform-file.spec.ts
Test Suites: 6 passed, 6 total
Tests:       1 skipped, 92 passed, 93 total
Snapshots:   0 total
Time:        2.175 s, estimated 3 s
Ran all test suites.
exit 0

npm.cmd run typecheck --workspace=@filestation/update-core
> @filestation/update-core@0.2.0 typecheck
> tsc --noEmit
exit 0
```

Outputs were captured with `2>&1 | Tee-Object -FilePath (Join-Path $env:TEMP 'filestation-task4-round1-<red|green|core|typecheck>.log')`; each shell block preserves `$LASTEXITCODE`. No external calls, agents, push/tag/Release, unchanged server/Web suite reruns or root rebuilds. The existing Windows file-symlink skip remains explicitly disclosed; this round does not expand platform coverage.

Changed paths this round: `scripts/release/validate-version.mjs`, `scripts/release/release-tools.test.mjs`, `docs/CURRENT-STATE.md`, and this report. Self-review: the explicit product list is intentionally maintained rather than broad directory discovery, preserving third-party exclusion; Task 5 must append the updater workspace. Archive/manifest core remains otherwise approved and unchanged. Final whitespace result is appended after execution.

Round 1 final check: `git diff --check` exited **0**, with only LF→CRLF conversion warnings and no whitespace errors. Commit command: `git commit -m "fix(ci): enforce update-core release version"`.
