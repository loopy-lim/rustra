#!/usr/bin/env python3
"""One focused host diagnostic. Preparation/inspection never invokes timing."""
import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = Path(__file__).resolve().parent
DEFAULT_OUTPUT = ROOT / '.superpowers/sdd/2026-09-16-nitro-parity-followup/core-dfs-next'
ORDER = ['balanced255', 'balanced1023', 'balanced8191', 'wide1025']
PROTOCOL = 'rustra-nitro-host-core-dfs-diagnostic/v2'
LIMITATIONS = [
    'Host macOS arm64 only; neither iOS Simulator nor Android/device ABI or public-call parity evidence.',
    'Rust LLVM 22 and Apple clang 17 are different compiler implementations. O3/release and one host do not establish matched compiler/target/allocator settings; actual versions/options are recorded.',
    'Original host-only loaders retained. C++ does not reserve metadata, bypasses generated ParityTree(vector) copy constructor, and passes lvalues to generated node constructors. This does not reproduce Nitro JSIConverter allocator history.',
    'Rust JSON decode followed by postcard round-trip creates extra temporary allocations absent from native dispatch. Its final input capacities are inferred resident capacities solely because parity_store moves the same owned tree without transforming its fields.',
    'C++ final resident observation includes repeated optional copy assignment across the ordered fixtures, including balanced8191 then wide1025. Resident is never reconstructed or shrunk to force capacity equality.',
    'No JSI/FFI/conversion/setup is inside the measured interval. The C++ handwritten class shim omits Nitro/JSI inheritance and virtual surface, so this is not exact native ABI or heap-history evidence.',
    'Timing includes 16 calls, result consumption/checksum, and result destruction. Rust adds black_box on query and result; C++ consumes an externally compiled result with separate translation units and -fno-lto. Barriers differ.',
    'Rust default release LTO=false permits compiler-local thin LTO with default multiple codegen units; C++ explicitly disables LTO. Neither driver uses explicit target-cpu/features overrides unless captured in the environment/compiler invocation.',
    'The non-timed probes preserve exact original initialization and child-push expressions; trace-vector allocations and observer branches perturb allocator activity, so they establish growth policy, not timing or cache causality.',
    'Rust probe reads final input before move outside lock; C++ probe reads final resident under mutex. These observations do not measure identical lock/setup paths.',
    'Map bucket count is meaningful for libc++ unordered_map only. Rust BTreeMap has no public bucket count; heap bytes and allocation counts remain unmeasured.',
    'Fixture loader format is restricted to printable ASCII by the TypeScript exporter. std::quoted is not a general JSON Unicode/control-escape decoder.',
    'Five launch means per framework are descriptive. Ratio is arithmetic mean(Rust launch means) / arithmetic mean(C++ launch means). No confidence interval, public-v2 acceptance threshold, statistical equality, regression, or causal layout claim is inferred.',
    'Inspection is a separate process launch from timing. Actual C++ resident capacities describe deterministic setup in inspection; allocator placement of later timing processes is not directly observed.',
]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def read(path):
    return json.loads(path.read_text())


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def command(output, name, argv, cwd=ROOT, env=None):
    # File handles keep large raw inspection trees out of the terminal and retain
    # exact success/failure outputs. No shell interpolation or complete env dump.
    log = output / 'logs'
    log.mkdir(exist_ok=True)
    stdout, stderr = log / f'{name}.stdout', log / f'{name}.stderr'
    if stdout.exists() or stderr.exists():
        raise RuntimeError(f'refusing to overwrite command output: {name}')
    started = now()
    with stdout.open('wb') as out, stderr.open('wb') as err:
        result = subprocess.run(argv, cwd=cwd, env=env, stdout=out, stderr=err)
    entry = {'id': name, 'argv': list(map(str, argv)), 'cwd': str(cwd), 'startedAt': started, 'endedAt': now(), 'exitCode': result.returncode,
             'stdout': {'path': str(stdout), 'sha256': sha(stdout)}, 'stderr': {'path': str(stderr), 'sha256': sha(stderr)}}
    with (output / 'commands.jsonl').open('a') as handle:
        handle.write(json.dumps(entry) + '\n')
    if result.returncode:
        raise RuntimeError(f'{name} failed ({result.returncode}); see {stderr}')
    return entry


