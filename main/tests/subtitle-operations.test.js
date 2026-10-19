const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => proc.emit('close', null);
  const errors = [];
  const results = [];
  const filename = path.join(__dirname, '..', 'subtitle-operations.js');
  const context = {
    module: { exports: {} }, __dirname: path.dirname(filename), process,
    require(name) {
      if (name === 'child_process') return { spawn: () => proc };
      if (name === 'path') return path;
      if (name === 'fs') return { existsSync: () => true };
      if (name === './engine-manager') return { findEngineDir: () => 'test-engine' };
      if (name === './translator') return {};
      throw new Error('No Electron logger in test');
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const api = context.module.exports;
  api.processVideo('input.mp4', { translate: 'off' }, () => {},
    value => results.push(value), error => errors.push(error));
  return { api, proc, errors, results };
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
