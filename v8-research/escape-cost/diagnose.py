#!/usr/bin/env python3
"""Record table occupancy and lookup attribution; never report diagnostic scores as gains."""

from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
V8 = ROOT / 'results/v8-general/v8'
sys.path.insert(0, str(ROOT / 'v8-research'))
from paired_benchmark import parse_scores, sha256, source_hashes

COMMIT = '285d9486'
DIRECTORY = V8 / 'out/x64.release-escape-table-diagnostics'


def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)


def parse(text, suite):
    rows = []
    case, function = suite, None
    pending = []
    for line in text.splitlines():
        if line.startswith('EA_CASE_BEGIN '):
            assert not pending
            case = line.removeprefix('EA_CASE_BEGIN ')
        elif line.startswith('EA_CASE_END '):
            assert not pending
            assert case == line.removeprefix('EA_CASE_END ')
            case = suite
        match = re.search(r'\[compiling method .*<JSFunction ([^ ]+) ', line)
        if match:
            function = match[1]
        if not line.startswith('EA_TABLE '):
            continue
        row = json.loads(line.removeprefix('EA_TABLE '))
        row.update(case=case, function=function)
        pending.append(row)
        if len(pending) != 4:
            continue
        assert [(r['stage'], r['table']) for r in pending] == [
            ('analysis', 'virtual'), ('analysis', 'state'),
            ('final', 'virtual'), ('final', 'state')]
        assert len({r['id'] for r in pending}) == 1
        for earlier, final in zip(pending[:2], pending[2:]):
            assert final['gets'] >= earlier['gets']
            final['replacement_gets'] = final['gets'] - earlier['gets']
            final['compilation_sequence'] = len(rows) // 2
            assert final['gets'] == final['hits'] + final['missing_gets']
            assert final['merge_gets'] <= final['gets']
            # Structural estimates omit historical growth buffers and allocator
            # overhead. Actual phase-zone statistics are measured separately.
            length = final['max_stored_id'] + 1 if final['entries'] else 0
            final['estimated_dense_value_bytes'] = length * final['value_bytes']
            final['estimated_pointer_index_bytes'] = (
                length * 8 + final['entries'] * final['value_bytes'])
            final['estimated_hash_live_bytes'] = (
                final['buckets'] * 8 + final['entries'] * (24 + final['value_bytes']))
            for size in (64, 256, 1024):
                pages = (length + size - 1) // size
                final[f'estimated_chunk{size}_bytes'] = (
                    pages * 8 + final[f'pages{size}'] *
                    (size * final['value_bytes'] + size // 8))
            rows.append(final)
        pending = []
    assert not pending and rows
    grouped = defaultdict(list)
    for row in rows:
        grouped[row['case'], row['table']].append(row)
    summaries = []
    for (case, table), items in grouped.items():
        totals = {name: sum(r[name] for r in items) for name in (
            'gets', 'hits', 'missing_gets', 'merge_gets', 'merge_missing_gets',
            'sets', 'default_sets', 'replacement_gets')}
        summaries.append(dict(case=case, table=table, compilations=len(items),
                              totals=totals, representative=items[-1]))
    return {'rows': rows, 'summaries': summaries}


def main():
    commit = run(['git', 'rev-parse', 'HEAD'], cwd=V8,
                 capture_output=True, text=True).stdout.strip()
    assert commit.startswith(COMMIT)
    run(['git', 'diff', '--quiet', 'HEAD'], cwd=V8)
    assert not DIRECTORY.exists()
    run(['cp', '-a', '--reflink=auto', 'out/x64.release', str(DIRECTORY)], cwd=V8)
    files = {name: {'sha256': sha256(DIRECTORY / name),
                    'size_bytes': (DIRECTORY / name).stat().st_size}
             for name in ('d8', 'v8_unittests', 'snapshot_blob.bin', 'icudtl.dat',
                          'args.gn', 'v8_build_config.json')}
    output = {'source_commit': commit, 'directory': str(DIRECTORY.relative_to(ROOT)),
              'files': files, 'gn_args': (DIRECTORY / 'args.gn').read_text(),
              'runs': {}, 'limits': 'Instrumented lookup counts, not performance evidence. '
              'Memory estimates include current storage only, omit historical allocation '
              'and assume eight-byte alignment for the observed types.'}
    raw = V8.parent / 'escape-table-diagnostics'
    raw.mkdir(exist_ok=False)
    for suite in ('Compiler', 'DataView'):
        cwd = V8 / 'test/js-perf-test' / suite
        script = str(HERE / 'compiler-once.js') if suite == 'Compiler' else 'run.js'
        flags = ['--no-concurrent-recompilation', '--trace-opt']
        if suite == 'Compiler':
            flags.append('--allow-natives-syntax')
        command = ['taskset', '-c', '2', str(DIRECTORY / 'd8'), *flags, script]
        sources = source_hashes(cwd, [script])
        stdout, stderr = raw / f'{suite}.stdout.txt', raw / f'{suite}.stderr.txt'
        with stdout.open('w') as out, stderr.open('w') as err:
            run(command, cwd=cwd, stdout=out, stderr=err)
        assert source_hashes(cwd, [script]) == sources
        parsed = parse(stdout.read_text(), suite)
        if suite == 'Compiler':
            counts = Counter(r['case'] for r in parsed['rows'] if r['table'] == 'state')
            expected = {name: 100 if name.startswith('Small-') else
                        10 if name.startswith('Medium-') else 1 for name in counts}
            assert len(counts) == 9 and counts == expected and sum(counts.values()) == 441, counts
        else:
            scores = parse_scores(stdout.read_text())
            assert len(scores) == 6
            parsed['diagnostic_scores'] = scores
        output['runs'][suite] = {
            'command': command, 'cwd': str(cwd), 'returncode': 0,
            'source_sha256': sources, 'stdout': str(stdout.relative_to(ROOT)),
            'stdout_sha256': sha256(stdout), 'stderr_sha256': sha256(stderr), **parsed}
        print(suite, len(parsed['rows']) // 2, 'compilations', flush=True)
    assert sha256(DIRECTORY / 'd8') == files['d8']['sha256']
    (HERE / 'table-diagnostics.json').write_text(json.dumps(output, indent=2) + '\n')


if __name__ == '__main__':
    main()
