"""Extract unchanged production slices and authenticate observation-only edits."""
from pathlib import Path
import difflib
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = Path(__file__).resolve().parent
NATIVE = ROOT / 'examples/react-native-calculator/modules/nitro-bench/nitro-bench'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def extract(output):
    parts, proof = [], {}
    for name in ['ParityNode', 'ParityTree', 'ParityFindInput', 'ParityQuery', 'ParitySearch', 'ParityStored']:
        path = NATIVE / f'nitrogen/generated/shared/c++/{name}.hpp'
        source = path.read_text()
        start = source.index('  struct ' + name + ' final')
        piece = source[start:source.index('\n  };', start) + 6]
        parts.append(piece)
        proof[name] = {'source': str(path.relative_to(ROOT)), 'sourceSha256': sha(path.read_bytes()), 'sliceSha256': sha(piece.encode())}
    header = '''#pragma once
#include <string>
#include <vector>
#include <optional>
#include <unordered_map>
#include <mutex>
#include <ostream>
#define SWIFT_PRIVATE
namespace margelo::nitro::nitrobench {
''' + '\n'.join(parts) + '''
class HybridNitroBench {
public:
  ParityTree parityEcho(const ParityTree&);
  ParitySearch parityFind(const ParityFindInput&);
  ParityStored parityStore(const ParityTree&);
  ParitySearch parityResident(const ParityQuery&);
  ParitySearch parityIndexed(const ParityQuery&);
  void diagnosticInspect(std::ostream&, double);
private:
  std::mutex mutex_;
  std::optional<ParityTree> resident_;
  std::vector<std::optional<size_t>> index_;
};
}
'''
    path = NATIVE / 'ios/HybridNitroBench.cpp'
    source = path.read_text()
    body = source[source.index('namespace {\nParitySearch missing'):source.rindex('} // namespace margelo')]
    proof['methods'] = {'source': str(path.relative_to(ROOT)), 'sourceSha256': sha(path.read_bytes()), 'sliceSha256': sha(body.encode())}
    start = body.index('ParitySearch search(')
    search = body[start:body.index('\n}\n}', start) + 2]
    probe = search.replace('ParitySearch search(const ParityTree& tree, double id)', 'ParitySearch search_probe(const ParityTree& tree, double id, StackTrace& trace)')
    probe = probe.replace('  size_t visited = 0;', '  trace.observe(stack); // DIAGNOSTIC_OBSERVE\n  size_t visited = 0;')
    push = 'stack.push_back(static_cast<size_t>(*child));'
    probe = probe.replace(push, '{ ' + push + ' trace.observe(stack); /* DIAGNOSTIC_OBSERVE */ }')
    restored = probe.replace('search_probe(const ParityTree& tree, double id, StackTrace& trace)', 'search(const ParityTree& tree, double id)')
    restored = restored.replace('  trace.observe(stack); // DIAGNOSTIC_OBSERVE\n', '')
    restored = restored.replace('{ ' + push + ' trace.observe(stack); /* DIAGNOSTIC_OBSERVE */ }', push)
    assert restored == search, 'C++ instrumentation exceeds whitelist'
    extension = (SCRIPTS / 'observations.inc').read_text().replace('// GENERATED_STACK_PROBE', probe)
    cpp = '#include "core.hpp"\n#include <cmath>\n#include <algorithm>\n#include <iomanip>\n#include <map>\n#include <stdexcept>\nnamespace margelo::nitro::nitrobench {\n' + body + extension + '\n}\n'
    (output / 'core.hpp').write_text(header)
    (output / 'core.cpp').write_text(cpp)
    (output / 'driver.cpp').write_bytes((SCRIPTS / 'driver.cpp').read_bytes())
    rust_source = (ROOT / 'examples/calculator/src/parity_bench.rs').read_text()
    a = rust_source.index('fn search(')
    rust_search = rust_source[a:rust_source.index('\n#[command]', a)]
    rust_driver = (ROOT / 'examples/calculator/examples/nitro_core_dfs.rs').read_text()
    a = rust_driver.index('fn search_probe(')
    rust_probe = rust_driver[a:rust_driver.index('\nfn input_capacities', a)].rstrip()
    rust_restored = '\n'.join(line for line in rust_probe.splitlines() if '// DIAGNOSTIC_OBSERVE' not in line)
    rust_restored = rust_restored.replace('fn search_probe(tree: &ParityTree, id: f64, trace: &mut StackTrace)', 'fn search(tree: &ParityTree, id: f64)')
    assert rust_restored == rust_search.rstrip(), 'Rust instrumentation exceeds whitelist'
    a = rust_source.index('fn missing(')
    assert rust_source[a:rust_source.index('\nfn search(', a)] in rust_driver, 'Rust missing helper changed'
    proof['instrumentation'] = {
        'rustSearchSha256': sha(rust_search.encode()), 'rustProbeSha256': sha(rust_probe.encode()),
        'cppSearchSha256': sha(search.encode()), 'cppProbeSha256': sha(probe.encode()),
        'whitelist': ['rename search and add mutable trace parameter', 'observe after unchanged stack initialization', 'observe after exact unchanged child push expression', 'C++ adds braces solely to place observer inside the original one-line child loop'],
        'restoredBodiesByteIdentical': True,
        'rustProbeScope': 'final restored input before move, outside resident lock; separate --inspect mode',
        'cppProbeScope': 'actual final resident under original mutex; separate --inspect mode',
        'observerEffect': 'trace vector allocation and observation branches are present only in non-timed copied probes; no trace call is inserted in either timed production search body',
    }
    diff = ''.join(difflib.unified_diff(rust_search.splitlines(True), (rust_probe + '\n').splitlines(True), fromfile='Rust production search', tofile='Rust non-timed probe'))
    diff += ''.join(difflib.unified_diff(search.splitlines(True), probe.splitlines(True), fromfile='C++ production search', tofile='C++ non-timed probe'))
    (output / 'instrumentation.diff').write_text(diff)
    order = json.loads((output / 'fixture-order.json').read_text())
    assert order == ['balanced255', 'balanced1023', 'balanced8191', 'wide1025']
    for name in order:
        fixture = output / f'{name}.json'
        tree = json.loads(fixture.read_text())
        lines = [str(len(tree['nodes']))]
        quote = lambda value: json.dumps(value, ensure_ascii=False)
        for node in tree['nodes']:
            pieces = [str(node['id']), quote(node['name']), quote(node['tag']), '1' if node.get('note') is not None else '0', quote(node.get('note') or ''), str(len(node['metadata']))]
            for key, value in node['metadata'].items():
                pieces.extend([quote(key), quote(value)])
            pieces.extend([str(len(node['children'])), *map(str, node['children'])])
            lines.append(' '.join(pieces))
        fixture.with_suffix('.txt').write_text('\n'.join(lines) + '\n')
        proof[name] = {'jsonSha256': sha(fixture.read_bytes()), 'textSha256': sha(fixture.with_suffix('.txt').read_bytes())}
    for name in ['core.hpp', 'core.cpp', 'driver.cpp', 'instrumentation.diff']:
        proof[name] = {'completeFileSha256': sha((output / name).read_bytes())}
    (output / 'source-correspondence.json').write_text(json.dumps(proof, indent=2) + '\n')


if __name__ == '__main__':
    extract(Path(sys.argv[1]).resolve())
