# 자막 생성 품질 업그레이드 (v1.4.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** faster-whisper 인식 튜닝 + WhisperX 강제 정렬 + 자막 후처리로 인식 품질을 높이고, 무음 구간에 자막이 표시되지 않게 한다.

**Architecture:** 기존 `추출 → 인식 → SRT` 파이프라인을 `추출 → 인식(튜닝) → 정렬(whisperx.align) → 후처리(분할/트리밍/병합/줄바꿈) → SRT`로 확장. 후처리는 순수 함수 모듈로 분리해 단위 테스트. UI에 언어 선택 추가, 설정은 localStorage에 영속화.

**Tech Stack:** Python(faster-whisper, whisperx, torch cu128), Electron(vanilla JS), PyInstaller, pytest

**전제:** 스펙은 `docs/superpowers/specs/2026-07-19-subtitle-quality-upgrade-design.md`. 대상 GPU는 RTX 5060 Laptop 8GB(Blackwell) → torch는 반드시 cu128 빌드.

---

### Task 0: git 저장소 초기화

이 프로젝트는 아직 git 저장소가 아니다. 커밋 추적을 위해 초기화한다. `.gitignore`는 이미 존재한다.

**Files:**
- Create: `.git/` (git init)

- [ ] **Step 1: git init 및 초기 커밋**

```powershell
cd C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator
git init
git add -A
git commit -m "chore: initial commit (v1.3.0 baseline)"
```

Expected: 커밋 성공. `git status`가 clean.
주의: `.gitignore`에 `python/.venv`, `python/venv`, `dist`, `node_modules`가 포함되어 있는지 먼저 `git status` 출력 크기로 확인하고, 누락 시 `.gitignore`에 추가 후 커밋할 것.

---

### Task 1: 의존성 설치 (whisperx + torch cu128 + pytest)

**Files:**
- Modify: `python/requirements.txt`
- Modify: `scripts/setup.bat:35-36` (검증 라인)

- [ ] **Step 1: requirements.txt 수정**

```
--extra-index-url https://download.pytorch.org/whl/cu128
faster-whisper>=1.0.0
deep-translator>=1.11.0
torch>=2.7.0
torchaudio>=2.7.0
whisperx>=3.3.0
```

- [ ] **Step 2: venv에 설치**

```powershell
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe -m pip install -r C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\requirements.txt
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe -m pip install pytest
```

Expected: 성공 설치 (수 GB 다운로드, 수 분 소요).
주의: whisperx가 faster-whisper/ctranslate2 버전을 pin해 다운그레이드를 시도할 수 있다. 설치 후 `pip check` 실행, faster-whisper import가 여전히 되는지 확인.

- [ ] **Step 3: GPU 인식 검증**

```powershell
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"
```

Expected: `2.7.x+cu128 True NVIDIA GeForce RTX 5060 Laptop GPU`
False가 나오면 cu128 빌드가 설치됐는지 (`torch.__version__`에 `+cu128`) 확인. 아니면 `pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128 --force-reinstall`.

- [ ] **Step 4: whisperx import + 언어별 정렬 모델 매핑 검증**

```powershell
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe -c "import whisperx; from whisperx.alignment import DEFAULT_ALIGN_MODELS_TORCH, DEFAULT_ALIGN_MODELS_HF; m={**DEFAULT_ALIGN_MODELS_TORCH, **DEFAULT_ALIGN_MODELS_HF}; print({k: m.get(k) for k in ['ko','en','ja','zh']})"
```

Expected: ko/en/ja/zh 모두 모델명 출력 (None 없음).
주의: whisperx 버전에 따라 모듈 경로가 `whisperx.alignment`가 아닐 수 있음. ImportError 시 `python -c "import whisperx.alignment"` 대신 `whisperx.align` 함수와 `whisperx.load_align_model` 존재만 확인해도 됨.

- [ ] **Step 5: setup.bat 검증 라인 추가**

`scripts/setup.bat`의 검증 부분(35~36행)에 추가:

```bat
python -c "import torch; print('[OK] torch', torch.__version__, 'CUDA:', torch.cuda.is_available())"
python -c "import whisperx; print('[OK] whisperx')"
```

- [ ] **Step 6: Commit**

```powershell
git add python/requirements.txt scripts/setup.bat
git commit -m "feat: add whisperx + torch cu128 dependencies"
```

---

### Task 2: 자막 후처리 모듈 (핵심 — 무음 구간 자막 제거)

