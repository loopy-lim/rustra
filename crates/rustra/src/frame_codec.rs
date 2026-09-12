//! Frame 바이너리 인코딩/디코딩 로직입니다.
//!
//! 요청·응답 wire, 필드 분류, JSON fallback, 그리고 JS postcard 지원
//! 판정을 책임별 파일로 분리합니다. 이 모듈은 기존 crate 내부 경계를
//! 유지하는 compatibility facade입니다.

use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::Arc;

use crate::{Result, RustraError};

include!("frame_raw.rs");
include!("frame_tier3.rs");
include!("frame_decode.rs");
include!("frame_response.rs");
include!("frame_error.rs");
include!("frame_fields.rs");
include!("frame_vec.rs");
include!("frame_support.rs");
include!("frame_support_extra.rs");
