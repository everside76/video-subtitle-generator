# Windows 자동 업데이트 배포

설치된 앱은 GitHub의 `everside76/video-subtitle-generator` 정식 릴리스를 시작 5초 후와 4시간마다 확인한다. 새 버전을 자동 다운로드하고 종료할 때 적용한다. 화면의 '재시작하여 업데이트'로 즉시 적용할 수도 있다. 자막 생성·번역·큐 처리·엔진 설치 중에는 해당 재시작을 차단한다. 개발 실행에서는 다운로드하지 않는다.

## 빌드

1. package.json과 package-lock.json의 버전을 함께 올리고 변경 이력을 갱신한다.
2. `npm test` 및 Python 테스트를 실행한다.
3. `npm run build -- --publish never`로 NSIS 설치 프로그램을 만든다.
4. `dist/Video-Subtitle-Generator-Setup.exe`, 대응 `.blockmap`, `latest.yml`을 **같은 정식 GitHub 릴리스**에 게시한다. `latest.yml`의 버전·파일명·SHA512가 설치본과 일치해야 한다.
5. 이전 버전이 설치된 Windows에서 새 버전 감지 → 다운로드 → 재시작 → 버전 변경을 확인한다.

로컬 빌드만으로 기존 설치 사용자에게 업데이트가 전달되지는 않는다. 릴리스 게시가 별도로 필요하다. 앱이 요구하는 `engine-v3` 엔진 릴리스(분할 파일 및 매니페스트)도 먼저 제공돼야 신규 설치가 정상 동작한다. 파이프라인 `.py` 파일은 앱의 `engine-scripts`에 포함되므로 이번 자막 로직 수정에는 엔진 재빌드가 필요 없다.

구현은 이 프로젝트에 설치된 electron-updater 6.x API를 사용한다. 이후 7.x로 올릴 때는 자동 설치 옵션 변경을 별도로 검토한다.
