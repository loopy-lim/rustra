#!/usr/bin/env python3
"""Alternate independent Criterion processes and keep raw estimates/provenance.

Build both binaries with the same bench profile and harness before invoking this
script. Allocation binaries use the same fixtures with a counting allocator;
they are intentionally separate from timed Criterion processes.
"""

import argparse
import hashlib
import json
import os
import platform
import statistics
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def command(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def identity(root, binary, allocator, suite="complex"):
    source = {
        str(path.relative_to(root)): digest(path)
        for path in sorted((root / "crates/rustra/src").rglob("*.rs"))
    }
    harness = [
        "crates/rustra/benches/complex_route.rs",
        "crates/rustra/benches/support/complex_cases.rs",
        "crates/rustra/benches/common.rs",
        "crates/rustra/examples/codec_allocations.rs",
    ]
    if suite == "tree":
        harness = ["crates/rustra/benches/tree_route.rs",
                   "crates/rustra/benches/common.rs",
                   "crates/rustra/examples/tree_allocations.rs"]
        harness += [str(path.relative_to(root)) for path in
                    sorted((root / "crates/rustra/benches/support").glob("tree_*.rs"))]
    return {
        "headSha": command("git", "rev-parse", "HEAD", cwd=root),
        "runtimeSourceHashes": source,
        "manifestHashes": {name: digest(root / name) for name in
                           ["Cargo.toml", "Cargo.lock", "crates/rustra/Cargo.toml",
                            "crates/rustra-macros/Cargo.toml", "crates/rustra-naming/Cargo.toml"]},
        "harnessHashes": {name: digest(root / name) for name in harness},
        "benchmarkBinarySha256": digest(binary),
        "allocationBinarySha256": digest(allocator),
        "dirty": bool(command("git", "status", "--porcelain", cwd=root)),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for variant in ("baseline", "candidate"):
        for item in ("root", "binary", "allocator"):
            parser.add_argument(f"--{variant}-{item}", type=Path, required=True)
    parser.add_argument("--suite", choices=("complex", "tree"), default="complex")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--warmup", type=float, default=0.5)
    parser.add_argument("--measurement", type=float, default=2)
    args = parser.parse_args()
    if args.runs < 5 or args.warmup <= 0 or args.measurement <= 0:
        parser.error("need at least five processes per variant and positive durations")
    args.artifacts.mkdir(parents=True, exist_ok=False)
    variants = {}
    for variant in ("baseline", "candidate"):
        paths = [getattr(args, f"{variant}_{item}").resolve()
                 for item in ("root", "binary", "allocator")]
        variants[variant] = {"paths": paths, "identity": identity(*paths, args.suite), "runs": []}
    if variants["baseline"]["identity"]["harnessHashes"] != variants["candidate"]["identity"]["harnessHashes"]:
        raise RuntimeError("baseline and candidate harnesses differ")
    # Preserve provenance even if an exploratory run is interrupted or fails.
    (args.artifacts / "inputs.json").write_text(json.dumps(
        {key: value["identity"] for key, value in variants.items()}, indent=2) + "\n")

    for index in range(args.runs):
        # AB / BA alternation reduces always-first/always-later ordering bias.
        order = ("baseline", "candidate") if index % 2 == 0 else ("candidate", "baseline")
        for variant in order:
            item = variants[variant]
            root, binary, allocator = item["paths"]
            output = (args.artifacts / f"{index + 1}-{variant}").resolve()
            output.mkdir()
            started = datetime.now(timezone.utc).isoformat()
            invocation = [str(binary), "--bench", "--noplot", "--warm-up-time", str(args.warmup),
                          "--measurement-time", str(args.measurement)]
            with (output / "criterion.log").open("w") as log:
                subprocess.run(invocation, cwd=root, env={**os.environ, "CRITERION_HOME": str(output)},
                               stdout=log, stderr=subprocess.STDOUT, check=True)
            estimates = {}
            group = output / f"{args.suite}_route"
            for path in sorted(group.glob("**/new/estimates.json")):
                key = path.parent.parent.relative_to(group).as_posix()
                if args.suite == "complex":
                    key = key.removeprefix("invoke_frame/")
                estimates[key] = json.loads(path.read_text())
            if not estimates:
                raise RuntimeError(f"no estimates from {variant} run {index + 1}")
            allocations = json.loads(command(str(allocator), cwd=root))
            if {row["case"] for row in allocations} != estimates.keys():
                raise RuntimeError("allocation/latency cases differ")
            item["runs"].append({"startedAt": started, "estimates": estimates, "allocations": allocations})
            print(f"{index + 1}/{args.runs} {variant}: {len(estimates)} cases", flush=True)

    names = set(variants["baseline"]["runs"][0]["estimates"])
    for item in variants.values():
        if identity(*item["paths"], args.suite) != item["identity"]:
            raise RuntimeError("source or binary changed during measurement")
        if any(set(run["estimates"]) != names for run in item["runs"]):
            raise RuntimeError("cases changed between runs")
    results = []
    for name in sorted(names):
        row = {"case": name}
        for variant, item in variants.items():
            medians = [run["estimates"][name]["median"]["point_estimate"] for run in item["runs"]]
            row[f"{variant}RunMediansNs"] = medians
            row[f"{variant}MedianNs"] = statistics.median(medians)
            allocations = [next(x for x in run["allocations"] if x["case"] == name) for run in item["runs"]]
            row[f"{variant}AllocationsPerCall"] = statistics.median(x["allocationCalls"] / x["iterations"] for x in allocations)
            row[f"{variant}RequestedBytesPerCall"] = statistics.median(x["requestedBytes"] / x["iterations"] for x in allocations)
            for field in ("requestBytes", "responseBytes", "nodeCount", "depth", "maxFanout"):
                if field not in allocations[0]:
                    continue
                value = allocations[0][field]
                if any(x[field] != value for x in allocations) or row.get(field, value) != value:
                    raise RuntimeError(f"fixture metadata changed: {name} {field}")
                row[field] = value
        ratio = row["candidateMedianNs"] / row["baselineMedianNs"]
        row["changePercent"] = (ratio - 1) * 100
        row["withinTenPercentRegressionBudget"] = ratio <= 1.10
        results.append(row)
    receipt = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "purpose": f"0.10.1 to 0.10.2 {args.suite} performance at Package.invoke_frame",
        "runnerSha256": digest(Path(__file__)),
        "environment": {"platform": platform.platform(), "machine": platform.machine(),
                        "rustc": command("rustc", "-Vv"), "cargo": command("cargo", "-V"),
                        "cpuCount": os.cpu_count(), "rustflags": os.environ.get("RUSTFLAGS", ""),
                        "profile": "bench/release optimized", "criterion": "0.8.2"},
        "method": {"processesPerVariant": args.runs, "order": "alternating AB/BA, starting with AB",
                   "warmupSeconds": args.warmup, "measurementSeconds": args.measurement,
                   "samplesPerCase": 100 if args.suite == "tree" else 500, "statistic": "median of per-process Criterion median estimates",
                   "p95Reported": False, "excludedRuns": [],
                   "allocationWarmupCalls": 20 if args.suite == "tree" else 100,
                   "allocationMeasuredCallsPerCasePerProcess": 100 if args.suite == "tree" else 1000},
        "variants": {key: {"identity": value["identity"], "runs": value["runs"]}
                     for key, value in variants.items()},
        "results": results,
        "limits": ["Core runtime, not JS transport or real-app/device latency.",
                   "Requested allocation bytes count alloc/alloc_zeroed/realloc sizes; not RSS, live bytes, or peak memory.",
                   "Original complex near-1MiB case uses 16 string chunks to preserve limits; tree cases use default limits.",
                   "Tree dfs cases borrow an existing tree; they exclude codec, construction and destruction.",
                   "Tree resident queries include invocation but exclude one-time tree storage; ordinary search retransmits the full tree.",
                   "Host processes are not under exclusive machine control; alternating repeated controls detect large drift."],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n")
    for row in results:
        print(f'{row["case"]}: {row["baselineMedianNs"]:.2f} -> {row["candidateMedianNs"]:.2f} ns ({row["changePercent"]:+.2f}%)')
    if any(not row["withinTenPercentRegressionBudget"] for row in results):
        raise SystemExit("10% regression budget exceeded; inspect receipt before accepting candidate")
    if any(row["changePercent"] > -20 for row in results if row["case"].startswith("recursive_depth_")):
        raise SystemExit("recursive improvement target not met")


if __name__ == "__main__":
    main()
