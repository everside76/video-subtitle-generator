"""Verify short or uncertain VAD islands without prompts before emitting dialogue.

VAD recognizes human vocal activity, including breathing/laughter. A decoder
may confidently complete a sentence from neighboring dialogue on those sounds.
Requiring an independent, unprompted reading of short islands reduces that
failure without banning any phrase or loading a second recognition model.
"""
from difflib import SequenceMatcher
from speech_filter import SAMPLE_RATE, SpeechTimeline, unreliable_segment
from math import isfinite


def _text(words):
    return ''.join(c for w in words for c in w.get('word', '').casefold() if c.isalnum())


def _needs_verification(duration, words):
    if duration <= 1.2:
        return True
    probabilities = [w.get('probability') for w in words if _text([w])]
    probabilities = [p for p in probabilities if isinstance(p, (float, int)) and isfinite(p)]
    # Segment-level confidence describes a whole decoder window. In mixed
    # dialogue/noise it can be high even when individual predicted words are weak.
    return duration <= 8 and bool(probabilities) and (
        min(probabilities) < .15 or sum(probabilities) / len(probabilities) < .6)


def verify_short_regions(audio, segments, chunks, decode, on_progress=None):
    timeline = SpeechTimeline(chunks)
    by_region = {}
    for segment in segments:
        if unreliable_segment(segment, strict=True):
            continue
        for word in segment.get('words') or []:
            timing = timeline.restore_interval(word.get('start'), word.get('end'))
            if timing:
                by_region.setdefault(timing['speech_region'], []).append(word)
    rejected = set()
    candidates = [(index, words) for index, words in by_region.items()
                  if _needs_verification(timeline.regions[index][1] - timeline.regions[index][0], words)]
    for number, (index, words) in enumerate(candidates, 1):
        if on_progress:
            on_progress(number, len(candidates))
        start, end, _, _ = timeline.regions[index]
        local_audio = audio[round(start * SAMPLE_RATE):round(end * SAMPLE_RATE)]
        local_segments = decode(local_audio)
        confirmed_words = []
        local_timeline = SpeechTimeline([{'start': 0, 'end': len(local_audio)}])
        for segment in local_segments:
            if unreliable_segment(segment, strict=True):
                continue
            confirmed_words.extend(w for w in segment.get('words') or []
                                   if local_timeline.restore_interval(w.get('start'), w.get('end')))
        expected, confirmed = _text(words), _text(confirmed_words)
        # Short interjections require exact lexical agreement. Longer phrases
        # allow small orthographic differences, not unrelated fluent sentences.
        agreement = bool(expected and confirmed) and (
            expected == confirmed if min(len(expected), len(confirmed)) <= 3 else
            SequenceMatcher(None, expected, confirmed, autojunk=False).ratio() >= .7)
        if not agreement:
            rejected.add(index)
    output = []
    for segment in segments:
        # Keep the confidence decision on the original words. Removing untimed
        # words first would hide evidence of a largely ungrounded prediction.
        if unreliable_segment(segment, strict=True):
            continue
        if 'words' not in segment:
            output.append(segment)
            continue
        kept = []
        for word in segment.get('words') or []:
            timing = timeline.restore_interval(word.get('start'), word.get('end'))
            if timing and timing['speech_region'] not in rejected:
                kept.append(word)
        output.append({**segment, 'words': kept})
    return output, len(rejected)
