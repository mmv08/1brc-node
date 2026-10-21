#!/usr/bin/env python3
"""Check saved identities and completeness after the experiment runs finish."""

import hashlib
import json
from collections import Counter
from pathlib import Path
import re
import runpy
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
V8 = ROOT / 'results/v8-general/v8'
sys.path.insert(0, str(ROOT / 'v8-research'))
from compilation_cost import parse_run

profile_summary = runpy.run_path(str(
    ROOT / 'v8-research/compile-cost/finish-fresh-allocation.py'))['profile_summary']


def read(name):
    return json.loads((HERE / name).read_text())


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def git(*args, cwd=V8):
    return subprocess.check_output(['git', *args], cwd=cwd, text=True)


def check_unsigned(commit, cwd=V8):
    raw = git('cat-file', 'commit', commit, cwd=cwd)
    assert not re.search(r'^gpgsig(?:-sha256)? ', raw, re.M), commit


def check_test_log(path, digest, count):
    assert sha256(path) == digest
    text = path.read_text()
    assert int(re.findall(r'>>> (\d+) tests ran', text)[-1]) == count > 0
    assert 'All tests succeeded' in text and ': FAIL' not in text


def code_objects(text):
    objects = []
    for chunk in text.split('--- Optimized code ---')[1:]:
        name = re.search(r'^name = (.+)$', chunk, re.M)
        size = re.search(r'^Instructions \(size = (\d+)\)', chunk, re.M)
        if name and size:
            objects.append({'name': name[1], 'instruction_bytes': int(size[1])})
    return objects


def object_counts(objects):
    return Counter((obj['name'], obj['instruction_bytes']) for obj in objects)


