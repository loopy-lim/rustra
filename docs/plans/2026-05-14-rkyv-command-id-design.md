# rkyv Command ID 직렬화 설계

> **상태**: 구현 완료 — `invoke_rkyv_v2`(`crates/rustra/src/lib.rs`, `[cmd_id: u16 LE][postcard]` 와이어)로 시행.
> 4플랫폼(macOS/iOS/Android/코드 수준 Windows)에서 동일 바이트 시퀀스로 검증 완료. 성능 실측: `docs/plans/2026-08-13-performance-benchmark.md`.
> **브랜치**: `feat/rkyv-command-id` (worktree: `.claude/worktrees/rkyv-command-id`)
> **의존**: `ca1c6ce` (multi-format serialization benchmark)

## 배경

벤치마크에서 5개 직렬화 포맷을 비교한 결과, rkyv가 가장 빠른 성능을 보였다. 하지만 rkyv의 `String` 필드는 TS에서 생성하기 어렵다 (상대 포인터, 정렬, 메타데이터).

**해결**: 명령어 이름 대신 `command_id: u16`를 사용하면 요청/응답 모두 fixed-width가 되어 rkyv를 양방향으로 쉽게 사용할 수 있다.

## 핵심 결정

### DX는 변하지 않는다

```typescript
// 개발자가 작성하는 코드 — 현재와 동일
const result = await addNumbers(engine, { a: 42, b: 58 });
```

코드젠이 생성한 함수 내부에서 `"addNumbers" → command_id = 1` 매핑을 처리한다. 개발자는 command_id의 존재를 모른다.

### 명령어 레지스트리

```typescript
// 코드젠이 생성 (commands.ts)
const COMMAND_IDS = {
  addNumbers: 1,
  // 향후 명령어들은 순차 증가
} as const;

export function addNumbers(
  engine: EngineClient,
  input: AddNumbersInput,
): Promise<AddNumbersOutput> {
  return engine.invoke<AddNumbersOutput>('addNumbers', input);
  // 내부적으로 command_id = COMMAND_IDS.addNumbers = 1 사용
}
```

## Wire Format

### rkyv 요청 (TS → Rust)

`command: String` 대신 `command_id: u16` 사용:

```rust
#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
struct RkyvRequest {
    command_id: u16,
    a: i64,
    b: i64,
}
```

**실제 바이트 레이아웃** (rkyv는 필드를 선언 순서 + 정렬로 배치):

- offset 0: `command_id` u16 LE (2 bytes) + 6 bytes 패딩 (i64 정렬)
- offset 8: `a` i64 LE (8 bytes)
- offset 16: `b` i64 LE (8 bytes)

총 24 bytes. **TS에서 생성하기 매우 간단**:

```typescript
const buf = new ArrayBuffer(24);
const view = new DataView(buf);
view.setUint16(0, commandId, true); // command_id
// Hermes BigInt 미지원 → setInt32 두 개로 i64 처리
view.setInt32(8, a, true); // a low
view.setInt32(12, 0, true); // a high
view.setInt32(16, b, true); // b low
view.setInt32(20, 0, true); // b high
```

> **주의**: 위 오프셋은 Rust 테스트로 검증해야 함. rkyv의 Archived<u16> 정렬은
> u16 자체가 2바이트 정렬이지만, 뒤에 오는 i64가 8바이트 정렬을 요구하므로
> 실제 오프셋이 다를 수 있음. **첫 구현 단계에서 반드시 바이트를 출력해서 확인**.

### rkyv 응답 (Rust → TS)

이미 검증된 레이아웃 (벤치마크에서 측정 완료):

```rust
#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
struct RkyvResponse {
    ok: bool,        // offset 0: 1 byte + 7 bytes 패딩
    value: i64,      // offset 8: 8 bytes LE
    error: Option<String>,  // offset 16: 16 bytes (None)
}
```

총 32 bytes. TS에서 파싱:

```typescript
const u8 = new Uint8Array(buf);
const view = new DataView(buf);
const ok = u8[0] === 1;
const value = view.getInt32(8, true); // 32비트에 들어가는 값이면 충분
```

## 아키텍처

### 전체 흐름

```
TS (개발자)                    TS (어댑터)              JSI Bridge           Rust
───────────                    ──────────              ──────────           ────
addNumbers(engine, {a,b})
  │
  └─→ engine.invoke("addNumbers", {a:42, b:58})
        │
        ├─ command_id = CMD_ID["addNumbers"] // 1
        ├─ 인코딩: [u16=1, pad, i64=42, i64=58] (24B)
        │
        └─→ native.invokeRkyv(arrayBuffer) ──→ C++ JSI ──→ rkyv 디코딩
                                                       │
                                                       ├─ command_id → "addNumbers"
                                                       ├─ calculator_package().invoke_json()
                                                       ├─ rkyv 인코딩: 응답 32B
                                                       │
              TS ←── ArrayBuffer (32B) ←──────────────┘
              │
              ├─ u8[0] === 1 → ok
              ├─ getInt32(8) → value
              └─ return { value: 100 }
```

### Rust command_id 매핑

```rust
fn resolve_command(command_id: u16) -> Option<&'static str> {
    match command_id {
        1 => Some("addNumbers"),
        _ => None,
    }
}
```

코드젠이 이 매핑도 자동 생성한다.

## 구현 계획

### Step 1: Rust 바이트 레이아웃 검증

command_id 기반 RkyvRequest의 실제 바이트 오프셋을 확인하는 테스트 작성.

