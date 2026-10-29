"""자막 후처리: 정렬된 단어 타임스탬프 → 방송 규칙 기반 자막 목록.

순수 함수만 포함. 입력 단어: {"word", "start", "end"} (start/end None 허용).
출력 자막: {"start", "end", "text"} (text 최대 2줄, \n 구분).
"""

GAP_SPLIT = 0.6
MAX_DURATION = 6.0
MIN_DURATION = 0.8
MERGE_GAP = 0.3
MAX_LINE_CJK = 20
MAX_LINE_LATIN = 42
MAX_LINES = 2
NOSPACE_LANGS = {"ja", "zh"}
CJK_LANGS = {"ko", "ja", "zh"}


def fill_missing_timestamps(words):
    """start/end가 None인 단어를 이웃 단어 시각으로 보간."""
    out = [dict(w) for w in words]
    for i, w in enumerate(out):
        if w["start"] is None or w["end"] is None:
            prev_end = None
            for j in range(i - 1, -1, -1):
                if out[j]["end"] is not None:
                    prev_end = out[j]["end"]
                    break
            next_start = None
            for j in range(i + 1, len(out)):
                if out[j]["start"] is not None:
                    next_start = out[j]["start"]
                    break
            if prev_end is None and next_start is None:
                w["start"] = w["start"] if w["start"] is not None else 0.0
                w["end"] = w["end"] if w["end"] is not None else w["start"]
            else:
                w["start"] = prev_end if prev_end is not None else next_start
                w["end"] = next_start if next_start is not None else prev_end
    return out


def split_at_gaps(words, gap=GAP_SPLIT):
    """단어 간 무음이 gap 이상이면 자막 그룹 분할."""
    groups = []
    current = []
    for w in words:
        if current and (w["start"] - current[-1]["end"] >= gap
                        or w.get("speech_region") != current[-1].get("speech_region")):
            groups.append(current)
            current = []
        current.append(w)
    if current:
        groups.append(current)
    return groups


def _split_group_by_duration(group, max_duration=MAX_DURATION):
    """그룹이 max_duration 초과 시 중앙에 가장 가까운 단어 경계에서 재귀 분할."""
    if group[-1]["end"] - group[0]["start"] <= max_duration or len(group) < 2:
        return [group]
    mid_time = (group[0]["start"] + group[-1]["end"]) / 2
    best_idx = 1
    best_dist = float("inf")
    for i in range(1, len(group)):
        boundary = group[i]["start"]
        if abs(boundary - mid_time) < best_dist:
            best_dist = abs(boundary - mid_time)
            best_idx = i
    left, right = group[:best_idx], group[best_idx:]
    return _split_group_by_duration(left, max_duration) + \
        _split_group_by_duration(right, max_duration)


def enforce_limits(groups, max_duration=MAX_DURATION,
                   min_duration=MIN_DURATION, merge_gap=MERGE_GAP):
    """최대 시간 초과 분할 + 짧은 그룹 인접 병합."""
    result = []
    for g in groups:
        result.extend(_split_group_by_duration(g, max_duration))

    merged = []
    for g in result:
        if merged:
            prev = merged[-1]
            prev_dur = prev[-1]["end"] - prev[0]["start"]
            cur_dur = g[-1]["end"] - g[0]["start"]
            gap = g[0]["start"] - prev[-1]["end"]
            combined = g[-1]["end"] - prev[0]["start"]
            # 앞뒤 어느 쪽이든 너무 짧으면 인접 그룹과 병합
            if ((cur_dur < min_duration or prev_dur < min_duration)
                    and gap <= merge_gap and combined <= max_duration
                    and prev[-1].get("speech_region") == g[0].get("speech_region")):
                merged[-1] = prev + g
                continue
        merged.append(g)
    return merged


def join_words(words, lang):
    if lang not in NOSPACE_LANGS and any(w["word"][:1].isspace() for w in words):
        # Whisper encodes word boundaries as leading spaces. Do not insert a
        # space into contractions, hyphenated names, or attached punctuation.
        return "".join(w["word"] for w in words).strip()
    sep = "" if lang in NOSPACE_LANGS else " "
    return sep.join(w["word"].strip() for w in words).strip()