순수 함수 모듈. 입력은 단어 리스트(정렬 결과), 출력은 SRT용 자막 리스트.

**Files:**
- Create: `python/subtitle_postprocess.py`
- Test: `python/tests/test_subtitle_postprocess.py`

**데이터 모델:**
- 단어: `{"word": str, "start": float, "end": float}` (start/end가 None일 수 있음 — 정렬 실패 단어)
- 자막: `{"start": float, "end": float, "text": str}` (text는 `\n` 포함 가능, 최대 2줄)

**규칙 상수:**

```python
GAP_SPLIT = 0.6        # 단어 간 무음이 이 이상이면 자막 분할
MAX_DURATION = 6.0     # 자막당 최대 표시 시간
MIN_DURATION = 0.8     # 자막당 최소 표시 시간
MERGE_GAP = 0.3        # 이 간격 이하의 인접 자막과 병합 허용
MAX_LINE_CJK = 20      # ko/ja/zh 한 줄 최대 글자 수
MAX_LINE_LATIN = 42    # 라틴계 한 줄 최대 글자 수
MAX_LINES = 2
NOSPACE_LANGS = {"ja", "zh"}   # 단어 결합 시 공백 없음
CJK_LANGS = {"ko", "ja", "zh"}
```

- [ ] **Step 1: 테스트 디렉토리 생성 및 실패하는 테스트 작성**

`python/tests/test_subtitle_postprocess.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from subtitle_postprocess import (
    fill_missing_timestamps, split_at_gaps, enforce_limits,
    join_words, wrap_lines, postprocess,
)


def w(word, start, end):
    return {"word": word, "start": start, "end": end}


# --- fill_missing_timestamps ---

def test_fill_missing_interpolates_between_neighbors():
    words = [w("a", 0.0, 0.5), w("b", None, None), w("c", 1.5, 2.0)]
    out = fill_missing_timestamps(words)
    assert out[1]["start"] == 0.5
    assert out[1]["end"] == 1.5

def test_fill_missing_at_edges_uses_neighbor():
    words = [w("a", None, None), w("b", 1.0, 2.0)]
    out = fill_missing_timestamps(words)
    assert out[0]["start"] == 1.0 and out[0]["end"] == 1.0


# --- split_at_gaps: 무음 구간 자막 제거의 핵심 ---

def test_split_at_gap_creates_two_groups():
    words = [w("안녕", 0.0, 0.5), w("하세요", 0.5, 1.0),
             w("반갑", 3.0, 3.5), w("습니다", 3.5, 4.0)]
    groups = split_at_gaps(words)
    assert len(groups) == 2
    # 첫 자막은 실제 발화 종료(1.0)에서 끝나야 함 — 무음(1.0~3.0)에 자막 없음
    assert groups[0][-1]["end"] == 1.0
    assert groups[1][0]["start"] == 3.0

def test_no_split_below_gap_threshold():
    words = [w("a", 0.0, 0.5), w("b", 0.9, 1.4)]  # 갭 0.4 < 0.6
    assert len(split_at_gaps(words)) == 1


# --- enforce_limits: 최대/최소 표시 시간 ---

def test_long_group_split_at_max_duration():
    # 8초짜리 그룹 → 2개로 분할
    words = [w(f"w{i}", i * 1.0, i * 1.0 + 0.9) for i in range(8)]
    groups = enforce_limits([words])
    assert len(groups) >= 2
    for g in groups:
        assert g[-1]["end"] - g[0]["start"] <= 6.0 + 1e-6

def test_short_group_merged_with_adjacent():
    g1 = [w("a", 0.0, 0.3)]          # 0.3초 — 너무 짧음
    g2 = [w("b", 0.5, 2.0)]          # 갭 0.2 < MERGE_GAP
    groups = enforce_limits([g1, g2])
    assert len(groups) == 1

def test_short_isolated_group_extended():
    g1 = [w("a", 0.0, 0.3)]          # 짧지만 병합할 이웃 없음
    groups = enforce_limits([g1])
    sub_end = groups[0][-1]["end"]
    assert sub_end - groups[0][0]["start"] >= 0.3  # 원본 유지 (연장은 postprocess에서)


# --- join_words / wrap_lines ---

def test_join_korean_with_spaces():
    assert join_words([w("안녕", 0, 1), w("하세요", 1, 2)], "ko") == "안녕 하세요"

def test_join_japanese_without_spaces():
    assert join_words([w("こん", 0, 1), w("にちは", 1, 2)], "ja") == "こんにちは"

def test_wrap_lines_cjk_two_lines():
    text = "가" * 30  # 20자 초과 → 2줄
    wrapped = wrap_lines(text, "ko")
    lines = wrapped.split("\n")
    assert len(lines) == 2
    assert all(len(l) <= 20 for l in lines)

def test_wrap_lines_latin_breaks_at_word_boundary():
    text = "the quick brown fox jumps over the lazy dog again and again"
    wrapped = wrap_lines(text, "en")
    for line in wrapped.split("\n"):
        assert len(line) <= 42


# --- postprocess 통합 ---

def test_postprocess_end_to_end_silence_gap():
    segments = [{
        "start": 0.0, "end": 5.0, "text": "안녕하세요 반갑습니다",
        "words": [w("안녕하세요", 0.0, 1.0), w("반갑습니다", 4.0, 5.0)],
    }]
    subs = postprocess(segments, "ko")
    assert len(subs) == 2
    assert subs[0]["end"] == 1.0      # 무음 시작 전에 자막 종료
    assert subs[1]["start"] == 4.0

def test_postprocess_drops_segment_without_words():
    segments = [{"start": 0.0, "end": 2.0, "text": "환각텍스트", "words": []}]
    assert postprocess(segments, "ko") == []

def test_postprocess_min_duration_extension():
    segments = [{
        "start": 0.0, "end": 0.4, "text": "네",
        "words": [w("네", 0.0, 0.4)],
    }]
    subs = postprocess(segments, "ko")
    assert subs[0]["end"] - subs[0]["start"] >= 0.8

def test_postprocess_fallback_segment_without_word_field():
    # 정렬/word_timestamps 모두 실패한 세그먼트: words 키 자체가 없음 → 세그먼트 시각 그대로 사용
    segments = [{"start": 0.0, "end": 2.0, "text": "hello world"}]
    subs = postprocess(segments, "en")
    assert len(subs) == 1
    assert subs[0]["text"] == "hello world"
```

