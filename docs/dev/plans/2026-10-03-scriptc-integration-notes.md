# scriptc FFI 통합 조사 노트 (2026-10-03)

## 결론

scriptc는 Node/Bun 호스트를 로드하는 도구가 아니라 TS를 네이티브 코드로 정적 컴파일하고 C ABI 아카이브를 링크하는 경로다. rustra `staticlib` + `extern "C"` entry point 조합은 방향이 맞다. 우선 계산기처럼 동기 스칼라 호출을 대상으로 ffi manifest를 만들고, Rust async/channel 기능은 별도 shim 없이 바로 매핑하지 않는다. `--dynamic`은 동적 실행 엔진을 포함하는 옵션이지 napi/dlopen 지원이나 ABI 어댑터가 아니다.

## 공식 문서 요점

출처: [Native FFI](https://scriptc.dev/docs/ffi), [Coverage](https://scriptc.dev/docs/coverage), [Limitations](https://scriptc.dev/docs/limitations), [Compatibility](https://scriptc.dev/compatibility), [Platforms](https://scriptc.dev/docs/platforms), [Dependencies](https://scriptc.dev/docs/dependencies). 2026-10-03 조회. 호환성 페이지도 링크했으나 이 경로의 markdown 요청은 404였음.

- `ffi_format: 1` manifest는 `functions` 배열 항목의 `name`, `symbol`, `params`, `returns`로 TS 선언과 native symbol을 결합하고, `libraries`에는 아카이브/오브젝트 경로, `system_libraries`에는 시스템 라이브러리를 적는다. 선언 TS는 시그니처만 선언하고 구현은 archive가 제공한다. 런타임 symbol lookup은 없다.
- FFI 문서에서 format 2부터 C 함수 포인터를 별도 callback descriptor로 표현 가능하고 opaque context는 독립 ABI 항목으로 둔다. Rust `extern "C" fn` + `*mut c_void` 모델과 일치한다. 단순히 format 1에 함수 포인터를 넣는 건 대상이 아니다. format 2~5의 callback 인자 지원은 제한된 scalar 타입이며, 3부터 문자열/바이트, 4 retained, 5 foreign-thread 방식 추가. 따라서 Rust callback의 ABI/스레드 계약 및 lifetime을 명시적으로 모델링해야 한다.
- retained callback은 같은 스크립트 스레드에서 나중 FFI 호출 중 invoke 가능. 외부 Rust 작업 스레드에서 callback 호출은 format 5 foreign + retained + context 조합의 별도 계약이어야 한다. format 7의 foreign callback은 64-bit/pointer 인자를 거부. callback이 외부 스레드에서 동기적으로 임의 JS 실행을 보장하는 것으로 해석하면 안 된다.
- 정적 빌드의 FFI 아카이브는 링크 시 결정된다. `--dynamic`은 QuickJS 동적 island에 의존하는 TS/JS 실행 경로를 포함할 뿐, 런타임 `dlopen` 또는 Node-API를 제공하지 않는다. Coverage로 정적 컴파일 가능 여부와 dynamic/unsupported 지점을 구분한다. Rustra Bun 경로처럼 bun:ffi + `dlopen` 및 JSCallback을 쓰는 호스트 어댑터는 재사용 불가.
- platforms 문서는 macOS/Linux/Windows 실행 파일에 시스템 linker/SDK가 추가로 필요하다고 설명한다. Native FFI 및 archive 동작은 대상 ABI/플랫폼에 맞춰야 한다. dependencies 문서의 npm 코드가 dynamic engine을 필요로 할 수 있으므로 예제 빌드에서 불필요한 npm/runtime 의존을 끊어야 한다.

## 심볼/아카이브 대조

Bun 채널 코드(`packages/bun/src/bun-channels.ts`)는 직접 `rustra_ffi_channel_create`, `_create_bytes`, `_channel_drop`를 사용한다. 이들은 callback function pointer를 받는 create 심볼이므로 포맷/스레드/lifetime 검토나 C/TS shim이 필요하다. Bun 채널 데이터 송신 쪽도 `_channel_send`, `_channel_send_bytes`를 사용하며 raw pointer + 길이/C string의 정확한 ABI 선언이 필요하다.

현재 `target/debug/librustra_calculator_example.a` 및 `target/release/librustra_calculator_example.a` 존재 확인. `nm -gU`에서 archive가 export하는 Rustra 계열 심볼 중 callback 없는 후보는 `_rustra_ffi_invoke`, `_invoke_frame`, `_invoke_buffer`, `_invoke_raw`, `_has_buffer`, `_has_raw`, `_contract_hash`, `_schema_generation`, `_get_max_payload`, `_set_max_payload`, `_cancellation_status`, `_invoke_cancel`, `_hot_reload`, `_get_schema`, `_capture_snapshot`, `_free`, `_free_owned_bytes` 등이다. 단, invoke 계열 중 JSON/frame/async 호출과 포인터-아웃 버퍼 소유권 함수들은 manifest에 함수 이름만 옮겨 적어서는 안전하지 않다. 계산기 예제는 `src/lib.rs`의 공개 ABI와 호출 계약을 확인해 필요한 최소 subset만 선택한다.

`_event_sink_register`/`_event_sink_unregister`, `_invoke_async`, `_invoke_frame_async*`, `_invoke_json_async` 및 channel create는 callback 인자/비동기 lifetime이 있어 format 1 직접 매핑 대상이 아니며 shim 또는 제외가 필요하다. `nm`는 해당 archive의 실제 심볼 확인 증거이며 Rust 심볼 mangling/플랫폼별 underscore 차이를 고려해야 한다. `target/{debug,release}/lib*.a` 가운데 계산기용 경로는 `target/{debug,release}/librustra_calculator_example.a`.

## 툴체인 설치/검증

요구대로 Node 26 환경에서 설치:

```text
$ fnm exec --using 26 -- npm install -g scriptc
added 2 packages in 6s
npm warn install-scripts ... scriptc@0.2.1 postinstall ... not yet covered by allowScripts
$ fnm exec --using 26 -- scriptc --version
0.2.1
```

설치는 성공했지만 npm이 postinstall을 허용하지 않았다는 경고가 있었다. 실행 가능한 CLI 버전 확인은 통과했으나 네이티브 postinstall artifact 설치 상태는 별도 확인 위험이다.

## 후속 구현 권고

계산기 정적 실행에 필요한 좁은 C ABI wrapper를 제공하고, wrapper는 기존 Rust 로직을 호출하되 scriptc manifest는 포인터 복잡성과 ownership을 최소화한다. TS 선언은 구현 없이 ABI signature만 선언한다. Rust callback/async/worker 기능은 초기 scope에 넣지 않는다. codegen과 릴리스 parity는 `fnm exec --using 26` 아래에서 scriptc build/run 및 아티팩트 freshness를 확인하도록 연결한다.
