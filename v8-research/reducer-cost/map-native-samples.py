#!/usr/bin/env python3
"""Reproduce compiler-state self-PC mapping for the preserved initial profile."""

from collections import Counter
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PROFILE = ROOT / 'results/v8-general/profiles/compilation-cost/target-fresh-allocation/v8.log'
BINARY = ROOT / 'results/v8-general/v8/out/x64.release-fresh-allocation/d8'
FUNCTIONS = {
    'ReduceTop': (0x140aea0, 0x517, 'reduce-top-before.txt', 2182),
    'Reduce': (0x140b3e0, 0x5b2, 'reduce-before.txt', 1849),
}


def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    counts = Counter()
    included = 0
    start = None
    for line in PROFILE.read_text().splitlines():
        fields = line.split(',')
        if fields[0] == 'shared-library' and fields[1] == str(BINARY):
            start = int(fields[2], 16)
        if fields[0] != 'tick' or fields[5] != '4':
            continue
        included += 1
        if fields[3] == '0':
            assert start is not None
            # .text VMA minus file offset, verified in the preserved ELF.
            counts[int(fields[1], 16) - start + 0x1000] += 1
    assert included == 32959
    functions = {}
    for name, (address, size, filename, expected) in FUNCTIONS.items():
        instructions = {}
        for line in (HERE / filename).read_text().splitlines():
            match = re.match(r'\s*([0-9a-f]+):', line)
            if match:
                instructions[int(match[1], 16)] = line.strip()
        samples = {pc: n for pc, n in counts.items() if address <= pc < address + size}
        assert sum(samples.values()) == expected
        assert samples.keys() <= instructions.keys()
        functions[name] = {
            'total_ticks': sum(samples.values()), 'instruction_bytes': size,
            'sampled_pcs': [
                {'pc': hex(pc), 'ticks': n, 'instruction': instructions[pc]}
                for pc, n in sorted(samples.items(), key=lambda item: -item[1])
            ],
        }
    result = {
        'baseline': '87e3481b', 'binary_sha256': sha256(BINARY),
        'profile': str(PROFILE.relative_to(ROOT)), 'profile_sha256': sha256(PROFILE),
        'included_compiler_ticks': included, 'functions': functions,
        'limits': 'Self samples, not branch counts. Mapping uses logged PIE start plus the verified 0x1000 text VMA/file offset difference; counts match the official tick processor.',
    }
    path = HERE / 'initial-pc-samples.json'
    old = json.loads(path.read_text())
    assert old == result, 'Reproduced mapping differs from the saved evidence'
    print('Verified both native functions and all 4031 self samples.')


if __name__ == '__main__':
    main()
