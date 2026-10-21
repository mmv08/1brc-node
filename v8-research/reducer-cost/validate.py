#!/usr/bin/env python3
"""Run serialized correctness, native inspection and fixed benchmark stages."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
V8 = ROOT / 'results/v8-general/v8'
HERE = Path(__file__).resolve().parent
BASELINE = V8 / 'out/x64.release-fresh-allocation/d8'
BASE_COMMIT = '87e3481b97d9ae327293ec319b57f4ef79e0c2a3'
SYMBOLS = {
    'reduce-top': '_ZN2v88internal8compiler12GraphReducer9ReduceTopEv',
    'reduce': '_ZN2v88internal8compiler12GraphReducer6ReduceEPNS1_4NodeE',
}


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def save(name, data):
    (HERE / name).write_text(json.dumps(data, indent=2) + '\n')


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prepare(experiment, directory, expected_commit):
    assert expected_commit
    commit = run(['git', 'rev-parse', 'HEAD'], cwd=V8,
                 capture_output=True, text=True).stdout.strip()
    assert commit.startswith(expected_commit), commit
    run(['git', 'diff', '--quiet', 'HEAD'], cwd=V8)
    assert not directory.exists(), 'Do not overwrite a preserved build'
    tests = [
        'unittests/GraphReducerTest.*', 'unittests/AdvancedReducerTest.*',
        'unittests/LoopPeelingTest.*', 'unittests/LoadEliminationTest.*',
        'mjsunit/compiler/dataview-*', 'mjsunit/compiler/terminal-throw-loop-peeling',
        'mjsunit/compiler/array-buffer-byte-length',
        'mjsunit/compiler/constant-phi-branch', 'mjsunit/compiler/dead-loops',
        'mjsunit/compiler/loops', 'mjsunit/compiler/loopcount',
        'mjsunit/compiler/osr-try-catch', 'mjsunit/compiler/recursive-loop-phis',
    ]
    if experiment == 'encoded-marker':
        tests += ['unittests/NodeMarkerTest.*']
    elif experiment == 'safepoint-predicate':
        tests += ['unittests/LocalHeapTest.*', 'unittests/SafepointTest.*',
                  'unittests/GlobalSafepointTest.*',
                  'mjsunit/turboshaft/regress-539984773',
                  'cctest/test-concurrent-allocation/ConcurrentAllocationWhileMainThreadRunsWithSafepoints',
                  'cctest/test-concurrent-allocation/ConcurrentAllocationWhileMainThreadParksAndUnparks',
                  'cctest/test-concurrent-allocation/ConcurrentAllocationWhileMainThreadIsParked']
    else:
        raise ValueError(experiment)
    command = [sys.executable, '-B', 'tools/run-tests.py',
               '--outdir=out/x64.release', '--progress=verbose',
               '--variants=default', '--run-skipped', *tests]
    log_path = V8.parent / f'{experiment}-tests.log'
    with log_path.open('w') as log:
        run(command, cwd=V8, stdout=log, stderr=subprocess.STDOUT)
    log = log_path.read_text()
    counts = re.findall(r'>>> (\d+) tests ran', log)
    assert counts and int(counts[-1]) > 0 and 'All tests succeeded' in log
    assert ': FAIL' not in log
    for pattern in tests:
        literal = pattern.rstrip('*')
        assert literal in log, f'No test output matches requested {pattern}'
    run(['cp', '-a', '--reflink=auto', 'out/x64.release', str(directory)], cwd=V8)
    files = {name: {'sha256': sha256(directory / name),
                    'size_bytes': (directory / name).stat().st_size}
             for name in ('d8', 'v8_unittests', 'snapshot_blob.bin', 'icudtl.dat',
                          'args.gn', 'v8_build_config.json')}
    if experiment == 'safepoint-predicate':
        files['cctest'] = {'sha256': sha256(directory / 'cctest'),
                           'size_bytes': (directory / 'cctest').stat().st_size}
    save(f'{experiment}-build-evidence.json', {
        'source_commit': commit, 'base_commit': BASE_COMMIT,
        'directory': str(directory.relative_to(ROOT)), 'files': files,
        'gn_args': (directory / 'args.gn').read_text(),
        'tests': {'passed': int(counts[-1]), 'failed': 0, 'command': command,
                  'log': str(log_path.relative_to(ROOT)), 'sha256': sha256(log_path)},
    })
    patch = run(['git', 'diff', BASE_COMMIT, commit], cwd=V8,
                capture_output=True, text=True).stdout
    (HERE / f'{experiment}.patch').write_text(patch)
    native_inspection(experiment, directory)
    print(f'{experiment}: {counts[-1]} tests passed; binary preserved.', flush=True)


def native_inspection(experiment, directory):
    llvm = V8 / 'third_party/llvm-build/Release+Asserts/bin'
    sizes = run([str(llvm / 'llvm-nm'), '-S', str(directory / 'd8')],
                capture_output=True, text=True).stdout.splitlines()
    native_sizes = {}
    for label, symbol in SYMBOLS.items():
        row, = [line.split() for line in sizes if line.endswith(' ' + symbol)]
        native_sizes[label] = int(row[1], 16)
        output = run([str(llvm / 'llvm-objdump'), '--disassemble-symbols=' + symbol,
                      str(directory / 'd8')], capture_output=True, text=True).stdout
        (HERE / f'{experiment}-{label}.txt').write_text(output)
    command = ['taskset', '-c', '2', str(directory / 'd8'),
               '--no-concurrent-recompilation', '--print-opt-code', 'run.js']
    result = run(command, cwd=V8 / 'test/js-perf-test/DataView',
                 capture_output=True, text=True)
    raw = V8.parent / 'profiles/reducer-cost' / experiment
    raw.mkdir(parents=True, exist_ok=True)
    (raw / 'opt-code.txt').write_text(result.stdout)
    (raw / 'stderr.txt').write_text(result.stderr)
    objects = []
    for chunk in result.stdout.split('--- Optimized code ---')[1:]:
        name = re.search(r'^name = (.+)$', chunk, re.M)
        size = re.search(r'^Instructions \(size = (\d+)\)', chunk, re.M)
        if name and size:
            objects.append({'name': name[1], 'instruction_bytes': int(size[1])})
    baseline = json.loads((ROOT / 'v8-research/compile-cost/fresh-allocation-native-evidence.json').read_text())['code_objects']
    match = Counter((o['name'], o['instruction_bytes']) for o in objects) == Counter(
        (o['name'], o['instruction_bytes']) for o in baseline)
    save(f'{experiment}-native-evidence.json', {
        'command': command, 'raw_directory': str(raw.relative_to(ROOT)),
        'native_function_sizes': native_sizes, 'code_objects': objects,
        'all_function_names_and_sizes_match_baseline': match,
    })
    assert match, 'Inspect generated-code size changes before benchmarking'


def benchmark(experiment, directory, suite):
    config = {
        'cost': ('DataView', 6, ['--no-concurrent-recompilation', '--turbo-stats',
                               '--turbo-stats-nvp', '--trace-opt', 'run.js']),
        'compiler': ('Compiler', 12, ['--allow-natives-syntax', 'run.js']),
        'runtime': ('DataView', 21, ['run.js']),
    }
    folder, rounds, flags = config[suite]
    expected = json.loads((ROOT / f'v8-research/compile-cost/fresh-allocation-{suite}-results.json').read_text())['expected_scores']
    manifest = json.loads((HERE / f'{experiment}-build-evidence.json').read_text())
    assert sha256(directory / 'd8') == manifest['files']['d8']['sha256']
    output = HERE / f'{experiment}-{suite}-results.json'
    assert not output.exists(), 'Do not overwrite measured rounds'
    command = [sys.executable, '-B', str(ROOT / 'v8-research/paired_benchmark.py'),
               '--baseline', str(BASELINE), '--candidate', str(directory / 'd8'),
               '--cwd', str(V8 / 'test/js-perf-test' / folder),
               '--rounds', str(rounds), '--output', str(output)]
    for name in expected:
        command += ['--expected-score', name]
    run(command + ['--', *flags], cwd=ROOT)
    if suite == 'cost':
        run([sys.executable, '-B', str(ROOT / 'v8-research/compilation_cost.py'),
             str(output), '--output', str(HERE / f'{experiment}-cost-summary.json')])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('experiment', choices=['encoded-marker', 'safepoint-predicate'])
    parser.add_argument('stage', choices=['prepare', 'measure', 'runtime'])
    parser.add_argument('--commit')
    args = parser.parse_args()
    directory = V8 / f'out/x64.release-{args.experiment}'
    if args.stage == 'prepare':
        prepare(args.experiment, directory, args.commit)
    elif args.stage == 'measure':
        benchmark(args.experiment, directory, 'cost')
        benchmark(args.experiment, directory, 'compiler')
    else:
        benchmark(args.experiment, directory, 'runtime')


if __name__ == '__main__':
    main()
