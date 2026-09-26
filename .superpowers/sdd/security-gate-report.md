# Phase 2 Dependency Security Gate Report

**Baseline:** `df26fc5` (Task14 approved; 2026-09-26)
**Host:** Node `v22.14.0`, npm `10.9.2` (default npm); root minimum Node `>=20.17.0`
**Disposition:** Critical/High security gate cleared. `npm audit` is not fully clean: Moderate/Low advisories remain. Phase 2 user acceptance and overall release approval remain pending.

## Audit before / after

Both recorded snapshots were fetched from the npm registry with `npm audit --json` and `npm audit --omit=dev --json`. On resumed final validation, another attempt to refresh both commands failed because registry access returned `EACCES`; a request for elevated network access was denied, so the counts below remain the last successful snapshot rather than a new result. No dependency changes followed that successful snapshot. npm audit exits `1` while any findings remain; do not describe either command as passing.

| Dependency closure | Before: findings (C/H/M/L) | Before direct / transitive | After: findings (C/H/M/L) | After direct / transitive |
|---|---:|---:|---:|---:|
| Full | 46 (2 / 19 / 19 / 6) | 17 / 29 | 25 (0 / 0 / 23 / 2) | 15 / 10 |
| Production (`--omit=dev`) | 28 (1 / 13 / 11 / 3) | 12 / 16 | 17 (0 / 0 / 16 / 1) | 12 / 5 |

The baseline Criticals were the production `tar@6.2.1` archive-extraction chain and dev `vitest@1.6.1`. The final snapshot has zero Critical and zero High in both closures. Remaining findings are 23 Moderate / 2 Low full and 16 Moderate / 1 Low production.

## Dependency changes and reviewed experiments

- `sqlite3` `5.1.7 → 6.0.1`; `bcrypt` `5.1.1 → 6.0.0`; TypeORM remains `0.3.31`. Registry metadata: sqlite3 6 requires Node `>=20.17.0`, and TypeORM's sqlite3 peerOptional range includes `^5.0.3 || ^6.0.0`. Root `engines`, README and AGENTS deployment guidance now state Node `>=20.17.0`.
- Web test/build stack: `vite` `^6.4.3`, `vitest` `^4.1.11`. Vitest 4.1.11 covers the later Vitest4 advisory while supporting Node20; Vite6.4.3 is the patched Vite6 line. A Vitest4 type change exposed one broad `ReturnType<typeof vi.fn>` in `LoginPage.test.tsx`; parameterizing that test mock with the actual two-argument login callback restored root typecheck without changing runtime behavior.
- Exact-parent overrides in root `package.json`:
  - `@nestjs/common@10.4.22 → file-type@20.5.0`; `@nestjs/config@3.3.0 → lodash@4.18.1`; `@nestjs/swagger@7.4.2 → js-yaml@4.3.2` and `lodash@4.18.1`.
  - `@nestjs/platform-express@10.4.22 → multer@2.3.0`. This is a scoped, non-official Nest10/Multer combination; full upload/MCP E2E, typecheck and build passed. Preserve this explicit compatibility caveat for future Nest upgrades.
  - `@nestjs/serve-static@4.0.2 → path-to-regexp@1.9.0`; `express@4.22.1 → path-to-regexp@0.1.13` to preserve Express4's `~0.1.12` API range. The initial 1.9-only trial made npm reuse 1.9 inside Express and was removed; the final separate Express constraint yields a valid tree. New ServeStatic E2E verifies static asset, SPA fallback, API route, and exclude behavior.
  - `@nestjs/cli@10.4.9 → glob@11.1.0`; `external-editor@3.1.0 → tmp@0.2.7`; `@angular-devkit/core@17.3.11 → picomatch@4.0.4`; `fdir@6.5.0 → picomatch@4.0.7`. The Angular DevKit exact pin prevents npm from hoisting the Vite picomatch version into a dependency that pins 4.0.1; `picomatch@2.x` consumers remain on 2.3.2. `npm ls --all` exits 0.
