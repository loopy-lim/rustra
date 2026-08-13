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

| 측정          | 승자                 | 근거                                        |
| ------------- | -------------------- | ------------------------------------------- |
| 전송 계층     | in-process FFI/napi  | subprocess 대비 150–203x                    |
| 와이어포맷    | **rkyv V2**          | JSON 대비 1.86x 빠름, 11.75x 작은 페이로드  |
| 현실적 기준선 | napi/FFI 15–19µs     | Lynx/Tauri 네이티브 경로의 상한 추정치      |
| Lynx 런타임   | ~50µs/call (QuickJS) | Node(V8) 15.3µs 의 ~3.3x; 코어 1.3µs(~2.6%) |

rustra-bridge 의 rkyv V2 fast-path(spike 9/52/95 바이트 시퀀스로 4플랫폼 증명)는 속도·크기 양쪽에서 JSON 경로를 일관되게 상회하며, 코어 비용 1.30µs / 770K ops/s 로 네이티브 UI 프레임의 per-frame 호출 예산(16ms @60fps)에 여유.

---

## 5. Lynx 런타임(QuickJS) end-to-end 실측 — ★ 본 세션 추가

§1–§3 은 Node(V8)/Bun 과 Rust 코어 위주. 실제 Lynx 런타임(QuickJS)에서 `addNumbers` rkyv V2 왕복이 얼마인지를 데스크톱 스파이크(`examples/lynx-tauri-spike`)에서 실측했다. 이 경로는 **Lynx desktop N-API**(모바일 iOS JSI / Android JNI 와는 다름).

**측정 방법:** App.tsx 에서 warmup 50회 후 `addNumbers(20,22)` 500회 연속 `await` 배치. JS end-to-end 는 배치 총시간/N (신뢰). host侧 `InvokeRkyvV2` 핸들러 본체(진입→리턴)는 `std::chrono` 로 per-call ns 누적 후 p50/p99. 3회 실행.

> **QuickJS 제약:** `performance.now()` 미지원(`js.hires=0` 확인) → JS 개별 호출 p50/p99 는 `Date.now()` 양자화로 무의미해 suppressed. **배치 avg(총시간/N) 만 신뢰** 가능한 JS 수치. 단, 개별 `Date.now()` avg 가 배치 avg 와 거의 일치(48 vs 50, 46 vs 46, 66 vs 66)해 ~50µs/call 이 실제임을 교차 검증.

| 경로                             |        avg |        p50 |      p99 |   ops/s | 비고                          |
| -------------------------------- | ---------: | ---------: | -------: | ------: | ----------------------------- |
| Node napi-rs (V8) end-to-end     |    15.3 µs |    14.6 µs |  25.6 µs |  65,467 | §1 기준선(V8)                 |
| **Lynx QuickJS end-to-end**      | **~50 µs** |         —¹ |       —¹ | ~20,000 | **배치 avg**, 3회 46/50/66µs  |
| Lynx host 핸들러 본체(N-API+FFI) |   ~9.7 µs² | **7.0 µs** | 31–48 µs |       — | p50 6.6/7.0/7.3µs (3회, 안정) |
| Rust core rkyv V2 (§2)           |     1.3 µs |     1.3 µs |   1.5 µs | 769,906 | 코어만                        |

¹ QuickJS `performance.now()` 미지원으로 개별 p50/p99 측정 불가.
² avg 는 꼬리(p99 31–48µs) 에 민감 — p50(7.0µs) 이 "전형적" 네이티브 핸들러 비용.

**Lynx end-to-end 병목 분해 (p50 기준):**

```
Lynx QuickJS end-to-end   ~50 µs  ████████████████████████████████   (100%)
  ├─ host 핸들러 본체       ~7 µs  ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░   (~14%)
  │    └─ Rust core rkyv   1.3 µs  █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   (~2.6%)
  └─ QuickJS 오버헤드      ~43 µs  ████████████████████████████████   (~86%)
       (Promise/마이크로태스크 스케줄링 + weak-N-API ArrayBuffer 마샬링)
```

**결론:**

- **Lynx(QuickJS) end-to-end ~50µs/call ≈ Node(V8) 15.3µs 의 ~3.3x.** 차이의 대부분(~43µs) 은 QuickJS 해석 실행 + Promise 마이크로태스크 스케줄링 + weak-N-API 값 마샬링이지, Rust/rustra 코어(1.3µs) 가 아니다.
- **host 핸들러 본체 p50 7.0µs** 중 Rust 코어(rkyv V2) 는 1.3µs(~18%). 나머지 ~5.7µs 가 N-API 인자 언팩 + ArrayBuffer 2회 alloc/copy + free — Lynx desktop 의 weak-N-API 가 ArrayBuffer 한 왕복에 지불하는 비용.
- **코어 비용(1.3µs)은 Lynx end-to-end(50µs) 의 ~2.6% 로 Node(8%) 보다 더 작다.** 즉 Lynx desktop 에선 직렬화 포맷 선택(rkyv vs JSON, 1.3µs 차)이 end-to-end 에 미치는 영향이 더 작다. **단, 페이로드 4B vs 47B(11.75x) 크기 이점은 벤치마크 머신과 무관하게 독립적 가치**(네트워크/IPC/배터리)로 그대로 성립.
- **모바일(iOS JSI / Android JNI) 은 본 데스크톱 N-API 경로보다 얕은 브릿지** → 코어 비용 비중이 더 크므로 rkyv V2 우위가 직접 드러날 것으로 예상. 본 macOS 머신에서는 측정 불가(정직 연기).

> per-frame 예산(16ms @60fps) 대비 ~50µs/call = 0.3%. 한 프레임에 수백 번 호출해도 여유. 스크롤/제스처 같은 빈번 per-frame 호출 시에는 JS 엔진 오버헤드(~43µs) 가 누적되므로 호출 수 합산이 설계 기준.

## 6. 재현

```sh
# 전송 계층 (Node)
npm run bench
# 전송 계층 (Bun FFI)
npm run bench:bun
# 와이어포맷 코어 (★ 본 세션 추가)
cargo run -p rustra-calculator-example --bin wire-bench --release
# Lynx 런타임(QuickJS) end-to-end (★ 본 세션 추가)
cd examples/lynx-tauri-spike && npm run build && bash build-lynx-host.sh && ./verify.sh
#  → stderr 에서 [bench] js.* (end-to-end) / [bench] host.* (핸들러 본체 p50/p99) 확인
```

`wire-bench.rs` 는 `invoke` / `invoke_postcard` / `invoke_rkyv_v2` FFI 심볼을 각각 100K 회 직접 호출해 코어 직렬화 비용을 분리 측정한다. Lynx 런타임 측정은 App.tsx 의 warmup+배치 루프가 `[bench] js.*` 를, host `InvokeRkyvV2` 의 chrono 누적이 `lynx_spike_summary` 에서 `[bench] host.*` 를 출력한다.
