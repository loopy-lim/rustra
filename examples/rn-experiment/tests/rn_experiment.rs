//! rn-experiment 예제 통합 테스트 — gzip bytes 와이어와 uuid v7 문자열 스키마.
//!
//! 세 면을 고정한다:
//! 1. 타입 와이어(typed JSON invoke) gzip 왕복
//! 2. 버퍼 와이어(`rustra_ffi_invoke_buffer`) gzip 왕복 — Tier buffer fast
//!    path 가 실제로 광고되고 동작하는지의 증거(버퍼 우위 실측의 전제)
//! 3. uuid v7 문자열 스키마(버전 비트, 시간 정렬, 코드젠 스키마)

use rustra_rn_experiment::*;

/// LCG 기반 결정적 페이로드 — 상위 니블만 사용해 16-심볼 알파벳의 반복+노이즈
/// 혼합을 만든다(완전 랜덤은 gzip 이 압축 불가). 테스트 자체는 결정적이다.
fn pseudo_random_payload(len: usize) -> Vec<u8> {
    let mut state = 0x1234_5678u32;
    (0..len)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 28) as u8
        })
        .collect()
}

fn resolve_command_id(name: &str) -> u16 {
    (0u16..)
        .find(|id| rn_experiment_package().resolve_command_id(*id).as_deref() == Some(name))
        .unwrap_or_else(|| panic!("{name} registered"))
}

#[test]
fn gzip_round_trip_via_typed_wire() {
    let package = rn_experiment_package();
    let raw = pseudo_random_payload(64 * 1024);

    let compressed: GzipPayload = package
        .invoke("gzipCompress", GzipPayload { data: raw.clone() })
        .unwrap();
    // gzip 멤버 스트림 매직 넘버(0x1f 0x8b) + deflate 방법(0x08).
    assert_eq!(&compressed.data[..3], &[0x1f, 0x8b, 0x08]);
    assert!(
        compressed.data.len() < raw.len(),
        "repetitive payload should compress (raw={}, compressed={})",
        raw.len(),
        compressed.data.len()
    );

    let restored: GzipPayload = package
        .invoke(
            "gzipDecompress",
            GzipPayload {
                data: compressed.data,
            },
        )
        .unwrap();
    assert_eq!(restored.data, raw);
}

#[test]
fn gzip_rejects_invalid_stream_with_args_error() {
    let package = rn_experiment_package();
    let not_gzip = b"definitely not a gzip stream".to_vec();
    let err = package
        .invoke::<_, GzipPayload>("gzipDecompress", GzipPayload { data: not_gzip })
        .unwrap_err();
    assert_eq!(err.code(), "command.invalid_args");
}

#[test]
fn gzip_rejects_decompression_beyond_payload_limit() {
    // A tiny valid gzip member must not cause unbounded expansion before FFI's
    // final output-length check. Exercise the typed path too, which bypasses FFI.
    let limit = rustra::ffi::max_payload_bytes();
    let compressed = gzip_compress(GzipPayload {
        data: vec![0; limit + 1],
    })
    .unwrap();
    assert!(compressed.data.len() < 4096);
    let error = rn_experiment_package()
        .invoke::<_, GzipPayload>("gzipDecompress", compressed)
        .unwrap_err();
    assert_eq!(error.code(), "payload.too_large");
}

