/**
 * 엔진(음성 인식 번들) 설치/관리.
 *
 * 6GB급 PyInstaller 엔진은 앱 설치본과 분리되어
 * GitHub Release(engine-v<N> 태그)에서 최초 1회만 다운로드된다.
 * 설치 위치: %LOCALAPPDATA%\VideoSubtitleGenerator\engine-v<N>\
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ENGINE_VERSION = 2;
const REPO = 'everside76/video-subtitle-generator';
const RELEASE_BASE = `https://github.com/${REPO}/releases/download/engine-v${ENGINE_VERSION}`;

function getEngineRoot() {
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'VideoSubtitleGenerator');
}

function getEngineDir() {
  return path.join(getEngineRoot(), `engine-v${ENGINE_VERSION}`);
}

/** 설치된 엔진 디렉토리 탐색: LocalAppData → (legacy) resources/bin → dev bin/ */
function findEngineDir() {
  const candidates = [
    getEngineDir(),
    path.join(process.resourcesPath || '', 'bin'),
    path.join(__dirname, '..', 'bin'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'process_video.exe'))
      && fs.existsSync(path.join(dir, 'ffmpeg.exe'))) {
      return dir;
    }
  }
  return null;
}

function isEngineInstalled() {
  return findEngineDir() !== null;
}

async function fetchJson(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status}): ${url}`);
  return res.json();
}

async function downloadFile(url, dest, onBytes) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status}): ${url}`);
  const out = fs.createWriteStream(dest);
  const reader = Readable.fromWeb(res.body);
  reader.on('data', (chunk) => onBytes(chunk.length));
  await pipeline(reader, out);
}

function concatFiles(parts, dest) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    let i = 0;
    const next = () => {
      if (i >= parts.length) { out.end(); return; }
      const rs = fs.createReadStream(parts[i++]);
      rs.on('error', reject);
      rs.pipe(out, { end: false });
      rs.on('end', next);
    };
    out.on('finish', resolve);
    out.on('error', reject);
    next();
  });
}

/** Windows 내장 bsdtar로 zip 해제 */
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`압축 해제 실패 (코드 ${code}): ${err.slice(0, 500)}`));
    });
    proc.on('error', reject);
  });
}

/**
 * 엔진 다운로드 + 설치.
 * onProgress({phase, percent, message}) 로 진행률 보고.
 */
async function installEngine(onProgress) {
  const report = (phase, percent, message) => onProgress({ phase, percent, message });

  report('manifest', 0, '엔진 정보 확인 중...');
  const manifest = await fetchJson(`${RELEASE_BASE}/engine-manifest.json`);
  // manifest: { version, totalSize, parts: ["engine.zip.001", ...] }

  const tmpDir = path.join(getEngineRoot(), 'tmp');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  let downloaded = 0;
  const totalSize = manifest.totalSize || 0;
  const partPaths = [];
  for (let i = 0; i < manifest.parts.length; i++) {
    const name = manifest.parts[i];
    const dest = path.join(tmpDir, name);
    partPaths.push(dest);
    report('download', totalSize ? Math.round((downloaded / totalSize) * 80) : 0,
      `엔진 다운로드 중... (${i + 1}/${manifest.parts.length})`);
    await downloadFile(`${RELEASE_BASE}/${name}`, dest, (n) => {
      downloaded += n;
      if (totalSize) {
        report('download', Math.round((downloaded / totalSize) * 80),
          `엔진 다운로드 중... (${(downloaded / 1e9).toFixed(2)} / ${(totalSize / 1e9).toFixed(2)} GB)`);
      }
    });
  }

  report('extract', 82, '파일 병합 중...');
  const zipPath = path.join(tmpDir, 'engine.zip');
  if (partPaths.length === 1) {
    fs.renameSync(partPaths[0], zipPath);
  } else {
    await concatFiles(partPaths, zipPath);
    partPaths.forEach((p) => fs.rmSync(p, { force: true }));
  }

  report('extract', 85, '압축 해제 중... (수 분 소요)');
  const dest = getEngineDir();
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  await extractZip(zipPath, dest);

  report('cleanup', 98, '정리 중...');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (!isEngineInstalled()) {
    throw new Error('엔진 설치 확인 실패: 필수 파일이 없습니다.');
  }
  report('done', 100, '엔진 설치 완료');
}

module.exports = {
  ENGINE_VERSION,
  getEngineDir,
  findEngineDir,
  isEngineInstalled,
  installEngine,
};
