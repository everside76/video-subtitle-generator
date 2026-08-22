# CrisperWhisper 2.0 엔진 지원 구현 계획 (v1.8.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CrisperWhisper 2.0(transformers 백엔드)을 세 번째 음성 인식 엔진으로 추가하고 엔진 v3 빌드 체계를 갖춘다.

**Architecture:** 공식 `crisperwhisper` 패키지의 transformers 백엔드를 기존 엔진 로더 구조에 얹는다. 평면 단어 결과를 단일 세그먼트로 매핑해 기존 후처리(무음 분할)를 재사용하고, Electron UI는 엔진별 모델 목록/전사 모드/언어 제약을 반영한다. PyInstaller 번들에 transformers 스택을 추가한 engine-v3와 재현 가능한 릴리스 패키징 스크립트를 만든다.

**Tech Stack:** crisperwhisper 2.0.2 (transformers 백엔드), torch 2.8.0+cu128, Electron, PyInstaller 6.19

**전제 (조사·검증 완료, 설계 문서 참조):** `docs/superpowers/specs/2026-08-20-crisperwhisper2-design.md`
- venv(Python 3.13.14)에 `crisperwhisper[transformers]` 설치 확인 완료 (accelerate 1.14.0, soundfile 0.14.0, soxr 1.1.0 추가됨)
- API: `CrisperWhisperModel("large", backend="transformers", device="cuda"|"cpu", compute_type="float16"|"float32")`, `transcribe(path, language="en", mode="intended"|"verbatim", word_timestamps=True)` → `result.text/.language/.words[WordTimestamp(word,start,end)]`
- 언어 자동 감지 없음 → "auto"는 "en" 폴백

**Task 1/2/3은 파일이 겹치지 않아 병렬 실행 가능. Task 4→5→6은 순차.**

---

### Task 1: 파이프라인 — CrisperWhisper 엔진 경로 (python)

**Files:**
- Modify: `python/process_video.py`
- Test: `python/tests/test_cw_mapping.py` (신규)

- [ ] **Step 1: 실패하는 테스트 작성** — `python/tests/test_cw_mapping.py` 생성:

```python
"""CrisperWhisper 결과 매핑 단위 테스트 (모델 로드 없음)."""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from process_video import cw_normalize_model, cw_words_to_segments


def W(word, start, end):
    return SimpleNamespace(word=word, start=start, end=end)


def test_words_to_single_segment():
    words = [W("Hello", 0.5, 0.9), W("world", 1.0, 1.4)]
    segs = cw_words_to_segments(words, "Hello world")
    assert len(segs) == 1
    assert segs[0]["start"] == 0.5
    assert segs[0]["end"] == 1.4
    assert segs[0]["text"] == "Hello world"
    assert segs[0]["words"] == [
        {"word": "Hello", "start": 0.5, "end": 0.9},
        {"word": "world", "start": 1.0, "end": 1.4},
    ]


def test_empty_words_returns_empty():
    assert cw_words_to_segments([], "text") == []


def test_all_none_timestamps_returns_empty():
    assert cw_words_to_segments([W("x", None, None)], "x") == []


def test_partial_none_kept_for_postprocess():
    words = [W("a", 0.0, 0.2), W("b", None, None), W("c", 0.5, 0.7)]
    segs = cw_words_to_segments(words, "a b c")
    assert segs[0]["start"] == 0.0
    assert segs[0]["end"] == 0.7
    assert segs[0]["words"][1] == {"word": "b", "start": None, "end": None}


def test_normalize_model():
    assert cw_normalize_model("large") == "large"
    assert cw_normalize_model("turbo") == "turbo"
    assert cw_normalize_model("medium") == "medium"
    assert cw_normalize_model("small") == "small"
    assert cw_normalize_model("large-v3") == "large"
    assert cw_normalize_model("base") == "small"
    assert cw_normalize_model("tiny") == "small"
```

- [ ] **Step 2: 실패 확인**

Run: `python/.venv/Scripts/python.exe -m pytest python/tests/test_cw_mapping.py -v`
Expected: FAIL (ImportError: cannot import name 'cw_normalize_model')

