/**
 * SRT 자막 번역 (Google 번역 웹 엔드포인트).
 *
 * 엔진과 분리되어 Electron 메인 프로세스에서 동작 — 엔진 재배포 불필요.
 * 실패한 항목은 원문을 유지하고 전체 작업은 계속 진행한다.
 */
const fs = require('fs');

const CONCURRENCY = 4;
const MAX_LINE_KO = 20;

function getFetch() {
  try {
    const { net } = require('electron');
    if (net && net.fetch) return net.fetch.bind(net);
  } catch { /* Electron 외 환경 (테스트) */ }
  return fetch;
}

async function translateOne(text, targetLang) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl='
    + encodeURIComponent(targetLang) + '&dt=t&q=' + encodeURIComponent(text);
  const res = await getFetch()(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  const out = (data && data[0] ? data[0] : []).map((seg) => seg[0]).join('');
  if (!out.trim()) throw new Error('빈 번역 결과');
  return out.trim();
}

async function translateWithRetry(text, targetLang) {
  try {
    return await translateOne(text, targetLang);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return translateOne(text, targetLang);
  }
}

/** 한국어 텍스트를 최대 2줄(줄당 약 20자)로 줄바꿈 */
function wrapKo(text) {
  if (text.length <= MAX_LINE_KO) return text;
  const words = text.split(' ');
  let line1 = '';
  let i = 0;
  while (i < words.length) {
    const candidate = (line1 + ' ' + words[i]).trim();
    if (candidate.length > MAX_LINE_KO && line1) break;
    line1 = candidate;
    i++;
  }
  const rest = words.slice(i).join(' ');
  return rest ? line1 + '\n' + rest : line1;
}

function parseSrt(content) {
  return content.replace(/^﻿/, '').trim().split(/\r?\n\s*\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      if (lines.length < 2) return null;
      return {
        index: lines[0].trim(),
        time: lines[1].trim(),
        text: lines.slice(2).join('\n').trim(),
      };
    })
    .filter((b) => b && b.time.includes('-->'));
}

function buildSrt(blocks) {
  return blocks.map((b, i) => `${i + 1}\n${b.time}\n${b.text}\n`).join('\n') + '\n';
}

/**
 * SRT 파일을 한국어로 번역해 덮어쓴다.
 * mode: 'ko' = 한국어만, 'both' = 원문 + 한국어
 * onProgress(done, total)
 */
async function translateSrtFile(srtPath, mode, onProgress) {
  const content = fs.readFileSync(srtPath, 'utf-8');
  const blocks = parseSrt(content);
  if (blocks.length === 0) return { translated: 0, failed: 0 };

  let done = 0;
  let failed = 0;

  for (let i = 0; i < blocks.length; i += CONCURRENCY) {
    const chunk = blocks.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (block) => {
      const flat = block.text.replace(/\s*\n\s*/g, ' ');
      try {
        const translated = await translateWithRetry(flat, 'ko');
        block.text = mode === 'both'
          ? block.text + '\n' + translated
          : wrapKo(translated);
      } catch {
        failed++; // 실패 시 원문 유지
      }
      done++;
    }));
    if (onProgress) onProgress(done, blocks.length);
  }

  fs.writeFileSync(srtPath, buildSrt(blocks), 'utf-8');
  return { translated: done - failed, failed };
}

module.exports = { translateSrtFile, parseSrt, wrapKo };
