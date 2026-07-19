const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// ===== DOM 요소 =====
const dropZone = document.getElementById('drop-zone');
const processingView = document.getElementById('processing-view');
const resultView = document.getElementById('result-view');
const depWarning = document.getElementById('dep-warning');
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const progressFill = document.getElementById('progress-fill');
const progressMessage = document.getElementById('progress-message');
const cancelBtn = document.getElementById('cancel-btn');
const saveAsBtn = document.getElementById('save-as-btn');
const newVideoBtn = document.getElementById('new-video-btn');
const srtPreview = document.getElementById('srt-preview');

// 큐 관련 DOM
const queueList = document.getElementById('queue-list');
const queueCount = document.getElementById('queue-count');
const queueAddBtn = document.getElementById('queue-add-btn');
const queueClearBtn = document.getElementById('queue-clear-btn');
const queueStartBtn = document.getElementById('queue-start-btn');
const queueStopBtn = document.getElementById('queue-stop-btn');

// 버전/업데이트 이력 DOM
const appVersion = document.getElementById('app-version');
const changelogOverlay = document.getElementById('changelog-overlay');
const changelogClose = document.getElementById('changelog-close');
const changelogContent = document.getElementById('changelog-content');

// ===== 상태 =====
let queue = [];           // { id, filePath, fileName, fileSize, status, result, error, srtContent }
let idCounter = 0;
let isRunning = false;    // 큐 순차 처리 중인지
let stopRequested = false;
let selectedItemId = null;
let currentProcessingId = null;

// ===== 설정 토글 =====
settingsToggle.addEventListener('click', () => {
  settingsPanel.classList.toggle('visible');
});

// ===== 뷰 전환 =====
function showView(view) {
  dropZone.style.display = 'none';
  processingView.classList.remove('visible');
  resultView.classList.remove('visible');
  depWarning.classList.remove('visible');

  switch (view) {
    case 'drop':
      dropZone.style.display = 'flex';
      break;
    case 'processing':
      processingView.classList.add('visible');
      break;
    case 'result':
      resultView.classList.add('visible');
      break;
    case 'dep-warning':
      depWarning.classList.add('visible');
      break;
  }
}

// ===== 유틸리티 =====
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function isVideoFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.wmv', '.flv'].includes(ext);
}

// ===== 큐 관리 =====
function addToQueue(filePath) {
  // 중복 방지
  if (queue.some(item => item.filePath === filePath)) return;

  let fileSize = 0;
  try { fileSize = fs.statSync(filePath).size; } catch {}

  const item = {
    id: ++idCounter,
    filePath,
    fileName: path.basename(filePath),
    fileSize,
    status: 'pending',   // pending | processing | done | error
    result: null,
    error: null,
    srtContent: null,
  };
  queue.push(item);
  renderQueue();
  updateButtons();
}

function removeFromQueue(id) {
  // 처리 중인 항목은 제거 불가
  if (id === currentProcessingId) return;
  queue = queue.filter(item => item.id !== id);
  if (selectedItemId === id) {
    selectedItemId = null;
    showView('drop');
  }
  renderQueue();
  updateButtons();
}

function clearQueue() {
  if (isRunning) return;
  queue = [];
  selectedItemId = null;
  showView('drop');
  renderQueue();
  updateButtons();
}

function getQueueItem(id) {
  return queue.find(item => item.id === id);
}

// ===== 큐 렌더링 =====
function renderQueue() {
  queueList.innerHTML = '';
  const pendingCount = queue.filter(i => i.status === 'pending').length;
  const doneCount = queue.filter(i => i.status === 'done').length;
  const totalCount = queue.length;
  queueCount.textContent = `(${doneCount}/${totalCount})`;

  queue.forEach(item => {
    const el = document.createElement('div');
    el.className = `queue-item ${item.status}`;
    if (item.id === selectedItemId) el.classList.add('selected');

    const statusIcons = {
      pending: '-',
      processing: '...',
      done: '\u2713',
      error: '!',
    };

    el.innerHTML = `
      <div class="qi-status">${statusIcons[item.status]}</div>
      <div class="qi-info">
        <div class="qi-name" title="${item.fileName}">${item.fileName}</div>
        <div class="qi-detail">${getItemDetail(item)}</div>
      </div>
      <button class="qi-remove" data-id="${item.id}" title="제거">\u00d7</button>
    `;

    // 클릭 → 결과 보기
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('qi-remove')) return;
      selectItem(item.id);
    });

    // 제거 버튼
    el.querySelector('.qi-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeFromQueue(item.id);
    });

    queueList.appendChild(el);
  });
}