- [ ] **Step 3: 매핑 함수 구현** — `python/process_video.py`의 `_unload_whisper_vram()` 뒤에 추가:

```python
CW_MODELS = {"large", "turbo", "medium", "small"}
CW_MODEL_FALLBACK = {"large-v3": "large", "base": "small", "tiny": "small"}


def cw_normalize_model(model_size):
    """CrisperWhisper 모델 크기 정규화 (Whisper 크기 이름 → 가장 가까운 CW 크기)."""
    if model_size in CW_MODELS:
        return model_size
    return CW_MODEL_FALLBACK.get(model_size, "large")


def cw_words_to_segments(words, full_text):
    """CrisperWhisper 평면 단어 목록 → 파이프라인 세그먼트 1개.

    무음 기준 분할은 postprocess가 단어 타임스탬프로 전담하므로
    세그먼트 경계는 형식 맞춤용. 일부 None 시각은 후처리 보간에 위임.
    """
    items = [{"word": w.word, "start": w.start, "end": w.end} for w in words]
    starts = [it["start"] for it in items if it["start"] is not None]
    ends = [it["end"] for it in items if it["end"] is not None]
    if not starts or not ends:
        return []
    return [{
        "start": min(starts),
        "end": max(ends),
        "text": full_text.strip(),
        "words": items,
    }]
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `python/.venv/Scripts/python.exe -m pytest python/tests -v`
Expected: 신규 5건 + 기존 17건 전부 PASS

- [ ] **Step 5: 엔진 경로 구현** — `python/process_video.py`:

(a) `transcribe_audio`를 다음으로 교체:

```python
def transcribe_audio(audio_path, model_size="base", device="auto",
                     engine="faster-whisper", language="auto", cw_mode="intended"):
    """음성 인식 (엔진 선택 가능)"""
    if engine == "crisperwhisper":
        return _transcribe_crisperwhisper(audio_path, model_size, device,
                                          language, cw_mode)
    if engine == "openai-whisper":
        return _transcribe_openai(audio_path, model_size, device, language)
    return _transcribe_faster(audio_path, model_size, device, language)
```

(b) `_transcribe_faster_impl` 본문 맨 앞(global 선언 다음)과 `_transcribe_openai`의 device 결정 코드 앞에 whisper 크기 정규화 추가:

```python
    if model_size in ("large", "turbo"):
        model_size = "large-v3"
```

(c) 매핑 함수들 뒤에 CrisperWhisper 경로 추가:

```python
def _release_torch_vram():
    """CPU 재시도 전 GPU 모델 해제 (런타임 중 해제는 안전)."""
    global _whisper_model
    _whisper_model = None
    gc.collect()
    try:
        import torch
        torch.cuda.empty_cache()
    except Exception:
        pass


def _download_cw_model(repo_id):
    """모델 사전 다운로드 (최초 1회) — HF 캐시 크기 폴링으로 진행률 보고."""
    import threading
    from huggingface_hub import snapshot_download
    try:
        from huggingface_hub import constants as hf_constants
        cache_root = hf_constants.HF_HUB_CACHE
    except Exception:
        cache_root = os.path.join(os.path.expanduser("~"),
                                  ".cache", "huggingface", "hub")
    repo_dir = os.path.join(cache_root, "models--" + repo_id.replace("/", "--"))

    def dir_size(path):
        total = 0
        for root, _dirs, files in os.walk(path):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(root, name))
                except OSError:
                    pass
        return total

    stop = threading.Event()

    def poll():
        while not stop.wait(2.0):
            gb = dir_size(repo_dir) / 1e9 if os.path.isdir(repo_dir) else 0.0
            report("transcribing", 22,
                   f"[crisperwhisper] 모델 다운로드 중 (최초 1회)... {gb:.2f} GB")

    t = threading.Thread(target=poll, daemon=True)
    t.start()
    try:
        snapshot_download(repo_id)
    finally:
        stop.set()
        t.join(timeout=5)


