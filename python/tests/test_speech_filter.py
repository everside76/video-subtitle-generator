"""Speech gating regressions: no downloaded recognition models required."""
import os
import sys
import wave

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import process_video
from speech_filter import (
    SAMPLE_RATE, SpeechTimeline, prepare_speech, restore_speech_segments,
    unreliable_segment,
)
from subtitle_postprocess import postprocess


def chunks(*ranges):
    return [{"start": round(start * SAMPLE_RATE), "end": round(end * SAMPLE_RATE)}
            for start, end in ranges]


def word(text, start, end, **extra):
    return {"word": text, "start": start, "end": end, **extra}


def segment(words, **extra):
    return {"start": 0, "end": 30, "text": "test", "words": words, **extra}


def test_original_timeline_restored_without_subtitles_in_long_silence():
    speech = chunks((5, 6), (20, 21))
    output = restore_speech_segments([
        segment([word("안녕하세요", 0.1, 0.8), word("반갑습니다", 1.1, 1.8)])
    ], speech)
    subtitles = postprocess(output, "ko")
    assert len(subtitles) == 2
    assert subtitles[0]["start"] == pytest.approx(5.1)
    assert subtitles[0]["end"] <= 6
    assert subtitles[1]["start"] == pytest.approx(20.1)
    assert subtitles[1]["end"] <= 21


def test_short_silence_is_not_rejoined_by_minimum_duration_rule():
    output = restore_speech_segments([
        segment([word("네", 0, 0.2), word("맞아요", 0.2, 0.4)])
    ], chunks((0, 0.2), (0.4, 0.6)))
    subtitles = postprocess(output, "ko")
    assert len(subtitles) == 2
    assert subtitles[0]["end"] == pytest.approx(0.2)
    assert subtitles[1]["start"] == pytest.approx(0.4)
    assert subtitles[1]["end"] == pytest.approx(0.6)


def test_word_crossing_concatenation_join_stays_in_one_speech_region():
    timeline = SpeechTimeline(chunks((3, 4), (10, 11)))
    before = timeline.restore_interval(0.7, 1.1)
    after = timeline.restore_interval(0.9, 1.3)
    assert before["start"] == pytest.approx(3.7)
    assert before["end"] == 4
    assert after["start"] == 10
    assert after["end"] == pytest.approx(10.3)


@pytest.mark.parametrize("start,end", [
    (None, None), (None, 0.4), (0.2, None), (0.3, 0.3), (0.5, 0.2),
    (-1, 0.5), (float("nan"), 0.5), (0, float("inf")), (1.0, 1.2), (0.9, 5),
])
def test_unplaced_predictions_do_not_get_moved_into_speech(start, end):
    assert restore_speech_segments([
        segment([word("시청해 주셔서 감사합니다", start, end)])
    ], chunks((5, 6))) == []


def test_no_speech_drops_even_confident_predictions():
    assert restore_speech_segments([
        segment([word("hallucination", 0, 1, probability=0.99)], avg_logprob=-0.01)
    ], []) == []


def test_low_confidence_and_non_speech_evidence_required_together():
    assert unreliable_segment({"avg_logprob": -0.8, "no_speech_prob": 0.9})
    assert not unreliable_segment({"avg_logprob": -0.1, "no_speech_prob": 0.9})
    assert not unreliable_segment({"avg_logprob": -0.8, "no_speech_prob": 0.1})
    assert not unreliable_segment({})


def test_uncertain_repetition_is_removed_but_confident_real_repeats_survive():
    assert unreliable_segment({"avg_logprob": -1.5, "compression_ratio": 3})
    assert not unreliable_segment({"avg_logprob": -0.1, "compression_ratio": 3})


def test_common_hallucination_phrases_are_kept_when_actually_spoken():
    text = "시청해 주셔서 감사합니다."
    output = restore_speech_segments([
        segment([word(text, 0, 1)], avg_logprob=-0.1, no_speech_prob=0.01)
    ], chunks((5, 6)))
    assert postprocess(output, "ko")[0]["text"] == text


