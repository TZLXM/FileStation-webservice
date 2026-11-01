import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function resolveCandidateSource({ selectedSha, requestedSha, checkedOutSha }) {
  if (requestedSha && requestedSha !== selectedSha) throw new Error('candidate source must match the selected ref');
  const source = requestedSha || selectedSha;
  if (!/^[a-f0-9]{40}$/.test(source ?? '')) throw new Error('candidate source must be an exact commit');
  if (source !== checkedOutSha) throw new Error('candidate checkout differs from resolved source');
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(resolveCandidateSource({ selectedSha: process.env.RUN_SOURCE, requestedSha: process.env.REQUESTED_SOURCE, checkedOutSha: process.argv[2] }) + '\n');
}
