const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const engineManager = require('./engine-manager');
const translator = require('./translator');

let currentProcess = null;

/** 엔진 디렉토리 (LocalAppData 설치본 → legacy resources/bin → dev bin/) */
function getBinDir() {
  return engineManager.findEngineDir() || path.join(__dirname, '..', 'bin');
}

function getProcessVideoExe() {
  return path.join(getBinDir(), 'process_video.exe');
}

function getFfmpegPath() {
  return path.join(getBinDir(), 'ffmpeg.exe');
}

/**
 * 파이프라인 스크립트 디렉토리.
 * 엔진 exe는 얇은 로더라서 실제 .py 스크립트는 앱이 제공한다.
 * 패키징 후: resources/engine-scripts, 개발 모드: python/
 */
function getScriptsDir() {
  const packed = path.join(process.resourcesPath || '', 'engine-scripts');
  if (fs.existsSync(path.join(packed, 'process_video.py'))) return packed;
  return path.join(__dirname, '..', 'python');
}

function processVideo(videoPath, options, onProgress, onComplete, onError) {
  const exePath = getProcessVideoExe();

  if (!fs.existsSync(exePath)) {
    onError(new Error('process_video.exe를 찾을 수 없습니다.'));
    return null;
  }

  const args = [
    videoPath,
    '--engine', options.engine || 'faster-whisper',
    '--model', options.model || 'large-v3',
    '--ffmpeg', getFfmpegPath(),
    '--device', options.device || 'auto',
    '--language', options.language || 'auto',
    '--cw-mode', options.cwMode || 'intended',
  ];

  if (options.output) {
    args.push('--output', options.output);
  }

  const proc = spawn(exePath, args, {
    windowsHide: true,
    env: {
      ...process.env,
      PATH: getBinDir() + ';' + process.env.PATH,
      VSG_SCRIPTS_DIR: getScriptsDir(),
    },
  });

  currentProcess = proc;
  let buffer = '';
  let completed = false;  // complete 메시지를 받았는지 추적

  proc.stdout.on('data', (data) => {
    buffer += data.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.stage === 'complete') {
          completed = true;
          currentProcess = null;
          finishWithTranslation(msg.result, options, onProgress, onComplete);
        } else if (msg.stage === 'error') {
          currentProcess = null;
          onError(new Error(msg.message));
        } else {
          onProgress(msg);
        }
      } catch (e) {
        // JSON이 아닌 출력은 무시
      }
    }
  });

  // stderr는 진단 로그 파일로 저장하고, 실패 시 마지막 줄을 오류에 포함
  let stderrTail = '';
  let logStream = null;
  try {
    const { app } = require('electron');
    logStream = fs.createWriteStream(path.join(app.getPath('userData'), 'engine.log'));
    logStream.write(`[${new Date().toISOString()}] ${videoPath}\nargs: ${args.join(' ')}\n\n`);
  } catch { /* 로그 실패는 무시 */ }

  proc.stderr.on('data', (data) => {
    const text = data.toString('utf-8');
    stderrTail = (stderrTail + text).slice(-2000);
    if (logStream) logStream.write(text);
  });

  proc.on('close', (code) => {
    currentProcess = null;
    if (logStream) logStream.end(`\n[exit code: ${code}]\n`);
    // 이미 complete를 받았으면 종료 코드 무시 (CUDA 정리 시 크래시 가능)
    if (!completed && code !== 0 && code !== null) {
      const tail = stderrTail.trim().split('\n').slice(-3).join('\n');
      onError(new Error(
        `프로세스가 종료되었습니다 (코드: ${code})${tail ? '\n' + tail : ''}`));
    }
  });

  proc.on('error', (err) => {
    currentProcess = null;
    onError(err);
  });

  return proc;
}

/** 외국어 음성이면 SRT를 한국어로 번역한 뒤 완료 처리 */
async function finishWithTranslation(result, options, onProgress, onComplete) {
  const mode = options.translate || 'ko'; // 'ko' | 'both' | 'off'
  if (mode !== 'off' && result && result.language && result.language !== 'ko') {
    try {
      onProgress({ stage: 'generating', progress: 99, message: '한국어 번역 중...' });
      const stats = await translator.translateSrtFile(result.srt_path, mode, (done, total) => {
        onProgress({
          stage: 'generating', progress: 99,
          message: `한국어 번역 중... (${done}/${total})`,
        });
      });
      if (stats.failed > 0) {
        onProgress({
          stage: 'warning', progress: 99,
          message: `번역 ${stats.failed}건 실패 — 해당 자막은 원문 유지`,
        });
      }
    } catch (err) {
      onProgress({
        stage: 'warning', progress: 99,
        message: '번역 실패(' + err.message + ') — 원문 자막으로 저장됨',
      });
    }
  }
  onComplete(result);
}

function cancelProcessing() {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
    return true;
  }
  return false;
}

function checkDependencies() {
  return new Promise((resolve) => {
    const exePath = getProcessVideoExe();
    const ffmpegPath = getFfmpegPath();

    const results = {
      processVideo: fs.existsSync(exePath),
      ffmpeg: fs.existsSync(ffmpegPath),
    };

    // process_video.exe가 실제로 실행되는지 확인
    if (results.processVideo) {
      const proc = spawn(exePath, ['--help'], { windowsHide: true });
      proc.on('close', (code) => {
        results.processVideo = code === 0;
        resolve(results);
      });
      proc.on('error', () => {
        results.processVideo = false;
        resolve(results);
      });
    } else {
      resolve(results);
    }
  });
}

/** 파일 존재 여부만 확인하는 빠른 버전 (시작 시 사용) */
function checkDependenciesFast() {
  return {
    processVideo: fs.existsSync(getProcessVideoExe()),
    ffmpeg: fs.existsSync(getFfmpegPath()),
  };
}

module.exports = { processVideo, cancelProcessing, checkDependencies, checkDependenciesFast };
