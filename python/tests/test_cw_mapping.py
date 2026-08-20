"""CrisperWhisper 결과 매핑 단위 테스트 (모델 로드 없음)."""
import os
import sys
from types import SimpleNamespace

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


def test_normalize_model():
    assert cw_normalize_model("large") == "large"
    assert cw_normalize_model("turbo") == "turbo"
    assert cw_normalize_model("medium") == "medium"
    assert cw_normalize_model("small") == "small"
    assert cw_normalize_model("large-v3") == "large"
    assert cw_normalize_model("base") == "small"
    assert cw_normalize_model("tiny") == "small"