def _transcribe_crisperwhisper(audio_path, model_size, device, language, mode):
    """CrisperWhisper 2.0 (transformers 백엔드). GPU 실패 시 CPU 재시도."""
    import torch

    if device == "cpu":
        actual_device = "cpu"
    else:
        actual_device = "cuda" if torch.cuda.is_available() else "cpu"
        if device == "cuda" and actual_device == "cpu":
            report("warning", 0, "CUDA를 사용할 수 없습니다. CPU로 전환합니다.")

    try:
        return _transcribe_crisperwhisper_impl(
            audio_path, model_size, actual_device, language, mode)
    except Exception as e:
        if actual_device != "cuda":
            raise
        _release_torch_vram()
        report("warning", 20,
               f"GPU 인식 실패({type(e).__name__}) — CPU로 재시도합니다 (느려질 수 있음)")
        return _transcribe_crisperwhisper_impl(
            audio_path, model_size, "cpu", language, mode)


def _transcribe_crisperwhisper_impl(audio_path, model_size, actual_device,
                                    language, mode):
    global _whisper_model

    if language == "auto":
        report("warning", 20,
               "CrisperWhisper는 언어 자동 감지를 지원하지 않습니다 — 영어(en)로 진행합니다.")
        language = "en"

    cw_size = cw_normalize_model(model_size)
    if cw_size != model_size:
        report("warning", 20,
               f"CrisperWhisper 모델 크기 조정: {model_size} → {cw_size}")

    device_label = "GPU (CUDA)" if actual_device == "cuda" else "CPU"
    repo_id = f"nyralabs/CrisperWhisper2.0_{cw_size}"

    report("transcribing", 21, f"[crisperwhisper] 모델 확인 중 ({cw_size})...")
    try:
        _download_cw_model(repo_id)
    except Exception as e:
        # 캐시가 있으면 오프라인에서도 로드 가능 — 사전 다운로드 실패는 경고만
        report("warning", 22,
               f"모델 사전 다운로드 실패({type(e).__name__}) — 로드 단계에서 재시도")

    report("transcribing", 25,
           f"[crisperwhisper] 모델 로딩 중 ({cw_size}, {device_label})...")

    from crisperwhisper import CrisperWhisperModel

    model = CrisperWhisperModel(
        cw_size,
        backend="transformers",
        device=actual_device,
        compute_type="float16" if actual_device == "cuda" else "float32",
    )
    _whisper_model = model

    mode_label = "정제(intended)" if mode == "intended" else "축어(verbatim)"
    report("transcribing", 30,
           f"[crisperwhisper] 음성 인식 중... ({mode_label}, {device_label})")

    result = model.transcribe(
        audio_path,
        language=language,
        mode=mode,
        word_timestamps=True,
    )

    segments = cw_words_to_segments(result.words or [], result.text or "")
    if not segments:
        raise RuntimeError("CrisperWhisper가 단어 타임스탬프를 반환하지 않았습니다.")

    detected_lang = result.language or language
    report("transcribing", 85,
           f"[crisperwhisper] 음성 인식 완료 "
           f"({len(segments[0]['words'])}개 단어, {device_label})")

    return segments, detected_lang, actual_device
```

(d) `main()`의 argparse 수정:

```python
    parser.add_argument("--model", default="base",
                        choices=["tiny", "base", "small", "medium", "large-v3",
                                 "large", "turbo"],
                        help="모델 크기 (Whisper: tiny~large-v3 / CrisperWhisper: large, turbo, medium, small)")
```
```python
    parser.add_argument("--engine", default="faster-whisper",
                        choices=["faster-whisper", "openai-whisper", "crisperwhisper"],
                        help="음성 인식 엔진 (faster-whisper=CTranslate2, openai-whisper=PyTorch, crisperwhisper=CrisperWhisper 2.0)")
    parser.add_argument("--cw-mode", default="intended",
                        choices=["intended", "verbatim"],
                        help="CrisperWhisper 전사 모드 (intended=정제, verbatim=축어)")
```

(e) `main()`의 인식 호출을 다음으로 교체:

```python
        segments, detected_lang, used_device = transcribe_audio(
            audio_path, args.model, args.device, args.engine, args.language,
            args.cw_mode
        )
