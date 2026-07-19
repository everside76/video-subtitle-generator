"""WhisperX wav2vec2 강제 정렬 래퍼.

입력 세그먼트: {"start", "end", "text", "words": [...]} (words는 폴백용)
출력: (segments, aligned) — aligned=False면 입력 그대로(폴백).
정렬은 어떤 실패에서도 예외를 밖으로 던지지 않는다.
"""

SUPPORTED_ALIGN_LANGS = {"ko", "en", "ja", "zh"}


def align_with_whisperx(segments, audio_path, language, device, report):
    """세그먼트를 wav2vec2로 강제 정렬. 실패 시 폴백.

    report: report(stage, progress, message) 콜백 (process_video.report)
    """
    if language not in SUPPORTED_ALIGN_LANGS:
        report("warning", 86,
               f"언어 '{language}'는 정밀 정렬 미지원 — Whisper 단어 타임스탬프 사용")
        return segments, False

    try:
        import torch
        import whisperx
    except ImportError as e:
        report("warning", 86, f"정렬 라이브러리 로드 실패({e}) — 기본 타임스탬프 사용")
        return segments, False

    align_device = "cuda" if (device == "cuda" and torch.cuda.is_available()) else "cpu"

    try:
        report("aligning", 86, f"정렬 모델 로딩 중 ({language}, {align_device})...")
        model_a, metadata = whisperx.load_align_model(
            language_code=language, device=align_device)
        audio = whisperx.load_audio(audio_path)
        report("aligning", 88, "타임스탬프 정밀 정렬 중...")
        result = whisperx.align(
            segments, model_a, metadata, audio, align_device,
            return_char_alignments=False)
        aligned = result["segments"]
        report("aligning", 92, f"정렬 완료 ({len(aligned)}개 구간)")
        return aligned, True
    except BaseException as e:
        # frozen(PyInstaller) 환경에서 SystemExit 등 Exception이 아닌 예외도
        # 파이프라인을 죽이지 않도록 BaseException까지 폴백 처리
        if align_device == "cuda":
            # GPU 실패(OOM 등) 시 CPU로 1회 재시도
            try:
                report("aligning", 86, f"GPU 정렬 실패({type(e).__name__}) — CPU로 재시도...")
                model_a, metadata = whisperx.load_align_model(
                    language_code=language, device="cpu")
                audio = whisperx.load_audio(audio_path)
                result = whisperx.align(
                    segments, model_a, metadata, audio, "cpu",
                    return_char_alignments=False)
                report("aligning", 92, "정렬 완료 (CPU)")
                return result["segments"], True
            except BaseException as e2:
                report("warning", 92, f"정렬 실패({type(e2).__name__}: {e2}) — 기본 타임스탬프 사용")
                return segments, False
        report("warning", 92, f"정렬 실패({type(e).__name__}: {e}) — 기본 타임스탬프 사용")
        return segments, False
