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
