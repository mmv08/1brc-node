#!/usr/bin/env python3
"""Map refreshed baseline compiler samples to native lookup instructions."""

from collections import Counter
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
V8 = ROOT / 'results/v8-general/v8'
BINARY = V8 / 'out/x64.release-encoded-marker/d8'
PROFILE = V8.parent / 'profiles/escape-cost/marker-baseline/v8.log'
LLVM = V8 / 'third_party/llvm-build/Release+Asserts/bin'
sys.path.insert(0, str(ROOT / 'v8-research'))
from paired_benchmark import sha256


def main():
    sections = subprocess.check_output(['readelf', '-WS', str(BINARY)], text=True)
    section = re.search(r'\] \.text\s+PROGBITS\s+([0-9a-f]+)\s+([0-9a-f]+)', sections)
    offset = int(section[1], 16) - int(section[2], 16)
    counts, included, start = Counter(), 0, None
    for line in PROFILE.read_text().splitlines():
        fields = line.split(',')
        if fields[0] == 'shared-library' and fields[1] == str(BINARY):
            start = int(fields[2], 16)
        if fields[0] != 'tick' or fields[5] != '4':
            continue
        included += 1
        if fields[3] == '0':
            assert start is not None
            counts[int(fields[1], 16) - start + offset] += 1
    symbols = subprocess.check_output([str(LLVM / 'llvm-nm'), '-S', '-C', str(BINARY)], text=True)
    functions = {}
    for line in symbols.splitlines():
        if 'SparseSidetable<' in line and '>::Get(' in line:
            label = 'state-get' if 'VariableTracker::State' in line else 'virtual-get'
        elif 'VariableTracker::MergeInputs(' in line:
            label = 'merge-inputs'
        else:
            continue
        parts = line.split(maxsplit=3)
        address, size = int(parts[0], 16), int(parts[1], 16)
        command = [str(LLVM / 'llvm-objdump'), '-d', '-C',
                   '--start-address=' + hex(address),
                   '--stop-address=' + hex(address + size), str(BINARY)]
        disassembly = subprocess.check_output(command, text=True)
        (HERE / f'marker-{label}.txt').write_text(disassembly)
        instructions = {}
        for instruction in disassembly.splitlines():
            match = re.match(r'\s*([0-9a-f]+):', instruction)
            if match:
                instructions[int(match[1], 16)] = instruction.strip()
        samples = {pc: n for pc, n in counts.items() if address <= pc < address + size}
        assert samples.keys() <= instructions.keys()
        aliases = [s.split(maxsplit=3)[-1] for s in symbols.splitlines()
                   if s.startswith(parts[0] + ' ')]
        assert len(aliases) == 1, aliases
        functions[label] = {
            'symbol': parts[3], 'address': hex(address), 'instruction_bytes': size,
            'self_ticks': sum(samples.values()),
            'sampled_pcs': [{'pc': hex(pc), 'offset': hex(pc - address),
                             'ticks': n, 'instruction': instructions[pc]}
                            for pc, n in sorted(samples.items(), key=lambda item: -item[1])],
        }
    assert included == 169430
    assert {k: v['self_ticks'] for k, v in functions.items()} == {
        'state-get': 5749, 'virtual-get': 3443, 'merge-inputs': 4026}
    result = {
        'binary_sha256': sha256(BINARY), 'profile_sha256': sha256(PROFILE),
        'included_compiler_ticks': included, 'text_vma_file_offset_difference': offset,
        'functions': functions,
        'limits': 'Self samples identify sampled instructions, not branch counts or '
                  'instruction latency. Counts match the official tick processor.',
    }
    (HERE / 'marker-native-samples.json').write_text(json.dumps(result, indent=2) + '\n')
    print({k: (v['instruction_bytes'], v['self_ticks']) for k, v in functions.items()})


if __name__ == '__main__':
    main()
