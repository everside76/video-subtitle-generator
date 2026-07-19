/**
 * 엔진(음성 인식 번들) 설치/관리.
 *
 * 6GB급 PyInstaller 엔진은 앱 설치본과 분리되어
 * GitHub Release(engine-v<N> 태그)에서 최초 1회만 다운로드된다.
 * 설치 위치: %LOCALAPPDATA%\VideoSubtitleGenerator\engine-v<N>\
 *
 * 무결성: 매니페스트의 파트별 SHA256으로 검증하고, 손상된 파트만 재다운로드.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const ENGINE_VERSION = 2;
const REPO = 'everside76/video-subtitle-generator';
const RELEASE_BASE = `https://github.com/${REPO}/releases/download/engine-v${ENGINE_VERSION}`;
const PART_RETRIES = 3;

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

/** Electron 메인 프로세스면 Chromium 네트워크 스택(net.fetch) 사용 (더 견고) */
function getFetch() {
  try {
    const { net } = require('electron');
    if (net && net.fetch) return net.fetch.bind(net);
  } catch { /* Electron 외 환경 */ }
  return fetch;
}

async function fetchJson(url) {
  const res = await getFetch()(url, { redirect: 'follow', cache: 'no-store' });
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status}): ${url}`);
  return res.json();
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', (c) => hash.update(c));
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 파트가 이미 존재하고 크기+해시가 맞으면 true (재다운로드 생략) */
async function isPartValid(dest, part) {
  try {
    const stat = fs.statSync(dest);
    if (stat.size !== part.size) return false;
    return (await sha256File(dest)) === part.sha256;
  } catch {
    return false;
  }
}

async function downloadFile(url, dest, onBytes) {
  const res = await getFetch()(url, { redirect: 'follow', cache: 'no-store' });
  if (!res.ok) throw new Error(`다운로드 실패 (${res.status}): ${url}`);
  const out = fs.createWriteStream(dest);
  const reader = Readable.fromWeb(res.body);
  reader.on('data', (chunk) => onBytes(chunk.length));
  await pipeline(reader, out);
}

/** 파트 다운로드 + 해시 검증, 실패 시 재시도 */
async function downloadPart(part, dest, onBytes, report) {
  for (let attempt = 1; attempt <= PART_RETRIES; attempt++) {
    try {
      await downloadFile(`${RELEASE_BASE}/${part.name}`, dest, onBytes);
      const stat = fs.statSync(dest);
      if (stat.size !== part.size) {
        throw new Error(`크기 불일치 (${stat.size} != ${part.size})`);
      }
      const hash = await sha256File(dest);
      if (hash !== part.sha256) {
        throw new Error(`해시 불일치 (기대 ${part.sha256.slice(0, 12)}…, 실제 ${hash.slice(0, 12)}…)`);
      }
      return;
    } catch (err) {
      fs.rmSync(dest, { force: true });
      if (attempt === PART_RETRIES) {
        throw new Error(`${part.name} 다운로드 실패 (${PART_RETRIES}회 시도): ${err.message}`);
      }
      report('download', null, `${part.name} 손상/실패 — 재시도 ${attempt + 1}/${PART_RETRIES}...`);
    }
  }
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
function extractWithTar(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const tarExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const proc = spawn(tarExe, ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar 해제 실패 (코드 ${code}): ${err.slice(0, 300)}`));
    });
    proc.on('error', reject);
  });
}

/** 폴백: PowerShell(.NET) Expand-Archive */
function extractWithPowerShell(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ], { windowsHide: true });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`압축 해제 실패 (코드 ${code}): ${err.slice(0, 300)}`));
    });
    proc.on('error', reject);
  });
}

/**
 * 엔진 다운로드 + 검증 + 설치.
 * onProgress({phase, percent, message}) 로 진행률 보고.
 */
async function installEngine(onProgress) {
  let lastPercent = 0;
  const report = (phase, percent, message) => {
    if (percent !== null && percent !== undefined) lastPercent = percent;
    onProgress({ phase, percent: lastPercent, message });
  };

  report('manifest', 0, '엔진 정보 확인 중...');
  const manifest = await fetchJson(`${RELEASE_BASE}/engine-manifest.json`);
  // { version, totalSize, zipSha256, parts: [{name, size, sha256}] }

  const tmpDir = path.join(getEngineRoot(), 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const totalSize = manifest.totalSize || 0;
  let downloaded = 0;
  const partPaths = [];

  for (let i = 0; i < manifest.parts.length; i++) {
    const part = manifest.parts[i];
    const dest = path.join(tmpDir, part.name);
    partPaths.push(dest);

    report('verify', Math.round((downloaded / totalSize) * 75),
      `기존 파일 확인 중... (${i + 1}/${manifest.parts.length})`);
    if (await isPartValid(dest, part)) {
      downloaded += part.size;
      report('download', Math.round((downloaded / totalSize) * 75),
        `${part.name} 이미 다운로드됨 — 건너뜀`);
      continue;
    }

    const baseDownloaded = downloaded;
    await downloadPart(part, dest, (n) => {
      downloaded += n;
      report('download', Math.round((downloaded / totalSize) * 75),
        `엔진 다운로드 중... (${(downloaded / 1e9).toFixed(2)} / ${(totalSize / 1e9).toFixed(2)} GB)`);
    }, (phase, pct, msg) => {
      downloaded = baseDownloaded; // 재시도 시 진행률 롤백
      report(phase, Math.round((downloaded / totalSize) * 75), msg);
    });
    downloaded = baseDownloaded + part.size;
  }

  report('merge', 78, '파일 병합 중...');
  const zipPath = path.join(tmpDir, 'engine.zip');
  fs.rmSync(zipPath, { force: true });
  if (partPaths.length === 1) {
    fs.renameSync(partPaths[0], zipPath);
  } else {
    await concatFiles(partPaths, zipPath);
  }

  report('merge', 82, '병합 파일 무결성 검증 중...');
  if (manifest.zipSha256) {
    const zipHash = await sha256File(zipPath);
    if (zipHash !== manifest.zipSha256) {
      fs.rmSync(zipPath, { force: true });
      throw new Error('병합 파일 해시 불일치 — 다시 시도해 주세요 (받은 파트는 재사용됩니다).');
    }
  }

  report('extract', 85, '압축 해제 중... (수 분 소요)');
  const dest = getEngineDir();
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  try {
    await extractWithTar(zipPath, dest);
  } catch (tarErr) {
    report('extract', 86, 'tar 해제 실패 — 대체 방식으로 재시도 중...');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    await extractWithPowerShell(zipPath, dest);
  }

  if (!isEngineInstalled()) {
    throw new Error('엔진 설치 확인 실패: 필수 파일이 없습니다.');
  }

  report('cleanup', 98, '정리 중...');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  report('done', 100, '엔진 설치 완료');
}

module.exports = {
  ENGINE_VERSION,
  getEngineDir,
  findEngineDir,
  isEngineInstalled,
  installEngine,
};
