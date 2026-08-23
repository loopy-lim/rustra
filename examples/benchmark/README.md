# 벤치마크

rustra-bridge 성능 측정: 코드 생성 속도, invoke 오버헤드, 페이로드 확장성.

## 빌드

```sh
cargo build --release -p rustra-benchmark
```

## 실행

```sh
cargo run --release -p rustra-benchmark
```

최적화 반복 중에는 전체 payload 스케일링을 기다리지 않고 hot path만 빠르게
재측정할 수 있습니다.

```sh
cargo run --release -p rustra-benchmark -- --hot-path-only
```

## 측정 항목

1. **코드 생성 속도** — `schema.json`, `types.ts`, `commands.ts` 생성 시간
2. **Invoke 오버헤드** — 다양한 페이로드 크기별 명령어 실행 지연 시간
3. **처리량** — 페이로드 크기별 초당 작업 수

## JS 벤치마크

```sh
bun scripts/adapter-bench.mjs
```

이 스크립트는 네이티브 성능이 아니라 JSON 파싱과 mock EngineClient의 순수 JS
비용만 측정합니다. 실제 브릿지 비교는 `bun scripts/transport-bench.mjs`, Rust
Tier 비교는 Criterion 벤치마크를 사용합니다.
