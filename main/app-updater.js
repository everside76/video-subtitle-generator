// Keep update state in the main process so renderer reloads cannot lose it.
function createAppUpdater({ updater, packaged, notify = () => {}, isBusy = () => false }) {
  let status = { state: packaged && updater ? 'idle' : 'disabled' };
  let checking = false;
  let startupTimer;
  let intervalTimer;

  const getStatus = () => ({ ...status });
  const publish = (next) => {
    status = next;
    notify(getStatus());
  };
  const fail = (error) => publish({
    state: 'error', message: error?.message || '업데이트 서버에 연결할 수 없습니다.',
  });

  if (packaged && updater) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.on('checking-for-update', () => publish({ state: 'checking' }));
    updater.on('update-not-available', () => publish({ state: 'current' }));
    updater.on('update-available', (info) => publish({
      state: 'downloading', version: info.version, percent: 0,
    }));
    updater.on('download-progress', (progress) => publish({
      state: 'downloading', version: status.version,
      percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
    }));
    updater.on('update-downloaded', (info) => publish({
      state: 'ready', version: info.version, percent: 100,
    }));
    updater.on('error', fail);
  }

  async function check() {
    if (!packaged || !updater || checking
        || ['downloading', 'ready', 'installing'].includes(status.state)) return getStatus();
    checking = true;
    publish({ state: 'checking' });
    try {
      const result = await updater.checkForUpdates();
      // Automatic download has its own promise; observe failures as well as
      // updater events to avoid an unhandled rejection on a broken connection.
      if (result?.downloadPromise) result.downloadPromise.catch(fail);
    } catch (error) {
      fail(error);
    } finally {
      checking = false;
    }
    return getStatus();
  }

  function install() {
    if (status.state !== 'ready') {
      return { ok: false, message: '다운로드된 업데이트가 없습니다.' };
    }
    if (isBusy()) {
      return { ok: false, message: '자막 생성·번역 또는 엔진 설치가 끝난 뒤 다시 눌러 주세요.' };
    }
    publish({ ...status, state: 'installing' });
    try {
      updater.quitAndInstall(false, true);
      if (status.state === 'error') return { ok: false, message: status.message };
      return { ok: true };
    } catch (error) {
      fail(error);
      return { ok: false, message: error.message };
    }
  }

  function start() {
    if (!packaged || !updater || intervalTimer) return;
    startupTimer = setTimeout(() => { void check(); }, 5000);
    intervalTimer = setInterval(() => { void check(); }, 4 * 60 * 60 * 1000);
    startupTimer.unref?.();
    intervalTimer.unref?.();
  }

  function stop() {
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
    startupTimer = intervalTimer = undefined;
  }

  return { getStatus, check, install, start, stop };
}

module.exports = { createAppUpdater };
