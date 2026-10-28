# FileStation Upgrade and Release Verification

This document covers the v0.2.0 release foundation. Managed layout and the
Windows/Linux updater begin with v0.2.5; v0.2.0 itself is a source-deployment
candidate.

## Before v0.2.0 can be tagged

The versioned release notes, CHANGELOG, root package, and all three workspace
manifests must agree on `0.2.0`. The exact candidate commit must be built by
`release-candidate.yml`, and its Windows/Linux artifact SHA-256 values must be
recorded with the Actions run ID in `release-evidence/v0.2.0.json`.

The same two downloaded artifact byte sets must pass the three Phase 2 manual
checks required by the repository: 375px layout, TOTP/recovery, and resume
after refresh. A later commit may change only the release evidence and the
evidence/status portion of `docs/CURRENT-STATE.md`. The tag workflow compares
that commit with the recorded candidate source and rejects changes to any
artifact input.

Candidate dispatch must select the exact source ref (an optional source SHA must
match that ref). Before signing, the release tool uses the job token with
`actions:read` to authenticate the recorded run through GitHub, requires the
expected repository and `release-candidate.yml`, a completed successful run,
and the exact source SHA. Same-repository candidate sources are required;
fork candidates cannot be promoted directly. It downloads that run's provenance
record and both archives, hashes their actual bytes, and reconciles provenance,
committed evidence, archive metadata and rebuilt bytes. Missing, expired,
unrelated or failed runs/artifacts stop signing. These hosted checks remain
pending until a real run exists; local fixtures do not supply release evidence.

## Publisher signing key prerequisite

The repository intentionally ships with an explicit unconfigured public-key
sentinel in
`packages/shared/src/update-public-key.ts`. Release signing and verification
fail closed until a reviewed publisher Ed25519 key is provisioned.

To enable signing after review:

1. Create an Ed25519 key pair in a protected administrative environment.
2. Store the private key as base64 PKCS#8 in the GitHub protected environment
   secret `RELEASE_SIGNING_PRIVATE_KEY_BASE64`. Do not commit it or place it in
   artifacts, logs, command arguments, or source-deployment configuration.
3. Resolve the configured `release-signing` GitHub environment to required
   reviewers and restrict who can deploy to it.
4. Provision only the base64 SPKI public key in
   `packages/shared/src/update-public-key.ts`, change its status to
   `configured`, and review that change before building the acceptance candidate.
   Key provisioning changes artifact inputs, so it requires a fresh candidate.

CI accepts either the explicit `unconfigured` / `UNCONFIGURED` pair or a
`configured` status with a valid Ed25519 base64 SPKI. Contradictory states,
malformed keys and other algorithms fail. Sentinel tests use temporary fixtures;
provisioning a reviewed real public key does not require changing the tests.

The release job checks that the private key derives exactly the checked-in SPKI
public key. Applications and the updater must use that fixed module as their
trust root. They must not accept a replacement key from the network, runtime
configuration, or writable installation data.

## Tag workflow behavior

Pushing a `v*` tag starts `.github/workflows/release.yml`. Before any Release is
created it:

1. Checks tag/workspace version agreement and the structured release gate.
2. Runs both Node test suites and the normal server, E2E, Web, typecheck, build,
   and diff checks.
3. Rebuilds the recorded candidate source commit on Windows x64 and Linux x64
   through `.github/workflows/release-platform.yml`.
4. Extracts each archive at a fresh absolute temporary path, verifies native
   SQLite/bcrypt loading, starts the server from the artifact root with an
   initialized credential-free smoke database using the extracted artifact's own
   smoke script and portable launcher, and requests `/api/v1/settings/public`,
   `/`, and a JS/CSS asset referenced by the returned HTML.
5. Authenticates the recorded candidate run and compares both downloaded and
   rebuilt SHA-256 values with its provenance and committed candidate evidence.
6. Renders the reviewed bilingual notes and signs the RFC 8785 canonical
   manifest only in the protected `release-signing` job.
