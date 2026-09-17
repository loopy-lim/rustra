#!/usr/bin/env python3
"""Attach honest provenance to the immutable exploratory receipt; no execution."""
import hashlib
import json
from pathlib import Path
import sys

from run import ROOT, DEFAULT_OUTPUT, ORDER, LIMITATIONS, canonical_sha, normalized


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_OUTPUT
    legacy = ROOT / '.superpowers/sdd/2026-09-16-nitro-parity-followup/core-dfs'
    receipt = json.loads((legacy / 'receipt.json').read_text())
    saved_rust = output / 'legacy-sources/nitro_core_dfs.rs'
    saved_binary = output / 'legacy-sources/rustra_core_dfs'
    assert sha(saved_binary) == receipt['binaries']['rustra'], 'saved original Rust binary differs'
    assert sha(legacy / 'nitro_core_dfs') == receipt['binaries']['nitro'], 'original Nitro binary differs'
    launches = []
    for pair in range(1, 6):
        for framework in (['rustra', 'nitro'] if pair % 2 else ['nitro', 'rustra']):
            extension = 'json' if framework == 'rustra' else 'txt'
            path = legacy / f'{framework}-{pair}.jsonl'
            rows = [json.loads(line) for line in path.read_text().splitlines()]
            assert len(rows) == 5
            for fixture, row in zip(ORDER, rows[1:]):
                assert Path(row['fixture']).stem == fixture
                assert len(row['samplesNs']) == 31 and row['warmup'] == 3 and row['batch'] == 16
                count = row['nodes']
                assert row['checksum'] == 34 * 16 * (2 * count + len(f'node-{count-1}'))
            launches.append({'pair': pair, 'framework': framework, 'argv': [str(ROOT / 'target/release/examples/nitro_core_dfs') if framework == 'rustra' else str(legacy / 'nitro_core_dfs'), *[str(legacy / f'{name}.{extension}') for name in ORDER]], 'raw': {'path': str(path), 'sha256': sha(path)}, 'exitCode': 0, 'exitCodeEvidence': 'successful execution reported by parent; original command event log is not in this directory'})
    files = [path for path in legacy.iterdir() if path.is_file()]
    files += [saved_rust, saved_binary, ROOT / 'examples/calculator/src/parity_bench.rs', ROOT / 'Cargo.toml', ROOT / 'Cargo.lock']
    supplement = {
        'protocol': 'rustra-nitro-host-core-dfs-legacy-supplement/v1',
        'originalReceipt': {'path': str(legacy / 'receipt.json'), 'sha256': sha(legacy / 'receipt.json')},
        'originalReceiptUnmodified': True,
        'originalBinaryHashesVerified': True,
        'recordedSourceCaptureCaveat': 'The Rust driver was saved immediately before its diagnostic-only edit. Current Rust DFS, Cargo manifests, and lockfile are capture-time hashes, not a contemporaneous complete build freeze. Historical source/binary correspondence cannot be fully reconstructed from this record.',
        'parentReportedBuildCommands': [
            {'cwd': str(ROOT), 'argv': ['cargo', 'build', '--release', '--locked', '-p', 'rustra-calculator-example', '--example', 'nitro_core_dfs', '-j2']},
            {'cwd': str(legacy), 'argv': ['clang++', '-std=c++20', '-O3', '-DNDEBUG', '-fno-lto', '-c', 'core.cpp', '-o', 'core.o']},
            {'cwd': str(legacy), 'argv': ['clang++', '-std=c++20', '-O3', '-DNDEBUG', '-fno-lto', 'driver.cpp', 'core.o', '-o', 'nitro_core_dfs']},
        ],
        'buildEvidence': 'commands and alternating process order supplied by parent execution history, not independently recovered from compiler logs',
        'rustCompiler': receipt['rustc'], 'cppCompiler': receipt['clang'],
        'buildOptions': {'rustOptLevel': 'Cargo release default 3; no release override in captured Cargo.toml', 'rustCodegenUnits': 'default 16; not directly recorded at original build', 'rustLto': 'Cargo false default permits local thin LTO; not matched to explicit C++ -fno-lto', 'rustPanic': 'default unwind; no original verbose invocation retained', 'rustFlags': 'original reviewer observed fingerprint rustflags=[]', 'cppOptLevel': '-O3', 'cppLto': '-fno-lto at compile and link', 'cppExceptions': 'compiler default enabled', 'targetCpuFeatures': 'not explicitly selected by reported commands; historical implicit CPU/features/environment not captured', 'environmentOverrides': 'not contemporaneously captured; do not infer full environment equality'},
        'capacityFieldCorrection': {'nodeCapacity': 'inputNodeCapacity', 'childCapacitySum': 'inputChildCapacitySum', 'appliesTo': 'original rows remain unchanged; interpret their values as first loader input observations, not final resident capacities'},
        'fixtureOrder': ORDER, 'launches': launches,
        'aggregationFormula': 'mean of 31 samples per launch; ratio = mean of five Rust launch means / mean of five C++ launch means',
        'acceptanceRule': None,
        'files': [{'path': str(path), 'sha256': sha(path)} for path in sorted(files)],
        'fixtureCanonicalHashes': {name: canonical_sha(normalized(json.loads((legacy / f'{name}.json').read_text()))) for name in ORDER},
        'limitations': LIMITATIONS + ['Legacy ratios are unchanged descriptive estimates. New non-timed observations do not retrospectively authenticate capacities or heap addresses of the old timing processes.'],
    }
    (output / 'legacy-supplement.json').write_text(json.dumps(supplement, indent=2) + '\n')
    print('legacy supplement: validated 10 raw files and preserved original binary hashes')


if __name__ == '__main__':
    main()