```

- [ ] **Step 6: 전체 테스트 + CLI 스모크**

Run: `python/.venv/Scripts/python.exe -m pytest python/tests -v` → 전부 PASS
Run: `python/.venv/Scripts/python.exe python/process_video.py --help` → 새 인자 표시, exit 0

- [ ] **Step 7: Commit**

```bash
git add python/process_video.py python/tests/test_cw_mapping.py
git commit -m "feat: CrisperWhisper 2.0 engine path in pipeline"
```

---

### Task 2: Electron UI/IPC — 엔진 선택·모드·언어 제약

**Files:**
- Modify: `renderer/index.html` (설정 패널, 36-77행 부근)
- Modify: `renderer/app.js` (SETTING_IDS 42행 부근, options 351행 부근)
- Modify: `main/subtitle-operations.js` (args 41-48행 부근)
- Modify: `main/engine-manager.js:18` (ENGINE_VERSION)

- [ ] **Step 1: index.html** — 엔진 옵션 추가 (`engine-select` 내):

```html
        <option value="crisperwhisper">CrisperWhisper 2.0 (정밀 타임스탬프)</option>
```

모델 label 바로 뒤에 전사 모드 label 추가:

```html
    <label id="cw-mode-label" style="display:none;">
      전사 모드:
      <select id="cw-mode-select">
        <option value="intended" selected>정제 (읽기 좋은 자막)</option>
        <option value="verbatim">축어 (말한 그대로, 필러 포함)</option>
      </select>
    </label>
```

- [ ] **Step 2: app.js — 엔진별 모델 목록/제약 동기화.** 기존 SETTING_IDS 저장/복원 로직(42행 부근)을 읽고 다음을 통합:

(a) `'cw-mode-select'`를 `SETTING_IDS`에 추가. `'model-select'`는 SETTING_IDS에서 **제거** (엔진별 키로 별도 관리).

(b) 상수와 동기화 함수 추가:

```js
const ENGINE_MODELS = {
  'faster-whisper': [
    ['tiny', 'tiny (빠름, 낮은 정확도)'],
    ['base', 'base (균형)'],
    ['small', 'small (보통)'],
    ['medium', 'medium (높은 정확도)'],
    ['large-v3', 'large-v3 (최고 정확도)'],
  ],
  'openai-whisper': [
    ['tiny', 'tiny (빠름, 낮은 정확도)'],
    ['base', 'base (균형)'],
    ['small', 'small (보통)'],
    ['medium', 'medium (높은 정확도)'],
    ['large-v3', 'large-v3 (최고 정확도)'],
  ],
  'crisperwhisper': [
    ['large', 'large (최고 정확도)'],
    ['turbo', 'turbo (빠름)'],
    ['medium', 'medium (균형)'],
    ['small', 'small (가벼움)'],
  ],
};
const ENGINE_DEFAULT_MODEL = {
  'faster-whisper': 'large-v3',
  'openai-whisper': 'large-v3',
  'crisperwhisper': 'large',
};

function syncEngineUI() {
  const engine = document.getElementById('engine-select').value;
  const modelSel = document.getElementById('model-select');
  const models = ENGINE_MODELS[engine] || ENGINE_MODELS['faster-whisper'];

  const saved = localStorage.getItem('setting:model-select@' + engine);
  modelSel.innerHTML = '';
  for (const [value, label] of models) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    modelSel.appendChild(opt);
  }
  const values = models.map(([v]) => v);
  modelSel.value = values.includes(saved)
    ? saved : (ENGINE_DEFAULT_MODEL[engine] || values[0]);

  // CrisperWhisper 전용 전사 모드 표시
  document.getElementById('cw-mode-label').style.display =
    engine === 'crisperwhisper' ? '' : 'none';

  // CrisperWhisper는 언어 자동 감지 미지원
  const langSel = document.getElementById('language-select');
  const autoOpt = [...langSel.options].find((o) => o.value === 'auto');
  if (autoOpt) autoOpt.disabled = engine === 'crisperwhisper';
  if (engine === 'crisperwhisper' && langSel.value === 'auto') {
    langSel.value = 'en';
    localStorage.setItem('setting:language-select', 'en');
  }
}
```

(c) 이벤트 연결: 설정 복원 직후 `syncEngineUI()` 1회 호출. `engine-select`의 change 핸들러(기존 저장 로직)에 `syncEngineUI()` 추가. `model-select` change 시:

```js
document.getElementById('model-select').addEventListener('change', () => {
  const engine = document.getElementById('engine-select').value;
  localStorage.setItem('setting:model-select@' + engine,
    document.getElementById('model-select').value);
});
```

(d) options(351행 부근)에 추가:

```js
      cwMode: document.getElementById('cw-mode-select').value,
