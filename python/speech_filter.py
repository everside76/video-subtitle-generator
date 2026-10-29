"""Shared speech gating and original-timeline restoration for every ASR engine.

Silero runs on the original audio before a transcription model is loaded. Only
speech (with a small boundary pad) reaches ASR; timestamps are then restored per
word so a subtitle can never bridge a removed silence.
"""

from bisect import bisect_right
from math import isfinite

SAMPLE_RATE = 16000
VAD_PARAMETERS = {
    "threshold": 0.5,
    "min_speech_duration_ms": 100,
    "min_silence_duration_ms": 400,
    "speech_pad_ms": 100,
}


def prepare_speech(audio_path):
    """Return compact float32 audio and VAD ranges in original sample units.

    Detection errors intentionally propagate: silently bypassing VAD would
    re-enable hallucinations. Do not apply a volume cutoff to quiet speech.
    """
    import numpy as np
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import get_speech_timestamps, VadOptions

    audio = decode_audio(audio_path, sampling_rate=SAMPLE_RATE)
    if not len(audio):
        return audio, []
    chunks = get_speech_timestamps(
        audio, vad_options=VadOptions(**VAD_PARAMETERS),
        sampling_rate=SAMPLE_RATE,
    )
    if not chunks:
        return np.empty(0, dtype=np.float32), []
    # Concatenate once; repeatedly concatenating long recordings is quadratic.
    return np.concatenate([audio[c["start"]:c["end"]] for c in chunks]), chunks


def _number(value):
    return isinstance(value, (int, float)) and isfinite(value)


def unreliable_segment(segment, strict=False):
    """Use combined acoustic evidence, never a blacklist of spoken phrases.

    A high no-speech probability alone also occurs on real quiet speech;
    repetition alone can be intentional. Require weak recognition as well.
    """
    logprob = segment.get("avg_logprob")
    no_speech = segment.get("no_speech_prob")
    compression = segment.get("compression_ratio")
    if strict:
        words = segment.get('words') or []
        total = sum(sum(c.isalnum() for c in w.get('word', '')) for w in words)
        placed = sum(sum(c.isalnum() for c in w.get('word', '')) for w in words
                     if _number(w.get('start')) and _number(w.get('end'))
                     and w['end'] > w['start'] >= 0)
        # Do not turn a largely untimed hallucination into a plausible fragment.
        if total and placed < total * .5:
            return True
    if not _number(logprob):
        return False
    return (
        (_number(no_speech) and no_speech >= 0.6 and logprob < (-0.2 if strict else -0.5))
        or (_number(compression) and compression > 2.4 and logprob < (-0.5 if strict else -1.0))
    )


class SpeechTimeline:
    def __init__(self, chunks, sampling_rate=SAMPLE_RATE):
        self.regions = []
        self.ends = []
        offset = 0
        for chunk in chunks:
            length = chunk["end"] - chunk["start"]
            self.regions.append((offset / sampling_rate,
                                 (offset + length) / sampling_rate,
                                 chunk["start"] / sampling_rate,
                                 chunk["end"] / sampling_rate))
            offset += length
            self.ends.append(offset / sampling_rate)

    def restore_interval(self, start, end):
        """Assign a word to one speech region, clipping at concatenation joins.

        Untimed, zero-length and out-of-audio predictions have no usable acoustic
        placement. Do not interpolate them into a pause or clamp them to EOF.
        """
        if (not self.regions or not _number(start) or not _number(end)
                or start < 0 or end <= start or start >= self.ends[-1]):
            return None
        midpoint = (start + end) / 2
        if midpoint >= self.ends[-1]:
            return None
        index = bisect_right(self.ends, midpoint)
        compact_start, compact_end, original_start, original_end = self.regions[index]
        clipped_start = max(start, compact_start)
        clipped_end = min(end, compact_end)
        if clipped_end - clipped_start < (end - start) * 0.5:
            return None
        return {
            "start": original_start + clipped_start - compact_start,
            "end": min(original_end, original_start + clipped_end - compact_start),
            "speech_region": index,
            "speech_end": original_end,
        }


def restore_speech_segments(segments, chunks, strict=False):
    """Filter weak predictions and restore words to the video's time axis."""
    timeline = SpeechTimeline(chunks)
    restored = []
    for segment in segments:
        if unreliable_segment(segment, strict):
            continue
        if "words" not in segment:
            # Without words, text cannot be assigned safely across two regions.
            timing = timeline.restore_interval(segment["start"], segment["end"])
            if timing is None or not segment.get("text", "").strip():
                continue
            region = timeline.regions[timing["speech_region"]]
            if segment["start"] < region[0] or segment["end"] > region[1]:
                continue
            restored.append({**segment, **timing})
            continue
        words = []
        for word in segment["words"] or []:
            if not word.get("word", "").strip():
                continue
            timing = timeline.restore_interval(word.get("start"), word.get("end"))
            if timing is None:
                continue
            probability = word.get("probability")
            logprob = segment.get("avg_logprob")
            if (_number(probability) and probability < 0.1
                    and _number(logprob) and logprob < -1.0):
                continue
            words.append({**word, **timing})
        if words:
            words.sort(key=lambda w: (w["start"], w["end"]))
            restored.append({**segment, "start": words[0]["start"],
                             "end": words[-1]["end"], "words": words})
    return restored
