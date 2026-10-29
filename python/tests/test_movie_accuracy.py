import os
import sys
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import process_video
from audio_tracks import select_audio_stream, extraction_args, has_center_channel
from subtitle_postprocess import postprocess, join_words


def test_audio_stream_selection_uses_absolute_index_and_container_default():
    streams = [{'index': 2}, {'index': 4, 'disposition': {'default': 1}}]
    assert select_audio_stream(streams)['index'] == 4
    assert select_audio_stream(streams, '2')['index'] == 2
    with pytest.raises(ValueError):
        select_audio_stream(streams, '0')
    with pytest.raises(ValueError):
        select_audio_stream([], 'auto')


@pytest.mark.parametrize('layout,expected', [('5.1', True), ('5.1(side)', True),
    ('stereo', False), ('2.1', False), ('quad', False), ('3.0(back)', False),
    ('6.0(front)', False), ('6.1(front)', False), ('', False), ('FL+FR+FC+LFE', True)])
def test_center_channel_requires_a_known_center_layout(layout, expected):
    stream = {'index': 3, 'channels': 6, 'channel_layout': layout}
    assert has_center_channel(stream) is expected
    args = extraction_args('movie.mkv', 'out.wav', stream, 'center')
    assert args[args.index('-map') + 1] == '0:3'
    assert ('pan=mono|c0=FC' in args) is expected


def test_gpu_precision_falls_back_on_same_gpu_before_cpu(monkeypatch):
    monkeypatch.setattr(process_video, 'detect_device', lambda *args: ('cuda', 'float16'))
    monkeypatch.setattr(process_video, '_unload_ct2_vram', lambda: None)
    calls = []
    def decode(audio, model, device, computation, language, terms):
        calls.append((device, computation, language, terms))
        if device == 'cuda':
            raise RuntimeError('CUDA out of memory')
        return [], 'en', 'cpu'
    monkeypatch.setattr(process_video, '_transcribe_faster_impl', decode)
    process_video._transcribe_faster(None, terms='Elara', language='en')
    assert calls == [('cuda', 'float16', 'en', 'Elara'),
                     ('cuda', 'int8_float16', 'en', 'Elara'), ('cpu', 'int8', 'en', 'Elara')]


def test_download_or_input_error_does_not_trigger_a_slow_cpu_retry(monkeypatch):
    monkeypatch.setattr(process_video, 'detect_device', lambda *args: ('cuda', 'float16'))
    calls = []
    def fail(*args):
        calls.append(args)
        raise ValueError('invalid model name')
    monkeypatch.setattr(process_video, '_transcribe_faster_impl', fail)
    with pytest.raises(ValueError, match='invalid model name'):
        process_video._transcribe_faster(None)
    assert len(calls) == 1


@pytest.mark.parametrize('engine', ['faster-whisper', 'openai-whisper'])
def test_vocabulary_never_reaches_a_model_when_audio_is_silent(monkeypatch, engine):
    monkeypatch.setattr(process_video, 'prepare_speech',
                        lambda _: (np.empty(0, dtype=np.float32), []))
    def forbidden(*args):
        pytest.fail('Silence must not reach a prompted model')
    monkeypatch.setattr(process_video, '_transcribe_faster', forbidden)
    monkeypatch.setattr(process_video, '_transcribe_openai', forbidden)
    assert process_video.transcribe_audio('silent.wav', engine=engine, terms='Asterion protocol')[0] == []


def test_faster_vocabulary_is_repeated_hotwords_without_previous_text(monkeypatch):
    calls = []
    class Model:
        def __init__(self, *args, **kwargs): pass
        def transcribe(self, audio, **kwargs):
            calls.append(kwargs)
            return iter([]), SimpleNamespace(language='en', language_probability=1.0)
    monkeypatch.setitem(sys.modules, 'faster_whisper', SimpleNamespace(WhisperModel=Model))
    monkeypatch.setattr(process_video, '_whisper_model', None)
    process_video._transcribe_faster_impl(np.zeros(16000), 'base', 'cpu', 'int8', 'auto', 'Elara Voss')
    assert calls[0]['hotwords'] == 'Elara Voss'
    assert calls[0]['condition_on_previous_text'] is False
    assert calls[0]['language'] is None
    assert calls[0]['language_detection_segments'] == 3


def test_openai_vocabulary_carries_to_later_decode_windows(monkeypatch):
    calls = []
    def transcribe(audio, **kwargs):
        calls.append(kwargs)
        return {'segments': [], 'language': 'fr'}
    monkeypatch.setitem(sys.modules, 'torch', SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False)))
    monkeypatch.setitem(sys.modules, 'whisper', SimpleNamespace(load_model=lambda *a, **k: SimpleNamespace(transcribe=transcribe)))
    monkeypatch.setattr(process_video, '_whisper_model', None)
    process_video._transcribe_openai(np.zeros(16000), 'base', 'cpu', 'fr', 'Jean-Luc')
    assert calls[0]['initial_prompt'] == 'Jean-Luc'
    assert calls[0]['carry_initial_prompt'] is True
    assert calls[0]['condition_on_previous_text'] is False


def test_vocabulary_control_characters_and_length_are_bounded():
    assert process_video.normalize_terms('  Elara\x00 Voss\n Asterion ') == 'Elara Voss Asterion'
    assert len(process_video.normalize_terms('a' * 1000)) == 300


def test_contractions_and_punctuation_keep_decoder_spacing():
    words = [{'word': value} for value in [' I', "'m", ' not', ' Jean', '-Luc', '.']]
    assert join_words(words, 'en') == "I'm not Jean-Luc."


@pytest.mark.parametrize('language,word,limit', [('en', ' dialogue', 42), ('ko', ' 대사입니다', 20), ('ja', 'セリフ', 20)])
def test_fast_long_dialogue_is_split_without_losing_text_or_crossing_silence(language, word, limit):
    words = [{'word': word, 'start': 5 + i * .1, 'end': 5.09 + i * .1,
              'speech_region': 0, 'speech_end': 8} for i in range(30)]
    subs = postprocess([{'words': words}], language)
    assert len(subs) > 1
    assert all(len(line) <= limit for sub in subs for line in sub['text'].splitlines())
    assert ''.join(''.join(sub['text'].split()) for sub in subs) == ''.join(join_words(words, language).split())
    assert all(5 <= sub['start'] < sub['end'] <= 8 for sub in subs)
    assert all(a['end'] <= b['start'] for a, b in zip(subs, subs[1:]))


def test_srt_rounding_carries_milliseconds_across_minutes_and_hours():
    assert process_video.format_timestamp(59.9996) == '00:01:00,000'
    assert process_video.format_timestamp(3599.9996) == '01:00:00,000'
    assert process_video.format_timestamp(-0.01) == '00:00:00,000'


def test_japanese_readability_split_prefers_a_complete_clause():
    words = [{'word': value, 'start': i*.1, 'end': i*.1+.09}
             for i,value in enumerate(['あ'*15, '。', 'い'*15, 'う'*15])]
    subs = postprocess([{'words': words}], 'ja')
    assert subs[0]['text'].endswith('。')
    assert ''.join(''.join(s['text'].split()) for s in subs) == ''.join(w['word'] for w in words)
