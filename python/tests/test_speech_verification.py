import os
import sys
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import process_video
from speech_filter import unreliable_segment, restore_speech_segments
from speech_verification import verify_short_regions


def segment(text, start=0, end=.5, **metrics):
    return {'words': [{'word': text, 'start': start, 'end': end, 'probability': .95}],
            'avg_logprob': -.1, 'no_speech_prob': .05, **metrics}


@pytest.mark.parametrize('text,logprob,no_speech', [
    ('ご視聴', -.435791, .905273), ('はぁ', -.27578, .725586)])
def test_real_laughter_and_breathing_false_positives_are_rejected(text, logprob, no_speech):
    prediction = segment(text, avg_logprob=logprob, no_speech_prob=no_speech)
    assert not unreliable_segment(prediction)
    assert unreliable_segment(prediction, strict=True)
    assert restore_speech_segments([prediction], [{'start': 0, 'end': 16000}], strict=True) == []


def test_a_genuinely_spoken_stock_phrase_is_not_blacklisted():
    prediction = segment('ご視聴ありがとうございました', end=2, no_speech_prob=.9)
    assert not unreliable_segment(prediction, strict=True)
    assert restore_speech_segments([prediction], [{'start': 0, 'end': 32000}], strict=True)


def test_untimed_majority_cannot_become_a_short_plausible_fragment():
    prediction = segment('ご視聴', end=.6)
    prediction['words'].append({'word': 'ありがとうございました', 'start': .6, 'end': .6})
    def forbidden(_):
        pytest.fail('A rejected prediction should not be re-decoded')
    result, _ = verify_short_regions(np.zeros(16000), [prediction],
                                    [{'start': 0, 'end': 16000}], forbidden)
    assert result == []


def test_a_short_noise_island_is_checked_without_neighboring_dialogue():
    audio = np.concatenate([np.ones(32000), np.full(8000, .25)])
    prediction = segment('今日は晴れです', end=1.8)
    prediction['words'].append({'word': 'ありがとう', 'start': 2.1, 'end': 2.4})
    chunks = [{'start': 16000, 'end': 48000}, {'start': 160000, 'end': 168000}]
    calls = []
    def decode(sample):
        calls.append(sample)
        return []
    result, excluded = verify_short_regions(audio, [prediction], chunks, decode)
    assert excluded == 1
    assert len(calls) == 1 and np.array_equal(calls[0], np.full(8000, .25))
    restored = restore_speech_segments(result, chunks, strict=True)
    assert [w['word'] for s in restored for w in s['words']] == ['今日は晴れです']
    assert restored[0]['start'] == 1


@pytest.mark.parametrize('expected,confirmed,kept', [
    ('はい', 'はい', True), ('はい', 'はぁ', False), ('明日は晴れです', '明日は晴れ', True),
    ('待って', 'ご視聴ありがとうございました', False)])
def test_independent_confirmation_keeps_short_dialogue(expected, confirmed, kept):
    result, count = verify_short_regions(np.zeros(16000), [segment(expected)],
        [{'start': 0, 'end': 16000}], lambda _: [segment(confirmed)])
    words = [w for s in result for w in s['words']]
    assert bool(words) is kept
    assert count == (0 if kept else 1)


def test_verification_failure_is_not_silently_bypassed():
    def fail(_):
        raise RuntimeError('decoder failed')
    with pytest.raises(RuntimeError, match='decoder failed'):
        verify_short_regions(np.zeros(16000), [segment('はい')],
                             [{'start': 0, 'end': 16000}], fail)


def test_mixed_dialogue_window_cannot_hide_weak_words_on_longer_laughter():
    prediction = segment('そんな違うんだ', end=1.5, avg_logprob=-.195, no_speech_prob=.00005)
    prediction['words'][0]['probability'] = .0243
    result, count = verify_short_regions(np.zeros(40000), [prediction],
        [{'start': 0, 'end': 40000}], lambda _: [])
    assert count == 1 and not result[0]['words']


@pytest.mark.parametrize('engine', ['faster-whisper', 'openai-whisper'])
def test_verification_reuses_model_without_names_or_previous_dialogue(monkeypatch, engine):
    calls = []
    confirmed = segment('はい')
    def transcribe(audio, **settings):
        calls.append(settings)
        if engine == 'openai-whisper':
            return {'segments': [confirmed]}
        value = SimpleNamespace(**{**confirmed, 'compression_ratio': 1,
            'words': [SimpleNamespace(**word) for word in confirmed['words']]})
        return iter([value]), SimpleNamespace(language='ja')
    monkeypatch.setattr(process_video, '_whisper_model', SimpleNamespace(transcribe=transcribe))
    monkeypatch.setattr(process_video, 'prepare_speech',
        lambda _: (np.zeros(16000), [{'start': 0, 'end': 16000}]))
    monkeypatch.setattr(process_video, '_transcribe_faster', lambda *a: ([segment('はい')], 'ja', 'cpu'))
    monkeypatch.setattr(process_video, '_transcribe_openai', lambda *a: ([segment('はい')], 'ja', 'cpu'))
    result, lang, _ = process_video.transcribe_audio('clip.wav', engine=engine, language='ja', terms='大橋')
    assert result and lang == 'ja'
    assert len(calls) == 1
    assert calls[0]['condition_on_previous_text'] is False
    assert calls[0]['language'] == 'ja'
    assert calls[0].get('hotwords') is None
    assert calls[0].get('initial_prompt') is None
    assert not calls[0].get('carry_initial_prompt', False)