- [ ] **Step 2: 테스트 실패 확인**

```powershell
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe -m pytest C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\tests\test_subtitle_postprocess.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'subtitle_postprocess'`

- [ ] **Step 3: 구현**

`python/subtitle_postprocess.py`:

```python
"""자막 후처리: 정렬된 단어 타임스탬프 → 방송 규칙 기반 자막 목록.

순수 함수만 포함. 입력 단어: {"word", "start", "end"} (start/end None 허용).
출력 자막: {"start", "end", "text"} (text 최대 2줄, \n 구분).
"""

GAP_SPLIT = 0.6
MAX_DURATION = 6.0
MIN_DURATION = 0.8
MERGE_GAP = 0.3
MAX_LINE_CJK = 20
MAX_LINE_LATIN = 42
MAX_LINES = 2
NOSPACE_LANGS = {"ja", "zh"}
CJK_LANGS = {"ko", "ja", "zh"}


def fill_missing_timestamps(words):
    """start/end가 None인 단어를 이웃 단어 시각으로 보간."""
    out = [dict(w) for w in words]
    for i, w in enumerate(out):
        if w["start"] is None or w["end"] is None:
            prev_end = None
            for j in range(i - 1, -1, -1):
                if out[j]["end"] is not None:
                    prev_end = out[j]["end"]
                    break
            next_start = None
            for j in range(i + 1, len(out)):
                if out[j]["start"] is not None:
                    next_start = out[j]["start"]
                    break
            if prev_end is None and next_start is None:
                w["start"] = w["start"] if w["start"] is not None else 0.0
                w["end"] = w["end"] if w["end"] is not None else w["start"]
            else:
                w["start"] = prev_end if prev_end is not None else next_start
                w["end"] = next_start if next_start is not None else prev_end
    return out


def split_at_gaps(words, gap=GAP_SPLIT):
    """단어 간 무음이 gap 이상이면 자막 그룹 분할."""
    groups = []
    current = []
    for w in words:
        if current and w["start"] - current[-1]["end"] >= gap:
            groups.append(current)
            current = []
        current.append(w)
    if current:
        groups.append(current)
    return groups


def _split_group_by_duration(group, max_duration=MAX_DURATION):
    """그룹이 max_duration 초과 시 중앙에 가장 가까운 단어 갭에서 재귀 분할."""
    if group[-1]["end"] - group[0]["start"] <= max_duration or len(group) < 2:
        return [group]
    mid_time = (group[0]["start"] + group[-1]["end"]) / 2
    best_idx = 1
    best_dist = float("inf")
    for i in range(1, len(group)):
        boundary = group[i]["start"]
        if abs(boundary - mid_time) < best_dist:
            best_dist = abs(boundary - mid_time)
            best_idx = i
    left, right = group[:best_idx], group[best_idx:]
    return _split_group_by_duration(left, max_duration) + \
        _split_group_by_duration(right, max_duration)


def enforce_limits(groups, max_duration=MAX_DURATION,
                   min_duration=MIN_DURATION, merge_gap=MERGE_GAP):
    """최대 시간 초과 분할 + 짧은 그룹 인접 병합."""
    result = []
    for g in groups:
        result.extend(_split_group_by_duration(g, max_duration))

    merged = []
    for g in result:
        duration = g[-1]["end"] - g[0]["start"]
        if (merged and duration < min_duration
                and g[0]["start"] - merged[-1][-1]["end"] <= merge_gap
                and g[-1]["end"] - merged[-1][0]["start"] <= max_duration):
            merged[-1] = merged[-1] + g
        else:
            merged.append(g)
    return merged


def join_words(words, lang):
    sep = "" if lang in NOSPACE_LANGS else " "
    return sep.join(w["word"].strip() for w in words).strip()


def wrap_lines(text, lang, max_lines=MAX_LINES):
    """언어별 최대 줄 길이로 줄바꿈 (최대 max_lines줄)."""
    max_len = MAX_LINE_CJK if lang in CJK_LANGS else MAX_LINE_LATIN
    if len(text) <= max_len:
        return text

    if lang in NOSPACE_LANGS:
        # 공백 없는 언어: 글자 수로 균등 분할
        n_lines = min(max_lines, (len(text) + max_len - 1) // max_len)
        per_line = (len(text) + n_lines - 1) // n_lines
        lines = [text[i:i + per_line] for i in range(0, len(text), per_line)]
    else:
        # 공백 있는 언어: 단어 경계에서 분할
        lines = []
        current = ""
        for word in text.split(" "):
            candidate = (current + " " + word).strip()
            if len(candidate) <= max_len or not current:
                current = candidate
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)

    if len(lines) > max_lines:
        # 줄 수 초과 시 텍스트를 버리지 않고 마지막 줄에 합침
        # (상류의 enforce_limits가 대부분 방지하므로 드문 케이스)
        lines = lines[:max_lines - 1] + [" ".join(lines[max_lines - 1:])
                                         if lang not in NOSPACE_LANGS
                                         else "".join(lines[max_lines - 1:])]
    return "\n".join(lines)


def postprocess(segments, lang):
    """정렬된 세그먼트 목록 → 자막 목록.

    - words가 있는 세그먼트: 단어 기반 분할/트리밍
    - words 키가 없는 세그먼트(폴백): 세그먼트 시각 그대로 사용
    - words가 빈 리스트인 세그먼트(정렬이 환각으로 판정): 제거
    """
    all_words = []
    fallback_subs = []
    for seg in segments:
        if "words" not in seg:
            fallback_subs.append({
                "start": seg["start"], "end": seg["end"],
                "text": wrap_lines(seg["text"].strip(), lang),
            })
            continue
        if not seg["words"]:
            continue  # 환각 의심: 정렬된 단어 없음
        all_words.extend(fill_missing_timestamps(seg["words"]))

    subs = []
    groups = enforce_limits(split_at_gaps(all_words))
    for i, g in enumerate(groups):
        start, end = g[0]["start"], g[-1]["end"]
        if end - start < MIN_DURATION:
            # 다음 자막 시작 직전까지만 연장
            limit = groups[i + 1][0]["start"] if i + 1 < len(groups) else float("inf")
            end = min(start + MIN_DURATION, limit)
        text = join_words(g, lang)
        if not text:
            continue
        subs.append({"start": start, "end": end, "text": wrap_lines(text, lang)})

    subs.extend(fallback_subs)
    subs.sort(key=lambda s: s["start"])
    return subs
```

