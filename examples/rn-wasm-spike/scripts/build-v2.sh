#!/bin/sh
# Builds the v2 (swap PoC) wasm engine: same contract, factor=3 behavior.
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "$DIR/backend"
cargo build --release --target wasm32-unknown-unknown --features factor3
cp target/wasm32-unknown-unknown/release/rustra_wasm_spike_backend.wasm \
   "$DIR/artifacts/engine_v2.wasm"
# v1 comes from the default build (SPIKE_FACTOR unset => 2)
echo "engine_v2.wasm written (factor=3). contract hash must equal v1's."
