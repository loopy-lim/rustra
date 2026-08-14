# rustra-macros

Procedural macros for the [`rustra`](https://crates.io/crates/rustra) bridge framework.

Provides:
- `#[command]`: Defines a typed Rust command that can be exported to TypeScript.
- `#[bridge_type]`: Declares serializable types shared across the bridge.
- `build!`: Package builder macro.
- `register!`: Registers commands into the global runtime registry.
