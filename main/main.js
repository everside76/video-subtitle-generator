const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const subtitleOps = require('./subtitle-operations');

let mainWindow;
let splashWindow;

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
  return new Promise((resolve, reject) => {
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
});

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

app.whenReady().then(() => {
  createSplashWindow();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createSplashWindow();
    createWindow();
  }
});