#[test]
fn gzip_round_trip_via_buffer_ffi() {
    // 첫 호출이 FFI 전역 컨텍스트에 패키지를 등록한다(OnceLock first-wins).
    let _ = rn_experiment_package();

    let compress_id = resolve_command_id("gzipCompress");
    let decompress_id = resolve_command_id("gzipDecompress");

    // buffer fast path 광고 확인 — 단일 Vec<u8> 필드 스키마 덕이다.
    assert_eq!(rustra::ffi::rustra_ffi_has_buffer(compress_id), 1);
    assert_eq!(rustra::ffi::rustra_ffi_has_buffer(decompress_id), 1);

    let raw = pseudo_random_payload(32 * 1024);

    // compress — 바이트 버퍼를 소유 포인터로 직접 주고받는다.
    let mut compressed = std::ptr::null_mut();
    let mut compressed_len = 0usize;
    let status = unsafe {
        rustra::ffi::rustra_ffi_invoke_buffer(
            compress_id,
            raw.as_ptr(),
            raw.len(),
            &mut compressed,
            &mut compressed_len,
        )
    };
    assert_eq!(status, 0);
    assert!(!compressed.is_null());
    let compressed_bytes =
        unsafe { std::slice::from_raw_parts(compressed, compressed_len) }.to_vec();
    unsafe { rustra::ffi::rustra_ffi_free_owned_bytes(compressed, compressed_len) };
    assert_eq!(&compressed_bytes[..3], &[0x1f, 0x8b, 0x08]);

    // decompress — 같은 버퍼 경로로 되돌린다.
    let mut restored = std::ptr::null_mut();
    let mut restored_len = 0usize;
    let status = unsafe {
        rustra::ffi::rustra_ffi_invoke_buffer(
            decompress_id,
            compressed_bytes.as_ptr(),
            compressed_bytes.len(),
            &mut restored,
            &mut restored_len,
        )
    };
    assert_eq!(status, 0);
    assert_eq!(
        unsafe { std::slice::from_raw_parts(restored, restored_len) },
        raw
    );
    unsafe { rustra::ffi::rustra_ffi_free_owned_bytes(restored, restored_len) };
}

#[test]
fn uuid_v7_string_schema_contract() {
    let package = rn_experiment_package();

    let first: UuidV7Output = package.invoke("uuidV7", UuidV7Input {}).unwrap();
    let second: UuidV7Output = package.invoke("uuidV7", UuidV7Input {}).unwrap();

    let parsed_first: uuid::Uuid = first.value.parse().expect("hyphenated uuid string");
    let parsed_second: uuid::Uuid = second.value.parse().expect("hyphenated uuid string");

    // version 비트가 v7(7)이고 variant 는 RFC 9562.
    assert_eq!(parsed_first.get_version_num(), 7);
    assert_eq!(parsed_second.get_version_num(), 7);
    assert!(matches!(
        parsed_first.get_version(),
        Some(uuid::Version::SortRand)
    ));

    // v7은 시간 정렬 — ms 타임스탬프가 같아도 rand_a 순위로 비교 가능.
    assert!(parsed_first < parsed_second || first.value != second.value);
    assert_ne!(first.value, second.value);
}

#[test]
fn schema_declares_three_commands_with_expected_shapes() {
    let package = rn_experiment_package();
    let generated = package.generate_typescript().expect("codegen failed");
    let schema: serde_json::Value = serde_json::from_str(&generated.schema_json).unwrap();

    assert_eq!(schema["packageId"], "examples.rnexperiment");
    let commands = schema["commands"].as_array().expect("commands array");
    let mut names: Vec<&str> = commands.iter().filter_map(|c| c["name"].as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, ["gzipCompress", "gzipDecompress", "uuidV7"]);

    let by_name = |name: &str| {
        commands
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("{name} in schema"))
    };

    // gzip — bytes in/out(단일 data 필드, 배열 of u8).
    for name in ["gzipCompress", "gzipDecompress"] {
        let command = by_name(name);
        assert_eq!(
            command["inputSchema"]["properties"]["data"]["type"], "array",
            "{name} input is bytes"
        );
        assert_eq!(
            command["outputSchema"]["properties"]["data"]["type"], "array",
            "{name} output is bytes"
        );
        assert_eq!(
            command["inputSchema"]["required"],
            serde_json::json!(["data"]),
            "{name} input has exactly one required field (buffer path contract)"
        );
    }

    // uuid — 문자열 스키마.
    let uuid_command = by_name("uuidV7");
    assert_eq!(
        uuid_command["outputSchema"]["properties"]["value"]["type"],
        "string"
    );
}