- [ ] **Step 4: 테스트 통과 확인**

```powershell
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe -m pytest C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\tests\test_subtitle_postprocess.py -v
```

Expected: 전부 PASS. 실패 시 구현(테스트가 아니라)을 수정.

- [ ] **Step 5: Commit**

```powershell
git add python/subtitle_postprocess.py python/tests/test_subtitle_postprocess.py
git commit -m "feat: add subtitle post-processing (gap split, trim, merge, wrap)"
```

---

### Task 3: 정렬 모듈 (whisperx.align 래퍼 + 폴백)

**Files:**
- Create: `python/align_segments.py`

정렬은 어떤 실패에서도 예외를 밖으로 던지지 않는다. 성공 시 단어 타임스탬프가 정밀해진 세그먼트, 실패 시 입력 세그먼트 그대로 반환.

- [ ] **Step 1: 구현**

`python/align_segments.py`:

```python
"""WhisperX wav2vec2 강제 정렬 래퍼.

입력 세그먼트: {"start", "end", "text", "words": [...]} (words는 폴백용)
출력: (segments, aligned) — aligned=False면 입력 그대로(폴백).
"""

SUPPORTED_ALIGN_LANGS = {"ko", "en", "ja", "zh"}


def align_with_whisperx(segments, audio_path, language, device, report):
    """세그먼트를 wav2vec2로 강제 정렬. 실패 시 폴백.

    report: report(stage, progress, message) 콜백 (process_video.report)
    """
    if language not in SUPPORTED_ALIGN_LANGS:
        report("warning", 86,
               f"언어 '{language}'는 정밀 정렬 미지원 — Whisper 단어 타임스탬프 사용")
        return segments, False

    try:
        import torch
        import whisperx
    except ImportError as e:
        report("warning", 86, f"정렬 라이브러리 로드 실패({e}) — 기본 타임스탬프 사용")
        return segments, False

    align_device = "cuda" if (device == "cuda" and torch.cuda.is_available()) else "cpu"

    try:
        report("aligning", 86, f"정렬 모델 로딩 중 ({language}, {align_device})...")
        model_a, metadata = whisperx.load_align_model(
            language_code=language, device=align_device)
        audio = whisperx.load_audio(audio_path)
        report("aligning", 88, "타임스탬프 정밀 정렬 중...")
        result = whisperx.align(
            segments, model_a, metadata, audio, align_device,
            return_char_alignments=False)
        aligned = result["segments"]
        report("aligning", 92, f"정렬 완료 ({len(aligned)}개 구간)")
        return aligned, True
    except Exception as e:
        if align_device == "cuda":
            # GPU 실패(OOM 등) 시 CPU로 1회 재시도
            try:
                report("aligning", 86, f"GPU 정렬 실패({type(e).__name__}) — CPU로 재시도...")
                model_a, metadata = whisperx.load_align_model(
                    language_code=language, device="cpu")
                audio = whisperx.load_audio(audio_path)
                result = whisperx.align(
                    segments, model_a, metadata, audio, "cpu",
                    return_char_alignments=False)
                report("aligning", 92, "정렬 완료 (CPU)")
                return result["segments"], True
            except Exception as e2:
                report("warning", 92, f"정렬 실패({e2}) — 기본 타임스탬프 사용")
                return segments, False
        report("warning", 92, f"정렬 실패({e}) — 기본 타임스탬프 사용")
        return segments, False
```

