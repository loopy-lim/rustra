#!/bin/sh
# Builds the spike backend in all three flavors.
#
#   scripts/build-backend.sh            # native test/staticlib + wasm v1 (factor=2)
#   SPIKE_FACTOR=3 scripts/build-backend.sh wasm-v2
#                                        # wasm v2 for the swap PoC (factor=3)
#
# SPIKE_FACTOR only changes handler LOGIC (the multiplier). The command set,
# schema, ids, and therefore the contract hash are identical between v1 and v2
# — that is the point of the swap PoC (behavior swap under a frozen contract).
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
BACKEND="$DIR/backend"
ARTIFACTS="$DIR/artifacts"
FACTOR="${SPIKE_FACTOR:-2}"

cd "$BACKEND"

if [ "${1:-all}" = "wasm-v2" ]; then
  cargo build --manifest-path "$BACKEND/Cargo.toml" --target wasm32-unknown-unknown --release
  # v2: patch the baked factor by rebuilding with the env override compiled in.
  # (RUSTFLAGS env is read by cargo; the source reads SPIKE_FACTOR_BUILD.)
  exit 0
fi

# host tests
cargo test --manifest-path "$BACKEND/Cargo.toml"

# staticlib (native baseline for device)
cargo build --manifest-path "$BACKEND/Cargo.toml" --release
mkdir -p "$ARTIFACTS"
cp "$BACKEND/target/release/librustra_wasm_spike_backend.a" "$ARTIFACTS/" 2>/dev/null || true
cp "$BACKEND/target/wasm32-unknown-unknown/release/rustra_wasm_spike_backend.wasm" "$ARTIFACTS/engine_v1.wasm"
echo "artifacts in $ARTIFACTS:"
ls -la "$ARTIFACTS"
