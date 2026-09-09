// ── tauri_support 테스트 (파사드의 #[path] 테스트 서브모듈) ──────────────────
//
// hot_core_tests.rs 와 같은 관용 — 본체(tauri_support.rs)는 등록·디스패치 배선만
// 남기고 테스트는 책임별로 여기에 모은다. `use super::*` 로 파사드 표면 전체를
// 본다.

use super::*;

mod profiled_tests {
    use super::*;

    /// ProfiledResponse 의 필드 계약 — JS 측 차감 로직이 의존하는 표면 고정.
    #[test]
    fn profiled_response_serializes_native_ns_field() {
        let response = ProfiledResponse {
            result: json!({"value": 42}),
            ok: true,
            native_ns: 1234,
        };
        let value = serde_json::to_value(&response).expect("serializable");
        assert_eq!(value["ok"], json!(true));
        assert_eq!(value["native_ns"], json!(1234));
        assert_eq!(value["result"]["value"], json!(42));
    }
}

mod batch_tests {
    use super::*;
    use crate::RustraError;

    /// run_batch 이 사용하는 것과 동일한 invoke_json 경로를 지나는 최소 패키지.
    fn batch_package() -> Package {
        Package::builder("test.batch")
            .command("addNumbers", |args: serde_json::Value| {
                let a = args["a"].as_i64().unwrap_or(0);
                let b = args["b"].as_i64().unwrap_or(0);
                Ok::<_, RustraError>(json!(a + b))
            })
            .command("failAlways", |_args: serde_json::Value| {
                Err::<Value, _>(RustraError::custom("invoke.failed", "boom"))
            })
            .build()
    }

    /// 순서 보존 + 성공 응답 형태.
    #[test]
    fn batch_preserves_request_order_and_success_shape() {
        let package = batch_package();
        let responses = run_batch(
            &package,
            vec![
                BatchRequest {
                    command: "addNumbers".into(),
                    args: json!({"a": 20, "b": 22}),
                },
                BatchRequest {
                    command: "addNumbers".into(),
                    args: json!({"a": 6, "b": 7}),
                },
            ],
        );
        assert_eq!(responses.len(), 2);
        assert!(responses[0].ok);
        assert_eq!(responses[0].result.as_ref().unwrap(), &json!(42));
        assert!(responses[0].error.is_none(), "성공 항목은 error 필드 생략");
        assert!(responses[1].ok);
        assert_eq!(responses[1].result.as_ref().unwrap(), &json!(13));
    }

    /// 부분 실패 — 개별 실패가 배치 전체를 중단시키지 않는다(fail-fast 아님).
    #[test]
    fn batch_partial_failure_isolates_errors() {
        let package = batch_package();
        let responses = run_batch(
            &package,
            vec![
                BatchRequest {
                    command: "nope_not_found".into(),
                    args: json!({}),
                },
                BatchRequest {
                    command: "failAlways".into(),
                    args: json!({}),
                },
                BatchRequest {
                    command: "addNumbers".into(),
                    args: json!({"a": 1, "b": 2}),
                },
            ],
        );
        assert!(!responses[0].ok, "unknown command must fail its own entry");
        assert!(responses[0].error.is_some());
        assert!(!responses[1].ok, "handler error must fail only its entry");
        assert_eq!(
            responses[1].error.as_ref().unwrap()["message"],
            json!("boom")
        );
        // 이후 항목은 정상 실행된다.
        assert!(responses[2].ok);
        assert_eq!(responses[2].result.as_ref().unwrap(), &json!(3));
    }
}
