#!/usr/bin/env python3
"""Measure Large-Copy phase allocations separately from official throughput."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
V8 = ROOT / 'results/v8-general/v8'
sys.path.insert(0, str(ROOT / 'v8-research'))
from paired_benchmark import sha256, source_hashes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('experiment', choices=['indexed-storage', 'merge-input-cache'])
    args = parser.parse_args()
    manifest = json.loads((HERE / f'{args.experiment}-build-evidence.json').read_text())
    binaries = {'baseline': ROOT / manifest['baseline_binary'],
                'candidate': ROOT / manifest['directory'] / 'd8'}
    raw = V8.parent / f'escape-{args.experiment}-large-allocation'
    raw.mkdir(exist_ok=False)
    result = {'experiment': args.experiment, 'runs': {},
              'limits': 'One compilation per binary. Allocation evidence only; '
                        'phase durations are not paired timing evidence. Zone allocation is not RSS.'}
    for name, binary in binaries.items():
        expected = manifest['baseline_sha256'] if name == 'baseline' else manifest['files']['d8']['sha256']
        assert sha256(binary) == expected
        cwd = V8 / 'test/js-perf-test/Compiler'
        script = str(HERE / 'compiler-large-once.js')
        sources = source_hashes(cwd, [script])
        command = ['taskset', '-c', '2', str(binary), '--allow-natives-syntax',
                   '--no-concurrent-recompilation', '--trace-opt',
                   '--turbo-stats', '--turbo-stats-nvp', script]
        stdout, stderr = raw / f'{name}.stdout.txt', raw / f'{name}.stderr.txt'
        with stdout.open('w') as out, stderr.open('w') as err:
            subprocess.run(command, cwd=cwd, stdout=out, stderr=err, check=True)
        assert sha256(binary) == expected and source_hashes(cwd, [script]) == sources
        text = stdout.read_text()
        nvp = dict(re.findall(r'"(Turbofan_[^"]+)"=([0-9]+(?:\.[0-9]+)?)', text))
        phase = re.findall(r'^\s*V8\.TFEscapeAnalysis\s+([0-9.]+)\s+\([^)]*\)\s+([0-9]+)', text, re.M)
        assert int(nvp['Turbofan_totals_count']) == 1 and len(phase) == 1
        result['runs'][name] = {
            'command': command, 'cwd': str(cwd), 'binary_sha256': expected,
            'source_sha256': sources, 'stdout': str(stdout.relative_to(ROOT)),
            'stdout_sha256': sha256(stdout), 'stderr_sha256': sha256(stderr),
            'pipeline_count': 1, 'pipeline_zone_bytes': int(nvp['Turbofan_totals_space']),
            'escape_analysis_zone_bytes': int(phase[0][1]),
        }
    (HERE / f'{args.experiment}-large-allocation.json').write_text(json.dumps(result, indent=2) + '\n')
    print({k: {key: r[key] for key in ('pipeline_zone_bytes', 'escape_analysis_zone_bytes')}
           for k, r in result['runs'].items()})


if __name__ == '__main__':
    main()
