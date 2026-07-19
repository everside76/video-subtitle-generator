const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const engineManager = require('./engine-manager');

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
          onComplete(msg.result);
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

  proc.stderr.on('data', () => {
    // stderr는 모델 로딩 등의 로그 → 무시
  });

  proc.on('close', (code) => {
    currentProcess = null;
    // 이미 complete를 받았으면 종료 코드 무시 (CUDA 정리 시 크래시 가능)
    if (!completed && code !== 0 && code !== null) {
      onError(new Error(`프로세스가 종료되었습니다 (코드: ${code})`));
    }
  });

  proc.on('error', (err) => {
    currentProcess = null;
    onError(err);
  });

  return proc;
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