- [ ] **Step 2: 스모크 테스트 (import + 폴백 경로)**

```powershell
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe -c "import sys; sys.path.insert(0, r'C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python'); from align_segments import align_with_whisperx; segs=[{'start':0,'end':1,'text':'hi'}]; out, ok = align_with_whisperx(segs, 'nonexistent.wav', 'xx', 'cpu', lambda *a, **k: print(a)); print('fallback ok:', out == segs and not ok)"
```

Expected: `fallback ok: True` (미지원 언어 → 즉시 폴백)

- [ ] **Step 3: Commit**

```powershell
git add python/align_segments.py
git commit -m "feat: add whisperx forced-alignment wrapper with fallback"
```

---

### Task 4: process_video.py 파이프라인 통합

**Files:**
- Modify: `python/process_video.py`

변경 요약: (1) `--language` 인자, (2) 인식 파라미터 튜닝 + 단어 타임스탬프 수집, (3) CUDA compute_type `int8_float16`, (4) 인식 모델 VRAM 해제, (5) 정렬 + 후처리 호출, (6) SRT는 후처리 결과로 생성.

- [ ] **Step 1: `--language` 인자 추가**

`main()`의 argparse 부분(311행 부근)에 추가:

```python
    parser.add_argument("--language", default="auto",
                        choices=["auto", "ko", "en", "ja", "zh"],
                        help="음성 언어 (auto=자동 감지)")
```

