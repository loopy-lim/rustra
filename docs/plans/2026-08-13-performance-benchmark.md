# rustra-bridge 성능 벤치마크

- **상태:** Benchmark. rustra-bridge 전송 계층 + 와이어포맷 직렬화 계층의 측정 결과.
- **날짜:** 2026-08-13
- **환경:** Apple M1 Max (10 cores), macOS, rustc 1.95.0, Node.js v22.21.1, Bun 1.3.6.
- **재현:** `node scripts/transport-bench.mjs` / `bun scripts/transport-bench.mjs` / `cargo run -p rustra-calculator-example --bin wire-bench --release`.

> 모든 수치는 `addNumbers(42, 58) → 100` 단일 호출. release 빌드. 2회 실행으로 안정성 확인.

---

## 1. 전송 계층 비교 (JS ↔ Rust 경계)

같은 JSON 경로를 4가지 전송으로 비교. 네이티브(FFI/napi)가 subprocess 대비 **~150–203x 빠름**.

| 전송               |     avg |     p50 |     p99 |  ops/s | 비고                            |
| ------------------ | ------: | ------: | ------: | -----: | ------------------------------- |
| Node.js subprocess | 3.10 ms | 3.05 ms | 4.04 ms |    323 | 프로세스 스폰 + stdio JSON      |
| Node napi-rs       | 15.3 µs | 14.6 µs | 25.6 µs | 65,467 | 네이티브 addon, **203x** 빠름   |
| Bun subprocess     | 2.82 ms | 2.77 ms | 3.73 ms |    354 | Bun 런타임 스폰                 |
| Bun FFI            | 19.0 µs | 18.6 µs | 28.3 µs | 52,495 | `bun:ffi` dlopen, **148x** 빠름 |

**결론:** 프로세스 스폰(~3ms)은 호출당 고정 비용이 너무 크다. 모바일/데스크톱 네이티브(Lynx NativeModule, Tauri)는 항상 in-process FFI 경로 — 즉 napi/FFI 수치(15–19µs)가 현실적인 기준선.

---

## 2. 와이어포맷(직렬화) 계층 비교 — ★ 핵심

Rust 코어 비용(직렬화 + 디스패치 + 역직렬화)만 분리 측정. JS↔FFI 경계 노이즈 제외.
`examples/calculator/src/bin/wire-bench.rs`, 100,000 회.

| 포맷        | FFI 심볼          |         avg |     p50 |     p99 |       ops/s |    요청 | 응답 |
| ----------- | ----------------- | ----------: | ------: | ------: | ----------: | ------: | ---: |
| **JSON**    | `invoke`          |     2.42 µs | 2.38 µs | 2.71 µs |     413,546 |    47 B | 34 B |
| postcard    | `invoke_postcard` |     1.66 µs | 1.62 µs | 1.89 µs |     600,810 |    13 B |  4 B |
| **rkyv V2** | `invoke_rkyv_v2`  | **1.30 µs** | 1.29 µs | 1.46 µs | **769,906** | **4 B** | 10 B |

**rkyv V2 fast-path 우위 (JSON 기준):**

- **속도 1.86x 빠름** — 2.42µs → 1.30µs, ops/s 413K → 770K
- **요청 페이로드 11.75x 작음** — 47B → 4B (`[cmd_id u16][postcard {a,b}]`)
- **응답 3.4x 작음** — 34B → 10B (`[ok u8][7B pad][postcard out]`)
- p99 변동도 가장 낮음 (1.46µs, 일관된 지연)

> postcard도 JSON 대비 1.46x 빠르지만, rkyv V2는 cmd_id 기반 정적 라우팅(문자열 키 조회 없음)으로
> 더 빠르고 페이로드도 더 작음. design 의 fast-path 선택 근거.

---

## 3. 병목 위치 분석

전송 계층(napi 15.3µs)과 코어(rkyv V2 1.30µs)를 대조하면 비용이 어디 있는지 보인다.

```
Node napi-rs 전체      15.3 µs  ████████████████████████████████
  ├─ Rust 코어 (rkyv V2)  1.3 µs  ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (~8%)
  └─ napi 브릿지 오버헤드 ~14 µs  ████████████████████████████████  (~92%)
```

- **JS↔FFI 브릿지(napi)가 전체의 ~92%.** 직렬화 포맷 선택의 영향(1.3µs 차이)은 브릿지 앞에서 상대적으로 작다.
- **하지만 Lynx 모바일(iOS Obj-C JSI / Android JNI)과 Tauri 데스크톱은 napi가 아니다** — NativeModule 의 `invokeRkyvV2(ByteArray)` 는 더 얕은 브릿지. 거기선 코어 비용(1.3µs)의 비중이 훨씬 크므로 rkyv V2 선택이 직접적으로 드러남.
- **와이어 크기(4B vs 47B)는 속도와 무관하게 독립적 가치:** 모바일 네트워크/IPC, 빈번한 호출(스크롤 이벤트), 배터리에 유리. 11.75x 축소는 벤치마크 머신과 무관하게 항상 성립.

---

## 4. 요약

| 측정          | 승자                | 근거                                       |
| ------------- | ------------------- | ------------------------------------------ |
| 전송 계층     | in-process FFI/napi | subprocess 대비 150–203x                   |
| 와이어포맷    | **rkyv V2**         | JSON 대비 1.86x 빠름, 11.75x 작은 페이로드 |
| 현실적 기준선 | napi/FFI 15–19µs    | Lynx/Tauri 네이티브 경로의 상한 추정치     |

rustra-bridge 의 rkyv V2 fast-path(spike 9/52/95 바이트 시퀀스로 4플랫폼 증명)는 속도·크기 양쪽에서 JSON 경로를 일관되게 상회하며, 코어 비용 1.30µs / 770K ops/s 로 네이티브 UI 프레임의 per-frame 호출 예산(16ms @60fps)에 여유.

## 5. 재현

```sh
# 전송 계층 (Node)
npm run bench
# 전송 계층 (Bun FFI)
npm run bench:bun
# 와이어포맷 코어 (★ 본 세션 추가)
cargo run -p rustra-calculator-example --bin wire-bench --release
```

`wire-bench.rs` 는 `invoke` / `invoke_postcard` / `invoke_rkyv_v2` FFI 심볼을 각각 100K 회 직접 호출해 코어 직렬화 비용을 분리 측정한다.
