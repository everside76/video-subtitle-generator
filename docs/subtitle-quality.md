# 자막 품질 개선 근거

조사일: 2026-10-20. GitHub 별 수는 조회 화면의 근사치이며 스킬 개별 설치 수가 아니다.

| 검토 대상 | 확인한 규모 / 상태 | 적용 판단 |
| --- | --- | --- |
| [OpenAI transcribe 스킬](https://github.com/openai/skills/blob/main/skills/.curated/transcribe/SKILL.md) | 저장소 약 28.2k stars. 저장소가 deprecated 상태로 새 plugins 저장소를 안내함 | 결과 텍스트와 구간 경계를 함께 검증하는 절차 참고. 클라우드 API 전용 실행기는 로컬 앱에 추가하지 않음 |
| [ThePlasmak faster-whisper 스킬](https://github.com/ThePlasmak/faster-whisper/blob/master/SKILL.md) | 저장소 11 stars. 대중적인 스킬이라고 단정할 근거는 부족함 | VAD, temperature=0, 이전 텍스트 조건 해제, 단어 시간 정보와 무음 환각 옵션을 공식 구현과 대조해 반영 |
| [SYSTRAN faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 약 26k stars. 스킬이 아닌 인식 엔진 원본 | 공통 Silero VAD, 16kHz float32 입력, 단어 확률과 세그먼트 점수의 실제 API 확인 |
| [OpenAI Whisper 구현](https://github.com/openai/whisper/blob/main/whisper/transcribe.py) | 원본 구현 | beam search, 무음 확률과 logprob의 결합 조건, hallucination_silence_threshold 확인 |

외부 스킬 전체를 실행하거나 설치하지 않고 검증한 지침을 앱 코드에 적용했다. 스킬의 예시 옵션을 그대로 복사하지 않는다. 예를 들어 no_speech_threshold를 0.8로 높이면 무음 판정이 더 엄격해지는 것이 아니라 해당 조건을 충족하는 구간이 줄어든다. 실제 발화일 수 있는 '감사합니다' 같은 문구를 블랙리스트로 삭제하지 않는다.

## 처리 과정

1. 원본 16kHz 오디오에서 Silero로 발화를 찾는다. 음량만으로 작은 목소리를 버리지 않는다.
2. 시작·중간·끝의 긴 무음을 제외한 오디오만 각 인식 엔진에 전달한다. 발화가 없으면 모델을 로드하지 않는다.
3. 인식 신뢰도와 무음/반복 근거를 함께 검사한다. 단어 시각을 원본 영상 시간으로 복원한다.
4. 서로 다른 발화 구간의 단어를 한 자막으로 합치지 않는다. 최소 표시 시간보다 발화 경계가 우선한다.

발화 경계 손실을 줄이기 위해 VAD 경계 양쪽에 100ms 여유를 둔다. 배경음악·잡음과 발화를 구분하는 모델 판단에는 오차가 있으므로 모든 영상의 환각 제거 또는 전반적인 인식률 향상을 수치로 보장하지 않는다. 실사용 영상의 기준 전사문과 비교해야 정확도 개선 폭을 측정할 수 있다.

## 검증

`python/.venv/Scripts/python.exe -m pytest python/tests -q`

무음·낮은 잡음·단일 음에 대한 실제 VAD 검사, 모든 엔진의 무음 우회 방지, 원본 시간축 복원, 짧은 무음과 긴 무음, 경계에 걸친 단어, 유효하지 않은 시각, 실제 발화 문구 보존을 검사한다.

2026-10-20 로컬 검증: Python 테스트 61개 통과. Windows 합성 음성에 앞 3초·중간 8초·뒤 5초 무음을 넣은 한국어(faster-whisper large-v3)와 영어(OpenAI Whisper base, CrisperWhisper large) 샘플에서 두 발화 모두 인식하고 긴 무음에는 자막을 표시하지 않음을 새 엔진 v3 실행 파일과 CUDA로 확인했다. 완전 무음 입력은 세 엔진 모두 종료 코드 1과 무발화 안내를 반환하며 SRT를 생성하지 않았다. 이 결과는 합성 샘플 검사이며 실사용 영상의 인식률 벤치마크는 아니다.
