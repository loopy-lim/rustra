---
'@rustra/cli': minor
---

`rustra.json`에 `scriptc` 섹션을 추가해 `rustra codegen`의 scriptc 스테이지를 켠다.
스테이지는 정적 링크 계약의 아티팩트 두 벌을 렌더한다: `scriptc/ffi.json`
(ffi_format 7 매니페스트 — rustra staticlib 아카이브를 libraries로)와
`scriptc/scriptc-ffi.d.ts`(시그니처-only 선언). scriptc는 napi 애드온과 dlopen을
지원하지 않아 기존 Node/Bun 호스트 코드젠을 재사용할 수 없으므로 별도 경로다.

매니페스트는 scriptc 직접 호출 세계가 실제로 공급할 수 있는 인자만 싣는다(scriptc
형태 표면): out 포인터에 쓰는 심볼과 콜백 함수 포인터(async·이벤트·채널) 심볼은
사유와 함께 제외되고, 그 대체로 코어의 `rustra_ffi_invoke_json_into_len`(길이를
out 포인터 대신 반환)이 caller-buffer envelope 진입으로 포함된다. 설정은 필수인
`output` 외에 `profile`(기본 release)과 `archive`(명시적 경로 재정의)를 받는다.
아카이브가 없는 쓰기 모드는 `cargo build --release` 힌트와 함께 fail-closed 하고,
check 모드는 커밋된 아티팩트와의 바이트 비교로 드리프트를 잡는다. 실증 게이트:
`test:runtime:scriptc`(examples/calculator — 정적 링크 바이너리가 응답 42).
