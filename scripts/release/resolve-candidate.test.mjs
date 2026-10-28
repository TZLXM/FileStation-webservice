import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCandidateSource } from './resolve-candidate.mjs';
import { verifyAuthenticatedCandidate } from './verify-candidate.mjs';

test('dispatch selected ref A rejects explicit B before candidate promotion', async () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  assert.throws(() => resolveCandidateSource({ selectedSha: a, requestedSha: b, checkedOutSha: b }), /selected ref/);
  assert.throws(() => resolveCandidateSource({ selectedSha: a, checkedOutSha: b }), /checkout/);
  const source = resolveCandidateSource({ selectedSha: a, requestedSha: a, checkedOutSha: a });
  const { createHash } = await import('node:crypto');
  const artifacts = ['linux-x64', 'windows-x64'].map(platform => {
    const bytes = Buffer.from(platform);
    return { platform, filename: `filestation-v0.2.5-${platform === 'linux-x64' ? 'linux-x64.tar.gz' : 'win-x64.zip'}`, archive_size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const evidence = { candidate: { sourceCommit: source, runId: '123', platformDigests: Object.fromEntries(artifacts.map(item => [item.platform, 'sha256:' + item.sha256])) } };
  const provider = {
    getRun: async () => ({ id: 123, repository: { full_name: 'example/repo' }, head_repository: { full_name: 'example/repo' }, path: '.github/workflows/release-candidate.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: a }),
    getArtifact: async name => {
      if (name.endsWith('-candidate-evidence')) return { 'release-candidate.json': Buffer.from(JSON.stringify({ schemaVersion: 1, version: '0.2.5', candidate: evidence.candidate, status: 'unsigned-candidate-pending-human-acceptance' })) };
      const item = artifacts.find(item => name.endsWith(item.platform));
      return { [item.filename]: Buffer.from(item.platform), [`artifact-metadata-${item.platform}.json`]: Buffer.from(JSON.stringify(item)) };
    },
  };
  const verify = () => verifyAuthenticatedCandidate({ repository: 'example/repo', version: '0.2.5', evidence, rebuiltArtifacts: artifacts, provider });
  assert.equal((await verify()).sourceCommit, a);
  evidence.candidate.sourceCommit = b;
  await assert.rejects(verify(), /source identity mismatch/);
});
