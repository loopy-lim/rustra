use super::*;

// oneOf data enum — JS postcard 코덱 미지원 → complex binary 라우트.
// (rkyv_v2_wire.rs 의 Status fixture 와 동일한 라우팅)
#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
enum IntoStatus {
    Active { level: i64 },
    Idle,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct IntoStatusIn {
    status: IntoStatus,
}

#[derive(Debug, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct IntoStatusOut {
    status: IntoStatus,
}

fn status_echo(input: IntoStatusIn) -> Result<IntoStatusOut> {
    Ok(IntoStatusOut {
        status: input.status,
    })
}

fn complex_pkg() -> Package {
    Package::builder("test.complex-into")
        .command("statusEcho", status_echo)
        .build()
}

// [cmd_id u16 LE][variant index=0(Active)][level zigzag(7)=14]
fn status_request(id: u16) -> Vec<u8> {
    let mut req = id.to_le_bytes().to_vec();
    req.extend_from_slice(&[0, 14]);
    req
}

// complex 커맨드가 into-handler를 가져야 한다 (과거 None → Buffered 폴백).
#[test]
fn complex_command_gets_into_handler_and_writes_caller_buffer() {
    let pkg = complex_pkg();
    let req = status_request(1);
    let mut target = vec![0u8; 64];
    match pkg.invoke_rkyv_v2_into(&req, &mut target).unwrap() {
        DirectResponse::Written(len) => {
            // 8B header + [variant 0][zigzag(7)=14]
            assert_eq!(len, 10);
            assert_eq!(target[0], 1, "ok flag");
            assert_eq!(&target[8..10], &[0, 14]);
        }
        DirectResponse::Buffered(_) => {
            panic!("complex command must use the into-handler, not the malloc fallback")
        }
    }
    // 와이어 무변경 게이트 — into 기록 바이트 == 할당 경로 응답 바이트.
    let buffered = pkg.invoke_rkyv_v2(&req).unwrap();
    assert_eq!(buffered.len(), 10);
    assert_eq!(&buffered[..], &target[..10]);
}

// caller 버퍼 부족 → bounded writer overflow → 기존 Buffered 폴백 유지.
#[test]
fn complex_into_falls_back_to_buffered_when_caller_buffer_is_small() {
    let pkg = complex_pkg();
    let req = status_request(1);
    // 8B header 만 들어가는 버퍼 — body 2B 는 못 들어간다.
    let mut target = vec![0u8; 9];
    match pkg.invoke_rkyv_v2_into(&req, &mut target).unwrap() {
        DirectResponse::Buffered(response) => {
            assert_eq!(response.len(), 10);
            assert_eq!(response[0], 1);
            assert_eq!(&response[8..], &[0, 14]);
        }
        DirectResponse::Written(_) => {
            panic!("insufficient buffer must fall back to Buffered")
        }
    }
}

// caller 버퍼가 header 조차 못 담을 때(<=8B)도 Buffered 폴백이어야 한다.
#[test]
fn complex_into_falls_back_when_buffer_has_no_body_room() {
    let pkg = complex_pkg();
    let req = status_request(1);
    let mut target = vec![0u8; 8];
    match pkg.invoke_rkyv_v2_into(&req, &mut target).unwrap() {
        DirectResponse::Buffered(response) => assert_eq!(response.len(), 10),
        DirectResponse::Written(_) => {
            panic!("no body room must fall back to Buffered")
        }
    }
}

// 폴백(exact-once) — caller 버퍼 부족으로 Buffered 로 흘러가도 핸들러는
// 정확히 1회만 실행된다. postcard 라우트의 동일 계약
// (trust_baseline_ffi::caller_buffer_rkyv_v2_large_response_executes_exactly_once)
// 를 complex 라우트에서 미러한다. 비멱등 command 안전성의 근거.
static INTO_FALLBACK_COUNTER: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

fn counted_status_echo(input: IntoStatusIn) -> Result<IntoStatusOut> {
    INTO_FALLBACK_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok(IntoStatusOut {
        status: input.status,
    })
}

#[test]
fn complex_into_fallback_executes_handler_exactly_once() {
    let pkg = Package::builder("test.complex-into-once")
        .command("countedStatusEcho", counted_status_echo)
        .build();
    let req = status_request(1);
    let before = INTO_FALLBACK_COUNTER.load(std::sync::atomic::Ordering::SeqCst);

    // 8B header 만 담는 target — body 2B 가 못 들어가 폴백 강제.
    let mut target = vec![0u8; 8];
    match pkg.invoke_rkyv_v2_into(&req, &mut target).unwrap() {
        DirectResponse::Buffered(response) => {
            assert_eq!(response.len(), 10);
            assert_eq!(response[0], 1);
            assert_eq!(&response[8..], &[0, 14]);
        }
        DirectResponse::Written(_) => panic!("small target must force the fallback"),
    }
    assert_eq!(
        INTO_FALLBACK_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        1,
        "fallback must not re-run the handler"
    );

    // 같은 요청을 넉넉한 target 으로 — Written 경로도 카운터를 1만 늘린다.
    let mut roomy = vec![0u8; 64];
    assert!(matches!(
        pkg.invoke_rkyv_v2_into(&req, &mut roomy).unwrap(),
        DirectResponse::Written(10)
    ));
    assert_eq!(
        INTO_FALLBACK_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        2
    );
}
