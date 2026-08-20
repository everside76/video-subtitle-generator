# CrisperWhisper 2.0 엔진 지원 설계 (v1.8.0)

날짜: 2026-08-20
상태: 승인됨 (자율 세션 — 사용자 지시: "크리스피위스퍼 2.0 사용할 수 있게 업데이트")

## 목표

세 번째 음성 인식 엔진으로 CrisperWhisper 2.0(nyralabs)을 추가한다.
핵심 가치: 무음 구간으로 번지지 않는 정밀 단어 타임스탬프(읽기 음성 ~30ms 오차) —
v1.6.0의 "무음 자막 금지" 요구사항과 직결. 정제(intended)/축어(verbatim) 모드 지원.

## 조사로 확정된 사실

- 패키지: `crisperwhisper==2.0.2` (PyPI, 2026-08-06). Python ≥3.10, **프로젝트 venv(3.13.14)에 설치 확인 완료**.
- 백엔드 2종: `[ct2]`(CTranslate2 포크 `ctranslate2-crisperwhisper`, **Linux x86_64 전용 휠**,
  faster-whisper와 동시 설치 금지 명시) / `[transformers]`(torch — **Windows 공식 경로**).
  → **transformers 백엔드 채택.** torch 2.8.0+cu128이 이미 엔진에 번들되어 GPU 가속 그대로 사용.
- 모델: `nyralabs/CrisperWhisper2.0_{large|turbo|medium|small}` (+`_pro`는 상업 라이선스 전용).
  large = safetensors 3.09GB (bf16). 생성자에 크기 축약형("large" 등) 직접 전달 가능(`resolve_model_id`).
- API (설치본 소스로 검증):
  - `CrisperWhisperModel(model, backend=, compute_type="float16", device="auto", ...)`
    — device "auto"→`cuda` if available; compute_type `float32`는 CPU용.
  - `model.transcribe(audio, language="en", mode="verbatim"|"intended", word_timestamps=True, ...)`
    — **언어 자동 감지 없음** (language 기본 "en", 검증 리스트 없이 Whisper 언어 토큰으로 사용).
    30초 초과 롱폼은 continuation 전략으로 자동 처리. VAD 없음(모델 특성상 불필요).
  - 결과 `TranscriptionResult`: `.text`, `.language`, `.words: list[WordTimestamp(word,start,end)]`
    (공개 결과에서 start/end는 float), `.chunks`. **세그먼트 구조 없음(평면 단어 리스트)**.
- 라이선스: 추론 코드 MIT, **모델 가중치는 Nyra Health 비상업 연구 라이선스** (상업 사용은 별도 계약).
- 모델 다운로드: HF Hub 표준 캐시(`~/.cache/huggingface`). 진행률 콜백 없음.

## 대안 비교

| 방안 | 판정 |
|---|---|
| A. 공식 패키지 + transformers 백엔드 | **채택** — Windows 공식 지원, 모드/롱폼/환각 억제 전부 제공, torch 번들 재사용 |
| B. `[ct2]` 포크 백엔드 | 탈락 — Linux 전용 휠, 기존 ctranslate2/faster-whisper와 충돌 |
| C. 수동 CT2 변환 + faster-whisper 로드 | 탈락 — 비공식, 모드 프롬프트·타임스탬프 추출 로직 재현 불가 위험 |

## 설계

### 파이프라인 (python/process_video.py)
- `--engine`에 `crisperwhisper` 추가, `--cw-mode {intended,verbatim}` 신설 (기본 **intended** — 자막 가독성).
- `--model` 선택지에 `large`, `turbo` 추가. 엔진별 정규화:
  CW 경로 `large-v3→large, base/tiny→small`; whisper 경로 `large/turbo→large-v3`.
- `_transcribe_crisperwhisper()`: openai-whisper 경로와 같은 torch 기반 디바이스 감지,
  GPU 실패 시 VRAM 해제 후 CPU 재시도(기존 패턴). GPU=float16, CPU=float32.
