# Changelog

## [1.9.0] - 2026-10-20

### Added
- 자동 업데이트 상태 표시 및 수동 확인·재시작 버튼, 시작 시와 4시간마다 새 버전 확인
- 다운로드 진행률·실패 후 재시도·화면 새로 고침 후 상태 복원
- 자막 생성·번역·큐 처리·엔진 설치 중 업데이트 재시작 방지

### Fixed
- 엔진 v3 번들에서 불필요한 torchcodec을 제외해 CrisperWhisper 시작 시 AutoProcessor 로드 실패 수정
- 모든 인식 엔진에 공통 Silero VAD 적용: 발화 구간만 인식하고 원본 영상 시간으로 복원, 무음 영상은 모델 로드 없이 종료
- 무음 경계에서 단어/자막을 분리하고 최소 표시 시간 연장·병합으로 무음 구간에 자막이 남던 문제 수정
- 배치할 수 없는 단어와 무음 확률·인식 신뢰도가 함께 나쁜 결과 제거 (특정 문구를 일괄 삭제하지 않음)

### Changed
- faster-whisper와 OpenAI Whisper에 temperature=0, beam_size=5 및 무음 환각 억제 옵션 적용
- CLI 기본 모델을 앱과 동일한 large-v3로 통일

## [1.8.0] - 2026-08-20

### Added
- CrisperWhisper 2.0 엔진 (transformers 백엔드): 무음으로 번지지 않는 정밀 단어 타임스탬프(±30ms급), 정제(intended)/축어(verbatim) 전사 모드
- 엔진별 모델 목록 동적 전환 (CrisperWhisper: large/turbo/medium/small), 엔진별 모델 선택 저장
- CrisperWhisper 모델 최초 다운로드 진행률 표시 (HF 캐시, large 기준 약 3.1GB)
- 엔진 릴리스 패키징 스크립트 `scripts/build-engine-release.ps1` (파트 분할 + SHA256 매니페스트 자동 생성)
- 엔진 번들에서 빌드타임 아티팩트(torch 정적 .lib / C++ 헤더, 약 2.7GB) 제거 — 설치 후 디스크 사용량 약 29% 감소

### Changed
- 엔진 v3: crisperwhisper/transformers/tokenizers/accelerate/soundfile/soxr 번들 추가 (ENGINE_VERSION=3, 최초 실행 시 재다운로드 필요)
- CrisperWhisper 선택 시 언어 자동 감지 비활성화 (미지원 — 화면 표시만 한국어로 전환)
- 엔진 설치 성공 시 이전 버전 엔진 디렉토리 자동 정리
- setup.bat의 whisperx 잔재 제거

### Note
- CrisperWhisper 2.0 모델 가중치는 Nyra Health 비상업 연구 라이선스 (상업적 사용은 별도 계약 필요)
- 배포 순서: GitHub `engine-v3` 릴리스(파트+매니페스트) 업로드 → 앱 v1.8.0 릴리스

## [1.7.0] - 2026-07-19

### Added
- 한국어 번역 자막: 음성 언어가 한국어가 아니면 SRT를 한국어로 자동 번역 (Electron 측 처리, 엔진 변경 없음)
- 번역 모드: 한국어로 번역(기본) / 원문+한국어 / 사용 안 함 (설정 저장)
- 번역 진행률 표시, 실패 항목은 원문 유지 후 경고

## [1.6.1] - 2026-07-19

### Changed
- WhisperX 완전 제거 (align_segments.py 삭제, --align 인자/UI 옵션/정렬 단계 제거)
- requirements.txt와 PyInstaller spec에서 whisperx/transformers/scipy/sklearn 수집 제거 (다음 엔진 빌드부터 번들 대폭 축소)
- 무음 자막 제거는 Whisper word_timestamps + subtitle_postprocess.py가 전담

## [1.6.0] - 2026-07-19

### Changed
- 무음 자막 제거를 Whisper 단어 타임스탬프 + 후처리만으로 처리 (WhisperX 정렬 기본 비활성화)
- 정밀 정렬(WhisperX)은 설정에서 "자동" 선택 시에만 사용 (--align 인자)
- 음성 인식 GPU 실패 시 CPU 자동 재시도

### Added
- 엔진 stderr를 engine.log로 저장, 프로세스 실패 시 마지막 오류 줄을 UI에 표시

## [1.5.3] - 2026-07-19

### Fixed
- GPU 메모리 부족 시 정렬: 여유 VRAM 확인 후 부족하면 즉시 CPU 전환 (OOM 대기 제거)
- PYTORCH_CUDA_ALLOC_CONF=expandable_segments로 메모리 파편화 완화
- 정렬 완료 후 GPU 메모리 즉시 반환, CPU 재시도 전 캐시 정리

## [1.5.2] - 2026-07-19

### Fixed
- 엔진 다운로드를 Chromium 네트워크 스택(net.fetch)으로 전환
- 해시 불일치 시 기대/실제 해시 진단 정보 표시

## [1.5.1] - 2026-07-19

