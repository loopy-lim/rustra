#!/usr/bin/env bash
# A reproducible local counterpart to sanitizer.yml and the large fuzz job.
# Requires Linux, nightly Rust, C/C++ compiler, Python 3 and cargo-fuzz.
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"
export RUSTUP_TOOLCHAIN=nightly
export SAFETY_LOG_DIR=${SAFETY_LOG_DIR:-"$repo_root/target/safety/linux-validation"}
target=$(rustc -vV | sed -n 's/^host: //p')
case "$target" in *-unknown-linux-gnu) ;; *) echo 'Linux GNU target required' >&2; exit 2;; esac
mkdir -p "$SAFETY_LOG_DIR"
{ git rev-parse HEAD; rustc -Vv; cargo fuzz --version; } > "$SAFETY_LOG_DIR/environment.txt"

export RUSTFLAGS=-Zsanitizer=address
export ASAN_OPTIONS="detect_leaks=1:detect_stack_use_after_return=1:log_path=$SAFETY_LOG_DIR/asan"
export RUST_TEST_THREADS=1
bash scripts/run-safety-check.sh lib cargo test -p rustra --lib --target "$target"
for profile in debug release; do
  profile_args=()
  if [[ "$profile" == release ]]; then profile_args+=(--release); fi
  bash scripts/run-safety-check.sh "ffi-$profile" cargo test -p rustra \
    "${profile_args[@]}" --target "$target" --test trust_baseline_ffi \
    --test payload_robustness --test ffi_process_contract --test large_payload_boundary --test ffi_scriptc
done
unset RUSTFLAGS ASAN_OPTIONS
bash scripts/run-safety-check.sh foreign-exception bash scripts/run-foreign-exception-check.sh
python3 scripts/safety/generate-large-fuzz-seeds.py fuzz/corpus/invoke_large_boundary
cd fuzz
bash ../scripts/run-safety-check.sh large-seeds cargo fuzz run invoke_large_boundary \
  corpus/invoke_large_boundary -- -runs=0 -max_len=1048577 -rss_limit_mb=2048 -timeout=10
bash ../scripts/run-safety-check.sh large-campaign cargo fuzz run invoke_large_boundary \
  corpus/invoke_large_boundary -- -max_total_time=600 -max_len=1048577 -rss_limit_mb=2048 -timeout=10
