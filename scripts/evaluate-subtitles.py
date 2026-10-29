"""Offline paired ASR evaluation. Manifest paths are relative to the manifest.

Example: python scripts/evaluate-subtitles.py samples.json --executable ENGINE
  --scripts-dir python --ffmpeg bin/ffmpeg.exe --output-dir evaluation/new
Use --legacy for the v1.9.1 scripts and --with-hints to evaluate supplied terms.
Reports normalized character errors and cue overlap with annotated non-speech.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
import unicodedata


def normalized(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', text).casefold() if c.isalnum())


def distance(a, b):
    row = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        new = [i]
        for j, cb in enumerate(b, 1):
            new.append(min(new[-1] + 1, row[j] + 1, row[j - 1] + (ca != cb)))
        row = new
    return row[-1]


def parse_srt(content):
    def seconds(value):
        h, m, s, ms = map(int, re.split('[:,]', value))
        return h * 3600 + m * 60 + s + ms / 1000
    blocks = []
    for block in re.split(r'\r?\n\s*\r?\n', content.strip()):
        lines = block.splitlines()
        if len(lines) >= 3 and ' --> ' in lines[1]:
            a, b = lines[1].split(' --> ')
            blocks.append((seconds(a), seconds(b), ' '.join(lines[2:])))
    return blocks


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('manifest', type=Path)
    p.add_argument('--executable', required=True, type=Path)
    p.add_argument('--scripts-dir', required=True, type=Path)
    p.add_argument('--ffmpeg', required=True, type=Path)
    p.add_argument('--output-dir', required=True, type=Path)
    p.add_argument('--legacy', action='store_true')
    p.add_argument('--with-hints', action='store_true')
    p.add_argument('--precision', default='accurate', choices=['accurate', 'balanced'])
    args = p.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, VSG_SCRIPTS_DIR=str(args.scripts_dir.resolve()), HF_HUB_OFFLINE='1')
    report = {'legacy': args.legacy, 'with_hints': args.with_hints, 'samples': []}
    for item in json.loads(args.manifest.read_text(encoding='utf-8-sig')):
        name = item['id']
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', name):
            raise ValueError('Sample id must be a simple filename')
        output = args.output_dir / (name + '.srt')
        if output.exists():
            raise FileExistsError(f'Use a fresh output directory: {output}')
        command = [str(args.executable.resolve()), str((args.manifest.parent / item['audio']).resolve()),
                   '--output', str(output.resolve()), '--ffmpeg', str(args.ffmpeg.resolve()),
                   '--engine', item.get('engine', 'faster-whisper'), '--model', item.get('model', 'large-v3'),
                   '--language', item.get('language', 'auto')]
        if not args.legacy:
            command += ['--precision', args.precision]
            if args.with_hints and item.get('terms'):
                command += ['--terms', item['terms']]
        start = time.monotonic()
        result = subprocess.run(command, env=env, capture_output=True, timeout=900,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        (args.output_dir / (name + '.log')).write_bytes(result.stdout + b'\nSTDERR:\n' + result.stderr)
        blocks = parse_srt(output.read_text(encoding='utf-8-sig')) if output.exists() else []
        reference = normalized(item['reference'])
        hypothesis = normalized(' '.join(b[2] for b in blocks))
        errors = distance(reference, hypothesis)
        silence_overlap = sum(max(0, min(end, b) - max(start, a))
                              for start, end, _ in blocks for a, b in item.get('silence', []))
        messages = [json.loads(line) for line in result.stdout.decode('utf8', errors='replace').splitlines()
                    if line.startswith('{')]
        expected_exit = 0 if reference else 1
        success = result.returncode == expected_exit and bool(messages) and (
            messages[-1].get('stage') == 'complete' if reference else
            '음성이 감지되지 않았습니다' in messages[-1].get('message', '') and not output.exists())
        entry = {'id': name, 'exit_code': result.returncode, 'successful': success,
                 'seconds': round(time.monotonic() - start, 2), 'reference_characters': len(reference),
                 'character_errors': errors, 'cer': errors / len(reference) if reference else None,
                 'silence_overlap_seconds': round(silence_overlap, 3), 'cue_count': len(blocks),
                 'text': ' '.join(b[2] for b in blocks)}
        report['samples'].append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)
        (args.output_dir / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf8')
    chars = sum(s['reference_characters'] for s in report['samples'])
    report['cer'] = sum(s['character_errors'] for s in report['samples']) / chars if chars else None
    report['silence_overlap_seconds'] = sum(s['silence_overlap_seconds'] for s in report['samples'])
    (args.output_dir / 'report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf8')
    if not all(s['successful'] for s in report['samples']):
        raise SystemExit('One or more engine runs failed; do not treat this report as an accuracy result.')


if __name__ == '__main__':
    main()
