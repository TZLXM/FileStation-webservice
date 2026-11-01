import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseStableSemver, ReleaseValidationError } from "./validate-version.mjs";
const exec = promisify(execFile);
function fail(message) { throw new ReleaseValidationError(message); }
function json(files, name) {
  if (!Buffer.isBuffer(files?.[name])) fail("candidate provenance/metadata missing: " + name);
  return JSON.parse(files[name].toString("utf8"));
}
export async function verifyAuthenticatedCandidate({ repository, version, evidence, rebuiltArtifacts, provider }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "")) fail("expected candidate repository is required");
  parseStableSemver(version);
  const candidate = evidence?.candidate;
  if (!/^[1-9][0-9]*$/u.test(candidate?.runId ?? "") || typeof candidate?.runId !== "string" || !/^[0-9a-f]{40}$/u.test(candidate?.sourceCommit ?? "")) fail("invalid candidate run/source");
  const run = await provider.getRun();
  if (String(run.id) !== candidate.runId ||
      run.repository?.full_name !== repository ||
      run.head_repository?.full_name !== repository ||
      run.path !== ".github/workflows/release-candidate.yml" ||
      !["pull_request", "workflow_dispatch"].includes(run.event) ||
      run.status !== "completed" || run.conclusion !== "success" ||
      run.head_sha !== candidate.sourceCommit) {
    fail("candidate run repository/workflow/success/source identity mismatch");
  }
  const prefix = "filestation-v" + version;
  const record = json(await provider.getArtifact(prefix + "-candidate-evidence"), "release-candidate.json");
  if (record.schemaVersion !== 1 || record.version !== version ||
      record.status !== "unsigned-candidate-pending-human-acceptance" ||
      record.candidate?.sourceCommit !== candidate.sourceCommit ||
      record.candidate?.runId !== candidate.runId) fail("candidate provenance identity mismatch");
  if (!Array.isArray(rebuiltArtifacts) || rebuiltArtifacts.length !== 2) fail("candidate requires two rebuilt platforms");
  for (const platform of ["linux-x64", "windows-x64"]) {
    const rebuilt = rebuiltArtifacts.filter(item => item.platform === platform);
    if (rebuilt.length !== 1) fail("candidate platform missing/duplicated");
    const item = rebuilt[0];
    const filename = prefix + (platform === "linux-x64" ? "-linux-x64.tar.gz" : "-win-x64.zip");
    if (item.filename !== filename) fail("candidate archive filename mismatch");
    const files = await provider.getArtifact(prefix + "-" + platform);
    const metadata = json(files, "artifact-metadata-" + platform + ".json");
    for (const field of ["platform", "os", "arch", "filename", "url", "archive_size", "unpacked_size", "sha256", "format"]) {
      if (metadata[field] !== item[field]) fail("candidate metadata differs from rebuild: " + platform + "." + field);
    }
    const bytes = files[filename];
    if (!Buffer.isBuffer(bytes)) fail("candidate archive missing: " + filename);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== item.archive_size || digest !== item.sha256 ||
        candidate.platformDigests?.[platform] !== "sha256:" + digest ||
        record.candidate.platformDigests?.[platform] !== "sha256:" + digest) {
      fail("candidate archive digest/size does not reconcile with provenance, evidence and rebuild: " + platform);
    }
  }
  return { repository, runId: candidate.runId, sourceCommit: candidate.sourceCommit, authenticated: true };
}

// Only this production adapter accesses GitHub. Tests inject in-memory responses.
export function githubCandidateProvider({ repository, runId, token = process.env.GH_TOKEN }) {
  if (!token) fail("GH_TOKEN with actions:read is required to authenticate candidate provenance");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository ?? "") || !/^[1-9][0-9]*$/u.test(runId ?? "")) fail("invalid candidate repository/run");
  const environment = { ...process.env, GH_TOKEN: token, GH_HOST: "github.com" };
  delete environment.RELEASE_SIGNING_PRIVATE_KEY_BASE64;
  async function gh(args) {
    try {
      return (await exec("gh", args, { env: environment, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout;
    } catch {
      fail("authenticated candidate GitHub retrieval failed (missing/expired/inaccessible run or artifact)");
    }
  }
  return {
    getRun: async () => JSON.parse(await gh(["api", "--hostname", "github.com", "repos/" + repository + "/actions/runs/" + runId])),
    getArtifact: async (name) => {
      const pages = JSON.parse(await gh(["api", "--hostname", "github.com", "--paginate", "--slurp", "repos/" + repository + "/actions/runs/" + runId + "/artifacts?per_page=100"]));
      const matches = pages.flatMap(page => page.artifacts).filter(item => item.name === name);
      if (matches.length !== 1 || matches[0].expired || String(matches[0].workflow_run?.id) !== runId) fail("candidate artifact missing, expired or ambiguous: " + name);
      const directory = await mkdtemp(path.join(tmpdir(), "filestation-candidate-"));
      try {
        await gh(["run", "download", runId, "--repo", "https://github.com/" + repository, "--name", name, "--dir", directory]);
        const files = {};
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || entry.isSymbolicLink()) fail("unexpected candidate artifact member");
          files[entry.name] = await readFile(path.join(directory, entry.name));
        }
        return files;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
