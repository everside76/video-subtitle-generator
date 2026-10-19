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
let appUpdateStatus = { state: 'idle' };

// ===== 설정 영속화 =====
const SETTING_IDS = ['engine-select', 'device-select', 'language-select', 'translate-select', 'cw-mode-select'];

// 모델 목록은 엔진마다 다르므로 별도 관리 (설정도 엔진별로 저장)
const ENGINE_MODELS = {
  'faster-whisper': [
    ['tiny', 'tiny (빠름, 낮은 정확도)'],
    ['base', 'base (균형)'],
    ['small', 'small (보통)'],
    ['medium', 'medium (높은 정확도)'],
    ['large-v3', 'large-v3 (최고 정확도)'],
  ],
  'openai-whisper': [
    ['tiny', 'tiny (빠름, 낮은 정확도)'],
    ['base', 'base (균형)'],
    ['small', 'small (보통)'],
    ['medium', 'medium (높은 정확도)'],
    ['large-v3', 'large-v3 (최고 정확도)'],
  ],
  'crisperwhisper': [
    ['large', 'large (최고 정확도)'],
    ['turbo', 'turbo (빠름)'],
    ['medium', 'medium (균형)'],
    ['small', 'small (가벼움)'],
  ],
};
const ENGINE_DEFAULT_MODEL = {
  'faster-whisper': 'large-v3',
  'openai-whisper': 'large-v3',
  'crisperwhisper': 'large',
};

// 엔진에 맞춰 모델 목록/전사 모드/언어 제약 동기화
function syncEngineUI() {
  const engine = document.getElementById('engine-select').value;
  const modelSel = document.getElementById('model-select');
  const models = ENGINE_MODELS[engine] || ENGINE_MODELS['faster-whisper'];

  const saved = localStorage.getItem('setting:model-select@' + engine);
  modelSel.innerHTML = '';
  for (const [value, label] of models) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    modelSel.appendChild(opt);
  }
  const values = models.map(([v]) => v);
  modelSel.value = values.includes(saved)
    ? saved : (ENGINE_DEFAULT_MODEL[engine] || values[0]);

  // CrisperWhisper 전용 전사 모드 표시
  document.getElementById('cw-mode-label').style.display =
    engine === 'crisperwhisper' ? '' : 'none';

  // CrisperWhisper는 언어 자동 감지 미지원
  const langSel = document.getElementById('language-select');
  const autoOpt = [...langSel.options].find((o) => o.value === 'auto');
  if (autoOpt) autoOpt.disabled = engine === 'crisperwhisper';
  if (engine === 'crisperwhisper') {
    if (langSel.value === 'auto') langSel.value = 'ko'; // 표시만 변경, 저장 안 함
  } else {
    const savedLang = localStorage.getItem('setting:language-select');
    if (savedLang && [...langSel.options].some((o) => o.value === savedLang)) {
      langSel.value = savedLang;
    }
  }
}

// 기존 단일 모델 설정을 엔진별 키로 1회 이전
function migrateModelSetting() {
  const legacy = localStorage.getItem('setting:model-select');
  if (legacy === null) return;
  ['faster-whisper', 'openai-whisper'].forEach(engine => {
    if (ENGINE_MODELS[engine].some(([v]) => v === legacy)) {
      const key = 'setting:model-select@' + engine;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
    }
  });
  localStorage.removeItem('setting:model-select');
}