- [ ] **Step 2: detect_device의 CUDA compute_type 변경**

`detect_device()`(101행)에서 `return "cuda", "float16"` → `return "cuda", "int8_float16"` 으로 변경 (8GB VRAM에서 large-v3 안전 로드).

- [ ] **Step 3: `_transcribe_faster` 튜닝 + 단어 수집**

`_transcribe_faster` 시그니처를 `(audio_path, model_size="base", device="auto", language="auto")`로 변경하고, `model.transcribe` 호출(176행)을 다음으로 교체:

```python
    segments_gen, info = model.transcribe(
        audio_path,
        language=None if language == "auto" else language,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
        beam_size=5,
        word_timestamps=True,
        condition_on_previous_text=False,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
    )
```

세그먼트 수집 루프(189행)를 단어 포함으로 교체:

```python
    segments = []
    for seg in segments_gen:
        words = []
        if seg.words:
            for wd in seg.words:
                words.append({"word": wd.word, "start": wd.start, "end": wd.end})
        segments.append({
            "start": seg.start,
            "end": seg.end,
            "text": seg.text.strip(),
            "words": words,
        })
        if len(segments) % 10 == 0:
            report("transcribing", min(35 + len(segments) // 2, 65),
                   f"[faster-whisper] 음성 인식 중... ({len(segments)}개 구간, {device_label})")
```

- [ ] **Step 4: `_transcribe_openai`에도 단어 타임스탬프 추가**

`model.transcribe` 호출(229행)에 `word_timestamps=True, condition_on_previous_text=False` 추가. 세그먼트 수집(240행)에 단어 포함:

```python
    segments = []
    for seg in result.get("segments", []):
        words = [{"word": wd["word"], "start": wd["start"], "end": wd["end"]}
                 for wd in seg.get("words", [])]
        segments.append({
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"].strip(),
            "words": words,
        })
```

- [ ] **Step 5: `transcribe_audio` 시그니처에 language 전달**

```python
def transcribe_audio(audio_path, model_size="base", device="auto",
                     engine="faster-whisper", language="auto"):
    if engine == "openai-whisper":
        return _transcribe_openai(audio_path, model_size, device, language)
    else:
        return _transcribe_faster(audio_path, model_size, device, language)
```

`_transcribe_openai`도 language 파라미터를 받아 `model.transcribe(audio_path, language=None if language == "auto" else language, ...)`로 전달.

- [ ] **Step 6: 인식 모델 VRAM 해제 함수 추가**

`_transcribe_faster` 끝(return 전)은 그대로 두고, 모듈 레벨에 추가:

```python
def _unload_whisper_vram():
    """정렬 모델 로드 전 인식 모델의 VRAM 해제 (Python 객체는 유지해 GC 크래시 방지)"""
    global _whisper_model
    try:
        if _whisper_model is not None and hasattr(_whisper_model, "model"):
            _whisper_model.model.unload_model()
    except Exception:
        pass
```

- [ ] **Step 7: main()에 정렬 + 후처리 통합**

파일 상단 import에 추가:

```python
from subtitle_postprocess import postprocess
from align_segments import align_with_whisperx
```

`main()`의 2번(인식)과 3번(SRT) 사이(354~363행)를 다음으로 교체:

```python
        # 2. 음성 인식 (GPU/CPU 자동 선택)
        segments, detected_lang, used_device = transcribe_audio(
            audio_path, args.model, args.device, args.engine, args.language
        )

        if not segments:
            report("error", 0, "음성이 감지되지 않았습니다.")
            sys.exit(1)

        # 3. 강제 정렬 (실패 시 Whisper 단어 타임스탬프로 폴백)
        align_lang = args.language if args.language != "auto" else detected_lang
        _unload_whisper_vram()
        segments, aligned = align_with_whisperx(
            segments, audio_path, align_lang, used_device, report
        )

        # 4. 후처리: 무음 분할/트리밍/병합/줄바꿈
        subtitles = postprocess(segments, align_lang)

        if not subtitles:
            report("error", 0, "자막을 생성할 수 없습니다 (유효한 발화 없음).")
            sys.exit(1)

        # 5. SRT 생성
        generate_srt(subtitles, srt_path)
```

완료 report의 `"segments": len(segments)` → `"segments": len(subtitles)` 로 변경.

주의: whisperx.align의 입력 세그먼트는 `start/end/text` 키를 사용한다 — 현재 dict 구조 그대로 호환됨. `words` 키가 있어도 무시된다.

