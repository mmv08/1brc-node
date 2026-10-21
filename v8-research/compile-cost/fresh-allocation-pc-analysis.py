#!/usr/bin/env python3
"""Reproduce bounded native-PC analysis of the saved fcc58178 Compiler profile.

Run from the repository root, without collecting a new profile:
  taskset -c 6 python3 -B v8-research/compile-cost/fresh-allocation-pc-analysis.py

The reviewed basic-block boundaries apply only to the preserved binary hash
below. This intentionally refuses other binaries instead of guessing boundaries.
"""

import bisect
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / "v8-research/compile-cost"
BINARY = ROOT / "results/v8-general/v8/out/x64.release-winning-followups/d8"
PROFILE = ROOT / "results/v8-general/profiles/compilation-cost/candidate/v8.log"
REPORT = PROFILE.with_name("compiler-report.txt")
EXPECTED_BINARY_SHA256 = "93dd6be9762fcaa25aa5662660a466bbc2e0dcb3db0c134003231563abadb921"
PREFIX = "v8::internal::compiler::LoadElimination::"
FUNCTIONS = {
    "AbstractField::Kill": {
        "symbol": PREFIX + "AbstractField::Kill(v8::internal::compiler::LoadElimination::AliasStateInfo const&, v8::internal::MaybeHandle<v8::internal::Name>, v8::internal::Zone*) const",
        "start": 0x14B50D0,
        "end": 0x14B5621,
        "expected_ticks": 40542,
        "blocks": [
            (0x14B50D0, 0x14B5109, "entry and first-scan end check"),
            (0x14B5109, 0x14B5131, "first-scan dead-node check"),
            (0x14B5131, 0x14B513D, "first-scan alias call and result"),
            (0x14B513D, 0x14B516E, "first-scan tree iteration"),
            (0x14B516E, 0x14B51C0, "replacement field allocation and copy-loop setup"),
            (0x14B51C0, 0x14B5370, "copy-loop alias and name filtering"),
            (0x14B5370, 0x14B5588, "retained-entry map insertion and balancing"),
            (0x14B5588, 0x14B55C2, "copy-loop tree iteration"),
            (0x14B55C2, 0x14B5621, "allocation slow paths and common return"),
        ],
    },
    "AliasStateInfo::MayAlias": {
        "symbol": PREFIX + "AliasStateInfo::MayAlias(v8::internal::compiler::Node*) const",
        "start": 0x14B5630,
        "end": 0x14B577E,
        "expected_ticks": 8383,
        "blocks": [
            (0x14B5630, 0x14B5650, "entry and Allocate opcode test"),
            (0x14B5650, 0x14B565B, "Allocate-only exact pointer comparison"),
            (0x14B565B, 0x14B5773, "general object-alias and map paths"),
            (0x14B5773, 0x14B577E, "common return"),
        ],
    },
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def command(*args):
    return subprocess.check_output(args, text=True)


def main():
    affinity = sorted(os.sched_getaffinity(0))
    if affinity != [6]:
        raise SystemExit("Run under taskset -c 6 to isolate this offline analysis.")
    if sha256(BINARY) != EXPECTED_BINARY_SHA256:
        raise ValueError("Preserved binary changed; reviewed block boundaries are invalid")

    symbols = []
    for line in command("nm", "-S", "-n", "-C", "--defined-only", str(BINARY)).splitlines():
        match = re.fullmatch(r"([0-9a-f]+) ([0-9a-f]+) [tTwW] (.+)", line)
        if match:
            start, size, name = match.groups()
            symbols.append((int(start, 16), int(size, 16), name))
    by_name = {name: (start, size) for start, size, name in symbols}
    for info in FUNCTIONS.values():
        if by_name[info["symbol"]] != (info["start"], info["end"] - info["start"]):
            raise ValueError("Native symbol extent does not match reviewed disassembly")
    symbols.sort()
    symbol_starts = [entry[0] for entry in symbols]

    text_section = next(
        line.split() for line in command("objdump", "-h", str(BINARY)).splitlines()
        if len(line.split()) > 5 and line.split()[1] == ".text"
    )
    text_vma = int(text_section[3], 16)
    text_file_offset = int(text_section[5], 16)
    file_offset_minus_vma = text_file_offset - text_vma
    counts = {name: Counter() for name in FUNCTIONS}
    callers = {name: Counter() for name in FUNCTIONS}
    all_tick_states = Counter()
    log_hash = hashlib.sha256()
    library = None
    with PROFILE.open("rb") as source:
        for raw in source:
            log_hash.update(raw)
            if raw.startswith(b"shared-library,"):
                values = raw.decode().rstrip().split(",")
                if values[1] == str(BINARY):
                    library = {
                        "path": values[1], "start": int(values[2], 16),
                        "end": int(values[3], 16), "aslr_slide": int(values[4], 0),
                    }
            if not raw.startswith(b"tick,"):
                continue
            values = raw.decode().rstrip().split(",")
            all_tick_states[values[5]] += 1
            # Match tools/tickprocessor.mjs -c: COMPILER VM state is 4.
            # External callbacks replace the top PC and are not included here.
            if values[5] != "4" or values[3] != "0":
                continue
            if library is None or library["aslr_slide"] != 0:
                raise ValueError("Expected zero-slide PIE mapping before compiler ticks")
            native_pc = int(values[1], 16) - library["start"] - file_offset_minus_vma
            for name, info in FUNCTIONS.items():
                if info["start"] <= native_pc < info["end"]:
                    counts[name][native_pc] += 1
                    if len(values) > 6:
                        callers[name][values[6]] += 1
                    break

    functions = {}
    report_text = REPORT.read_text()
    for name, info in FUNCTIONS.items():
        pcs = counts[name]
        total = sum(pcs.values())
        if total != info["expected_ticks"]:
            raise ValueError(f"{name}: {total} samples differ from saved official report")
        report_pattern = rf"^\s*{total}\s+[0-9.]+%\s+[0-9.]+%\s+{re.escape(info['symbol'])}$"
        if not re.search(report_pattern, report_text, re.MULTILINE):
            raise ValueError(f"{name}: saved tick-processor report disagrees")
        blocks = []
        for start, end, label in info["blocks"]:
            ticks = sum(count for pc, count in pcs.items() if start <= pc < end)
            blocks.append({
                "label": label, "start_vma": hex(start), "end_vma_exclusive": hex(end),
                "ticks": ticks, "percent_of_function_self_ticks": 100 * ticks / total,
            })
        if sum(block["ticks"] for block in blocks) != total:
            raise ValueError("Block classification does not cover every sample")
        caller_rows = []
        for address, ticks in callers[name].most_common():
            pc = int(address, 16) - library["start"] - file_offset_minus_vma
            index = bisect.bisect_right(symbol_starts, pc) - 1
            start, size, symbol = symbols[index]
            if not start <= pc < start + size:
                symbol = "unresolved"
            caller_rows.append({"logged_pc": address, "native_vma": hex(pc), "symbol": symbol, "ticks": ticks})
        functions[name] = {
            "symbol": info["symbol"], "start_vma": hex(info["start"]),
            "end_vma_exclusive": hex(info["end"]), "self_ticks": total,
            "matches_official_tick_processor_total": True, "blocks": blocks,
            "sampled_pcs": [{"vma": hex(pc), "offset": hex(pc - info["start"]), "ticks": ticks}
                            for pc, ticks in pcs.most_common()],
            "first_logged_stack_entries": caller_rows,
        }

    evidence = {
        "schema_version": 1,
        "source_commit": "fcc58178",
        "reproduce": "taskset -c 6 python3 -B v8-research/compile-cost/fresh-allocation-pc-analysis.py",
        "analysis_cpu_affinity": affinity,
        "provenance": {
            "profile": str(PROFILE.relative_to(ROOT)), "profile_sha256": log_hash.hexdigest(),
            "official_processor_report": str(REPORT.relative_to(ROOT)),
            "official_processor_report_sha256": sha256(REPORT),
            "binary": str(BINARY.relative_to(ROOT)), "binary_sha256": EXPECTED_BINARY_SHA256,
            "source_commit_reference": "v8-research/compile-cost/build-manifest.json:baseline",
            "reviewed_disassembly": "objdump -d -C --start-address=0x14b50d0 --stop-address=0x14b577e results/v8-general/v8/out/x64.release-winning-followups/d8",
        },
        "address_translation": {
            "library_start": hex(library["start"]), "library_end": hex(library["end"]),
            "aslr_slide": library["aslr_slide"], "text_vma": hex(text_vma),
            "text_file_offset": hex(text_file_offset),
            "file_offset_minus_vma": file_offset_minus_vma,
            "formula": "native VMA = sampled PC - logged library start - (.text file offset - .text VMA)",
            "reference": "tools/tickprocessor.mjs LinuxCppEntriesProvider.loadSymbols and CppEntriesProvider.parseVmSymbols",
        },
        "all_tick_states": dict(all_tick_states),
        "compiler_state_ticks": all_tick_states["4"],
        "functions": functions,
        "interpretation": [
            "38,230 of 40,542 Kill self samples are before replacement allocation: entry, first-scan dead checks, alias call sites, and tree iteration.",
            "2,387 of 8,383 AliasStateInfo::MayAlias self samples are uniquely in the Allocate exact-identity block; only 33 are in the general alias/map path.",
            "The saved official processor caller tree attributes 40,531 of 40,542 Kill samples to run_copy in unchanged Compiler/large.js.",
            "These samples support replacing linear alias scans with exact map lookup when the queried object is an Allocate node, using the existing alias invariant.",
        ],
        "limitations": [
            "One saved instrumented sampling run; this is not a hardware-counter measurement or a new benchmark.",
            "Self-PC attribution omits time spent in called functions and does not count calls, branch outcomes, misses, or live/dead entries.",
            "Sampled PCs alone do not identify cache misses, branch mispredictions, or per-instruction latency.",
            "The logged stack reaches Runtime_BenchTurbofan rather than unwinding intermediate native compiler callers.",
            "Exact hit/miss and dead-entry frequencies would require bounded counters in Kill; speedup requires uninstrumented paired benchmarks.",
        ],
    }
    output = DIRECTORY / "fresh-allocation-pc-evidence.json"
    output.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({"output": str(output.relative_to(ROOT)), "self_ticks": {
        name: function["self_ticks"] for name, function in functions.items()
    }}))


if __name__ == "__main__":
    main()