function getItemDetail(item) {
  switch (item.status) {
    case 'pending':
      return formatFileSize(item.fileSize);
    case 'processing':
      return '처리 중...';
    case 'done':
      return `완료 (${item.result?.segments || 0}개 구간)`;
    case 'error':
      return item.error || '오류 발생';
    default:
      return '';
  }
}

function selectItem(id) {
  selectedItemId = id;
  const item = getQueueItem(id);
  if (!item) return;

  renderQueue(); // 선택 상태 갱신

  if (item.status === 'done' && item.result) {
    showItemResult(item);
  } else if (item.status === 'processing') {
    showView('processing');
  } else if (item.status === 'error') {
    showView('drop');
  } else {
    showView('drop');
  }
}

function showItemResult(item) {
  const langNames = {
    en: 'English', ko: '한국어', ja: '日本語', zh: '中文',
    fr: 'Français', de: 'Deutsch', es: 'Español', ru: 'Русский',
    pt: 'Português', it: 'Italiano', ar: 'العربية', hi: 'हिन्दी',
  };

  document.getElementById('res-filename').textContent = item.fileName;
  document.getElementById('res-lang').textContent = langNames[item.result.language] || item.result.language;
  document.getElementById('res-segments').textContent = item.result.segments + '개';
  document.getElementById('res-duration').textContent = item.result.duration || '-';
  document.getElementById('res-device').textContent = item.result.device || 'CPU';

  srtPreview.textContent = item.srtContent || '';
  showView('result');
}

// ===== 버튼 상태 =====
function updateButtons() {
  const hasPending = queue.some(i => i.status === 'pending');
  queueStartBtn.disabled = !hasPending || isRunning;
  queueStopBtn.disabled = !isRunning;
  queueClearBtn.disabled = isRunning;
}

// ===== 파일 추가 (드래그앤드롭 / 클릭 / 메뉴) =====
function addFiles(filePaths) {
  filePaths.forEach(fp => {
    if (isVideoFile(fp)) addToQueue(fp);
  });
}

// 드래그 앤 드롭 (전체 화면)
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('drag-over');
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropZone.classList.remove('drag-over');

  const files = Array.from(e.dataTransfer.files);
  const videoPaths = files.map(f => f.path).filter(isVideoFile);

  if (videoPaths.length > 0) {
    addFiles(videoPaths);
    // 자동으로 전체 시작이 아직 안 됐으면 대기 상태로
  }
});

// 드롭존 클릭
dropZone.addEventListener('click', async () => {
  const filePaths = await ipcRenderer.invoke('open-video-files');
  if (filePaths && filePaths.length > 0) {
    addFiles(filePaths);
  }
});

// 큐 추가 버튼
queueAddBtn.addEventListener('click', async () => {
  const filePaths = await ipcRenderer.invoke('open-video-files');
  if (filePaths && filePaths.length > 0) {
    addFiles(filePaths);
  }
});

// 메뉴에서 열기
ipcRenderer.on('menu-open', async () => {
  const filePaths = await ipcRenderer.invoke('open-video-files');
  if (filePaths && filePaths.length > 0) {
    addFiles(filePaths);
  }
});

// 큐 비우기
queueClearBtn.addEventListener('click', clearQueue);

// ===== 순차 처리 =====
queueStartBtn.addEventListener('click', startQueue);
queueStopBtn.addEventListener('click', stopQueue);

async function startQueue() {
  if (isRunning) return;
  isRunning = true;
  stopRequested = false;
  updateButtons();

  const pendingItems = queue.filter(i => i.status === 'pending');

  for (let idx = 0; idx < pendingItems.length; idx++) {
    if (stopRequested) break;

    const item = pendingItems[idx];
    // 아이템이 이미 큐에서 제거됐을 수 있음
    if (!queue.find(q => q.id === item.id)) continue;

    currentProcessingId = item.id;
    item.status = 'processing';
    selectedItemId = item.id;
    renderQueue();

    // 처리 화면 표시
    showView('processing');
    document.getElementById('proc-filename').textContent = item.fileName;
    document.getElementById('proc-filesize').textContent = formatFileSize(item.fileSize);

    const totalPending = pendingItems.length;
    document.getElementById('proc-queue-label').textContent =
      `작업 ${idx + 1} / ${totalPending}`;

    // 단계 초기화
    document.querySelectorAll('.step').forEach(el => {
      el.classList.remove('active', 'done');
    });
    progressFill.style.width = '0%';
    progressMessage.textContent = '시작 중...';

    const options = {
      engine: document.getElementById('engine-select').value,
      model: document.getElementById('model-select').value,
      device: document.getElementById('device-select').value,
    };

    try {
      const result = await ipcRenderer.invoke('process-video', {
        videoPath: item.filePath,
        options,
      });

      // 완료 처리는 processing-complete 이벤트에서 수행됨
      // 하지만 invoke가 resolve되면 result도 받을 수 있음
    } catch (err) {
      // 에러는 processing-error 이벤트에서 처리됨
    }

    // 다음 항목 처리 전 약간의 지연
    await new Promise(r => setTimeout(r, 300));
  }

  isRunning = false;
  currentProcessingId = null;
  updateButtons();

  // 모든 작업 완료 시 첫 번째 완료 항목 결과 표시
  const firstDone = queue.find(i => i.status === 'done');
  if (firstDone && !stopRequested) {
    selectItem(firstDone.id);
  } else if (!stopRequested) {
    showView('drop');
  }
}

