//! codegen bin — backend contract 로 app/generated/ 를 재생성한다 (Rust 측 절반).
//!
//! dual-path codegen 의 1단계(메모리: codegen-dual-path-regen):
//! 1. (본 bin)  package.generate_typescript() → types.ts / commands.ts / contract.ts / schema.json
//! 2. (TS CLI)  rustra generate --schema schema.json → rkyv-codecs.ts / rkyv-registry.ts
//!
//! 완전 재생성은 둘 다 순서대로 실행해야 한다 — `app/npm run codegen` 이 이를 수행.
//!
//! 스파이크 패턴: examples/calculator/src/main.rs (`package.generate_typescript()?.write_to_dir`).
use rustra_template_backend::template_package;

fn main() -> rustra::Result<()> {
    // CARGO_MANIFEST_DIR = runner/template/backend → ../app/generated
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../app/generated");
    let package = template_package();
    let generated = package.generate_typescript()?;
    generated.write_to_dir(out)?;
    println!("generated → app/generated (schema.json, types.ts, commands.ts, contract.ts)");
    println!("다음: (cd app && npm run codegen) 이 rkyv-codecs/rkyv-registry 까지 완성한다.");
    Ok(())
}
