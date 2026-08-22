"""CrisperWhisper 엔진 단위 테스트: 결과 매핑, 상류 API 계약, impl/재시도 오케스트레이션 (모델 로드 없음)."""
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from process_video import cw_normalize_model, cw_words_to_segments


def W(word, start, end):
    return SimpleNamespace(word=word, start=start, end=end)


def test_words_to_single_segment():
    words = [W("Hello", 0.5, 0.9), W("world", 1.0, 1.4)]
    segs = cw_words_to_segments(words, "Hello world")
    assert len(segs) == 1
    assert segs[0]["start"] == 0.5
    assert segs[0]["end"] == 1.4
    assert segs[0]["text"] == "Hello world"
    assert segs[0]["words"] == [
        {"word": "Hello", "start": 0.5, "end": 0.9},
        {"word": "world", "start": 1.0, "end": 1.4},
    ]


def test_empty_words_returns_empty():
    assert cw_words_to_segments([], "text") == []


def test_all_none_timestamps_returns_empty():
    assert cw_words_to_segments([W("x", None, None)], "x") == []


def test_partial_none_kept_for_postprocess():
    words = [W("a", 0.0, 0.2), W("b", None, None), W("c", 0.5, 0.7)]
    segs = cw_words_to_segments(words, "a b c")
    assert segs[0]["start"] == 0.0
    assert segs[0]["end"] == 0.7
    assert segs[0]["words"][1] == {"word": "b", "start": None, "end": None}


def test_leading_none_timestamp():
    words = [W("a", None, None), W("b", 0.5, 0.9)]
    segs = cw_words_to_segments(words, "a b")
    assert segs[0]["start"] == 0.5
    assert segs[0]["end"] == 0.9
    assert segs[0]["words"][0] == {"word": "a", "start": None, "end": None}


def test_normalize_model():
    assert cw_normalize_model("large") == "large"
    assert cw_normalize_model("turbo") == "turbo"
    assert cw_normalize_model("medium") == "medium"
    assert cw_normalize_model("small") == "small"
    assert cw_normalize_model("large-v3") == "large"
    assert cw_normalize_model("base") == "small"
    assert cw_normalize_model("tiny") == "small"


def test_wordtimestamp_contract():
    crisperwhisper = pytest.importorskip("crisperwhisper")
    import dataclasses
    fields = {f.name for f in dataclasses.fields(crisperwhisper.WordTimestamp)}
    assert {"word", "start", "end"} <= fields
    assert set(crisperwhisper.OFFICIAL_MODELS) >= {"large", "turbo", "medium", "small"}


def test_impl_returns_empty_on_no_words(monkeypatch):
    crisperwhisper = pytest.importorskip("crisperwhisper")
    import process_video

    class FakeResult:
        text = ""
        language = "en"
        words = None

    class FakeModel:
        def __init__(self, *a, **k):
            pass

        def transcribe(self, *a, **k):
            return FakeResult()

    monkeypatch.setattr(process_video, "_whisper_model", None)
    monkeypatch.setattr(crisperwhisper, "CrisperWhisperModel", FakeModel)
    segments, lang, device = process_video._transcribe_crisperwhisper_impl(
        "dummy.wav", "large", "cpu", "en", "intended")
    assert segments == []
    assert lang == "en"
    assert device == "cpu"


def _run_orchestrator(monkeypatch, device, impl_behaviors):
    """impl을 가짜로 바꿔 _transcribe_crisperwhisper의 재시도 분기를 검증."""
    pytest.importorskip("crisperwhisper")
    import process_video

    calls = []

    def fake_impl(audio_path, cw_size, actual_device, language, mode):
        calls.append(actual_device)
        behavior = impl_behaviors[len(calls) - 1]
        if isinstance(behavior, Exception):
            raise behavior
        return behavior

    monkeypatch.setattr(process_video, "_transcribe_crisperwhisper_impl", fake_impl)
    monkeypatch.setattr(process_video, "_download_cw_model", lambda repo_id: None)
    monkeypatch.setattr(process_video, "_release_torch_vram", lambda: None)
    result = process_video._transcribe_crisperwhisper(
        "dummy.wav", "large", device, "en", "intended")
    return result, calls


def test_orchestrator_cpu_failure_propagates(monkeypatch):
    with pytest.raises(RuntimeError, match="boom"):
        _run_orchestrator(monkeypatch, "cpu", [RuntimeError("boom")])


def test_orchestrator_gpu_failure_retries_cpu(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    ok = ([{"start": 0, "end": 1, "text": "x", "words": []}], "en", "cpu")
    result, calls = _run_orchestrator(
        monkeypatch, "auto", [RuntimeError("CUDA out of memory"), ok])
    assert calls == ["cuda", "cpu"]
    assert result == ok


def test_orchestrator_gpu_then_cpu_failure_propagates(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    with pytest.raises(RuntimeError, match="cpu fail"):
        _run_orchestrator(monkeypatch, "auto",
                          [RuntimeError("CUDA out of memory"),
                           RuntimeError("cpu fail")])


def test_orchestrator_non_gpu_error_not_retried(monkeypatch):
    import torch
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    with pytest.raises(ValueError, match="bad token"):
        _run_orchestrator(monkeypatch, "auto", [ValueError("bad token")])


def test_is_gpu_failure_classification():
    import process_video
    assert process_video._is_gpu_failure(RuntimeError("CUDA out of memory. Tried to allocate"))
    assert process_video._is_gpu_failure(RuntimeError("CUBLAS_STATUS_ALLOC_FAILED"))
    assert not process_video._is_gpu_failure(ValueError("bad token"))
    assert not process_video._is_gpu_failure(FileNotFoundError("model.safetensors"))


def test_orchestrator_success_no_retry(monkeypatch):
    ok = ([{"start": 0, "end": 1, "text": "x", "words": []}], "en", "cpu")
    result, calls = _run_orchestrator(monkeypatch, "cpu", [ok])
    assert calls == ["cpu"]
    assert result == ok