- [ ] **Step 8: CLI 스모크 테스트 (실제 영상)**

짧은(1~3분) 한국어 영상 파일로:

```powershell
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\process_video.py "<테스트영상.mp4>" --model small --language ko --output C:\Users\evers\AppData\Local\Temp\claude\test_out.srt
```

Expected:
- `aligning` 스테이지 JSON 라인이 출력됨 (첫 실행 시 정렬 모델 다운로드로 수 분 소요 가능)
- `complete` 라인 출력, SRT 파일 생성
- SRT를 열어 무음 구간(영상에서 말이 없는 부분)에 자막이 없는지 육안 확인

- [ ] **Step 9: 기존 후처리 단위 테스트 재실행 (회귀 확인)**

```powershell
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe -m pytest C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\tests -v
```

Expected: 전부 PASS

- [ ] **Step 10: Commit**

```powershell
git add python/process_video.py
git commit -m "feat: integrate alignment + post-processing into pipeline"
```

---

### Task 5: UI — 언어 선택, 설정 영속화, 정렬 단계 표시

**Files:**
- Modify: `renderer/index.html:33-59` (설정 패널), `:106-119` (진행 단계)
- Modify: `renderer/app.js` (설정 저장/복원, options에 language 추가, stageOrder)
- Modify: `main/subtitle-operations.js:36-42` (--language 인자 전달)

- [ ] **Step 1: index.html 설정 패널에 언어 드롭다운 추가**

`#settings-panel`의 처리 장치 label 뒤에 추가:

```html
    <label>
      음성 언어:
      <select id="language-select">
        <option value="ko" selected>한국어</option>
        <option value="en">영어</option>
        <option value="ja">일본어</option>
        <option value="zh">중국어</option>
        <option value="auto">자동 감지</option>
      </select>
    </label>
```

- [ ] **Step 2: index.html 진행 단계에 "정렬" 추가**

`.progress-steps`(106행)를 4단계로 교체:

```html
        <div class="progress-steps">
          <div class="step" data-stage="extracting">
            <div class="dot">1</div>
            <div class="label">오디오<br>추출</div>
          </div>
          <div class="step" data-stage="transcribing">
            <div class="dot">2</div>
            <div class="label">음성<br>인식</div>
          </div>
          <div class="step" data-stage="aligning">
            <div class="dot">3</div>
            <div class="label">타임스탬프<br>정렬</div>
          </div>
          <div class="step" data-stage="generating">
            <div class="dot">4</div>
            <div class="label">자막<br>생성</div>
          </div>
        </div>
```

- [ ] **Step 3: app.js — stageOrder에 aligning 추가**

390행 `const stageOrder = ['extracting', 'transcribing', 'generating'];` →

```javascript
const stageOrder = ['extracting', 'transcribing', 'aligning', 'generating'];
```

- [ ] **Step 4: app.js — 설정 영속화 (localStorage)**

`// ===== 설정 토글 =====` 섹션(41행) 앞에 추가:

```javascript
// ===== 설정 영속화 =====
const SETTING_IDS = ['engine-select', 'model-select', 'device-select', 'language-select'];

function loadSettings() {
  SETTING_IDS.forEach(id => {
    const el = document.getElementById(id);
    const saved = localStorage.getItem('setting:' + id);
    if (saved !== null && [...el.options].some(o => o.value === saved)) {
      el.value = saved;
    }
    el.addEventListener('change', () => {
      localStorage.setItem('setting:' + id, el.value);
    });
  });
}
loadSettings();
```

- [ ] **Step 5: app.js — options에 language 추가**

`startQueue()`의 options(334행)에 추가:

```javascript
    const options = {
      engine: document.getElementById('engine-select').value,
      model: document.getElementById('model-select').value,
      device: document.getElementById('device-select').value,
      language: document.getElementById('language-select').value,
    };
```

- [ ] **Step 6: subtitle-operations.js — --language 전달**

`processVideo()`의 args(36행)에 추가:

```javascript
  const args = [
    videoPath,
    '--engine', options.engine || 'faster-whisper',
    '--model', options.model || 'large-v3',
    '--ffmpeg', getFfmpegPath(),
    '--device', options.device || 'auto',
    '--language', options.language || 'auto',
  ];
```

- [ ] **Step 7: 앱 실행 육안 확인**

```powershell
cd C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator; npm start
```

