const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const subtitleOps = require('./subtitle-operations');
const engineManager = require('./engine-manager');
const { createAppUpdater } = require('./app-updater');

let mainWindow;
let splashWindow;
let appUpdater;
let activeJobs = 0;
let queueRunning = false;

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 300,
    frame: false,
    resizable: false,
    skipTaskbar: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  splashWindow.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
  splashWindow.center();
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 700,
    minHeight: 500,
    title: '비디오 자막 생성기',
    show: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  const menu = Menu.buildFromTemplate(getMenuTemplate());
  Menu.setApplicationMenu(menu);

  // 메인 윈도우 준비 완료 시 스플래시 닫고 표시
  mainWindow.once('ready-to-show', () => {
    closeSplash();
    mainWindow.show();
  });

  // 안전장치: 5초 후에도 표시되지 않으면 강제 표시
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      closeSplash();
      mainWindow.show();
    }
  }, 5000);
}

function getMenuTemplate() {
  return [
    {
      label: '파일',
      submenu: [
        { label: '비디오 열기', accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu-open') },
        { type: 'separator' },
        { label: '종료', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '개발자 도구', accelerator: 'F12', click: () => mainWindow.webContents.toggleDevTools() },
        { label: '새로 고침', accelerator: 'F5', click: () => mainWindow.webContents.reload() },
      ],
    },
    {
      label: '도움말',
      submenu: [{ label: '업데이트 확인', click: () => appUpdater?.check() }],
    },
  ];
}

// IPC: 비디오 파일 열기 다이얼로그 (복수 선택)
ipcMain.handle('open-video-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '비디오 파일 열기',
    filters: [
      { name: '비디오 파일', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'flv'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) return [];
  return result.filePaths;
});

// IPC: 비디오 처리 시작
ipcMain.handle('process-video', async (event, { videoPath, options }) => {
  if (appUpdater?.getStatus().state === 'installing') throw new Error('업데이트를 적용하고 있습니다.');
  activeJobs++;
  try {
    return await new Promise((resolve, reject) => {
      subtitleOps.processVideo(
        videoPath,
        options || {},
        (progress) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('processing-progress', progress);
          }
        },
        (result) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('processing-complete', result);
          }
          resolve(result);
        },
        (error) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('processing-error', { message: error.message });
          }
          reject(error);
        }
      );
    });
  } finally {
    activeJobs--;
  }
});

ipcMain.on('queue-running', (_event, running) => { queueRunning = running === true; });
ipcMain.handle('app-update-status', () => appUpdater?.getStatus() || { state: 'disabled' });
ipcMain.handle('app-update-check', () => appUpdater?.check() || { state: 'disabled' });
ipcMain.handle('app-update-install', () => appUpdater?.install()
  || { ok: false, message: '설치된 앱에서 업데이트를 사용할 수 있습니다.' });

// IPC: 처리 취소
ipcMain.handle('cancel-processing', () => {
  return subtitleOps.cancelProcessing();
});

// IPC: SRT 다른 이름으로 저장
ipcMain.handle('save-srt-as', async (event, { content }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'SRT 파일 저장',
    filters: [{ name: 'SRT 자막 파일', extensions: ['srt'] }],
    defaultPath: 'subtitle.srt',
  });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, content, 'utf-8');
  return result.filePath;
});

// IPC: 의존성 체크 (파일 존재 여부만)
ipcMain.handle('check-dependencies', () => {
  return subtitleOps.checkDependenciesFast();
});

// IPC: 엔진 설치 상태
ipcMain.handle('engine-status', () => {
  return {
    installed: engineManager.isEngineInstalled(),
    version: engineManager.ENGINE_VERSION,
    dir: engineManager.findEngineDir(),
  };
});

// IPC: 엔진 다운로드 + 설치
let engineInstalling = false;
ipcMain.handle('engine-install', async () => {
  if (appUpdater?.getStatus().state === 'installing') {
    return { ok: false, message: '업데이트를 적용하고 있습니다.' };
  }
  if (engineInstalling) return { ok: false, message: '이미 설치 진행 중입니다.' };
  engineInstalling = true;
  try {
    await engineManager.installEngine((progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('engine-progress', progress);
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  } finally {
    engineInstalling = false;
  }
});

// ===== 앱 자동 업데이트 (GitHub Releases) =====
function setupAutoUpdater() {
  let autoUpdater;
  if (app.isPackaged) {
    ({ autoUpdater } = require('electron-updater'));
  }
  appUpdater = createAppUpdater({
    updater: autoUpdater,
    packaged: app.isPackaged,
    isBusy: () => activeJobs > 0 || queueRunning || engineInstalling,
    notify: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-update', status);
      }
    },
  });
  appUpdater.start();
}

app.whenReady().then(() => {
  createSplashWindow();
  createWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => appUpdater?.stop());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createSplashWindow();
    createWindow();
  }
});
