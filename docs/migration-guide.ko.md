[English](./migration-guide.md)

# 계약 마이그레이션 가이드

Rust 백엔드와 TypeScript 클라이언트가 공유하는 계약(schema)이 시간이 지나며
변할 때, 파괴적 변경(breaking change)을 안전하게 롤아웃하는 방법을 정리한다.

## 버전별 시작 지점

- **0.3.x에서 올라오는 경우** — 먼저 [0.3에서 0.4로 마이그레이션](migrations/0.3-to-0.4.ko.md)을 따른 뒤 이 가이드를 쓴다.
- **0.5.x에서 올라오는 경우** — 먼저 [0.5에서 0.6으로 마이그레이션](migrations/0.5-to-0.6.ko.md)을 따른다. 오래된 스키마는 CLI 검증에서 "generic type name" 오류로 실패할 수도 있다([Rust API 가이드 — 사용자 정의 제네릭](rust-api-guide.ko.md#사용자-정의-제네릭-타입)) — `rustra diff` 전에 현재 rustra로 `schema.json`을 재생성한다.
- **0.6~0.9에서 올라오는 경우** — Rust 0.10 경계를 넘을 때 [Frame/API 마이그레이션](migrations/post-0.9-frame-and-audit.ko.md)을 함께 적용한 뒤 아래 레시피를 쓴다.
- **rkyv V2 → Frame 리네임(0.10.0 릴리스)** — 아래 [리네임 표](#frame-리네임-rkyv-v2--frame) 참고. 순수 이름 변경이며 와이어 포맷은 불변이다.

<a id="09-리네임-rkyv-v2--frame"></a>

## Frame 리네임: rkyv V2 → Frame

0.10.0 릴리스(2026-09-12)가 구칭 "rkyv V2"로 불리던 바이너리 프로토콜을 모든
API에서 **Frame**으로 이름 바꾼다. 이름 변경만 있을 뿐 와이어 바이트, 프레이밍,
postcard 페이로드 코덱은 불변이다. API 이름과 native 심벌은 바뀌므로
[릴리스 마이그레이션](migrations/post-0.9-frame-and-audit.ko.md)에 따라 생성물과
native 라이브러리·셸을 함께 갱신해야 한다. 패키지 버전은 독립이라 리네임의 귀속점은 단일 버전 번호가 아니라 릴리스다: Rust 워크스페이스와
`@rustra/types`/`@rustra/node`/`@rustra/bun`/`@rustra/cli`는 0.10.0으로,
`@rustra/tauri`와 `@rustra/react-native`는 각자의 0.9.0에 같은 리네임을 실었다 —
0.9.x 어댑터 버전만으로 리네임 전을 뜻하지 않는다. 참조하는 식별자를 다음처럼
갱신한다:

| 구(리네임 전)                          | 신(리네임 릴리스)                    |
| -------------------------------------- | ------------------------------------ |
| `createRkyvV2Engine`                   | `createFrameEngine`                  |
| `RkyvV2Engine`                         | `FrameEngine`                        |
| `RkyvV2Codec`                          | `FrameCodec`                         |
| `RkyvV2Native`                         | `FrameNative`                        |
| `RkyvV2SchemaNative`                   | `FrameSchemaNative`                  |
| `invokeRkyvV2`                         | `invokeFrame`                        |
| `rkyv-codecs.ts`                       | `frame-codecs.ts`                    |
| `rkyv-registry.ts`                     | `frame-registry.ts`                  |
| `rkyv-engine`                          | `frame-engine`                       |
| `rustra_ffi_invoke_rkyv_v2*`           | `rustra_ffi_invoke_frame*`           |
| `decode_rkyv_v2_response`              | `decode_frame_response`              |
| `encode_rkyv_v2_error`                 | `encode_frame_error`                 |
| `decode_rkyv_v2_error_parts`           | `decode_frame_error_parts`           |
| `BUN_RKYV_V2_ENGINE_SUPPORTS`          | `BUN_FRAME_ENGINE_SUPPORTS`          |
| `REACT_NATIVE_RKYV_V2_ENGINE_SUPPORTS` | `REACT_NATIVE_FRAME_ENGINE_SUPPORTS` |
| 에러 접두어 `"rkyv v2: ..."`           | `"frame: ..."`                       |
| debug transport 리터럴 `'rkyv'`        | `'frame'`                            |

RN JSI 호스트 메서드도 같은 리네임을 따른다(`invokeRkyvV2` → `invokeFrame`),
그리고 codegen 산출 파일도 새 이름(`frame-codecs.ts`, `frame-registry.ts`)으로
떨어진다 — `rustra codegen`을 다시 실행하고 import를 갱신한다.

현재 소스의 다음 CLI 패치에서는 이전 `.rustra-generated.json`에 기록된 hash가
일치하는 구형 생성물을 정리한다. 아직 공개된 CLI 0.11.3에는 이 수정이 없으므로
타입 검사에서 남은 `rkyv-codecs.ts`/`rkyv-registry.ts`도 확인해야 한다.
이전 CLI 실행으로 manifest가 이미 덮어써졌다면, 업그레이드 전 생성물과
manifest 묶음을 복원한 뒤 수정된 CLI로 다시 생성하거나 남은 파일의 내용을
직접 검토해 옮긴다. 사용자 수정·symlink·소유 기록 없는 파일은 자동 삭제하지 않는다.
`codegen --check`는 남은 구형 파일을 실패로 알리며 아무 파일도 지우지 않는다.

RN 모노레포에서는 기존 루트 workspaces에 앱과 생성 모듈을 등록한다.
수정된 CLI는 루트 설정을 재사용한다. 이전 실행이 앱 package.json에 불필요한
중첩 workspaces를 추가했다면 원래 앱 manifest와 비교해 정리한다. CLI는
사용자 정의 workspace 설정을 임의로 제거하지 않는다.

## 도구

### `rustra diff`

두 스키마 버전을 비교해 breaking change를 검출한다. CI 게이트로 쓸 수 있게
breaking이 있으면 exit 1을 반환한다. exit 2는 명령 자체를 잘못 호출했다는
뜻(예: `--old`/`--new` 누락)이므로 CI job이 설정 실수와 실제 breaking을 구분할 수 있다.

```bash
# 텍스트 출력
rustra diff --old ./generated/schema.v1.json --new ./generated/schema.json

# 기계 판독 — { "schemaVersion": 1, "breaking": [...], "clean": boolean }
rustra diff --old ./generated/schema.v1.json --new ./generated/schema.json --format json
```

### 감지되는 breaking change 타입

| 타입                    | 의미                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command_removed`       | 커맨드 삭제                                                                                                                                                                                                                        |
| `command_id_changed`    | 커맨드의 숫자 id가 이동(`from` → `to`) — by-id 호출이 전부 갈라진다                                                                                                                                                                |
| `field_removed`         | input/output 필드 삭제                                                                                                                                                                                                             |
| `field_type_changed`    | 필드 타입 변경(`from` → `to`)                                                                                                                                                                                                      |
| `required_field_added`  | 필수 필드 신규 추가(구 페이로드에 없던 필드)                                                                                                                                                                                       |
| `field_became_required` | 기존 선택 필드가 필수로 바뀜                                                                                                                                                                                                       |
| `field_became_optional` | 기존 필수 필드가 선택으로 바뀜                                                                                                                                                                                                     |
| `definition_removed`    | 스키마가 참조하던 중첩 타입 정의(`definitions`/`$defs`) 삭제                                                                                                                                                                       |
| `event_removed`         | 이벤트 삭제                                                                                                                                                                                                                        |
| `event_payload_changed` | 이벤트 페이로드 변경. 페이로드 내부의 필드 수준 발견은 각각 `path`, `before`, `after`를 가진 항목 하나로 접힌다 — 새 필수 필드는 `(absent)` → `(required)`, `(present)` → `(removed)`, `(optional)` → `(required)`, 또는 타입 이름 |

아래 레시피는 가장 자주 만나는 커맨드 측 4종을 다룬다. 이벤트·정의 항목도 같은 롤아웃
순서를 따른다(이벤트 계약은 [events-and-channels.ko.md](events-and-channels.ko.md) 참고).

## Breaking change별 해결 레시피

Frame/postcard는 구조체 필드를 위치 순서대로 인코딩한다. 필드 순서, 정수의
signedness, 실수 크기, enum 순번, tuple 위치, optional 필드 존재 여부 모두
wire 계약이다. `Option<T>`나 `#[serde(default)]`를 추가해도 바이너리 변경이
하위호환으로 바뀌지 않는다. `skip_serializing_if`도 위치 기반 바이너리의
마이그레이션 수단으로 사용할 수 없다.

### 필드 삭제·타입 변경·필드 추가

기존 명령의 입출력 구조를 유지하고 별도 ID를 가진 버전별 명령을 추가한다.
새 입출력을 공통 도메인 로직으로 변환하며, 이전 소비자가 사라질 때까지
기존 이름과 ID는 이전 구조로 처리한다. 필드나 enum 순서 변경도 타입 변경과
같이 취급한다. optional 필드 추가 역시 wire 파괴 변경으로 보고한다.

JSON 전용 transport에서는 `serde(default)`로 생략된 필드를 수용할 수 있다.
정확한 이전·이후 JSON 소비자로 검증해야 하며, 이 결과는 생성된 Frame,
postcard, native typed 호출의 호환성 근거가 아니다.

### 커맨드 삭제

새 명령을 추가하는 동안 기존 명령을 유지한다. 이름 별칭만으로는 숫자 ID나
이전 wire 구조를 보존하지 못한다. 이전 생성 클라이언트로 이름 경로와
ID 경로를 모두 확인한다.

## 롤아웃 순서와 contract hash

`GENERATED_CONTRACT_HASH`는 생성된 계약을 식별한다. `contractHash`를 전달하면
`createFrameEngine`이 native hash를 검증하며 생성된 호스트 진입점은 이 검사를
설정한다. 마이그레이션에서도 strict 검증을 유지한다. `warn`·`off`는 검증
강도를 바꿀 뿐 호환성을 제공하지 않으며 이전 바이너리 구조를 안전하게 만들지 않는다.

1. 이전 JS/Rust lockfile, 생성물, native 빌드를 보존한다.
2. [호환성 표](compatibility-matrix.ko.md)에 맞춰 CLI, 어댑터, Rust 의존성을
   맞춘다. 계약과 모든 binding을 재생성하고 앱별 native 라이브러리와 셸을 재빌드한다.
3. `rustra diff`, `rustra doctor`, `rustra codegen --check`를 실행한다. 대상
   호스트에서 첫 호출, 변경 필드, 선언 에러, 이벤트 구독·해지, 종료를 확인한다.
   diff 통과만으로 런타임 수락을 대신하지 않는다.
4. JS·생성물·native 빌드를 한 묶음으로 배포한다. 버전이 섞이는 점진 배포는
   명시적 버전 협상·변환 경로를 먼저 구현하고 검증해야 한다. hash 불일치를 우회하지 않는다.
5. 롤백할 때 보존한 전체 묶음을 복원하고 같은 호출을 반복한다. JS 의존성만
   되돌려서는 native 심벌이나 wire 호환성을 복원할 수 없다.

## CI 통합

스키마 변경이 breaking인지 PR 에서 자동으로 확인한다:

```yaml
# .github/workflows/ci.yml 에 추가
- uses: actions/checkout@v4
  with:
    fetch-depth: 0 # rustra diff가 베이스 커밋과 비교하므로 전체 히스토리 필요
- uses: oven-sh/setup-bun@v2
- run: bun install -g @rustra/cli # 또는: bun add -d @rustra/cli + bunx --bun rustra
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

- 중첩·재귀 참조, union, tuple, map 값과 위치 기반 wire 속성을 보수적으로
  비교한다. 따라서 JSON 전용 경로에서는 허용할 변경도 breaking으로 보고할 수 있다.
- 동작 의미, native ABI, schema에 드러나지 않는 사용자 serde 구현의 호환성은
  이 도구만으로 증명할 수 없다.
- 이벤트 추가는 `compatible[]`에 나타나지만 optional 필드 추가는 그렇지 않다.
  package ID, 지원 역량, 최종 native 빌드는 별도 런타임 검증이 필요하다.
