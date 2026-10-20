// Used by the application repository from a pinned release-tools revision.
// All inputs and downloaded files are data; no candidate executable is launched.
import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { commit, version, newer, verifyApproved, fileDigest, assetNames, REPOSITORY } from './sign.mjs';
import { publishRelease, releaseClient } from './publish-release.mjs';

const CONTROL = 'misosiruda/bongo-cat-chat-release';
const tag = process.env.CANDIDATE_TAG;
const match = /^approved-v([0-9]+\.[0-9]+\.[0-9]+(?:\.dev[0-9]+)?)-([1-9][0-9]*)-([1-9][0-9]*)$/.exec(tag ?? '');
if (!match) throw Error('Invalid approved candidate tag');
const v = version(match[1]);
async function api(repo, path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {...options, headers: {'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${process.env.GH_TOKEN}`, ...(options.headers ?? {})}});
  if (!response.ok) throw Error(`GitHub API failure: ${response.status}`);
  return response.json();
}
const candidate = await api(CONTROL, `releases/tags/${tag}`);
const signerSha = commit(candidate.target_commitish);
if (candidate.draft || !candidate.prerelease || candidate.tag_name !== tag) throw Error('Not an approved staging release');
const run = await api(CONTROL, `actions/runs/${match[2]}/attempts/${match[3]}`);
if (run.conclusion !== 'success' || run.status !== 'completed' || run.head_sha !== signerSha || run.head_branch !== 'main' || run.event !== 'workflow_dispatch' || run.path !== '.github/workflows/release.yml') throw Error('Signing workflow identity or result mismatch');
const expectedNames = [...assetNames(v), 'update-manifest.sig', 'release-approval.json', 'release-approval.sig', 'SHA256SUMS.txt'].sort();
if (candidate.assets.map(a => a.name).sort().join() !== expectedNames.join() || candidate.assets.some(a => a.state !== 'uploaded' || a.size > 2147483648 || (a.name.endsWith('.sig') && a.size !== 64) || (['release-approval.json', 'update-manifest.json', 'SHA256SUMS.txt'].includes(a.name) && a.size > 16384)) || candidate.assets.reduce((sum, a) => sum + a.size, 0) > 4294967296) throw Error('Unexpected candidate assets');
await mkdir('approved-assets');
execFileSync('gh', ['release', 'download', tag, '--repo', CONTROL, '--dir', 'approved-assets'], {stdio: 'inherit'});
const receiptBytes = await readFile('approved-assets/release-approval.json');
if (receiptBytes.length > 16384) throw Error('Oversized approval');
const receipt = JSON.parse(receiptBytes);
const expected = {version: v, source_sha: commit(receipt.source_sha), signer_sha: signerSha, run_id: match[2], run_attempt: match[3]};
await verifyApproved('approved-assets', expected);
const comparison = await api(REPOSITORY, `compare/${expected.source_sha}...main`);
if (!['identical', 'ahead'].includes(comparison.status)) throw Error('Approved source is not on application main');
const latest = await api(REPOSITORY, 'releases/latest');
if (!newer(v, latest.tag_name.slice(1))) throw Error('Published version cannot be replaced or downgraded');
const notes = `# Bongo Cat Chat ${v} 개발판\n\n- 소스 커밋: ${expected.source_sha}\n- 승인된 후보: https://github.com/${CONTROL}/releases/tag/${tag}\n- 서명 작업: https://github.com/${CONTROL}/actions/runs/${match[2]}\n- 기존 공개키의 Ed25519 업데이트 서명과 모든 자산 해시를 검증했습니다.\n- Windows Authenticode 미서명 개발판입니다.\n- 실제 게임·다른 PC·장시간 실행 인수는 이 배포 작업의 검증 범위에 포함되지 않습니다.\n`;
if (process.env.DRY_RUN !== 'false') {
  console.log('Dry run: all signatures, file hashes and provenance verified; no release or tag created.');
} else {
  const files = {};
  for (const name of expectedNames) files[name] = await fileDigest(join('approved-assets', name));
  await publishRelease({expected, files, notes, approvedDirectory: 'approved-assets', uploadedDirectory: 'uploaded-assets'}, releaseClient(process.env.GH_TOKEN));
}