**파일**: `examples/calculator/src/lib.rs`

```rust
#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
struct CmdRequest {
    command_id: u16,
    a: i64,
    b: i64,
}

#[test]
fn test_cmd_request_wire_format() {
    let req = CmdRequest { command_id: 1, a: 42, b: 58 };
    let bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&req).unwrap();
    println!("CmdRequest hex: {}", bytes.iter().map(|x| format!("{:02x}", x)).collect::<Vec<_>>().join(" "));
    println!("CmdRequest len: {}", bytes.len());

    // 접근해서 값 확인
    let archived = rkyv::access::<ArchivedCmdRequest, rkyv::rancor::Error>(&bytes).unwrap();
    assert_eq!(u16::from(archived.command_id), 1);
    assert_eq!(i64::from(archived.a), 42);
    assert_eq!(i64::from(archived.b), 58);
}
```

**검증 항목**:

- command_id의 실제 offset (0일 수도, 다를 수도 있음)
- a, b의 실제 offset
- 총 바이트 수
- Archived<u16>의 정렬 요구사항

### Step 2: Rust FFI 함수 구현

command_id 기반 rkyv FFI 함수.

**파일**: `examples/calculator/src/lib.rs`

```rust
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_rkyv_v2(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    // 1. rkyv access로 zero-copy 디코드
    // 2. command_id → 명령어 이름 매핑
    // 3. invoke_json 실행
    // 4. rkyv 인코드로 응답
}
```

### Step 3: C++ JSI Bridge 업데이트

**파일**: `modules/rustra-jsi/ios/RustraJSIBridge.hpp`, `.cpp`

`invokeRkyvV2` 메서드 추가 (기존 invokeRkyv 유지).

### Step Step 4: TS 어댑터 구현

**파일**: `src/adapters/rkyv-v2-adapter.ts`

```typescript
// command_id 매핑 (코드젠 생성)
const COMMAND_IDS: Record<string, number> = {
  addNumbers: 1,
};

// 요청 인코딩: fixed-width (Step 1에서 확인한 오프셋 사용)
// 응답 디코딩: 기존과 동일 (offset 0=ok, offset 8=value)
```

codec 레지스트리 패턴:

```typescript
type RkyvCodec<I, O> = {
  encode(commandId: number, args: I): ArrayBuffer;
  decode(buf: ArrayBuffer): { ok: boolean; result?: O; error?: string };
};
```

### Step 5: 코드젠 업데이트 (선택, 이후 작업)

**파일**: `crates/rustra/src/codegen.rs`, `packages/cli/src/generate.ts`

- 각 명령에 자동으로 command_id 할당
- commands.ts에 `COMMAND_IDS` 상수 생성
- Rust에 command_id 매핑 함수 생성

> 이 단계는 프로덕션 적용 시 필요. 벤치마크 검증에서는 수동으로 진행.

### Step 6: 벤치마크 업데이트

**파일**: `BenchmarkApp.tsx`

rkyv-v2 (command_id)를 벤치마크에 추가하여 기존 JSON/msgpack/postcard/pure-rkyv/hybrid와 비교.

## 파일 변경 요약

| 단계 | 파일                                         | 변경                                   |
| ---- | -------------------------------------------- | -------------------------------------- |
| 1    | `examples/calculator/src/lib.rs`             | CmdRequest 구조체 + wire format 테스트 |
| 2    | `examples/calculator/src/lib.rs`             | `rustra_calculator_invoke_rkyv_v2` FFI |
| 3    | `modules/rustra-jsi/ios/RustraJSIBridge.hpp` | `invokeRkyvV2` extern 선언             |
| 3    | `modules/rustra-jsi/ios/RustraJSIBridge.cpp` | `invokeRkyvV2` JSI 메서드              |
| 4    | `src/adapters/rkyv-v2-adapter.ts`            | TS 어댑터 (새 파일)                    |
| 4    | `modules/rustra-jsi/src/index.ts`            | RustraNative 타입에 invokeRkyvV2 추가  |
| 6    | `BenchmarkApp.tsx`                           | rkyv-v2 벤치마크 추가                  |

## 검증된 rkyv Wire Format (참고)

Rust 테스트에서 실제 측정한 값:

```
// RkyvRequest (String command) — 40 bytes, 복잡
rkyv request hex: 61 64 64 4e 75 6d 62 65 72 73 00 00 00 00 00 00 8a 00 00 00 f0 ff ff ff 2a 00 00 00 00 00 00 00 3a 00 00 00 00 00 00 00

// RkyvResponse — 32 bytes, 고정 오프셋
rkyv response hex: 01 00 00 00 00 00 00 00 64 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  offset 0:  ok = 0x01 (true)
  offset 8:  value = 0x64 (100 i64 LE)
  offset 16: error = None (16 bytes zero)

// postcard i64 인코딩 (LEB128 + zigzag)
i64(0)   → 00          (1B)
i64(42)  → 54          (1B, zigzag=84)
i64(58)  → 74          (1B, zigzag=116)
i64(100) → c8 01       (2B, zigzag=200, LEB128)
i64(128) → 80 02       (2B, zigzag=256, LEB128)
```

## Hermes 제약사항

- `DataView.prototype.setBigInt64()` / `getBigInt64()` 미지원
- i64는 `setInt32(lo)` + `setInt32(hi)` 두 번으로 처리
- `WeakRef` / `FinalizationRegistry` 미지원 (msgpackr 불가, @msgpack/msgpack은 안전)
