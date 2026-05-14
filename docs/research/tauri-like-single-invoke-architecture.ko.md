# Tauri-like Single Invoke Architecture

상태: iOS PoC에 적용. 목적은 public API를 나누지 않고 `invoke(command, args)` 하나로 유지하면서, 내부에서 JSON/binary/file-handle 최적화를 선택할 수 있는지 확인하는 것이다.

## 결론

public API를 `invokeJson`, `invokeBinary`, `invokeNumber`처럼 나누는 것은 DX에 치명적이다. 앱 개발자가 transport를 고르는 순간, Rust local engine은 다시 bridge surface를 관리하는 구조가 된다.

따라서 Tauri 패턴처럼 실행 API는 하나로 둔다.

```ts
await RustEngine.invoke('bench.addNumbers', { a: 2, b: 3 });
await RustEngine.invoke('binary.echo', { contentType: 'image/mock', input: bytes });
await RustEngine.invoke('video.transcode', { input: { type: 'file', uri } });
```

내부 구현만 payload 형태에 따라 최적화한다.

| public API                                          | 내부 transport                   | 용도                               |
| --------------------------------------------------- | -------------------------------- | ---------------------------------- |
| `invoke(command, plainObject)`                      | JSON command                     | 일반 상태 조회, 설정, 작은 command |
| `invoke(command, { input: Uint8Array })`            | JSON command + binary attachment | 이미지/문서/압축 blob              |
| `invoke(command, { input: { type: "file", uri } })` | JSON command + file handle       | 영상/대형 파일                     |
| `invoke(command, { ops: [...] })`                   | JSON command batch               | 고빈도 logical operation           |

## 현재 적용된 형태

native Expo Module에는 기존 함수를 그대로 둔다.

```ts
NativeRustEngineModule.invoke(payloadJson);
NativeRustEngineModule.invokeBinary(commandJson, payload);
NativeRustEngineModule.invokeProtobuf(payload);
```

앱이 보는 API는 `RustEngineClient`에서 하나로 감춘다.

```ts
RustEngine.invoke<T>(command, args);
```

`args` 안에 `Uint8Array`가 있으면 wrapper가 첫 번째 binary attachment를 분리한다.

```ts
RustEngine.invoke<Uint8Array>('binary.invert', {
  contentType: 'image/mock',
  input: imageBytes,
});
```

wrapper 내부에서는 JSON command를 만들고, bytes는 Swift `Data` 경로로 따로 보낸다.

```txt
RN JS
  -> RustEngine.invoke(command, args)
  -> RustEngineClient detects Uint8Array
  -> NativeRustEngineModule.invokeBinary(commandJson, bytes)
  -> Swift Data
  -> Rust FFI
  -> Rust command dispatcher
```

## 비용 지점

`invoke` 하나를 유지해도 비용은 사라지지 않는다. 다만 비용이 생기는 위치를 숨기고, command 설계로 관리할 수 있다.

| 비용                            | 대응                                                              |
| ------------------------------- | ----------------------------------------------------------------- |
| Promise/Expo Module 호출 경계   | fine call을 API로 노출하지 않고 coarse command/batch로 설계       |
| JSON stringify/parse            | 작은 command에는 허용, 큰 payload는 attachment/file handle        |
| Rust `serde_json::Value` lookup | 추후 command별 typed struct deserialize로 개선 가능               |
| 문자열 allocation/copy          | response를 작게 유지하고 큰 결과는 bytes/file handle로 반환       |
| binary response 문자열 판별     | 첫 byte가 JSON처럼 보일 때만 decode하고, 일반 bytes는 그대로 반환 |
| 영상급 데이터 copy              | `Uint8Array` 대신 file URI/resource handle 사용                   |

## iOS PoC 측정값

2026-05-13 iPhone 17 iOS 26.2 Simulator, Debug build, RN 앱 내부 측정값이다. `RustEngine.invoke(command, args)` wrapper를 거친 결과다.

| Metric                      |                         호출 |    p50 |    p95 |    p99 |  총 시간 |     처리량 |
| --------------------------- | ---------------------------: | -----: | -----: | -----: | -------: | ---------: |
| JSON `bench.addNumbers`     |             1,000 sequential | 0.07ms | 0.10ms | 0.14ms |  78.72ms | 12,703.7/s |
| JSON `bench.addNumbers`     |  1,000 burst, concurrency 10 | 0.26ms | 0.31ms | 0.55ms |  27.73ms | 36,057.0/s |
| JSON `bench.addNumbersLoop` | 20 calls, each 100K Rust ops | 0.64ms | 0.72ms | 0.72ms |  20.06ms |    996.9/s |
| binary echo                 |              256KB, 50 calls | 0.21ms | 0.44ms | 0.65ms |  25.68ms |  1,946.8/s |
| binary invert               |              256KB, 50 calls | 1.99ms | 2.12ms | 2.41ms | 111.37ms |    448.9/s |
| binary checksum             |                1MB, 20 calls | 3.60ms | 3.88ms | 3.88ms |  83.22ms |    240.3/s |

같은 run에서 HTTP/fetch `addNumbers` 1,000 sequential은 16,665.71ms였다. 즉 single invoke wrapper 경로는 HTTP/fetch 대비 약 212배 빠른 범위에 있다.

```txt
16,665.71ms / 78.72ms = about 212x
```

Protobuf와 비교하면 작은 command에서는 여전히 JSON wrapper가 밀리지 않았다.

| 비교                                    |    결과 |
| --------------------------------------- | ------: |
| JSON wrapper `addNumbers` 1K sequential | 78.72ms |
| Protobuf `addNumbers` 1K sequential     | 82.93ms |
| JSON wrapper `addNumbers` 1K burst      | 27.73ms |
| Protobuf `addNumbers` 1K burst          | 45.27ms |

따라서 지금 단계에서는 Protobuf보다 single invoke DX를 유지하고, 큰 데이터만 bytes/file/resource로 숨겨서 보내는 쪽이 더 낫다.

## 왜 lane을 public으로 나누지 않는가

public lane을 나누면 호출부가 transport 정책을 알아야 한다.

```ts
invokeJson('document.search', params);
invokeBinary('image.resize', params, bytes);
invokeHandle('video.transcode', uri);
```

이 구조는 성능 실험에는 명확하지만 제품 API로는 좋지 않다. command가 늘어날수록 사용자는 어떤 lane을 골라야 하는지 기억해야 하고, 나중에 내부 최적화를 바꾸기도 어렵다.

반대로 single invoke는 command contract만 유지하면 내부 transport를 바꿀 수 있다.

```ts
invoke('image.resize', { input: bytes, width: 512 });
```

오늘은 binary attachment로 처리하고, 나중에는 file handle이나 resource id로 바꿔도 호출부 형태를 크게 유지할 수 있다.

## 다음 개선 후보

1. `Uint8Array` attachment를 1개에서 N개로 확장한다.
2. `type: "file"` / `type: "resource"` handle을 Rust dispatcher에 추가한다.
3. JSON command를 Rust에서 command별 typed struct로 deserialize한다.
4. 고빈도 명령은 `ops: []` batch 형태로 설계한다.
5. response가 큰 경우 `Uint8Array` 또는 file/resource handle을 반환한다.

이 방향이면 Tauri의 `invoke` DX를 유지하면서, Nitro/Craby식 micro-call 최적화와는 다른 “Rust-owned command engine” 형태를 가져갈 수 있다.