```

- [ ] **Step 3: subtitle-operations.js** — args 배열에 추가 (`--language` 뒤):

```js
    '--cw-mode', options.cwMode || 'intended',
```

- [ ] **Step 4: engine-manager.js** — `const ENGINE_VERSION = 2;` → `const ENGINE_VERSION = 3;`

- [ ] **Step 5: 수동 확인 (Electron 미기동 검증)**

Run: `node -e "require('./main/engine-manager.js'); require('./main/subtitle-operations.js'); console.log('OK')"`
Expected: `OK` (문법 오류 없음. app.js는 브라우저 전용이라 `node --check renderer/app.js`로 문법만 확인)

- [ ] **Step 6: Commit**

```bash
git add renderer/index.html renderer/app.js main/subtitle-operations.js main/engine-manager.js
git commit -m "feat: CrisperWhisper 2.0 UI options and engine-v3 pointer"
```

---

### Task 3: 엔진 v3 빌드 체계 + 문서

**Files:**
- Modify: `python/requirements.txt`
- Modify: `python/process_video.spec`
- Modify: `scripts/setup.bat` (whisperx 잔재 정리)
- Create: `scripts/build-engine-release.ps1`
- Modify: `CHANGELOG.md`, `package.json` (version 1.8.0)

- [ ] **Step 1: requirements.txt** 를 다음으로 교체:

```
--extra-index-url https://download.pytorch.org/whl/cu128
faster-whisper>=1.0.0
crisperwhisper[transformers]>=2.0.2
deep-translator>=1.11.0
torch>=2.7.0
torchaudio>=2.7.0
```

- [ ] **Step 2: process_video.spec** — `collect_all('tiktoken')` 블록 뒤에 추가:

```python
tmp_ret = collect_all('crisperwhisper')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('transformers')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('tokenizers')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('accelerate')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('soundfile')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('soxr')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
```

기존 `copy_metadata('torch')` 줄 뒤에 추가 (transformers 런타임 버전 검사 대응):

```python
datas += copy_metadata('transformers')
datas += copy_metadata('tokenizers')
datas += copy_metadata('accelerate')
datas += copy_metadata('safetensors')
datas += copy_metadata('crisperwhisper')
datas += copy_metadata('huggingface_hub')
datas += copy_metadata('numpy')
```

`Analysis(... excludes=[]...)`의 excludes를 venv 잔재 차단으로 교체:

```python
    excludes=['whisperx', 'pytorch_lightning', 'lightning_fabric', 'torchvision',
              'matplotlib', 'pandas', 'sklearn', 'IPython', 'jedi'],
```

- [ ] **Step 3: setup.bat** — 검증 라인에서 `python -c "import whisperx; ..."` 줄 삭제, 그 자리에:

```
python -c "import crisperwhisper; print('[OK] crisperwhisper', crisperwhisper.__version__)"
```

- [ ] **Step 4: scripts/build-engine-release.ps1 생성** (전체 내용):

```powershell
# 엔진 릴리스 패키징: PyInstaller 빌드 → ffmpeg 포함 스테이징 → zip → 파트 분할 + SHA256 매니페스트
# 사용: powershell -ExecutionPolicy Bypass -File scripts\build-engine-release.ps1 [-SkipBuild]
param(
  [int]$EngineVersion = 3,
  [long]$PartSize = 1900MB,
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$py = Join-Path $root 'python'

if (-not $SkipBuild) {
  Write-Host '=== PyInstaller 빌드 ==='
  Push-Location $py
  & (Join-Path $py '.venv\Scripts\pyinstaller.exe') --noconfirm process_video.spec
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "PyInstaller 실패 (exit $LASTEXITCODE)" }
  Pop-Location
}