function stopQueue() {
  stopRequested = true;
  // 현재 처리 중인 작업도 취소
  ipcRenderer.invoke('cancel-processing');

  if (currentProcessingId) {
    const item = getQueueItem(currentProcessingId);
    if (item && item.status === 'processing') {
      item.status = 'pending'; // 다시 대기로
      item.error = null;
    }
  }

  isRunning = false;
  currentProcessingId = null;
  renderQueue();
  updateButtons();
  showView('drop');
}

// ===== 진행률 업데이트 =====
const stageOrder = ['extracting', 'transcribing', 'generating'];

ipcRenderer.on('processing-progress', (event, data) => {
  const { stage, progress, message } = data;

  progressFill.style.width = progress + '%';
  if (message) progressMessage.textContent = message;

  const currentIdx = stageOrder.indexOf(stage);
  document.querySelectorAll('.step').forEach(el => {
    const stepStage = el.getAttribute('data-stage');
    const stepIdx = stageOrder.indexOf(stepStage);
    if (stepIdx < currentIdx) {
      el.classList.remove('active');
      el.classList.add('done');
    } else if (stepIdx === currentIdx) {
      el.classList.add('active');
      el.classList.remove('done');
    } else {
      el.classList.remove('active', 'done');
    }
  });
});

// ===== 처리 완료 =====
ipcRenderer.on('processing-complete', (event, result) => {
  if (!currentProcessingId) return;

  const item = getQueueItem(currentProcessingId);
  if (!item) return;

  item.status = 'done';
  item.result = result;

  // SRT 파일 읽기
  try {
    item.srtContent = fs.readFileSync(result.srt_path, 'utf-8');
  } catch {
    item.srtContent = '';
  }

  renderQueue();

  // 현재 선택된 항목이 이 항목이면 결과 표시
  if (selectedItemId === item.id) {
    showItemResult(item);
  }
});

// ===== 처리 에러 =====
ipcRenderer.on('processing-error', (event, data) => {
  if (!currentProcessingId) return;

  const item = getQueueItem(currentProcessingId);
  if (!item) return;

  item.status = 'error';
  item.error = data.message;

  renderQueue();
  progressMessage.textContent = '오류: ' + data.message;
});

// ===== 취소 (현재 작업만) =====
cancelBtn.addEventListener('click', async () => {
  await ipcRenderer.invoke('cancel-processing');

  if (currentProcessingId) {
    const item = getQueueItem(currentProcessingId);
    if (item && item.status === 'processing') {
      item.status = 'error';
      item.error = '사용자가 취소함';
      renderQueue();
    }
  }
});

// ===== 다른 이름으로 저장 =====
saveAsBtn.addEventListener('click', async () => {
  const item = selectedItemId ? getQueueItem(selectedItemId) : null;
  const content = item?.srtContent;
  if (!content) return;
  await ipcRenderer.invoke('save-srt-as', { content });
});

// ===== 새 작업 =====
newVideoBtn.addEventListener('click', () => {
  selectedItemId = null;
  renderQueue();
  showView('drop');
});

// ===== 버전 표시 & 업데이트 이력 =====
const APP_VERSION = require(path.join(__dirname, '..', 'package.json')).version;

