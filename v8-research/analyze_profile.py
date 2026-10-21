#!/usr/bin/env python3
"""Summarize V8's official --preprocess output, optionally with native code.

The official processor resolves code moves and address reuse before this script
sees samples. Native bodies are matched to code-creation timestamps, addresses,
sizes and names; unresolved or ambiguous matches are never guessed.
"""

import argparse
import bisect
import collections
import json
import pathlib
import re


def source_tables(profile):
    tables = {}
    for code_id, code in enumerate(profile["code"]):
        source = code.get("source")
        if not source:
            continue
        positions = [
            (int(m[1]), int(m[2]), int(m[3]) if m[3] else None)
            for m in re.finditer(r"C(\d+)O(\d+)(?:I(\d+))?", source["positions"])
        ]
        inlined = [
            int(m[1]) for m in re.finditer(r"F(-?\d+)O\d+(?:I\d+)?", source["inlined"])
        ]
        tables[code_id] = (positions, [p[0] for p in positions], inlined)
    return tables


def source_location(profile, tables, code_id, offset):
    if code_id not in tables:
        return None
    code = profile["code"][code_id]
    positions, offsets, inlined = tables[code_id]
    if not positions or offset < offsets[0]:
        return None
    _, position, inline_id = positions[bisect.bisect_right(offsets, offset) - 1]
    source = code["source"]
    script_id, name = source["script"], code["name"]
    if inline_id is not None:
        function_index = inlined[inline_id]
        if function_index < 0:
            return None
        function_id = source["fns"][function_index]
        if function_id is None:
            return None
        function = profile["functions"][function_id]
        name = function["name"]
        scripts = {
            profile["code"][c]["source"]["script"]
            for c in function["codes"] if "source" in profile["code"][c]
        }
        if len(scripts) != 1:
            return None
        script_id = scripts.pop()
    script = profile["scripts"][script_id]
    if script is None:
        return None
    text = script["source"]
    # V8 source offsets count UTF-16 units; Python counts Unicode code points.
    if not text.isascii():
        encoded = text.encode("utf-16-le", errors="surrogatepass")
        if not 0 <= position * 2 <= len(encoded):
            raise ValueError((name, position, len(encoded) // 2))
        position = len(encoded[:position * 2].decode(
            "utf-16-le", errors="surrogatepass"))
    if not 0 <= position <= len(text):
        raise ValueError((name, position, len(text)))
    start = text.rfind("\n", 0, position) + 1
    end = text.find("\n", position)
    if end < 0:
        end = len(text)
    return (name, script["url"], text.count("\n", 0, position) + 1,
            text[start:end].strip())


def native_bodies(assembly_path, log_path, profile):
    printed = collections.defaultdict(list)
    for section in assembly_path.read_text().split("--- Optimized code ---")[1:]:
        name = re.search(r"^name = (.*)$", section, re.M)
        size = re.search(r"Instructions \(size = (\d+)\)", section)
        instructions = [
            {"address": int(m[1], 16), "offset": int(m[2], 16),
             "bytes": m[3], "operation": m[4]}
            for m in re.finditer(
                r"^0x([0-9a-f]+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(.+)$",
                section, re.M)
        ]
        if name and size and instructions:
            key = (instructions[0]["address"], int(size[1]), name[1])
            printed[key].append(instructions)
    creations = collections.defaultdict(list)
    for line in log_path.read_text().splitlines():
        fields = line.split(",")
        if fields[0] == "code-creation" and fields[1] == "JS":
            creations[(int(fields[3]), fields[6])].append(
                (int(fields[4], 16), int(fields[5]), fields[6].split(" ")[0]))
    matched = {}
    for code_id, code in enumerate(profile["code"]):
        if code.get("type") != "JS" or code.get("kind") != "Opt":
            continue
        keys = creations.get((code["tm"], code["name"]), [])
        if len(keys) != 1:
            raise ValueError(("Ambiguous/missing code creation", code_id, keys))
        bodies = printed.get(keys[0], [])
        if len(bodies) > 1:
            raise ValueError(("Ambiguous disassembly", code_id, keys[0]))
        if bodies:
            matched[code_id] = (keys[0], bodies[0])
    return matched


def analyze(directory, with_native=False):
    profile = json.loads((directory / "profile.json").read_text())
    tables = source_tables(profile)
    counts, offsets, locations = collections.Counter(), {}, collections.Counter()
    unknown, no_stack = 0, 0
    for tick in profile["ticks"]:
        if not tick["s"]:
            no_stack += 1
            continue
        code_id, offset = tick["s"][:2]
        if code_id < 0:
            unknown += 1
            continue
        counts[code_id] += 1
        offsets.setdefault(code_id, collections.Counter())[offset] += 1
        location = source_location(profile, tables, code_id, offset)
        if location:
            locations[location] += 1
    native = native_bodies(directory / "stdout.txt", directory / "v8.log", profile) if with_native else {}
    total = len(profile["ticks"])
    bodies = []
    for code_id, count in counts.most_common():
        code = profile["code"][code_id]
        entry = {"code_id": code_id, "name": code["name"],
                 "kind": code.get("kind", code["type"]),
                 "ticks": count, "percent": 100 * count / total}
        if code_id in native:
            (address, size, _), instructions = native[code_id]
            starts = [i["offset"] for i in instructions]
            instruction_counts = collections.Counter()
            for offset, n in offsets[code_id].items():
                if not 0 <= offset < size:
                    raise ValueError((code_id, offset, size))
                instruction_counts[bisect.bisect_right(starts, offset) - 1] += n
            entry.update(address=hex(address), size=size, instructions=[
                {**instruction, "ticks": instruction_counts[i]}
                for i, instruction in enumerate(instructions)
            ])
        bodies.append(entry)
    return {
        "total_ticks": total, "unknown_leaf_ticks": unknown, "empty_stack_ticks": no_stack,
        "source_mapped_ticks": sum(locations.values()),
        "interpretation": "Sampled PCs and inline source positions, not hardware instruction costs. Code lifetimes are resolved by the official V8 processor. Diagnostic native capture is separate from the three sampling-only runs.",
        "leaf_code": bodies,
        "source_lines": [
            {"function": loc[0], "url": loc[1], "line": loc[2],
             "source": loc[3], "ticks": n, "percent": 100 * n / total}
            for loc, n in locations.most_common()
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=pathlib.Path)
    parser.add_argument("--native", action="store_true")
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    args.output.write_text(json.dumps(analyze(args.directory, args.native), indent=2) + "\n")
