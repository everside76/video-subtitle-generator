@echo off
chcp 65001 >nul
echo === 비디오 자막 생성기 설치 ===
echo.

REM Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [오류] Python이 설치되어 있지 않습니다. Python 3.10 이상을 설치해주세요.
    pause
    exit /b 1
)

REM Check ffmpeg
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [오류] ffmpeg가 설치되어 있지 않습니다. ffmpeg를 설치해주세요.
    pause
    exit /b 1
)

REM Create venv
echo Python 가상 환경 생성 중...
cd /d "%~dp0\..\python"
python -m venv .venv

REM Activate and install
echo 의존성 설치 중...
call .venv\Scripts\activate.bat
pip install -r requirements.txt

REM Verify
echo.
echo 설치 확인 중...
python -c "from faster_whisper import WhisperModel; print('[OK] faster-whisper')"
python -c "import whisper; print('[OK] openai-whisper')"
python -c "import torch; print('[OK] torch', torch.__version__, 'CUDA:', torch.cuda.is_available())"
python -c "import crisperwhisper; print('[OK] crisperwhisper', crisperwhisper.__version__)"

echo.
echo === 설치 완료! ===
echo.

REM Install npm deps
cd /d "%~dp0\.."
call npm install

echo.
echo 실행: npm start
pause