def source_paths():
    # Hash repository-owned Rust dependencies, Cargo lockfile/checksums and the
    # complete native/driver inputs. No installed registry source is rewritten.
    selected = {ROOT / 'Cargo.toml', ROOT / 'Cargo.lock', ROOT / 'examples/react-native-calculator/src/nitro-parity/fixtures.ts'}
    for base in ['crates/rustra', 'crates/rustra-macros', 'crates/rustra-naming', 'examples/calculator']:
        selected.update(p for p in (ROOT / base).rglob('*.rs') if 'target' not in p.parts)
        selected.add(ROOT / base / 'Cargo.toml')
    selected.update(p for p in SCRIPTS.iterdir() if p.is_file())
    native = ROOT / 'examples/react-native-calculator/modules/nitro-bench/nitro-bench'
    selected.add(native / 'ios/HybridNitroBench.cpp')
    selected.update(native.glob('nitrogen/generated/shared/c++/Parity*.hpp'))
    for candidate in [ROOT / '.cargo/config', ROOT / '.cargo/config.toml', Path.home() / '.cargo/config', Path.home() / '.cargo/config.toml', ROOT / 'rust-toolchain', ROOT / 'rust-toolchain.toml']:
        if candidate.is_file(): selected.add(candidate)
    return sorted(selected)


def freeze(output):
    generated = [output / name for name in ['core.hpp', 'core.cpp', 'driver.cpp', 'source-correspondence.json', 'instrumentation.diff', 'fixture-order.json']]
    generated += [output / f'{fixture}.{extension}' for fixture in ORDER for extension in ['json', 'txt']]
    write(output / 'source-freeze.json', [{'path': str(path), 'sha256': sha(path)} for path in source_paths() + generated])


def check_freeze(output):
    for entry in read(output / 'source-freeze.json'):
        if sha(Path(entry['path'])) != entry['sha256']:
            raise RuntimeError(f'source/input changed after prepare: {entry["path"]}; use a new output directory')


def prepare(output):
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'source-freeze.json').exists():
        raise RuntimeError('already prepared; choose a fresh --out directory')
    command(output, 'export-fixtures', ['bun', str(SCRIPTS / 'export.ts'), str(output)])
    command(output, 'extract-core', [sys.executable, str(SCRIPTS / 'prepare.py'), str(output)])
    command(output, 'git-head', ['git', 'rev-parse', 'HEAD'])
    command(output, 'git-status', ['git', 'status', '--porcelain=v1'])
    command(output, 'git-diff', ['git', 'diff', '--binary'])
    freeze(output)
    write(output / 'identity.json', {'protocol': PROTOCOL, 'runId': output.name + '-' + now(), 'preparedAt': now(), 'root': str(ROOT), 'host': {'system': platform.system(), 'machine': platform.machine(), 'platform': platform.platform()}, 'fixtureOrder': ORDER, 'limitations': LIMITATIONS})


def environment_options():
    exact = ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_TARGET', 'CARGO_TARGET_DIR', 'CARGO_HOME', 'CC', 'CXX', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS', 'MACOSX_DEPLOYMENT_TARGET', 'SDKROOT']
    exact += sorted(k for k in os.environ if k.startswith('CARGO_PROFILE_RELEASE_'))
    return {name: os.environ.get(name) for name in exact}


