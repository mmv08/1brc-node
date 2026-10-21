#!/usr/bin/env python3
"""Validate and measure independent escape-cost and standalone lookup candidates."""

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import runpy
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
V8 = ROOT / 'results/v8-general/v8'
sys.path.insert(0, str(ROOT / 'v8-research'))
from paired_benchmark import sha256
from compilation_cost import summarize as cost_summary

MARKER = 'c281a2f9e3fb9ece0b455153ae45579b7b4108ad'
PRISTINE = '293377af'


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def save(name, data):
    (HERE / name).write_text(json.dumps(data, indent=2) + '\n')


def base(experiment):
    if experiment == 'standalone-fresh-allocation':
        return PRISTINE, V8 / 'out/x64.release-baseline/d8'
    return MARKER, V8 / 'out/x64.release-encoded-marker/d8'


def prepare(experiment, directory, expected_commit):
    assert expected_commit
    commit = run(['git', 'rev-parse', 'HEAD'], cwd=V8,
                 capture_output=True, text=True).stdout.strip()
    assert commit.startswith(expected_commit), commit
    run(['git', 'diff', '--quiet', 'HEAD'], cwd=V8)
    assert not directory.exists(), 'Do not overwrite a preserved build'
    if experiment == 'standalone-fresh-allocation':
        previous = json.loads((ROOT / 'v8-research/compile-cost/fresh-allocation-build-evidence.json').read_text())
        tests = previous['tests']['command'][7:]
        assert tests[0].startswith('unittests/')
        # These three regression scripts belong to the other experiments and
        # do not exist on the pristine revision used for this standalone patch.
        absent_on_pristine = {
            'mjsunit/compiler/terminal-throw-loop-peeling',
            'mjsunit/compiler/array-buffer-byte-length',
            'mjsunit/compiler/constant-phi-branch',
        }
        tests = [test for test in tests if test not in absent_on_pristine]
    else:
        tests = [
            'unittests/GraphReducerTest.*', 'unittests/AdvancedReducerTest.*',
            'unittests/LoopPeelingTest.*', 'unittests/LoadEliminationTest.*',
            'mjsunit/compiler/escape-analysis*',
            'mjsunit/compiler/regress-escape-analysis-indirect',
            'mjsunit/compiler/dataview-*', 'mjsunit/compiler/recursive-loop-phis',
            'mjsunit/compiler/dead-loops', 'mjsunit/compiler/loops',
            'mjsunit/compiler/loopcount', 'mjsunit/compiler/osr-try-catch',
        ]
        if experiment == 'indexed-storage':
            tests += ['unittests/SparseSidetableTest.*']
    command = [sys.executable, '-B', 'tools/run-tests.py',
               '--outdir=out/x64.release', '--progress=verbose',
               '--variants=default', '--run-skipped', *tests]
    log_path = V8.parent / f'escape-{experiment}-tests.log'
    assert not log_path.exists()
    with log_path.open('w') as log:
        run(command, cwd=V8, stdout=log, stderr=subprocess.STDOUT)
    log = log_path.read_text()
    counts = re.findall(r'>>> (\d+) tests ran', log)
    assert counts and int(counts[-1]) > 0 and 'All tests succeeded' in log
    assert ': FAIL' not in log
    for pattern in tests:
        assert pattern.rstrip('*') in log, f'No test output matches {pattern}'
    run(['cp', '-a', '--reflink=auto', 'out/x64.release', str(directory)], cwd=V8)
    files = {name: {'sha256': sha256(directory / name),
                    'size_bytes': (directory / name).stat().st_size}
             for name in ('d8', 'v8_unittests', 'snapshot_blob.bin', 'icudtl.dat',
                          'args.gn', 'v8_build_config.json')}
    base_commit, baseline = base(experiment)
    save(f'{experiment}-build-evidence.json', {
        'source_commit': commit, 'base_commit': base_commit,
        'baseline_binary': str(baseline.relative_to(ROOT)),
        'baseline_sha256': sha256(baseline),
        'directory': str(directory.relative_to(ROOT)), 'files': files,
        'gn_args': (directory / 'args.gn').read_text(),
        'tests': {'passed': int(counts[-1]), 'failed': 0, 'command': command,
                  'log': str(log_path.relative_to(ROOT)), 'sha256': sha256(log_path)},
    })
    patch = run(['git', 'diff', base_commit, commit], cwd=V8,
                capture_output=True, text=True).stdout
    (HERE / f'{experiment}.patch').write_text(patch)
    print(f'{experiment}: {counts[-1]} tests passed; binary preserved.', flush=True)


def code_objects(path):
    objects = []
    for chunk in path.read_text().split('--- Optimized code ---')[1:]:
        name = re.search(r'^name = (.+)$', chunk, re.M)
        size = re.search(r'^Instructions \(size = (\d+)\)', chunk, re.M)
        if name and size:
            objects.append({'name': name[1], 'instruction_bytes': int(size[1])})
    return objects