확인 항목:
- 설정 패널에 "음성 언어" 드롭다운 표시
- 언어를 바꾸고 앱 재시작 → 마지막 선택값 유지
- 진행 화면에 4단계(추출/인식/정렬/생성) 표시
(개발 모드는 `bin/process_video.exe`가 없으면 의존성 경고가 뜰 수 있음 — UI 확인만 하면 됨)

- [ ] **Step 8: Commit**

```powershell
git add renderer/index.html renderer/app.js main/subtitle-operations.js
git commit -m "feat: language selection UI, persisted settings, align stage display"
```

---

### Task 6: 버전/체인지로그 + 빌드 스크립트 갱신

**Files:**
- Modify: `package.json` (version 1.3.0 → 1.4.0)
- Modify: `renderer/app.js:485` (CHANGELOG 배열 맨 앞에 v1.4.0 추가)
- Modify: `python/process_video.spec` (whisperx 관련 collect 추가)

- [ ] **Step 1: package.json 버전 변경**

`"version": "1.3.0"` → `"version": "1.4.0"`

- [ ] **Step 2: CHANGELOG 항목 추가**

`renderer/app.js`의 `const CHANGELOG = [` 바로 뒤(486행)에 추가:

```javascript
  {
    version: '1.4.0',
    date: '2026-07-19',
    sections: [
      {
        title: 'Added',
        type: 'added',
        items: [
          'WhisperX 강제 정렬: 단어 단위 정밀 타임스탬프 (한/영/일/중)',
          '자막 후처리: 무음 구간(0.6초 이상)에서 자막 자동 분할 — 말이 없을 때 자막 미표시',
          '자막 표시 규칙: 최대 6초, 최소 0.8초, 자동 줄바꿈 (CJK 20자/라틴 42자, 최대 2줄)',
          '음성 언어 선택 (한국어/영어/일본어/중국어/자동 감지)',
          '설정값 저장: 마지막 사용 설정이 다음 실행 시 기본값',
        ],
      },
      {
        title: 'Changed',
        type: 'changed',
        items: [
          '환각(hallucination) 억제: 이전 텍스트 조건화 비활성화 및 품질 임계값 필터 적용',
          'GPU에서 large-v3를 int8_float16 양자화로 로드 (8GB VRAM 대응)',
          'VAD 파라미터 튜닝 (최소 무음 500ms, 발화 패딩 200ms)',
        ],
      },
    ],
  },
```

- [ ] **Step 3: PyInstaller spec에 whisperx 의존성 추가**

`python/process_video.spec`의 collect_all 블록(7~20행) 뒤에 추가:

```python
tmp_ret = collect_all('whisperx')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('torch')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('torchaudio')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('transformers')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
hiddenimports += ['pyannote.audio', 'lightning_fabric']
```

주의: torch 포함으로 빌드 결과물이 수 GB로 커진다. 빌드는 이 계획 범위에서는 실행하지 않고(개발 모드 검증까지), 다음 배포 시점에 `pyinstaller process_video.spec`으로 검증한다.

- [ ] **Step 4: Commit**

```powershell
git add package.json renderer/app.js python/process_video.spec
git commit -m "chore: bump to v1.4.0, changelog, bundle whisperx in spec"
```

---

### Task 7: E2E 검증

- [ ] **Step 1: 단위 테스트 전체 실행**

```powershell
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe -m pytest C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\tests -v
```

Expected: 전부 PASS

- [ ] **Step 2: 실제 영상 E2E (venv 파이썬으로 CLI 직접 실행)**

무음 구간이 있는 실제 영상(한국어 권장)으로:

```powershell
C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\.venv\Scripts\python.exe C:\Users\evers\Documents\AUTOMATA\video-subtitle-generator\python\process_video.py "<영상경로>" --model large-v3 --language ko --output C:\Users\evers\AppData\Local\Temp\claude\e2e_out.srt
```

검증 항목:
- [ ] GPU 사용 확인 (`GPU (CUDA)` 메시지)
- [ ] `aligning` 단계 통과 (폴백 경고 없이)
- [ ] SRT에서 무음 구간에 자막이 없는지: 영상에서 말이 끊기는 지점 2~3곳을 골라 해당 시간대 SRT 항목 확인
- [ ] 자막당 6초 이하, 2줄 이하인지 확인
- [ ] 이전 버전 대비 오탈자/환각 감소 체감 확인

- [ ] **Step 3: 사용자 인수 확인**

사용자에게 결과 SRT와 함께 개선 사항을 보고하고 피드백을 받는다.
