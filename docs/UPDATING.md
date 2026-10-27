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
   `configured`, and review that change before tagging.

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
   initialized credential-free smoke database, and requests
   `/api/v1/settings/public`.
5. Compares both rebuilt SHA-256 values with the candidate evidence.
6. Renders the reviewed bilingual notes and signs the RFC 8785 canonical
   manifest only in the protected `release-signing` job.
7. Creates the GitHub Release only after all earlier checks succeed.

Until the publisher key and the pending human evidence are complete, the
intended outcome is failure before Release creation. Local tests and successful
non-signing CI do not replace hosted Windows/Linux acceptance or human review.
