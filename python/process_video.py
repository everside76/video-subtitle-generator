#!/usr/bin/env python3
"""
비디오 자막 생성기 - 메인 파이프라인
비디오 → 오디오 추출 → 음성 인식 → SRT 생성
GPU(CUDA) 가속 지원
"""

import sys
import os
import json
import argparse
import subprocess
import tempfile
import gc
import atexit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from subtitle_postprocess import postprocess
from align_segments import align_with_whisperx


def _load_cuda_libs():
    """CUDA DLL을 명시적으로 로드 (PyInstaller 번들 + venv 환경 대응)"""
    if sys.platform != "win32":
        return

    search_dirs = []

    # 1. PyInstaller 번들 환경 — exe와 같은 디렉토리의 _internal 폴더
    exe_dir = os.path.dirname(os.path.abspath(sys.argv[0] if sys.argv[0] else sys.executable))
    internal_dir = os.path.join(exe_dir, '_internal')

    # PyInstaller _MEIPASS (onefile 모드)
    if getattr(sys, '_MEIPASS', None):
        search_dirs.append(sys._MEIPASS)
        for sub in ['nvidia/cublas/bin', 'nvidia/cudnn/bin', 'ctranslate2']:
            d = os.path.join(sys._MEIPASS, sub)
            if os.path.isdir(d):
                search_dirs.append(d)

    # PyInstaller onedir 모드: _internal 하위 nvidia DLL 경로 (가장 중요!)
    if os.path.isdir(internal_dir):
        search_dirs.append(internal_dir)
        for sub in ['nvidia/cublas/bin', 'nvidia/cudnn/bin', 'ctranslate2']:
            d = os.path.join(internal_dir, sub)
            if os.path.isdir(d):
                search_dirs.append(d)

    search_dirs.append(exe_dir)

    # 2. site-packages 내 nvidia DLL 경로 (일반 Python/venv 환경)
    site_packages_dirs = [
        os.path.join(sys.prefix, 'Lib', 'site-packages'),
        os.path.join(sys.base_prefix, 'Lib', 'site-packages'),
    ]
    # sys.path에서도 site-packages 찾기
    for p in sys.path:
        if 'site-packages' in p and os.path.isdir(p):
            site_packages_dirs.append(p)

    for sp in set(site_packages_dirs):
        for sub in ['nvidia/cublas/bin', 'nvidia/cudnn/bin']:
            d = os.path.join(sp, sub)
            if os.path.isdir(d):
                search_dirs.append(d)

    # 경로 등록
    for d in search_dirs:
        d = os.path.abspath(d)
        if os.path.isdir(d):
            try:
                os.add_dll_directory(d)
            except (OSError, AttributeError):
                pass
            if d not in os.environ.get('PATH', ''):
                os.environ['PATH'] = d + os.pathsep + os.environ.get('PATH', '')


# Windows 콘솔(cp949)에서 유니코드 메시지 출력 크래시 방지 — Electron은 UTF-8로 읽음
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

# CUDA 메모리 파편화로 인한 OOM 완화 (torch 로드 전에 설정해야 유효)
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

# 시작 시 CUDA DLL 로드
_load_cuda_libs()

# CUDA 모델을 프로세스 종료까지 유지 (GC에 의한 CUDA 크래시 방지)
_whisper_model = None


def _safe_exit():
    """프로세스 종료 시 GC를 비활성화하여 CUDA 객체 소멸자 크래시 방지"""
    gc.disable()


atexit.register(_safe_exit)


def report(stage, progress, message="", **kwargs):
    """Electron 메인 프로세스로 진행률 보고 (JSON 라인)"""
    data = {"stage": stage, "progress": progress, "message": message}
    data.update(kwargs)
    print(json.dumps(data, ensure_ascii=False), flush=True)


FFMPEG_PATH = "ffmpeg"
FFPROBE_PATH = "ffprobe"