$dist = Join-Path $py 'dist\process_video'
if (-not (Test-Path (Join-Path $dist 'process_video.exe'))) { throw '빌드 산출물 없음' }

Write-Host '=== 스테이징 (ffmpeg 포함) ==='
$staging = Join-Path $root "dist\engine-v$EngineVersion-staging"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force $staging | Out-Null
Copy-Item -Recurse (Join-Path $dist '*') $staging
Copy-Item (Join-Path $root 'bin\ffmpeg.exe') $staging
Copy-Item (Join-Path $root 'bin\ffprobe.exe') $staging

Write-Host '=== 압축 (tar) ==='
$outDir = Join-Path $root "dist\engine-v$EngineVersion-release"
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force $outDir | Out-Null
$zip = Join-Path $outDir 'engine.zip'
Push-Location $staging
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip *
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "tar 압축 실패 (exit $LASTEXITCODE)" }
Pop-Location

Write-Host '=== 파트 분할 + SHA256 매니페스트 ==='
$zipHash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
$zipSize = (Get-Item $zip).Length
$parts = @()
$in = [System.IO.File]::OpenRead($zip)
try {
  $buf = New-Object byte[] (8MB)
  $idx = 0
  while ($in.Position -lt $in.Length) {
    $idx++
    $name = 'engine.zip.{0:d3}' -f $idx
    $dest = Join-Path $outDir $name
    $out = [System.IO.File]::Create($dest)
    try {
      $written = 0L
      while ($written -lt $PartSize -and $in.Position -lt $in.Length) {
        $toRead = [Math]::Min($buf.Length, $PartSize - $written)
        $n = $in.Read($buf, 0, $toRead)
        if ($n -le 0) { break }
        $out.Write($buf, 0, $n)
        $written += $n
      }
    } finally { $out.Close() }
    $parts += [ordered]@{
      name   = $name
      size   = (Get-Item $dest).Length
      sha256 = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLower()
    }
    Write-Host ("  {0}: {1:N0} bytes" -f $name, (Get-Item $dest).Length)
  }
} finally { $in.Close() }
Remove-Item $zip

$manifest = [ordered]@{
  version   = $EngineVersion
  totalSize = $zipSize
  zipSha256 = $zipHash
  parts     = $parts
}
$manifestPath = Join-Path $outDir 'engine-manifest.json'
$manifest | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 $manifestPath

Write-Host ''
Write-Host "완료: $outDir"
Write-Host "업로드: GitHub Release 태그 engine-v$EngineVersion 에 engine-manifest.json + engine.zip.* 업로드"
Write-Host '주의: 앱 릴리스(v1.8.0)보다 엔진 릴리스 업로드가 먼저여야 합니다.'
```

- [ ] **Step 5: CHANGELOG.md** 맨 위에 추가:

```markdown
## [1.8.0] - 2026-08-20

### Added
- CrisperWhisper 2.0 엔진 (transformers 백엔드): 무음으로 번지지 않는 정밀 단어 타임스탬프(±30ms급), 정제(intended)/축어(verbatim) 전사 모드
- 엔진별 모델 목록 동적 전환 (CrisperWhisper: large/turbo/medium/small), 엔진별 모델 선택 저장
- CrisperWhisper 모델 최초 다운로드 진행률 표시 (HF 캐시, large 기준 약 3.1GB)
- 엔진 릴리스 패키징 스크립트 `scripts/build-engine-release.ps1` (파트 분할 + SHA256 매니페스트 자동 생성)

### Changed
- 엔진 v3: crisperwhisper/transformers/accelerate/soundfile/soxr 번들 추가 (ENGINE_VERSION=3)
- CrisperWhisper 선택 시 언어 자동 감지 비활성화 (미지원 — 영어 기본)
- setup.bat의 whisperx 잔재 제거

