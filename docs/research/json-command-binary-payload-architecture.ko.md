# JSON Command + Binary Payload 구조

상태: 실험 설계 및 iOS PoC 구현. 목적은 Protobuf 대신 JSON command를 유지하면서 이미지/영상 같은 binary 데이터를 string/base64 없이 넘길 수 있는지 확인하는 것이다. public API는 `invoke(command, args)` 하나로 유지하고, binary transport는 wrapper 내부 구현으로 숨긴다.

## 왜 이 구조인가

Protobuf tiny-call 벤치에서는 이득이 없었다. 반대로 JSON native invoke는 충분히 빠르고 관리도 쉽다. 그래서 기본 command contract는 JSON으로 유지하되, 큰 데이터만 bytes로 따로 넘기는 구조가 더 현실적이다.

```txt
RN JS
  -> RustEngine.invoke(command, args)
  -> wrapper가 Uint8Array attachment 감지
  -> JSON command: method, id, params, contentType, options
  -> binary payload: Uint8Array
  -> Expo Module
  -> Swift Data pass-through
  -> Rust FFI
  -> Rust command dispatcher
  -> binary response 또는 JSON metadata response
```

핵심은 JSON에 이미지/영상 본문을 넣지 않는 것이다. JSON은 “무엇을 할지”만 설명하고, 실제 데이터는 `Uint8Array`로 전달한다.

## 잘못된 방향: string/base64만 쓰기

```txt
RN JS
  -> JSON.stringify({
       method: "image.process",
       base64: "...."
     })
  -> Swift String
  -> Rust C string
  -> base64 decode
  -> process
```

문제:

| 문제 | 영향 |
| --- | --- |
| base64 팽창 | 원본보다 약 33% 커짐 |
| JS string allocation | 큰 이미지/영상에서 GC 압박 |
| JSON parse 비용 | 실제 데이터가 커질수록 command parse가 아니라 payload parse가 되어버림 |
| C string 경계 | null byte/binary data와 맞지 않음 |
| streaming 부적합 | 영상처럼 큰 데이터를 한 string으로 들고 있기 어려움 |

## 현재 PoC 방향: single invoke + JSON + bytes

```ts
RustEngine.invoke("binary.invert", {
  contentType: "image/mock",
  width: 1024,
  height: 1024,
  input: imageBytes,
})
```

앱에서는 `invoke` 하나만 보이고, wrapper가 내부에서 native `invokeBinary(commandJson, bytes)`로 보낸다. Swift는 이 구조에서 decode를 하지 않는다.

```txt
String commandJson
Data payload
  -> rust_engine_invoke_binary(commandJson, payloadPtr, payloadLen)
  -> Data response
```

Rust만 JSON command를 읽고 bytes를 처리한다.

## 처리 패턴

| 패턴 | 입력 | 출력 | 예시 |
| --- | --- | --- | --- |
| binary -> binary | JSON command + bytes | bytes | 이미지 resize/filter, thumbnail 생성 |
| binary -> JSON | JSON command + bytes | JSON metadata bytes | checksum, media probe, OCR summary |
| JSON -> binary | JSON command only | bytes | cached asset read, generated preview |
| file path -> file path | JSON command with file URI | output file URI | 긴 영상 transcode, 큰 이미지 batch |

이미지처럼 수백 KB에서 몇 MB 수준은 `Uint8Array/Data`로 실험할 만하다. 영상처럼 수십 MB 이상은 bytes를 매번 RN boundary로 복사하지 말고, 파일 경로/asset handle을 넘기고 Rust가 직접 읽고 쓰는 방식이 더 맞다.

## 이번 실험에 추가한 command

| Method | 의미 | 출력 |
| --- | --- | --- |
| `binary.echo` | bytes 왕복 가능성 확인 | 입력 bytes 그대로 반환 |
| `binary.invert` | binary transform 가능성 확인 | 각 byte bit invert 후 반환 |
| `binary.checksum` | 큰 binary 입력 후 metadata만 반환 | JSON metadata bytes |

이 세 가지는 이미지/영상 실제 codec 처리가 아니라 transport 검증용이다.

## iOS 시뮬레이터 측정값

2026-05-13 iPhone 17 iOS 26.2 Simulator, Debug build, RN 앱 내부 측정값이다.

| Metric | 호출 | p50 | p95 | p99 | 총 시간 | 처리량 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `binary.echo` 256KB | 50 | 0.21ms | 0.50ms | 0.74ms | 25.54ms | 1,957.4/s |
| `binary.invert` 256KB | 50 | 2.04ms | 2.24ms | 2.94ms | 114.17ms | 438.0/s |
| `binary.checksum` 1MB | 20 | 3.85ms | 4.10ms | 4.10ms | 87.69ms | 228.1/s |

해석:

| 결과 | 의미 |
| --- | --- |
| 256KB echo p50 0.21ms | Swift/Rust bytes 왕복 자체는 이미지급 payload에서 꽤 낮다 |
| 256KB invert p50 2.04ms | Rust 쪽에서 새 output buffer를 만들고 byte-wise transform하면 비용이 바로 보인다 |
| 1MB checksum p50 3.85ms | 큰 binary input을 받아 Rust에서 스캔하고 작은 JSON metadata만 돌려주는 패턴은 현실성이 있다 |

따라서 이미지/문서/압축 blob처럼 “몇백 KB에서 1MB대” 데이터는 JSON command + binary payload 경로를 실험할 가치가 있다. 반면 영상 원본처럼 큰 데이터는 여전히 file URI/handle 기반으로 가야 한다.

## 추천 API 모양

앱에서 최종적으로는 아래처럼 가져가는 것이 좋다.

```ts
type BinaryCommand = {
  id: string;
  method: string;
  params: Record<string, unknown>;
  input?: {
    kind: "bytes" | "file";
    contentType?: string;
    name?: string;
  };
  output?: {
    kind: "bytes" | "json" | "file";
    contentType?: string;
  };
};
```

작은 이미지:

```txt
imageBytes -> invoke("image.thumbnail", { input: imageBytes }) -> thumbnailBytes
```

큰 영상:

```txt
videoFileUri -> invoke(JSON command only) -> outputFileUri / progress events
```

## 판단 기준

| 데이터 크기/성격 | 추천 transport |
| --- | --- |
| 작은 command, 상태 조회 | Native JSON invoke |
| 수백 KB 이미지/압축 데이터 | JSON command + binary payload |
| 1-5MB 이미지/문서 | JSON command + binary payload를 측정 후 결정 |
| 수십 MB 영상/녹음 | file URI/handle 기반 command |
| frame 단위 실시간 처리 | Nitro/Craby hot path 검토 |

## 결론

Protobuf 대신 이 구조가 더 실용적이다.

```txt
기본 control plane: JSON
큰 data plane: bytes 또는 file
초고빈도 native call: Nitro/Craby
```

이렇게 나누면 JSON의 관리 편의성을 유지하면서도, 이미지/영상 데이터를 string으로 밀어 넣는 문제를 피할 수 있다.
