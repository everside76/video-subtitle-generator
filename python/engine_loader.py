"""PyInstaller 엔진 로더 (얇은 진입점).

실제 파이프라인 스크립트(process_video.py 등)는 번들 밖에서 로드한다.
→ 파이프라인 코드 수정 시 엔진 재빌드 없이 앱 업데이트만으로 반영됨.

스크립트 탐색 순서:
1. VSG_SCRIPTS_DIR 환경변수 (Electron이 앱 리소스 경로를 지정)
2. exe 옆의 scripts/ 폴더
"""

import sys
import os
import json
import runpy

# PyInstaller가 파이프라인 스크립트의 stdlib 의존성을 번들에 포함하도록 명시
import argparse          # noqa: F401
import subprocess        # noqa: F401
import tempfile          # noqa: F401
import gc                # noqa: F401
import atexit            # noqa: F401
import traceback         # noqa: F401
import multiprocessing


def _scripts_dir():
    d = os.environ.get("VSG_SCRIPTS_DIR")
    if d and os.path.isfile(os.path.join(d, "process_video.py")):
        return d
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    d2 = os.path.join(exe_dir, "scripts")
    if os.path.isfile(os.path.join(d2, "process_video.py")):
        return d2
    return None


if __name__ == "__main__":
    multiprocessing.freeze_support()
    scripts = _scripts_dir()
    if scripts is None:
        print(json.dumps({
            "stage": "error", "progress": 0,
            "message": "엔진 스크립트를 찾을 수 없습니다 (VSG_SCRIPTS_DIR 또는 scripts 폴더)",
        }, ensure_ascii=False), flush=True)
        sys.exit(1)
    sys.path.insert(0, scripts)
    runpy.run_path(os.path.join(scripts, "process_video.py"), run_name="__main__")
