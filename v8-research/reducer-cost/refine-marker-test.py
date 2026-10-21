#!/usr/bin/env python3
"""Rebuild one changed test and relink unchanged validated production objects."""

import hashlib
import json
from pathlib import Path
import re
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
V8 = ROOT / 'results/v8-general/v8'
OUT = V8 / 'out/x64.release-encoded-marker-tests'


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    commit = run(['git', 'rev-parse', 'HEAD'], cwd=V8,
                 capture_output=True, text=True).stdout.strip()
    assert commit.startswith('c281a2f9')
    run(['git', 'diff', '--quiet', 'HEAD'], cwd=V8)
    changed = run(['git', 'diff', '--name-only', '428ce5ce', commit], cwd=V8,
                  capture_output=True, text=True).stdout.splitlines()
    assert changed == ['test/unittests/compiler/node-marker-unittest.cc']
    original = json.loads((HERE / 'encoded-marker-build-evidence.json').read_text())
    if not OUT.exists():
        run(['cp', '-a', '--reflink=auto', str(ROOT / original['directory']), str(OUT)])
    assert digest(OUT / 'd8') == original['files']['d8']['sha256']
    assert digest(OUT / 'args.gn') == original['files']['args.gn']['sha256']
    obj = 'obj/test/unittests/v8_unittests_sources/node-marker-unittest.o'
    run(['third_party/ninja/ninja', '-C', str(OUT), obj], cwd=V8)

    # Ninja's link rule uses ${in} as its response-file content. Use the exact
    # generated edge and link command, retaining the validated production inputs.
    edge_file = OUT / 'obj/test/unittests/v8_unittests.ninja'
    edge, = [line for line in edge_file.read_text().splitlines()
             if line.startswith('build ./v8_unittests: link ')]
    inputs = edge.split(': link ', 1)[1].split(' |', 1)[0].split()
    assert obj in inputs and all('$' not in item for item in inputs)
    assert all((OUT / item).is_file() for item in inputs)
    response = OUT / 'v8_unittests.rsp'
    response.write_text('\n'.join(inputs) + '\n')
    commands = json.loads(run(['third_party/ninja/ninja', '-C', str(OUT),
                               '-t', 'compdb', 'link'], cwd=V8,
                              capture_output=True, text=True).stdout)
    link, = [row for row in commands if Path(row['output']).name == 'v8_unittests']
    command = shlex.split(link['command'])
    assert str(OUT) == link['directory']
    assert '@./v8_unittests.rsp' in command
    log = V8.parent / 'encoded-marker-refinement-link.log'
    with log.open('w') as stream:
        run(command, cwd=OUT, stdout=stream, stderr=subprocess.STDOUT)
    tests = [sys.executable, '-B', 'tools/run-tests.py',
             '--outdir=' + str(OUT), '--progress=verbose', '--variants=default',
             '--run-skipped', 'unittests/NodeMarkerTest.*',
             'unittests/GraphReducerTest.*', 'unittests/AdvancedReducerTest.*']
    tested = subprocess.run(tests, cwd=V8, capture_output=True, text=True)
    test_log = V8.parent / 'encoded-marker-refinement-tests.log'
    test_log.write_text(tested.stdout + tested.stderr)
    tested.check_returncode()
    match = re.search(r'>>> (\d+) tests ran', tested.stdout)
    assert match and int(match[1]) == 28 and 'All tests succeeded' in tested.stdout
    assert digest(OUT / 'd8') == original['files']['d8']['sha256']
    patch = run(['git', 'diff', '87e3481b', commit], cwd=V8,
                capture_output=True, text=True).stdout
    (HERE / 'encoded-marker.patch').write_text(patch)
    result = {
        'source_commit': commit, 'prior_tested_commit': original['source_commit'],
        'changed_files': changed, 'd8_sha256_unchanged': digest(OUT / 'd8'),
        'test_binary_sha256': digest(OUT / 'v8_unittests'), 'test_directory': str(OUT),
        'tests': tests, 'passed': int(match[1]), 'failed': 0,
        'test_log': str(test_log.relative_to(ROOT)), 'test_log_sha256': digest(test_log),
        'link_command': command, 'link_cwd': str(OUT),
        'response_file_sha256': digest(response),
        'method': 'Only the test source differs from428ce5ce. Copy the preserved validated build, compile the changed test object with Ninja, and use its generated link command/input list. Production d8 hash is unchanged.',
        'build_note': 'A broad rebuild triggered by branch header timestamps was stopped. One targeted test-object build briefly overlapped that redundant build; no benchmark, profile or test ran during either build.',
        'runner_note': 'Direct multi-test execution is unsupported by V8 platform initialization. The final validation uses the standard runner with a separate process per test.',
    }
    (HERE / 'encoded-marker-test-refinement.json').write_text(json.dumps(result, indent=2) + '\n')
    print(f'Test refinement: {match[1]} tests passed; measured d8 unchanged.')


if __name__ == '__main__':
    main()