- `tmp@0.2.6` was rejected: the refreshed audit exposed a new High, GHSA-7c78-jf6q-g5cm (`>=0.2.6 <0.2.7`). `tmp@0.2.7` is the first patched version for that advisory, supports Node `>=14.14`, and leaves the dependency tree/build green.
- `@nestjs/cli@12.0.7` was tried as a dev-only official audit route; `nest build` failed on the host with `ERR_REQUIRE_CYCLE_MODULE` while loading ESM `ora` through Angular DevKit's CommonJS executor. Its Angular DevKit dependencies also declared Node `^22.22.3 || ^24.15.0 || >=26.0.0`, above this host's Node22.14. The experiment was fully rolled back; CLI10 and every Nest runtime package remain at their compatible majors.
- `npm audit fix --force` was never run. No override was retained when `npm ls --all` or verification failed.

## Final package-level audit inventory

`Direct` is npm's `isDirect` classification. Production/runtime membership is determined by presence in the `--omit=dev` result; other full-audit rows are dev-only. Aggregate rows can inherit severity from the named transitive dependency, while the advisory leaf is listed separately.

### Production/runtime (17 rows: 12 direct, 5 transitive)

| Package | Severity / directness | Advisory or dependency path | npm `fixAvailable` |
|---|---|---|---|
| `@nestjs/common` | Moderate, direct | `file-type` | `@nestjs/common@12.1.0` (major) |
| `@nestjs/config` | Moderate, direct | `@nestjs/common` | compatible update (`true`) |
| `@nestjs/core` | Moderate, direct | `@nestjs/common`, `@nestjs/platform-express`; GHSA-36xv-jgw5-4q75 | `@nestjs/core@12.1.0` (major) |
| `@nestjs/jwt` | Moderate, direct | `@nestjs/common` | compatible update (`true`) |
| `@nestjs/mapped-types` | Moderate, transitive | `@nestjs/common` | `@nestjs/swagger@12.0.2` (major) |
| `@nestjs/passport` | Moderate, direct | `@nestjs/common` | compatible update (`true`) |
| `@nestjs/platform-express` | Moderate, direct | `@nestjs/common`, `@nestjs/core`, `body-parser` | `@nestjs/platform-express@12.1.0` (major) |
| `@nestjs/schedule` | Moderate, direct | `@nestjs/common`, `@nestjs/core`, `uuid` | `@nestjs/schedule@12.0.2` (major) |
| `@nestjs/serve-static` | Moderate, direct | `@nestjs/common`, `@nestjs/core`; path-to-regexp High is resolved by the scoped 1.9.0 override | `@nestjs/serve-static@12.0.0` (major) |
| `@nestjs/swagger` | Moderate, direct | `@nestjs/common`, `@nestjs/core`, `@nestjs/mapped-types` | `@nestjs/swagger@12.0.2` (major) |
| `@nestjs/typeorm` | Moderate, direct | `@nestjs/common`, `@nestjs/core`, `uuid` | `@nestjs/typeorm@12.0.1` (major) |
| `body-parser` | Low, transitive | GHSA-v422-hmwv-36x6 (`<1.20.6`) | `@nestjs/platform-express@12.1.0` (major) |
| `file-type` | Moderate, transitive | GHSA-5v7r-6r5c-r473; GHSA-j47w-4g3g-c36v | `@nestjs/common@12.1.0` (major) |
| `qs` | Moderate, transitive | GHSA-q8mj-m7cp-5q26; GHSA-x5fp-wj9c-mxmx; GHSA-4mjr-xmp4-gh2g | compatible update (`true`) |
| `react-router` | Moderate, transitive | GHSA-wrjc-x8rr-h8h6; GHSA-337j-9hxr-rhxg | `react-router-dom@7.18.4` (major) |
| `react-router-dom` | Moderate, direct | via `react-router` above | `react-router-dom@7.18.4` (major) |
| `uuid` | Moderate, direct | GHSA-w5hq-g745-h8pq | `uuid@14.0.2` (major) |

### Dev-only (8 rows: 3 direct, 5 transitive)