7. Creates the GitHub Release only after all earlier checks succeed.

Until the publisher key and the pending human evidence are complete, the
intended outcome is failure before Release creation. Local tests and successful
non-signing CI do not replace hosted Windows/Linux acceptance or human review.

## Packaged startup

From the extracted artifact root, `npm start` invokes the shipped Node launcher
with static serving enabled and host `0.0.0.0`; `npm run start:bynginx` invokes
the same launcher with static serving disabled and host `127.0.0.1`, matching
the source scripts. Both work without `cross-env` or shell-specific assignments.
The launcher imports the server in the same process so stopping it stops the server.

## Task 6 managed bootstrap fixtures and source command

Task 6 adds the bootstrap, stable launcher, and pre-write validation needed for
the managed layout. This is implementation evidence for the update program; it
does not complete the v0.2.5 candidate, hosted Linux checks, or manual release
acceptance.

Capture the old process identity before stopping it. The bootstrap command
never signals or stops that process, and it fails if the supplied old identity
is still alive on the current boot.

On Windows:

```powershell
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString("O")
$created = (Get-CimInstance Win32_Process -Filter "ProcessId=<old-pid>").CreationDate.ToUniversalTime().ToString("O")
.\scripts\bootstrap-update.ps1 `
  -Root C:\FileStation `
  -SourceRoot C:\FileStation-source `
  -OldPid <old-pid> `
  -OldBootIdentity "win32:$boot" `
  -OldProcessCreatedAt "win32:$created" `
  -RelativePathPolicy preserve
```

On Linux:

```bash
old_pid=<old-pid>
boot="linux:$(cat /proc/sys/kernel/random/boot_id)"
created="linux-starttime:$(awk '{print $22}' "/proc/$old_pid/stat")"
bash scripts/bootstrap-update.sh \
  --root /srv/filestation \
  --source-root /srv/filestation-source \
  --old-pid "$old_pid" \
  --old-boot-identity "$boot" \
  --old-process-created-at "$created" \
  --relative-path-policy preserve
```

Bootstrap requires the original `NODE_ENV` explicitly (`production`, `development`
or `test`), from source .env or the invocation environment. If the old service
environment is unavailable, inspect it securely and resolve the mode before
proceeding; missing mode never silently selects development.
Before bootstrap writes, it validates effective production `NODE_ENV=production`
and a nonempty `JWT_SECRET`. Process variables take precedence over the source
`.env`. If either required value exists only in the old shell, use a trusted
editor to migrate the same values into the restricted source `.env`, or securely
configure **both** variables in the new service environment and pass
`--production-env-resolution service` (`-ProductionEnvResolution service` in
PowerShell). The acknowledgement records names/source only. Bootstrap never
copies shell secret values into `.env`, argv or output. Every service-mode launch
requires both variables from its actual calling environment; an old dotenv secret
cannot silently replace a missing service secret. Keep the original JWT secret
stable to preserve existing JWT/TOTP behavior. No service configuration is edited
by these commands.

Use `preserve` for default relative paths so the existing database, storage and
temp remain at their canonical absolute locations. Bootstrap does not copy the
storage tree. Any reviewed absolute path override must be an existing canonical
path and also requires `--accept-path-change`; prepare and validate data at the
new location separately before starting the managed service. Exclusions include
both old and new DB/WAL/SHM/storage/temp roots and canonical aliases. Recovery
`database.sqlite` is a verified snapshot of the **original** database. When a DB
path changes, `target-database.sqlite` separately validates the administrator's
prepared target; the manifest records both canonical identities and receipts.
Neither storage generation is copied into code or source backup trees.

The source checkout helpers below select the installation root as the child
process cwd. Root `.env` values load before server modules; variables already
present in the calling process take precedence:

```powershell
.\scripts\start-filestation.ps1 -Root C:\FileStation
```

```bash
bash scripts/start-filestation.sh --root /srv/filestation
```