function loadSettings() {
  SETTING_IDS.forEach(id => {
    const el = document.getElementById(id);
    const saved = localStorage.getItem('setting:' + id);
    if (saved !== null && [...el.options].some(o => o.value === saved)) {
      el.value = saved;
    }
    el.addEventListener('change', () => {
      localStorage.setItem('setting:' + id, el.value);
      if (id === 'engine-select') syncEngineUI();
    });
  });

  migrateModelSetting();
  syncEngineUI();

  // 모델은 엔진별로 저장
  document.getElementById('model-select').addEventListener('change', () => {
    const engine = document.getElementById('engine-select').value;
    localStorage.setItem('setting:model-select@' + engine,
      document.getElementById('model-select').value);
  });
}
loadSettings();

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
  ipcRenderer.send('queue-running', isRunning);
  renderUpdateStatus(appUpdateStatus);
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
      language: document.getElementById('language-select').value,
      translate: document.getElementById('translate-select').value,
      cwMode: document.getElementById('cw-mode-select').value,
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

  // 경고는 진행 단계가 아니므로 메시지만 갱신 (단계 표시/진행률 되돌림 방지)
  if (stage === 'warning') {
    if (message) progressMessage.textContent = message;
    return;
  }

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
    version: '1.9.0',
    date: '2026-10-20',
    sections: [
      { title: 'Fixed', type: 'fixed', items: [
        '모든 엔진에서 실제 발화만 인식 — 무음 구간의 임의 자막 억제',
        '무음 경계를 넘는 자막 병합과 표시 시간 연장 방지',
        '음성 인식 신뢰도 검증 및 안정적인 인식 설정 적용',
      ] },
      { title: 'Added', type: 'added', items: [
        '시작 시·4시간마다 자동 업데이트 확인 및 다운로드 진행률 표시',
        '업데이트 확인·재시작 버튼과 네트워크 오류 후 재시도',
        '자막 생성·번역·엔진 설치 중 업데이트 재시작 방지',
      ] },
    ],
  },
  {
    version: '1.8.0',
    date: '2026-08-20',
    sections: [
      {
        title: 'Added',
        type: 'added',
        items: [
          'CrisperWhisper 2.0 엔진 추가: 정밀 단어 타임스탬프',
          '전사 모드 선택: 정제(읽기 좋은 자막) / 축어(말한 그대로, 필러 포함)',
          '엔진별 모델 목록 표시 및 모델 설정 개별 저장',
          'CrisperWhisper 모델 최초 다운로드 진행률 표시 (large 기준 약 3.1GB)',
        ],
      },
      {
        title: 'Changed',
        type: 'changed',
        items: [
          '음성 인식 엔진 v3로 업데이트 — 최초 실행 시 엔진 재다운로드 필요',
          'CrisperWhisper 선택 시 언어 자동 감지 비활성화 (해당 엔진 미지원)',
          'CrisperWhisper 모델 가중치는 비상업 연구 라이선스 (상업적 사용은 별도 계약 필요)',
          '엔진 설치 성공 시 이전 버전 엔진 디렉토리 자동 정리',
          '엔진 번들에서 빌드타임 아티팩트 제거 — 설치 후 디스크 사용량 약 29% 감소',
        ],
      },
    ],
  },
  {
    version: '1.7.0',
    date: '2026-07-19',
    sections: [
      {
        title: 'Added',
        type: 'added',
        items: [
          '한국어 번역 자막: 음성이 한국어가 아니면 자동으로 한국어 자막 생성',
          '번역 모드 선택: 한국어로 번역(기본) / 원문+한국어 / 사용 안 함',
          '번역 진행률 표시, 일부 실패 시 해당 자막만 원문 유지',
        ],
      },
    ],
  },
  {
    version: '1.6.1',
    date: '2026-07-19',
    sections: [
      {
        title: 'Changed',
        type: 'changed',
        items: [
          'WhisperX 완전 제거: 무음 자막 제거는 Whisper 단어 타임스탬프 + 후처리로 동작',
          '진행 단계를 3단계(추출/인식/생성)로 단순화',
          '설정에서 정밀 정렬 옵션 제거',
        ],
      },
    ],
  },
  {
    version: '1.6.0',
    date: '2026-07-19',
    sections: [
      {
        title: 'Changed',
        type: 'changed',
        items: [
          '무음 자막 제거를 Whisper 단어 타임스탬프 + 후처리만으로 처리 (WhisperX 정렬 기본 비활성화 — GPU 메모리 오류 해소)',
          '정밀 정렬(WhisperX)은 설정에서 선택 시에만 사용',
          '음성 인식도 GPU 실패 시 CPU로 자동 재시도',
        ],
      },
      {
        title: 'Added',
        type: 'added',
        items: [
          '엔진 오류 로그 저장 (engine.log) 및 실패 시 실제 오류 내용 표시',
        ],
      },
    ],
  },
  {
    version: '1.5.3',
    date: '2026-07-19',
    sections: [
      {
        title: 'Fixed',
        type: 'fixed',
        items: [
          'GPU 메모리 부족 시 정렬 처리 개선: 여유 VRAM 확인 후 부족하면 즉시 CPU 전환',
          'CUDA 메모리 파편화 완화 설정 적용 (OOM 발생률 감소)',
          '정렬 후 GPU 메모리 즉시 반환',
        ],
      },
    ],
  },
  {
    version: '1.5.2',
    date: '2026-07-19',
    sections: [
      {
        title: 'Fixed',
        type: 'fixed',
        items: [
          '엔진 다운로드를 Chromium 네트워크 방식으로 전환 (다운로드 손상 대응)',
          '해시 불일치 시 상세 진단 정보 표시',
        ],
      },
    ],
  },
  {
    version: '1.5.1',
    date: '2026-07-19',
    sections: [
      {
        title: 'Fixed',
        type: 'fixed',
        items: [
          '엔진 다운로드 무결성 검증(SHA256) 추가 — 손상된 파일로 설치 실패하던 문제 해결',
          '손상된 파트만 자동 재다운로드, 정상 파트는 재사용 (재시도 시 처음부터 다시 받지 않음)',
          '압축 해제 실패 시 대체 방식(PowerShell)으로 자동 재시도',
        ],
      },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-07-19',
    sections: [
      {
        title: 'Added',
        type: 'added',
        items: [
          '앱 자동 업데이트: GitHub Releases에서 새 버전 자동 다운로드 및 적용',
          '엔진 분리 설치: 대용량 음성 인식 엔진을 최초 1회만 다운로드 (설치본 대폭 축소)',
          '엔진 로더 구조: 파이프라인 코드를 앱에서 로드 — 기능 업데이트가 수 분 내로 빨라짐',
        ],
      },
      {
        title: 'Fixed',
        type: 'fixed',
        items: [
          '설치본에서 정렬(WhisperX) 단계가 실패하던 문제 (scipy/torchcodec 번들 누락)',
          '한글 Windows(cp949)에서 오류 메시지 출력 시 크래시하던 문제',
          '오류가 표시되지 않고 조용히 종료되던 문제',
        ],
      },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-07-19',
    sections: [
      {
        title: 'Added',
        type: 'added',
        items: [
          'WhisperX 강제 정렬: 단어 단위 정밀 타임스탬프 (한/영/일/중)',
          '자막 후처리: 무음 구간(0.6초 이상)에서 자막 자동 분할 — 말이 없을 때 자막 미표시',
          '자막 표시 규칙: 최대 6초, 최소 0.8초, 자동 줄바꿈 (CJK 20자/라틴 42자, 최대 2줄)',
          '음성 언어 선택 (한국어/영어/일본어/중국어/자동 감지)',
          '설정값 저장: 마지막 사용 설정이 다음 실행 시 기본값',
        ],
      },
      {
        title: 'Changed',
        type: 'changed',
        items: [
          '환각(hallucination) 억제: 이전 텍스트 조건화 비활성화 및 품질 임계값 필터 적용',
          'GPU에서 large-v3를 int8_float16 양자화로 로드 (8GB VRAM 대응)',
          'VAD 파라미터 튜닝 (최소 무음 500ms, 발화 패딩 200ms)',
        ],
      },
    ],
  },
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
// 창 제목에도 버전 표시
document.title = `비디오 자막 생성기 v${APP_VERSION}`;
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

// ===== 엔진 설치 =====
const engineInstallBtn = document.getElementById('engine-install-btn');
const engineProgressWrap = document.getElementById('engine-progress-wrap');
const engineProgressFill = document.getElementById('engine-progress-fill');
const engineProgressMessage = document.getElementById('engine-progress-message');
const engineMessage = document.getElementById('engine-message');

ipcRenderer.on('engine-progress', (event, { percent, message }) => {
  engineProgressWrap.style.display = 'block';
  engineProgressFill.style.width = (percent || 0) + '%';
  engineProgressMessage.textContent = message || '';
});

engineInstallBtn.addEventListener('click', async () => {
  // 설치 실패 시 안내문(용량/라이선스 고지)을 복원하기 위해 원본 보관
  const originalHtml = engineMessage.innerHTML;
  engineInstallBtn.disabled = true;
  engineMessage.textContent = '엔진을 설치하는 동안 앱을 종료하지 마세요.';
  const result = await ipcRenderer.invoke('engine-install');
  if (result.ok) {
    engineProgressMessage.textContent = '설치 완료!';
    showView('drop');
  } else {
    engineInstallBtn.disabled = false;
    engineMessage.innerHTML = originalHtml;
    engineProgressMessage.textContent = '설치 실패: ' + (result.message || '알 수 없는 오류');
  }
});

// ===== 앱 자동 업데이트 =====
function renderUpdateStatus(status) {
  appUpdateStatus = status;
  const action = document.getElementById('update-action');
  const label = document.getElementById('update-status');
  const messages = {
    idle: '',
    disabled: '자동 업데이트는 설치된 앱에서 사용할 수 있습니다.',
    checking: '새 버전을 확인하고 있습니다...',
    current: `현재 v${APP_VERSION}이 최신 버전입니다.`,
    downloading: `v${status.version} 다운로드 중... ${Math.round(status.percent || 0)}%`,
    ready: isRunning ? `v${status.version} 준비 완료 — 작업을 마친 뒤 재시작할 수 있습니다.`
      : `v${status.version} 준비 완료 — 재시작하거나 앱을 종료하면 적용됩니다.`,
    installing: '업데이트를 적용하기 위해 재시작합니다...',
    error: '업데이트 확인 또는 다운로드에 실패했습니다. 다시 시도할 수 있습니다.',
  };
  label.textContent = messages[status.state] || '';
  label.title = status.message || '';
  action.textContent = status.state === 'ready' ? '재시작하여 업데이트' : '업데이트 확인';
  action.disabled = ['disabled', 'checking', 'downloading', 'installing'].includes(status.state)
    || (status.state === 'ready' && isRunning);
}

ipcRenderer.on('app-update', (_event, status) => renderUpdateStatus(status));
document.getElementById('update-action').addEventListener('click', async () => {
  try {
    if (appUpdateStatus.state === 'ready') {
      const result = await ipcRenderer.invoke('app-update-install');
      if (!result.ok) document.getElementById('update-status').textContent = result.message;
    } else {
      renderUpdateStatus(await ipcRenderer.invoke('app-update-check'));
    }
  } catch (error) {
    renderUpdateStatus({ state: 'error', message: error.message });
  }
});

// ===== 초기화 =====
async function init() {
  renderUpdateStatus(await ipcRenderer.invoke('app-update-status'));
  const deps = await ipcRenderer.invoke('check-dependencies');

  if (!deps.processVideo || !deps.ffmpeg) {
    showView('dep-warning');
  } else {
    showView('drop');
  }

  renderQueue();
  updateButtons();
}

init();
