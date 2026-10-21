#!/usr/bin/env python3
"""Summarize separately instrumented V8 compilation-cost benchmark pairs."""

import argparse
import json
import math
from pathlib import Path
import random
import re
import statistics


def parse_run(run):
    output = run["stdout"]
    nvp = {}
    for name, value in re.findall(r'"(Turbofan_[^"]+)"=([0-9]+(?:\.[0-9]+)?)', output):
        if name in nvp:
            raise ValueError(f"Repeated compilation statistic: {name}")
        nvp[name] = float(value)
    metrics = {
        "pipeline_time_ms": nvp["Turbofan_totals_time"],
        "pipeline_zone_bytes": nvp["Turbofan_totals_space"],
    }
    peeling = re.findall(
        r"^\s*V8\.TFLoopPeeling\s+([0-9.]+)\s+\([^)]*\)\s+([0-9]+)",
        output, re.M)
    if len(peeling) != 1:
        raise ValueError(f"Expected one loop-peeling statistics row: {peeling}")
    metrics.update(peeling_time_ms=float(peeling[0][0]),
                   peeling_zone_bytes=int(peeling[0][1]))
    targets = {"normal": [], "osr": []}
    completed_turbofan = 0
    for line in output.splitlines():
        if "completed compiling" not in line or "(target TURBOFAN_JS)" not in line:
            continue
        completed_turbofan += 1
        if "<JSFunction doOneIterationJS " not in line:
            continue
        times = re.search(r"- took ([0-9.]+), ([0-9.]+), ([0-9.]+) ms", line)
        if not times:
            raise ValueError(f"Unrecognized compilation completion: {line}")
        kind = "osr" if " OSR " in line else "normal"
        targets[kind].append([float(t) for t in times.groups()])
    if not targets["normal"]:
        raise ValueError("No normal doOneIterationJS compilation was traced")
    for kind, timings in targets.items():
        metrics[f"target_{kind}_time_ms"] = sum(map(sum, timings))
    return {
        "round": run["round"], "binary": run["binary"], "warmup": run["warmup"],
        "pipeline_count": int(nvp["Turbofan_totals_count"]),
        "completed_turbofan_count": completed_turbofan,
        "target_compilations": targets, "metrics": metrics,
        "aborted_compilation_lines": [line for line in output.splitlines()
                                      if "abort" in line.lower() and "compil" in line.lower()],
    }


def percentile(values, fraction):
    position = (len(values) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(values) - 1)
    return values[lower] + (values[upper] - values[lower]) * (position - lower)


def summarize(baseline, candidate):
    result = {"baseline_median": statistics.median(baseline),
              "candidate_median": statistics.median(candidate)}
    if any(x <= 0 for x in baseline + candidate):
        result["ratio_note"] = "Ratio undefined with zero-valued observations."
        return result
    logs = [math.log(c / b) for b, c in zip(baseline, candidate)]
    rng = random.Random(20261021)
    draws = sorted(math.exp(statistics.fmean(rng.choices(logs, k=len(logs))))
                   for _ in range(10000))
    result.update(
        paired_cost_change_percent=100 * (math.exp(statistics.fmean(logs)) - 1),
        paired_bootstrap_95_percent_interval=[100 * (percentile(draws, q) - 1)
                                             for q in (.025, .975)],
        ab_cost_change_percent=100 * (math.exp(statistics.fmean(logs[::2])) - 1),
        ba_cost_change_percent=100 * (math.exp(statistics.fmean(logs[1::2])) - 1))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    raw = json.loads(args.results.read_text())
    if raw["status"] != "complete" or raw["completed_pairs"] != raw["requested_rounds"]:
        raise ValueError("Compilation-cost run must finish its declared pairs")
    for flag in ("--no-concurrent-recompilation", "--turbo-stats",
                 "--turbo-stats-nvp", "--trace-opt"):
        if flag not in raw["d8_args"]:
            raise ValueError(f"Missing diagnostic flag: {flag}")
    runs = [parse_run(run) for run in raw["runs"]]
    measured = {(r["round"], r["binary"]): r for r in runs if not r["warmup"]}
    rounds = range(1, raw["completed_pairs"] + 1)
    summary = {}
    for key in runs[0]["metrics"]:
        summary[key] = summarize(
            [measured[n, "baseline"]["metrics"][key] for n in rounds],
            [measured[n, "candidate"]["metrics"][key] for n in rounds])
    output = {
        "source_results": str(args.results), "pairs": raw["completed_pairs"],
        "binaries": raw["binaries"], "runs": runs, "summary": summary,
        "interpretation": "Positive percentages mean greater compilation cost. "
                          "Zone allocations are not RSS or JavaScript allocations. "
                          "Counts and aborted attempts are retained; costs are not "
                          "normalized to assume identical compilation work. "
                          "Instrumented benchmark scores are not throughput evidence.",
        "statistics": {"bootstrap_seed": 20261021, "resamples": 10000,
                       "resampling_unit": "paired round"},
    }
    args.output.write_text(json.dumps(output, indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