def split_for_readability(groups, lang):
    """Split on timed word boundaries before wrapping can overflow two lines."""
    max_len = MAX_LINE_CJK if lang in CJK_LANGS else MAX_LINE_LATIN
    result = []
    for group in groups:
        current = []
        for word in group:
            while current:
                wrapped = wrap_lines(join_words(current + [word], lang), lang)
                if all(len(line) <= max_len for line in wrapped.split("\n")):
                    break
                # Prefer complete clauses over a mid-sentence character cutoff,
                # especially before Japanese text goes to translation.
                boundaries = [i + 1 for i, token in enumerate(current)
                              if token['word'].rstrip().endswith(('。', '！', '？', '!', '?', '、'))]
                cut = boundaries[-1] if boundaries else len(current)
                result.append(current[:cut])
                current = current[cut:]
            current.append(word)
        if current:
            result.append(current)
    return result


def wrap_lines(text, lang, max_lines=MAX_LINES):
    """언어별 최대 줄 길이로 줄바꿈 (최대 max_lines줄)."""
    max_len = MAX_LINE_CJK if lang in CJK_LANGS else MAX_LINE_LATIN
    if len(text) <= max_len:
        return text

    if lang in NOSPACE_LANGS:
        # 공백 없는 언어: 글자 수로 균등 분할
        n_lines = min(max_lines, (len(text) + max_len - 1) // max_len)
        per_line = (len(text) + n_lines - 1) // n_lines
        lines = [text[i:i + per_line] for i in range(0, len(text), per_line)]
    else:
        # 공백 있는 언어: 단어 경계에서 분할
        lines = []
        current = ""
        for word in text.split(" "):
            candidate = (current + " " + word).strip()
            if len(candidate) <= max_len or not current:
                current = candidate
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)
        # 공백이 없어 max_len을 넘는 줄은 글자 단위로 강제 분할
        lines = [chunk for line in lines
                 for chunk in (line[i:i + max_len]
                               for i in range(0, len(line), max_len))]

    if len(lines) > max_lines:
        # 줄 수 초과 시 텍스트를 버리지 않고 마지막 줄에 합침
        # (상류의 enforce_limits가 대부분 방지하므로 드문 케이스)
        sep = "" if lang in NOSPACE_LANGS else " "
        lines = lines[:max_lines - 1] + [sep.join(lines[max_lines - 1:])]
    return "\n".join(lines)


def postprocess(segments, lang):
    """정렬된 세그먼트 목록 → 자막 목록.

    - words가 있는 세그먼트: 단어 기반 분할/트리밍
    - words 키가 없는 세그먼트(폴백): 세그먼트 시각 그대로 사용
    - words가 빈 리스트인 세그먼트(정렬이 환각으로 판정): 제거
    """
    all_words = []
    fallback_subs = []
    for seg in segments:
        if "words" not in seg:
            fallback_subs.append({
                "start": seg["start"], "end": seg["end"],
                "text": wrap_lines(seg["text"].strip(), lang),
            })
            continue
        if not seg["words"]:
            continue  # 환각 의심: 정렬된 단어 없음
        all_words.extend(fill_missing_timestamps(seg["words"]))

    subs = []
    all_words.sort(key=lambda w: (w["start"], w["end"]))
    groups = split_for_readability(enforce_limits(split_at_gaps(all_words)), lang)
    for i, g in enumerate(groups):
        start, end = g[0]["start"], g[-1]["end"]
        if end - start < MIN_DURATION:
            # 가독성보다 발화 경계가 우선: 무음/영상 끝까지 늘리지 않는다.
            limit = groups[i + 1][0]["start"] if i + 1 < len(groups) else float("inf")
            limit = min(limit, g[-1].get("speech_end", end))
            end = min(start + MIN_DURATION, limit)
        text = join_words(g, lang)
        if not text:
            continue
        subs.append({"start": start, "end": end, "text": wrap_lines(text, lang)})

    subs.extend(fallback_subs)
    subs.sort(key=lambda s: s["start"])
    return subs
