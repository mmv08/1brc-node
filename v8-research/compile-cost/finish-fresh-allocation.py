#!/usr/bin/env python3
"""Run the declared remaining-cost comparison and post-change native profile.

Wait for both fixed official benchmarks, then serialize all diagnostics. This
does not change the source, build, benchmark inputs, or number of measured pairs.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[2]
V8 = ROOT / 'results/v8-general/v8'
OUTPUT = ROOT / 'v8-research/compile-cost'
CANDIDATE = V8 / 'out/x64.release-fresh-allocation/d8'
HISTORICAL = V8 / 'out/x64.release-byte-length/d8'
PROFILES = V8.parent / 'profiles/compilation-cost'


def read(path):
    return json.loads(path.read_text())


def save(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def profile_summary(path):
    report = path.read_text()
    match = re.search(r'\((\d+) ticks, (\d+) unaccounted, (\d+) excluded\)', report)
    if not match:
        raise ValueError('Missing profiler accounting header')
    total, unaccounted, excluded = map(int, match.groups())
    included = total - excluded
    cpp = report.split(' [C++]:', 1)[1].split('\n [', 1)[0]
    symbols = []
    for line in cpp.splitlines():
        row = re.fullmatch(r'\s*(\d+)\s+[\d.]+%\s+[\d.]+%\s+(.+)', line)
        if row:
            ticks = int(row[1])
            symbols.append({'symbol': row[2], 'self_ticks': ticks,
                            'percent_of_included_ticks': 100 * ticks / included})
    selected = [row for row in symbols if any(name in row['symbol'] for name in (
        'LoadElimination::AbstractField::Kill(',
        'LoadElimination::AliasStateInfo::MayAlias(',
        'GraphReducer::Reduce(', 'GraphReducer::ReduceTop(',
    ))]
    return {
        'report': str(path.relative_to(ROOT)), 'sha256': digest(path),
        'total_ticks': total, 'excluded_ticks': excluded,
        'included_ticks': included, 'unaccounted_ticks': unaccounted,
        'selected_symbols': selected, 'top_cpp_symbols': symbols[:15],
    }


def main():
    print('Waiting for the complete 12-pair Compiler and 21-pair runtime runs.',
          flush=True)
    while True:
        try:
            runtime = read(OUTPUT / 'fresh-allocation-runtime-results.json')
        except (FileNotFoundError, json.JSONDecodeError):
            runtime = {}
        if runtime.get('status') == 'failed':
            raise RuntimeError('Runtime validation failed; inspect before continuing')
        if runtime.get('status') == 'complete':
            break
        try:
            compiler = read(OUTPUT / 'fresh-allocation-compiler-results.json')
        except (FileNotFoundError, json.JSONDecodeError):
            compiler = {}
        if compiler.get('status') == 'failed':
            raise RuntimeError('Compiler validation failed; inspect before continuing')
        time.sleep(5)
    compiler = read(OUTPUT / 'fresh-allocation-compiler-results.json')
    for data, pairs in ((runtime, 21), (compiler, 12)):
        assert data['status'] == 'complete'
        assert data['completed_pairs'] == data['requested_rounds'] == pairs
        assert all(data['binary_sha256_after'][name] == entry['sha256']
                   for name, entry in data['binaries'].items())
    manifest = read(OUTPUT / 'fresh-allocation-build-evidence.json')
    expected_digest = manifest['files']['d8']['sha256']
    assert digest(CANDIDATE) == expected_digest

    result_path = OUTPUT / 'fresh-allocation-remaining-cost-results.json'
    assert not result_path.exists(), 'Do not overwrite a completed experiment'
    reference = read(OUTPUT / 'fresh-allocation-cost-results.json')
    command = [sys.executable, '-B', str(ROOT / 'v8-research/paired_benchmark.py'),
               '--baseline', str(HISTORICAL), '--candidate', str(CANDIDATE),
               '--cwd', str(V8 / 'test/js-perf-test/DataView'), '--rounds', '6',
               '--output', str(result_path)]
    for name in reference['expected_scores']:
        command += ['--expected-score', name]
    command += ['--', '--no-concurrent-recompilation', '--turbo-stats',
                '--turbo-stats-nvp', '--trace-opt', 'run.js']
    print('Starting six fixed cost pairs against the historical getter build.',
          flush=True)
    run(command, cwd=ROOT)
    run([sys.executable, '-B', str(ROOT / 'v8-research/compilation_cost.py'),
         str(result_path), '--output',
         str(OUTPUT / 'fresh-allocation-remaining-cost-summary.json')], cwd=ROOT)

    directory = PROFILES / 'fresh-allocation'
    directory.mkdir(exist_ok=False)
    log = directory / 'v8.log'
    command = ['taskset', '-c', '2', str(CANDIDATE), '--allow-natives-syntax',
               '--prof', '--prof-sampling-interval=250',
               '--no-logfile-per-isolate', '--logfile=' + str(log), 'run.js']
    print('Profiling the unchanged official Compiler suite after the change.',
          flush=True)
    started = time.monotonic()
    with (directory / 'stdout.txt').open('w') as stdout, \
            (directory / 'stderr.txt').open('w') as stderr:
        run(command, cwd=V8 / 'test/js-perf-test/Compiler',
            stdout=stdout, stderr=stderr)
    capture = {
        'command': command, 'cwd': str(V8 / 'test/js-perf-test/Compiler'),
        'elapsed_seconds': time.monotonic() - started,
        'source_commit': manifest['source_commit'], 'binary_sha256': expected_digest,
        'log_sha256': digest(log), 'returncode': 0,
    }
    report = directory / 'compiler-report.txt'
    processor = ['tools/linux-tick-processor', '--compiler', str(log)]
    with report.open('w') as stdout, \
            (directory / 'processor-stderr.txt').open('w') as stderr:
        run(processor, cwd=V8, env={**os.environ, 'D8_PATH': str(CANDIDATE)},
            stdout=stdout, stderr=stderr)
    capture['processor_command'] = processor
    capture['processor_D8_PATH'] = str(CANDIDATE)
    capture['processor_returncode'] = 0
    assert digest(CANDIDATE) == expected_digest
    save(directory / 'capture.json', capture)
    baseline = profile_summary(PROFILES / 'candidate/compiler-report.txt')
    candidate = profile_summary(report)
    save(OUTPUT / 'fresh-allocation-post-profile.json', {
        'capture': capture, 'baseline_fcc58178': baseline, 'candidate': candidate,
        'interpretation': (
            'Compiler-state native sampling is diagnostic, not the official '
            'score measurement. Shares use total ticks minus excluded ticks. '
            'The harness times batches and can execute different compilation '
            'counts; raw ticks and process wall times are not a matched '
            'per-compilation measure. '
            'Profiler-enabled source-position collection changes some paths.'),
    })
    print('Remaining-cost comparison and post-change profile complete.', flush=True)


if __name__ == '__main__':
    main()
