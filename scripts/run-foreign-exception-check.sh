#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixture="$repo_root/scripts/safety/foreign-exception"
probe_target=${RUSTRA_FOREIGN_PROBE_TARGET_DIR:-"$repo_root/target/safety/foreign-exception"}
case "$probe_target" in /*) ;; *) echo 'probe target must be absolute' >&2; exit 2;; esac
case "$(uname -s)" in
  Darwin|Linux) ;;
  *) echo 'foreign exception harness supports macOS/Linux; target not verified' >&2; exit 2;;
esac
mkdir -p "$probe_target"
cargo build --locked --manifest-path "$fixture/Cargo.toml" --target-dir "$probe_target"
"${CXX:-c++}" -std=c++17 -Wall -Wextra -Werror "$fixture/host.cpp" \
  -L "$probe_target/debug" -lrustra_foreign_exception_probe \
  -Wl,-rpath,"$probe_target/debug" -o "$probe_target/foreign-exception-host"
python3 - "$probe_target/foreign-exception-host" <<'PY'
import resource
import signal
import subprocess
import sys
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
for mode in ('recover', 'abort'):
    result = subprocess.run([sys.argv[1], mode], capture_output=True, text=True, timeout=30)
    print(result.stdout, end='')
    print(result.stderr, end='', file=sys.stderr)
    expected = 0 if mode == 'recover' else -signal.SIGABRT
    assert result.returncode == expected, (mode, result.returncode, expected)
    assert 'caught C++ exception in host callback' in result.stderr
    if mode == 'abort':
        assert 'host explicitly aborting' in result.stderr
    print(f'foreign exception {mode}: PASS (exit {result.returncode})')
PY
