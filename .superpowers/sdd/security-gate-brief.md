# Phase 2 Dependency Security Gate Repair Brief

**Baseline:** `df26fc5` (Task14 approved docs round; 2026-09-26)

**Goal:** Reduce the production and development dependency audit findings without crossing the Nest major boundary or applying unverified overrides, then record whether the Phase 2 release security gate can be cleared.

## Scope and constraints

- Re-run registry-backed `npm audit --json` and `npm audit --json --omit=dev`; classify each package by severity, direct/transitive status, production/dev closure, advisory, and `fixAvailable`.
- Prioritize the production `tar` Critical and the Vitest Critical. Review all production High advisories for compatible patch/minor routes.
- Do not run `npm audit fix --force`, apply blind overrides, or upgrade Nest across major versions in this round.
- Use npm workspace-scoped installs and preserve lockfile consistency.
- Before accepting native package majors, verify SQLite migrations/entity alignment, WAL and immediate transactions, concurrency/recovery/uploads/full E2E; verify old bcrypt hashes and new-password login; run all Web Vitest tests after the Vitest/Vite changes.
- If sqlite3 6 is selected, raise the documented project Node minimum to at least 20.17.0 after validating this host and its compatibility requirements.
- Update `docs/CURRENT-STATE.md`, README, AGENTS, package engines, and this SDD ledger. Commit only this security repair scope; retain unrelated untracked user files. Do not create a PR or merge.

## Initial environment and registry snapshot

- Host: Node `v22.14.0`, npm `10.9.2`.
- Root engine: Node `>=20.0.0`.
- Installed dependency versions: TypeORM `0.3.31`, sqlite3 `5.1.7`, bcrypt `5.1.1`, Vitest `1.6.1`, Vite `5.x`.
- `npm audit --json`: 46 findings — 2 Critical, 19 High, 19 Moderate, 6 Low; 17 direct / 29 transitive. Command exits 1 because advisories exist.
- `npm audit --json --omit=dev`: 28 findings — 1 Critical, 13 High, 11 Moderate, 3 Low; 12 direct / 16 transitive. Command exits 1 because advisories exist.
- The default sandbox initially denied registry TLS (`EACCES`); the successful snapshot was obtained through the approved elevated npm registry call. Failed attempts are not audit results.

## Major-version candidates requiring verification

- `sqlite3@6.0.1`: npm metadata says Node `>=20.17.0`, optional peer `node-gyp@12.x`, and TypeORM `0.3.31` accepts sqlite3 `^5.0.3 || ^6.0.0`. Registry metadata is necessary but not sufficient; validate native installation and the listed SQLite regression matrix.
- `bcrypt@6.0.0`: npm metadata says Node `>=18`; install chain switches to `node-gyp-build` and removes the old `@mapbox/node-pre-gyp` route. Verify existing bcrypt hashes and login behavior.
- Vitest advisory `GHSA-5xrq-8626-4rwp` is patched in 3.2.6/4.1.0; Vitest4 then has a later advisory affecting `<4.1.11`, while Vitest5 raises the Node floor to 22.12. Select `vitest@4.1.11` as the lowest currently safe maintained major on Node20 and pair it with Vite6.4.3. Keep an eye on Vitest's changing Node engines; do not downgrade to an unpatched/unsupported 3.x merely to reduce version distance.
- Vite Windows `server.fs.deny` advisory `GHSA-fx2h-pf6j-xcff`: Vite 6 first patched release is `6.4.3`; npm engine supports Node20. Validate `vite@6.4.3` with `vitest@4.1.11` and the installed React plugin.

## Baseline security findings

- Production Critical `tar`: transitive dependency in the native installation/archive extraction graph, through sqlite3/node-gyp and bcrypt/node-pre-gyp. Audit currently recommends `sqlite3@6.0.1` as the graph fix.
- Development Critical `vitest@1.6.1`: direct dev dependency. Audit recommends Vitest 5, but the first patched 3.x release is compatible with the desired Node 20 floor and will be evaluated.
- Production direct High findings include `bcrypt`, `sqlite3`, `@nestjs/platform-express` (Multer chain), and `@nestjs/serve-static` (`path-to-regexp` chain). The npm suggested fixes for the two Nest packages cross to Nest 12 and are outside this round.
- The remainder of the baseline audit package-by-package advisory and fixability table will be captured in the report after resolution and the final audit rerun.

## Verification plan

- SQLite dependency upgrade: fresh database migrations and entity alignment; WAL/busy timeout; `BEGIN IMMEDIATE`; focused concurrency/recovery/upload E2E repeatedly; full server E2E.
- bcrypt upgrade: old password hash verification and new-hash authentication through login, plus complete server unit/E2E.
- Vitest/Vite upgrade: all Web tests with `npx vitest run --no-cache`.
- Final: full server unit, full server E2E, concurrency-focused rounds, Web no-cache, typecheck, build, audit (all and omit-dev), `git diff --check`, and accurate lint availability status.

## Final disposition

- Current host remained Node `v22.14.0` / npm `10.9.2`; root engines/README/AGENTS now require Node `>=20.17.0` because of sqlite3 6.0.1.
- Final full audit: 25 findings, 0 Critical / 0 High / 23 Moderate / 2 Low; 15 direct / 10 transitive. Final `--omit=dev`: 17 findings, 0 Critical / 0 High / 16 Moderate / 1 Low; 12 direct / 5 transitive. Both audit commands still exit 1 because Moderate/Low findings remain; the Critical/High security gate is cleared, not the whole release/manual-acceptance gate.
- The production `tar` and dev Vitest Criticals are cleared by sqlite3 6.0.1, bcrypt 6.0.0 and Vitest 4.1.11. Same-major or tightly scoped patches clear production `multer`, `path-to-regexp`, and dev `glob`/`tmp` Highs; exact override details, advisories, remaining package table and test evidence are in `.superpowers/sdd/security-gate-report.md`.
- A path-to-regexp 1.9.0-only override initially caused npm to reuse 1.9.0 inside Express4, where Express requires `~0.1.12`; that experiment was removed. Final tree explicitly pins the ServeStatic subtree to 1.9.0 and Express4.22.1 to patched compatible 0.1.13. Added HTTP E2E covers static asset, SPA fallback and `/api/v1` exclude behavior.
- Nest CLI12.0.7 was evaluated as a dev-only official audit fix, but `nest build` failed on Node22.14 with `ERR_REQUIRE_CYCLE_MODULE` through Angular DevKit/ESM `ora`; it was fully rolled back. Nest runtime remains version10. Scoped CLI10→glob11.1.0 and external-editor3.1.0→tmp0.2.7 overrides leave `npm ls --all` clean and build green; tmp0.2.6 was rejected after audit revealed a new High fixed in 0.2.7.
- Full verification: server unit 25 suites / 172 passed / 20 todo; server E2E 10 suites / 85 passed; Web no-cache 15 files / 131 passed; focused concurrency/recovery/folder E2E 3 consecutive rounds / 18 passed each; root typecheck/build; isolated current-npm `npm ci --ignore-scripts --no-audit` + `npm ls --all`; lint unavailable (no eslint executable; shared workspace has no lint script).
- A resumed-turn final refresh of full and production registry audits was blocked: the default network returned `EACCES`, and the elevated request was rejected. Counts above are the last successful online snapshot; no dependency edits followed it.
- User acceptance remains pending for a real MCP client, 375px/device layout, real TOTP/recovery flow, and refresh-based upload resume. Do not declare Phase2 release acceptance complete.
