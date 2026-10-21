#!/usr/bin/env python3
"""Capture a matched native compiler diagnostic after fixed measurements."""

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
    parser.add_argument('experiment')
    args = parser.parse_args()
    manifest = json.loads((HERE / f'{args.experiment}-build-evidence.json').read_text())
    compiler = json.loads((HERE / f'{args.experiment}-compiler-results.json').read_text())
    assert compiler['status'] == 'complete' and compiler['completed_pairs'] == 12
    binary = ROOT / manifest['directory'] / 'd8'
    assert sha256(binary) == manifest['files']['d8']['sha256']
    directory = V8.parent / 'profiles/reducer-cost' / f'{args.experiment}-target'
    directory.mkdir(parents=True, exist_ok=False)
    log = directory / 'v8.log'
    target = ROOT / 'v8-research/compile-cost/recompile-dataview.js'
    command = ['taskset', '-c', '2', str(binary), '--allow-natives-syntax',
               '--no-concurrent-recompilation', '--prof', '--prof-sampling-interval=250',
               '--no-logfile-per-isolate', '--logfile=' + str(log), str(target)]
    suite = V8 / 'test/js-perf-test/DataView'
    sources = source_hashes(suite, [str(target)])
    started = time.monotonic()
    result = subprocess.run(command, cwd=suite, capture_output=True, text=True, check=True)
    elapsed = time.monotonic() - started
    (directory / 'stdout.txt').write_text(result.stdout)
    (directory / 'stderr.txt').write_text(result.stderr)
    assert source_hashes(suite, [str(target)]) == sources
    scores = parse_scores(result.stdout)
    expected = json.loads((HERE / f'{args.experiment}-cost-results.json').read_text())['expected_scores']
    assert set(scores) == set(expected)
    processor = ['tools/linux-tick-processor', '--compiler', str(log)]
    result = subprocess.run(processor, cwd=V8, env={**os.environ, 'D8_PATH': str(binary)},
                            capture_output=True, text=True, check=True)
    report = directory / 'compiler-report.txt'
    report.write_text(result.stdout)
    (directory / 'processor-stderr.txt').write_text(result.stderr)
    baseline_path = V8.parent / 'profiles/compilation-cost/target-fresh-allocation/compiler-report.txt'
    baseline, candidate = profile_summary(baseline_path), profile_summary(report)
    assert baseline['unaccounted_ticks'] == candidate['unaccounted_ticks'] == 0
    output = {
        'capture': {'command': command, 'cwd': str(suite), 'elapsed_seconds': elapsed,
                    'processor_command': processor, 'processor_D8_PATH': str(binary),
                    'source_commit': manifest['source_commit'], 'binary_sha256': sha256(binary),
                    'source_sha256': sources, 'log_sha256': sha256(log),
                    'returncode': 0, 'processor_returncode': 0, 'diagnostic_scores': scores},
        'baseline': baseline, 'candidate': candidate,
        'limits': 'Compiler-state self samples from the same repeated-compilation diagnostic. '
                  'Shares use total minus excluded ticks; fewer ticks do not establish speedup. '
                  'Profiling enables source-position wrappers absent from stock measurements.',
    }
    (HERE / f'{args.experiment}-post-profile.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps(candidate['selected_symbols'], indent=2))


if __name__ == '__main__':
    main()
