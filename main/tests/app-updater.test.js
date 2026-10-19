const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAppUpdater } = require('../app-updater');

function fixture(options = {}) {
  const updater = new EventEmitter();
  let checks = 0;
  let installs = 0;
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit('update-not-available');
    return {};
  };
  updater.quitAndInstall = (silent, forceRun) => {
    assert.equal(silent, false);
    assert.equal(forceRun, true);
    installs++;
  };
  const controller = createAppUpdater({ updater, packaged: true, ...options });
  return { updater, controller, checks: () => checks, installs: () => installs };
}

test('development mode never contacts update server', async () => {
  const f = fixture({ packaged: false });
  f.controller.start();
  assert.deepEqual(await f.controller.check(), { state: 'disabled' });
  assert.equal(f.checks(), 0);
  assert.equal(f.controller.install().ok, false);
});

test('reports latest version and enables stable automatic downloads', async () => {
  const f = fixture();
  assert.equal(f.updater.autoDownload, true);
  assert.equal(f.updater.autoInstallOnAppQuit, true);
  assert.equal(f.updater.allowPrerelease, false);
  assert.equal(f.updater.allowDowngrade, false);
  assert.equal((await f.controller.check()).state, 'current');
});

test('retains download progress and ready status for renderer reloads', async () => {
  const seen = [];
  const f = fixture({ notify: status => seen.push(status) });
  f.updater.emit('update-available', { version: '1.9.0' });
  f.updater.emit('download-progress', { percent: 42.5 });
  assert.deepEqual(f.controller.getStatus(), { state: 'downloading', version: '1.9.0', percent: 42.5 });
  await f.controller.check();
  assert.equal(f.checks(), 0);
  f.updater.emit('update-downloaded', { version: '1.9.0' });
  await f.controller.check();
  assert.equal(f.controller.getStatus().state, 'ready');
  assert.equal(f.checks(), 0);
  assert.equal(seen.at(-1).state, 'ready');
  const snapshot = f.controller.getStatus();
  snapshot.state = 'broken';
  assert.equal(f.controller.getStatus().state, 'ready');
});

test('does not restart while transcription, translation, queue or engine is busy', () => {
  let busy = true;
  const f = fixture({ isBusy: () => busy });
  f.updater.emit('update-downloaded', { version: '1.9.0' });
  assert.equal(f.controller.install().ok, false);
  assert.equal(f.installs(), 0);
  assert.equal(f.controller.getStatus().state, 'ready');
  busy = false;
  assert.equal(f.controller.install().ok, true);
  assert.equal(f.installs(), 1);
  assert.equal(f.controller.install().ok, false);
  assert.equal(f.installs(), 1);
});

test('network error remains visible and a manual check can recover', async () => {
  const f = fixture();
  const goodCheck = f.updater.checkForUpdates;
  f.updater.checkForUpdates = async () => { throw new Error('offline'); };
  assert.deepEqual(await f.controller.check(), { state: 'error', message: 'offline' });
  f.updater.checkForUpdates = goodCheck;
  assert.equal((await f.controller.check()).state, 'current');
});

test('installation error events are returned to the restart button', () => {
  const f = fixture();
  f.updater.emit('update-downloaded', { version: '1.9.0' });
  f.updater.quitAndInstall = () => f.updater.emit('error', new Error('installer missing'));
  assert.deepEqual(f.controller.install(), { ok: false, message: 'installer missing' });
  assert.equal(f.controller.getStatus().state, 'error');
});

test('failed automatic download is handled without unhandled rejection', async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => {
    f.updater.emit('update-available', { version: '1.9.0' });
    return { downloadPromise: Promise.reject(new Error('download failed')) };
  };
  await f.controller.check();
  await Promise.resolve();
  assert.deepEqual(f.controller.getStatus(), { state: 'error', message: 'download failed' });
});

test('concurrent checks share a single server request', async () => {
  const f = fixture();
  let calls = 0;
  let finish;
  f.updater.checkForUpdates = () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  };
  const first = f.controller.check();
  assert.equal((await f.controller.check()).state, 'checking');
  assert.equal(calls, 1);
  f.updater.emit('update-not-available');
  finish({});
  await first;
});

test('checks at startup and every four hours, stops when app quits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture();
  f.controller.start();
  f.controller.start();
  t.mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(f.checks(), 1);
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  await Promise.resolve();
  assert.equal(f.checks(), 2);
  f.controller.stop();
  t.mock.timers.tick(4 * 60 * 60 * 1000);
  assert.equal(f.checks(), 2);
});
