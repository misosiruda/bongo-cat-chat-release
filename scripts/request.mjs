import { appendFile } from 'node:fs/promises';
import { REPOSITORY, PUBLIC_KEY, version, commit, newer } from './sign.mjs';
const sha = commit(process.env.SOURCE_SHA);
const v = version(process.env.RELEASE_VERSION);
if (process.env.ALLOW_UNSIGNED !== 'true') throw Error('Windows Authenticode unsigned development release must be explicitly acknowledged');
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, {headers: {'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${process.env.GH_TOKEN}`}});
  if (!response.ok) throw Error(`GitHub metadata request failed: ${response.status}`);
  return response.json();
}
const branch = await api('branches/main');
if (branch.commit.sha !== sha) throw Error('Select the current reviewed main SHA; arbitrary branches cannot be signed');
const release = await api('releases/latest');
if (process.env.VALIDATION_ONLY !== 'true' && !newer(v, release.tag_name.slice(1))) throw Error('Version must be newer than the currently published release');
const source = async path => Buffer.from((await api(`contents/${path}?ref=${sha}`)).content, 'base64').toString('utf8');
if (!new RegExp(`^version = "${v.replaceAll('.', '\\.')}"$`, 'm').test(await source('pyproject.toml'))) throw Error('Source version mismatch');
const config = JSON.parse(await source('src/bongo_chat/update-config.json'));
if (config.repository !== REPOSITORY || config.public_key !== PUBLIC_KEY) throw Error('Existing client trust configuration changed');
await appendFile(process.env.GITHUB_STEP_SUMMARY, `# 서명 승인 대상\n\n- 소스: https://github.com/${REPOSITORY}/commit/${sha}\n- 버전: ${v}\n- Windows Authenticode: 미서명 개발판\n- 빌드·테스트 결과와 아래 파일 해시를 확인한 뒤 release-signing을 승인합니다.\n`);