def detect_device(requested_device):
    """
    사용 가능한 디바이스 감지.
    requested_device: "auto", "cuda", "cpu"
    returns: (device, compute_type) 튜플
    """
    if requested_device == "cpu":
        return "cpu", "int8"

    # CUDA 사용 가능 여부 확인
    try:
        import ctranslate2
        ctranslate2.get_supported_compute_types("cuda")
        # CUDA 테스트 - 실제로 GPU에 접근 가능한지 확인
        if requested_device in ("cuda", "auto"):
            # 8GB VRAM에서 large-v3 안전 로드 (품질 손실 미미)
            return "cuda", "int8_float16"
    except Exception:
        if requested_device == "cuda":
            report("warning", 0, "CUDA를 사용할 수 없습니다. CPU로 전환합니다.")

    return "cpu", "int8"


def extract_audio(video_path, audio_path):
    """ffmpeg로 비디오에서 오디오 추출 (16kHz mono WAV)"""
    report("extracting", 5, "오디오 추출 중...")
    cmd = [
        FFMPEG_PATH, "-y",
        "-i", video_path,
        "-ar", "16000",
        "-ac", "1",
        "-f", "wav",
        audio_path
    ]
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 오류: {result.stderr.decode('utf-8', errors='replace')}")
    report("extracting", 15, "오디오 추출 완료")


def transcribe_audio(audio_path, model_size="base", device="auto",
                     engine="faster-whisper", language="auto"):
    """음성 인식 (엔진 선택 가능)"""
    if engine == "openai-whisper":
        return _transcribe_openai(audio_path, model_size, device, language)
    else:
        return _transcribe_faster(audio_path, model_size, device, language)


def _transcribe_faster(audio_path, model_size="base", device="auto", language="auto"):
    """faster-whisper 인식. GPU 실패(OOM 등) 시 CPU로 자동 재시도."""
    actual_device, compute_type = detect_device(device)
    try:
        return _transcribe_faster_impl(
            audio_path, model_size, actual_device, compute_type, language)
    except Exception as e:
        if actual_device != "cuda":
            raise
        _unload_whisper_vram()
        report("warning", 20,
               f"GPU 인식 실패({type(e).__name__}) — CPU로 재시도합니다 (느려질 수 있음)")
        return _transcribe_faster_impl(audio_path, model_size, "cpu", "int8", language)