### Note
- CrisperWhisper 2.0 모델 가중치는 Nyra Health 비상업 연구 라이선스 (상업 사용은 별도 계약 필요)
- 배포 순서: GitHub `engine-v3` 릴리스(파트+매니페스트) 업로드 → 앱 v1.8.0 릴리스
```

- [ ] **Step 6: package.json** — `"version": "1.7.0"` → `"version": "1.8.0"`

- [ ] **Step 7: Commit**

```bash
git add python/requirements.txt python/process_video.spec scripts/setup.bat scripts/build-engine-release.ps1 CHANGELOG.md package.json
git commit -m "build: engine-v3 packaging with CrisperWhisper deps (v1.8.0)"
```

---

### Task 4: 통합 검증 — 단위 테스트 + 실 GPU E2E

**Files:** 없음 (검증 전용; 산출물은 스크래치 디렉토리)

- [ ] **Step 1: 의존성 확인**

Run: `python/.venv/Scripts/python.exe -c "import crisperwhisper, transformers, torch; print(crisperwhisper.__version__, transformers.__version__, torch.__version__, torch.cuda.is_available())"`
Expected: `2.0.2 4.57.6 2.8.0+cu128 True`

- [ ] **Step 2: 전체 pytest**

Run: `python/.venv/Scripts/python.exe -m pytest python/tests -v`
Expected: 전부 PASS (기존 17건 + 신규 5건)

- [ ] **Step 3: 테스트 비디오 생성** (스크래치 디렉토리에서, SAPI TTS + ffmpeg):

```powershell
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SetOutputToWaveFile("$env:TEMP\cw_e2e.wav")
$s.Speak('Hello everyone, and welcome back to the channel. Today we are testing the new subtitle engine.')
$s.Speak('It should produce accurate word level timestamps, even around pauses. Thank you for watching.')
$s.Dispose()
```

```bash
bin/ffmpeg.exe -y -f lavfi -i color=c=black:s=320x240:d=20 -i "$TEMP/cw_e2e.wav" -shortest -c:v libx264 -c:a aac "<scratchpad>/cw_e2e.mp4"
```

- [ ] **Step 4: E2E 실행 (GPU, intended 모드)** — 최초 실행은 모델 3.1GB 다운로드 포함:

```bash
python/.venv/Scripts/python.exe python/process_video.py "<scratchpad>/cw_e2e.mp4" --engine crisperwhisper --model large --language en --cw-mode intended --device auto --ffmpeg bin/ffmpeg.exe --output "<scratchpad>/cw_e2e.srt"
```

Expected: JSON 진행 라인 (다운로드 → 로딩 → 인식) 후 `"stage": "complete"`; SRT 파일에 발화 내용과 유사한 영어 자막, 타임스탬프가 음성 구간에만 존재 (두 Speak 사이 무음에서 자막 분할 확인)

- [ ] **Step 5: verbatim 모드 + 매핑 견고성 확인** (모델 캐시 재사용으로 빠름):

```bash
python/.venv/Scripts/python.exe python/process_video.py "<scratchpad>/cw_e2e.mp4" --engine crisperwhisper --model large --language en --cw-mode verbatim --ffmpeg bin/ffmpeg.exe --output "<scratchpad>/cw_e2e_verbatim.srt"
```

Expected: complete + SRT 생성

- [ ] **Step 6: 기존 엔진 회귀** — faster-whisper 경로가 그대로 동작하는지:

```bash
python/.venv/Scripts/python.exe python/process_video.py "<scratchpad>/cw_e2e.mp4" --engine faster-whisper --model base --language en --ffmpeg bin/ffmpeg.exe --output "<scratchpad>/fw_e2e.srt"
```

Expected: complete + SRT 생성

---

### Task 5: 엔진 v3 빌드 + exe 스모크 + dev bin 갱신

**Files:** 빌드 산출물만 (`python/dist/`, `dist-engine/engine-v3-release/`, `bin/` — 전부 gitignore 대상)

- [ ] **Step 1: 릴리스 빌드 실행** (10~30분 소요 가능):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-engine-release.ps1
```