| Package | Severity / directness | Advisory or dependency path | npm `fixAvailable` |
|---|---|---|---|
| `@angular-devkit/core` | Moderate, transitive | `ajv` | `@nestjs/cli@12.0.7` (major) |
| `@angular-devkit/schematics` | Moderate, transitive | `@angular-devkit/core` | compatible update (`true`) |
| `@angular-devkit/schematics-cli` | Moderate, transitive | `@angular-devkit/core`, `@angular-devkit/schematics` | compatible update (`true`) |
| `@nestjs/cli` | Moderate, direct | Angular DevKit, Nest schematics, webpack | `@nestjs/cli@12.0.7` (major; tried and reverted after build failure) |
| `@nestjs/schematics` | Moderate, direct | `@angular-devkit/core`, `@angular-devkit/schematics` | `@nestjs/schematics@12.0.0` (major) |
| `@nestjs/testing` | Moderate, direct | Nest common/core/platform-express | `@nestjs/testing@12.1.0` (major) |
| `ajv` | Moderate, transitive | GHSA-2g4f-4pwh-qvx6 | `@nestjs/cli@12.0.7` (major) |
| `webpack` | Low, transitive | GHSA-8fgc-7cc6-rx7x; GHSA-38r7-794h-5758 | `@nestjs/cli@12.0.7` (major) |

## Verification evidence

- `npm ls --depth=0`, `npm ls --all`, and targeted dependency-tree checks exit 0. In an isolated Temp copy containing the root/workspace manifests and lockfile, default npm10.9.2 ran `npm ci --ignore-scripts --no-audit` successfully (1,077 packages), followed by `npm ls --all` exit 0; that task-created copy was removed.
- Resumed-turn `npm audit --json` and `npm audit --omit=dev --json` refresh attempts were blocked by registry `EACCES`; the application approval review also rejected the elevated request. No alternate route was used. The audit counts in this report refer to the last successful registry snapshot above.
- `npm test --workspace=@filestation/server -- --runInBand`: 25 suites, 172 passed, 20 todo.
- `npm run test:e2e --workspace=@filestation/server`: 10 suites, 85 passed, including upload init/part/complete, MCP size behavior and the new ServeStatic regression.
- Focused `concurrency.e2e-spec.ts`, `file-lifecycle-recovery.e2e-spec.ts`, and `folders-concurrency.e2e-spec.ts`: three separate consecutive rounds, 18 tests per round, all passed.
- Web `npx vitest run --no-cache`: 15 files, 131 passed.
- Root `npm run typecheck` and `npm run build`: passed. `git diff --check`: recorded with final commit validation.
- `npm run lint`: unavailable, not passed; server and web cannot find the `eslint` executable, and shared has no lint script.
- SQLite migration/entity alignment, WAL/immediate transaction coverage and concurrency/recovery/upload E2E passed. The full server unit set includes auth-service tests; the earlier explicit bcrypt compatibility probe verified an old hash and new-password authentication under bcrypt6.

## Independent security review

Final review of `df26fc5..7a5ba50`: **APPROVED**, no Critical/P1/P2. The reviewer independently reran server unit (25 suites / 172 passed / 20 todo), full server E2E (10 suites / 85 passed), Web Vitest no-cache (15 files / 131 passed), root typecheck and build, focused ServeStatic E2E (2/2), and `git diff --check`. Additional reviewer checks confirmed `npm ls --all` exit 0 and the expected dependency placement (ServeStatic path-to-regexp 1.9.0; Express4 path-to-regexp 0.1.13; Nest core/swagger 3.3.0; Angular picomatch 4.0.4; Vite/fdir picomatch 4.0.7; CLI glob 11.1.0; external-editor tmp 0.2.7; platform-express Multer 2.3.0), SQLite native binding load/version, and bcrypt6 hash round-trip. No secret was found; both unrelated user files remained untracked.

Residual limitations accepted as non-blocking for this security-fix review, not as release approval: the latest registry audit refresh was denied with `EACCES`, so reported counts remain the last successful snapshot; isolated `npm ci --ignore-scripts --no-audit` validates lockfile/tree reproduction but skips install scripts and is not itself proof of a clean-room native install (current-host native binding load and full runtime tests are separate evidence); exact parent-scoped overrides need fresh advisory and compatibility review when parent versions change, especially the non-official Nest10/Multer2 combination; Moderate/Low advisories and real MCP client, 375px/device layout, TOTP/recovery, and refresh-resume user acceptance remain pending.

## Remaining decision

The last successful registry snapshot contains no production Critical/High or dev Critical/High. Moderate/Low handling is not a release blocker under the current documented Critical/High checklist, but is not risk-free. The majority of official fixes cross Nest10→Nest12, file-type20→21, React Router6→7 or uuid9→14. Schedule that work with compatibility tests and/or record risk acceptance before expanding to those majors. Real MCP client, 375px/device layout, real TOTP/recovery, and refresh-resume manual checks remain pending; this report does not approve full Phase2 release acceptance.