def main():
    plan = read('plan.json')
    summary = read('validation-summary.json')
    assert summary['baseline_commit'] == plan['baseline']
    assert sha256(ROOT / plan['baseline_binary']) == plan['baseline_sha256']
    experiments = {}
    for experiment in plan['experiments']:
        name = experiment['id']
        manifest = read(f'{name}-build-evidence.json')
        assert manifest['base_commit'] == plan['baseline']
        assert manifest['source_commit'].startswith(experiment['source_commit'])
        final_commit = experiment.get('final_source_commit', experiment['source_commit'])
        patch = git('diff', plan['baseline'], final_commit)
        assert (HERE / f'{name}.patch').read_text() == patch
        for commit in [*experiment.get('source_checkpoints', []), final_commit]:
            check_unsigned(commit)
        directory = ROOT / manifest['directory']
        for filename, info in manifest['files'].items():
            path = directory / filename
            assert sha256(path) == info['sha256']
            assert path.stat().st_size == info['size_bytes']
        tests = manifest['tests']
        check_test_log(ROOT / tests['log'], tests['sha256'], tests['passed'])
        native = read(f'{name}-native-evidence.json')
        assert native['all_function_names_and_sizes_match_baseline']
        assert len(native['code_objects']) == 25
        raw_native = ROOT / native['raw_directory'] / 'opt-code.txt'
        assert code_objects(raw_native.read_text()) == native['code_objects']
        baseline_native = json.loads((ROOT / 'v8-research/compile-cost/fresh-allocation-native-evidence.json').read_text())
        assert object_counts(native['code_objects']) == object_counts(baseline_native['code_objects'])
        runs = {}
        for suite, pairs in [('cost', 6), ('compiler', 12), ('runtime', 21)]:
            path = HERE / f'{name}-{suite}-results.json'
            if suite == 'runtime' and not path.exists():
                assert experiment['disposition'].startswith('Rejected'), experiment
                continue
            data = json.loads(path.read_text())
            assert data['status'] == 'complete'
            assert data['completed_pairs'] == data['requested_rounds'] == pairs
            assert len(data['runs']) == 2 + 2 * pairs
            assert data['binaries']['baseline']['sha256'] == plan['baseline_sha256']
            assert data['binaries']['candidate']['sha256'] == manifest['files']['d8']['sha256']
            assert all(record['returncode'] == 0 and record['sources_unchanged']
                       for record in data['runs'])
            if suite != 'cost':
                assert summary['experiments'][name][suite]['sha256'] == sha256(path)
            runs[suite] = {'sha256': sha256(path), 'completed_pairs': pairs}
        cost = read(f'{name}-cost-summary.json')
        raw_cost_path = HERE / f'{name}-cost-results.json'
        raw_cost = json.loads(raw_cost_path.read_text())
        assert Path(cost['source_results']) == raw_cost_path
        assert cost['binaries'] == raw_cost['binaries']
        assert [parse_run(record) for record in raw_cost['runs']] == cost['runs']
        assert summary['experiments'][name]['cost']['sha256'] == sha256(HERE / f'{name}-cost-summary.json')
        assert summary['experiments'][name]['cost']['metrics'] == cost['summary']
        assert cost['pairs'] == 6 and len(cost['runs']) == 14
        for record in cost['runs']:
            assert record['pipeline_count'] == 25
            assert len(record['target_compilations']['normal']) == 2
            assert not record['target_compilations']['osr']
            assert not record['aborted_compilation_lines']
        profile = read(f'{name}-post-profile.json')
        assert profile['capture']['binary_sha256'] == manifest['files']['d8']['sha256']
        assert profile['capture']['source_commit'] == manifest['source_commit']
        assert profile['baseline']['unaccounted_ticks'] == 0
        assert profile['candidate']['unaccounted_ticks'] == 0
        for kind in ['baseline', 'candidate']:
            report = ROOT / profile[kind]['report']
            assert sha256(report) == profile[kind]['sha256']
            assert profile_summary(report) == profile[kind]
            assert profile[kind]['included_ticks'] == profile[kind]['total_ticks'] - profile[kind]['excluded_ticks']
        log_arg, = [arg for arg in profile['capture']['command'] if arg.startswith('--logfile=')]
        assert sha256(Path(log_arg.split('=', 1)[1])) == profile['capture']['log_sha256']
        experiments[name] = {
            'measured_source_commit': manifest['source_commit'],
            'final_source_commit': git('rev-parse', final_commit).strip(),
            'patch_matches_committed_diff': True,
            'preserved_build_matches_manifest': True,
            'tests': tests,
            'generated_function_names_and_sizes_match_baseline': True,
            'runs': runs,
            'compilation_counts_match': True,
            'post_profile_has_zero_unaccounted_ticks': True,
        }
    refinement = read('encoded-marker-test-refinement.json')
    marker = read('encoded-marker-build-evidence.json')
    marker_plan, = [exp for exp in plan['experiments'] if exp['id'] == 'encoded-marker']
    assert refinement['prior_tested_commit'] == marker['source_commit']
    assert refinement['source_commit'] == git('rev-parse', marker_plan['final_source_commit']).strip()
    assert refinement['d8_sha256_unchanged'] == marker['files']['d8']['sha256']
    changed = git('diff', '--name-only', refinement['prior_tested_commit'],
                  refinement['source_commit']).splitlines()
    assert changed == refinement['changed_files'] == ['test/unittests/compiler/node-marker-unittest.cc']
    directory = Path(refinement['test_directory'])
    assert sha256(directory / 'd8') == refinement['d8_sha256_unchanged']
    assert sha256(directory / 'v8_unittests') == refinement['test_binary_sha256']
    check_test_log(ROOT / refinement['test_log'], refinement['test_log_sha256'],
                   refinement['passed'])
    report = ROOT / 'v8-research/README.md'
    for target in re.findall(r'\]\(([^)]+)\)', report.read_text()):
        if '://' not in target and not target.startswith('#'):
            assert (report.parent / target.split('#')[0]).exists(), target
    root_commits = git('rev-list', '95a0ae5^..HEAD', cwd=ROOT).splitlines()
    for commit in root_commits:
        check_unsigned(commit, cwd=ROOT)
    touched = git('diff', '--name-only', '95a0ae5^', 'HEAD', cwd=ROOT).splitlines()
    assert all(path.startswith('v8-research/') for path in touched), touched
    output = {
        'baseline_commit': plan['baseline'],
        'experiments': experiments,
        'marker_test_only_refinement_verified': True,
        'report_local_links_resolve': True,
        'unsigned_root_checkpoints_through': root_commits[0],
        'root_checkpoint_count': len(root_commits),
        'production_program_edits': 'none in this follow-up',
    }
    (HERE / 'final-artifact-audit.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