def _transcribe_faster_impl(audio_path, model_size, actual_device, compute_type, language):
    global _whisper_model

    device_label = "GPU (CUDA)" if actual_device == "cuda" else "CPU"
    report("transcribing", 20,
           f"[faster-whisper] 모델 로딩 중 ({model_size}, {device_label})...")

    from faster_whisper import WhisperModel

    model = WhisperModel(
        model_size,
        device=actual_device,
        compute_type=compute_type,
    )

    _whisper_model = model

    report("transcribing", 30, f"[faster-whisper] 음성 인식 중... ({device_label})")

    segments_gen, info = model.transcribe(
        audio_path,
        language=None if language == "auto" else language,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
        beam_size=5,
        word_timestamps=True,
        condition_on_previous_text=False,
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
    )

    detected_lang = info.language
    lang_prob = info.language_probability
    report("transcribing", 35,
           f"감지된 언어: {detected_lang} (확률: {lang_prob:.1%})")

    segments = []
    for seg in segments_gen:
        words = []
        if seg.words:
            for wd in seg.words:
                words.append({"word": wd.word, "start": wd.start, "end": wd.end})
        segments.append({
            "start": seg.start,
            "end": seg.end,
            "text": seg.text.strip(),
            "words": words,
        })
        if len(segments) % 10 == 0:
            report("transcribing", min(35 + len(segments) // 2, 65),
                   f"[faster-whisper] 음성 인식 중... ({len(segments)}개 구간, {device_label})")

    report("transcribing", 85,
           f"[faster-whisper] 음성 인식 완료 ({len(segments)}개 구간, {device_label})")

    return segments, detected_lang, actual_device


def _transcribe_openai(audio_path, model_size="base", device="auto", language="auto"):
    """OpenAI Whisper (PyTorch) 엔진으로 음성 인식"""
    global _whisper_model

    import torch

    if device == "cpu":
        actual_device = "cpu"
    elif device in ("cuda", "auto"):
        actual_device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        actual_device = "cpu"

    device_label = "GPU (CUDA)" if actual_device == "cuda" else "CPU"
    report("transcribing", 20,
           f"[openai-whisper] 모델 로딩 중 ({model_size}, {device_label})...")

    import whisper

    model = whisper.load_model(model_size, device=actual_device)
    _whisper_model = model

    report("transcribing", 30, f"[openai-whisper] 음성 인식 중... ({device_label})")

    result = model.transcribe(
        audio_path,
        language=None if language == "auto" else language,
        verbose=False,
        word_timestamps=True,
        condition_on_previous_text=False,
    )

    detected_lang = result.get("language", "unknown")
    report("transcribing", 35,
           f"감지된 언어: {detected_lang}")

    segments = []
    for seg in result.get("segments", []):
        words = [{"word": wd["word"], "start": wd["start"], "end": wd["end"]}
                 for wd in seg.get("words", [])]
        segments.append({
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"].strip(),
            "words": words,
        })
        if len(segments) % 10 == 0:
            report("transcribing", min(35 + len(segments) // 2, 65),
                   f"[openai-whisper] 음성 인식 중... ({len(segments)}개 구간, {device_label})")

    report("transcribing", 85,
           f"[openai-whisper] 음성 인식 완료 ({len(segments)}개 구간, {device_label})")

    return segments, detected_lang, actual_device


def _unload_whisper_vram():
    """정렬 모델 로드 전 인식 모델의 VRAM 해제 (Python 객체는 유지해 GC 크래시 방지)"""
    global _whisper_model
    try:
        if _whisper_model is not None and hasattr(_whisper_model, "model"):
            _whisper_model.model.unload_model()
            gc.collect()
    except Exception:
        pass


def format_timestamp(seconds):
    """초를 SRT 타임스탬프 형식으로 변환 (HH:MM:SS,mmm)"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def generate_srt(segments, output_path):
    """SRT 파일 생성"""
    report("generating", 90, "SRT 파일 생성 중...")

    with open(output_path, "w", encoding="utf-8") as f:
        for i, seg in enumerate(segments, 1):
            f.write(f"{i}\n")
            f.write(f"{format_timestamp(seg['start'])} --> {format_timestamp(seg['end'])}\n")
            f.write(f"{seg['text']}\n\n")

    report("generating", 98, "SRT 파일 생성 완료")


def get_video_duration(video_path):
    """비디오 길이 조회"""
    try:
        cmd = [
            FFPROBE_PATH,
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            video_path
        ]
        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        )
        info = json.loads(result.stdout)
        return float(info["format"]["duration"])
    except Exception:
        return 0


def main():
    parser = argparse.ArgumentParser(description="비디오 자막 생성기")
    parser.add_argument("video_path", help="비디오 파일 경로")
    parser.add_argument("--model", default="base",
                        choices=["tiny", "base", "small", "medium", "large-v3"],
                        help="Whisper 모델 크기")
    parser.add_argument("--output", default="", help="출력 SRT 파일 경로")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg 실행 파일 경로")
    parser.add_argument("--device", default="auto",
                        choices=["auto", "cuda", "cpu"],
                        help="처리 디바이스 (auto=GPU 우선, cuda=GPU 강제, cpu=CPU만)")
    parser.add_argument("--engine", default="faster-whisper",
                        choices=["faster-whisper", "openai-whisper"],
                        help="Whisper 엔진 (faster-whisper=CTranslate2, openai-whisper=PyTorch)")
    parser.add_argument("--language", default="auto",
                        choices=["auto", "ko", "en", "ja", "zh"],
                        help="음성 언어 (auto=자동 감지)")
    parser.add_argument("--align", default="off",
                        choices=["auto", "off"],
                        help="WhisperX 정밀 정렬 (off=Whisper 단어 타임스탬프 사용, 기본)")
    args = parser.parse_args()

    # 번들된 ffmpeg 경로를 전역으로 설정
    global FFMPEG_PATH, FFPROBE_PATH
    FFMPEG_PATH = args.ffmpeg
    ffmpeg_dir = os.path.dirname(args.ffmpeg)
    FFPROBE_PATH = os.path.join(ffmpeg_dir, "ffprobe.exe") if ffmpeg_dir else "ffprobe"

    video_path = args.video_path

    if not os.path.isfile(video_path):
        report("error", 0, f"파일을 찾을 수 없습니다: {video_path}")
        sys.exit(1)

    # 출력 경로 결정
    if args.output:
        srt_path = args.output
    else:
        base = os.path.splitext(video_path)[0]
        srt_path = base + ".srt"

    report("start", 0, "처리 시작...")

    # 비디오 길이
    duration = get_video_duration(video_path)
    duration_str = ""
    if duration > 0:
        m, s = divmod(int(duration), 60)
        h, m = divmod(m, 60)
        duration_str = f"{h:02d}:{m:02d}:{s:02d}"

    # 임시 오디오 파일
    temp_dir = tempfile.gettempdir()
    audio_path = os.path.join(temp_dir, "subtitle_gen_temp.wav")

    try:
        # 1. 오디오 추출
        extract_audio(video_path, audio_path)

        # 2. 음성 인식 (GPU/CPU 자동 선택)
        segments, detected_lang, used_device = transcribe_audio(
            audio_path, args.model, args.device, args.engine, args.language
        )

        if not segments:
            report("error", 0, "음성이 감지되지 않았습니다.")
            sys.exit(1)

        # 3. 강제 정렬 (옵션, 실패 시 Whisper 단어 타임스탬프로 폴백)
        align_lang = args.language if args.language != "auto" else detected_lang
        if args.align == "auto":
            _unload_whisper_vram()
            segments, aligned = align_with_whisperx(
                segments, audio_path, align_lang, used_device, report
            )
        else:
            report("aligning", 88, "Whisper 단어 타임스탬프 사용 (정밀 정렬 생략)")

        # 4. 후처리: 무음 분할/트리밍/병합/줄바꿈
        subtitles = postprocess(segments, align_lang)

        if not subtitles:
            report("error", 0, "자막을 생성할 수 없습니다 (유효한 발화 없음).")
            sys.exit(1)

        # 5. SRT 생성
        generate_srt(subtitles, srt_path)

        # 완료
        device_label = "GPU" if used_device == "cuda" else "CPU"
        report("complete", 100, "완료!", result={
            "srt_path": srt_path,
            "language": detected_lang,
            "segments": len(subtitles),
            "duration": duration_str,
            "device": device_label
        })

    except SystemExit:
        raise
    except BaseException as e:
        # os._exit가 finally에서 트레이스백을 삼키지 않도록 먼저 보고
        import traceback
        report("error", 0, f"처리 실패: {type(e).__name__}: {e}")
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        if _whisper_model is not None:
            os._exit(1)
        raise
    finally:
        # 임시 파일 정리
        if os.path.exists(audio_path):
            try:
                os.remove(audio_path)
            except OSError:
                pass

        # CUDA 모델이 있으면 Python 정상 종료 과정에서 CUDA 소멸자 크래시 발생
        # os._exit(0)으로 Python cleanup을 완전히 건너뛰어 크래시 방지
        if _whisper_model is not None:
            os._exit(0)


if __name__ == "__main__":
    # frozen(PyInstaller) 환경에서 multiprocessing 자식 프로세스가
    # 메인 스크립트를 재실행하는 것을 방지 (필수)
    import multiprocessing
    multiprocessing.freeze_support()
    main()
