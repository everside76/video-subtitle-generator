# Changelog

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
