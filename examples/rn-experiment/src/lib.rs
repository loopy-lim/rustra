//! rn-experiment 예제 — RN 번들링 실험용 네이티브 유닛.
//!
//! 동일한 gzip 연산의 JSON/바이트 경로 비용을 실기기에서 비교하기 위한
//! 최소 커맨드 세트를 노출한다(calculator 예제의 native_entry! 골격 재사용):
//!
//! - `gzipCompress` / `gzipDecompress` — 입력·출력이 정확히 하나의 `Vec<u8>`
//!   필드인 bytes in/out 스키마. `buffer_command_fn` 으로 등록해 Tier buffer
//!   fast path(`rustra_ffi_invoke_buffer`)가 광고되고, JSI/host 측에서
//!   number 배열과 JSON 직렬화 없이 바이트 버퍼를 주고받는다. 실제 할당과
//!   복사량은 별도 계측해야 한다.
//! - `uuidV7` — 문자열 스키마(입력 없음, `{ value: string }` 출력) 기능 확인.
//!   gzip과 다른 연산이므로 transport 성능 비교에는 사용하지 않는다.
//!
//! 와이어 구조:
//!
//!   `#[command]` 매크로 → `build!`/`buffer_command_fn` 체인 → `Package` →
//!   `register_ffi_with_default(FfiFormat::Json)`(전역 FFI 컨텍스트 등록 —
//!   OnceLock first-wins) → `rustra::native_entry!` 가 `rustra_mobile_init`
//!   심볼과 Apple 로드 시점 constructor 를 설치.

use rustra::prelude::*;
use std::io::{Read, Write};

// ── gzip — bytes in/out 버퍼 커맨드 ──────────────────────────────
//
// buffer fast path 계약: 입력·출력 스키마가 정확히 하나의 required Vec<u8>
// 필드여야 한다(builder_commands::buffer_command 가 등록 시 loud-fail).
// BenchBytesPayload(calculator)와 동일한 단일 `data` 필드 모양을 유지해
// benchEchoBytes 대비 "실연산 포함" 버퍼 우위를 같은 스키마로 측정한다.

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GzipPayload {
    #[serde(with = "rustra::byte_buffer")]
    #[schemars(with = "Vec<u8>")]
    pub data: Vec<u8>,
}

impl rustra::BufferCommandInput for GzipPayload {
    fn from_buffer(data: Vec<u8>) -> Self {
        Self { data }
    }
}

impl rustra::BufferCommandOutput for GzipPayload {
    fn into_buffer(self) -> Vec<u8> {
        self.data
    }
}

/// 원본 바이트를 gzip(gzip 멤버 스트림, 기본 압축 레벨)으로 압축한다.
#[command]
pub fn gzip_compress(input: GzipPayload) -> Result<GzipPayload> {
    let mut encoder = flate2::write::GzEncoder::new(
        Vec::with_capacity(input.data.len() / 2 + 64),
        flate2::Compression::default(),
    );
    encoder
        .write_all(&input.data)
        .map_err(RustraError::internal)?;
    let data = encoder.finish().map_err(RustraError::internal)?;
    Ok(GzipPayload { data })
}

/// gzip 바이트를 원본 바이트로 복원한다. 잘못된 스트림은 `command.invalid_args`,
/// 현재 FFI payload 한도를 넘는 압축 해제 결과는 `payload.too_large` 로 거부된다.
#[command]
pub fn gzip_decompress(input: GzipPayload) -> Result<GzipPayload> {
    let limit = rustra::ffi::max_payload_bytes();
    let mut decoder =
        flate2::read::GzDecoder::new(input.data.as_slice()).take(limit.saturating_add(1) as u64);
    let mut data = Vec::new();
    decoder
        .read_to_end(&mut data)
        .map_err(|error| RustraError::invalid_args(format!("invalid gzip payload: {error}")))?;
    if data.len() > limit {
        return Err(RustraError::payload_too_large(data.len(), limit));
    }
    Ok(GzipPayload { data })
}

// ── uuid v7 — 문자열 스키마 커맨드 ───────────────────────────────

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UuidV7Input {}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UuidV7Output {
    /// 표준 하이픈 형식의 UUID v7 문자열(시간 정렬 가능).
    pub value: String,
}

/// UUID v7(UTC 기준 ms 타임스탬프 + 랜덤)을 생성해 문자열로 반환한다.
#[command]
pub fn uuid_v7(_input: UuidV7Input) -> Result<UuidV7Output> {
    Ok(UuidV7Output {
        value: uuid::Uuid::now_v7().to_string(),
    })
}

static CACHED_PACKAGE: std::sync::OnceLock<Package> = std::sync::OnceLock::new();

pub fn rn_experiment_package() -> Package {
    CACHED_PACKAGE
        .get_or_init(|| {
            // 문자열 스키마 커맨드(uuidV7)는 build! 체인으로 등록하고, bytes
            // in/out 커맨드(gzip*)는 그 뒤에 buffer fast path 로 이어 붙인다.
            // 등록 순서가 command id 계약이므로 기존 순서를 유지한다.
            let builder = rustra::build!("examples.rnexperiment", uuid_v7)
                .buffer_command_fn(gzip_compress)
                .command_execution(
                    __RUstra_meta_gzip_compress,
                    __RUstra_execution_gzip_compress,
                )
                .buffer_command_fn(gzip_decompress)
                .command_execution(
                    __RUstra_meta_gzip_decompress,
                    __RUstra_execution_gzip_decompress,
                );

            let pkg = builder.build();

            // FFI 전역 컨텍스트 등록 — rustra_ffi_invoke_* / contract_hash 가
            // 읽는 상태다(calculator/hot-core-variant 와 동일, Json 기본 포맷).
            pkg.register_ffi_with_default(rustra::ffi::FfiFormat::Json);

            pkg
        })
        .clone()
}

// Stable zero-config native entry shared by Bun FFI and the RN bridge. The
// macro also installs the Apple load-time constructor; other hosts call the
// exported symbol explicitly during lazy bootstrap.
rustra::native_entry!(rn_experiment_package);
