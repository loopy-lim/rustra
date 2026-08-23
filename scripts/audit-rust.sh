#!/usr/bin/env bash
set -euo pipefail

# Tauri 2.11.x still ships GTK3 bindings on Linux and its current tauri-utils
# release still uses the rust-unic identifier crates. These advisories have no
# patched Tauri 2 dependency path yet. Keep the exception set exact so every new
# advisory, including informational and soundness warnings, fails this gate.
tauri_upstream_advisories=(
  RUSTSEC-2024-0370 # proc-macro-error via glib/gtk macros
  RUSTSEC-2024-0411 # gdkwayland-sys
  RUSTSEC-2024-0412 # gdk
  RUSTSEC-2024-0413 # atk
  RUSTSEC-2024-0414 # gdkx11-sys
  RUSTSEC-2024-0415 # gtk
  RUSTSEC-2024-0416 # atk-sys
  RUSTSEC-2024-0417 # gdkx11
  RUSTSEC-2024-0418 # gdk-sys
  RUSTSEC-2024-0419 # gtk3-macros
  RUSTSEC-2024-0420 # gtk-sys
  RUSTSEC-2024-0429 # glib VariantStrIter soundness, fixed only in GTK4-era glib
  RUSTSEC-2025-0075 # unic-char-range via tauri-utils
  RUSTSEC-2025-0080 # unic-common via tauri-utils
  RUSTSEC-2025-0081 # unic-char-property via tauri-utils
  RUSTSEC-2025-0098 # unic-ucd-version via tauri-utils
  RUSTSEC-2025-0100 # unic-ucd-ident via tauri-utils
)

audit_args=(--quiet --deny warnings)
for advisory in "${tauri_upstream_advisories[@]}"; do
  audit_args+=(--ignore "$advisory")
done

cargo audit --file Cargo.lock "${audit_args[@]}"
cargo audit --file fuzz/Cargo.lock --quiet --deny warnings

echo "Rust dependency audit clean: no actionable warnings or vulnerabilities"
