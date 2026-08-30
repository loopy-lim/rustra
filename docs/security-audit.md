English | [한국어](./security-audit.ko.md)

# Security audit (cargo audit) status

Last verified: 2026-08-23 — **0 vulnerabilities / 0 actionable warnings**

## Gate policy

- `scripts/audit-rust.sh` fails not only on vulnerabilities but also on **new
  unmaintained/unsound/yanked warnings** (`cargo audit --deny warnings`). It checks
  both the root and `fuzz/Cargo.lock`.
- Only the 17 GTK3/rust-unic warnings that Tauri 2's current Linux runtime cannot
  avoid are excepted by exact RUSTSEC ID. New warnings outside the exceptions can
  never pass automatically.
- These exceptions are on the upstream-replacement watchlist. Once Tauri ships a
  GTK4/glib 0.20+ path or `tauri-utils` drops rust-unic, remove those IDs
  immediately.

## Status per lockfile

| Lockfile            | Vulnerabilities | Actionable warnings | Upstream exceptions |
| ------------------- | ------ | ---------------- | ------------------ |
| root (`Cargo.lock`) | 0      | 0                | 17 (Tauri 2, below) |
| `fuzz/Cargo.lock`   | 0      | 0                | 0                  |

(The past `runner/template/backend` and `runner/template/desktop` lockfile audit
entries were removed when runner/ was deleted along with Lynx — 2026-08-20.)

## Resolution history

| Item            | Before  | After        | RUSTSEC                                           |
| --------------- | ------- | ------------ | ------------------------------------------------- |
| rkyv            | 0.8.16  | 0.8.18       | 2026-0233, 2026-0234, 2026-0235 (3 memory safety) |
| quick-xml       | 0.39.4  | 0.41.0       | 2026-0194, 2026-0195 (2 DoS)                      |
| crossbeam-epoch | 0.9.18  | 0.9.20       | 2026-0204 (pointer dereference)                   |
| plist           | 1.9.0   | 1.10.0       | prerequisite of the quick-xml bump                 |
| anyhow          | 1.0.102 | 1.0.103+     | 2026-0190 (downcast_mut soundness)                |
| atomic-polyfill | present | removed      | 2023-0089 (Postcard default heapless-cas disabled)|
| bincode         | 2.0.1   | removed      | 2025-0141 (required v2 wire preserved in our own codec) |

The only direct rkyv dependency is `examples/calculator` (the RN native path);
the `crates/rustra` core does not depend on the rkyv crate (a serde_json-based
hand-written rkyv V2 wire implementation).

## Tauri 2 upstream exceptions and paths

| Crate                                                                                     | Warning type | Entry path                               |
| ----------------------------------------------------------------------------------------- | ------------ | ---------------------------------------- |
| atk, atk-sys, gdk, gdk-sys, gdkwayland-sys, gdkx11, gdkx11-sys, gtk, gtk-sys, gtk3-macros | unmaintained | tauri → GTK3 (Linux render host)         |
| proc-macro-error                                                                          | unmaintained | via gtk/glib macros                      |
| unic-char-property, unic-char-range, unic-common, unic-ucd-ident, unic-ucd-version        | unmaintained | via tauri-utils identifier validation    |
| glib 0.18.5                                                                               | unsound      | tauri → GTK3; limited to the VariantStrIter functions |

The GTK3 path belongs to the Tauri Linux host runtime and cannot simply be deleted.
The current Tauri 2.11.x ships the same dependencies, and the GTK4 transition is
upstream Tauri/Wry work. The rust-unic path is the build/config parsing path in
`tauri-utils`.

Impact scope:

- The gtk-rs family is linked on Linux by the `rustra-tauri-calculator` example
- Rustra's default FFI/JSI/N-API deliverables do not enable Tauri features by default
- `glib::VariantStrIter` is never called directly from Rustra or Tauri adapter code

The exception IDs are managed in a single place, `scripts/audit-rust.sh`, and the
cargo-audit gate never works around them with arbitrary package names or broad
warning-suppression policies.
