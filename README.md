# Bongo Cat Chat 릴리스 제어

두 개발 PC에서 같은 GitHub Actions 작업을 요청하고, 운영 업데이트 키는 `release-signing` Environment에서 승인된 서명 작업에만 제공한다. 최종 업데이트 주소는 기존 `misosiruda/bongo-cat-chat`를 유지한다. 이 저장소의 공개 여부는 키 공개를 뜻하지 않는다. 키는 소스·artifact·로그에 포함하지 않는다.

## 배포 요청

1. 앱 버전 변경을 검토·검사한 뒤 앱 `main`에 병합한다. 앱 main의 전체 SHA와 버전을 확인한다.
2. [Request release candidate](https://github.com/misosiruda/bongo-cat-chat-release/actions/workflows/release.yml)에서 `main`, 소스 SHA, 버전을 지정한다. 현재 경로는 Windows Authenticode 미서명 개발판이며 명시적 확인이 필요하다.
3. 키 없는 Windows 실행기에서 테스트·빌드·오프라인 화면 검사를 수행한다. 별도 Ubuntu 작업이 실제 파일 해시를 요약한다.
4. 소스 diff, 빌드 결과, 파일 해시를 확인하고 `release-signing` 배포를 직접 승인한다. 승인만으로 악성 코드가 자동 탐지되는 것은 아니다.
5. 성공한 실행은 `approved-v<version>-<run-id>-<attempt>` prerelease에 서명된 자산을 보관한다. 이 위치는 기존 앱의 업데이트 피드가 아니다.
6. 앱 저장소의 `Publish approved release` 작업에 그 태그를 지정한다. 먼저 기본값인 dry run으로 검증할 수 있다. 실제 게시 선택 후 `release-publishing`을 승인하면, 서명·출처·해시를 재검증하고 앱 저장소에 새 릴리스를 게시한다.

```powershell
gh workflow run release.yml --repo misosiruda/bongo-cat-chat-release --ref main -f source_sha=<40자리-SHA> -f version=<새-버전> -F allow_unsigned_windows=true
gh workflow run publish-approved-release.yml --repo misosiruda/bongo-cat-chat --ref main -f candidate_tag=<approved-태그> -F dry_run=true
```

두 PC 어디서든 같은 명령 또는 브라우저를 사용한다. PC별 개인키·항상 켜진 상대 PC·저장소 간 장기 게시 토큰은 필요하지 않다. 앱 저장소의 게시 작업은 자기 저장소에만 유효한 `GITHUB_TOKEN`을 사용한다.

## 신뢰 경계

- 요청 단계는 현재 앱 main SHA, 소스 버전, 고정 저장소·공개키, 최신 릴리스보다 높은 버전을 검사한다.
- 빌드 작업은 운영 키와 게시 권한을 받지 않는다. 서명 작업과 다른 GitHub 호스팅 실행기를 사용하며 캐시를 공유하지 않는다.
- 서명 작업은 이 저장소의 Node 내장 모듈 기반 도구만 실행한다. 앱 저장소를 checkout/import하거나 후보 EXE를 실행하지 않는다.
- 승인 전 파일 목록 해시와 서명 시 파일 목록 해시를 비교한다. 원래 manifest 형식·Ed25519 원본 바이트 서명·공개키를 유지한다.
- 추가 `release-approval.json`은 source SHA, signer SHA, 실행 ID·attempt, 모든 설치·소스·업데이트 자산 해시를 결합한다. 별도 도메인 접두사를 서명하여 업데이트 manifest 서명과 구분한다.
- 게시기는 서명된 승인 기록, 성공한 서명 워크플로 실행, source main 포함 여부와 모든 파일을 확인한다. 기존 태그·릴리스는 교체하지 않는다. 새 draft 업로드를 다시 내려받아 검증한 뒤 공개한다. 실패한 draft/tag는 조사 후 수동 처리한다.
- 이 저장소의 main 변경도 PR·검사를 거친다. 개발 저장소 쓰기 권한을 추가한다고 서명 저장소 권한까지 부여하지 않는다.
- 단독 운영자는 요청과 수동 승인을 둘 다 할 수 있다. 이것은 두 사람의 독립 승인이 아니다. GitHub 관리자 계정 또는 신뢰된 서명 도구 침해는 잔여 위험이다. Environment Secret은 비추출형 HSM이 아니다.
- 서명은 무결성과 배포 권한을 확인한다. 코드의 악성 여부, 순정 게임·다른 PC 인수, Windows 게시자 신뢰를 보증하지 않는다. SignPath/Authenticode는 별도 작업이다.

## 기존 키 이전과 복구

`scripts/import-key.py`는 기존 DPAPI 키를 같은 Windows 사용자로 읽어 고정 공개키와 공개 dev11 서명을 대조하고, stdin으로 GitHub CLI에 넘겨 보호된 Environment Secret에 저장한다. 앱 코드 import, 평문 키 파일, 키 출력, 키 생성·교체·삭제를 하지 않는다. 신뢰된 Python 환경에서 `-I`로 실행한다.

```powershell
<신뢰된-python.exe> -I scripts/import-key.py --dpapi <기존-키.dpapi> --check-only
<신뢰된-python.exe> -I scripts/import-key.py --dpapi <기존-키.dpapi>
gh workflow run verify-key.yml --repo misosiruda/bongo-cat-chat-release --ref main
```

`Verify existing update key`는 승인 후 이미 공개된 dev11 manifest에 다시 서명하고 기존 서명과 일치하는지만 확인한다. 새 버전·태그·릴리스는 만들지 않는다.

클라우드 검증과 독립 복구용 백업 확인 전에는 양쪽 PC의 기존 키를 삭제하지 않는다. 두 PC의 기존 개발 계정 키 사본을 모두 제거한 뒤에만 로컬 키 접근까지 차단된 전환 완료로 기록한다. DPAPI 파일만 복사한 것은 다른 PC·계정에서 쓸 수 있는 복구 백업이 아니다. GitHub Secret 원문은 나중에 다시 읽을 수 없으므로 이를 유일한 복구 수단으로 삼지 않는다.

## 검증

```text
node --test
python -m unittest discover -s test
```

합성 테스트는 잘못된 키·manifest·파일 변경·버전·출처·실행 attempt·체크섬을 거부하는지 검사한다. 공개 dev11 fixture는 기존 클라이언트 공개키와 실제 공개 서명의 호환성을 검사한다. 이는 새 Windows 빌드 또는 실제 자동 업데이트 적용 검증을 대신하지 않는다.
