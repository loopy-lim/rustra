pub(crate) type BinHandler = Arc<dyn Fn(&[u8]) -> Result<Vec<u8>> + Send + Sync>;

/// 스칼라 직결(raw) 핸들러 — postcard 인코딩/디코딩을 완전히 건너뛴다.
/// 인자는 64비트 슬롯(f64는 비트 재해석, 정수는 값 그대로)로 전달되고
/// 결과도 동일하게 64비트 하나로 돌아온다. 필드 종류는 `RawFieldKind`
/// 시퀀스가 정의한다(호스트와 코어가 같은 순서로 비트를 해석한다).
pub(crate) type RawHandler = Arc<dyn Fn(&[u64]) -> Result<u64> + Send + Sync>;

/// raw 직결이 다루는 스칼라 필드 종류 — JS/C++/Rust 3면이 공유한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RawFieldKind {
    /// 지그재그 부호 정수(i8–i64) — 슬롯에 값 그대로.
    Zigzag,
    /// 플레인 varint 무부호(u8–u64) — 슬롯에 값 그대로.
    Uvar,
    /// f64 — 슬롯에 IEEE-754 비트.
    F64,
    /// f32 — 정밀도 손실 없이 f64로 전달(호스트가 이미 double 로 받는다).
    F32,
    /// bool — 0/1.
    Bool,
}

impl RawFieldKind {
    /// 스키마 표현(코드젠/라이브 스키마와 동일 문자열).
    pub fn from_schema_kind(kind: &str) -> Option<Self> {
        match kind {
            "zigzag" => Some(Self::Zigzag),
            "uvar" => Some(Self::Uvar),
            "f64" => Some(Self::F64),
            "f32" => Some(Self::F32),
            "bool" => Some(Self::Bool),
            _ => None,
        }
    }
}

/// u64 슬롯 ↔ f64 비트 재해석 — raw 직결의 기본 변환기.
pub fn u64_from_f64(value: f64) -> u64 {
    value.to_bits()
}

pub fn f64_from_u64(bits: u64) -> f64 {
    f64::from_bits(bits)
}

pub(crate) type BinIntoHandler =
    Arc<dyn Fn(&[u8], &mut [u8]) -> Result<DirectResponse> + Send + Sync>;

/// caller-buffer dispatch 결과. 작은 응답은 호스트 버퍼에 직접 기록하고, 용량이
/// 부족한 응답만 한 번 할당해 probe cache로 넘긴다(핸들러 재실행 방지).
pub(crate) enum DirectResponse {
    Written(usize),
    Buffered(Vec<u8>),
}
pub(crate) type DecodeFn = Arc<dyn Fn(&[u8]) -> Result<Value> + Send + Sync>;
pub(crate) type EncodeFn = Arc<dyn Fn(&Value) -> Vec<u8> + Send + Sync>;
