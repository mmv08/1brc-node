#!/usr/bin/env python3
"""Audit completed official measurements and retain paired order summaries."""

import hashlib
import json
import math
from pathlib import Path
import random
import statistics
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'v8-research'))
from paired_benchmark import BOOTSTRAPS, SEED, parse_scores, percentile


DIRECTORY = ROOT / 'v8-research/compile-cost'


def percent(logs):
    return 100 * math.expm1(statistics.fmean(logs))


def summarize(path, rounds):
    path = path.resolve()
    data = json.loads(path.read_text())
    assert data['status'] == 'complete'
    assert data['completed_pairs'] == data['requested_rounds'] == rounds
    assert data['cpu'] == 2
    assert all(data['binary_sha256_after'][name] == info['sha256']
               for name, info in data['binaries'].items())
    keys = data['expected_scores']
    assert set(data['summary']) == set(keys)
    runs = data['runs']
    assert len(runs) == 2 + 2 * rounds
    assert [r['binary'] for r in runs[:2]] == ['baseline', 'candidate']
    assert all(r['round'] == 0 and r['warmup'] for r in runs[:2])
    for record in runs:
        assert record['returncode'] == 0 and record['sources_unchanged']
        assert parse_scores(record['stdout']) == record['scores']
        assert set(record['scores']) == set(keys)
    pairs = []
    for i in range(rounds):
        two = runs[2 + 2 * i:4 + 2 * i]
        order = ['baseline', 'candidate'] if i % 2 == 0 else ['candidate', 'baseline']
        assert [r['binary'] for r in two] == order
        assert all(r['round'] == i + 1 and not r['warmup'] for r in two)
        pairs.append({r['binary']: r['scores'] for r in two})
    logs = {key: [math.log(p['candidate'][key] / p['baseline'][key])
                  for p in pairs] for key in keys}
    per_case = {}
    for key in keys:
        stored = data['summary'][key]
        assert math.isclose(percent(logs[key]), stored['score_change_percent'],
                            abs_tol=1e-10)
        per_case[key] = {
            'score_change_percent': stored['score_change_percent'],
            'ci95_percent': [100 * (x - 1) for x in stored['paired_bootstrap_95_percent_ci']],
            'ab_change_percent': percent(logs[key][::2]),
            'ba_change_percent': percent(logs[key][1::2]),
            'wins': stored['candidate_wins'], 'ties': stored['ties'],
        }
    pair_means = [statistics.fmean(logs[k][i] for k in keys) for i in range(rounds)]
    rng = random.Random(SEED)
    samples = sorted(percent(rng.choices(pair_means, k=rounds)) for _ in range(BOOTSTRAPS))
    return {
        'raw_results': str(path.relative_to(ROOT)),
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'pairs': rounds, 'binaries': data['binaries'], 'd8_args': data['d8_args'],
        'source_sha256': data['source_sha256'], 'cases': per_case,
        'case_geometric_mean': {
            'score_change_percent': percent(pair_means),
            'ci95_percent': [percentile(samples, .025), percentile(samples, .975)],
            'ab_change_percent': percent(pair_means[::2]),
            'ba_change_percent': percent(pair_means[1::2]),
            'per_pair_change_percent': [100 * math.expm1(x) for x in pair_means],
        },
    }


def main():
    experiments = {}
    for experiment in ('field-name', 'fresh-allocation'):
        experiments[experiment] = {
            suite: summarize(DIRECTORY / f'{experiment}-{suite}-results.json', rounds)
            for suite, rounds in (('compiler', 12), ('runtime', 21))
        }
    manifest = json.loads((DIRECTORY / 'fresh-allocation-build-evidence.json').read_text())
    for suite in experiments['fresh-allocation'].values():
        assert suite['binaries']['candidate']['sha256'] == manifest['files']['d8']['sha256']
    for suite in ('compiler', 'runtime'):
        field, fresh = (experiments[e][suite] for e in ('field-name', 'fresh-allocation'))
        assert field['binaries']['baseline'] == fresh['binaries']['baseline']
        assert field['source_sha256'] == fresh['source_sha256']
        assert field['d8_args'] == fresh['d8_args']
    result = {
        'experiments': experiments,
        'statistics': {'bootstrap_seed': SEED, 'resamples': BOOTSTRAPS,
                       'resampling_unit': 'paired round, preserving all cases together'},
        'interpretation': ('Higher benchmark scores are better. Intervals are per case, '
                           'not adjusted for multiple comparisons. Case geometric means '
                           'are local summaries, not whole-V8 performance estimates.'),
    }
    output = DIRECTORY / 'official-validation-summary.json'
    output.write_text(json.dumps(result, indent=2) + '\n')
    for experiment, suites in experiments.items():
        for suite, data in suites.items():
            print(experiment, suite, data['case_geometric_mean'])
            for name, case in data['cases'].items():
                print(name, case)


if __name__ == '__main__':
    main()
