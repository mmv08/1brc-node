#!/usr/bin/env python3
"""Serialize the fresh-allocation experiment after the prior fixed run."""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[2]
V8 = ROOT / 'results/v8-general/v8'
OUTPUT = ROOT / 'v8-research/compile-cost'
BASELINE = V8 / 'out/x64.release-winning-followups/d8'
CANDIDATE_DIR = V8 / 'out/x64.release-fresh-allocation'
EXPECTED_COMMIT = '87e3481b'


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def save(name, data):
    (OUTPUT / name).write_text(json.dumps(data, indent=2) + '\n')


def benchmark(suite, rounds, reference, filename, flags):
    expected = json.loads((ROOT / 'v8-research' / reference).read_text())
    command = [sys.executable, '-B', str(ROOT / 'v8-research/paired_benchmark.py'),
               '--baseline', str(BASELINE), '--candidate', str(CANDIDATE_DIR / 'd8'),
               '--cwd', str(V8 / 'test/js-perf-test' / suite),
               '--rounds', str(rounds), '--output', str(OUTPUT / filename)]
    for name in expected['expected_scores']:
        command += ['--expected-score', name]
    print(f'Starting {suite}: {rounds} fixed pairs; {filename}', flush=True)
    run(command + ['--', *flags], cwd=ROOT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wait-for', type=Path)
    args = parser.parse_args()
    if args.wait_for:
        print('Waiting for the preceding fixed benchmark to finish.', flush=True)
        while True:
            try:
                previous = json.loads(args.wait_for.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                previous = {}
            if previous.get('status') == 'failed':
                raise RuntimeError('Preceding benchmark failed; inspect before continuing')
            if previous.get('status') == 'complete':
                assert previous['completed_pairs'] == previous['requested_rounds'] == 21
                break
            time.sleep(5)

    commit = run(['git', 'rev-parse', 'HEAD'], cwd=V8,
                 capture_output=True, text=True).stdout.strip()
    assert commit.startswith(EXPECTED_COMMIT), commit
    run(['git', 'diff', '--quiet', 'HEAD'], cwd=V8)
    assert not CANDIDATE_DIR.exists(), 'Do not overwrite a preserved experiment'
    print('Building the checkpointed fresh-allocation candidate.', flush=True)
    build_log = V8.parent / 'fresh-allocation-build.log'
    with build_log.open('w') as log:
        run(['third_party/ninja/ninja', '-C', 'out/x64.release', '-j16',
             'd8', 'v8_unittests'], cwd=V8, stdout=log, stderr=subprocess.STDOUT)

    tests = [
        'unittests/LoadEliminationTest.*', 'unittests/LoopPeelingTest.*',
        'unittests/ControlFlowTest.BranchElimination*',
        'mjsunit/compiler/load-elimination*', 'mjsunit/compiler/dataview-*',
        'mjsunit/compiler/terminal-throw-loop-peeling',
        'mjsunit/compiler/array-buffer-byte-length',
        'mjsunit/compiler/constant-phi-branch',
        'mjsunit/compiler/typedarray-resizablearraybuffer',
        'mjsunit/compiler/typed-array-length-detached-*',
        'mjsunit/compiler/dead-loops', 'mjsunit/compiler/loops',
        'mjsunit/compiler/loopcount', 'mjsunit/compiler/osr-try-catch',
        'mjsunit/compiler/recursive-loop-phis',
        'mjsunit/compiler/regress-488925413', 'mjsunit/no-branch-elimination',
        'mjsunit/turboshaft/branch-elim-switch-*',
        'mjsunit/regress/wasm/condition-change-during-branch-elimination',
    ]
    test_command = [sys.executable, '-B', 'tools/run-tests.py',
                    '--outdir=out/x64.release', '--progress=verbose',
                    '--variants=default', '--run-skipped', *tests]
    test_log = V8.parent / 'fresh-allocation-tests.log'
    with test_log.open('w') as log:
        run(test_command, cwd=V8, stdout=log, stderr=subprocess.STDOUT)
    output = test_log.read_text()
    counts = re.findall(r'>>> (\d+) tests ran', output)
    assert counts and int(counts[-1]) == 83, output[-2000:]
    assert 'All tests succeeded' in output and ': FAIL' not in output
    run(['cp', '-a', '--reflink=auto', 'out/x64.release', str(CANDIDATE_DIR)], cwd=V8)
    files = {}
    for name in ('d8', 'snapshot_blob.bin', 'icudtl.dat', 'args.gn', 'v8_build_config.json'):
        path = CANDIDATE_DIR / name
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        files[name] = {'sha256': digest, 'size_bytes': path.stat().st_size}
    save('fresh-allocation-build-evidence.json', {
        'source_commit': commit, 'directory': str(CANDIDATE_DIR.relative_to(ROOT)),
        'files': files, 'gn_args': (CANDIDATE_DIR / 'args.gn').read_text(),
        'build_log': str(build_log.relative_to(ROOT)),
        'tests': {'passed': int(counts[-1]), 'failed': 0, 'command': test_command,
                  'log': str(test_log.relative_to(ROOT))},
    })
    print('83 regression tests passed; binary preserved.', flush=True)

    capture_dir = V8.parent / 'profiles/compilation-cost/native-fresh-allocation'
    capture_dir.mkdir(parents=True, exist_ok=True)
    command = ['taskset', '-c', '2', str(CANDIDATE_DIR / 'd8'),
               '--no-concurrent-recompilation', '--print-opt-code', 'run.js']
    captured = run(command, cwd=V8 / 'test/js-perf-test/DataView',
                   capture_output=True, text=True)
    (capture_dir / 'stdout.txt').write_text(captured.stdout)
    (capture_dir / 'stderr.txt').write_text(captured.stderr)
    objects = []
    for chunk in captured.stdout.split('--- Optimized code ---')[1:]:
        name = re.search(r'^name = (.+)$', chunk, re.M)
        size = re.search(r'^Instructions \(size = (\d+)\)', chunk, re.M)
        if name and size:
            objects.append({'name': name[1], 'instruction_bytes': int(size[1])})
    baseline_objects = json.loads(
        (OUTPUT / 'native-code-validation.json').read_text())[0]['code_objects']
    same_sizes = (Counter((o['name'], o['instruction_bytes']) for o in objects) ==
                  Counter((o['name'], o['instruction_bytes']) for o in baseline_objects))
    save('fresh-allocation-native-evidence.json', {
        'command': command, 'raw_directory': str(capture_dir.relative_to(ROOT)),
        'code_objects': objects, 'all_function_names_and_sizes_match_baseline': same_sizes,
    })
    assert same_sizes, 'Inspect unexpected generated-code changes before benchmarking'

    benchmark('DataView', 6, 'followups/winning-compile-cost-results.json',
              'fresh-allocation-cost-results.json',
              ['--no-concurrent-recompilation', '--turbo-stats',
               '--turbo-stats-nvp', '--trace-opt', 'run.js'])
    run([sys.executable, '-B', str(ROOT / 'v8-research/compilation_cost.py'),
         str(OUTPUT / 'fresh-allocation-cost-results.json'), '--output',
         str(OUTPUT / 'fresh-allocation-cost-summary.json')], cwd=ROOT)
    benchmark('Compiler', 12, 'followups/winning-compiler-results.json',
              'fresh-allocation-compiler-results.json', ['--allow-natives-syntax', 'run.js'])
    benchmark('DataView', 21, 'followups/winning-followups-results.json',
              'fresh-allocation-runtime-results.json', ['run.js'])


if __name__ == '__main__':
    main()
