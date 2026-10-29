const { execFile } = require('child_process');
const path = require('path');
const engineManager = require('./engine-manager');

function getAudioTracks(videoPath) {
  const bin = engineManager.findEngineDir() || path.join(__dirname, '..', 'bin');
  return new Promise((resolve, reject) => {
    execFile(path.join(bin, 'ffprobe.exe'), ['-v', 'error', '-select_streams', 'a',
      '-show_streams', '-of', 'json', videoPath],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    (error, stdout) => {
      if (error) return reject(new Error('음성 트랙 정보를 읽지 못했습니다. 엔진 설치와 파일을 확인하세요.'));
      try {
        resolve(JSON.parse(stdout).streams.map(stream => ({
          index: stream.index, language: stream.tags?.language || 'und',
          title: stream.tags?.title || '', channels: stream.channels || 0,
          layout: stream.channel_layout || '', default: Boolean(stream.disposition?.default),
        })));
      } catch { reject(new Error('음성 트랙 정보 형식이 올바르지 않습니다.')); }
    });
  });
}

module.exports = { getAudioTracks };
