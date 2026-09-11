use rustra_calculator_example::calculator_package;
use rustra_calculator_example::uniffi_render;
use std::path::PathBuf;

fn main() -> rustra::Result<()> {
    let generated = calculator_package().generate_typescript()?;
    let schema_json = generated.schema_json.clone();
    let out = match std::env::var_os("RUSTRA_SCHEMA_OUT") {
        Some(p) if !p.is_empty() => PathBuf::from(p).join("schema.json"),
        _ => PathBuf::from("generated").join("schema.json"),
    };
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&out, generated.schema_json)?;
    println!("{} written", out.display());

    // Track B1-2 — RUSTRA_UNIFFI_OUT 이 설정되면(schema.json 과 동일한 임시
    // 디렉터리 계약) UniFFI 미러 소스를 같이 렌더링해 쓴다. check 모드도 같은
    // 환경변수로 렌더→커밋된 src/uniffi_generated.rs 와 비교한다(코드젠 신선도
    // 게이트가 두 모드에서 대칭 동작). 미러로 표현 불가능한 타입이 있으면
    // 렌더러가 경로를 밝히며 실패한다(fail-closed, skip 없음).
    if let Some(uniffi_out) = std::env::var_os("RUSTRA_UNIFFI_OUT").filter(|p| !p.is_empty()) {
        let source = uniffi_render::render_uniffi_generated(&schema_json).map_err(|error| {
            rustra::RustraError::custom("codegen.uniffi_render_failed", error.to_string())
        })?;
        let out = PathBuf::from(uniffi_out).join("uniffi_generated.rs");
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&out, source)?;
        // rustfmt 정규화 — lefthook 이 커밋 시점에 `rustfmt -- <file>` 로 제자리
        // 포맷하므로 정규화 없이는 커밋된 산출과 check 모드의 임시 렌더가 어긋나
        // 신선도 게이트가 항상 깨진다. 렌더러가 직접 동일 방식(제자리)으로 포맷해
        // 두 모드가 동일한 바이트를 내게 한다. 실패 시 fail-closed.
        let status = std::process::Command::new("rustfmt")
            .arg("--edition")
            .arg("2024")
            .arg("--")
            .arg(&out)
            .status()
            .map_err(|error| {
                rustra::RustraError::custom(
                    "codegen.uniffi_rustfmt_failed",
                    format!("rustfmt spawn failed: {error}"),
                )
            })?;
        if !status.success() {
            return Err(rustra::RustraError::custom(
                "codegen.uniffi_rustfmt_failed",
                format!("rustfmt failed on {}", out.display()),
            ));
        }
        println!("{} written", out.display());
    }
    Ok(())
}
