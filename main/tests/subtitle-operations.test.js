const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => proc.emit('close', null);
  const errors = [];
  const results = [];
  const calls = [];
  const filename = path.join(__dirname, '..', 'subtitle-operations.js');
  const context = {
    module: { exports: {} }, __dirname: path.dirname(filename), process,
    require(name) {
      if (name === 'child_process') return { spawn: (...args) => { calls.push(args); return proc; } };
      if (name === 'path') return path;
      if (name === 'fs') return { existsSync: () => true };
      if (name === './engine-manager') return { findEngineDir: () => 'test-engine' };
      throw new Error('No Electron logger in test');
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const api = context.module.exports;
  api.processVideo('input.mp4', options, () => {},
    value => results.push(value), error => errors.push(error));
  return { api, proc, errors, results, calls };
}

test('track index zero and quoted terms reach the engine as separate literal arguments', () => {
  const f = fixture({ audioStream: 0, audioMix: 'center', precision: 'accurate',
    language: 'fr', terms: 'Jean-Luc, "Asterion" & friends' });
  const args = f.calls[0][1];
  for (const [flag, value] of [['--audio-stream', '0'], ['--audio-mix', 'center'],
    ['--language', 'fr'], ['--terms', 'Jean-Luc, "Asterion" & friends'], ['--speech-guard', 'strict']]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.equal(f.calls[0][2].shell, undefined);
});

for (const language of ['ja', 'en', 'ko']) {
  test(`${language} subtitles complete directly even with retired client options`, () => {
    const f = fixture({ translate: 'ko' });
    const result = { language, srt_path: 'film.srt', segments: 2 };
    f.proc.stdout.emit('data', Buffer.from(JSON.stringify({ stage: 'complete', result }) + '\n'));
    assert.equal(f.results.length, 1);
    assert.equal(JSON.stringify(f.results[0]), JSON.stringify(result));
    assert.equal(f.errors.length, 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][1].includes('--translate'), false);
  });
}

test('cancel settles the job so update restart is not blocked forever', () => {
  const f = fixture();
  assert.equal(f.api.cancelProcessing(), true);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0].message, /취소/);
});

test('an engine error followed by exit is reported only once', () => {
  const f = fixture();
  f.proc.stdout.emit('data', Buffer.from('{"stage":"error","message":"No speech"}\n'));
  f.proc.emit('close', 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].message, 'No speech');
});

test('clean exit without a completion message settles as failure', () => {
  const f = fixture();
  f.proc.emit('close', 0);
  assert.equal(f.errors.length, 1);
});

test('CUDA cleanup exit after successful completion does not undo result', () => {
  const f = fixture();
  f.proc.stdout.emit('data', Buffer.from('{"stage":"complete","result":{"language":"ko"}}\n'));
  f.proc.emit('close', 1);
  assert.equal(f.results.length, 1);
  assert.equal(f.errors.length, 0);
});