Expected: `dist-engine\engine-v3-release\` 에 `engine-manifest.json` + `engine.zip.NNN` 파트들

- [ ] **Step 2: exe 스모크 테스트** (빌드 직후 dist에서, 새 스크립트 지정):

```powershell
$env:VSG_SCRIPTS_DIR = "$PWD\python"
python\dist\process_video\process_video.exe "<scratchpad>\cw_e2e.mp4" --engine crisperwhisper --model large --language en --ffmpeg bin\ffmpeg.exe --output "<scratchpad>\cw_exe.srt"
```

Expected: complete + SRT (HF 캐시 재사용). 실패 시 누락 모듈을 spec hiddenimports/copy_metadata에 추가 후 재빌드.

- [ ] **Step 3: 기존 엔진 exe 회귀** — faster-whisper도 번들에서 동작 확인:

```powershell
python\dist\process_video\process_video.exe "<scratchpad>\cw_e2e.mp4" --engine faster-whisper --model base --language en --ffmpeg bin\ffmpeg.exe --output "<scratchpad>\fw_exe.srt"
```

- [ ] **Step 4: dev bin/ 갱신** — 새 번들로 교체 (ffmpeg는 유지):

```powershell
Remove-Item -Recurse -Force bin\_internal
Copy-Item -Recurse python\dist\process_video\_internal bin\_internal
Copy-Item -Force python\dist\process_video\process_video.exe bin\process_video.exe
```

- [ ] **Step 5: (선택) 앱 스모크** — `npm start` 후 CrisperWhisper 엔진으로 짧은 비디오 1건 처리, UI 옵션 전환 동작 확인

---

### Task 6: 코드 리뷰 + 마무리

- [ ] superpowers:code-reviewer 서브에이전트로 스펙/계획 대비 리뷰
- [ ] 리뷰 지적 반영 후 재검증 (`pytest` + 필요 시 E2E 재실행)
- [ ] 미커밋 변경 없는지 `git status` 확인

## Self-Review 결과

- 스펙 커버리지: 파이프라인(T1), UI(T2), 엔진 v3·문서·라이선스 고지(T3), 검증(T4/T5) — 전부 매핑됨
- 타입/시그니처 일관성: `cwMode`(JS) ↔ `--cw-mode`(CLI) ↔ `cw_mode`(Python); `cw_words_to_segments(words, full_text)` 테스트와 구현 일치
- 릴리스 업로드는 의도적으로 범위 제외 (사용자 결정) — CHANGELOG와 빌드 스크립트 출력에 순서 명시

---

## 구현 결과 노트 (사후 기록, 2026-08-20)

리뷰 과정에서 계획과 달라진 사항:

- **turbo/large → large-v3 리맵 제거** (Task 1): faster-whisper·openai-whisper 모두 `turbo`/`large`를 네이티브 지원 — 리맵은 turbo 무음 강등 회귀라 삭제.
- **재시도 구조 재설계** (Task 1): 언어/크기 정규화·모델 다운로드를 재시도 범위 밖으로, CPU 재시도는 except 블록 밖에서 실행(트레이스백의 GPU 모델 참조 해제), `_release_torch_vram`은 `_RELEASED` 센티널로 전역 non-None 유지(os._exit 가드 보존). 무발화 시 RuntimeError 대신 빈 목록 반환.
- **UI 언어 폴백 en → ko, 표시 전용** (Task 2): localStorage 미저장으로 엔진 왕복 시 auto 복원. 구버전 엔진 디렉토리 자동 정리 + 설치 검증 게이트를 현재 버전 디렉토리 특정으로 강화.
- **의존성 폐쇄 보강** (Task 3): requirements.txt에 openai-whisper/nvidia-cublas-cu12(<13)/nvidia-cudnn-cu12(<10) 추가, torch==2.8.0+cu128 정확 핀, 미사용 deep-translator 제거. spec은 미설치 패키지 하드 실패 `collect()` 헬퍼 + torch .lib/헤더 2.7GB 스트립. 산출물은 `dist-engine\`으로 분리.
- **E2E가 잡은 기존 결함 2건 수정** (Task 4 후): ffmpeg 슬래시 상대경로 normpath 정규화, os._exit(0)이 SystemExit(1)을 삼키던 종료 코드 보존.
- **한국어 포함 .ps1은 UTF-8 BOM 필수**: BOM 없으면 PowerShell 5.1이 CP949로 오독해 파싱 실패.

검증 실측 (RTX 5060 8GB): CW large fp16 GPU 피크 VRAM 7,656/8,151MiB, 2초 무음 경계 분할 정상, intended/verbatim/faster-whisper 회귀/무음 exit 1 전부 통과.