def build(output):
    check_freeze(output)
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('this version is scoped to macOS arm64')
    options = environment_options()
    # Foreign overrides would make the documented default recipe ambiguous.
    for key, value in options.items():
        if value and key not in ['CARGO_HOME']:
            raise RuntimeError(f'unset build override {key} or revise this recipe and its limitations explicitly')
    for name, argv in [('rustc-version', ['rustc', '-vV']), ('cargo-version', ['cargo', '-V']), ('clang-version', ['clang++', '--version']), ('bun-version', ['bun', '--version']), ('rust-default-cfg', ['rustc', '--print', 'cfg']), ('clang-default-invocation', ['clang++', '-###', '-std=c++20', '-O3', '-DNDEBUG', '-fno-lto', '-c', 'core.cpp', '-o', 'core.o'])]:
        command(output, name, argv, cwd=output)
    write(output / 'build-options.json', {
        'inheritedAllowlistedOverrides': options, 'diagnosticOverride': {'CARGO_TERM_VERBOSE': 'true'},
        'rust': {'recipe': ['cargo', 'build', '--release', '--locked', '-p', 'rustra-calculator-example', '--example', 'nitro_core_dfs', '-j2'], 'profile': 'Cargo default release (workspace has no release override)', 'optLevel': 3, 'codegenUnits': 16, 'lto': 'Cargo false default: local thin LTO possible; no explicit cross-crate LTO', 'panic': 'unwind', 'debugAssertions': False, 'overflowChecks': False, 'target': 'rustc host aarch64-apple-darwin', 'cpuFeatures': 'compiler default; see rust-default-cfg and verbose build stderr'},
        'cpp': {'flags': ['-std=c++20', '-O3', '-DNDEBUG', '-fno-lto'], 'compileAndLink': 'separate translation units, both commands explicitly disable LTO', 'exceptions': 'enabled compiler default, active require throws on mismatch', 'targetCpuFeatures': 'compiler default; see clang-default-invocation stderr'},
        'comparisonClaim': 'same host, ordinary optimized builds; compiler backend, LTO defaults, barrier and ABI settings are not identical',
    })
    env = dict(os.environ, CARGO_TERM_VERBOSE='true')
    command(output, 'build-rust', ['cargo', 'build', '--release', '--locked', '-p', 'rustra-calculator-example', '--example', 'nitro_core_dfs', '-j2'], env=env)
    shutil.copy2(ROOT / 'target/release/examples/nitro_core_dfs', output / 'rustra_core_dfs')
    command(output, 'compile-cpp', ['clang++', '-std=c++20', '-O3', '-DNDEBUG', '-fno-lto', '-c', 'core.cpp', '-o', 'core.o'], cwd=output)
    command(output, 'link-cpp', ['clang++', '-std=c++20', '-O3', '-DNDEBUG', '-fno-lto', 'driver.cpp', 'core.o', '-o', 'nitro_core_dfs'], cwd=output)
    write(output / 'binaries.json', {name: {'path': str(output / filename), 'sha256': sha(output / filename)} for name, filename in [('rustra', 'rustra_core_dfs'), ('nitro', 'nitro_core_dfs'), ('cppObject', 'core.o')]})
    check_freeze(output)


def binaries(output):
    values = read(output / 'binaries.json')
    for entry in values.values():
        if sha(Path(entry['path'])) != entry['sha256']:
            raise RuntimeError(f'binary changed: {entry["path"]}')
    return values


def normalized(tree):
    # Missing optional notes and decoded None/null are the same schema value;
    # every other field (including all metadata and child order) compares exactly.
    result = json.loads(json.dumps(tree))
    for node in result['nodes']:
        node.setdefault('note', None)
        if isinstance(node['id'], float) and node['id'].is_integer(): node['id'] = int(node['id'])
        node['children'] = [int(value) if isinstance(value, float) and value.is_integer() else value for value in node['children']]
    return result