- `language == "auto"` → 경고 후 `"en"` 폴백 (UI에서도 차단).
- 결과 매핑 `cw_words_to_segments()`: 평면 단어 → **세그먼트 1개** `{start,end,text,words}`.
  기존 `subtitle_postprocess.postprocess()`가 단어 무음 간격(0.6s) 기준 분할을 전담하므로 충분.
  타임스탬프 전부 None이면 빈 리스트(상위에서 오류 처리), 일부 None은 후처리 보간에 위임.
- 최초 다운로드 UX: `snapshot_download` 사전 실행 + 캐시 디렉토리 크기 폴링 스레드로
  `"모델 다운로드 중 (최초 1회)... X.XX GB"` 진행 보고. 실패 시 경고만 하고 로드에 위임(오프라인 캐시 대응).

### UI (renderer)
- 엔진 셀렉트에 "CrisperWhisper 2.0 (정밀 타임스탬프)" 추가.
- 모델 셀렉트를 엔진별 동적 구성 (CW: large 기본/turbo/medium/small ↔ Whisper: tiny~large-v3).
  모델 선택은 엔진별 localStorage 키(`setting:model-select@<engine>`)로 저장.
- CW 선택 시에만 "전사 모드" 셀렉트 표시 (정제 기본/축어).
- CW 선택 시 언어 "자동 감지" 옵션 비활성화, auto였다면 en으로 전환.
- `options.cwMode` → `--cw-mode` 인자 전달 (subtitle-operations.js).

### 엔진 v3 (재빌드 필요)
- 근거: 현 engine-v2 번들에 transformers/accelerate/soundfile/soxr/crisperwhisper 없음
  (v1.6.1에서 transformers 제거됨). 모델 가중치는 번들하지 않음(런타임 HF 캐시 다운로드) → 번들 증가 수백 MB 수준.
- `requirements.txt`: `crisperwhisper[transformers]>=2.0.2` 추가.
- `process_video.spec`: collect_all(crisperwhisper/transformers/tokenizers/accelerate/soundfile/soxr)
  + copy_metadata(transformers 등 — PyInstaller 메타데이터 함정 대응) + excludes(whisperx, pytorch_lightning 등 venv 잔재).
- `engine-manager.js` `ENGINE_VERSION = 3`.
- 신규 `scripts/build-engine-release.ps1`: PyInstaller 빌드 → ffmpeg 포함 스테이징 → zip →
  1.9GB 파트 분할 → SHA256 → `engine-manifest.json` 생성 (기존 수동 릴리스 패키징의 재현 가능화).
- **릴리스 순서(중요)**: GitHub `engine-v3` 태그에 파트+매니페스트 업로드가 **앱 v1.8.0 릴리스보다 먼저**여야 함.
  (버전 범프된 앱은 engine-v3만 찾음.) 업로드는 이 작업 범위 밖 — 사용자 승인 후 진행.

### 검증
- 단위: `cw_words_to_segments`/`cw_normalize_model` pytest (+기존 17건 회귀).
- E2E: Windows SAPI TTS로 영어 음성 생성 → ffmpeg로 mp4 합성 →
  `process_video.py --engine crisperwhisper` 실제 GPU(RTX 5060) 실행 → SRT 검증.
- 엔진 빌드 스모크: 리빌드된 exe를 `VSG_SCRIPTS_DIR`로 실행해 동일 E2E 통과 확인, dev `bin/` 갱신.

### 범위 제외 (YAGNI)
- hotwords/speculative decoding/verbatimize (Pro 모델·CT2 전용 기능 포함) — 노출하지 않음.
- 언어 자동 감지를 위한 별도 감지 모델 로드 — 하지 않음(en 폴백).
- 앱/엔진 릴리스 업로드 — 사용자 결정 사항.

### 라이선스 고지
CHANGELOG와 엔진 설치 안내에 모델 가중치 비상업 연구 라이선스 명시.
