# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, copy_metadata


def collect(name):
    """미설치 패키지의 collect_all은 조용히 빈 결과를 반환하므로 하드 실패로 전환."""
    import importlib.util
    if importlib.util.find_spec(name) is None:
        raise SystemExit(f"[spec] required package not installed: {name}")
    return collect_all(name)


datas = []
binaries = []
hiddenimports = ['charset_normalizer', 'chardet']
tmp_ret = collect('charset_normalizer')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect('ctranslate2')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect('faster_whisper')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect('nvidia.cublas')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect('nvidia.cudnn')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect('whisper')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect('tiktoken')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect('tokenizers')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
# PyTorch is required by OpenAI Whisper; audio decoding uses PyAV/ffmpeg.
tmp_ret = collect('torch')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
datas += copy_metadata('torch')
datas += copy_metadata('tokenizers')
datas += copy_metadata('huggingface_hub')
datas += copy_metadata('numpy')
# Runtime package metadata.
datas += copy_metadata('tqdm')
datas += copy_metadata('regex')
datas += copy_metadata('requests')
datas += copy_metadata('packaging')
datas += copy_metadata('filelock')
datas += copy_metadata('pyyaml')


a = Analysis(
    ['engine_loader.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Prevent optional converter/audio imports from restoring retired engines.
    excludes=['whisperx', 'crisperwhisper', 'transformers', 'accelerate',
              'torchaudio', 'torchcodec', 'torchvision', 'soundfile', 'soxr',
              'pytorch_lightning', 'lightning_fabric', 'matplotlib', 'pandas',
              'sklearn', 'IPython', 'jedi'],
    noarchive=False,
    optimize=0,
)


def _strip_buildtime_artifacts(entries):
    """torch 정적 .lib / C++ 헤더는 런타임 무용 (~2.5GB) — 배포 번들에서 제외."""
    out = []
    for dest, src, kind in entries:
        p = dest.replace('\\', '/')
        if p.endswith('.lib') or p.startswith('torch/include/'):
            continue
        out.append((dest, src, kind))
    return out


a.datas = _strip_buildtime_artifacts(a.datas)
a.binaries = _strip_buildtime_artifacts(a.binaries)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='process_video',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='process_video',
)
