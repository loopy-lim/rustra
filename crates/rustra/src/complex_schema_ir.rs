//! Complex codec 스키마 사전컴파일 IR.
//!
//! `serde_json::Value` 스키마를 코덱 생성 시점에 **한 번** 순회해 닫힌 노드
//! 트리로 만든다. 이후 encode/decode 는 `&Value` 스키마를 호출마다 재해석하지
//! 않고 IR 만 순회한다 — 매 호출의 `resolved_schema` 클론, `option_inner`
//! 클론, `variants` 클론+정렬이 모두 빌드 시점 1회로 이동한다.
//!
//! 와이어 불변식: IR 순회는 기존 런타임 해석과 바이트 단위로 동일해야 한다
//! (게이트 — complex round-trip 테스트 + PINNED wire fixture 전수). 원본이
//! 매 호출 raw 스키마 모양을 보고 내리는 결정들을 빌드 시점에 스냅샷한다:
//!
//! - `$ref`/`allOf` 전개는 컴파일 시점에 완료. 재귀 정의는 사이클을 끊는
//!   `Ref` 노드로 남고 정의 IR은 공유 `OnceLock` 에 메모이즈된다. 컴파일이
//!   성공하면 도달한 모든 `Ref` 슬롯이 채워진 상태가 보장된다(실패한 정의
//!   컴파일은 전체 Err 로 귀결되어 코덱이 만들어지지 않음).
//! - `option_inner`(type:[T,null] / anyOf:[T,null]) 해석을 `Option` 노드로
//!   고정 — 런타임 inner 재구성 클론 제거.
//! - oneOf 변형 정렬(`variant_key` 유도+사전순)과 판별자 검출, 변형 매칭/
//!   본체 디스패치 결정을 `IrVariant` 에 고정 — 원본 `matches_variant` /
//!   `encode_variant` / `decode_variant` 는 raw 변형 스키마 모양을 보므로
//!   그 결정 트리를 컴파일 시점에 동일 순서로 밟아 스냅샷한다.
//! - enum 이 const 검사보다 앞서고(encode/decode 공통), const 는 encode 에서
//!   값 검사 후 타입 폴스루, decode 에서는 무시(원본 decode_node 에 const
//!   분기가 없음)하는 분기 순서도 그대로 유지한다.
//!
//! 원본이 지원하지 않는 스키마는 IR 도 지원하지 않는다(동일 에러 문자열 —
//! 빌드 시 Err 로 귀결되고, 핸들러가 그 에러를 호출 시점에 재방출한다).
//! 튜플 `items` 배열은 원본이 지원하므로 IR 에서도 길이 일치 검사로 지원한다.

use super::complex_codec_schema::error;
use crate::Result;
use serde_json::Value;
use std::sync::{Arc, OnceLock};

/// 컴파일된 complex 스키마 노드.
#[derive(Debug)]
pub(crate) enum IrNode {
    /// `type: "string"` — len+bytes.
    String,
    /// `type: "boolean"` — 1바이트.
    Boolean,
    /// `type: "integer"` — `uint*` 포맷이면 uvar, 아니면 zigzag.
    Int { unsigned: bool },
    /// `type: "number"` — `float` 포맷이면 f32, 아니면 f64 (LE 고정폭).
    Float { single: bool },
    /// `type: "null"` — 와이어 0바이트.
    Null,
    /// 배열 — `tuple` 은 `items` 배열 케이스(길이 일치 검사), `items` 는
    /// 단일 반복 노드. 컴파일 시점에 어느 쪽인지 고정된다.
    Seq {
        tuple: Option<Vec<Arc<IrNode>>>,
        items: Option<Arc<IrNode>>,
    },
    /// Option — presence 바이트 1개 + 내부 노드 (option_inner 해석 완료).
    Option { inner: Arc<IrNode> },
    /// struct — 프로퍼티 declaration 순서 고정, 선택 필드 presence 태그.
    Struct {
        fields: Vec<IrField>,
        required: Vec<bool>,
    },
    /// map — `additionalProperties` 값 스키마. 키는 사전순(varint+key+value).
    Map { value: Arc<IrNode> },
    /// enum — 값 목록 (인덱스 uvar). 원본 분기에서 enum 이 const/type 보다
    /// 앞서므로 enum 유무가 이 노드로 붕괴한다.
    Enum { values: Arc<[Value]> },
    /// const — encode: 값 일치 검사 후 `inner` 폴스루, decode: `inner` 만
    /// 읽는다(원본 decode_node 에 const 분기가 없어 const 를 무시하고 타입으로
    /// 읽는다). `inner` 가 없으면(=const 단독) 원본과 동일하게
    /// `unsupported schema type None` 이 된다 — const 단독 본체는 변형 경로
    /// (`IrBody::ConstValue`)에서만 와이어 0바이트로 처리된다.
    Const {
        value: Value,
        inner: Option<Arc<IrNode>>,
    },
    /// data enum / union — 정렬 완료 변형.
    OneOf { variants: Vec<IrVariant> },
    /// 재귀 `$ref` — 정의 IR 로 1-hop(원본이 `$ref` 를 인라인 해석하듯 깊이
    /// 카운터를 바꾸지 않는다). 정의 IR 은 컴파일 성공 시 채워진 공유
    /// `OnceLock` 에 메모이즈된다.
    Ref { target: Arc<OnceLock<Arc<IrNode>>> },
}

