import { version } from './sign.mjs';

export function releaseTitle(value) {
  const v = version(value);
  return `Bongo Cat Chat ${v}${v.includes('.dev') ? ' 개발판' : ''}`;
}

export function defaultNotes(v, sourceSha, tag, runId) {
  const control = 'misosiruda/bongo-cat-chat-release';
  return `# ${releaseTitle(v)}\n\n- 소스 커밋: ${sourceSha}\n- 승인된 후보: https://github.com/${control}/releases/tag/${tag}\n- 서명 작업: https://github.com/${control}/actions/runs/${runId}\n- 기존 공개키의 Ed25519 업데이트 서명과 모든 자산 해시를 검증했습니다.\n- Windows Authenticode 미서명 빌드입니다.\n- 실제 게임·다른 PC·장시간 실행 인수는 이 배포 작업의 검증 범위에 포함되지 않습니다.\n`;
}
