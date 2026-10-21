#!/usr/bin/env python3
"""Capture an official Compiler native profile with source and binary identities."""

import argparse
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
V8 = ROOT / 'results/v8-general/v8'
sys.path.insert(0, str(ROOT / 'v8-research'))
from paired_benchmark import parse_scores, source_hashes, sha256

profile_summary = runpy.run_path(str(
    ROOT / 'v8-research/compile-cost/finish-fresh-allocation.py'))['profile_summary']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('label')
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args()
    binary = args.binary.resolve()
    directory = V8.parent / 'profiles/escape-cost' / args.label
    directory.mkdir(parents=True, exist_ok=False)
    log = directory / 'v8.log'
    suite = V8 / 'test/js-perf-test/Compiler'
    command = ['taskset', '-c', '2', str(binary), '--allow-natives-syntax',
               '--prof', '--prof-sampling-interval=250',
               '--no-logfile-per-isolate', '--logfile=' + str(log), 'run.js']
    sources = source_hashes(suite, ['run.js'])
    digest = sha256(binary)
    started = time.monotonic()
    with (directory / 'stdout.txt').open('w') as stdout, (directory / 'stderr.txt').open('w') as stderr:
        subprocess.run(command, cwd=suite, stdout=stdout, stderr=stderr, check=True)
    elapsed = time.monotonic() - started
    assert sha256(binary) == digest and source_hashes(suite, ['run.js']) == sources
    scores = parse_scores((directory / 'stdout.txt').read_text())
    expected = json.loads((ROOT / 'v8-research/reducer-cost/encoded-marker-compiler-results.json').read_text())['expected_scores']
    assert set(scores) == set(expected)
    processor = ['tools/linux-tick-processor', '--compiler', str(log)]
    report = directory / 'compiler-report.txt'
    with report.open('w') as stdout, (directory / 'processor-stderr.txt').open('w') as stderr:
        subprocess.run(processor, cwd=V8, env={**os.environ, 'D8_PATH': str(binary)},
                       stdout=stdout, stderr=stderr, check=True)
    result = profile_summary(report)
    assert result['unaccounted_ticks'] == 0
    output = {
        'capture': {'command': command, 'cwd': str(suite), 'elapsed_seconds': elapsed,
                    'source_commit': args.commit, 'binary_sha256': digest,
                    'source_sha256': sources, 'log_sha256': sha256(log),
                    'processor_command': processor, 'processor_D8_PATH': str(binary),
                    'diagnostic_scores': scores, 'returncode': 0},
        'profile': result,
        'limits': 'Compiler-state self samples, not timing evidence. Profiling enables source-position wrappers absent from stock benchmarks. Shared native addresses can have multiple template symbols.',
    }
    (HERE / f'{args.label}-profile.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