def native(experiment, directory):
    raw = V8.parent / f'escape-{experiment}-native'
    raw.mkdir(exist_ok=False)
    command = ['taskset', '-c', '2', str(directory / 'd8'),
               '--no-concurrent-recompilation', '--print-opt-code', 'run.js']
    with (raw / 'generated.txt').open('w') as stdout, (raw / 'stderr.txt').open('w') as stderr:
        run(command, cwd=V8 / 'test/js-perf-test/DataView', stdout=stdout, stderr=stderr)
    objects = code_objects(raw / 'generated.txt')
    prior = json.loads((ROOT / 'v8-research/reducer-cost/encoded-marker-native-evidence.json').read_text())
    match = Counter((o['name'], o['instruction_bytes']) for o in objects) == Counter(
        (o['name'], o['instruction_bytes']) for o in prior['code_objects'])
    evidence = {
        'command': command, 'raw_directory': str(raw.relative_to(ROOT)),
        'generated_sha256': sha256(raw / 'generated.txt'), 'code_objects': objects,
        'names_and_sizes_match_marker': match,
        'limits': 'Names and sizes are not proof of byte-identical generated code.',
    }
    if experiment == 'standalone-fresh-allocation':
        _, baseline = base(experiment)
        baseline_command = [*command]
        baseline_command[3] = str(baseline)
        with (raw / 'baseline-generated.txt').open('w') as stdout, (raw / 'baseline-stderr.txt').open('w') as stderr:
            run(baseline_command, cwd=V8 / 'test/js-perf-test/DataView', stdout=stdout, stderr=stderr)
        baseline_objects = code_objects(raw / 'baseline-generated.txt')
        baseline_match = Counter((o['name'], o['instruction_bytes']) for o in objects) == Counter(
            (o['name'], o['instruction_bytes']) for o in baseline_objects)
        evidence.update(baseline_command=baseline_command,
                        baseline_binary_sha256=sha256(baseline),
                        baseline_generated_sha256=sha256(raw / 'baseline-generated.txt'),
                        baseline_code_objects=baseline_objects,
                        names_and_sizes_match_pristine=baseline_match)
    save(f'{experiment}-native-evidence.json', evidence)
    assert objects
    if experiment != 'standalone-fresh-allocation':
        assert match, 'Inspect generated-code size changes before benchmarking'
    else:
        assert baseline_match, 'Inspect generated-code size changes before benchmarking'


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
    _, baseline = base(experiment)
    assert sha256(directory / 'd8') == manifest['files']['d8']['sha256']
    assert sha256(baseline) == manifest['baseline_sha256']
    output = HERE / f'{experiment}-{suite}-results.json'
    assert not output.exists(), 'Do not overwrite measured rounds'
    command = [sys.executable, '-B', str(ROOT / 'v8-research/paired_benchmark.py'),
               '--baseline', str(baseline), '--candidate', str(directory / 'd8'),
               '--cwd', str(V8 / 'test/js-perf-test' / folder),
               '--rounds', str(rounds), '--output', str(output)]
    for name in expected:
        command += ['--expected-score', name]
    run(command + ['--', *flags], cwd=ROOT)
    if suite == 'cost':
        summary_file = HERE / f'{experiment}-cost-summary.json'
        run([sys.executable, '-B', str(ROOT / 'v8-research/compilation_cost.py'),
             str(output), '--output', str(summary_file)])
        summary = json.loads(summary_file.read_text())
        values = {}
        for record in json.loads(output.read_text())['runs']:
            matches = re.findall(r'^\s*V8\.TFEscapeAnalysis\s+([0-9.]+)\s+\([^)]*\)\s+([0-9]+)',
                                 record['stdout'], re.M)
            assert len(matches) == 1
            if not record['warmup']:
                values[record['round'], record['binary']] = [float(matches[0][0]), int(matches[0][1])]
        for i, name in enumerate(('escape_analysis_time_ms', 'escape_analysis_zone_bytes')):
            summary['summary'][name] = cost_summary(
                [values[n, 'baseline'][i] for n in range(1, rounds + 1)],
                [values[n, 'candidate'][i] for n in range(1, rounds + 1)])
        summary_file.write_text(json.dumps(summary, indent=2) + '\n')
    else:
        audit = runpy.run_path(str(ROOT / 'v8-research/compile-cost/summarize-validation.py'))
        save(f'{experiment}-{suite}-summary.json', audit['summarize'](output, rounds))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('experiment', choices=[
        'indexed-storage', 'merge-input-cache', 'standalone-fresh-allocation'])
    parser.add_argument('stage', choices=['prepare', 'native', 'measure', 'runtime'])
    parser.add_argument('--commit')
    args = parser.parse_args()
    directory = V8 / f'out/x64.release-escape-{args.experiment}'
    if args.stage == 'prepare':
        prepare(args.experiment, directory, args.commit)
    elif args.stage == 'native':
        native(args.experiment, directory)
    elif args.stage == 'measure':
        if args.experiment != 'standalone-fresh-allocation':
            benchmark(args.experiment, directory, 'cost')
        benchmark(args.experiment, directory, 'compiler')
    else:
        benchmark(args.experiment, directory, 'runtime')


if __name__ == '__main__':
    main()
