//! TypeScript 코드 생성 유틸리티입니다.
//!
//! JSON Schema를 TypeScript 타입 표현식으로 변환하고,
//! 명령 이름을 lowerCamelCase 함수 이름으로 변환합니다.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

include!("codegen_types.rs");

include!("codegen_objects.rs");

include!("codegen_names.rs");

/// 코드젠 경고 수집기 — 매핑 불가 스키마가 `"unknown"` 폴백으로 떨어질 때
/// 타입 컨텍스트를 잃지 않게 스레드 로컬 버퍼에 모은다.
///
/// `ts_type_from_schema`는 (스키마, 정의)만 받으므로 명령명은 호출부가 아는
/// 정보다. 호출부는 [`take_codegen_warnings`]로 소비하기 전에
/// [`set_codegen_command_context`]로 현재 명령을 알려준다. 경고는 폴백 시점의
/// 타입 컨텍스트(스키마 발췌)를 포함한다.
///
/// # 소비 계약
///
/// `Package::generate_typescript`가 `generate_types_ts`/`generate_commands_ts`
/// 진입에서 `clear_codegen_warnings()` → 명령/정의 루프에서
/// `set_codegen_command_context(컨텍스트명)` → 종료 시 `take_codegen_warnings()`를
/// `GeneratedPackage::warnings` 필드로 실어준다. CLI(`@rustra/cli` codegen
/// 파이프라인)가 이를 stderr로 출력한다. 경고는 생성 파일(types.ts 등)의
/// 바이트 출력에 영향을 주지 않는다 — 별도 진행 채널이다.
pub(crate) struct CodegenWarning {
    /// 폴백이 일어난 TypeScript 타입 표현식 컨텍스트 (스키마 type/format 발췌).
    pub(crate) context: String,
    /// 폴백 시점에 코드젠 중이던 명령명 (컨텍스트 미설정 시 `"<unknown>"`).
    pub(crate) command: String,
}

impl CodegenWarning {
    /// CLI/호스트가 그대로 출력할 수 있는 한 줄 진단 문자열.
    pub(crate) fn message(&self) -> String {
        format!(
            "{}: unmapped schema fell back to \"unknown\" ({})",
            self.command, self.context
        )
    }
}

use std::cell::RefCell;

thread_local! {
    static CODEGEN_WARNINGS: RefCell<Vec<CodegenWarning>> = const { RefCell::new(Vec::new()) };
    static CODEGEN_COMMAND: RefCell<String> = RefCell::new(String::from("<unknown>"));
}

/// 경고 수집 시작 전 버퍼를 비운다 (생성 세션 진입점에서 호출).
pub(crate) fn clear_codegen_warnings() {
    CODEGEN_WARNINGS.with(|warnings| warnings.borrow_mut().clear());
}

/// 현재 코드젠 중인 명령명을 기록한다 — 이후 폴백 경고에 첨부된다.
pub(crate) fn set_codegen_command_context(command: &str) {
    CODEGEN_COMMAND.with(|slot| *slot.borrow_mut() = command.to_string());
}

/// 수집된 경고를 소비한다 (생성 세션 종료점에서 호출).
pub(crate) fn take_codegen_warnings() -> Vec<CodegenWarning> {
    CODEGEN_WARNINGS.with(|warnings| std::mem::take(&mut *warnings.borrow_mut()))
}

/// 폴백 경고를 기록한다 — codegen_types.rs/codegen_objects.rs의 `"unknown"`
/// 폴백 지점에서 호출한다.
fn record_unknown_fallback(schema: &Value) {
    let context = match schema.get("type").and_then(Value::as_str) {
        Some(t) => match schema.get("format").and_then(Value::as_str) {
            Some(f) => format!("{t} (format: {f})"),
            None => t.to_string(),
        },
        None => "untyped schema".to_string(),
    };
    let command = CODEGEN_COMMAND.with(|slot| slot.borrow().clone());
    CODEGEN_WARNINGS.with(|warnings| {
        warnings
            .borrow_mut()
            .push(CodegenWarning { context, command });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 감사 HIGH 항목 — 매핑 불가 스키마가 조용히 `"unknown"`으로 폴백하며
    /// 타입명/명령명을 잃는 결함. 폴백이 경고를 남기는지 검증한다.
    #[test]
    fn unknown_fallback_records_warning_with_schema_context() {
        clear_codegen_warnings();
        set_codegen_command_context("addNumbers");
        let schema = json!({ "type": "i-am-not-a-real-type" });
        let definitions = json!({});
        let ts = ts_type_from_schema(&schema, &definitions);
        assert_eq!(ts, "unknown");
        let warnings = take_codegen_warnings();
        assert_eq!(warnings.len(), 1, "fallback must emit a warning");
        assert_eq!(warnings[0].command, "addNumbers");
        assert_eq!(warnings[0].context, "i-am-not-a-real-type");
    }

    #[test]
    fn known_types_emit_no_warnings() {
        clear_codegen_warnings();
        set_codegen_command_context("addNumbers");
        let definitions = json!({});
        assert_eq!(
            ts_type_from_schema(&json!({ "type": "string" }), &definitions),
            "string"
        );
        assert_eq!(
            ts_type_from_schema(
                &json!({ "type": "integer", "format": "int64" }),
                &definitions
            ),
            "number | bigint"
        );
        assert!(take_codegen_warnings().is_empty());
    }

    #[test]
    fn nested_array_element_fallback_reports_inner_context() {
        clear_codegen_warnings();
        set_codegen_command_context("echoGroups");
        let schema = json!({ "type": "array", "items": { "type": "mystery" } });
        let definitions = json!({});
        assert_eq!(ts_type_from_schema(&schema, &definitions), "unknown[]");
        let warnings = take_codegen_warnings();
        assert_eq!(warnings.len(), 1);
        assert_eq!(warnings[0].context, "mystery");
    }

    /// 수집기 소비 계약 — `take_codegen_warnings` 결과가 사람이 읽을 수 있는
    /// 메시지(명령명 + 타입 컨텍스트)로 렌더링되는지 검증한다. 이 메시지가
    /// `GeneratedPackage::warnings` 를 거쳐 CLI stderr 로 나간다.
    #[test]
    fn warning_message_contains_command_and_type_context() {
        clear_codegen_warnings();
        set_codegen_command_context("addNumbers");
        let ts = ts_type_from_schema(&json!({ "type": "mystery" }), &json!({}));
        assert_eq!(ts, "unknown");
        let warnings = take_codegen_warnings();
        assert_eq!(warnings.len(), 1);
        assert_eq!(
            warnings[0].message(),
            "addNumbers: unmapped schema fell back to \"unknown\" (mystery)"
        );
    }
}
