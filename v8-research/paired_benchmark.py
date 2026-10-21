#!/usr/bin/env python3
"""Run unchanged d8 benchmark suites in alternating, CPU-pinned pairs."""

import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import re
import shutil
import statistics
import subprocess
import sys
import time


SCORE = re.compile(r"^(.*?)\(Score\):\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*$")
SEED = 20261021
BOOTSTRAPS = 10000


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha256(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def read_optional(path):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return None


def source_hashes(cwd, args):
    paths = set(cwd.rglob("*.js"))
    paths.update(p for p in (cwd / "run.js", cwd.parent / "base.js") if p.is_file())
    paths.update(cwd / arg for arg in args if arg.endswith(".js") and (cwd / arg).is_file())
    return {os.path.relpath(p, cwd): sha256(p) for p in sorted(paths)}


def parse_scores(stdout):
    scores = {}
    for line in stdout.splitlines():
        match = SCORE.fullmatch(line)
        if not match:
            if "(Score):" in line:
                raise ValueError(f"Invalid score or benchmark error: {line}")
            continue
        name, value = match.group(1).strip(), float(match.group(2))
        if name in scores or not math.isfinite(value) or value <= 0:
            raise ValueError(f"Duplicate or invalid score: {line}")
        scores[name] = value
    if not scores:
        raise ValueError("No '(Score): NUMBER' results found")
    return scores


def percentile(values, fraction):
    position = (len(values) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(values) - 1)
    return values[lower] + (values[upper] - values[lower]) * (position - lower)


def summarize(pairs, keys):
    result = {}
    for key in sorted(keys):
        baseline = [pair["baseline"]["scores"][key] for pair in pairs]
        candidate = [pair["candidate"]["scores"][key] for pair in pairs]
        logs = [math.log(c / b) for b, c in zip(baseline, candidate)]
        rng = random.Random(SEED)
        draws = sorted(math.exp(statistics.fmean(rng.choices(logs, k=len(logs))))
                       for _ in range(BOOTSTRAPS))
        ratio = math.exp(statistics.fmean(logs))
        result[key] = {
            "rounds": len(pairs),
            "baseline_median_score": statistics.median(baseline),
            "candidate_median_score": statistics.median(candidate),
            "paired_geometric_mean_score_ratio": ratio,
            "score_change_percent": 100 * (ratio - 1),
            "candidate_wins": sum(c > b for b, c in zip(baseline, candidate)),
            "ties": sum(c == b for b, c in zip(baseline, candidate)),
            "paired_bootstrap_95_percent_ci": [percentile(draws, .025), percentile(draws, .975)],
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--cwd", type=Path, required=True)
    parser.add_argument("--rounds", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cpu", type=int, default=2)
    parser.add_argument("--expected-score", action="append",
                        help="Require this exact score name; repeat for each suite result")
    parser.add_argument("d8_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.rounds < 1 or args.cpu < 0:
        parser.error("--rounds must be positive and --cpu nonnegative")
    d8_args = args.d8_args[1:] if args.d8_args[:1] == ["--"] else args.d8_args
    d8_args = d8_args or ["run.js"]
    cwd, output = args.cwd.resolve(), args.output.resolve()
    binaries = {name: getattr(args, name).resolve() for name in ("baseline", "candidate")}
    taskset = shutil.which("taskset")
    if not taskset:
        parser.error("taskset is required for CPU pinning")
    cpuinfo = read_optional("/proc/cpuinfo") or ""
    model = next((line.split(":", 1)[1].strip() for line in cpuinfo.splitlines()
                  if line.startswith("model name")), None)
    data = {
        "schema_version": 1, "status": "running", "started_at": timestamp(),
        "cwd": str(cwd), "d8_args": d8_args, "requested_rounds": args.rounds,
        "cpu": args.cpu, "higher_is_better": True,
        "machine": {"hostname": platform.node(), "platform": platform.platform(),
                    "uname": list(platform.uname()), "cpu_model": model,
                    "logical_cpus": os.cpu_count(), "python": sys.version,
                    "runner_affinity": sorted(os.sched_getaffinity(0)),
                    "governor": read_optional(f"/sys/devices/system/cpu/cpu{args.cpu}/cpufreq/scaling_governor")},
        "binaries": {}, "runs": [],
        "statistics": {"ratio": "candidate / baseline", "bootstrap_seed": SEED,
                       "bootstrap_resamples": BOOTSTRAPS, "resampling_unit": "paired round"},
        "expected_scores": sorted(set(args.expected_score)) if args.expected_score else None,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    pairs = []
    keys = set(args.expected_score) if args.expected_score else None

    def save():
        output.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n")

    def run(name, round_number, warmup=False):
        nonlocal keys
        before = source_hashes(cwd, d8_args)
        if before != data["source_sha256"]:
            raise RuntimeError("Benchmark sources changed before a run")
        command = [taskset, "-c", str(args.cpu), str(binaries[name]), *d8_args]
        record = {"binary": name, "round": round_number, "warmup": warmup,
                  "command": command, "cwd": str(cwd), "started_at": timestamp()}
        data["runs"].append(record)
        begin = time.monotonic()
        process = subprocess.run(command, cwd=cwd, capture_output=True, text=True,
                                 encoding="utf-8", errors="replace", check=False)
        record.update({"ended_at": timestamp(), "wall_seconds": time.monotonic() - begin,
                       "returncode": process.returncode, "stdout": process.stdout,
                       "stderr": process.stderr})
        record["sources_unchanged"] = source_hashes(cwd, d8_args) == before
        save()
        if process.returncode != 0:
            raise RuntimeError(f"{name} exited with status {process.returncode}")
        if not record["sources_unchanged"]:
            raise RuntimeError("Benchmark sources changed during a run")
        record["scores"] = parse_scores(process.stdout)
        observed = set(record["scores"])
        if keys is None:
            keys = observed
        elif observed != keys:
            raise RuntimeError(f"Score keys differ: missing={sorted(keys - observed)}, extra={sorted(observed - keys)}")
        save()
        return record

    try:
        data["source_sha256"] = source_hashes(cwd, d8_args)
        data["binaries"] = {name: {"path": str(path), "sha256": sha256(path),
                                   "size_bytes": path.stat().st_size}
                            for name, path in binaries.items()}
        save()
        for name in binaries:
            run(name, 0, warmup=True)
        for number in range(1, args.rounds + 1):
            order = ("baseline", "candidate") if number % 2 else ("candidate", "baseline")
            pair = {name: run(name, number) for name in order}
            pairs.append(pair)
            ratio = math.exp(statistics.fmean(math.log(pair["candidate"]["scores"][key] /
                                                        pair["baseline"]["scores"][key]) for key in keys))
            print(f"Pair {number}/{args.rounds} ({'/'.join(order)}): score ratio {ratio:.5f}", flush=True)
        data["summary"] = summarize(pairs, keys)
        data["binary_sha256_after"] = {name: sha256(path) for name, path in binaries.items()}
        if any(data["binary_sha256_after"][name] != data["binaries"][name]["sha256"] for name in binaries):
            raise RuntimeError("A benchmark binary changed during the experiment")
        data["status"] = "complete"
    except (Exception, KeyboardInterrupt) as error:
        data["status"] = "failed"
        data["error"] = f"{type(error).__name__}: {error}"
        print(data["error"], file=sys.stderr)
    finally:
        data["completed_pairs"] = len(pairs)
        data["ended_at"] = timestamp()
        data["wall_seconds"] = time.monotonic() - started
        save()
    return 0 if data["status"] == "complete" else 1


if __name__ == "__main__":
    sys.exit(main())
