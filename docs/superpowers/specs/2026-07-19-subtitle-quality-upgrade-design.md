# 자막 생성 품질 업그레이드 설계 (v1.4.0)

날짜: 2026-07-19
상태: 승인됨

## 목표

1. 음성 인식 품질 향상 (환각 억제, 언어 명시 지정)
2. 말이 없는 구간에 자막이 표시되지 않도록 정밀 타임스탬프 + 후처리 도입

## 대상 환경

- Windows 11, Electron + Python(PyInstaller exe) 구조
- GPU: NVIDIA RTX 5060 Laptop 8GB (Blackwell, sm_120) → PyTorch cu128 빌드 필수
- 지원 언어: 한국어, 영어, 일본어, 중국어 (+ 자동 감지)

## 파이프라인 (python/process_video.py)

기존 `추출 → 인식 → SRT` 를 `추출 → 인식 → 정렬 → 후처리 → SRT` 로 확장.

### 인식 (faster-whisper, 튜닝)

- `condition_on_previous_text=False` — 환각 전파 차단
- `language` — 사용자가 지정한 언어 (auto일 때만 자동 감지)
- `word_timestamps=True` — 정렬 실패 시 폴백용 단어 타임스탬프
- VAD 튜닝: `vad_filter=True`, `min_silence_duration_ms=500`, `speech_pad_ms=200`
- 환각 필터: `log_prob_threshold`, `no_speech_threshold`, `compression_ratio_threshold` 기본 활성
- CUDA 시 compute_type `int8_float16` (8GB VRAM 안전), CPU 시 `int8`
- openai-whisper 엔진도 유지 (`word_timestamps=True` 추가)

### 정렬 (신규: whisperx.align)

- 인식 세그먼트 + 오디오를 wav2vec2 강제 정렬에 통과 → 음소 수준 단어 타임스탬프
- 언어별 정렬 모델은 whisperx 기본 매핑 사용 (ko/en/ja/zh 모두 존재), 첫 사용 시 자동 다운로드 + 진행률 보고
- VRAM 관리: 인식 모델 해제 후 정렬 모델 로드 (순차 사용)
- 실패(모델 없음/OOM/torch GPU 미지원) 시 faster-whisper 단어 타임스탬프로 폴백, 경고 보고. 파이프라인은 절대 중단하지 않음
- torch가 CUDA를 못 잡으면 정렬만 CPU로 수행

### 후처리 (신규 모듈: python/subtitle_postprocess.py, 순수 함수)

표준 방송 자막 규칙 기반:

- 단어 간 무음 0.6초 이상 → 자막 분할 (무음 구간 자막 미표시의 핵심)
- 자막 시작/끝을 실제 첫/마지막 단어 시각으로 트리밍
- 자막당 최대 6초 (초과 시 가장 가까운 단어 갭에서 분할)
- 최소 표시 0.8초, 짧은 조각은 인접 자막과 병합
- 줄바꿈: CJK 한 줄 약 20자, 라틴 42자, 최대 2줄
- 정렬된 단어가 없는 세그먼트(환각 의심) 제거

### CLI 변경

- `--language {auto,ko,en,ja,zh}` 추가 (기본 auto)
- 진행률 보고에 `aligning` 단계 추가

## UI (Electron renderer)

- 설정 패널에 언어 선택 드롭다운 추가 (자동/한국어/영어/일본어/중국어)
- 엔진/모델/디바이스/언어 설정을 localStorage에 저장, 최근 설정값이 다음 실행 기본값
- 진행 단계 표시에 "정렬" 단계 추가
- CHANGELOG에 v1.4.0 항목 추가

## 의존성·빌드

- `python/requirements.txt`: whisperx, torch(cu128 인덱스) 추가
- PyInstaller 번들 크기 수 GB 증가 허용, 빌드 스크립트에 cu128 인덱스 명시

## 오류 처리

- 정렬 단계의 모든 실패는 폴백 후 경고 — 자막은 항상 생성
- 언어 auto + 감지 확률 낮음 → 경고 메시지 보고

## 테스트

- 후처리 모듈 단위 테스트 (분할/병합/트리밍/줄바꿈 케이스)
- 실제 영상으로 E2E 수동 검증 (무음 구간 자막 소멸 확인)