### Fixed
- 엔진 다운로드 무결성 검증(파트별/병합본 SHA256) — 손상 다운로드로 "Invalid central directory signature" 압축 해제 실패하던 문제
- 손상 파트만 최대 3회 재다운로드, 검증된 파트는 재사용 (이어받기 효과)
- tar 압축 해제 실패 시 PowerShell Expand-Archive로 자동 폴백

## [1.5.0] - 2026-07-19

### Added
- 앱 자동 업데이트: electron-updater + GitHub Releases (새 버전 자동 다운로드/적용)
- 엔진 분리 설치: 6GB급 음성 인식 엔진을 앱 설치본에서 분리, 최초 실행 시 1회 자동 다운로드 (`%LOCALAPPDATA%\VideoSubtitleGenerator\engine-v2`)
- 엔진 로더 구조: PyInstaller exe는 얇은 로더, 파이프라인 스크립트(.py)는 앱 리소스에서 로드 — 파이프라인 수정 시 엔진 재빌드 불필요, 앱 업데이트만으로 반영

### Fixed
- 설치본(PyInstaller)에서 WhisperX 정렬이 실패하던 문제: scipy 서브모듈 및 torchcodec/torch dist-info 메타데이터 번들 누락
- 한글 Windows 콘솔(cp949)에서 유니코드 메시지 출력 시 UnicodeEncodeError로 크래시하던 문제 (stdout UTF-8 강제)
- 파이프라인 오류가 트레이스백 없이 조용히 종료되던 문제 (os._exit가 예외를 은폐)
- frozen 환경 multiprocessing 안전장치(freeze_support) 추가

## [1.4.0] - 2026-07-19

### Added
- WhisperX 강제 정렬: wav2vec2 기반 단어 단위 정밀 타임스탬프 (한/영/일/중)
- 자막 후처리 모듈 (`python/subtitle_postprocess.py`): 무음 구간(0.6초 이상)에서 자막 자동 분할 — 말이 없을 때 자막 미표시
- 자막 표시 규칙: 최대 6초, 최소 0.8초, 자동 줄바꿈 (CJK 20자/라틴 42자, 최대 2줄)
- 음성 언어 선택 UI (한국어/영어/일본어/중국어/자동 감지), `--language` CLI 인자
- 설정값 저장(localStorage): 마지막 사용 설정이 다음 실행 시 기본값
- 진행 단계에 "타임스탬프 정렬" 표시 추가
- 후처리 단위 테스트 (pytest, 17건)

### Changed
- 환각(hallucination) 억제: `condition_on_previous_text=False` 및 품질 임계값 필터 적용
- GPU에서 large-v3를 int8_float16 양자화로 로드 (8GB VRAM 대응)
- VAD 파라미터 튜닝 (최소 무음 500ms, 발화 패딩 200ms)
- PyTorch cu128 빌드 사용 (RTX 50xx Blackwell GPU 지원)
- 정렬 실패 시 Whisper 단어 타임스탬프로 자동 폴백 (GPU 실패 시 CPU 재시도)

## [1.3.0] - 2026-03-25

### Added
- 작업 리스트(큐) 기능: 여러 비디오 파일을 추가하고 순차적으로 자동 처리
- 왼쪽 사이드바에 작업 목록 패널 상시 표시
- 복수 파일 드래그&드롭 및 다중 선택 지원
- 각 파일별 상태 표시 (대기/처리중/완료/오류)
- 전체 시작/중지 버튼으로 큐 일괄 제어
- 완료된 항목 클릭 시 해당 SRT 결과 조회/저장
- 헤더에 앱 버전 표시 및 업데이트 이력 보기 기능

## [1.2.0] - 2026-03-25

### Added
- Whisper 엔진 선택 기능 (faster-whisper / openai-whisper)
- faster-whisper (CTranslate2): 기본 엔진, 최고 GPU 성능
- openai-whisper (PyTorch): 원본 엔진, 넓은 호환성

### Changed
- 기본 모델을 base에서 large-v3 (최고 정확도)로 변경
- Python 엔진에 --engine 인자 추가
- PyInstaller 번들에 whisper, tiktoken 패키지 추가

## [1.1.0] - 2026-03-25

### Fixed
- 설치 버전 실행 시 멈춤 오류 해결
- 스플래시 윈도우에서 transparent: true 제거 (Windows 렌더링 멈춤 방지)
- ready-to-show 미발생 시 5초 안전 타임아웃 추가
- IPC 콜백에 윈도우 파괴 상태 체크 추가 (크래시 방지)

### Changed
- 스플래시 윈도우 배경을 투명에서 solid (#1a1a2e)로 변경

## [1.0.0] - 2026-03-25

### Added
- 최초 릴리스
- 비디오 파일에서 자동 자막(SRT) 생성
- faster-whisper (CTranslate2) 기반 음성 인식
- GPU(CUDA) / CPU 자동 감지 및 선택
- 드래그&드롭 비디오 파일 입력
- Whisper 모델 선택 (tiny ~ large-v3)
- 실시간 진행률 표시 (오디오 추출 → 음성 인식 → SRT 생성)
- SRT 파일 미리보기 및 다른 이름으로 저장
- ffmpeg 번들 포함 (별도 설치 불필요)
- NSIS 설치 프로그램 빌드 지원
