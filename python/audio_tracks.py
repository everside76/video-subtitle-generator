"""Explicit audio-stream selection; no guessing a center channel by index."""
import json
import subprocess
import sys


def probe_audio_streams(video_path, ffprobe_path):
    result = subprocess.run(
        [ffprobe_path, "-v", "error", "-select_streams", "a", "-show_streams",
         "-of", "json", video_path], capture_output=True, timeout=30,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    if result.returncode:
        raise RuntimeError("음성 트랙을 읽을 수 없습니다: "
                           + result.stderr.decode("utf-8", errors="replace")[-500:])
    return json.loads(result.stdout).get("streams", [])


def select_audio_stream(streams, requested="auto"):
    if not streams:
        raise ValueError("영상에 음성 트랙이 없습니다.")
    if requested != "auto":
        try:
            index = int(requested)
        except (ValueError, TypeError):
            raise ValueError("올바르지 않은 음성 트랙 번호입니다.") from None
        for stream in streams:
            if stream["index"] == index:
                return stream
        raise ValueError(f"선택한 음성 트랙({index})이 파일에 없습니다.")
    # Honor the container's default. Explicit UI selection handles dub/commentary.
    return next((s for s in streams if s.get("disposition", {}).get("default")), streams[0])


def has_center_channel(stream):
    layout = stream.get("channel_layout", "")
    return (layout in {"3.0", "3.1", "4.0", "4.1", "5.0",
                       "5.0(side)", "5.1", "5.1(side)", "6.0",
                       "hexagonal", "6.1", "6.1(back)",
                       "7.0", "7.0(front)", "7.1", "7.1(wide)", "7.1(wide-side)",
                       "octagonal", "3.1.2", "5.1.2", "5.1.2(back)", "5.1.4", "7.1.2", "7.1.4"}
            or "FC" in layout.split("+"))


def extraction_args(video_path, audio_path, stream, mix="full"):
    if mix not in {"full", "center"}:
        raise ValueError("지원하지 않는 음성 믹스입니다.")
    args = ["-nostdin", "-y", "-i", video_path, "-map", f"0:{stream['index']}", "-vn"]
    if mix == "center" and has_center_channel(stream):
        args += ["-af", "pan=mono|c0=FC"]
    return args + ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav", audio_path]
