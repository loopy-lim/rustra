# Fixed host DFS diagnostic

This is a diagnostic-only comparison of the four current Nitro parity fixtures on
macOS arm64. It does not change native runtime/codegen sources and does not assert
public-call or device parity. The original `core-dfs/receipt.json` is immutable.

From the worktree root, with the usual Rust, Apple clang, Python and Bun installed:

```sh
python3 scripts/nitro-core-diagnostic/run.py prepare
python3 scripts/nitro-core-diagnostic/run.py build
python3 scripts/nitro-core-diagnostic/run.py inspect
```

`prepare` executes the real TypeScript `FIXTURES`/`makeTree`, extracts current C++
DTO declarations and method bodies, verifies an exact whitelist for the copied
non-timed stack probes, and freezes source/input hashes. `build` uses the reported
parent build recipes, saving both compiler version/default-target information and
actual verbose Rust compiler output. No target CPU is forced. Source hashes must
still match before each following stage. All subprocess outputs, argument arrays,
working directories, exit codes and output hashes remain under the chosen output
directory. It refuses to overwrite an existing command log.

`inspect` launches each binary once with `--inspect` and no timer. It validates all
fields of all nodes against the TypeScript exports, including optional note,
metadata and child order. Missing notes normalize to null, and integral doubles
normalize to integers for the cross-language canonical digest. Full reconstructed
trees remain in raw stdout; the receipt stores their canonical hashes and compact
capacity/stack observations. Root/last/miss/index/replacement/empty-tree correctness
checks remain active in each binary.

The C++ shim getter observes the final stored tree under the original mutex after
all three replacements. It records node capacity, child capacity histogram,
allocated empty/nonempty children and metadata bucket histogram. The same object
continues through balanced255, balanced1023, balanced8191, wide1025: no capacity is
shrunk or object recreated between shapes. The Rust final input's capacities are
explicitly **inferred resident capacities**, justified by the current store moving
the unchanged owned tree into `Resident`; there is no production Rust getter.

The Rust/C++ stack probes are copies of the exact source search body. A whitelist
allows only renaming/signature extension and an observer after initialization and
after the unchanged push expression. The one-line C++ child loop also receives
braces to contain its observer. `instrumentation.diff` records all these edits and
preparation restores and byte-compares the bodies. Observers record initial
capacity, subsequent capacity changes and maximum live entries. Probe result and
maximum stack size are checked against each fixture. Observer allocations and
branches are outside timing. The Rust probe is before the move and outside lock;
the C++ probe is under lock on the final resident. They diagnose growth policy,
not timing/cache effects.

The original host loaders are intentionally retained: C++ construction does not
reproduce Nitro converter reserve/constructor history, and Rust JSON + postcard
round-trip does not reproduce native dispatch allocation history. No equality of
resident capacity or native allocator state is assumed. The Rust probe comparison
also clones the final tree in inspection mode only; that allocation is absent from
the timing process. The handwritten C++ shim is not the original Nitro class ABI.

If the parent explicitly elects a **new** timing run after inspection:

```sh
python3 scripts/nitro-core-diagnostic/run.py time
```

That runs exactly five process pairs (R,N / N,R / R,N / N,R / R,N), each with the
four fixtures in the order above, 3 warmups, 31 rounds and batch 16. Checksums include
all 34 rounds. It averages samples per launch, then launch means per framework,
and reports Rust/C++ mean ratio. No confidence interval or acceptance rule is used.
Rust query/result `black_box` and C++ external-call consumption differ. Cargo's
default release profile is O3, 16 codegen units, panic unwind, LTO=false (local thin
LTO may occur); C++ is O3, exceptions enabled, explicitly no LTO at compile/link.
Rust LLVM 22 versus Apple clang 17 is not a matched-backend comparison. Exact actual
versions are recorded. Inspection and timing run in distinct processes, so observed
capacities do not authenticate heap addresses in the later timing processes.

`--out /absolute/new/directory` chooses a fresh run directory; default is the task
ledger's `core-dfs-next`. `all` performs all four stages including timing and should
only be used by the parent when a performance window has been reserved.

For this task's existing exploratory run, `legacy.py` creates a **supplement** only
when the original Rust driver and binary have already been saved under the next
run's `legacy-sources/`. It validates the original binary hashes, all 10 raw sample
shapes/checksums, and records parent-reported commands and process order separately
from directly hashed files. It relabels old `nodeCapacity`/`childCapacitySum` as input
observations without rewriting the old JSON. Missing historical environment and
complete contemporaneous Rust build inputs remain explicit limitations.