For the installed standalone updater, use the installation root as cwd:

```powershell
Set-Location C:\FileStation
node .\updater\dist\cli.js launch --root .
```

```bash
cd /srv/filestation
node updater/dist/cli.js launch --root .
```

The Linux helper contract is explicit `bash scripts/<helper>.sh ...`, including
packaged/extracted or source-copied installations whose private files stay 0600.
Do not rely on an execute bit or change private files to a broader mode.

Direct CLI launch from a different cwd fails before loading the server. A missing
managed metadata file, changed canonical target (including an ancestor junction),
active/pending update, torn journal tail or unresolved staging marker also fails
closed. A completed update must agree with the journal's COMMITTED target version
and current release. `status` and `recover` inspect the journal without creating
or protecting directories.

Use `--dry-run` on `bootstrap` or `launch` to inspect validation without
creating directories or opening the database. `filestation-updater status
--root <root>` reads the existing journal contract. The updater process starts
automatically as `continue --attempt <id>` with its private capability delivered
on inherited stdin; never place that capability in argv, environment variables,
URLs, logs or status files. Ambiguous active states, including states requiring
an operator proof that is unavailable to this CLI, still fail closed. Do not edit
or truncate journal files by hand.

After a committed update has passed the independent restart check, remove the
bootstrap-only recovery copies for one exact identifier with:

```powershell
node .\updater\dist\cli.js cleanup --bootstrap-backup <exact-id> --root .
```

```bash
node updater/dist/cli.js cleanup --bootstrap-backup <exact-id> --root .
```

This removes only that backup's `env` and `legacy-source` recovery trees. It
keeps the verified database snapshot and every current/previous/active rollback
asset. Startup and retention never remove those bootstrap trees automatically.

Each bootstrap creates `backups/<id>/MANIFEST.json`, a verified SQLite snapshot,
the recoverable `legacy-source` tree, and a separate `env/legacy.env` copy.
Restore by stopping the managed process, reviewing that manifest, placing the
legacy tree and env file at a separate exact path, and starting the old command
from the original legacy root. Never run old and new versions against the same
database or storage. Internal dependency links in the backup and release point
inside their copied trees; the standalone updater resolves dependencies from the
managed release. When restoring the source to a different directory, materialize
those workspace links as ordinary directories or recreate them inside the restored
tree, restore the separate env file and verified snapshot, and explicitly review
the resulting canonical data paths before running the old command. The original
storage is preserved separately; it is never included in the source backup.

Bootstrap flushes copied assets, snapshot and their parent entries before
publishing managed metadata/current. An idempotent rerun verifies the planned
paths, expected release, backup manifest, recorded SQLite integrity/FK receipt,
snapshot/source/env hashes and internal links. A damaged installation is rejected;
keep the original source intact and investigate instead of treating it as an
already completed bootstrap. Reruns require exclusive bootstrap ownership before
reporting success. A remaining `.bootstrap-in-progress.json` or same-parent
bootstrap lock means **bootstrap recovery required**, even when metadata/current
and backup assets exist; do not remove a live owner's state or edit journals.
The CLI fails closed and gives manual inspection guidance instead of claiming
that an interrupted publication completed.

Nginx configuration is intentionally untouched. Review `proxy_pass` and the
manual root or `/fs/` configuration, run `nginx -t`, and reload Nginx yourself.
The supplied configuration explicitly denies the internal health/promote routes
at both the root and `/fs/`; this is defense in depth because the inherited
capability remains the authority even for loopback requests.

Source development commands establish emitted runtime dependencies explicitly:
`npm run dev:prepare` builds shared → update-core → updater, `npm run dev` runs
that preparation before starting dev processes, and `npm run typecheck` emits the
same prerequisites before checking dependents. Neither requires a preceding full
build. The fresh-prerequisite tests use isolated workspace fixtures without any
generated dist; they never delete or rename the working checkout's dist.
