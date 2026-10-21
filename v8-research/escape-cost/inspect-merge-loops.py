#!/usr/bin/env python3
"""Locate table reads and inlined hash division in the native merge routine."""

import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'v8-research'))
from paired_benchmark import sha256


def inspect(path):
    instructions = {}
    for line in path.read_text().splitlines():
        match = re.match(r'\s*([0-9a-f]+):\s+(?:[0-9a-f]{2}\s+)+([a-z][a-z0-9]*)\s*(.*)', line)
        if match:
            instructions[int(match[1], 16)] = (match[2], match[3])
    addresses = sorted(instructions)
    edges = {a: set() for a in addresses}
    for index, address in enumerate(addresses):
        op, args = instructions[address]
        if op.startswith('j'):
            target = re.match(r'0x([0-9a-f]+)', args)
            if target and int(target[1], 16) in edges:
                edges[address].add(int(target[1], 16))
        if op not in ('jmp', 'jmpq', 'ret', 'retq', 'ud2', 'int3') and index + 1 < len(addresses):
            edges[address].add(addresses[index + 1])
    reachable, stack = set(), [addresses[0]]
    while stack:
        node = stack.pop()
        if node in reachable:
            continue
        reachable.add(node)
        stack.extend(edges[node] - reachable)
    predecessors = {a: set() for a in reachable}
    for a in reachable:
        for b in edges[a]:
            predecessors[b].add(a)
    entry = addresses[0]
    dominators = {a: ({entry} if a == entry else set(reachable)) for a in reachable}
    changed = True
    while changed:
        changed = False
        for a in sorted(reachable - {entry}):
            new = {a} | set.intersection(*(dominators[p] for p in predecessors[a]))
            if new != dominators[a]:
                dominators[a] = new
                changed = True
    loops = {}
    for tail in reachable:
        for head in edges[tail]:
            if head not in dominators[tail]:
                continue
            members, pending = {head, tail}, [tail] if tail != head else []
            while pending:
                node = pending.pop()
                for parent in predecessors[node] - members:
                    members.add(parent)
                    pending.append(parent)
            loops.setdefault(head, set()).update(members)
    calls, divisions = [], []
    for a in addresses:
        op, args = instructions[a]
        if op.startswith('call') and 'SparseSidetable<' in args and '::Get(' in args:
            calls.append({'address': hex(a), 'instruction': op + ' ' + args,
                          'loop_headers': [hex(h) for h, members in sorted(loops.items()) if a in members]})
        if op.startswith('div'):
            divisions.append({'address': hex(a), 'instruction': op + ' ' + args,
                              'loop_headers': [hex(h) for h, members in sorted(loops.items()) if a in members]})
    return {'disassembly_sha256': sha256(path), 'table_read_calls': calls,
            'inlined_divisions': divisions,
            'natural_loops': [{'header': hex(h), 'instruction_count': len(members)}
                              for h, members in sorted(loops.items())]}


def main():
    result = {'baseline': inspect(HERE / 'marker-merge-inputs.txt'),
              'candidate': inspect(HERE / 'merge-input-cache-native.txt'),
              'limits': 'Static native control flow, not dynamic counts. Natural loops '
                        'use backedges whose target dominates their source. Calls return '
                        'to the next instruction; exception paths are not modeled.'}
    baseline = sorted(len(c['loop_headers']) for c in result['baseline']['table_read_calls'])
    candidate = sorted(len(c['loop_headers']) for c in result['candidate']['table_read_calls'])
    assert baseline == [0, 1], baseline
    assert candidate == [0, 0, 1], candidate
    assert len(result['baseline']['inlined_divisions']) == 3
    assert not result['candidate']['inlined_divisions']
    (HERE / 'merge-loop-evidence.json').write_text(json.dumps(result, indent=2) + '\n')
    print('Table-read loop nesting:', baseline, '->', candidate)
    print('Baseline division loop nesting:', [len(i['loop_headers'])
          for i in result['baseline']['inlined_divisions']])


if __name__ == '__main__':
    main()
