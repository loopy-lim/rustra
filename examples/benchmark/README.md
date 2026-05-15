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

## 측정 항목

1. **코드 생성 속도** — `schema.json`, `types.ts`, `commands.ts` 생성 시간
2. **Invoke 오버헤드** — 다양한 페이로드 크기별 명령어 실행 지연 시간
3. **처리량** — 페이로드 크기별 초당 작업 수

## JS 벤치마크

```sh
node scripts/adapter-bench.mjs    # Node.js
bun scripts/adapter-bench.mjs     # Bun
```

JSON 파싱 오버헤드, mock EngineClient 처리량, 페이로드 크기 확장 (1KB–1MB), 동시성(Promise.all)을 측정합니다.