/// struct 필드 — 이름과 컴파일된 타입 노드.
#[derive(Debug)]
pub(crate) struct IrField {
    pub name: String,
    pub node: Arc<IrNode>,
}

/// 변형 매칭 결정 — 원본 `matches_variant` 의 순서를 컴파일 시점에 밟아
/// 고정한 것. 런타임은 이 결정만 값에 적용한다.
#[derive(Debug)]
pub(crate) enum IrMatcher {
    /// 판별자 일치 — `IrVariant::discriminator` 의 (필드명, 태그).
    Discriminator,
    /// 단일 프로퍼티 키 존재 여부.
    SingleProperty { key: String },
    /// const 값 일치.
    ConstEq(Value),
    /// 단일 enum 값 일치.
    EnumSingle(Value),
    /// type string 폴백 — 값이 문자열.
    AnyString,
    /// type object 폴백 — 값이 객체.
    AnyObject,
    /// 매칭 불가 (원본 폴백 false).
    Never,
}

/// 변형 본체 디스패치 — 원본 `encode_variant`/`decode_variant` 의 순서를
/// 컴파일 시점에 밟아 고정한 것.
#[derive(Debug)]
pub(crate) enum IrBody {
    /// 판별자 struct — 본체 struct 노드를 판별자 필드를 제외하고
    /// 인코딩/디코딩한다. decode 는 결과 객체에 판별자 (필드명, 태그) 를 심고
    /// encode 는 값이 객체임을 요구한다(`expected enum object`).
    Tagged { node: Arc<IrNode> },
    /// 단일 프로퍼티 언래핑 — 본체는 프로퍼티 값만 인코딩/디코딩.
    UnwrapSingle { key: String, node: Arc<IrNode> },
    /// const 본체 — encode 0바이트, decode 는 값 복제.
    ConstValue(Value),
    /// enum 본체 — encode 0바이트, decode 는 첫 값.
    EnumFirst(Value),
    /// 폴스루 — 변형 전체 노드 인코딩/디코딩.
    Node(Arc<IrNode>),
}

/// 정렬 완료된 oneOf 변형.
#[derive(Debug)]
pub(crate) struct IrVariant {
    /// 정렬 키 — `variant_key` 유도 결과(explicit 순서 키 포함). 와이어 변형
    /// 인덱스는 이 키의 사전순 순번이고, serde 유도 코드가 매칭하는 변형
    /// 이름(또는 태그 값)도 schemars 스키마에서는 이 키와 일치한다 — 직결
    /// 경로(complex_serde)가 인덱스↔이름 대응에 쓴다.
    pub key: String,
    /// 변형 판별자 — 변형이 const 프로퍼티를 가진 struct 면 (필드명, 태그).
    pub discriminator: Option<(String, Value)>,
    /// 변형 매칭 결정.
    pub matcher: IrMatcher,
    /// 변형 본체 디스패치.
    pub body: IrBody,
}

/// 컴파일 실패/미지원 스키마 에러 (원본과 동일 문자열).
fn ir_error(message: impl Into<String>) -> RustraError {
    error(message)
}

/// 메모이즈된 Ref 슬롯 해석 — encode/decode 공통. 컴파일 성공 시 모든 도달
/// Ref 슬롯이 채워진다 — 빈 슬롯은 컴파일러 버그.
pub(crate) fn compiled_ref(target: &OnceLock<Arc<IrNode>>) -> Result<&Arc<IrNode>> {
    target
        .get()
        .ok_or_else(|| error("unresolved schema reference"))
}

include!("complex_schema_ir_compile.rs");
