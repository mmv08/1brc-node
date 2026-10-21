#!/usr/bin/env python3
"""Audit completed experiment measurements without selecting individual rounds."""

import argparse
import hashlib
import json
from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
audit = runpy.run_path(str(ROOT / 'v8-research/compile-cost/summarize-validation.py'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('experiments', nargs='+')
    args = parser.parse_args()
    plan = json.loads((HERE / 'plan.json').read_text())
    experiments = {}
    for experiment in args.experiments:
        manifest = json.loads((HERE / f'{experiment}-build-evidence.json').read_text())
        candidate_hash = manifest['files']['d8']['sha256']
        results = {}
        for suite, rounds in [('compiler', 12), ('runtime', 21)]:
            path = HERE / f'{experiment}-{suite}-results.json'
            if not path.exists():
                continue
            result = audit['summarize'](path, rounds)
            assert result['binaries']['baseline']['sha256'] == plan['baseline_sha256']
            assert result['binaries']['candidate']['sha256'] == candidate_hash
            results[suite] = result
        cost_path = HERE / f'{experiment}-cost-summary.json'
        cost = json.loads(cost_path.read_text())
        assert cost['pairs'] == 6
        assert len(cost['runs']) == 14
        for record in cost['runs']:
            assert record['pipeline_count'] == 25
            assert len(record['target_compilations']['normal']) == 2
            assert not record['target_compilations']['osr']
            assert not record['aborted_compilation_lines']
        results['cost'] = {
            'summary_file': str(cost_path.relative_to(ROOT)),
            'sha256': hashlib.sha256(cost_path.read_bytes()).hexdigest(),
            'pairs': 6, 'metrics': cost['summary'],
            'pipeline_count_per_run': 25, 'normal_target_compilations_per_run': 2,
            'target_osr_compilations': 0, 'aborted_compilations': 0,
        }
        experiments[experiment] = results
    output = {
        'baseline_commit': plan['baseline'], 'experiments': experiments,
        'statistics': {'bootstrap_seed': 20261021, 'resamples': 10000,
                       'resampling_unit': 'paired round, retaining cases together'},
        'limits': 'Intervals are per case, without multiple-comparison correction. '
                  'The nine-case mean is a local summary, not whole-V8 performance. '
                  'Instrumented cost diagnostics are separate from stock runtime scores.',
    }
    (HERE / 'validation-summary.json').write_text(json.dumps(output, indent=2) + '\n')
    for experiment, results in experiments.items():
        for suite, result in results.items():
            if suite == 'cost':
                print(experiment, suite, result['metrics']['pipeline_time_ms'])
            else:
                print(experiment, suite, result['case_geometric_mean'])
                for name, case in result['cases'].items():
                    print(name, case)


if __name__ == '__main__':
    main()