def test_weak_word_does_not_remove_confident_neighbors_or_low_volume_speech():
    output = restore_speech_segments([
        segment([word("real", 0, 0.3, probability=0.9),
                 word("invented", 0.3, 0.5, probability=0.02)], avg_logprob=-1.2),
        segment([word("quiet", 0.5, 0.9, probability=0.02)], avg_logprob=-0.2),
    ], chunks((0, 1)))
    assert [w["word"] for s in output for w in s["words"]] == ["real", "quiet"]


def test_fallback_segment_cannot_bridge_removed_silence():
    assert restore_speech_segments([
        {"start": 0.5, "end": 1.5, "text": "unplaced text"},
    ], chunks((0, 1), (10, 11))) == []
    restored = restore_speech_segments([
        {"start": 1.1, "end": 1.5, "text": "placed text"},
    ], chunks((0, 1), (10, 11)))
    assert restored[0]["start"] == pytest.approx(10.1)
    assert restored[0]["end"] == pytest.approx(10.5)


@pytest.mark.parametrize("engine,implementation", [
    ("faster-whisper", "_transcribe_faster"),
    ("openai-whisper", "_transcribe_openai"),
    ("crisperwhisper", "_transcribe_crisperwhisper"),
])
def test_every_engine_receives_only_speech_and_returns_original_times(
        monkeypatch, engine, implementation):
    audio = np.zeros(SAMPLE_RATE, dtype=np.float32)
    monkeypatch.setattr(process_video, "prepare_speech",
                        lambda path: (audio, chunks((10, 11))))

    def recognize(received_audio, *args):
        assert received_audio is audio
        return [segment([word("hello", 0.2, 0.6)])], "en", "cpu"

    monkeypatch.setattr(process_video, implementation, recognize)
    output, lang, device = process_video.transcribe_audio("input.wav", engine=engine)
    assert output[0]["words"][0]["start"] == pytest.approx(10.2)
    assert output[0]["words"][0]["end"] == pytest.approx(10.6)
    assert (lang, device) == ("en", "cpu")


@pytest.mark.parametrize("engine", ["faster-whisper", "openai-whisper", "crisperwhisper"])
def test_silent_recording_never_loads_any_recognition_model(monkeypatch, engine):
    monkeypatch.setattr(process_video, "prepare_speech",
                        lambda path: (np.empty(0, dtype=np.float32), []))

    def forbidden(*args, **kwargs):
        pytest.fail("A recognition model must not be loaded on silence")

    for implementation in ("_transcribe_faster", "_transcribe_openai", "_transcribe_crisperwhisper"):
        monkeypatch.setattr(process_video, implementation, forbidden)
    output, lang, _device = process_video.transcribe_audio("silent.wav", engine=engine)
    assert output == []
    assert lang == "unknown"


def test_vad_failure_is_not_silently_bypassed(monkeypatch):
    def broken(path):
        raise RuntimeError("VAD unavailable")

    monkeypatch.setattr(process_video, "prepare_speech", broken)
    with pytest.raises(RuntimeError, match="VAD unavailable"):
        process_video.transcribe_audio("input.wav")


@pytest.mark.parametrize("signal", ["silence", "noise", "tone"])
def test_real_vad_rejects_non_speech_audio(tmp_path, signal):
    samples = np.zeros(SAMPLE_RATE * 3, dtype=np.float32)
    if signal == "noise":
        samples = np.random.default_rng(42).normal(0, 0.003, len(samples))
    elif signal == "tone":
        samples = 0.05 * np.sin(2 * np.pi * 440 * np.arange(len(samples)) / SAMPLE_RATE)
    path = tmp_path / "non-speech.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes((samples * 32767).astype("<i2").tobytes())
    audio, speech = prepare_speech(str(path))
    assert speech == []
    assert audio.size == 0
