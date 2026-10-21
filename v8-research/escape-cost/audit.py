#!/usr/bin/env python3
"""Audit preserved source, binaries, full paired runs and diagnostic accounting."""

import argparse
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
from paired_benchmark import sha256, source_hashes
from compilation_cost import parse_run

summarize = runpy.run_path(str(ROOT / 'v8-research/compile-cost/summarize-validation.py'))['summarize']
profile_summary = runpy.run_path(str(ROOT / 'v8-research/compile-cost/finish-fresh-allocation.py'))['profile_summary']


def git(*args):
    return subprocess.check_output(['git', *args], cwd=V8, text=True)


def audit(experiment):
    manifest_path = HERE / f'{experiment}-build-evidence.json'
    manifest = json.loads(manifest_path.read_text())
    directory = ROOT / manifest['directory']
    for name, info in manifest['files'].items():
        assert sha256(directory / name) == info['sha256']
        assert (directory / name).stat().st_size == info['size_bytes']
    assert sha256(ROOT / manifest['baseline_binary']) == manifest['baseline_sha256']
    assert (directory / 'args.gn').read_text() == manifest['gn_args']
    patch = git('diff', manifest['base_commit'], manifest['source_commit'])
    assert patch == (HERE / f'{experiment}.patch').read_text()
    commit = git('cat-file', '-p', manifest['source_commit'])
    assert '\ngpgsig ' not in commit
    tests = manifest['tests']
    log = ROOT / tests['log']
    assert sha256(log) == tests['sha256']
    counts = re.findall(r'>>> (\d+) tests ran', log.read_text())
    assert int(counts[-1]) == tests['passed'] > 0
    assert 'All tests succeeded' in log.read_text() and tests['failed'] == 0
    results = {}
    for suite, rounds in [('compiler', 12), ('runtime', 21)]:
        path = HERE / f'{experiment}-{suite}-results.json'
        if suite == 'runtime' and not path.exists():
            continue
        summary = summarize(path, rounds)
        assert summary == json.loads((HERE / f'{experiment}-{suite}-summary.json').read_text())
        assert summary['binaries']['baseline']['sha256'] == manifest['baseline_sha256']
        assert summary['binaries']['candidate']['sha256'] == manifest['files']['d8']['sha256']
        raw = json.loads(path.read_text())
        assert source_hashes(Path(raw['cwd']), raw['d8_args']) == raw['source_sha256']
        results[suite] = summary
    cost_path = HERE / f'{experiment}-cost-results.json'
    if cost_path.exists():
        raw = json.loads(cost_path.read_text())
        assert raw['status'] == 'complete' and raw['completed_pairs'] == raw['requested_rounds'] == 6
        assert len(raw['runs']) == 14
        summarize(cost_path, 6)  # Audit pair ordering, identities and all scores.
        summary_path = HERE / f'{experiment}-cost-summary.json'
        cost = json.loads(summary_path.read_text())
        assert cost['runs'] == [parse_run(r) for r in raw['runs']]
        for record in cost['runs']:
            assert record['pipeline_count'] == 25
            assert len(record['target_compilations']['normal']) == 2
            assert not record['target_compilations']['osr']
            assert not record['aborted_compilation_lines']
        results['cost'] = {'sha256': sha256(summary_path), 'metrics': cost['summary'],
                           'pairs': 6, 'pipeline_count_per_run': 25}
    native_path = HERE / f'{experiment}-native-evidence.json'
    if native_path.exists():
        native = json.loads(native_path.read_text())
        assert sha256(ROOT / native['raw_directory'] / 'generated.txt') == native['generated_sha256']
        if experiment != 'standalone-fresh-allocation':
            assert native['names_and_sizes_match_marker'] and len(native['code_objects']) == 25
    allocation_path = HERE / f'{experiment}-large-allocation.json'
    if allocation_path.exists():
        allocation = json.loads(allocation_path.read_text())
        for name, record in allocation['runs'].items():
            assert record['pipeline_count'] == 1
            assert sha256(ROOT / record['stdout']) == record['stdout_sha256']
            expected = manifest['baseline_sha256'] if name == 'baseline' else manifest['files']['d8']['sha256']
            assert record['binary_sha256'] == expected
        results['large_allocation'] = allocation
    return {'source_commit': manifest['source_commit'], 'base_commit': manifest['base_commit'],
            'build_manifest_sha256': sha256(manifest_path), 'tests_passed': tests['passed'],
            'unsigned_source_checkpoint': True, 'results': results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('experiments', nargs='+')
    args = parser.parse_args()
    diagnostic = json.loads((HERE / 'table-diagnostics.json').read_text())
    for name, info in diagnostic['files'].items():
        assert sha256(ROOT / diagnostic['directory'] / name) == info['sha256']
    assert git('diff', 'c281a2f9', diagnostic['source_commit']) == (HERE / 'table-diagnostics.patch').read_text()
    for suite, count in [('Compiler', 441), ('DataView', 25)]:
        run = diagnostic['runs'][suite]
        assert len(run['rows']) == 2 * count
        assert sha256(ROOT / run['stdout']) == run['stdout_sha256']
    profiles = {}
    for path in sorted(HERE.glob('*-profile.json')):
        profile = json.loads(path.read_text())
        capture = profile['capture']
        assert sha256(Path(capture['command'][3])) == capture['binary_sha256']
        log = next(arg.split('=', 1)[1] for arg in capture['command']
                   if arg.startswith('--logfile='))
        assert sha256(Path(log)) == capture['log_sha256']
        report = ROOT / profile['profile']['report']
        assert profile_summary(report) == profile['profile']
        assert profile['profile']['unaccounted_ticks'] == 0
        assert len(capture['diagnostic_scores']) == 9
        profiles[path.name] = {'sha256': sha256(path),
                               'included_compiler_ticks': profile['profile']['included_ticks'],
                               'unaccounted_ticks': 0}
    output = {'experiments': {name: audit(name) for name in args.experiments},
              'diagnostic_compilations': {'Compiler': 441, 'DataView': 25},
              'profiles': profiles,
              'statistics': 'Fixed alternating pairs, seed 20261021, 10000 bootstrap '
                            'resamples. Per-case intervals are not corrected for multiple comparisons.',
              'limits': 'Single-machine results for these suites. Zone allocation is not RSS. '
                        'Diagnostic phase times and sampled self shares are distinct from official scores.'}
    (HERE / 'artifact-audit.json').write_text(json.dumps(output, indent=2) + '\n')
    print('Verified', ', '.join(args.experiments))


if __name__ == '__main__':
    main()
