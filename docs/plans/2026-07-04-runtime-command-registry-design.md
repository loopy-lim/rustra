# Runtime Command Registry — Design

> 날짜: 2026-07-04
> 목표: `Package`를 런타임에 add/remove/replace 가능하게 만들어, 프로그램이 동적으로 변경 가능하도록 한다.
> 접근: **하이브리드** — 단일 `Package` 타입 유지 + runtime mutation API + `frozen` 플래그.
> 모드 분리: **Cargo debug/release 프로파일** (`debug_assertions`). debug = mutable, release = frozen.

---

## 1. 배경

현재 `Package`는 `.build()` 시점에 명령 집합이 `Arc<BTreeMap<String, Command>>`로 **고정**된다.
실행 중에는 명령 추가/삭제/교체가 불가능하다. 본 설계는 런타임 가변성을 추가하되:

- **dev(debug 빌드)**: 런타임 `register`/`unregister`/`replace` 허용 (핫스왑, 테스트, 피처 토글).
- **prod(release 빌드)**: 초기 등록 후 자동 동결 → 불변. 안전하고 빠른 읽기 경로 유지.

---

## 2. 접근 후보

| | 접근 | 장점 | 단점 |
|---|------|------|------|
| **A (채택)** | `Package`에 runtime mutation + `frozen` 플래그 | 단일 타입, 예시 거의 무변경, 점진 도입 | `Package`가 약간 무거워짐 |
| B | 별도 `CommandRegistry` + `Package`는 frozen 뷰 | mutable/immutable 분리 명확 | 타입 2개 → 예시·코드젠 마이그레이션 |
| C | 항상 mutable, freeze 없음 | 단순 | prod 안전성·빠른 읽기 경로 포기 |

---

## 3. 내부 구조

`Package` 내부를 `Arc<BTreeMap>` → `Arc<RwLock<RegistryState>>` + 동결 플래그로 교체.

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};

pub struct Package {
    id: String,
    state: Arc<RwLock<RegistryState>>,
    frozen: AtomicBool,
}

struct RegistryState {
    commands: BTreeMap<String, Command>,
    id_to_name: BTreeMap<u16, String>,
    next_command_id: u16, // 단조 증가. 절대 감소/재사용 금지.
}
```

`Arc<RwLock<_>>`도 `Clone` 가능 → 기존 `Package: Clone + Debug` 계약 유지.

---

## 4. 동결(freeze) 의미론

```rust
impl PackageBuilder {
    pub fn build(self) -> Package {
        let frozen = !cfg!(debug_assertions); // debug→mutable, release→frozen
        Package { id, state: Arc::new(RwLock::new(state)), frozen: AtomicBool::new(frozen) }
    }
}

impl Package {
    /// 명시적 봉인. debug에서 prod 동작을 시뮬레이션하거나, 런타임에 명시적으로 잠글 때 사용.
    pub fn freeze(&self) { self.frozen.store(true, Ordering::Release); }
    pub fn is_frozen(&self) -> bool { self.frozen.load(Ordering::Acquire) }
}
```

---

## 5. 런타임 mutation API

전부 `Result<()>` 반환. frozen 상태면 `RustraError::custom("registry.frozen", ...)`.

```rust
impl Package {
    /// 이름 지정 등록. 같은 이름이면 핸들러를 덮어쓴다(replace, 멱등).
    pub fn register<I, O, F>(&self, name: &str, handler: F) -> Result<()>;
    /// `#[command]` 함수 등록. 이름 자동 추론(`command_name_from_handler`).
    pub fn register_fn<I, O, F>(&self, handler: F) -> Result<()>;
    /// 기존 이름의 핸들러 교체. 없으면 Err.
    pub fn replace<I, O, F>(&self, name: &str, handler: F) -> Result<()>;
    /// 명령 제거. command_id는 retired(재사용 금지).
    pub fn unregister(&self, name: &str) -> Result<()>;
}
```

**release 바이너리에서 mutation 메서드 처리 방침**: 항상 컴파일에 포함하되 frozen=true로 `Err` 반환.
이유: API가 프로파일 무관하게 동일 → 예시 코드가 debug/release 양쪽에서 모두 컴파일됨.
(cfg 게이트하면 prod 바이너리 크기/보안엔 유리하지만 예시가 프로파일마다 갈라짐.)

---

## 6. command_id 안정성 (rkyv V2 바이너리 경로)

- ID는 **단조 증가**, `unregister` 시 **retired**(재사용 금지) → `next_command_id`는 감소하지 않는다.
- TS 측은 이름 기반 호출(`engine.invoke('name', input)`)이 주 경로.
- **정적 등록 명령**(codegen으로 schema.json에 ID 노출) → 기존 rkyv V2 바이너리 fast-path 유지.
- **런타임 등록 명령**(schema.json에 없음) → JSON/이름 경로만 지원. 바이너리 fast-path 미지원(자연스러운 스코핑).

ID 폭은 기존 wire 호환성(`u16`, 페이로드 첫 2바이트) 유지. 동적 churn으로 65535 초과 위험은
문서에 명시하고 초과 시 `Err`로 방어.

---

## 7. 스레드 안전성

- `invoke_*` = 읽기 잠금(`read()`), mutation = 쓰기 잠금(`write()`).
- Tauri `State`·FFI 다중 스레드에서 안전.
- prod 읽기 fast-path: 무경쟁 `RwLock` read ≈ 10ns → 벤치마크(3.8µs) 대비 영향 미미.
  (필요시 `arc-swap` lock-free 스냅샷으로 향후 최적화 가능 — 본 설계 범위 외.)

---

## 8. codegen 연동

`generate_typescript()`은 현재 등록 명령 **스냅샷**(읽기 잠금)으로 생성.
런타임에 추가된 명령도 포함 가능(등록 시점에 schema 생성). 단 사전 codegen된 헬퍼가 없으므로
generic `engine.invoke(name, args)`로 호출.

---

## 9. 에러 모델

`RustraError::custom`로 표현:

| 상황 | code | message 예시 |
|------|------|------|
| frozen 상태에서 mutation 시도 | `registry.frozen` | `"package is frozen; cannot mutate"` |
| `replace`/`unregister` 대상 없음 | `command.not_found` | 기존 재사용 |
| `register` 시 ID 한도 초과 | `registry.id_exhausted` | `"command_id u16 exhausted (65535)"` |

---

## 10. 테스트 전략

**debug 빌드**:
- `register`/`register_fn`/`replace`/`unregister` 정상 동작.
- `freeze()` 호출 후 모든 mutation이 `Err("registry.frozen")`.
- `unregister` 후 retired ID가 재사용되지 않는다(새 등록은 다음 ID).
- 다중 스레드: 동시 `register` + `invoke_json` 혼합 시 데이터 레이스 없음.

**release 빌드** (`cargo test --release` 별도 검증):
- `build()` 직후 `is_frozen() == true`, mutation `Err`.

**회귀**: `calculator`/`crud` 예시 기존 동작 유지(`cargo test --workspace`).

---

## 11. 영향 범위

- `crates/rustra/src/lib.rs`: `Package`/`PackageBuilder` 재구조화, mutation API 추가.
- `crates/rustra/src/error.rs`: 필요 시 helper 추가(`custom` 재사용).
- 단위/통합 테스트 추가.
- `README.md`/`docs/architecture.md`: runtime registry 섹션 추가.
- 예시: (선택) runtime register 데모 추가.