def canonical_sha(tree):
    return hashlib.sha256(json.dumps(tree, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def rows(output, entry, mode):
    values = [json.loads(line) for line in Path(entry['stdout']['path']).read_text().splitlines()]
    if len(values) != 5 or set(values[0]) != {'layout'}: raise RuntimeError('expected layout plus exactly four fixture rows')
    for name, row in zip(ORDER, values[1:]):
        expected = read(output / f'{name}.json')
        count = len(expected['nodes'])
        if Path(row['fixture']).stem != name or row['nodes'] != count: raise RuntimeError('fixture/order/count mismatch')
        if mode == 'time':
            samples = row['samplesNs']
            expected_checksum = 34 * 16 * ((count - 1) + count + len(f'node-{count-1}') + 1)
            if row['batch'] != 16 or row['warmup'] != 3 or len(samples) != 31 or row['checksum'] != expected_checksum: raise RuntimeError('sample shape/checksum mismatch')
            if not all(isinstance(value, (float, int)) and math.isfinite(value) and value > 0 for value in samples): raise RuntimeError('invalid timing sample')
        else:
            actual = row.get('finalResident', row.get('finalRestoredInput'))
            if normalized(actual) != normalized(expected): raise RuntimeError(f'{name} full fixture mismatch')
            capacity = row.get('residentCapacitiesObserved', row.get('residentCapacitiesInferredFromMove'))
            histogram = capacity['childCapacityDistribution']
            if sum(histogram.values()) != count or sum(int(key) * value for key, value in histogram.items()) != capacity['childCapacitySum']: raise RuntimeError('invalid resident child-capacity histogram')
            if sum(value for key, value in histogram.items() if int(key) > 0) != capacity['nonemptyChildrenWithAllocation'] + capacity['emptyChildrenWithAllocation']: raise RuntimeError('invalid allocated child counts')
            if capacity['metadataEntries'] != sum(len(node['metadata']) for node in expected['nodes']): raise RuntimeError('metadata entry count mismatch')
            trace = row['stackProbe']
            expected_hit = {'found': True, 'id': count - 1, 'name': f'node-{count-1}', 'visited': count}
            if trace['result'] != expected_hit: raise RuntimeError('stack probe result mismatch')
            stack, expected_max_live = [0], 1
            while stack:
                node = expected['nodes'][stack.pop()]
                if node['id'] == count - 1: break
                for child in reversed(node['children']):
                    stack.append(child)
                    expected_max_live = max(expected_max_live, len(stack))
            if trace['maxLive'] != expected_max_live: raise RuntimeError('stack max-live differs from fixture DFS')
            capacities = trace['capacitySequence']
            if trace['initialAllocationCount'] != 1 or trace['growthCountAfterInitial'] != len(capacities) - 1 or capacities[0] != 1 or any(a >= b for a, b in zip(capacities, capacities[1:])) or capacities[-1] < trace['maxLive']: raise RuntimeError('inconsistent stack growth record')
            # Canonical digest comes from the raw full reconstructed tree, not a
            # hand-picked field subset or merely the original JSON file bytes.
            row['canonicalFullTreeSha256'] = canonical_sha(normalized(actual))
            row.pop('finalResident', None)
            row.pop('finalRestoredInput', None)
    return values


def inspect(output):
    check_freeze(output)
    artifacts = binaries(output)
    summary = {}
    for framework, extension in [('rustra', 'json'), ('nitro', 'txt')]:
        entry = command(output, f'inspect-{framework}', [artifacts[framework]['path'], '--inspect', *[str(output / f'{name}.{extension}') for name in ORDER]])
        summary[framework] = {'raw': entry, 'rows': rows(output, entry, 'inspect')}
    for a, b in zip(summary['rustra']['rows'][1:], summary['nitro']['rows'][1:]):
        if a['canonicalFullTreeSha256'] != b['canonicalFullTreeSha256']: raise RuntimeError('cross-framework fixture digest mismatch')
    write(output / 'inspection.json', {'protocol': PROTOCOL, 'kind': 'non-timed-observation', 'fixtureOrder': ORDER, 'fullFixtureCorrespondence': 'all fields of every node matched actual TypeScript exports after absent note to null and integral float to integer normalization', 'frameworks': summary})
    receipt(output)


def timing(output):
    check_freeze(output)
    artifacts = binaries(output)
    if not (output / 'inspection.json').exists(): raise RuntimeError('run non-timed inspection first')
    launches = []
    for pair in range(1, 6):
        for framework in (['rustra', 'nitro'] if pair % 2 else ['nitro', 'rustra']):
            extension = 'json' if framework == 'rustra' else 'txt'
            entry = command(output, f'time-{pair}-{framework}', [artifacts[framework]['path'], *[str(output / f'{name}.{extension}') for name in ORDER]])
            launches.append({'pair': pair, 'framework': framework, 'raw': entry, 'rows': rows(output, entry, 'time')})
    summary = []
    for position, name in enumerate(ORDER, start=1):
        means = {framework: [statistics.mean(item['rows'][position]['samplesNs']) for item in launches if item['framework'] == framework] for framework in ['rustra', 'nitro']}
        summary.append({'fixture': name, 'launchMeansNs': means, 'ratio': statistics.mean(means['rustra']) / statistics.mean(means['nitro'])})
    write(output / 'timing.json', {'protocol': PROTOCOL, 'launches': launches, 'summary': summary, 'aggregateFormula': 'arithmetic mean of 31 batch-normalized samples per launch, then mean of five launch means per framework; ratio = Rust / C++', 'acceptanceRule': None})
    receipt(output)


def receipt(output):
    identity = read(output / 'identity.json')
    names = ['commands.jsonl', 'source-freeze.json', 'source-correspondence.json', 'instrumentation.diff', 'binaries.json', 'build-options.json', 'inspection.json', 'timing.json']
    identity['evidenceFiles'] = [{'path': str(output / name), 'sha256': sha(output / name)} for name in names if (output / name).exists()]
    identity['binaries'] = read(output / 'binaries.json')
    identity['inspection'] = read(output / 'inspection.json')
    identity['timing'] = read(output / 'timing.json') if (output / 'timing.json').exists() else None
    identity['completedAt'] = now()
    write(output / 'receipt.json', identity)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('step', choices=['prepare', 'build', 'inspect', 'time', 'all'])
    parser.add_argument('--out', type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    output = args.out.resolve()
    for step in (['prepare', 'build', 'inspect', 'time'] if args.step == 'all' else [args.step]):
        {'prepare': prepare, 'build': build, 'inspect': inspect, 'time': timing}[step](output)
        print(f'{step}: recorded in {output}')


if __name__ == '__main__':
    main()
