# 계약 마이그레이션 가이드

Rust 백엔드와 TypeScript 클라이언트가 공유하는 계약(schema)이 시간이 지나며
변할 때, 파괴적 변경(breaking change)을 안전하게 롤아웃하는 방법을 정리한다.

## 도구

### `rustra diff`

두 스키마 버전을 비교해 breaking change를 검출한다. CI 게이트로 쓸 수 있게
breaking이 있으면 exit 1을 반환한다.

```bash
# 텍스트 출력
rustra diff --old ./generated/schema.v1.json --new ./generated/schema.json

# 기계 판독 (DiffResult JSON)
rustra diff --old ./generated/schema.v1.json --new ./generated/schema.json --format json
```

### 감지되는 breaking change 4종

| 타입                   | 의미                   |
| ---------------------- | ---------------------- |
| `command_removed`      | 커맨드 삭제            |
| `field_removed`        | input/output 필드 삭제 |
| `field_type_changed`   | 필드 타입 변경         |
| `required_field_added` | 필수 필드 신규 추가    |

## Breaking change별 해결 레시피

### field_removed — 필드 삭제

삭제 대신 **deprecated 2단계 전환**을 권장한다:

```rust
// 1단계: 필드를 Option 으로 남기고 클라이언트가 마이그레이션할 시간을 준다
pub struct UserOutput {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>, // deprecated — name 을 사용
}

// 2단계 (다음 릴리스): 필드 제거 — 이때 diff 는 field_removed 를 보고한다
```

즉시 삭제해야 한다면 TS 클라이언트를 먼저 재생성해 해당 필드 참조를 제거한
뒤 Rust 를 배포한다.

### field_type_changed — 타입 변경

중간 신규 필드를 두는 2단계 전환:

```rust
// before
pub struct Config { pub timeout: i64 }

// 1단계: 새 필드 추가 + 기존 필드 deprecated
pub struct Config {
    #[serde(default)]
    pub timeout_ms: i64,           // new
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<i64>,      // deprecated (초 단위)
}

// 2단계: 구 필드 제거
```

### required_field_added — 필수 필드 추가

`Option<T>` + `#[serde(default)]`로 시작하면 breaking이 아니다:

```rust
pub struct SearchInput {
    pub query: String,
    #[serde(default)]                    // 기본값 있음 → 필수 아님
    pub limit: Option<i64>,              // 클라이언트가 안 보내도 OK
}
```

필수여야 하는 의미라면, 기본값을 가진 상태로 배포한 뒤 다음 버전에서
기본값을 제거하는 2단계로 간다.

### command_removed — 커맨드 삭제

별칭으로 하위호환을 유지할 수 있다:

```rust
#[command(name = "oldName")]
fn new_name(input: NewInput) -> Result<NewOutput> { /* ... */ }
```

새 이름 커맨드를 추가하고 구 이름을 별칭으로 남겨두면, 클라이언트가
자연스럽게 이전한 뒤 별칭을 제거한다.

## 롤아웃 순서와 contract hash

`contract.ts`의 `GENERATED_CONTRACT_HASH`는 스키마 전체의 SHA-256이다.
스키마가 바뀌면 hash가 바뀐다. `createRkyvV2Engine`에 `contractHash` 옵션을
전달하면 런타임에 네이티브 해시와 비교해 불일치 시 즉시 실패한다(fail-fast).

**안전한 배포 순서 (기본):**

1. Rust 백엔드 배포 — **추가 전용(additive) 변경**이면 기존 클라이언트와 호환된다.
   (`rustra diff`가 breaking 0을 보고하는 상태)
2. TS 클라이언트 재생성 (`npm run codegen`) 후 배포.

**breaking 변경이 불가피할 때 (역방향 불가 — 항상 신규 클라이언트 먼저):**

1. 새 스키마를 수용하는 Rust 를 배포하되, 구 스키마 요청도 받아들이게 한다
   (위 레시피의 `#[serde(default)]` 패턴이 이 역할을 한다).
2. TS 클라이언트 재생성·배포.
3. 구 필드/커맨드를 제거한 Rust 를 배포 (이때 `field_removed`가 의도적으로 발생).

> contractHash 검증을 켜둔 환경에서는 1→2 사이에 hash 불일치 에러
> (`contract.mismatch`)가 날 수 있으므로, 마이그레이션 기간에는 검증을
> 끄거나 2단계로 hash 를 갱신한다.

## CI 통합

스키마 변경이 breaking인지 PR 에서 자동으로 확인한다:

```yaml
# .github/workflows/ci.yml 에 추가
- name: Check schema compatibility
  run: |
    git diff --name-only ${{ github.event.before }} ${{ github.sha }} | grep -q schema.json \
      && rustra diff --old <(git show ${{ github.event.before }}:generated/schema.json) \
                     --new generated/schema.json
```

breaking이 감지되면 exit 1로 job이 실패한다. 의도된 breaking이면
`docs/migration-guide.md`의 레시피로 2단계 전환하거나, 리뷰에서 명시적으로
승인한다.

## 제한

- `diffSchemas`는 최상위 `properties`만 비교한다 — 중첩 `$ref` 정의 내부의
  변경은 검출하지 않는다 (개선 후보).
- `compatible[]` 목록은 새 커맨드/선택적 필드 추가를 보고한다.
