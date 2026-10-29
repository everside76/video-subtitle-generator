const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const original = '1\n00:00:03,000 --> 00:00:04,000\nNo.\n\n2\n00:00:12,000 --> 00:00:14,000\nCome back!\n\n';
function fixture(t, fail = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsg-translator-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'film.srt');
  fs.writeFileSync(file, original);
  const requests = [];
  const context = { module: { exports: {} }, AbortSignal,
    setTimeout: callback => { callback(); return 0; },
    require(name) { if (name === 'fs') return fs; throw new Error('No Electron'); },
    fetch: async url => {
      requests.push(new URL(url));
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => [[['번역 문장', '', null]]] };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'translator.js'), 'utf8'), context);
  return { file, requests, api: context.module.exports };
}

test('translation pins the detected language and preserves original timings and text', async t => {
  const f = fixture(t);
  const result = await f.api.translateSrtFile(f.file, 'ko', null, 'en');
  assert(f.requests.every(url => url.searchParams.get('sl') === 'en'));
  assert.equal(fs.readFileSync(result.originalPath, 'utf8'), original);
  const before = f.api.parseSrt(original), after = f.api.parseSrt(fs.readFileSync(f.file, 'utf8'));
  assert.equal(after.length, before.length);
  assert.deepEqual(after.map(b => b.time), before.map(b => b.time));
  assert.equal(result.failed, 0);
});

test('an existing different original file is never overwritten', async t => {
  const f = fixture(t);
  const existing = f.file.replace('.srt', '.original.srt');
  fs.writeFileSync(existing, 'user edited subtitles');
  const result = await f.api.translateSrtFile(f.file, 'both', null, 'fr');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'user edited subtitles');
  assert.match(result.originalPath, /original\.2\.srt$/);
  assert.equal(fs.readFileSync(result.originalPath, 'utf8'), original);
  assert.match(fs.readFileSync(f.file, 'utf8'), /No\.\n번역 문장/);
});

test('Japanese line wrapping is joined without changing a name or phrase', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '1\n00:00:01,000 --> 00:00:03,000\n綾\n瀬さん、待って！\n\n');
  await f.api.translateSrtFile(f.file, 'ko', null, 'ja');
  assert.equal(f.requests[0].searchParams.get('sl'), 'ja');
  assert.equal(f.requests[0].searchParams.get('q'), '綾瀬さん、待って！');
});

test('offline translation retains the source and reports each failed subtitle', async t => {
  const f = fixture(t, true);
  const result = await f.api.translateSrtFile(f.file, 'ko', null, 'unknown');
  assert.equal(result.failed, 2);
  assert.equal(result.translated, 0);
  assert(f.requests.every(url => url.searchParams.get('sl') === 'auto'));
  assert.equal(fs.readFileSync(result.originalPath, 'utf8'), original);
  assert.deepEqual(f.api.parseSrt(fs.readFileSync(f.file, 'utf8')), f.api.parseSrt(original));
});