const CHANGELOG = [
  {
    version: '1.3.0',
    date: '2026-03-25',
    sections: [
      {
        title: 'Added',
        type: 'added',
        items: [
          '작업 리스트(큐) 기능: 여러 비디오 파일을 추가하고 순차적으로 자동 처리',
          '왼쪽 사이드바에 작업 목록 패널 상시 표시',
          '복수 파일 드래그&드롭 및 다중 선택 지원',
          '각 파일별 상태 표시 (대기/처리중/완료/오류)',
          '전체 시작/중지 버튼으로 큐 일괄 제어',
          '완료된 항목 클릭 시 해당 SRT 결과 조회/저장',
          '헤더에 앱 버전 표시 및 업데이트 이력 보기 기능',
        ],
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-03-25',
    sections: [
      {
        title: 'Added',
        type: 'added',
        items: [
          'Whisper 엔진 선택 기능 (faster-whisper / openai-whisper)',
          'faster-whisper (CTranslate2): 기본 엔진, 최고 GPU 성능',
          'openai-whisper (PyTorch): 원본 엔진, 넓은 호환성',
        ],
      },
      {
        title: 'Changed',
        type: 'changed',
        items: [
          '기본 모델을 base에서 large-v3 (최고 정확도)로 변경',
          'Python 엔진에 --engine 인자 추가',
          'PyInstaller 번들에 whisper, tiktoken 패키지 추가',
        ],
      },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-03-25',
    sections: [
      {
        title: 'Fixed',
        type: 'fixed',
        items: [
          '설치 버전 실행 시 멈춤 오류 해결',
          '스플래시 윈도우 transparent 옵션 제거 (Windows 렌더링 멈춤 방지)',
          'ready-to-show 미발생 시 5초 안전 타임아웃 추가',
          'IPC 콜백에 윈도우 파괴 상태 체크 추가 (크래시 방지)',
        ],
      },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-03-25',
    sections: [
      {
        title: 'Added',
        type: 'added',
        items: [
          '최초 릴리스',
          '비디오 파일에서 자동 자막(SRT) 생성',
          'faster-whisper (CTranslate2) 기반 음성 인식',
          'GPU(CUDA) / CPU 자동 감지 및 선택',
          '드래그&드롭 비디오 파일 입력',
          'Whisper 모델 선택 (tiny ~ large-v3)',
          '실시간 진행률 표시',
          'SRT 파일 미리보기 및 다른 이름으로 저장',
          'NSIS 설치 프로그램 빌드 지원',
        ],
      },
    ],
  },
];

function renderChangelog() {
  changelogContent.innerHTML = '';

  CHANGELOG.forEach(entry => {
    const versionDiv = document.createElement('div');
    versionDiv.className = 'cl-version';

    // 헤더
    const header = document.createElement('div');
    header.className = 'cl-version-header';
    header.innerHTML = `
      <span class="cl-ver-tag">v${entry.version}</span>
      <span class="cl-ver-date">${entry.date}</span>
      ${entry.version === APP_VERSION ? '<span class="cl-ver-current">현재 버전</span>' : ''}
    `;
    versionDiv.appendChild(header);

    // 섹션들
    entry.sections.forEach(section => {
      const secDiv = document.createElement('div');
      secDiv.className = 'cl-section';
      secDiv.innerHTML = `<div class="cl-section-title ${section.type}">${section.title}</div>`;
      section.items.forEach(item => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'cl-item';
        itemDiv.textContent = item;
        secDiv.appendChild(itemDiv);
      });
      versionDiv.appendChild(secDiv);
    });

    changelogContent.appendChild(versionDiv);
  });
}

function openChangelog() {
  renderChangelog();
  changelogOverlay.classList.add('visible');
}

function closeChangelog() {
  changelogOverlay.classList.remove('visible');
}

// 버전 배지 클릭 → 업데이트 이력 열기
appVersion.textContent = `v${APP_VERSION}`;
appVersion.addEventListener('click', openChangelog);

// 모달 닫기
changelogClose.addEventListener('click', closeChangelog);
changelogOverlay.addEventListener('click', (e) => {
  if (e.target === changelogOverlay) closeChangelog();
});

// ESC로 모달 닫기
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && changelogOverlay.classList.contains('visible')) {
    closeChangelog();
  }
});

// ===== 초기화 =====
async function init() {
  const deps = await ipcRenderer.invoke('check-dependencies');

  if (!deps.processVideo || !deps.ffmpeg) {
    const depList = document.getElementById('dep-list');
    depList.innerHTML = '';

    const items = [
      { name: '자막 엔진 (process_video.exe)', ok: deps.processVideo },
      { name: 'ffmpeg', ok: deps.ffmpeg },
    ];

    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'dep-item ' + (item.ok ? 'ok' : 'missing');
      div.textContent = (item.ok ? '  ' : '  ') + item.name;
      depList.appendChild(div);
    });

    showView('dep-warning');
  } else {
    showView('drop');
  }

  renderQueue();
  updateButtons();
}

init();
