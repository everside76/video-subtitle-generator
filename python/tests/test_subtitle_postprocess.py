import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from subtitle_postprocess import (
    fill_missing_timestamps, split_at_gaps, enforce_limits,
    join_words, wrap_lines, postprocess,
)


def w(word, start, end):
    return {"word": word, "start": start, "end": end}


# --- fill_missing_timestamps ---

def test_fill_missing_interpolates_between_neighbors():
    words = [w("a", 0.0, 0.5), w("b", None, None), w("c", 1.5, 2.0)]
    out = fill_missing_timestamps(words)
    assert out[1]["start"] == 0.5
    assert out[1]["end"] == 1.5

def test_fill_missing_at_edges_uses_neighbor():
    words = [w("a", None, None), w("b", 1.0, 2.0)]
    out = fill_missing_timestamps(words)
    assert out[0]["start"] == 1.0 and out[0]["end"] == 1.0


# --- split_at_gaps: 무음 구간 자막 제거의 핵심 ---

def test_split_at_gap_creates_two_groups():
    words = [w("안녕", 0.0, 0.5), w("하세요", 0.5, 1.0),
             w("반갑", 3.0, 3.5), w("습니다", 3.5, 4.0)]
    groups = split_at_gaps(words)
    assert len(groups) == 2
    # 첫 자막은 실제 발화 종료(1.0)에서 끝나야 함 — 무음(1.0~3.0)에 자막 없음
    assert groups[0][-1]["end"] == 1.0
    assert groups[1][0]["start"] == 3.0

def test_no_split_below_gap_threshold():
    words = [w("a", 0.0, 0.5), w("b", 0.9, 1.4)]  # 갭 0.4 < 0.6
    assert len(split_at_gaps(words)) == 1


# --- enforce_limits: 최대/최소 표시 시간 ---

def test_long_group_split_at_max_duration():
    # 8초짜리 그룹 → 2개로 분할
    words = [w(f"w{i}", i * 1.0, i * 1.0 + 0.9) for i in range(8)]
    groups = enforce_limits([words])
    assert len(groups) >= 2
    for g in groups:
        assert g[-1]["end"] - g[0]["start"] <= 6.0 + 1e-6

def test_short_group_merged_with_adjacent():
    g1 = [w("a", 0.0, 0.3)]          # 0.3초 — 너무 짧음
    g2 = [w("b", 0.5, 2.0)]          # 갭 0.2 < MERGE_GAP
    groups = enforce_limits([g1, g2])
    assert len(groups) == 1

def test_short_isolated_group_kept():
    g1 = [w("a", 0.0, 0.3)]          # 짧지만 병합할 이웃 없음
    groups = enforce_limits([g1])
    assert len(groups) == 1
    assert groups[0][0]["start"] == 0.0


# --- join_words / wrap_lines ---

def test_join_korean_with_spaces():
    assert join_words([w("안녕", 0, 1), w("하세요", 1, 2)], "ko") == "안녕 하세요"

def test_join_japanese_without_spaces():
    assert join_words([w("こん", 0, 1), w("にちは", 1, 2)], "ja") == "こんにちは"

def test_wrap_lines_cjk_two_lines():
    text = "가" * 30  # 20자 초과 → 2줄
    wrapped = wrap_lines(text, "ko")
    lines = wrapped.split("\n")
    assert len(lines) == 2
    assert all(len(l) <= 20 for l in lines)

def test_wrap_lines_latin_breaks_at_word_boundary():
    text = "the quick brown fox jumps over the lazy dog again and again"
    wrapped = wrap_lines(text, "en")
    for line in wrapped.split("\n"):
        assert len(line) <= 42

def test_wrap_lines_overflow_keeps_all_text():
    # 3줄 분량이어도 텍스트가 사라지지 않아야 함
    text = "word " * 30
    wrapped = wrap_lines(text.strip(), "en")
    assert wrapped.replace("\n", " ") == text.strip()
    assert len(wrapped.split("\n")) <= 2


# --- postprocess 통합 ---

def test_postprocess_end_to_end_silence_gap():
    segments = [{
        "start": 0.0, "end": 5.0, "text": "안녕하세요 반갑습니다",
        "words": [w("안녕하세요", 0.0, 1.0), w("반갑습니다", 4.0, 5.0)],
    }]
    subs = postprocess(segments, "ko")
    assert len(subs) == 2
    assert subs[0]["end"] == 1.0      # 무음 시작 전에 자막 종료
    assert subs[1]["start"] == 4.0

def test_postprocess_drops_segment_without_words():
    segments = [{"start": 0.0, "end": 2.0, "text": "환각텍스트", "words": []}]
    assert postprocess(segments, "ko") == []

def test_postprocess_min_duration_extension():
    segments = [{
        "start": 0.0, "end": 0.4, "text": "네",
        "words": [w("네", 0.0, 0.4)],
    }]
    subs = postprocess(segments, "ko")
    assert subs[0]["end"] - subs[0]["start"] >= 0.8

def test_postprocess_extension_capped_by_next_subtitle():
    segments = [{
        "start": 0.0, "end": 0.3, "text": "네 알겠습니다",
        "words": [w("네", 0.0, 0.3), w("알겠습니다", 1.0, 2.0)],
    }]
    subs = postprocess(segments, "ko")
    assert len(subs) == 2
    assert subs[0]["end"] <= subs[1]["start"]  # 다음 자막과 겹치지 않음

def test_postprocess_fallback_segment_without_word_field():
    # 정렬/word_timestamps 모두 실패한 세그먼트: words 키 자체가 없음 → 세그먼트 시각 그대로 사용
    segments = [{"start": 0.0, "end": 2.0, "text": "hello world"}]
    subs = postprocess(segments, "en")
    assert len(subs) == 1
    assert subs[0]["text"] == "hello world"
